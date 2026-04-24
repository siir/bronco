import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { OperatorRole } from '@bronco/shared-types';
import type { AuthUser } from '../plugins/auth.js';
import { createLogger } from '@bronco/shared-utils';


const logger = createLogger('users');

type UserTypeSlug = 'ADMIN' | 'STANDARD';

const VALID_ROLE_SLUGS: readonly UserTypeSlug[] = ['ADMIN', 'STANDARD'];

function toOperatorRole(value: string): OperatorRole | null {
  if (value === 'ADMIN') return OperatorRole.ADMIN;
  // Accept the legacy "OPERATOR" slug as an alias for STANDARD so existing
  // frontend code continues to work during Wave 2C migration.
  if (value === 'STANDARD' || value === 'OPERATOR') return OperatorRole.STANDARD;
  return null;
}

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Require ADMIN operator for all user management routes.
   */
  fastify.addHook('preHandler', async (request, reply) => {
    const authUser = request.user as AuthUser | undefined;
    if (!authUser) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    if (authUser.role !== OperatorRole.ADMIN) {
      return reply.code(403).send({ error: 'Only admins can manage users' });
    }
  });

  /**
   * GET /api/search/users
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

      const people = await fastify.db.person.findMany({
        where: {
          operator: { isNot: null },
          OR: [
            { name: { contains: rawQ, mode: 'insensitive' } },
            { email: { contains: rawQ, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          isActive: true,
          operator: { select: { id: true, role: true } },
        },
        take: limit,
        orderBy: { name: 'asc' },
      });

      const qLower = rawQ.toLowerCase();
      const getRank = (u: { name: string; email: string }): number => {
        const nameLower = u.name.toLowerCase();
        const emailLower = u.email.toLowerCase();
        if (emailLower === qLower) return 0;
        if (nameLower.startsWith(qLower) || emailLower.startsWith(qLower)) return 1;
        return 2;
      };

      people.sort((a, b) => {
        const rankDiff = getRank(a) - getRank(b);
        if (rankDiff !== 0) return rankDiff;
        const nameDiff = a.name.localeCompare(b.name);
        if (nameDiff !== 0) return nameDiff;
        return a.email.localeCompare(b.email);
      });

      return people.slice(0, limit).map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        role: p.operator?.role ?? OperatorRole.STANDARD,
        isActive: p.isActive,
      }));
    },
  );

  /**
   * GET /api/users
   */
  fastify.get('/api/users', async () => {
    const operators = await fastify.db.operator.findMany({
      // Explicit Person select — don't pull `passwordHash` or `emailLower`
      // into memory on list queries.
      include: {
        person: { select: { id: true, name: true, email: true, isActive: true, createdAt: true } },
      },
      orderBy: { person: { name: 'asc' } },
    });

    return operators.map((op) => ({
      id: op.person.id,
      email: op.person.email,
      name: op.person.name,
      role: op.role,
      clientId: op.clientId,
      isActive: op.person.isActive,
      lastLoginAt: op.lastLoginAt,
      createdAt: op.person.createdAt,
      slackUserId: op.slackUserId,
    }));
  });

  /**
   * POST /api/users
   */
  fastify.post<{
    Body: { email: string; password: string; name: string; role?: string; slackUserId?: string };
  }>('/api/users', async (request, reply) => {
    const { email: rawEmail, password, name, role, slackUserId } = request.body ?? {};
    if (!rawEmail || !password || !name) {
      return reply.code(400).send({ error: 'Email, password, and name are required' });
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' });
    }

    const resolvedRole = toOperatorRole(role ?? OperatorRole.STANDARD);
    if (!resolvedRole) {
      return reply
        .code(400)
        .send({ error: `Invalid role. Must be one of: ${VALID_ROLE_SLUGS.join(', ')}` });
    }

    const email = rawEmail.trim();
    const emailLower = email.toLowerCase();

    // Only need id + operator presence for the conflict check.
    const existing = await fastify.db.person.findUnique({
      where: { emailLower },
      select: { id: true, operator: { select: { id: true } } },
    });
    if (existing?.operator) {
      return reply.code(409).send({ error: 'A user with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const trimmedSlackUserId = slackUserId?.trim() || null;

    try {
      const person = await fastify.db.$transaction(async (tx) => {
        const person = existing
          ? await tx.person.update({
              where: { id: existing.id },
              // Reactivate the Person on operator promotion — a previously
              // deactivated contact being given control-panel access must be
              // able to log in, and Person.isActive is the master switch.
              data: { passwordHash, name: name.trim(), isActive: true },
            })
          : await tx.person.create({
              data: { name: name.trim(), email, emailLower, passwordHash },
            });

        await tx.operator.create({
          data: {
            personId: person.id,
            role: resolvedRole,
            slackUserId: trimmedSlackUserId,
          },
        });

        return person;
      });

      // Explicit select — response shape only; never return passwordHash/emailLower.
      const created = await fastify.db.person.findUnique({
        where: { id: person.id },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          createdAt: true,
          operator: {
            select: { role: true, clientId: true, lastLoginAt: true, slackUserId: true },
          },
        },
      });

      return reply.code(201).send({
        id: created!.id,
        email: created!.email,
        name: created!.name,
        role: created!.operator?.role,
        clientId: created!.operator?.clientId ?? null,
        isActive: created!.isActive,
        lastLoginAt: created!.operator?.lastLoginAt ?? null,
        createdAt: created!.createdAt,
        slackUserId: created!.operator?.slackUserId ?? null,
      });
    } catch (err) {
      logger.warn({ err, email }, 'Failed to create user');
      throw err;
    }
  });

  /**
   * PATCH /api/users/:id
   */
  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; email?: string; role?: string; isActive?: boolean; slackUserId?: string };
  }>('/api/users/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, email: rawEmail, role, isActive, slackUserId } = request.body ?? {};

    const resolvedRole = role !== undefined ? toOperatorRole(role) : undefined;
    if (role !== undefined && !resolvedRole) {
      return reply
        .code(400)
        .send({ error: `Invalid role. Must be one of: ${VALID_ROLE_SLUGS.join(', ')}` });
    }

    const authUser = request.user as AuthUser;
    if (isActive === false && authUser.personId === id) {
      return reply.code(400).send({ error: 'Cannot deactivate your own account' });
    }
    if (resolvedRole && resolvedRole !== OperatorRole.ADMIN && authUser.personId === id) {
      return reply.code(400).send({ error: 'Cannot demote your own account' });
    }

    // Explicit select — only the fields needed for the guard + mutation are
    // fetched; passwordHash/emailLower are never read here.
    const target = await fastify.db.person.findUnique({
      where: { id },
      select: {
        id: true,
        operator: { select: { id: true } },
      },
    });
    // Guard: /api/users is the control-panel-operator admin surface. A Person
    // without an Operator extension is a portal-only contact and belongs to
    // /api/people instead. Without this check an admin could mutate arbitrary
    // Persons (including portal contacts) by ID.
    if (!target || !target.operator) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const email = rawEmail?.trim();
    const emailLower = email?.toLowerCase();
    if (emailLower) {
      // Only id needed for the conflict check.
      const existing = await fastify.db.person.findUnique({
        where: { emailLower },
        select: { id: true },
      });
      if (existing && existing.id !== id) {
        return reply.code(409).send({ error: 'Email is already in use' });
      }
    }

    const trimmedSlackUserId =
      slackUserId !== undefined ? (slackUserId.trim() || null) : undefined;

    const updated = await fastify.db.$transaction(async (tx) => {
      const person = await tx.person.update({
        where: { id },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email, emailLower: email.toLowerCase() }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      if (target.operator) {
        await tx.operator.update({
          where: { id: target.operator.id },
          data: {
            ...(resolvedRole && { role: resolvedRole }),
            ...(trimmedSlackUserId !== undefined && { slackUserId: trimmedSlackUserId }),
          },
        });
      }

      return person;
    });

    // Explicit select — response shape only; never return passwordHash/emailLower.
    const reloaded = await fastify.db.person.findUnique({
      where: { id: updated.id },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        createdAt: true,
        operator: {
          select: { role: true, clientId: true, lastLoginAt: true, slackUserId: true },
        },
      },
    });

    return {
      id: reloaded!.id,
      email: reloaded!.email,
      name: reloaded!.name,
      role: reloaded!.operator?.role ?? OperatorRole.STANDARD,
      clientId: reloaded!.operator?.clientId ?? null,
      isActive: reloaded!.isActive,
      lastLoginAt: reloaded!.operator?.lastLoginAt ?? null,
      createdAt: reloaded!.createdAt,
      slackUserId: reloaded!.operator?.slackUserId ?? null,
    };
  });

  /**
   * DELETE /api/users/:id
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/users/:id',
    async (request, reply) => {
      const { id } = request.params;
      const authUser = request.user as AuthUser | undefined;
      if (authUser && authUser.personId === id) {
        return reply.code(400).send({ error: 'Cannot deactivate your own account' });
      }

      // Same guard as PATCH: reject Persons without an Operator extension.
      // /api/users is the operator admin surface only.
      // Explicit select — only operator presence is needed for the guard.
      const target = await fastify.db.person.findUnique({
        where: { id },
        select: { id: true, operator: { select: { id: true } } },
      });
      if (!target || !target.operator) return fastify.httpErrors.notFound('User not found');

      await fastify.db.person.update({ where: { id }, data: { isActive: false } });
      return { message: 'User deactivated' };
    },
  );

  /**
   * POST /api/users/:id/reset-password
   */
  fastify.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/users/:id/reset-password',
    async (request, reply) => {
      const { id } = request.params;
      const { password } = request.body ?? {};
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      // Same guard as PATCH/DELETE: only reset passwords for Persons who are
      // control-panel operators. Portal contacts use /api/people.
      // Explicit select — operator presence is the only field needed here.
      const target = await fastify.db.person.findUnique({
        where: { id },
        select: { id: true, operator: { select: { id: true } } },
      });
      if (!target || !target.operator) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await fastify.db.person.update({ where: { id }, data: { passwordHash } });
      return { message: 'Password reset successfully' };
    },
  );
}
