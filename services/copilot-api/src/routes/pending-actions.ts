import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@bronco/db';
import { isClosedStatus } from '@bronco/shared-types';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('pending-actions');

const VALID_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED']);
const VALID_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const VALID_CATEGORIES = new Set([
  'DATABASE_PERF', 'BUG_FIX', 'FEATURE_REQUEST', 'SCHEMA_CHANGE',
  'CODE_REVIEW', 'ARCHITECTURE', 'GENERAL',
]);

/** Execute a single pending action upon operator approval. */
async function executePendingAction(
  db: PrismaClient,
  ticketId: string,
  actionValue: Record<string, unknown>,
): Promise<boolean> {
  const actionName = (actionValue.action as string) ?? '';
  const rawValue = (actionValue.value as string | undefined)?.trim();
  const value = rawValue?.toUpperCase();
  const reason = (actionValue.reason as string) ?? 'Operator-approved action';

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { status: true, priority: true, category: true },
  });
  if (!ticket) return false;

  switch (actionName) {
    case 'set_status': {
      if (!value || !VALID_STATUSES.has(value) || value === ticket.status) return false;
      await db.ticket.update({
        where: { id: ticketId },
        data: {
          status: value as 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'RESOLVED' | 'CLOSED',
          resolvedAt: isClosedStatus(value) ? new Date() : null,
        },
      });
      await db.ticketEvent.create({
        data: {
          ticketId,
          eventType: 'STATUS_CHANGE',
          content: `Approved: status changed to ${value} — ${reason}`,
          metadata: { previousStatus: ticket.status, newStatus: value, triggeredBy: 'operator_approval' },
          actor: 'system:recommendation-executor',
        },
      });
      return true;
    }
    case 'set_priority': {
      if (!value || !VALID_PRIORITIES.has(value) || value === ticket.priority) return false;
      await db.ticket.update({
        where: { id: ticketId },
        data: { priority: value as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' },
      });
      await db.ticketEvent.create({
        data: {
          ticketId,
          eventType: 'PRIORITY_CHANGE',
          content: `Approved: priority changed to ${value} — ${reason}`,
          metadata: { previousPriority: ticket.priority, newPriority: value, triggeredBy: 'operator_approval' },
          actor: 'system:recommendation-executor',
        },
      });
      return true;
    }
    case 'set_category': {
      if (!value || !VALID_CATEGORIES.has(value) || value === ticket.category) return false;
      await db.ticket.update({
        where: { id: ticketId },
        data: { category: value as 'DATABASE_PERF' | 'BUG_FIX' | 'FEATURE_REQUEST' | 'SCHEMA_CHANGE' | 'CODE_REVIEW' | 'ARCHITECTURE' | 'GENERAL' },
      });
      await db.ticketEvent.create({
        data: {
          ticketId,
          eventType: 'CATEGORY_CHANGE',
          content: `Approved: category changed to ${value} — ${reason}`,
          metadata: { previousCategory: ticket.category, newCategory: value, triggeredBy: 'operator_approval' },
          actor: 'system:recommendation-executor',
        },
      });
      return true;
    }
    case 'add_comment': {
      const text = rawValue ?? reason;
      if (!text) return false;
      await db.ticketEvent.create({
        data: {
          ticketId,
          eventType: 'COMMENT',
          content: text,
          metadata: { triggeredBy: 'operator_approval' },
          actor: 'system:recommendation-executor',
        },
      });
      return true;
    }
    default:
      // Unknown action types that need approval don't have auto-execute logic
      return false;
  }
}

