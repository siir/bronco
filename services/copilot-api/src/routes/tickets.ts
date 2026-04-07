import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { AIRouter } from '@bronco/ai-provider';
import { ensureClientUser, Prisma } from '@bronco/db';
import { TicketStatus, TicketCategory, TicketEventType, Priority, TicketSource, TaskType, isClosedStatus, AnalysisStatus, SufficiencyStatus, LogLevel } from '@bronco/shared-types';
import { getSelfAnalysisConfig } from '@bronco/shared-utils';
import type { TicketCreatedJob, IngestionJob } from '@bronco/shared-types';

interface TicketRouteOpts {
  logSummarizeQueue?: Queue;
  systemAnalysisQueue?: Queue;
  clientLearningQueue?: Queue;
  ticketCreatedQueue?: Queue<TicketCreatedJob>;
  ingestQueue?: Queue<IngestionJob>;
  ai?: AIRouter;
}

const VALID_PRIORITIES: Set<string> = new Set(Object.values(Priority));
const VALID_SOURCES: Set<string> = new Set(Object.values(TicketSource));
const VALID_CATEGORIES: Set<string> = new Set(Object.values(TicketCategory));
const VALID_STATUSES: Set<string> = new Set(Object.values(TicketStatus));
const VALID_EVENT_TYPES: Set<string> = new Set(Object.values(TicketEventType));
const VALID_ANALYSIS_STATUSES: Set<string> = new Set(Object.values(AnalysisStatus));
const VALID_SUFFICIENCY_STATUSES: Set<string> = new Set(Object.values(SufficiencyStatus));
const VALID_LOG_LEVELS: Set<string> = new Set(Object.values(LogLevel));

