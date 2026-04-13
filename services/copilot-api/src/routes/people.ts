import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { resolveClientScope, getOperatorClientIds } from '../plugins/client-scope.js';

const emailSchema = z.string().email('Invalid email format');

const ALLOWED_USER_TYPES = new Set(['ADMIN', 'OPERATOR', 'USER']);
const OPS_USER_TYPES = new Set(['ADMIN', 'OPERATOR']);

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

/**
 * Determine whether the caller is allowed to access people for the given client.
 * Resolves the caller's client scope and checks whether `clientId` is within it.
 * Returns `{ allowed: true }` when access is permitted, `{ allowed: false }` otherwise.
 */
async function checkClientAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  clientId: string | undefined,
): Promise<{ allowed: boolean }> {
  const scope = await resolveClientScope(request, (operatorId) =>
    getOperatorClientIds(fastify.db, operatorId),
  );
  if (scope.type === 'all') return { allowed: true };
  if (scope.type === 'assigned') {
    if (!clientId) return { allowed: false };
    return { allowed: scope.clientIds.includes(clientId) };
  }
  // single
  if (!clientId) return { allowed: false };
  return { allowed: clientId === scope.clientId };
}

/**
 * Check whether the caller is allowed to mutate people for the given client.
 * Client OPERATOR people are read-only — only ADMIN people (and Operators) can manage.
 */
function canManagePeople(request: FastifyRequest): boolean {
  if (request.user) return true; // Any operator (platform admin or scoped) can manage
  if (request.portalUser) {
    return request.portalUser.hasOpsAccess && request.portalUser.userType === 'ADMIN';
  }
  return false;
}

