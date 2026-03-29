import type { FastifyInstance } from 'fastify';
import { OperationalTaskStatus, OperationalTaskSource, OperationalTaskEventType, Priority } from '@bronco/shared-types';

const VALID_STATUSES: Set<string> = new Set(Object.values(OperationalTaskStatus));
const VALID_SOURCES: Set<string> = new Set(Object.values(OperationalTaskSource));
const VALID_PRIORITIES: Set<string> = new Set(Object.values(Priority));
const VALID_EVENT_TYPES: Set<string> = new Set(Object.values(OperationalTaskEventType));

export async function operationalTaskRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/operational-tasks — list with filters
  fastify.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    '/api/operational-tasks',
    async (request) => {
      const { status, limit: rawLimit = '50', offset: rawOffset = '0' } = request.query;

      const take = Math.trunc(Number(rawLimit));
      const skip = Math.trunc(Number(rawOffset));
      if (!Number.isFinite(take) || take < 0 || !Number.isFinite(skip) || skip < 0) {
        return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
      }

      let statusFilter: OperationalTaskStatus | { in: OperationalTaskStatus[] } | undefined;
      if (status) {
        const values = status.split(',').map(s => s.trim()).filter(Boolean);
        const invalid = values.filter(v => !VALID_STATUSES.has(v));
        if (invalid.length > 0) {
          return fastify.httpErrors.badRequest(`Invalid status values: ${invalid.join(', ')}`);
        }
        statusFilter = values.length === 1
          ? values[0] as OperationalTaskStatus
          : { in: values as OperationalTaskStatus[] };
      }

      return fastify.db.operationalTask.findMany({
        where: {
          ...(statusFilter && { status: statusFilter }),
        },
        include: {
          _count: { select: { events: true } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      });
    },
  );

  // GET /api/operational-tasks/:id — single task with events
  fastify.get<{ Params: { id: string } }>('/api/operational-tasks/:id', async (request) => {
    const task = await fastify.db.operationalTask.findUnique({
      where: { id: request.params.id },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        devopsSyncState: true,
      },
    });
    if (!task) return fastify.httpErrors.notFound('Operational task not found');
    return task;
  });

  // POST /api/operational-tasks — create manually
  fastify.post<{
    Body: {
      subject: string;
      description?: string;
      priority?: string;
      source?: string;
    };
  }>('/api/operational-tasks', async (request, reply) => {
    const { subject, description, priority, source } = request.body;

    if (!subject?.trim()) return fastify.httpErrors.badRequest('subject is required');
    if (priority && !VALID_PRIORITIES.has(priority)) return fastify.httpErrors.badRequest(`Invalid priority: ${priority}`);
    if (source && !VALID_SOURCES.has(source)) return fastify.httpErrors.badRequest(`Invalid source: ${source}`);

    const task = await fastify.db.operationalTask.create({
      data: {
        subject,
        description,
        priority: priority as Priority,
        source: source as OperationalTaskSource,
      },
    });

    reply.code(201);
    return task;
  });

  // POST /api/operational-tasks/:id/events — add event
  fastify.post<{
    Params: { id: string };
    Body: {
      eventType: string;
      content?: string;
      metadata?: Record<string, unknown>;
      actor?: string;
    };
  }>('/api/operational-tasks/:id/events', async (request, reply) => {
    const { eventType, content, metadata, actor } = request.body;

    if (!VALID_EVENT_TYPES.has(eventType)) return fastify.httpErrors.badRequest(`Invalid eventType: ${eventType}`);

    const task = await fastify.db.operationalTask.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!task) return fastify.httpErrors.notFound('Operational task not found');

    const event = await fastify.db.operationalTaskEvent.create({
      data: {
        taskId: request.params.id,
        eventType: eventType as OperationalTaskEventType,
        content,
        metadata: metadata as never ?? undefined,
        actor,
      },
    });
    reply.code(201);
    return event;
  });

  // PATCH /api/operational-tasks/:id — update status/priority
  fastify.patch<{ Params: { id: string }; Body: { status?: string; priority?: string } }>(
    '/api/operational-tasks/:id',
    async (request) => {
      const { status, priority } = request.body;
      if (status && !VALID_STATUSES.has(status)) return fastify.httpErrors.badRequest(`Invalid status: ${status}`);
      if (priority && !VALID_PRIORITIES.has(priority)) return fastify.httpErrors.badRequest(`Invalid priority: ${priority}`);

      try {
        return await fastify.db.operationalTask.update({
          where: { id: request.params.id },
          data: {
            ...(status && { status: status as OperationalTaskStatus }),
            ...(priority && { priority: priority as Priority }),
          },
        });
      } catch (err) {
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'P2025') {
          return fastify.httpErrors.notFound('Operational task not found');
        }
        throw err;
      }
    },
  );
}
