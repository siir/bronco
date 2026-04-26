import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { Prisma } from '@bronco/db';
import { z } from 'zod';
import cronParser from 'cron-parser';
const { parseExpression } = cronParser;
import { ProbeAction, TicketCategory, IntegrationType, BUILTIN_PROBE_TOOL_NAMES, BUILTIN_PROBE_TOOLS } from '@bronco/shared-types';
import { buildUtcCron } from '@bronco/shared-utils';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

const VALID_ACTIONS = new Set(Object.values(ProbeAction));
const VALID_CATEGORIES = new Set(Object.values(TicketCategory));

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const scheduleDaysOfWeekSchema = z
  .string()
  .regex(/^[0-6](,[0-6])*$/, 'Must be comma-separated day numbers 0-6')
  .transform((val) => {
    const days = [...new Set(val.split(','))].map(Number).sort((a, b) => a - b);
    return days.join(',');
  });

const actionConfigSchema = z
  .object({
    operatorEmail: z.string().email().optional(),
  })
  .passthrough()
  .optional()
  .nullable();

const createSchema = z.object({
  clientId: z.string().uuid(),
  integrationId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  toolName: z.string().min(1),
  toolParams: z.record(z.unknown()).optional().default({}),
  cronExpression: z.string().min(1).optional(),
  category: z.string().optional().nullable(),
  action: z.string().optional().default('create_ticket'),
  actionConfig: actionConfigSchema,
  isActive: z.boolean().optional().default(true),
  scheduleHour: z.number().int().min(0).max(23).optional(),
  scheduleMinute: z.number().int().min(0).max(59).optional().default(0),
  scheduleDaysOfWeek: scheduleDaysOfWeekSchema.optional().nullable(),
  scheduleTimezone: z.string().optional().nullable(),
  retentionDays: z.number().int().min(1).max(365).optional().default(30),
  retentionMaxRuns: z.number().int().min(5).max(10000).optional().default(100),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  toolName: z.string().min(1).optional(),
  toolParams: z.record(z.unknown()).optional(),
  cronExpression: z.string().min(1).optional(),
  category: z.string().optional().nullable(),
  action: z.string().optional(),
  actionConfig: actionConfigSchema,
  isActive: z.boolean().optional(),
  scheduleHour: z.number().int().min(0).max(23).optional().nullable(),
  scheduleMinute: z.number().int().min(0).max(59).optional().nullable(),
  scheduleDaysOfWeek: scheduleDaysOfWeekSchema.optional().nullable(),
  scheduleTimezone: z.string().optional().nullable(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  retentionMaxRuns: z.number().int().min(5).max(10000).optional(),
});

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

function validateCron(expression: string): string | null {
  try {
    parseExpression(expression);
    return null;
  } catch {
    return `Invalid cron expression: ${expression}`;
  }
}

interface ScheduledProbeOpts {
  probeQueue: Queue;
}

export async function scheduledProbeRoutes(
  fastify: FastifyInstance,
  opts: ScheduledProbeOpts,
): Promise<void> {
  const { probeQueue } = opts;

  // GET /api/search/scheduled-probes — lightweight search for the command palette
  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search/scheduled-probes',
    async (request) => {
      const rawQ = (request.query.q ?? '').trim();
      if (!rawQ) return fastify.httpErrors.badRequest('q is required');
      if (rawQ.length < 2) return fastify.httpErrors.badRequest('q must be at least 2 characters');

      const rawLimit = request.query.limit ?? '20';
      const limit = Math.trunc(Number(rawLimit));
      if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
        return fastify.httpErrors.badRequest('limit must be between 1 and 50');
      }

      const scope = await resolveClientScope(request);
      if (scope.type === 'assigned' && scope.clientIds.length === 0) return [];

      const clientWhere = scopeToWhere(scope);

      const results = await fastify.db.scheduledProbe.findMany({
        where: {
          ...clientWhere,
          OR: [
            { name: { contains: rawQ, mode: 'insensitive' } },
            { description: { contains: rawQ, mode: 'insensitive' } },
            { client: { name: { contains: rawQ, mode: 'insensitive' } } },
            { client: { shortCode: { contains: rawQ, mode: 'insensitive' } } },
          ],
        },
        select: {
          id: true,
          name: true,
          createdAt: true,
          clientId: true,
          toolName: true,
          isActive: true,
          client: { select: { name: true, shortCode: true } },
        },
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
      });

      const qLower = rawQ.toLowerCase();
      results.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;

        const createdAtDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (createdAtDiff !== 0) return createdAtDiff;

        return a.name.localeCompare(b.name);
      });

      return results.slice(0, limit).map(p => ({
        id: p.id,
        name: p.name,
        clientId: p.clientId,
        clientName: p.client.name,
        clientShortCode: p.client.shortCode,
        toolName: p.toolName,
        isActive: p.isActive,
      }));
    },
  );

  // List all probes, optionally filtered by clientId
  fastify.get<{
    Querystring: { clientId?: string };
  }>('/api/scheduled-probes', async (request) => {
    const scope = await resolveClientScope(request);
    const scopeWhere = scopeToWhere(scope);
    const { clientId } = request.query;

    // If a clientId filter is requested, validate it is within the caller's scope
    const effectiveClientId =
      clientId &&
      (scope.type === 'all' ||
        (scope.type === 'single' && scope.clientId === clientId) ||
        (scope.type === 'assigned' && scope.clientIds.includes(clientId)))
        ? clientId
        : undefined;

    return fastify.db.scheduledProbe.findMany({
      where: {
        ...scopeWhere,
        ...(effectiveClientId && { clientId: effectiveClientId }),
      },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        client: { select: { id: true, name: true, shortCode: true } },
        integration: { select: { id: true, label: true, type: true } },
      },
    });
  });

  // List available built-in probe tools
  fastify.get('/api/scheduled-probes/builtin-tools', async () => {
    return BUILTIN_PROBE_TOOLS;
  });

  // Get single probe
  fastify.get<{ Params: { id: string } }>('/api/scheduled-probes/:id', async (request) => {
    const scope = await resolveClientScope(request);
    const probe = await fastify.db.scheduledProbe.findFirst({
      where: { id: request.params.id, ...scopeToWhere(scope) },
      include: {
        client: { select: { id: true, name: true, shortCode: true } },
        integration: { select: { id: true, label: true, type: true, config: true, metadata: true } },
      },
    });
    if (!probe) return fastify.httpErrors.notFound('Scheduled probe not found');
    return probe;
  });

  // Create probe
  fastify.post<{ Body: z.input<typeof createSchema> }>('/api/scheduled-probes', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(parsed.error.errors[0]?.message ?? 'Invalid request body');
    }

    const data = parsed.data;

    // Scope enforcement: validate the caller is authorized for the target client
    const scope = await resolveClientScope(request);
    if (
      (scope.type === 'single' && scope.clientId !== data.clientId) ||
      (scope.type === 'assigned' && !scope.clientIds.includes(data.clientId))
    ) {
      return fastify.httpErrors.forbidden('clientId not in your scope');
    }

    // Timezone-based schedule validation
    if (data.scheduleTimezone) {
      if (!isValidTimezone(data.scheduleTimezone)) {
        return fastify.httpErrors.badRequest(`Invalid timezone: ${data.scheduleTimezone}`);
      }
      if (data.scheduleHour === undefined) {
        return fastify.httpErrors.badRequest('scheduleHour is required when scheduleTimezone is provided');
      }
      // Compute cronExpression from timezone fields
      data.cronExpression = buildUtcCron({
        hour: data.scheduleHour,
        minute: data.scheduleMinute ?? 0,
        daysOfWeek: data.scheduleDaysOfWeek,
        timezone: data.scheduleTimezone,
      });
    } else if (!data.cronExpression) {
      return fastify.httpErrors.badRequest('cronExpression is required when scheduleTimezone is not provided');
    }

    // Validate cron expression
    const cronErr = validateCron(data.cronExpression!);
    if (cronErr) return fastify.httpErrors.badRequest(cronErr);

    // Validate action
    if (!VALID_ACTIONS.has(data.action as ProbeAction)) {
      return fastify.httpErrors.badRequest(`Invalid action. Must be one of: ${[...VALID_ACTIONS].join(', ')}`);
    }

    // Validate category if provided
    if (data.category && !VALID_CATEGORIES.has(data.category as TicketCategory)) {
      return fastify.httpErrors.badRequest(`Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }

    // Built-in tools skip integration validation; MCP tools require a valid integration
    const isBuiltinTool = BUILTIN_PROBE_TOOL_NAMES.has(data.toolName);

    // Built-in tools don't require an integration; MCP tools do
    if (!isBuiltinTool) {
      if (!data.integrationId) {
        return fastify.httpErrors.badRequest('integrationId is required for MCP tools');
      }

      const integration = await fastify.db.clientIntegration.findUnique({
        where: { id: data.integrationId },
      });
      if (!integration) return fastify.httpErrors.badRequest('Integration not found');
      if (!integration.isActive) return fastify.httpErrors.badRequest('Integration is not active');
      if (integration.clientId !== data.clientId) {
        return fastify.httpErrors.badRequest('Integration does not belong to the specified client');
      }
      if (integration.type !== IntegrationType.MCP_DATABASE) {
        return fastify.httpErrors.badRequest('Scheduled probes only support MCP_DATABASE integrations');
      }

      // Validate tool name exists in integration metadata
      const meta = integration.metadata as Record<string, unknown> | null;
      const tools = Array.isArray(meta?.['tools']) ? meta!['tools'] as Array<Record<string, unknown>> : [];
      const toolNames = tools.map((t) => t['name']).filter(Boolean);
      if (!toolNames.includes(data.toolName)) {
        return fastify.httpErrors.badRequest(
          `Tool "${data.toolName}" not found in integration metadata. Available: ${toolNames.join(', ')}`,
        );
      }

      // Check tool is not disabled
      const cfg = integration.config as Record<string, unknown>;
      const disabledTools = new Set(Array.isArray(cfg['disabledTools']) ? cfg['disabledTools'] as string[] : []);
      if (disabledTools.has(data.toolName)) {
        return fastify.httpErrors.badRequest(`Tool "${data.toolName}" is disabled on this integration`);
      }
    }

    let probe;
    try {
      probe = await fastify.db.scheduledProbe.create({
        data: {
          clientId: data.clientId,
          integrationId: isBuiltinTool ? null : (data.integrationId ?? null),
          name: data.name.trim(),
          description: data.description?.trim() || null,
          toolName: data.toolName,
          toolParams: data.toolParams as Prisma.InputJsonValue,
          cronExpression: data.cronExpression!,
          scheduleHour: data.scheduleTimezone ? data.scheduleHour : null,
          scheduleMinute: data.scheduleTimezone ? (data.scheduleMinute ?? 0) : null,
          scheduleDaysOfWeek: data.scheduleTimezone ? (data.scheduleDaysOfWeek ?? null) : null,
          scheduleTimezone: data.scheduleTimezone ?? null,
          category: (data.category || null) as TicketCategory | null,
          action: data.action,
          actionConfig: data.actionConfig ? (data.actionConfig as Prisma.InputJsonValue) : Prisma.JsonNull,
          isActive: data.isActive,
          retentionDays: data.retentionDays,
          retentionMaxRuns: data.retentionMaxRuns,
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.badRequest('Invalid clientId or integrationId');
      }
      throw err;
    }

    reply.code(201);
    return probe;
  });

  // Update probe
  fastify.patch<{
    Params: { id: string };
    Body: z.input<typeof updateSchema>;
  }>('/api/scheduled-probes/:id', async (request) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(parsed.error.errors[0]?.message ?? 'Invalid request body');
    }

    const updates = parsed.data;

    // Determine if any schedule-related fields are being changed
    const scheduleFieldsChanged =
      updates.scheduleTimezone !== undefined ||
      updates.scheduleHour !== undefined ||
      updates.scheduleMinute !== undefined ||
      updates.scheduleDaysOfWeek !== undefined ||
      updates.cronExpression !== undefined;

    // Scope guard: ensure the caller is authorized for this probe's client
    const scope = await resolveClientScope(request);
    const probeForScope = await fastify.db.scheduledProbe.findFirst({
      where: { id: request.params.id, ...scopeToWhere(scope) },
      select: { id: true, scheduleHour: true, scheduleMinute: true, scheduleDaysOfWeek: true, scheduleTimezone: true },
    });
    if (!probeForScope) return fastify.httpErrors.notFound('Scheduled probe not found');

    // If any schedule fields changed and the probe uses timezone scheduling, we must
    // fetch the existing record to merge with the incoming partial update before recomputing cron
    let existingProbe: { scheduleHour: number | null; scheduleMinute: number | null; scheduleDaysOfWeek: string | null; scheduleTimezone: string | null } | null = null;
    if (scheduleFieldsChanged) {
      existingProbe = probeForScope;
    }

    // Resolve effective timezone schedule fields by merging incoming updates with existing values
    const effectiveTimezone = updates.scheduleTimezone !== undefined ? updates.scheduleTimezone : existingProbe?.scheduleTimezone ?? null;
    const effectiveHour = updates.scheduleHour !== undefined ? updates.scheduleHour : existingProbe?.scheduleHour ?? null;
    const effectiveMinute = updates.scheduleMinute !== undefined ? updates.scheduleMinute : existingProbe?.scheduleMinute ?? null;
    const effectiveDaysOfWeek = updates.scheduleDaysOfWeek !== undefined ? updates.scheduleDaysOfWeek : existingProbe?.scheduleDaysOfWeek ?? null;

    // When timezone scheduling is active, enforce invariants and always derive cronExpression
    if (effectiveTimezone) {
      if (!isValidTimezone(effectiveTimezone)) {
        return fastify.httpErrors.badRequest(`Invalid timezone: ${effectiveTimezone}`);
      }
      if (effectiveHour == null || effectiveMinute == null) {
        return fastify.httpErrors.badRequest('scheduleHour and scheduleMinute are required when scheduleTimezone is set');
      }
      // Always recompute cronExpression from timezone fields when schedule changed
      // or client attempted to set cronExpression directly — prevents divergence
      if (scheduleFieldsChanged) {
        updates.cronExpression = buildUtcCron({
          hour: effectiveHour,
          minute: effectiveMinute,
          daysOfWeek: effectiveDaysOfWeek,
          timezone: effectiveTimezone,
        });
      }
    }

    if (updates.cronExpression) {
      const cronErr = validateCron(updates.cronExpression);
      if (cronErr) return fastify.httpErrors.badRequest(cronErr);
    }

    if (updates.action && !VALID_ACTIONS.has(updates.action as ProbeAction)) {
      return fastify.httpErrors.badRequest(`Invalid action. Must be one of: ${[...VALID_ACTIONS].join(', ')}`);
    }

    if (updates.category && !VALID_CATEGORIES.has(updates.category as TicketCategory)) {
      return fastify.httpErrors.badRequest(`Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }

    // toolName is immutable via PATCH — changing the tool changes the probe
    // identity. Create a new probe instead. toolParams remains editable so
    // operators can adjust tool inputs (e.g. lookback windows) on existing probes.
    if (updates.toolName !== undefined) {
      return fastify.httpErrors.badRequest(
        'Updating toolName is not supported; create a new probe instead',
      );
    }

    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name.trim();
    if (updates.description !== undefined) data.description = updates.description?.trim() || null;
    if (updates.cronExpression !== undefined) data.cronExpression = updates.cronExpression;
    if (updates.category !== undefined) data.category = updates.category || null;
    if (updates.action !== undefined) data.action = updates.action;
    if (updates.actionConfig !== undefined) {
      data.actionConfig = updates.actionConfig === null ? Prisma.JsonNull : updates.actionConfig;
    }
    if (updates.isActive !== undefined) data.isActive = updates.isActive;
    // Write all schedule fields independently so partial updates (e.g. just scheduleHour) are persisted
    if (updates.scheduleTimezone !== undefined) {
      data.scheduleTimezone = updates.scheduleTimezone;
      // Clear hour/minute/days when switching to raw cron mode
      if (updates.scheduleTimezone === null) {
        data.scheduleHour = null;
        data.scheduleMinute = null;
        data.scheduleDaysOfWeek = null;
      }
    }
    if (updates.scheduleHour !== undefined) data.scheduleHour = updates.scheduleHour;
    if (updates.scheduleMinute !== undefined) data.scheduleMinute = updates.scheduleMinute;
    if (updates.scheduleDaysOfWeek !== undefined) data.scheduleDaysOfWeek = updates.scheduleDaysOfWeek;
    if (updates.retentionDays !== undefined) data.retentionDays = updates.retentionDays;
    if (updates.retentionMaxRuns !== undefined) data.retentionMaxRuns = updates.retentionMaxRuns;
    if (updates.toolParams !== undefined) {
      data.toolParams = updates.toolParams as Prisma.InputJsonValue;
    }

    try {
      return await fastify.db.scheduledProbe.update({
        where: { id: request.params.id },
        data,
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Scheduled probe not found');
      }
      throw err;
    }
  });

  // Delete probe
  fastify.delete<{ Params: { id: string } }>('/api/scheduled-probes/:id', async (request, reply) => {
    const scope = await resolveClientScope(request);
    const probe = await fastify.db.scheduledProbe.findFirst({
      where: { id: request.params.id, ...scopeToWhere(scope) },
      select: { id: true },
    });
    if (!probe) return fastify.httpErrors.notFound('Scheduled probe not found');

    try {
      await fastify.db.scheduledProbe.delete({ where: { id: probe.id } });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Scheduled probe not found');
      }
      throw err;
    }
    reply.code(204).send();
  });

  // Trigger immediate execution
  fastify.post<{ Params: { id: string } }>('/api/scheduled-probes/:id/run', async (request) => {
    const scope = await resolveClientScope(request);
    const probe = await fastify.db.scheduledProbe.findFirst({
      where: { id: request.params.id, ...scopeToWhere(scope) },
    });
    if (!probe) return fastify.httpErrors.notFound('Scheduled probe not found');

    await probeQueue.add('probe-run', { probeId: probe.id }, { jobId: `probe-${probe.id}-${Date.now()}` });
    return { message: 'Probe execution queued', probeId: probe.id };
  });

  // ── Probe Run History ──────────────────────────────────────────────

  // List runs for a probe
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; status?: string };
  }>('/api/scheduled-probes/:id/runs', async (request) => {
    const probeId = request.params.id;
    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);
    const statusFilter = request.query.status;

    const scope = await resolveClientScope(request);
    const probe = await fastify.db.scheduledProbe.findFirst({
      where: { id: probeId, ...scopeToWhere(scope) },
      select: { id: true },
    });
    if (!probe) return fastify.httpErrors.notFound('Scheduled probe not found');

    const where: Record<string, unknown> = { probeId };
    if (statusFilter) where.status = statusFilter;

    const [runs, total] = await Promise.all([
      fastify.db.probeRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip: offset,
        include: { _count: { select: { steps: true } } },
      }),
      fastify.db.probeRun.count({ where }),
    ]);

    const truncated = runs.map((run) => ({
      ...run,
      result: typeof run.result === 'string' && run.result.length > 500
        ? run.result.slice(0, 499) + '…'
        : run.result,
      error: typeof run.error === 'string' && run.error.length > 500
        ? run.error.slice(0, 499) + '…'
        : run.error,
    }));

    return { runs: truncated, total };
  });

  // Get current running probe run
  fastify.get<{ Params: { id: string } }>('/api/scheduled-probes/:id/runs/current', async (request) => {
    const probeId = request.params.id;
    // Scope guard: verify caller can access this probe before returning its runs
    const scope = await resolveClientScope(request);
    const probeExists = await fastify.db.scheduledProbe.findFirst({
      where: { id: probeId, ...scopeToWhere(scope) },
      select: { id: true },
    });
    if (!probeExists) return fastify.httpErrors.notFound('Scheduled probe not found');

    const run = await fastify.db.probeRun.findFirst({
      where: { probeId, status: 'running' },
      orderBy: { startedAt: 'desc' },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    return run ?? null;
  });

  // Get single run with steps
  fastify.get<{ Params: { id: string; runId: string } }>('/api/scheduled-probes/:id/runs/:runId', async (request) => {
    // Scope guard: verify caller can access the parent probe
    const scope = await resolveClientScope(request);
    const probeExists = await fastify.db.scheduledProbe.findFirst({
      where: { id: request.params.id, ...scopeToWhere(scope) },
      select: { id: true },
    });
    if (!probeExists) return fastify.httpErrors.notFound('Scheduled probe not found');

    const run = await fastify.db.probeRun.findUnique({
      where: { id: request.params.runId },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!run || run.probeId !== request.params.id) {
      return fastify.httpErrors.notFound('Probe run not found');
    }
    return run;
  });

  // Purge run history (keep most recent 5)
  fastify.delete<{ Params: { id: string } }>('/api/scheduled-probes/:id/runs', async (request) => {
    const probeId = request.params.id;
    const scope = await resolveClientScope(request);
    const probe = await fastify.db.scheduledProbe.findFirst({
      where: { id: probeId, ...scopeToWhere(scope) },
      select: { id: true },
    });
    if (!probe) return fastify.httpErrors.notFound('Scheduled probe not found');

    const recentRuns = await fastify.db.probeRun.findMany({
      where: { probeId },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: { id: true },
    });
    const keepIds = recentRuns.map((r) => r.id);

    const result = await fastify.db.probeRun.deleteMany({
      where: {
        probeId,
        id: { notIn: keepIds },
      },
    });

    return { deleted: result.count };
  });
}
