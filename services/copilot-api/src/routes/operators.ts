import type { FastifyInstance } from 'fastify';

export async function operatorRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/operators
   * List all operators. Defaults to active only; pass ?includeInactive=true for all.
   */
  fastify.get<{ Querystring: { includeInactive?: string } }>(
    '/api/operators',
    async (request) => {
      const includeInactive = request.query.includeInactive === 'true';
      return fastify.db.operator.findMany({
        where: includeInactive ? {} : { isActive: true },
        orderBy: { name: 'asc' },
      });
    },
  );

  /**
   * GET /api/operators/:id
   * Get a single operator by ID.
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/operators/:id',
    async (request) => {
      const operator = await fastify.db.operator.findUnique({
        where: { id: request.params.id },
      });
      if (!operator) return fastify.httpErrors.notFound('Operator not found');
      return operator;
    },
  );

  /**
   * POST /api/operators
   * Create a new operator.
   */
  fastify.post<{
    Body: {
      email: string;
      name: string;
      notifyEmail?: boolean;
      notifySlack?: boolean;
      slackUserId?: string;
    };
  }>('/api/operators', async (request, reply) => {
    const { email: rawEmail, name, notifyEmail, notifySlack, slackUserId } = request.body;

    if (!rawEmail || !name) {
      return reply.code(400).send({ error: 'Email and name are required' });
    }

    const email = rawEmail.trim().toLowerCase();

    const existing = await fastify.db.operator.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: 'An operator with this email already exists' });
    }

    const operator = await fastify.db.operator.create({
      data: {
        email,
        name: name.trim(),
        ...(notifyEmail !== undefined && { notifyEmail }),
        ...(notifySlack !== undefined && { notifySlack }),
        ...(slackUserId !== undefined && { slackUserId: slackUserId || null }),
      },
    });

    return reply.code(201).send(operator);
  });

  /**
   * PATCH /api/operators/:id
   * Update an operator's profile or notification preferences.
   */
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      email?: string;
      isActive?: boolean;
      notifyEmail?: boolean;
      notifySlack?: boolean;
      slackUserId?: string | null;
    };
  }>('/api/operators/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, email: rawEmail, isActive, notifyEmail, notifySlack, slackUserId } = request.body;

    const target = await fastify.db.operator.findUnique({ where: { id } });
    if (!target) {
      return reply.code(404).send({ error: 'Operator not found' });
    }

    const email = rawEmail?.trim().toLowerCase();
    if (email) {
      const existing = await fastify.db.operator.findUnique({ where: { email } });
      if (existing && existing.id !== id) {
        return reply.code(409).send({ error: 'Email is already in use by another operator' });
      }
    }

    const updated = await fastify.db.operator.update({
      where: { id },
      data: {
        ...(name && { name: name.trim() }),
        ...(email && { email }),
        ...(isActive !== undefined && { isActive }),
        ...(notifyEmail !== undefined && { notifyEmail }),
        ...(notifySlack !== undefined && { notifySlack }),
        ...(slackUserId !== undefined && { slackUserId: slackUserId || null }),
      },
    });

    return updated;
  });

  /**
   * DELETE /api/operators/:id
   * Soft-delete an operator by setting isActive=false.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/operators/:id',
    async (request) => {
      const { id } = request.params;

      const target = await fastify.db.operator.findUnique({ where: { id } });
      if (!target) return fastify.httpErrors.notFound('Operator not found');

      await fastify.db.operator.update({
        where: { id },
        data: { isActive: false },
      });

      return { message: 'Operator deactivated' };
    },
  );
}
