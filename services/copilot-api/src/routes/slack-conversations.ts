import type { FastifyInstance } from 'fastify';

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

    const where: Record<string, unknown> = {};
    if (operatorId) where.operatorId = operatorId;
    if (clientId) where.clientId = clientId;

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

    // Flatten operator.person.name → operator.name to preserve the pre-Wave-1
    // response shape expected by the control panel. Wave 2C will consume the
    // unified Person+Operator model natively.
    const items = rows.map((r) => ({
      ...r,
      operator: r.operator ? { id: r.operator.id, name: r.operator.person.name } : null,
    }));

    return { items, total };
  });

  // --- Get conversation detail ---
  fastify.get<{ Params: { id: string } }>('/api/slack-conversations/:id', async (request) => {
    const { id } = request.params;

    const conversation = await fastify.db.slackConversationLog.findUnique({
      where: { id },
      include: {
        operator: { select: { id: true, person: { select: { name: true } } } },
        client: { select: { id: true, name: true, shortCode: true } },
      },
    });

    if (!conversation) {
      return fastify.httpErrors.notFound('Conversation not found');
    }

    // Match the list-route flatten: preserve pre-Wave-1 operator.name shape.
    return {
      ...conversation,
      operator: conversation.operator
        ? { id: conversation.operator.id, name: conversation.operator.person.name }
        : null,
    };
  });
}
