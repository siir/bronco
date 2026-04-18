import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { UserRole } from '@bronco/shared-types';
import type { AuthUser } from '../plugins/auth.js';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('users');
const VALID_ROLES: string[] = [UserRole.ADMIN, UserRole.OPERATOR];
const OPERATOR_ROLES = new Set<string>([UserRole.ADMIN, UserRole.OPERATOR]);

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
   * GET /api/search/users
   * Lightweight search for the command palette. Admin gate inherited from preHandler.
   */
  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search/users',
    async (request) => {
      const rawQ = (request.query.q ?? '').trim();
      if (!rawQ) return fastify.httpErrors.badRequest('q is required');
      if (rawQ.length < 2) return fastify.httpErrors.badRequest('q must be at least 2 characters');

      const rawLimit = request.query.limit ?? '20';
      const limit = Math.trunc(Number(rawLimit));
      if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
        return fastify.httpErrors.badRequest('limit must be between 1 and 50');
      }

      const results = await fastify.db.user.findMany({
        where: {
          OR: [
            { name: { contains: rawQ, mode: 'insensitive' } },
            { email: { contains: rawQ, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
        },
        take: limit,
        orderBy: { name: 'asc' },
      });

      const qLower = rawQ.toLowerCase();
      results.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        return aStarts - bStarts;
      });

      return results.slice(0, limit);
    },
  );

  /**
   * GET /api/users
   * List all control panel users. Includes slackUserId from matching Operator record.
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

    // Bulk-load Operator records for ADMIN/OPERATOR users to attach slackUserId
    const operatorEmails = users
      .filter((u) => OPERATOR_ROLES.has(u.role))
      .map((u) => u.email);

    const operators = operatorEmails.length > 0
      ? await fastify.db.operator.findMany({
          where: { email: { in: operatorEmails } },
          select: { email: true, slackUserId: true },
        })
      : [];

    const slackMap = new Map(operators.map((o) => [o.email, o.slackUserId]));

    return users.map((u) => ({
      ...u,
      slackUserId: OPERATOR_ROLES.has(u.role) ? (slackMap.get(u.email) ?? null) : undefined,
    }));
  });

  /**
   * POST /api/users
   * Create a new control panel user. Auto-creates Operator record when role is ADMIN/OPERATOR.
   */
  fastify.post<{ Body: { email: string; password: string; name: string; role?: string; slackUserId?: string } }>(
    '/api/users',
    async (request, reply) => {
      const { email: rawEmail, password, name, role, slackUserId } = request.body;

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
      const effectiveRole = (role as UserRole) ?? UserRole.OPERATOR;
      const user = await fastify.db.user.create({
        data: {
          email,
          passwordHash,
          name: name.trim(),
          role: effectiveRole,
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

      // Auto-sync Operator record for ADMIN/OPERATOR roles
      let operatorSlackUserId: string | null = null;
      if (OPERATOR_ROLES.has(effectiveRole)) {
        const trimmedSlackUserId = slackUserId?.trim() || null;
        try {
          const existingOp = await fastify.db.operator.findUnique({ where: { email } });
          if (existingOp) {
            if (trimmedSlackUserId !== null) {
              await fastify.db.operator.update({ where: { email }, data: { slackUserId: trimmedSlackUserId } });
            }
            operatorSlackUserId = trimmedSlackUserId ?? existingOp.slackUserId;
          } else {
            const op = await fastify.db.operator.create({
              data: { email, name: name.trim(), slackUserId: trimmedSlackUserId },
            });
            operatorSlackUserId = op.slackUserId;
          }
        } catch (err) {
          logger.warn({ err, email }, 'Failed to sync Operator record on user create');
        }
      }

      return reply.code(201).send({ ...user, slackUserId: operatorSlackUserId });
    },
  );

  /**
   * PATCH /api/users/:id
   * Update a control panel user. Syncs slackUserId to Operator record when provided.
   */
  fastify.patch<{ Params: { id: string }; Body: { name?: string; email?: string; role?: string; isActive?: boolean; slackUserId?: string } }>(
    '/api/users/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { name, email: rawEmail, role, isActive, slackUserId } = request.body;

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

      // Sync slackUserId to Operator record
      let operatorSlackUserId: string | null | undefined;
      const effectiveRole = updated.role as string;
      if (OPERATOR_ROLES.has(effectiveRole)) {
        const operatorEmail = updated.email;
        try {
          const existingOp = await fastify.db.operator.findUnique({ where: { email: operatorEmail } });
          if (slackUserId !== undefined) {
            const trimmedSlackUserId = slackUserId.trim() || null;
            if (existingOp) {
              await fastify.db.operator.update({ where: { email: operatorEmail }, data: { slackUserId: trimmedSlackUserId } });
              operatorSlackUserId = trimmedSlackUserId;
            } else {
              const op = await fastify.db.operator.create({
                data: { email: operatorEmail, name: updated.name, slackUserId: trimmedSlackUserId },
              });
              operatorSlackUserId = op.slackUserId;
            }
          } else {
            operatorSlackUserId = existingOp?.slackUserId ?? null;
          }
        } catch (err) {
          logger.warn({ err, email: operatorEmail }, 'Failed to sync Operator record on user update');
        }
      }

      return { ...updated, ...(operatorSlackUserId !== undefined && { slackUserId: operatorSlackUserId }) };
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
      if (!target) return fastify.httpErrors.notFound('User not found');

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