export async function pendingActionRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/pending-actions — global list of pending actions (dashboard view)
  fastify.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
  }>('/api/pending-actions', async (request) => {
    const status = request.query.status ?? 'pending';
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const offset = Number(request.query.offset) || 0;

    const [items, total] = await Promise.all([
      fastify.db.pendingAction.findMany({
        where: { status },
        include: { ticket: { select: { id: true, subject: true, ticketNumber: true, clientId: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      fastify.db.pendingAction.count({ where: { status } }),
    ]);

    return { items, total };
  });

  // GET /api/tickets/:id/pending-actions — list pending actions for a ticket
  fastify.get<{
    Params: { id: string };
    Querystring: { status?: string };
  }>('/api/tickets/:id/pending-actions', async (request) => {
    const { id } = request.params;
    const where: Record<string, unknown> = { ticketId: id };
    if (request.query.status) where.status = request.query.status;

    return fastify.db.pendingAction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  });

  // POST /api/tickets/:id/pending-actions/:actionId/approve — approve and execute
  fastify.post<{
    Params: { id: string; actionId: string };
  }>('/api/tickets/:id/pending-actions/:actionId/approve', async (request) => {
    const { id, actionId } = request.params;

    const userId = (request as unknown as { user?: { id?: string } }).user?.id ?? null;

    // Atomic transition: only one operator can approve a given pending action.
    // updateMany with the 'pending' status filter acts as a compare-and-swap;
    // if another operator already approved/dismissed it, count will be 0.
    const resolvedAt = new Date();
    const { count } = await fastify.db.pendingAction.updateMany({
      where: { id: actionId, ticketId: id, status: 'pending' },
      data: {
        status: 'approved',
        resolvedAt,
        resolvedBy: userId,
      },
    });

    if (count === 0) {
      return fastify.httpErrors.conflict('Pending action not found or already resolved');
    }

    // Re-fetch the now-approved action so we have its data for execution and event logging.
    const action = await fastify.db.pendingAction.findUnique({ where: { id: actionId } });
    if (!action) {
      return fastify.httpErrors.notFound('Pending action not found after approval');
    }

    // Execute the action
    const executed = await executePendingAction(
      fastify.db,
      action.ticketId,
      action.value as Record<string, unknown>,
    );

    // Return the updated record
    const updated = await fastify.db.pendingAction.findUnique({ where: { id: actionId } });

    // Log the approval as a ticket event
    await fastify.db.ticketEvent.create({
      data: {
        ticketId: id,
        eventType: 'SYSTEM_NOTE',
        content: `Pending action approved: ${action.actionType}${executed ? ' (executed)' : ' (execution skipped)'}`,
        metadata: { pendingActionId: actionId, actionType: action.actionType, executed },
        actor: userId ? `operator:${userId}` : 'system:api',
      },
    });

    logger.info({ ticketId: id, actionId, actionType: action.actionType, executed }, 'Pending action approved');
    return updated;
  });

  // POST /api/tickets/:id/pending-actions/:actionId/dismiss — dismiss without executing
  fastify.post<{
    Params: { id: string; actionId: string };
  }>('/api/tickets/:id/pending-actions/:actionId/dismiss', async (request) => {
    const { id, actionId } = request.params;

    const action = await fastify.db.pendingAction.findFirst({
      where: { id: actionId, ticketId: id, status: 'pending' },
    });

    if (!action) {
      return fastify.httpErrors.notFound('Pending action not found or already resolved');
    }

    const userId = (request as unknown as { user?: { id?: string } }).user?.id ?? null;

    const updated = await fastify.db.pendingAction.update({
      where: { id: actionId },
      data: {
        status: 'dismissed',
        resolvedAt: new Date(),
        resolvedBy: userId,
      },
    });

    await fastify.db.ticketEvent.create({
      data: {
        ticketId: id,
        eventType: 'SYSTEM_NOTE',
        content: `Pending action dismissed: ${action.actionType}`,
        metadata: { pendingActionId: actionId, actionType: action.actionType },
        actor: userId ? `operator:${userId}` : 'system:api',
      },
    });

    logger.info({ ticketId: id, actionId, actionType: action.actionType }, 'Pending action dismissed');
    return updated;
  });
}
