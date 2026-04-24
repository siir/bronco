import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { AIRouter } from '@bronco/ai-provider';
import { Prisma } from '@bronco/db';
import { TicketStatus, TicketCategory, TicketEventType, Priority, TicketSource, TaskType, isClosedStatus, AnalysisStatus, SufficiencyStatus, LogLevel } from '@bronco/shared-types';
import { getSelfAnalysisConfig } from '@bronco/shared-utils';
import type { TicketCreatedJob, IngestionJob, AnalysisJob } from '@bronco/shared-types';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

interface TicketRouteOpts {
  logSummarizeQueue?: Queue;
  systemAnalysisQueue?: Queue;
  clientLearningQueue?: Queue;
  ticketCreatedQueue?: Queue<TicketCreatedJob>;
  ticketAnalysisQueue?: Queue<AnalysisJob>;
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
  /**
   * Assert that a ticket exists and belongs to the caller's tenant.
   * Returns the ticket's id when found, or a 404 error object for routes that
   * only need existence + scope verification (not the full ticket row).
   * Returns null when out-of-scope or missing (caller must return the error).
   *
   * Use this for routes that do NOT need additional ticket fields — they can
   * call this first, then proceed knowing the ticket is in-scope.
   * Routes that already load the ticket with broader selects (PATCH, reanalyze,
   * ai-help) embed the scope check in their own findFirst/include query.
   */
  async function assertTicketInScope(
    request: Parameters<typeof resolveClientScope>[0],
    ticketId: string,
  ): Promise<{ id: string } | null> {
    const scope = await resolveClientScope(request);
    const scopeWhere = scopeToWhere(scope);
    return fastify.db.ticket.findFirst({
      where: { id: ticketId, ...scopeWhere },
      select: { id: true },
    });
  }

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

      // Resolve caller's client scope (platform admin → all, scoped operator → assigned, person → single)
      const scope = await resolveClientScope(request);
      let scopedClientIdFilter: string | { in: string[] } | undefined;
      if (scope.type === 'assigned') {
        // No assigned clients → empty result set
        if (scope.clientIds.length === 0) return [];
        // If caller passed an explicit clientId filter, intersect with assigned clients
        if (clientId) {
          if (!scope.clientIds.includes(clientId)) return [];
          scopedClientIdFilter = clientId;
        } else {
          scopedClientIdFilter = { in: scope.clientIds };
        }
      } else if (scope.type === 'single') {
        if (clientId && clientId !== scope.clientId) return [];
        scopedClientIdFilter = scope.clientId;
      } else if (clientId) {
        scopedClientIdFilter = clientId;
      }

