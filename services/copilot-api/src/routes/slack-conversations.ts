import type { FastifyInstance } from 'fastify';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

export async function slackConversationRoutes(fastify: FastifyInstance): Promise<void> {
  // --- List conversations ---
  fastify.get<{
    Querystring: {
      operatorId?: string;
      clientId?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/slack-conversations', async (request) => {
    const {
      operatorId,
      clientId,
      startDate,
      endDate,
      limit: rawLimit = '50',
      offset: rawOffset = '0',
    } = request.query;

    const takeNum = Number(rawLimit);
    const skipNum = Number(rawOffset);
    if (!Number.isFinite(takeNum) || !Number.isInteger(takeNum) || takeNum < 0 ||
        !Number.isFinite(skipNum) || !Number.isInteger(skipNum) || skipNum < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }

    // Scope enforcement: restrict to caller's client(s)
    const callerScope = await resolveClientScope(request);
    const scopeWhere = scopeToWhere(callerScope);

    const where: Record<string, unknown> = {
      // Apply scope — conversations with clientId=null are only visible to 'all' callers
      ...scopeWhere,
    };
    if (operatorId) where.operatorId = operatorId;

    // If a clientId filter is requested, validate it is within the caller's scope
    const effectiveClientId =
      clientId &&
      (callerScope.type === 'all' ||
        (callerScope.type === 'single' && callerScope.clientId === clientId) ||
        (callerScope.type === 'assigned' && callerScope.clientIds.includes(clientId)))
        ? clientId
        : undefined;
    if (effectiveClientId) where.clientId = effectiveClientId;

    if (startDate || endDate) {
      const createdAt: Record<string, Date> = {};
      if (startDate) {
        const d = new Date(startDate);
        if (Number.isNaN(d.getTime())) return fastify.httpErrors.badRequest('startDate must be a valid date');
        createdAt.gte = d;
      }
      if (endDate) {
        const d = new Date(endDate);
        if (Number.isNaN(d.getTime())) return fastify.httpErrors.badRequest('endDate must be a valid date');
        createdAt.lte = d;
      }
      where.createdAt = createdAt;
    }

    const [rows, total] = await Promise.all([
      fastify.db.slackConversationLog.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: Math.min(takeNum, 200),
        skip: skipNum,
        select: {
          id: true,
          channelId: true,
          threadTs: true,
          messageCount: true,
          totalCost: true,
          totalInputTokens: true,
          totalOutputTokens: true,
          createdAt: true,
          updatedAt: true,
          operator: { select: { id: true, person: { select: { name: true } } } },
          client: { select: { id: true, name: true, shortCode: true } },
        },
      }),
      fastify.db.slackConversationLog.count({ where }),
    ]);

    return { items: rows, total };
  });

  // --- Get conversation detail ---
  fastify.get<{ Params: { id: string } }>('/api/slack-conversations/:id', async (request) => {
    const { id } = request.params;

    const callerScope = await resolveClientScope(request);
    const scopeWhere = scopeToWhere(callerScope);

    const conversation = await fastify.db.slackConversationLog.findFirst({
      where: { id, ...scopeWhere },
      include: {
        operator: { select: { id: true, person: { select: { name: true } } } },
        client: { select: { id: true, name: true, shortCode: true } },
      },
    });

    if (!conversation) {
      return fastify.httpErrors.notFound('Conversation not found');
    }

    return conversation;
  });
}