export async function ticketRoutes(fastify: FastifyInstance, opts?: TicketRouteOpts): Promise<void> {
  fastify.get<{ Querystring: { clientId?: string; status?: string; category?: string; priority?: string; source?: string; analysisStatus?: string; createdFrom?: string; createdTo?: string; environmentId?: string; assignedOperatorId?: string; limit?: string; offset?: string } }>(
    '/api/tickets',
    async (request) => {
      const { clientId, status, category, priority, source, analysisStatus, createdFrom, createdTo, environmentId, assignedOperatorId, limit: rawLimit = '50', offset: rawOffset = '0' } = request.query;

      const take = Math.trunc(Number(rawLimit));
      const skip = Math.trunc(Number(rawOffset));
      if (!Number.isFinite(take) || take < 0 || !Number.isFinite(skip) || skip < 0) {
        return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
      }

      // Validate and parse status filter (supports comma-separated values)
      let statusFilter: TicketStatus | { in: TicketStatus[] } | undefined;
      if (status) {
        const values = status.split(',').map(s => s.trim()).filter(Boolean);
        const invalid = values.filter(v => !VALID_STATUSES.has(v));
        if (invalid.length > 0) {
          return fastify.httpErrors.badRequest(`Invalid status values: ${invalid.join(', ')}`);
        }
        statusFilter = values.length === 1
          ? values[0] as TicketStatus
          : { in: values as TicketStatus[] };
      }

      // Validate and parse priority filter (supports comma-separated values)
      type PriorityType = (typeof Priority)[keyof typeof Priority];
      let priorityFilter: PriorityType | { in: PriorityType[] } | undefined;
      if (priority) {
        const values = priority.split(',').map(s => s.trim()).filter(Boolean);
        const invalid = values.filter(v => !VALID_PRIORITIES.has(v));
        if (invalid.length > 0) {
          return fastify.httpErrors.badRequest(`Invalid priority values: ${invalid.join(', ')}`);
        }
        priorityFilter = values.length === 1
          ? values[0] as PriorityType
          : { in: values as PriorityType[] };
      }

      // Validate source filter
      if (source && !VALID_SOURCES.has(source)) {
        return fastify.httpErrors.badRequest(`Invalid source: ${source}`);
      }

      // Validate analysisStatus filter
      if (analysisStatus && !VALID_ANALYSIS_STATUSES.has(analysisStatus)) {
        return fastify.httpErrors.badRequest(`Invalid analysisStatus: ${analysisStatus}`);
      }

      // Parse date range filters
      const createdAtFilter: { gte?: Date; lte?: Date } = {};
      if (createdFrom) {
        const d = new Date(createdFrom);
        if (isNaN(d.getTime())) return fastify.httpErrors.badRequest('Invalid createdFrom date');
        createdAtFilter.gte = d;
      }
      if (createdTo) {
        const d = new Date(createdTo);
        if (isNaN(d.getTime())) return fastify.httpErrors.badRequest('Invalid createdTo date');
        createdAtFilter.lte = d;
      }

      // Validate assignedOperatorId is a UUID or 'unassigned'
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (assignedOperatorId !== undefined && assignedOperatorId !== 'unassigned' && !UUID_RE.test(assignedOperatorId)) {
        return fastify.httpErrors.badRequest('assignedOperatorId must be a valid UUID or "unassigned"');
      }

      return fastify.db.ticket.findMany({
        where: {
          ...(clientId && { clientId }),
          ...(statusFilter && { status: statusFilter }),
          ...(category && { category: category as TicketCategory }),
          ...(priorityFilter && { priority: priorityFilter }),
          ...(source && { source: source as typeof TicketSource[keyof typeof TicketSource] }),
          ...(analysisStatus && { analysisStatus: analysisStatus as typeof AnalysisStatus[keyof typeof AnalysisStatus] }),
          ...(Object.keys(createdAtFilter).length > 0 && { createdAt: createdAtFilter }),
          ...(environmentId && { environmentId }),
          ...(assignedOperatorId !== undefined && {
            assignedOperatorId: assignedOperatorId === 'unassigned' ? null : assignedOperatorId,
          }),
        },
        omit: { knowledgeDoc: true },
        include: {
          client: { select: { name: true, shortCode: true } },
          system: { select: { name: true } },
          _count: { select: { events: true, artifacts: true } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      });
    },
  );

  // GET /api/tickets/stats — aggregate ticket counts by status, priority, category, and source
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/tickets/stats',
    async (request) => {
      const { clientId } = request.query;
      const where = clientId ? { clientId } : {};

      const [total, byStatus, byPriority, byCategory, bySource] = await Promise.all([
        fastify.db.ticket.count({ where }),
        fastify.db.ticket.groupBy({ by: ['status'], where, _count: true }),
        fastify.db.ticket.groupBy({ by: ['priority'], where, _count: true }),
        fastify.db.ticket.groupBy({ by: ['category'], where, _count: true }),
        fastify.db.ticket.groupBy({ by: ['source'], where, _count: true }),
      ]);

      const toRecord = <T extends string>(
        rows: Array<{ _count: number } & { [K in T]: string | null }>,
        key: T,
      ): Record<string, number> => {
        const record: Record<string, number> = {};
        for (const row of rows) {
          const value = row[key];
          if (value != null) record[value] = row._count;
        }
        return record;
      };

      return {
        total,
        byStatus: toRecord(byStatus, 'status'),
        byPriority: toRecord(byPriority, 'priority'),
        byCategory: toRecord(byCategory, 'category'),
        bySource: toRecord(bySource, 'source'),
      };
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/tickets/:id', async (request) => {
    const ticket = await fastify.db.ticket.findUnique({
      where: { id: request.params.id },
      include: {
        client: true,
        system: true,
        followers: { include: { contact: true }, orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        artifacts: true,
      },
    });
    if (!ticket) return fastify.httpErrors.notFound('Ticket not found');
    return ticket;
  });

  fastify.post<{
    Querystring: { sync?: string };
    Body: {
      clientId: string;
      subject: string;
      description?: string;
      systemId?: string;
      environmentId?: string | null;
      requesterId?: string;
      priority?: string;
      source?: string;
      category?: string;
    };
  }>('/api/tickets', async (request, reply) => {
    const { clientId, subject, description, systemId, environmentId, requesterId, priority, source, category } = request.body;
    const syncMode = request.query.sync === 'true';

    if (priority && !VALID_PRIORITIES.has(priority)) return fastify.httpErrors.badRequest(`Invalid priority: ${priority}`);
    if (source && !VALID_SOURCES.has(source)) return fastify.httpErrors.badRequest(`Invalid source: ${source}`);
    if (category && !VALID_CATEGORIES.has(category)) return fastify.httpErrors.badRequest(`Invalid category: ${category}`);

    if (requesterId) {
      const requesterContact = await fastify.db.contact.findUnique({
        where: { id: requesterId },
        select: { clientId: true },
      });
      if (!requesterContact || requesterContact.clientId !== clientId) {
        return fastify.httpErrors.badRequest(`requesterId does not belong to client ${clientId}`);
      }
    }

    if (environmentId !== undefined && environmentId !== null) {
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== clientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
    }

    // --- Async mode (default): enqueue to ingestion pipeline ---
    if (!syncMode && opts?.ingestQueue) {
      const job: IngestionJob = {
        source: (source as TicketSource) ?? TicketSource.MANUAL,
        clientId,
        payload: {
          subject,
          description,
          priority,
          category,
          contactId: requesterId,
          systemId,
          environmentId: environmentId ?? undefined,
        },
      };

      await opts.ingestQueue.add('ticket-ingest', job, {
        jobId: `ingest-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        attempts: 4,
        backoff: { type: 'exponential', delay: 30_000 },
      });

      // Auto-provision a CLIENT user account for the requester contact
      if (requesterId) {
        const contact = await fastify.db.contact.findUnique({
          where: { id: requesterId },
          select: { email: true, name: true, clientId: true },
        });
        if (contact) {
          try {
            await ensureClientUser(fastify.db, contact);
          } catch (error) {
            fastify.log.error({ err: error }, 'Failed to auto-provision CLIENT user');
          }
        }
      }

      reply.code(202);
      return { queued: true, source: job.source, clientId };
    }

    // --- Sync mode (?sync=true): create ticket directly for interactive callers ---
    let ticket: Awaited<ReturnType<typeof fastify.db.ticket.create>>;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const lastApiTicket = await fastify.db.ticket.findFirst({
        where: { clientId, ticketNumber: { gt: 0 } },
        orderBy: { ticketNumber: 'desc' },
        select: { ticketNumber: true },
      });
      const apiTicketNumber = (lastApiTicket?.ticketNumber ?? 0) + 1;

      try {
        ticket = await fastify.db.ticket.create({
          data: {
            clientId,
            subject,
            description,
            systemId,
            environmentId: environmentId ?? undefined,
            priority: priority as Priority,
            source: source as TicketSource,
            category: category as TicketCategory,
            ticketNumber: apiTicketNumber,
            ...(requesterId && {
              followers: {
                create: { contactId: requesterId, followerType: 'REQUESTER' },
              },
            }),
          },
        });
        break;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 3) {
          continue;
        }
        throw err;
      }
    }
    ticket = ticket!;

    // Enqueue ticket-created event for route dispatch
    if (opts?.ticketCreatedQueue) {
      await opts.ticketCreatedQueue.add('ticket-created', {
        ticketId: ticket.id,
        clientId: ticket.clientId,
        source: (ticket.source ?? TicketSource.MANUAL) as TicketCreatedJob['source'],
        category: ticket.category ?? null,
      }, {
        jobId: `ticket-created-${ticket.id}`,
        attempts: 4,
        backoff: { type: 'exponential', delay: 30_000 },
      });
    }

    // Auto-provision a CLIENT user account for the requester contact
    if (requesterId) {
      const contact = await fastify.db.contact.findUnique({
        where: { id: requesterId },
        select: { email: true, name: true, clientId: true },
      });
      if (contact) {
        try {
          await ensureClientUser(fastify.db, contact);
        } catch (error) {
          fastify.log.error({ err: error }, 'Failed to auto-provision CLIENT user');
        }
      }
    }

    reply.code(201);
    return ticket;
  });

  fastify.post<{
    Params: { id: string };
    Body: {
      eventType: string;
      content?: string;
      metadata?: Record<string, unknown>;
      actor?: string;
    };
  }>('/api/tickets/:id/events', async (request, reply) => {
    const { eventType, content, metadata, actor } = request.body;

    if (!VALID_EVENT_TYPES.has(eventType)) return fastify.httpErrors.badRequest(`Invalid eventType: ${eventType}`);

    const event = await fastify.db.ticketEvent.create({
      data: {
        ticketId: request.params.id,
        eventType: eventType as TicketEventType,
        content,
        metadata: metadata as never ?? undefined,
        actor,
      },
    });
    reply.code(201);
    return event;
  });

  fastify.patch<{ Params: { id: string }; Body: { status?: string; priority?: string; systemId?: string; environmentId?: string | null; category?: string | null; sufficiencyStatus?: string | null; assignedOperatorId?: string | null; knowledgeDoc?: string | null } }>(
    '/api/tickets/:id',
    async (request, reply) => {
      const { status: newStatus, priority, systemId, environmentId, category, sufficiencyStatus, assignedOperatorId, knowledgeDoc } = request.body;
      if (newStatus && !VALID_STATUSES.has(newStatus)) return fastify.httpErrors.badRequest(`Invalid status: ${newStatus}`);
      if (priority && !VALID_PRIORITIES.has(priority)) return fastify.httpErrors.badRequest(`Invalid priority: ${priority}`);
      if (category && !VALID_CATEGORIES.has(category)) return fastify.httpErrors.badRequest(`Invalid category: ${category}`);
      if (sufficiencyStatus !== undefined && sufficiencyStatus !== null && !VALID_SUFFICIENCY_STATUSES.has(sufficiencyStatus)) return fastify.httpErrors.badRequest(`Invalid sufficiencyStatus: ${sufficiencyStatus}`);

      const needsExisting = request.body.status !== undefined || environmentId !== undefined || assignedOperatorId !== undefined;
      const existing = needsExisting
        ? await fastify.db.ticket.findUnique({ where: { id: request.params.id }, select: { status: true, clientId: true, assignedOperatorId: true } })
        : null;
      if (request.body.status && !existing) return fastify.httpErrors.notFound('Ticket not found');
      if (environmentId !== undefined && !existing) return fastify.httpErrors.notFound('Ticket not found');
      if (assignedOperatorId !== undefined && !existing) return fastify.httpErrors.notFound('Ticket not found');

      if (environmentId !== undefined && environmentId !== null && existing) {
        const env = await fastify.db.clientEnvironment.findUnique({
          where: { id: environmentId },
          select: { clientId: true },
        });
        if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
        if (env.clientId !== existing.clientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
      }

      // Validate operator exists and is active
      const UUID_PATCH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (assignedOperatorId !== undefined && assignedOperatorId !== null && !UUID_PATCH_RE.test(assignedOperatorId)) {
        return fastify.httpErrors.badRequest('assignedOperatorId must be a valid UUID');
      }
      let resolvedOperatorName: string | null = null;
      if (assignedOperatorId !== undefined && assignedOperatorId !== null) {
        const operator = await fastify.db.operator.findUnique({ where: { id: assignedOperatorId }, select: { id: true, isActive: true, name: true } });
        if (!operator) return fastify.httpErrors.badRequest('Referenced operator not found');
        if (!operator.isActive) return fastify.httpErrors.badRequest('Cannot assign to an inactive operator');
        resolvedOperatorName = operator.name;
      }

      const ticket = await fastify.db.ticket.update({
        where: { id: request.params.id },
        data: {
          ...(newStatus && { status: newStatus as TicketStatus }),
          ...(priority && { priority: priority as Priority }),
          ...(systemId && { systemId }),
          ...(environmentId !== undefined && { environmentId }),
          ...(category !== undefined && { category: category as TicketCategory | null }),
          ...(sufficiencyStatus !== undefined && { sufficiencyStatus: sufficiencyStatus as SufficiencyStatus | null }),
          ...(assignedOperatorId !== undefined && { assignedOperatorId }),
          ...(knowledgeDoc !== undefined && { knowledgeDoc }),
        },
      });

      // Create assignment event for audit trail when operator assignment changes
      if (assignedOperatorId !== undefined && assignedOperatorId !== existing?.assignedOperatorId) {
        const operatorName = assignedOperatorId ? resolvedOperatorName : null;
        await fastify.db.ticketEvent.create({
          data: {
            ticketId: request.params.id,
            eventType: 'ASSIGNMENT',
            content: assignedOperatorId
              ? `Ticket assigned to operator: ${operatorName}`
              : 'Ticket unassigned from operator',
            metadata: {
              assignedOperatorId,
              previousOperatorId: existing?.assignedOperatorId ?? null,
            },
            actor: 'operator',
          },
        });
      }

      // Trigger log summarization only when ticket status actually changes
      if (request.body.status && request.body.status !== existing?.status && opts?.logSummarizeQueue) {
        await opts.logSummarizeQueue.add(
          'summarize-ticket-logs',
          { ticketId: request.params.id },
          { jobId: `ticket-status-${request.params.id}-${Date.now()}` },
        );
      }

      // Trigger system analysis when ticket transitions to a closed status from a non-closed status
      const statusChanged = request.body.status && request.body.status !== existing?.status;
      if (statusChanged && existing && !isClosedStatus(existing.status) && isClosedStatus(request.body.status!) && opts?.systemAnalysisQueue) {
        const selfAnalysisCfg = await getSelfAnalysisConfig(fastify.db);
        if (selfAnalysisCfg.ticketCloseTrigger) {
          await opts.systemAnalysisQueue.add(
            'analyze-ticket-closure',
            { ticketId: request.params.id, triggerType: 'TICKET_CLOSE' },
            { jobId: `closure-${request.params.id}-${Date.now()}` },
          );
        }
      }

      // Trigger client learning extraction when ticket transitions to closed
      if (statusChanged && existing && !isClosedStatus(existing.status) && isClosedStatus(request.body.status!) && existing.clientId && opts?.clientLearningQueue) {
        await opts.clientLearningQueue.add(
          'extract-client-learnings',
          { ticketId: request.params.id, clientId: existing.clientId },
          { jobId: `client-learning-${request.params.id}-${Date.now()}` },
        );
      }

      return ticket;
    },
  );

  // POST /api/tickets/:id/reanalyze — re-enqueue ticket for route dispatch
  fastify.post<{ Params: { id: string } }>('/api/tickets/:id/reanalyze', async (request, reply) => {
    const ticket = await fastify.db.ticket.findUnique({
      where: { id: request.params.id },
      select: { id: true, clientId: true, source: true, category: true },
    });
    if (!ticket) return fastify.httpErrors.notFound('Ticket not found');
    if (!opts?.ticketCreatedQueue) return fastify.httpErrors.serviceUnavailable('Ticket queue not available');

    const jobId = `ticket-created-reanalyze-${ticket.id}`;
    const existingJob = await opts.ticketCreatedQueue.getJob(jobId);
    let queued = true;

    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'completed' || state === 'failed') {
        await existingJob.remove();
      } else {
        queued = false;
      }
    }

    if (queued) {
      await fastify.db.ticket.update({
        where: { id: ticket.id },
        data: { analysisStatus: AnalysisStatus.PENDING, analysisError: null },
      });

      await opts.ticketCreatedQueue.add('ticket-created', {
        ticketId: ticket.id,
        clientId: ticket.clientId,
        source: (ticket.source ?? TicketSource.MANUAL) as TicketCreatedJob['source'],
        category: ticket.category ?? null,
      }, {
        jobId,
        attempts: 4,
        backoff: { type: 'exponential', delay: 30_000 },
      });
    }

    await fastify.db.ticketEvent.create({
      data: {
        ticketId: ticket.id,
        eventType: TicketEventType.SYSTEM_NOTE,
        content: queued
          ? 'Analysis pipeline re-triggered by operator.'
          : 'Re-analysis skipped — a job is already queued or running.',
        actor: 'operator',
      },
    });

    const updated = await fastify.db.ticket.findUnique({ where: { id: ticket.id } });

    reply.code(202);
    return { queued, ticketId: ticket.id, jobId, ticket: updated };
  });

  // GET /api/tickets/:id/logs — app logs filtered by this ticket's entityId
  fastify.get<{
    Params: { id: string };
    Querystring: { level?: string; service?: string; search?: string; limit?: string; offset?: string };
  }>('/api/tickets/:id/logs', async (request) => {
    const { level, service, search, limit: rawLimit = '100', offset: rawOffset = '0' } = request.query;

    const take = Math.trunc(Number(rawLimit));
    const skip = Math.trunc(Number(rawOffset));
    if (!Number.isFinite(take) || take < 0 || !Number.isFinite(skip) || skip < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }

    if (level && !VALID_LOG_LEVELS.has(level)) {
      return fastify.httpErrors.badRequest(`Invalid level. Must be one of: ${Object.values(LogLevel).join(', ')}`);
    }

    const where: Record<string, unknown> = {
      entityId: request.params.id,
      entityType: 'ticket',
    };
    if (level) where.level = level;
    if (service) where.service = service;
    if (search) where.message = { contains: search, mode: 'insensitive' };

    const [logs, total] = await Promise.all([
      fastify.db.appLog.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: Math.min(take, 500),
        skip,
      }),
      fastify.db.appLog.count({ where }),
    ]);

    return { logs, total };
  });

  // GET /api/tickets/:id/ai-usage — AI usage logs for this ticket
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>('/api/tickets/:id/ai-usage', async (request) => {
    const { limit: rawLimit = '50', offset: rawOffset = '0' } = request.query;

    const take = Math.trunc(Number(rawLimit));
    const skip = Math.trunc(Number(rawOffset));
    if (!Number.isFinite(take) || take < 0 || !Number.isFinite(skip) || skip < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }

    const [logs, total] = await Promise.all([
      fastify.db.aiUsageLog.findMany({
        where: { entityId: request.params.id, entityType: 'ticket' },
        select: {
          id: true,
          provider: true,
          model: true,
          taskType: true,
          inputTokens: true,
          outputTokens: true,
          durationMs: true,
          costUsd: true,
          promptText: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: Math.min(take, 200),
        skip,
      }),
      fastify.db.aiUsageLog.count({
        where: { entityId: request.params.id, entityType: 'ticket' },
      }),
    ]);

    return { logs, total };
  });

  // GET /api/tickets/:id/unified-logs — merged chronological stream of app_logs + ai_usage_logs
  const VALID_UNIFIED_TYPES = new Set(['log', 'ai', 'tool', 'step', 'error']);

  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; type?: string; level?: string; search?: string; includeArchive?: string; createdAfter?: string };
  }>('/api/tickets/:id/unified-logs', async (request) => {
    const { limit: rawLimit = '100', offset: rawOffset = '0', type, level, search, includeArchive, createdAfter } = request.query;

    const take = Math.trunc(Number(rawLimit));
    const skip = Math.trunc(Number(rawOffset));
    if (!Number.isFinite(take) || take < 0 || !Number.isFinite(skip) || skip < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }
    if (level && !VALID_LOG_LEVELS.has(level)) {
      return fastify.httpErrors.badRequest(`Invalid level. Must be one of: ${Object.values(LogLevel).join(', ')}`);
    }
    if (type && !VALID_UNIFIED_TYPES.has(type)) {
      return fastify.httpErrors.badRequest(`Invalid type. Must be one of: ${[...VALID_UNIFIED_TYPES].join(', ')}`);
    }

    const ticketId = request.params.id;
    const wantArchive = includeArchive === 'true';
    const wantLogs = !type || type === 'log' || type === 'tool' || type === 'step' || type === 'error';
    const wantAi = !type || type === 'ai';

    const afterDate = createdAfter ? new Date(createdAfter) : null;
    if (afterDate && isNaN(afterDate.getTime())) {
      return fastify.httpErrors.badRequest('createdAfter must be a valid ISO timestamp');
    }

    // Build app_logs where clause
    const logWhere: Record<string, unknown> = { entityId: ticketId, entityType: 'ticket' };
    if (level) logWhere.level = level;
    if (search) logWhere.message = { contains: search, mode: 'insensitive' };
    if (afterDate) logWhere.createdAt = { gte: afterDate };

    // Build ai_usage_logs where clause
    const aiWhere: Record<string, unknown> = { entityId: ticketId, entityType: 'ticket' };
    if (afterDate) aiWhere.createdAt = { gte: afterDate };
    if (search) {
      aiWhere.OR = [
        { taskType: { contains: search, mode: 'insensitive' } },
        { promptText: { contains: search, mode: 'insensitive' } },
        { responseText: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
      ];
    }

    // For merged pagination, we fetch both sources sorted by createdAt and merge.
    // We over-fetch (skip + take) from each source to ensure we have enough entries
    // for the requested window after merging and sorting.
    const fetchLimit = Math.min(skip + take, 5000);

    const [appLogs, aiLogs, appLogCount, aiLogCount] = await Promise.all([
      wantLogs
        ? fastify.db.appLog.findMany({
            where: logWhere,
            orderBy: { createdAt: 'asc' },
            take: fetchLimit,
          })
        : Promise.resolve([]),
      wantAi
        ? fastify.db.aiUsageLog.findMany({
            where: aiWhere,
            ...(wantArchive
              ? { include: { archive: { select: { fullPrompt: true, fullResponse: true, systemPrompt: true, conversationMessages: true, totalContextTokens: true, messageCount: true } } } }
              : {}),
            orderBy: { createdAt: 'asc' },
            take: fetchLimit,
          })
        : Promise.resolve([]),
      wantLogs ? fastify.db.appLog.count({ where: logWhere }) : Promise.resolve(0),
      wantAi ? fastify.db.aiUsageLog.count({ where: aiWhere }) : Promise.resolve(0),
    ]);

    // Classify and merge
    type UnifiedEntry = {
      id: string;
      type: 'log' | 'ai' | 'tool' | 'step' | 'error';
      timestamp: string;
      level?: string;
      service?: string;
      message?: string;
      context?: unknown;
      error?: string | null;
      taskType?: string;
      provider?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number | null;
      durationMs?: number | null;
      promptKey?: string | null;
      promptText?: string | null;
      systemPrompt?: string | null;
      responseText?: string | null;
      conversationMetadata?: unknown;
      archive?: {
        fullPrompt: string;
        fullResponse: string;
        systemPrompt: string | null;
        conversationMessages: unknown;
        totalContextTokens: number | null;
        messageCount: number | null;
      } | null;
    };

    const entries: UnifiedEntry[] = [];

    for (const log of appLogs) {
      const msg = log.message.toLowerCase();
      let entryType: 'log' | 'tool' | 'step' | 'error' = 'log';
      if (log.level === 'ERROR') entryType = 'error';
      else if (msg.includes('tool call') || msg.includes('tool_call') || msg.includes('executing tool')) entryType = 'tool';
      else if (msg.includes('executing step') || msg.includes('step completed') || msg.includes('step failed')) entryType = 'step';

      // Apply type filter for sub-types
      if (type && type !== entryType) {
        // type='log' shows only plain logs; type='tool'/'step'/'error' show only that sub-type
        continue;
      }

      entries.push({
        id: log.id,
        type: entryType,
        timestamp: log.createdAt.toISOString(),
        level: log.level,
        service: log.service,
        message: log.message,
        context: log.context,
        error: log.error,
      });
    }

    for (const ai of aiLogs) {
      entries.push({
        id: ai.id,
        type: 'ai',
        timestamp: ai.createdAt.toISOString(),
        taskType: ai.taskType,
        provider: ai.provider,
        model: ai.model,
        inputTokens: ai.inputTokens,
        outputTokens: ai.outputTokens,
        costUsd: ai.costUsd,
        durationMs: ai.durationMs,
        promptKey: ai.promptKey,
        promptText: ai.promptText,
        systemPrompt: ai.systemPrompt,
        responseText: ai.responseText,
        conversationMetadata: ai.conversationMetadata,
        archive: (ai as unknown as { archive?: UnifiedEntry['archive'] }).archive ?? null,
      });
    }

    // Sort by timestamp
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const total = appLogCount + aiLogCount;
    const page = entries.slice(skip, skip + take);

    return { entries: page, total };
  });

  // GET /api/tickets/:id/cost-summary — AI cost summary for this ticket
  fastify.get<{
    Params: { id: string };
  }>('/api/tickets/:id/cost-summary', async (request) => {
    const ticketId = request.params.id;

    const [rows, toolCallCount, totalDurationResult] = await Promise.all([
      fastify.db.aiUsageLog.groupBy({
        by: ['provider', 'model'],
        where: { entityId: ticketId, entityType: 'ticket' },
        _sum: { inputTokens: true, outputTokens: true, costUsd: true, durationMs: true },
        _count: true,
      }),
      fastify.db.appLog.count({
        where: {
          entityId: ticketId,
          entityType: 'ticket',
          OR: [
            { message: { contains: 'tool call', mode: 'insensitive' } },
            { message: { contains: 'tool_call', mode: 'insensitive' } },
            { message: { contains: 'executing tool', mode: 'insensitive' } },
          ],
        },
      }),
      fastify.db.aiUsageLog.aggregate({
        where: { entityId: ticketId, entityType: 'ticket' },
        _sum: { durationMs: true },
      }),
    ]);

    const totals = rows.reduce(
      (acc, r) => {
        acc.totalCostUsd += r._sum.costUsd ?? 0;
        acc.callCount += r._count;
        return acc;
      },
      { totalCostUsd: 0, callCount: 0 },
    );

    return {
      entityId: ticketId,
      totalCostUsd: totals.totalCostUsd,
      callCount: totals.callCount,
      toolCallCount,
      totalDurationMs: totalDurationResult._sum.durationMs ?? 0,
      breakdown: rows.map(r => ({
        provider: r.provider,
        model: r.model,
        callCount: r._count,
        totalCostUsd: r._sum.costUsd ?? 0,
        totalDurationMs: r._sum.durationMs ?? 0,
      })),
    };
  });

  // POST /api/tickets/:id/ai-help — ask AI for help on a ticket
  const MAX_QUESTION_LENGTH = 2000;

  /** Task types allowed for the ai-help endpoint (analysis/reasoning tasks only). */
  const AI_HELP_ALLOWED_TASK_TYPES = new Set<TaskType>([
    TaskType.SUGGEST_NEXT_STEPS,
    TaskType.DEEP_ANALYSIS,
    TaskType.BUG_ANALYSIS,
    TaskType.FEATURE_ANALYSIS,
    TaskType.ARCHITECTURE_REVIEW,
    TaskType.SCHEMA_REVIEW,
    TaskType.REVIEW_CODE,
    TaskType.ANALYZE_QUERY,
    TaskType.SUMMARIZE_TICKET,
  ]);

  fastify.post<{ Params: { id: string }; Body: { question?: string; provider?: string; model?: string; taskType?: string } }>(
    '/api/tickets/:id/ai-help',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      if (!opts?.ai) return fastify.httpErrors.serviceUnavailable('AI router not available');

      const ticket = await fastify.db.ticket.findUnique({
        where: { id: request.params.id },
        include: {
          client: { select: { id: true, name: true } },
          system: { select: { name: true } },
          events: { orderBy: { createdAt: 'desc' }, take: 50 },
        },
      });
      if (!ticket) return fastify.httpErrors.notFound('Ticket not found');

      const eventsSummary = ticket.events
        .slice()
        .reverse()
        .map(e => `[${e.eventType}] ${e.actor ?? 'system'}: ${(e.content ?? '').slice(0, 300)}`)
        .join('\n');

      const { question, provider: providerOverride, model: modelOverride, taskType: taskTypeOverride } = request.body ?? {};

      if ((providerOverride && !modelOverride) || (!providerOverride && modelOverride)) {
        return fastify.httpErrors.badRequest('Both provider and model must be specified together, or neither');
      }

      let userQuestion = typeof question === 'string' ? question.trim() : undefined;
      if (userQuestion && userQuestion.length > MAX_QUESTION_LENGTH) {
        fastify.log.warn({ ticketId: request.params.id, questionLength: userQuestion.length }, 'ai-help question exceeds max length, truncating');
        userQuestion = userQuestion.slice(0, MAX_QUESTION_LENGTH);
      }

      // Restrict taskType override to the allow-list of analysis/reasoning tasks
      if (taskTypeOverride && !AI_HELP_ALLOWED_TASK_TYPES.has(taskTypeOverride as TaskType)) {
        return fastify.httpErrors.badRequest(
          `Invalid taskType "${taskTypeOverride}". Allowed values: ${[...AI_HELP_ALLOWED_TASK_TYPES].join(', ')}`,
        );
      }

      const effectiveTaskType = taskTypeOverride
        ? taskTypeOverride as TaskType
        : TaskType.SUGGEST_NEXT_STEPS;

      const prompt = [
        `Ticket: ${ticket.subject}`,
        `Status: ${ticket.status} | Priority: ${ticket.priority} | Category: ${ticket.category ?? 'none'}`,
        ticket.client ? `Client: ${ticket.client.name}` : null,
        ticket.system ? `System: ${ticket.system.name}` : null,
        ticket.description ? `\nDescription:\n${ticket.description.slice(0, 2000)}` : null,
        eventsSummary ? `\nTimeline (${ticket.events.length} events):\n${eventsSummary}` : null,
        userQuestion ? `\nOperator question: ${userQuestion}` : null,
      ].filter(Boolean).join('\n');

      const response = await opts.ai.generate({
        taskType: effectiveTaskType,
        prompt,
        systemPrompt:
          'You are a support operations assistant helping an operator triage and resolve tickets. ' +
          'Analyze the ticket context and provide actionable recommendations. ' +
          'If the operator asked a specific question, answer it directly. ' +
          'Otherwise, suggest concrete next steps: what to investigate, who to contact, ' +
          'what status/priority changes to make, and whether deeper AI analysis is warranted. ' +
          'Be concise and practical. Use markdown formatting.',
        context: { ticketId: ticket.id, clientId: ticket.clientId },
        ...(providerOverride && modelOverride && { providerOverride, modelOverride }),
      });

      // Record the AI help as a ticket event
      await fastify.db.ticketEvent.create({
        data: {
          ticketId: ticket.id,
          eventType: TicketEventType.AI_ANALYSIS,
          content: response.content,
          actor: 'ai',
          metadata: {
            phase: 'ai_help',
            aiProvider: response.provider,
            aiModel: response.model,
            taskType: effectiveTaskType,
            ...(userQuestion && { question: userQuestion }),
            ...(response.usage != null && { usage: response.usage }),
            ...(response.durationMs != null && { durationMs: response.durationMs }),
          },
        },
      });

      return { content: response.content, provider: response.provider, model: response.model };
    },
  );
}