      return fastify.db.ticket.findMany({
        where: {
          ...(scopedClientIdFilter !== undefined && { clientId: scopedClientIdFilter }),
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

  // GET /api/search/tickets — lightweight full-text search for the command palette
  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search/tickets',
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
      const ticketNumberMatch = /^\d+$/.test(rawQ) ? Number(rawQ) : null;

      const selectShape = {
        id: true,
        ticketNumber: true,
        subject: true,
        status: true,
        priority: true,
        clientId: true,
        createdAt: true,
        client: { select: { name: true, shortCode: true } },
      } as const;

      // For numeric queries, fetch exact ticketNumber matches separately so
      // they're guaranteed to appear regardless of how many broad (subject/
      // client) matches exist — otherwise the broad query's `take: limit`
      // could push them out before the in-memory ranker sees them.
      //
      // ticketNumber is unique per-client (@@unique([clientId, ticketNumber]))
      // so a numeric query may match multiple tickets across the caller's
      // accessible clients. findMany + clientWhere covers all of them.
      const exactPromise: Promise<Array<Prisma.TicketGetPayload<{ select: typeof selectShape }>>> =
        ticketNumberMatch !== null
          ? fastify.db.ticket.findMany({
              where: { ...clientWhere, ticketNumber: ticketNumberMatch },
              select: selectShape,
              take: limit,
            })
          : Promise.resolve([]);

      const broadPromise = fastify.db.ticket.findMany({
        where: {
          ...clientWhere,
          OR: [
            { subject: { contains: rawQ, mode: 'insensitive' as const } },
            { client: { shortCode: { contains: rawQ, mode: 'insensitive' as const } } },
            { client: { name: { contains: rawQ, mode: 'insensitive' as const } } },
          ],
        },
        select: selectShape,
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      const [exact, broad] = await Promise.all([exactPromise, broadPromise]);

      // Merge + dedupe by id (an exact-number row may also appear in the
      // broad set via subject contains, e.g. `q="42"` and a ticket with
      // subject "42 bug").
      const byId = new Map<string, typeof broad[number]>();
      for (const row of exact) byId.set(row.id, row);
      for (const row of broad) byId.set(row.id, row);
      const merged = Array.from(byId.values());

      const qLower = rawQ.toLowerCase();
      merged.sort((a, b) => {
        const aExact = ticketNumberMatch !== null && a.ticketNumber === ticketNumberMatch ? 0 : 1;
        const bExact = ticketNumberMatch !== null && b.ticketNumber === ticketNumberMatch ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aStarts = a.subject.toLowerCase().startsWith(qLower) ? 0 : 1;
        const bStarts = b.subject.toLowerCase().startsWith(qLower) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });

      return merged.slice(0, limit).map(t => ({
        id: t.id,
        ticketNumber: t.ticketNumber,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        clientId: t.clientId,
        clientName: t.client.name,
        clientShortCode: t.client.shortCode,
      }));
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
    const scope = await resolveClientScope(request);
    const scopeWhere = scopeToWhere(scope);
    const ticket = await fastify.db.ticket.findFirst({
      where: { id: request.params.id, ...scopeWhere },
      include: {
        client: true,
        system: true,
        followers: {
          // Explicit Person select — never spread `person`. `passwordHash`
          // and `emailLower` must not leak via the ticket detail response.
          include: {
            person: {
              select: { id: true, name: true, email: true, phone: true, isActive: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
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
      // Tenant validation: the requester must be linked to the target
      // client via a ClientUser row, OR be a platform operator
      // (Operator.clientId === null), OR be a client-scoped operator
      // pinned to THIS client. A STANDARD operator scoped to a DIFFERENT
      // client is not a valid requester here — they can't legitimately
      // author a ticket on behalf of a tenant they don't serve.
      const requesterPerson = await fastify.db.person.findFirst({
        where: {
          id: requesterId,
          OR: [
            { clientUsers: { some: { clientId } } },
            { operator: { clientId: null } },
            { operator: { clientId } },
          ],
        },
        select: { id: true },
      });
      if (!requesterPerson) {
        return fastify.httpErrors.badRequest(`requesterId ${requesterId} is not associated with client ${clientId}`);
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
          personId: requesterId,
          systemId,
          environmentId: environmentId ?? undefined,
        },
      };

      await opts.ingestQueue.add('ticket-ingest', job, {
        jobId: `ingest-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        attempts: 4,
        backoff: { type: 'exponential', delay: 30_000 },
      });

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
            status: 'NEW',
            priority: priority as Priority,
            source: source as TicketSource,
            category: category as TicketCategory,
            ticketNumber: apiTicketNumber,
            ...(requesterId && {
              followers: {
                create: { personId: requesterId, followerType: 'REQUESTER' },
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

    // Scope guard: verify the ticket exists and belongs to the caller's tenant.
    if (!await assertTicketInScope(request, request.params.id)) {
      return fastify.httpErrors.notFound('Ticket not found');
    }

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

      // Scope-gated lookup: always verify the ticket exists AND belongs to the caller's tenant.
      // Using findFirst + scopeToWhere (not findUnique) so the scope where-clause is applied
      // atomically. Returns 404 for missing-or-out-of-scope tickets to prevent ID enumeration.
      const scope = await resolveClientScope(request);
      const scopeWhere = scopeToWhere(scope);
      const existing = await fastify.db.ticket.findFirst({
        where: { id: request.params.id, ...scopeWhere },
        select: { status: true, clientId: true, assignedOperatorId: true },
      });
      if (!existing) return fastify.httpErrors.notFound('Ticket not found');

      if (environmentId !== undefined && environmentId !== null) {
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
        const operator = await fastify.db.operator.findUnique({
          where: { id: assignedOperatorId },
          select: { id: true, person: { select: { name: true, isActive: true } } },
        });
        if (!operator) return fastify.httpErrors.badRequest('Referenced operator not found');
        if (!operator.person.isActive) return fastify.httpErrors.badRequest('Cannot assign to an inactive operator');
        resolvedOperatorName = operator.person.name;
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

  // POST /api/tickets/:id/reanalyze — re-enqueue ticket for route dispatch.
  //
  // #375: BullMQ dedupes job IDs across all states (completed, active, waiting,
  // etc.). The previous implementation used a deterministic jobId
  // (`ticket-created-reanalyze-<ticketId>`) and the downstream route dispatcher
  // in turn enqueued with `analysis-<ticketId>` — also deterministic. A Retry
  // Analysis click on a ticket whose prior analysis had completed was therefore
  // a silent no-op at the analysisQueue layer: queue.add() returned the old
  // completed Job without creating a new one, the API still wrote the
  // SYSTEM_NOTE audit event, and the UI showed "analysis running" while
  // nothing ran.
  //
  // Fix:
  //   - Use a timestamped `ticket-created-reanalyze-<ticketId>-<ts>` jobId so
  //     every click creates a distinct outer ticket-created job.
  //   - Pass `reanalysis: true` through to the route dispatcher so it routes
  //     the downstream analysis enqueue to `reanalysis-<ticketId>-<ts>` as
  //     well (see route-dispatcher.ts).
  //   - Verify BullMQ actually created a NEW job by inspecting Job.timestamp;
  //     if we somehow get back a dedupe hit, return 409 so the frontend can
  //     show a real error rather than optimistic success.
  //   - Only write the SYSTEM_NOTE audit row AFTER the enqueue confirms.
  fastify.post<{ Params: { id: string } }>('/api/tickets/:id/reanalyze', async (request, reply) => {
    const scope = await resolveClientScope(request);
    const scopeWhere = scopeToWhere(scope);
    const ticket = await fastify.db.ticket.findFirst({
      where: { id: request.params.id, ...scopeWhere },
      select: { id: true, clientId: true, source: true, category: true },
    });
    if (!ticket) return fastify.httpErrors.notFound('Ticket not found');
    if (!opts?.ticketCreatedQueue) return fastify.httpErrors.serviceUnavailable('Ticket queue not available');

    const enqueuedAt = Date.now();
    const jobId = `ticket-created-reanalyze-${ticket.id}-${enqueuedAt}`;

    await fastify.db.ticket.update({
      where: { id: ticket.id },
      data: { analysisStatus: AnalysisStatus.PENDING, analysisError: null },
    });

    const enqueuedJob = await opts.ticketCreatedQueue.add('ticket-created', {
      ticketId: ticket.id,
      clientId: ticket.clientId,
      source: (ticket.source ?? TicketSource.MANUAL) as TicketCreatedJob['source'],
      category: ticket.category ?? null,
      reanalysis: true,
    }, {
      jobId,
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    });

    // Belt-and-braces dedupe check. With a timestamped jobId this should never
    // trigger, but catching it here means we never lie to the UI.
    const DEDUPE_THRESHOLD_MS = 5_000;
    if (enqueuedJob.timestamp && enqueuedAt - enqueuedJob.timestamp > DEDUPE_THRESHOLD_MS) {
      return reply.code(409).send({
        queued: false,
        ticketId: ticket.id,
        jobId,
        error:
          'Analysis job with this ID already exists — was not re-enqueued. ' +
          'Check the Analysis Trace tab for current state.',
      });
    }

    await fastify.db.ticketEvent.create({
      data: {
        ticketId: ticket.id,
        eventType: TicketEventType.SYSTEM_NOTE,
        content: 'Analysis pipeline re-triggered by operator.',
        actor: 'operator',
      },
    });

    const updated = await fastify.db.ticket.findUnique({ where: { id: ticket.id } });

    reply.code(202);
    return { queued: true, ticketId: ticket.id, jobId, ticket: updated };
  });

  // ─── Chat Tab (#312) ────────────────────────────────────────────────────────
  // POST /api/tickets/:id/chat-message — operator sends a message in the Chat tab.
  // Creates a CHAT_MESSAGE TicketEvent, optionally classifies intent via
  // TaskType.CLASSIFY_CHAT_INTENT, and either enqueues a re-analysis job with
  // chatReanalysisMode set, skips when the reply is pure acknowledgement, or
  // surfaces an inline mode picker when classifier confidence is low.
  const CHAT_MODE_VALUES = ['continue', 'refine', 'fresh_start', 'not_a_question'] as const;
  type ChatMode = (typeof CHAT_MODE_VALUES)[number];
  type ReanalysisMode = Exclude<ChatMode, 'not_a_question'>;
  const CHAT_CONFIDENCE_THRESHOLD = 0.6;

  function parseChatClassification(raw: string): { label: ChatMode; confidence: number } {
    const fallback = { label: 'not_a_question' as ChatMode, confidence: 0 };
    if (!raw) return fallback;
    const match = raw.match(/\{[\s\S]*\}/);
    const candidate = match ? match[0] : raw.trim();
    try {
      const parsed = JSON.parse(candidate) as { label?: unknown; confidence?: unknown };
      const label = typeof parsed.label === 'string' ? parsed.label.toLowerCase() : '';
      const conf = typeof parsed.confidence === 'number' ? parsed.confidence : Number(parsed.confidence);
      if (!(CHAT_MODE_VALUES as readonly string[]).includes(label)) return fallback;
      if (!Number.isFinite(conf)) return fallback;
      return { label: label as ChatMode, confidence: Math.max(0, Math.min(1, conf)) };
    } catch {
      return fallback;
    }
  }

  /**
   * Enqueue a chat-driven re-analysis job. Throws when the analysis queue is
   * unavailable so callers can return a 503 rather than silently reporting
   * success with a null jobId.
   */
  async function enqueueChatReanalysis(
    ticketId: string,
    triggerEventId: string,
    mode: ReanalysisMode,
  ): Promise<string> {
    if (!opts?.ticketAnalysisQueue) {
      throw new Error('ticketAnalysisQueue is not configured');
    }
    const jobId = `chat-reanalysis-${ticketId}-${triggerEventId}`;
    const existing = await opts.ticketAnalysisQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'delayed' || state === 'active') return jobId;
      try { await existing.remove(); } catch { /* already cleaned up */ }
    }
    await opts.ticketAnalysisQueue.add('analyze-ticket', {
      ticketId,
      reanalysis: true,
      triggerEventId,
      chatReanalysisMode: mode,
    }, {
      jobId,
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
      // #375: age completed jobs out of Redis so the dedupe state doesn't
      // accumulate indefinitely.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    });
    await fastify.db.ticket.update({
      where: { id: ticketId },
      data: { analysisStatus: AnalysisStatus.PENDING, analysisError: null },
    });
    return jobId;
  }

  fastify.post<{
    Params: { id: string };
    Body: { text?: unknown; modeOverride?: unknown };
  }>('/api/tickets/:id/chat-message', async (request, reply) => {
    const ticket = await fastify.db.ticket.findUnique({
      where: { id: request.params.id },
      select: { id: true, clientId: true, subject: true },
    });
    if (!ticket) return fastify.httpErrors.notFound('Ticket not found');

    // Reject cross-client access as 404 (not 403) to avoid ticket-ID enumeration
    const scope = await resolveClientScope(request);
    if (scope.type === 'single' && ticket.clientId !== scope.clientId) {
      return fastify.httpErrors.notFound('Ticket not found');
    }
    if (scope.type === 'assigned' && !scope.clientIds.includes(ticket.clientId)) {
      return fastify.httpErrors.notFound('Ticket not found');
    }

    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
    if (!text) return fastify.httpErrors.badRequest('text is required');
    if (text.length > 20_000) return fastify.httpErrors.badRequest('text must be 20000 characters or fewer');

    let modeOverride: ChatMode | undefined;
    if (request.body?.modeOverride !== undefined && request.body.modeOverride !== null) {
      if (typeof request.body.modeOverride !== 'string' || !(CHAT_MODE_VALUES as readonly string[]).includes(request.body.modeOverride)) {
        return fastify.httpErrors.badRequest(`modeOverride must be one of ${CHAT_MODE_VALUES.join(', ')}`);
      }
      modeOverride = request.body.modeOverride as ChatMode;
    }

    // Fail fast when the analysis queue isn't configured — any branch that
    // would enqueue will hit this, and skipping branches don't need the queue.
    const willEnqueue = modeOverride !== undefined
      ? modeOverride !== 'not_a_question'
      : true; // classifier path may enqueue depending on result
    if (willEnqueue && !opts?.ticketAnalysisQueue) {
      return fastify.httpErrors.serviceUnavailable('Ticket analysis queue not available');
    }

    const operatorPersonId = request.user?.personId;
    const chatEvent = await fastify.db.ticketEvent.create({
      data: {
        ticketId: ticket.id,
        eventType: TicketEventType.CHAT_MESSAGE,
        content: text,
        actor: operatorPersonId ? `operator:${operatorPersonId}` : 'operator',
        metadata: {
          source: 'chat-tab',
          ...(operatorPersonId && { authorPersonId: operatorPersonId }),
          ...(modeOverride && { modeOverride }),
        },
      },
    });

    // Explicit override → skip classification
    if (modeOverride) {
      if (modeOverride === 'not_a_question') {
        reply.code(202);
        return { decision: 'skipped', chatMessageId: chatEvent.id };
      }
      const reanalysisJobId = await enqueueChatReanalysis(ticket.id, chatEvent.id, modeOverride);
      reply.code(202);
      return { decision: 'enqueued', chatMessageId: chatEvent.id, reanalysisJobId };
    }

    // Otherwise — classify via CLASSIFY_CHAT_INTENT
    let classifiedIntent: { label: ChatMode; confidence: number } = { label: 'not_a_question', confidence: 0 };
    if (opts?.ai) {
      try {
        const response = await opts.ai.generate({
          taskType: TaskType.CLASSIFY_CHAT_INTENT,
          promptKey: 'chat.classify-reply.system',
          prompt: text,
          context: { ticketId: ticket.id, clientId: ticket.clientId },
        });
        classifiedIntent = parseChatClassification(response.content ?? '');
      } catch (err) {
        fastify.log.warn({ err, ticketId: ticket.id }, 'Chat reply classifier unreachable — defaulting to mode picker');
      }
    }

    // Persist the classifier result onto the CHAT_MESSAGE event so the Chat tab
    // can re-render the mode picker across page reloads.
    const existingMeta = (chatEvent.metadata as Record<string, unknown> | null) ?? {};
    const needsModePick = classifiedIntent.confidence < CHAT_CONFIDENCE_THRESHOLD;
    const persistedMeta: Record<string, unknown> = {
      ...existingMeta,
      classifiedIntent: { label: classifiedIntent.label, confidence: classifiedIntent.confidence },
    };
    if (needsModePick) persistedMeta['needsModePick'] = true;
    await fastify.db.ticketEvent.update({
      where: { id: chatEvent.id },
      data: { metadata: persistedMeta as Prisma.InputJsonValue },
    });

    // Low confidence → ask operator
    if (needsModePick) {
      reply.code(202);
      return {
        decision: 'needs_mode_pick',
        chatMessageId: chatEvent.id,
        classifiedIntent,
      };
    }

    // not_a_question with high confidence → skip
    if (classifiedIntent.label === 'not_a_question') {
      reply.code(202);
      return {
        decision: 'skipped',
        chatMessageId: chatEvent.id,
        classifiedIntent,
      };
    }

    // Otherwise → enqueue with classified mode
    const mode = classifiedIntent.label as ReanalysisMode;
    const reanalysisJobId = await enqueueChatReanalysis(ticket.id, chatEvent.id, mode);
    reply.code(202);
    return {
      decision: 'enqueued',
      chatMessageId: chatEvent.id,
      reanalysisJobId,
      classifiedIntent,
    };
  });

  // POST /api/tickets/:id/chat-message/:eventId/pick-mode — resolves low-confidence
  // classifier cases: operator picks a mode, we enqueue re-analysis (or skip for
  // 'not_a_question') and annotate the original CHAT_MESSAGE event.
  fastify.post<{
    Params: { id: string; eventId: string };
    Body: { mode?: unknown };
  }>('/api/tickets/:id/chat-message/:eventId/pick-mode', async (request, reply) => {
    const ticket = await fastify.db.ticket.findUnique({
      where: { id: request.params.id },
      select: { id: true, clientId: true },
    });
    if (!ticket) return fastify.httpErrors.notFound('Ticket not found');

    // Reject cross-client access as 404 (not 403) to avoid ticket-ID enumeration
    const scope = await resolveClientScope(request);
    if (scope.type === 'single' && ticket.clientId !== scope.clientId) {
      return fastify.httpErrors.notFound('Ticket not found');
    }
    if (scope.type === 'assigned' && !scope.clientIds.includes(ticket.clientId)) {
      return fastify.httpErrors.notFound('Ticket not found');
    }

    const event = await fastify.db.ticketEvent.findFirst({
      where: { id: request.params.eventId, ticketId: ticket.id, eventType: TicketEventType.CHAT_MESSAGE },
      select: { id: true, metadata: true },
    });
    if (!event) return fastify.httpErrors.notFound('Chat message not found');

    const modeRaw = request.body?.mode;
    if (typeof modeRaw !== 'string' || !(CHAT_MODE_VALUES as readonly string[]).includes(modeRaw)) {
      return fastify.httpErrors.badRequest(`mode must be one of ${CHAT_MODE_VALUES.join(', ')}`);
    }
    const mode = modeRaw as ChatMode;

    // Any mode other than 'not_a_question' will enqueue — guard queue availability up front.
    if (mode !== 'not_a_question' && !opts?.ticketAnalysisQueue) {
      return fastify.httpErrors.serviceUnavailable('Ticket analysis queue not available');
    }

    // Preserve existing metadata (classifiedIntent, source, etc.) while
    // stamping the operator's pick and clearing the needsModePick flag —
    // the UI uses the absence of needsModePick to hide the picker.
    const existingMeta = (event.metadata as Record<string, unknown> | null) ?? {};
    const { needsModePick: _omit, ...preservedMeta } = existingMeta;
    await fastify.db.ticketEvent.update({
      where: { id: event.id },
      data: { metadata: { ...preservedMeta, pickedMode: mode } as Prisma.InputJsonValue },
    });

    if (mode === 'not_a_question') {
      reply.code(202);
      return { decision: 'skipped', chatMessageId: event.id };
    }

    const reanalysisJobId = await enqueueChatReanalysis(ticket.id, event.id, mode);
    reply.code(202);
    return { decision: 'enqueued', chatMessageId: event.id, reanalysisJobId };
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

    // Scope guard: verify the ticket exists and belongs to the caller's tenant.
    if (!await assertTicketInScope(request, request.params.id)) {
      return fastify.httpErrors.notFound('Ticket not found');
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

    // Scope guard: verify the ticket exists and belongs to the caller's tenant.
    if (!await assertTicketInScope(request, request.params.id)) {
      return fastify.httpErrors.notFound('Ticket not found');
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

    // Scope guard: verify the ticket exists and belongs to the caller's tenant.
    if (!await assertTicketInScope(request, request.params.id)) {
      return fastify.httpErrors.notFound('Ticket not found');
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
      parentLogId?: string | null;
      parentLogType?: string | null;
      taskRun?: number | null;
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

      const ctx = log.context as Record<string, unknown> | null;
      entries.push({
        id: log.id,
        type: entryType,
        timestamp: log.createdAt.toISOString(),
        level: log.level,
        service: log.service,
        message: log.message,
        context: log.context,
        error: log.error,
        durationMs: (ctx?.durationMs as number | null) ?? null,
        parentLogId: log.parentLogId ?? null,
        parentLogType: log.parentLogType ?? null,
        taskRun: log.taskRun ?? null,
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
        parentLogId: ai.parentLogId ?? null,
        parentLogType: ai.parentLogType ?? null,
        taskRun: ai.taskRun ?? null,
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
    // Scope guard: verify the ticket exists and belongs to the caller's tenant.
    if (!await assertTicketInScope(request, request.params.id)) {
      return fastify.httpErrors.notFound('Ticket not found');
    }

    const ticketId = request.params.id;

    const [rows, toolCallCount, wallClockResult] = await Promise.all([
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
      // Wall-clock duration: (first call start) → (last call end).
      // Start time = MIN(created_at - duration_ms), i.e. when the first call was initiated.
      // End time   = MAX(created_at), i.e. when the last call completed.
      // Using start time rather than MIN(created_at) avoids under-reporting when the first
      // call has a long duration_ms that began well before other calls completed.
      // More accurate than SUM(duration_ms) for parallel sub-tasks (avoids double-counting).
      fastify.db.$queryRaw<[{ start_ms: bigint | null; end_ms: bigint | null; input_tokens: bigint | null; output_tokens: bigint | null }]>`
        SELECT
          MIN(EXTRACT(EPOCH FROM created_at) * 1000 - COALESCE(duration_ms, 0))::bigint AS start_ms,
          MAX(EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS end_ms,
          SUM(input_tokens)::bigint AS input_tokens,
          SUM(output_tokens)::bigint AS output_tokens
        FROM ai_usage_logs
        WHERE entity_id = ${ticketId}::uuid
          AND entity_type = 'ticket'
      `,
    ]);

    const totals = rows.reduce(
      (acc, r) => {
        acc.totalCostUsd += r._sum.costUsd ?? 0;
        acc.callCount += r._count;
        return acc;
      },
      { totalCostUsd: 0, callCount: 0 },
    );

    const wc = wallClockResult[0];
    const wallClockMs =
      wc?.start_ms != null && wc?.end_ms != null
        ? Number(wc.end_ms) - Number(wc.start_ms)
        : 0;

    return {
      entityId: ticketId,
      totalCostUsd: totals.totalCostUsd,
      callCount: totals.callCount,
      toolCallCount,
      totalInputTokens: wc?.input_tokens != null ? Number(wc.input_tokens) : 0,
      totalOutputTokens: wc?.output_tokens != null ? Number(wc.output_tokens) : 0,
      wallClockMs,
      breakdown: rows.map(r => ({
        provider: r.provider,
        model: r.model,
        callCount: r._count,
        totalInputTokens: r._sum.inputTokens ?? 0,
        totalOutputTokens: r._sum.outputTokens ?? 0,
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

      const scope = await resolveClientScope(request);
      const scopeWhere = scopeToWhere(scope);
      const ticket = await fastify.db.ticket.findFirst({
        where: { id: request.params.id, ...scopeWhere },
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
