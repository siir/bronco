import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { UserRole } from '@bronco/shared-types';
import type { AuthUser } from '../plugins/auth.js';

const VALID_ROLES: string[] = [UserRole.ADMIN, UserRole.OPERATOR];

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Require ADMIN role for all user management routes.
   * Only admins can create, edit, or deactivate control panel users.
   */
  fastify.addHook('preHandler', async (request, reply) => {
    const authUser = request.user as AuthUser | undefined;
    if (!authUser) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    if (authUser.role !== UserRole.ADMIN) {
      return reply.code(403).send({ error: 'Only admins can manage users' });
    }
  });

  /**
   * GET /api/users
   * List all control panel users.
   */
  fastify.get('/api/users', async () => {
    const users = await fastify.db.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        clientId: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { name: 'asc' },
    });

    return users;
  });

  /**
   * POST /api/users
   * Create a new control panel user.
   */
  fastify.post<{ Body: { email: string; password: string; name: string; role?: string } }>(
    '/api/users',
    async (request, reply) => {
      const { email: rawEmail, password, name, role } = request.body;

      if (!rawEmail || !password || !name) {
        return reply.code(400).send({ error: 'Email, password, and name are required' });
      }

      const email = rawEmail.trim().toLowerCase();

      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      if (role && !VALID_ROLES.includes(role)) {
        return reply.code(400).send({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      }

      const existing = await fastify.db.user.findUnique({ where: { email } });
      if (existing) {
        return reply.code(409).send({ error: 'A user with this email already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await fastify.db.user.create({
        data: {
          email,
          passwordHash,
          name: name.trim(),
          role: (role as UserRole) ?? UserRole.OPERATOR,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          clientId: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });

      return reply.code(201).send(user);
    },
  );

  /**
   * PATCH /api/users/:id
   * Update a control panel user.
   */
  fastify.patch<{ Params: { id: string }; Body: { name?: string; email?: string; role?: string; isActive?: boolean } }>(
    '/api/users/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { name, email: rawEmail, role, isActive } = request.body;

      if (role && !VALID_ROLES.includes(role)) {
        return reply.code(400).send({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      }

      const authUser = request.user as AuthUser;
      if (isActive === false && authUser.id === id) {
        return reply.code(400).send({ error: 'Cannot deactivate your own account' });
      }
      if (role && role !== UserRole.ADMIN && authUser.id === id) {
        return reply.code(400).send({ error: 'Cannot demote your own account' });
      }

      const target = await fastify.db.user.findUnique({ where: { id } });
      if (!target) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const email = rawEmail?.trim().toLowerCase();
      if (email) {
        const existing = await fastify.db.user.findUnique({ where: { email } });
        if (existing && existing.id !== id) {
          return reply.code(409).send({ error: 'Email is already in use' });
        }
      }

      const updated = await fastify.db.user.update({
        where: { id },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email }),
          ...(role && { role: role as UserRole }),
          ...(isActive !== undefined && { isActive }),
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          clientId: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });

      return updated;
    },
  );

  /**
   * DELETE /api/users/:id
   * Deactivate a control panel user.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/users/:id',
    async (request, reply) => {
      const { id } = request.params;

      // Prevent self-deactivation
      const authUser = request.user as AuthUser | undefined;
      if (authUser && authUser.id === id) {
        return reply.code(400).send({ error: 'Cannot deactivate your own account' });
      }

      const target = await fastify.db.user.findUnique({ where: { id } });
      if (!target) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await fastify.db.user.update({
        where: { id },
        data: { isActive: false },
      });

      return { message: 'User deactivated' };
    },
  );

  /**
   * POST /api/users/:id/reset-password
   * Reset a control panel user's password.
   */
  fastify.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/users/:id/reset-password',
    async (request, reply) => {
      const { id } = request.params;
      const { password } = request.body;

      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      const target = await fastify.db.user.findUnique({ where: { id } });
      if (!target) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await fastify.db.user.update({
        where: { id },
        data: { passwordHash },
      });

      return { message: 'Password reset successfully' };
    },
  );
}
