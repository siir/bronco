import type { FastifyInstance } from 'fastify';
import type { AIRouter } from '@bronco/ai-provider';
import { EntityType, TaskType } from '@bronco/shared-types';
import { createLogger } from '@bronco/shared-utils';
import { fetchFromOpenRouter, fetchOllamaModels, type FetchedModel } from '../services/model-catalog-refresher.js';

const logger = createLogger('ai-usage-routes');
const VALID_ENTITY_TYPES = new Set<string>(Object.values(EntityType));

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

interface AiUsageOpts {
  ai: AIRouter;
}

function parseDate(fastify: FastifyInstance, value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw fastify.httpErrors.badRequest(`Invalid ${name} query parameter`);
  }
  return date;
}

interface LogsFilter {
  provider?: string;
  model?: string;
  taskType?: string;
  promptKey?: string;
  context?: string;
  since?: string;
  until?: string;
  minTokens?: string | number;
  maxTokens?: string | number;
  entityId?: string;
  entityType?: string;
}

function buildLogsWhereSql(
  fastify: FastifyInstance,
  filter: LogsFilter,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.provider) {
    const list = filter.provider.split(',').filter(Boolean);
    if (list.length > 0) {
      params.push(list);
      conditions.push(`provider = ANY($${params.length})`);
    }
  }

  if (filter.model) {
    params.push(`%${filter.model}%`);
    conditions.push(`model ILIKE $${params.length}`);
  }

  if (filter.taskType) {
    const list = filter.taskType.split(',').filter(Boolean);
    if (list.length > 0) {
      params.push(list);
      conditions.push(`task_type = ANY($${params.length})`);
    }
  }

  if (filter.promptKey) {
    const list = filter.promptKey.split(',').filter(Boolean);
    if (list.length > 0) {
      params.push(list);
      conditions.push(`prompt_key = ANY($${params.length})`);
    }
  }

  if (filter.context) {
    params.push(`%${filter.context}%`);
    const idx = params.length;
    conditions.push(`(entity_type ILIKE $${idx} OR entity_id::text ILIKE $${idx})`);
  }

  if (filter.entityId) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(filter.entityId)) {
      throw fastify.httpErrors.badRequest('Invalid entityId — must be a valid UUID');
    }
    params.push(filter.entityId);
    conditions.push(`entity_id = $${params.length}::uuid`);
  }

  if (filter.entityType) {
    if (!VALID_ENTITY_TYPES.has(filter.entityType)) {
      throw fastify.httpErrors.badRequest(
        `Invalid entityType "${filter.entityType}". Must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}.`,
      );
    }
    params.push(filter.entityType);
    conditions.push(`entity_type = $${params.length}`);
  }

  if (filter.since) {
    params.push(parseDate(fastify, filter.since, 'since'));
    conditions.push(`created_at >= $${params.length}`);
  }

  if (filter.until) {
    params.push(parseDate(fastify, filter.until, 'until'));
    conditions.push(`created_at <= $${params.length}`);
  }

  if (filter.minTokens !== undefined && filter.minTokens !== null && filter.minTokens !== '') {
    const min = Number(filter.minTokens);
    if (Number.isFinite(min)) {
      params.push(min);
      conditions.push(`(input_tokens + output_tokens) >= $${params.length}`);
    }
  }

  if (filter.maxTokens !== undefined && filter.maxTokens !== null && filter.maxTokens !== '') {
    const max = Number(filter.maxTokens);
    if (Number.isFinite(max)) {
      params.push(max);
      conditions.push(`(input_tokens + output_tokens) <= $${params.length}`);
    }
  }

  return {
    sql: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

export async function aiUsageRoutes(
  fastify: FastifyInstance,
  opts: AiUsageOpts,
): Promise<void> {
  // --- Per-client AI usage KPI summary (four time windows) ---
  fastify.get<{
    Params: { id: string };
  }>('/api/clients/:id/ai-usage/summary', async (request) => {
    const clientId = request.params.id;

    const client = await fastify.db.client.findUnique({
      where: { id: clientId },
      select: { billingMarkupPercent: true },
    });
    if (!client) return fastify.httpErrors.notFound('Client not found');
    const markup = Number(client.billingMarkupPercent);

    const windows = [
      { label: '24h' as const, hours: 24 },
      { label: '72h' as const, hours: 72 },
      { label: '7d' as const, hours: 168 },
      { label: '30d' as const, hours: 720 },
    ];

    const results = await Promise.all(
      windows.map(({ hours }) =>
        fastify.db.aiUsageLog.aggregate({
          where: {
            clientId,
            createdAt: { gte: new Date(Date.now() - hours * 3600 * 1000) },
          },
          _sum: { inputTokens: true, outputTokens: true, costUsd: true },
          _count: { id: true },
        }),
      ),
    );

    return {
      clientId,
      billingMarkupPercent: markup,
      windows: windows.map(({ label }, i) => {
        const r = results[i];
        const baseCost = r._sum.costUsd ?? 0;
        return {
          label,
          inputTokens: r._sum.inputTokens ?? 0,
          outputTokens: r._sum.outputTokens ?? 0,
          totalTokens: (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0),
          baseCostUsd: baseCost,
          billedCostUsd: baseCost * markup,
          requestCount: r._count.id,
        };
      }),
    };
  });

  // --- Per-client AI usage log (paginated) ---
  fastify.get<{
    Params: { id: string };
    Querystring: {
      limit?: string; offset?: string;
      provider?: string; model?: string; taskType?: string;
      promptKey?: string; since?: string; until?: string;
      context?: string; minTokens?: string; maxTokens?: string;
    };
  }>('/api/clients/:id/ai-usage', async (request) => {
    const clientId = request.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      return fastify.httpErrors.badRequest('Invalid client ID format');
    }
    const {
      provider, model, taskType, promptKey,
      since, until, context, minTokens, maxTokens,
      limit: rawLimit = '50', offset: rawOffset = '0',
    } = request.query;

    const parsedLimit = Number(rawLimit);
    let take = Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 50;
    if (take < 1) take = 50;
    if (take > 200) take = 200;

    const MAX_SKIP = 50_000;
    const parsedOffset = Number(rawOffset);
    let skip = Number.isFinite(parsedOffset) ? Math.trunc(parsedOffset) : 0;
    if (skip < 0) skip = 0;
    if (skip > MAX_SKIP) skip = MAX_SKIP;

    // Build WHERE clause from filters, then inject clientId
    const { sql: filterSql, params: filterParams } = buildLogsWhereSql(fastify, {
      provider, model, taskType, promptKey, context, since, until,
      minTokens, maxTokens,
    });

    // Add clientId condition
    const clientIdx = filterParams.length + 1;
    filterParams.push(clientId);
    const clientCondition = `client_id = $${clientIdx}::uuid`;
    const whereSql = filterSql
      ? filterSql + ' AND ' + clientCondition
      : 'WHERE ' + clientCondition;

    const limitIdx = filterParams.length + 1;
    const offsetIdx = filterParams.length + 2;

    const [rows, countResult] = await Promise.all([
      fastify.db.$queryRawUnsafe<Array<{
        id: string; provider: string; model: string; taskType: string;
        inputTokens: number; outputTokens: number; durationMs: number | null;
        costUsd: number | null; entityId: string | null; entityType: string | null;
        clientId: string | null; promptKey: string | null; createdAt: Date;
      }>>(
        `SELECT id, provider, model, task_type AS "taskType", input_tokens AS "inputTokens",
         output_tokens AS "outputTokens", duration_ms AS "durationMs", cost_usd AS "costUsd",
         entity_id AS "entityId", entity_type AS "entityType", client_id AS "clientId",
         prompt_key AS "promptKey", created_at AS "createdAt"
         FROM ai_usage_logs ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...filterParams, take, skip,
      ),
      fastify.db.$queryRawUnsafe<[{ count: number }]>(
        `SELECT COUNT(*)::int AS count FROM ai_usage_logs ${whereSql}`,
        ...filterParams,
      ),
    ]);

    const total = countResult[0].count;

    // Enrich with ticket subjects
    const ticketEntityIds = [...new Set(
      rows.filter((l) => l.entityType === 'ticket' && l.entityId).map((l) => l.entityId as string),
    )];
    const ticketMap = new Map<string, string>();
    if (ticketEntityIds.length > 0) {
      const tickets = await fastify.db.ticket.findMany({
        where: { id: { in: ticketEntityIds } },
        select: { id: true, subject: true },
      });
      for (const t of tickets) ticketMap.set(t.id, t.subject);
    }

    return {
      logs: rows.map((l) => ({
        ...l,
        ticketSubject: l.entityType === 'ticket' && l.entityId ? ticketMap.get(l.entityId) ?? null : null,
      })),
      total,
    };
  });

  // --- Usage summary by provider/model ---
  fastify.get<{
    Querystring: { since?: string; until?: string; entityId?: string; entityType?: string; clientId?: string; provider?: string; model?: string };
  }>('/api/ai-usage/summary', async (request) => {
    const { since, until, entityId, entityType, clientId, provider, model } = request.query;

    const where: Record<string, unknown> = {};
    if (entityId) where.entityId = entityId;
    if (entityType) {
      if (!VALID_ENTITY_TYPES.has(entityType)) {
        return fastify.httpErrors.badRequest(
          `Invalid entityType "${entityType}". Must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}.`,
        );
      }
      where.entityType = entityType;
    }
    if (clientId) where.clientId = clientId;
    if (provider) where.provider = provider;
    if (model) where.model = { contains: model, mode: 'insensitive' };
    if (since || until) {
      const createdAt: Record<string, Date> = {};
      if (since) createdAt.gte = parseDate(fastify, since, 'since');
      if (until) createdAt.lte = parseDate(fastify, until, 'until');
      where.createdAt = createdAt;
    }

    const rows = await fastify.db.aiUsageLog.groupBy({
      by: ['provider', 'model'],
      where,
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      _count: true,
    });

    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      totalInputTokens: r._sum.inputTokens ?? 0,
      totalOutputTokens: r._sum.outputTokens ?? 0,
      totalCostUsd: r._sum.costUsd ?? 0,
      callCount: r._count,
    }));
  });

  // --- Usage summary per ticket (with per-call detail) ---
  // The URL parameter is named ticketId for backward compatibility;
  // internally the query filters by entityId + entityType = 'ticket'.
  fastify.get<{
    Params: { ticketId: string };
  }>('/api/ai-usage/ticket/:ticketId', async (request) => {
    const { ticketId } = request.params;

    const [rows, calls] = await Promise.all([
      fastify.db.aiUsageLog.groupBy({
        by: ['provider', 'model'],
        where: { entityId: ticketId, entityType: 'ticket' },
        _sum: { inputTokens: true, outputTokens: true, costUsd: true },
        _count: true,
      }),
      fastify.db.aiUsageLog.findMany({
        where: { entityId: ticketId, entityType: 'ticket' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          provider: true,
          model: true,
          taskType: true,
          inputTokens: true,
          outputTokens: true,
          costUsd: true,
          durationMs: true,
          promptKey: true,
          createdAt: true,
        },
      }),
    ]);

    const totals = rows.reduce(
      (acc, r) => {
        acc.totalInputTokens += r._sum.inputTokens ?? 0;
        acc.totalOutputTokens += r._sum.outputTokens ?? 0;
        acc.totalCostUsd += r._sum.costUsd ?? 0;
        acc.callCount += r._count;
        return acc;
      },
      { entityId: ticketId, entityType: 'ticket', totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, callCount: 0 },
    );

    // Pre-group calls by provider+model for O(1) lookup per breakdown row
    const callsByGroup = new Map<string, typeof calls>();
    for (const c of calls) {
      const key = c.provider + ':' + c.model;
      let group = callsByGroup.get(key);
      if (!group) {
        group = [];
        callsByGroup.set(key, group);
      }
      group.push(c);
    }

    return {
      ...totals,
      breakdown: rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        totalInputTokens: r._sum.inputTokens ?? 0,
        totalOutputTokens: r._sum.outputTokens ?? 0,
        totalCostUsd: r._sum.costUsd ?? 0,
        callCount: r._count,
        calls: (callsByGroup.get(r.provider + ':' + r.model) ?? []).map(c => ({
          id: c.id,
          taskType: c.taskType,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          costUsd: c.costUsd,
          durationMs: c.durationMs,
          promptKey: c.promptKey,
          createdAt: c.createdAt,
        })),
      })),
    };
  });

  // --- Recent usage log entries ---
  fastify.get<{
    Querystring: {
      limit?: string; offset?: string; entityId?: string; entityType?: string;
      provider?: string; model?: string; taskType?: string;
      promptKey?: string; since?: string; until?: string;
      context?: string; minTokens?: string; maxTokens?: string;
    };
  }>('/api/ai-usage/logs', async (request) => {
    const {
      entityId, entityType, provider, model, taskType, promptKey,
      since, until, context, minTokens, maxTokens,
      limit: rawLimit = '50', offset: rawOffset = '0',
    } = request.query;
    const parsedLimit = Number(rawLimit);
    let take = Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 50;
    if (take < 1) take = 50;
    if (take > 200) take = 200;

    const MAX_SKIP = 50_000;
    const parsedOffset = Number(rawOffset);
    let skip = Number.isFinite(parsedOffset) ? Math.trunc(parsedOffset) : 0;
    if (skip < 0) skip = 0;
    if (skip > MAX_SKIP) skip = MAX_SKIP;

    const { sql: whereSql, params: whereParams } = buildLogsWhereSql(fastify, {
      provider, model, taskType, promptKey, context, since, until,
      minTokens, maxTokens, entityId, entityType,
    });

    const limitIdx = whereParams.length + 1;
    const offsetIdx = whereParams.length + 2;

    const [rows, countResult] = await Promise.all([
      fastify.db.$queryRawUnsafe<Array<{
        id: string; provider: string; model: string; taskType: string;
        inputTokens: number; outputTokens: number; durationMs: number | null;
        costUsd: number | null; entityId: string | null; entityType: string | null;
        clientId: string | null; promptKey: string | null; createdAt: Date;
      }>>(
        `SELECT id, provider, model, task_type AS "taskType", input_tokens AS "inputTokens",
         output_tokens AS "outputTokens", duration_ms AS "durationMs", cost_usd AS "costUsd",
         entity_id AS "entityId", entity_type AS "entityType", client_id AS "clientId",
         prompt_key AS "promptKey", created_at AS "createdAt"
         FROM ai_usage_logs ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...whereParams, take, skip,
      ),
      fastify.db.$queryRawUnsafe<[{ count: number }]>(
        `SELECT COUNT(*)::int AS count FROM ai_usage_logs ${whereSql}`,
        ...whereParams,
      ),
    ]);

    const logs = rows;
    const total = countResult[0].count;

    // Enrich with ticket subjects for context (only for ticket-type entities)
    const ticketEntityIds = [...new Set(
      logs
        .filter((l) => l.entityType === 'ticket' && l.entityId)
        .map((l) => l.entityId as string),
    )];
    const ticketMap = new Map<string, string>();
    if (ticketEntityIds.length > 0) {
      const tickets = await fastify.db.ticket.findMany({
        where: { id: { in: ticketEntityIds } },
        select: { id: true, subject: true },
      });
      for (const t of tickets) ticketMap.set(t.id, t.subject);
    }

    return {
      logs: logs.map((l) => ({
        ...l,
        ticketSubject: l.entityType === 'ticket' && l.entityId ? ticketMap.get(l.entityId) ?? null : null,
      })),
      total,
    };
  });

  // --- Distinct prompt keys for filter dropdown ---
  fastify.get('/api/ai-usage/logs/prompt-keys', async () => {
    const keys = await fastify.db.aiUsageLog.findMany({
      where: { promptKey: { not: null } },
      select: { promptKey: true },
      distinct: ['promptKey'],
      orderBy: { promptKey: 'asc' },
    });
    return keys.map((k) => k.promptKey).filter((promptKey): promptKey is string => promptKey != null);
  });

  // --- Bulk delete log entries ---
  fastify.delete<{
    Body: {
      ids?: string[];
      filter?: {
        provider?: string; model?: string; taskType?: string;
        promptKey?: string; context?: string; since?: string;
        until?: string; minTokens?: string | number; maxTokens?: string | number;
      };
    };
  }>('/api/ai-usage/logs', async (request) => {
    const { ids, filter } = request.body ?? {};

    if (ids && Array.isArray(ids) && ids.length > 0) {
      const result = await fastify.db.aiUsageLog.deleteMany({
        where: { id: { in: ids } },
      });
      return { deleted: result.count };
    }

    if (filter && typeof filter === 'object') {
      const { sql: whereSql, params } = buildLogsWhereSql(fastify, filter);
      if (!whereSql) {
        throw fastify.httpErrors.badRequest(
          'Filter must contain at least one criterion to prevent accidental deletion of all logs',
        );
      }
      const result = await fastify.db.$queryRawUnsafe<[{ count: number }]>(
        `WITH deleted AS (DELETE FROM ai_usage_logs ${whereSql} RETURNING 1) SELECT COUNT(*)::int AS count FROM deleted`,
        ...params,
      );
      return { deleted: result[0].count };
    }

    throw fastify.httpErrors.badRequest('Request body must include either "ids" (string[]) or "filter" (object)');
  });

  // --- Single log entry detail (includes promptText and responseText) ---
  fastify.get<{
    Params: { id: string };
  }>('/api/ai-usage/logs/:id', async (request, reply) => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(request.params.id)) {
      return fastify.httpErrors.badRequest('Invalid log id');
    }
    const log = await fastify.db.aiUsageLog.findUnique({
      where: { id: request.params.id },
    });
    if (!log) return fastify.httpErrors.notFound('Log entry not found');

    let ticketSubject: string | null = null;
    if (log.entityId && log.entityType === 'ticket') {
      const ticket = await fastify.db.ticket.findUnique({
        where: { id: log.entityId },
        select: { subject: true },
      });
      ticketSubject = ticket?.subject ?? null;
    }

    return { ...log, ticketSubject };
  });

  // --- Refresh costs on existing log entries ---
  // Recalculates costUsd for logs where cost is null (or all logs if force=true)
  // by looking up current rates from the AiModelCost table.
  fastify.post<{
    Body: { force?: boolean };
  }>('/api/ai-usage/logs/refresh-costs', async (request) => {
    const { force } = request.body ?? {};

    // Load current pricing (only active rates)
    const costEntries = await fastify.db.aiModelCost.findMany({
      where: { isActive: true },
      select: { provider: true, model: true, inputCostPer1m: true, outputCostPer1m: true },
    });
    const rateMap = new Map<string, { input: number; output: number }>();
    for (const c of costEntries) {
      rateMap.set(`${c.provider}:${c.model}`, { input: c.inputCostPer1m, output: c.outputCostPer1m });
    }

    // Only fetch logs whose provider+model has a known rate — prevents unpriceable
    // rows from filling the batch and stalling progress on priceable ones.
    if (rateMap.size === 0) {
      return { total: 0, updated: 0, skipped: 0 };
    }
    const priceableFilter = costEntries.map((c) => ({ provider: c.provider, model: c.model }));

    const MAX_LOGS_TO_REFRESH = 5000;
    const where = {
      ...(force ? {} : { costUsd: null }),
      OR: priceableFilter,
    };
    const logs = await fastify.db.aiUsageLog.findMany({
      where,
      select: { id: true, provider: true, model: true, inputTokens: true, outputTokens: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_LOGS_TO_REFRESH,
    });

    // Precompute costs for all logs with a known rate
    const updates: { id: string; costUsd: number }[] = [];
    for (const log of logs) {
      const rates = rateMap.get(`${log.provider}:${log.model}`);
      if (!rates) continue;
      const costUsd = (log.inputTokens * rates.input + log.outputTokens * rates.output) / 1_000_000;
      updates.push({ id: log.id, costUsd });
    }

    // Batch updates in chunks of 100 to reduce DB round trips
    const BATCH_SIZE = 100;
    let updated = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      await fastify.db.$transaction(
        batch.map((u) =>
          fastify.db.aiUsageLog.update({
            where: { id: u.id },
            data: { costUsd: u.costUsd },
          }),
        ),
      );
      updated += batch.length;
    }

    const skipped = logs.length - updates.length;
    logger.info({ total: logs.length, updated, skipped, force }, 'Refreshed log entry costs');
    return { total: logs.length, updated, skipped };
  });

  // --- Model costs CRUD ---

  fastify.get('/api/ai-usage/costs', async () => {
    return fastify.db.aiModelCost.findMany({
      orderBy: [{ provider: 'asc' }, { model: 'asc' }],
    });
  });

  fastify.post<{
    Body: {
      provider: string;
      model: string;
      displayName?: string;
      inputCostPer1m: number;
      outputCostPer1m: number;
      isCustomCost?: boolean;
    };
  }>('/api/ai-usage/costs', async (request, reply) => {
    const { provider, model, displayName, inputCostPer1m, outputCostPer1m, isCustomCost } = request.body;
    const cost = await fastify.db.aiModelCost.upsert({
      where: { provider_model: { provider, model } },
      update: { displayName, inputCostPer1m, outputCostPer1m, isActive: true, ...(isCustomCost !== undefined && { isCustomCost }) },
      create: { provider, model, displayName, inputCostPer1m, outputCostPer1m, isCustomCost: isCustomCost ?? false },
    });
    reply.code(200);
    return cost;
  });

  // --- Clear custom cost flag (allows AI refresh to update this model) ---
  fastify.post<{
    Params: { id: string };
  }>('/api/ai-usage/costs/:id/clear-custom', async (request) => {
    try {
      return await fastify.db.aiModelCost.update({
        where: { id: request.params.id },
        data: { isCustomCost: false },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) return fastify.httpErrors.notFound('Cost entry not found');
      throw err;
    }
  });

  fastify.delete<{
    Params: { id: string };
  }>('/api/ai-usage/costs/:id', async (request, reply) => {
    try {
      await fastify.db.aiModelCost.delete({ where: { id: request.params.id } });
      reply.code(204).send();
    } catch (err) {
      if (isPrismaError(err, 'P2025')) return fastify.httpErrors.notFound('Cost entry not found');
      throw err;
    }
  });

  // --- Refresh model costs from live APIs ---
  // Fetches the LATEST models and pricing from OpenRouter + Ollama.
  // Models with isCustomCost=true are skipped (user-set pricing protected).
  // Falls back to AI-based lookup if OpenRouter is unreachable.
  fastify.post('/api/ai-usage/costs/refresh', async (_request, reply) => {
    // Load existing custom cost models to protect them
    const customCosts = await fastify.db.aiModelCost.findMany({
      where: { isCustomCost: true },
      select: { provider: true, model: true },
    });
    const customKeys = new Set(customCosts.map((c) => `${c.provider}:${c.model}`));

    let models: FetchedModel[] = [];
    let source = 'openrouter';

    // 1. Try OpenRouter (public API, models + pricing)
    try {
      const openRouterModels = await fetchFromOpenRouter();
      models.push(...openRouterModels);
      logger.info({ count: openRouterModels.length }, 'Refreshed models from OpenRouter');
    } catch (err) {
      logger.warn({ err }, 'OpenRouter fetch failed, falling back to AI-based refresh');
      source = 'ai-fallback';

      // Fallback: use AI to generate pricing data
      try {
        const existingCosts = await fastify.db.aiModelCost.findMany({
          where: { isActive: true },
          select: { provider: true, model: true, displayName: true, inputCostPer1m: true, outputCostPer1m: true },
          orderBy: [{ provider: 'asc' }, { model: 'asc' }],
        });
        const currentModelsRef = existingCosts
          .map((c) => `  ${c.provider} | ${c.model} | ${c.displayName ?? ''} | $${c.inputCostPer1m}/$${c.outputCostPer1m}`)
          .join('\n');

        const response = await opts.ai.generate({
          taskType: TaskType.CUSTOM_AI_QUERY,
          prompt: `You are updating an AI model pricing database. Below are the models we currently track:\n\n${currentModelsRef}\n\nReturn a JSON array with the LATEST pricing for these providers: Anthropic (provider: "CLAUDE"), OpenAI (provider: "OPENAI"), xAI (provider: "GROK"), Google (provider: "GOOGLE"), Local (provider: "LOCAL" at $0).\n\nFor each model: { provider, model (exact API ID), displayName, inputCostPer1m (number), outputCostPer1m (number) }.\n\nInclude any new models released since this list was created. Return ONLY the JSON array.`,
          systemPrompt: 'Return only valid JSON arrays with no markdown formatting, no code blocks, no explanation.',
          maxTokens: 8192,
        });

        const cleaned = response.content.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned) as FetchedModel[];
        if (!Array.isArray(parsed)) throw new Error('Expected array');
        models.push(...parsed);
      } catch (aiErr) {
        const message = aiErr instanceof Error ? aiErr.message : 'Unknown error';
        return reply.code(503).send({
          error: 'Both OpenRouter and AI fallback failed',
          detail: message,
        });
      }
    }

    // 2. Fetch LOCAL models from configured Ollama instances
    const localProviders = await fastify.db.aiProvider.findMany({
      where: { provider: 'LOCAL', isActive: true },
      select: { baseUrl: true },
    });
    for (const lp of localProviders) {
      if (lp.baseUrl) {
        const ollamaModels = await fetchOllamaModels(lp.baseUrl);
        models.push(...ollamaModels);
      }
    }

    // 3. Upsert — update pricing + metadata for non-custom entries, insert new ones
    const results = [];
    let skipped = 0;
    for (const m of models) {
      if (!m.provider || !m.model || !Number.isFinite(m.inputCostPer1m) || !Number.isFinite(m.outputCostPer1m)) continue;
      if (customKeys.has(`${m.provider}:${m.model}`)) {
        skipped++;
        continue;
      }
      const cost = await fastify.db.aiModelCost.upsert({
        where: { provider_model: { provider: m.provider, model: m.model } },
        update: {
          displayName: m.displayName ?? null,
          description: m.description ?? undefined,
          inputCostPer1m: m.inputCostPer1m,
          outputCostPer1m: m.outputCostPer1m,
          contextLength: m.contextLength ?? undefined,
          maxCompletionTokens: m.maxCompletionTokens ?? undefined,
          modality: m.modality ?? undefined,
          isActive: true,
        },
        create: {
          provider: m.provider,
          model: m.model,
          displayName: m.displayName ?? null,
          description: m.description ?? null,
          inputCostPer1m: m.inputCostPer1m,
          outputCostPer1m: m.outputCostPer1m,
          contextLength: m.contextLength ?? null,
          maxCompletionTokens: m.maxCompletionTokens ?? null,
          modality: m.modality ?? null,
        },
      });
      results.push(cost);
    }

    return { source, updated: results.length, skipped, costs: results };
  });

  // --- Seed model costs from live APIs (idempotent — inserts only, never overwrites) ---
  fastify.post('/api/ai-usage/costs/seed', async (_request, reply) => {
    let models: FetchedModel[] = [];

    // 1. Fetch cloud provider models + pricing from OpenRouter (public, no auth)
    let openRouterError: string | null = null;
    try {
      const openRouterModels = await fetchFromOpenRouter();
      models.push(...openRouterModels);
      logger.info({ count: openRouterModels.length }, 'Fetched models from OpenRouter');
    } catch (err) {
      logger.warn({ err }, 'OpenRouter fetch failed during seed, proceeding with local models only');
      openRouterError = err instanceof Error ? err.message : 'Unknown error';
    }

    // 2. Fetch LOCAL models from any configured Ollama instances
    const localProviders = await fastify.db.aiProvider.findMany({
      where: { provider: 'LOCAL', isActive: true },
      select: { baseUrl: true },
    });
    for (const lp of localProviders) {
      if (lp.baseUrl) {
        const ollamaModels = await fetchOllamaModels(lp.baseUrl);
        models.push(...ollamaModels);
        logger.info({ baseUrl: lp.baseUrl, count: ollamaModels.length }, 'Fetched models from Ollama');
      }
    }

    // 3. Upsert (insert-only — existing entries are not overwritten)
    const results = [];
    for (const m of models) {
      const cost = await fastify.db.aiModelCost.upsert({
        where: { provider_model: { provider: m.provider, model: m.model } },
        update: {},
        create: {
          provider: m.provider,
          model: m.model,
          displayName: m.displayName,
          description: m.description,
          inputCostPer1m: m.inputCostPer1m,
          outputCostPer1m: m.outputCostPer1m,
          contextLength: m.contextLength,
          maxCompletionTokens: m.maxCompletionTokens,
          modality: m.modality,
        },
      });
      results.push(cost);
    }

    return {
      seeded: results.length,
      costs: results,
      ...(openRouterError && { warning: `OpenRouter unavailable: ${openRouterError}. Only local models were seeded.` }),
    };
  });

  // --- Model catalog (providers + models derived from costs table) ---
  // Single source of truth for provider/model dropdowns across the app.
  fastify.get('/api/ai-usage/costs/catalog', async () => {
    const costs = await fastify.db.aiModelCost.findMany({
      where: { isActive: true },
      orderBy: [{ provider: 'asc' }, { model: 'asc' }],
      select: { provider: true, model: true, displayName: true, contextLength: true, maxCompletionTokens: true, modality: true },
    });

    const grouped = new Map<string, Array<{ model: string; displayName: string | null; contextLength: number | null; maxCompletionTokens: number | null; modality: string | null }>>();
    for (const c of costs) {
      let models = grouped.get(c.provider);
      if (!models) {
        models = [];
        grouped.set(c.provider, models);
      }
      models.push({ model: c.model, displayName: c.displayName, contextLength: c.contextLength, maxCompletionTokens: c.maxCompletionTokens, modality: c.modality });
    }

    const providers = Array.from(grouped.entries()).map(([provider, models]) => ({
      provider,
      models,
    }));

    return { providers };
  });
}