export async function peopleRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/people?clientId=X
   * List people for a client, ordered by name.
   */
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/people',
    async (request, reply) => {
      const { clientId } = request.query;

      // Resolve scope and apply filtering
      const scope = await resolveClientScope(request, (operatorId) =>
        getOperatorClientIds(fastify.db, operatorId),
      );
      let scopedClientIdFilter: string | { in: string[] } | undefined;
      if (scope.type === 'assigned') {
        if (scope.clientIds.length === 0) return [];
        if (clientId) {
          if (!scope.clientIds.includes(clientId)) {
            return reply.code(403).send({ error: 'Forbidden: client not in scope' });
          }
          scopedClientIdFilter = clientId;
        } else {
          scopedClientIdFilter = { in: scope.clientIds };
        }
      } else if (scope.type === 'single') {
        if (clientId && clientId !== scope.clientId) {
          return reply.code(403).send({ error: 'Forbidden: client not in scope' });
        }
        scopedClientIdFilter = scope.clientId;
      } else if (clientId) {
        scopedClientIdFilter = clientId;
      }

      return fastify.db.person.findMany({
        where: {
          ...(scopedClientIdFilter !== undefined && { clientId: scopedClientIdFilter }),
        },
        select: {
          id: true,
          clientId: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          slackUserId: true,
          isPrimary: true,
          hasPortalAccess: true,
          hasOpsAccess: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          client: { select: { name: true, shortCode: true } },
        },
        orderBy: { name: 'asc' },
      });
    },
  );

  /**
   * GET /api/people/:id
   */
  fastify.get<{ Params: { id: string } }>('/api/people/:id', async (request, reply) => {
    const person = await fastify.db.person.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        clientId: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        slackUserId: true,
        isPrimary: true,
        hasPortalAccess: true,
        hasOpsAccess: true,
        userType: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        client: { select: { name: true, shortCode: true } },
      },
    });
    if (!person) return fastify.httpErrors.notFound('Person not found');
    const access = await checkClientAccess(fastify, request, person.clientId);
    if (!access.allowed) {
      return reply.code(403).send({ error: 'Forbidden: client not in scope' });
    }
    return person;
  });

  /**
   * POST /api/people
   * Create a person — either a contact-only or a portal user.
   */
  fastify.post<{
    Body: {
      clientId: string;
      name: string;
      email: string;
      phone?: string;
      role?: string;
      slackUserId?: string;
      isPrimary?: boolean;
      hasPortalAccess?: boolean;
      hasOpsAccess?: boolean;
      password?: string;
      userType?: string;
    };
  }>('/api/people', async (request, reply) => {
    const { clientId, name, email: rawEmail, phone, role, slackUserId, isPrimary, hasPortalAccess, hasOpsAccess, password, userType } = request.body;

    if (!clientId || !name || !rawEmail) {
      return reply.code(400).send({ error: 'clientId, name, and email are required' });
    }

    if (!canManagePeople(request)) {
      return reply.code(403).send({ error: 'Forbidden: insufficient role to manage people' });
    }

    const access = await checkClientAccess(fastify, request, clientId);
    if (!access.allowed) {
      return reply.code(403).send({ error: 'Forbidden: client not in scope' });
    }

    const parsed = emailSchema.safeParse(rawEmail);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(parsed.error.issues[0].message);
    }
    const email = rawEmail.trim().toLowerCase();

    if (userType && !ALLOWED_USER_TYPES.has(userType)) {
      return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN, OPERATOR, or USER' });
    }

    if (hasPortalAccess) {
      if (!password) {
        return reply.code(400).send({ error: 'password is required when hasPortalAccess is true' });
      }
      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }
    }

    // Ops access requires portal access (so the person can log in) and an
    // ADMIN or OPERATOR userType.
    if (hasOpsAccess) {
      if (!hasPortalAccess) {
        return reply.code(400).send({ error: 'hasOpsAccess requires hasPortalAccess to be true' });
      }
      if (!password) {
        return reply.code(400).send({ error: 'password is required when hasOpsAccess is true' });
      }
      if (!userType || !OPS_USER_TYPES.has(userType)) {
        return reply.code(400).send({ error: 'hasOpsAccess requires userType to be ADMIN or OPERATOR' });
      }
    }

    // Verify client exists
    const client = await fastify.db.client.findUnique({ where: { id: clientId } });
    if (!client) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    const passwordHash = hasPortalAccess && password ? await bcrypt.hash(password, 10) : null;
    const resolvedUserType =
      hasPortalAccess || hasOpsAccess
        ? ((userType ?? (hasOpsAccess ? 'OPERATOR' : 'USER')) as 'ADMIN' | 'OPERATOR' | 'USER')
        : undefined;

    try {
      const person = await fastify.db.person.create({
        data: {
          clientId,
          name: name.trim(),
          email,
          phone: phone ?? null,
          role: role ?? null,
          slackUserId: slackUserId ?? null,
          isPrimary: isPrimary ?? false,
          hasPortalAccess: hasPortalAccess ?? false,
          hasOpsAccess: hasOpsAccess ?? false,
          ...(passwordHash ? { passwordHash } : {}),
          ...(resolvedUserType !== undefined ? { userType: resolvedUserType } : {}),
        },
        select: {
          id: true,
          clientId: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          slackUserId: true,
          isPrimary: true,
          hasPortalAccess: true,
          hasOpsAccess: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      reply.code(201);
      return person;
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return reply.code(409).send({ error: 'A person with this email already exists for this client' });
      }
      throw err;
    }
  });

  /**
   * PATCH /api/people/:id
   */
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      email?: string;
      phone?: string | null;
      role?: string | null;
      slackUserId?: string | null;
      isPrimary?: boolean;
      hasPortalAccess?: boolean;
      hasOpsAccess?: boolean;
      password?: string;
      userType?: string;
      isActive?: boolean;
    };
  }>('/api/people/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, email: rawEmail, phone, role, slackUserId, isPrimary, hasPortalAccess, hasOpsAccess, password, userType, isActive } = request.body;

    if (!canManagePeople(request)) {
      return reply.code(403).send({ error: 'Forbidden: insufficient role to manage people' });
    }

    if (userType && !ALLOWED_USER_TYPES.has(userType)) {
      return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN, OPERATOR, or USER' });
    }

    const target = await fastify.db.person.findUnique({ where: { id } });
    if (!target) {
      return reply.code(404).send({ error: 'Person not found' });
    }

    const access = await checkClientAccess(fastify, request, target.clientId);
    if (!access.allowed) {
      return reply.code(403).send({ error: 'Forbidden: client not in scope' });
    }

    // Enabling portal access requires a password to be set — otherwise the person cannot log in.
    // To set/change a password on an existing portal user, use POST /api/people/:id/reset-password.
    if (hasPortalAccess === true && !target.hasPortalAccess) {
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'password (minimum 8 characters) is required when enabling portal access' });
      }
    }

    // Enabling ops access requires portal access (so the person can log in) and
    // an ADMIN or OPERATOR userType.
    if (hasOpsAccess === true) {
      const effectiveHasPortal = hasPortalAccess ?? target.hasPortalAccess;
      if (!effectiveHasPortal) {
        return reply.code(400).send({ error: 'hasOpsAccess requires hasPortalAccess to be true' });
      }
      if (!target.passwordHash && !password) {
        return reply.code(400).send({ error: 'hasOpsAccess requires the person to have a password — set one via password field or POST /api/people/:id/reset-password' });
      }
      const effectiveUserType = userType ?? target.userType ?? null;
      if (!effectiveUserType || !OPS_USER_TYPES.has(effectiveUserType)) {
        return reply.code(400).send({ error: 'hasOpsAccess requires userType to be ADMIN or OPERATOR' });
      }
    }

    const email = rawEmail?.trim().toLowerCase();
    if (email !== undefined) {
      const parsed = emailSchema.safeParse(email);
      if (!parsed.success) {
        return fastify.httpErrors.badRequest(parsed.error.issues[0].message);
      }
      const existing = await fastify.db.person.findFirst({ where: { clientId: target.clientId, email } });
      if (existing && existing.id !== id) {
        return reply.code(409).send({ error: 'Email is already in use for this client' });
      }
    }

    const newPasswordHash =
      hasPortalAccess === true && !target.hasPortalAccess && password
        ? await bcrypt.hash(password, 10)
        : undefined;

    try {
      return await fastify.db.person.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(email !== undefined && { email }),
          ...(phone !== undefined && { phone }),
          ...(role !== undefined && { role }),
          ...(slackUserId !== undefined && { slackUserId }),
          ...(isPrimary !== undefined && { isPrimary }),
          ...(hasPortalAccess !== undefined && { hasPortalAccess }),
          ...(hasOpsAccess !== undefined && { hasOpsAccess }),
          ...(newPasswordHash && { passwordHash: newPasswordHash }),
          ...(userType !== undefined && { userType: userType as 'ADMIN' | 'OPERATOR' | 'USER' }),
          ...(isActive !== undefined && { isActive }),
        },
        select: {
          id: true,
          clientId: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          slackUserId: true,
          isPrimary: true,
          hasPortalAccess: true,
          hasOpsAccess: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Person not found');
      }
      throw err;
    }
  });

  /**
   * DELETE /api/people/:id
   * Deactivate portal users; hard-delete contact-only people.
   */
  fastify.delete<{ Params: { id: string } }>('/api/people/:id', async (request, reply) => {
    if (!canManagePeople(request)) {
      return reply.code(403).send({ error: 'Forbidden: insufficient role to manage people' });
    }
    const target = await fastify.db.person.findUnique({ where: { id: request.params.id } });
    if (!target) {
      return reply.code(404).send({ error: 'Person not found' });
    }
    const access = await checkClientAccess(fastify, request, target.clientId);
    if (!access.allowed) {
      return reply.code(403).send({ error: 'Forbidden: client not in scope' });
    }

    // Soft delete: portal users get deactivated so they retain historical ticket links
    if (target.hasPortalAccess) {
      await fastify.db.person.update({
        where: { id: request.params.id },
        data: { isActive: false },
      });
      return { message: 'Person deactivated' };
    }

    // Hard delete: contact-only people
    try {
      await fastify.db.person.delete({
        where: { id: request.params.id },
      });
      reply.code(204);
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Person not found');
      }
      // P2003: foreign key constraint violation — person is referenced by ticket followers
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.conflict('Cannot delete person — they are a follower on one or more tickets. Remove them from tickets first.');
      }
      throw err;
    }
  });

  /**
   * POST /api/people/:id/reset-password
   * Reset a portal user's password.
   */
  fastify.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/people/:id/reset-password',
    async (request, reply) => {
      const { id } = request.params;
      const { password } = request.body;

      if (!canManagePeople(request)) {
        return reply.code(403).send({ error: 'Forbidden: insufficient role to manage people' });
      }
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      const target = await fastify.db.person.findUnique({ where: { id } });
      if (!target) {
        return reply.code(404).send({ error: 'Person not found' });
      }
      const access = await checkClientAccess(fastify, request, target.clientId);
      if (!access.allowed) {
        return reply.code(403).send({ error: 'Forbidden: client not in scope' });
      }
      if (!target.hasPortalAccess) {
        return reply.code(400).send({ error: 'Person does not have portal access' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await fastify.db.person.update({
        where: { id },
        data: { passwordHash },
      });

      return { message: 'Password reset successfully' };
    },
  );
}
