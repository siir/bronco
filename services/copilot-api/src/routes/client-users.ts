import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

export async function clientUserRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/client-users?clientId=X
   * List client portal users for a given client.
   */
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/client-users',
    async (request, reply) => {
      const { clientId } = request.query;
      if (!clientId) {
        return reply.code(400).send({ error: 'clientId is required' });
      }

      const users = await fastify.db.clientUser.findMany({
        where: { clientId },
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
        orderBy: { name: 'asc' },
      });

      return users;
    },
  );

  /**
   * POST /api/client-users
   * Create a client portal user (from control panel).
   */
  fastify.post<{ Body: { clientId: string; email: string; password: string; name: string; userType?: string } }>(
    '/api/client-users',
    async (request, reply) => {
      const { clientId, email: rawEmail, password, name, userType } = request.body;

      if (!clientId || !rawEmail || !password || !name) {
        return reply.code(400).send({ error: 'clientId, email, password, and name are required' });
      }

      const email = rawEmail.trim().toLowerCase();

      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      // Verify client exists
      const client = await fastify.db.client.findUnique({ where: { id: clientId } });
      if (!client) {
        return reply.code(404).send({ error: 'Client not found' });
      }

      const existing = await fastify.db.clientUser.findUnique({ where: { email } });
      if (existing) {
        return reply.code(409).send({ error: 'A user with this email already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await fastify.db.clientUser.create({
        data: {
          email,
          passwordHash,
          name: name.trim(),
          clientId,
          userType: (userType === 'ADMIN' ? 'ADMIN' : 'USER') as 'ADMIN' | 'USER',
        },
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });

      return reply.code(201).send(user);
    },
  );

  /**
   * PATCH /api/client-users/:id
   * Update a client portal user.
   */
  fastify.patch<{ Params: { id: string }; Body: { name?: string; email?: string; userType?: string; isActive?: boolean } }>(
    '/api/client-users/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { name, email: rawEmail, userType, isActive } = request.body;

      if (userType && userType !== 'ADMIN' && userType !== 'USER') {
        return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN or USER' });
      }

      const target = await fastify.db.clientUser.findUnique({ where: { id } });
      if (!target) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const email = rawEmail?.trim().toLowerCase();
      if (email) {
        const existing = await fastify.db.clientUser.findUnique({ where: { email } });
        if (existing && existing.id !== id) {
          return reply.code(409).send({ error: 'Email is already in use' });
        }
      }

      const updated = await fastify.db.clientUser.update({
        where: { id },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email }),
          ...(userType && { userType: userType as 'ADMIN' | 'USER' }),
          ...(isActive !== undefined && { isActive }),
        },
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });

      return updated;
    },
  );

  /**
   * DELETE /api/client-users/:id
   * Deactivate a client portal user.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/client-users/:id',
    async (request, reply) => {
      const target = await fastify.db.clientUser.findUnique({ where: { id: request.params.id } });
      if (!target) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await fastify.db.clientUser.update({
        where: { id: request.params.id },
        data: { isActive: false },
      });

      return { message: 'User deactivated' };
    },
  );

  /**
   * POST /api/client-users/:id/reset-password
   * Reset a client portal user's password.
   */
  fastify.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/client-users/:id/reset-password',
    async (request, reply) => {
      const { id } = request.params;
      const { password } = request.body;

      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      const target = await fastify.db.clientUser.findUnique({ where: { id } });
      if (!target) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await fastify.db.clientUser.update({
        where: { id },
        data: { passwordHash },
      });

      return { message: 'Password reset successfully' };
    },
  );
}
