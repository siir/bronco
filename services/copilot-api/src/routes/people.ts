import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { ClientUserType } from '@bronco/shared-types';
import { resolveClientScope } from '../plugins/client-scope.js';

/** Explicit Person projection — never expose passwordHash/emailLower to API consumers. */
const PERSON_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isActive: true,
  passwordHash: true,
} as const;

const CLIENT_SELECT = { name: true, shortCode: true } as const;

/** Map a ClientUser+Person row to the wire shape the frontend expects. */
function formatPerson(cu: {
  id: string;
  clientId: string;
  userType: ClientUserType;
  isPrimary: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  person: { id: string; name: string; email: string; phone: string | null; isActive: boolean; passwordHash: string | null };
  client: { name: string; shortCode: string };
}) {
  return {
    id: cu.person.id,
    clientId: cu.clientId,
    name: cu.person.name,
    email: cu.person.email,
    phone: cu.person.phone,
    role: null,
    slackUserId: null,
    isPrimary: cu.isPrimary,
    hasPortalAccess: cu.person.passwordHash !== null,
    hasOpsAccess: false, // Wave 1 BC shim — Wave 2C removes this field
    userType: cu.userType,
    isActive: cu.person.isActive,
    lastLoginAt: cu.lastLoginAt,
    createdAt: cu.createdAt,
    updatedAt: cu.updatedAt,
    client: cu.client,
  };
}

async function assertClientInScope(
  request: FastifyRequest,
  clientId: string,
): Promise<boolean> {
  const scope = await resolveClientScope(request);
  if (scope.type === 'all') return true;
  if (scope.type === 'assigned') return scope.clientIds.includes(clientId);
  return scope.clientId === clientId;
}

export async function peopleRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/search/people
   * Lightweight search for the command palette.
   */
  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search/people',
    async (request) => {
      const rawQ = (request.query.q ?? '').trim();
      if (!rawQ) return fastify.httpErrors.badRequest('q is required');
      if (rawQ.length < 2) return fastify.httpErrors.badRequest('q must be at least 2 characters');

      const rawLimit = request.query.limit ?? '20';
      const limit = Math.trunc(Number(rawLimit));
      if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
        return fastify.httpErrors.badRequest('limit must be between 1 and 50');
      }

      const scope = await resolveClientScope(request);

      let clientIdFilter: string | { in: string[] } | undefined;
      if (scope.type === 'assigned') {
        if (scope.clientIds.length === 0) return [];
        clientIdFilter = { in: scope.clientIds };
      } else if (scope.type === 'single') {
        clientIdFilter = scope.clientId;
      }

      const results = await fastify.db.clientUser.findMany({
        where: {
          ...(clientIdFilter !== undefined && { clientId: clientIdFilter }),
          person: {
            OR: [
              { name: { contains: rawQ, mode: 'insensitive' } },
              { email: { contains: rawQ, mode: 'insensitive' } },
            ],
          },
        },
        select: {
          id: true,
          clientId: true,
          userType: true,
          isPrimary: true,
          person: { select: { id: true, name: true, email: true, isActive: true } },
          client: { select: { name: true, shortCode: true } },
        },
        take: limit,
        orderBy: { person: { name: 'asc' } },
      });

      const qLower = rawQ.toLowerCase();
      results.sort((a, b) => {
        const aEmail = a.person.email.toLowerCase() === qLower ? 0 : 1;
        const bEmail = b.person.email.toLowerCase() === qLower ? 0 : 1;
        if (aEmail !== bEmail) return aEmail - bEmail;
        const aStarts = a.person.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        const bStarts = b.person.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.person.name.localeCompare(b.person.name);
      });

      return results.slice(0, limit).map((r) => ({
        id: r.person.id,
        name: r.person.name,
        email: r.person.email,
        clientId: r.clientId,
        clientName: r.client.name,
        clientShortCode: r.client.shortCode,
        role: null,
        isActive: r.person.isActive,
      }));
    },
  );

  /**
   * GET /api/people?clientId=X
   * Lists ClientUser rows joined to Person, optionally filtered by client.
   */
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/people',
    async (request, reply) => {
      const { clientId } = request.query;
      const scope = await resolveClientScope(request);

      let clientIdFilter: string | { in: string[] } | undefined;
      if (scope.type === 'assigned') {
        if (scope.clientIds.length === 0) return [];
        if (clientId) {
          if (!scope.clientIds.includes(clientId)) {
            return reply.code(403).send({ error: 'Forbidden: client not in scope' });
          }
          clientIdFilter = clientId;
        } else {
          clientIdFilter = { in: scope.clientIds };
        }
      } else if (scope.type === 'single') {
        if (clientId && clientId !== scope.clientId) {
          return reply.code(403).send({ error: 'Forbidden: client not in scope' });
        }
        clientIdFilter = scope.clientId;
      } else if (clientId) {
        clientIdFilter = clientId;
      }

      const rows = await fastify.db.clientUser.findMany({
        where: {
          ...(clientIdFilter !== undefined && { clientId: clientIdFilter }),
        },
        select: {
          id: true,
          clientId: true,
          userType: true,
          isPrimary: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          person: { select: PERSON_SELECT },
          client: { select: CLIENT_SELECT },
        },
        orderBy: { person: { name: 'asc' } },
      });

      return rows.map(formatPerson);
    },
  );

  /**
   * GET /api/people/:id
   */
  fastify.get<{ Params: { id: string } }>('/api/people/:id', async (request, reply) => {
    const cu = await fastify.db.clientUser.findFirst({
      where: { personId: request.params.id },
      select: {
        id: true,
        clientId: true,
        userType: true,
        isPrimary: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        person: { select: PERSON_SELECT },
        client: { select: CLIENT_SELECT },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (!cu) return fastify.httpErrors.notFound('Person not found');
    if (!(await assertClientInScope(request, cu.clientId))) {
      return reply.code(403).send({ error: 'Forbidden: client not in scope' });
    }
    return formatPerson(cu);
  });

  /**
   * POST /api/people
   * Create a contact (Person + ClientUser). Optionally set a portal password.
   */
  fastify.post<{
    Body: {
      clientId: string;
      name: string;
      email: string;
      phone?: string | null;
      password?: string;
      hasPortalAccess?: boolean;
      isPrimary?: boolean;
      userType?: string;
      isActive?: boolean;
    };
  }>('/api/people', async (request, reply) => {
    const {
      clientId,
      name,
      email: rawEmail,
      phone,
      password,
      hasPortalAccess,
      isPrimary,
      userType,
      isActive,
    } = request.body ?? {};

    if (!clientId || !name || !rawEmail) {
      return reply.code(400).send({ error: 'clientId, name, and email are required' });
    }

    if (!(await assertClientInScope(request, clientId))) {
      return reply.code(403).send({ error: 'Forbidden: client not in scope' });
    }

    if (password !== undefined && password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' });
    }

    const resolvedUserType = userType === ClientUserType.ADMIN ? ClientUserType.ADMIN : ClientUserType.USER;

    const email = rawEmail.trim();
    const emailLower = email.toLowerCase();

    const existingPerson = await fastify.db.person.findUnique({
      where: { emailLower },
      include: { clientUsers: { select: { clientId: true } } },
    });

    if (existingPerson) {
      const alreadyLinked = existingPerson.clientUsers.some((c) => c.clientId === clientId);
      if (alreadyLinked) {
        return reply.code(409).send({ error: 'A person with this email is already linked to this client' });
      }
    }

    const shouldSetPassword = (hasPortalAccess === true || !!password) && !!password;
    const passwordHash = shouldSetPassword ? await bcrypt.hash(password!, 10) : undefined;

    const result = await fastify.db.$transaction(async (tx) => {
      const person = existingPerson
        ? await tx.person.update({
            where: { id: existingPerson.id },
            data: {
              name: name.trim(),
              ...(isActive !== undefined && { isActive }),
              ...(passwordHash !== undefined && { passwordHash }),
            },
          })
        : await tx.person.create({
            data: {
              name: name.trim(),
              email,
              emailLower,
              phone: phone ?? null,
              ...(isActive !== undefined && { isActive }),
              ...(passwordHash !== undefined && { passwordHash }),
            },
          });

      const cu = await tx.clientUser.create({
        data: {
          personId: person.id,
          clientId,
          userType: resolvedUserType,
          isPrimary: isPrimary ?? false,
        },
        select: {
          id: true,
          clientId: true,
          userType: true,
          isPrimary: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          person: { select: PERSON_SELECT },
          client: { select: CLIENT_SELECT },
        },
      });

      return cu;
    });

    return reply.code(201).send(formatPerson(result));
  });

  /**
   * PATCH /api/people/:id
   * Update a person's details (Person fields + ClientUser fields).
   * `id` is the Person.id.
   */
  fastify.patch<{
    Params: { id: string };
    Body: {
      clientId?: string;
      name?: string;
      email?: string;
      phone?: string | null;
      password?: string;
      hasPortalAccess?: boolean;
      isPrimary?: boolean;
      userType?: string;
      isActive?: boolean;
    };
  }>('/api/people/:id', async (request, reply) => {
    const { id } = request.params;
    const {
      clientId: bodyClientId,
      name,
      email: rawEmail,
      phone,
      password,
      isPrimary,
      userType,
      isActive,
    } = request.body ?? {};

    if (password !== undefined && password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' });
    }

    // Find the ClientUser for this person — prefer the one from bodyClientId, else the primary
    const cuWhere = bodyClientId
      ? { personId: id, clientId: bodyClientId }
      : undefined;

    const cu = cuWhere
      ? await fastify.db.clientUser.findFirst({
          where: cuWhere,
          select: {
            id: true,
            clientId: true,
            userType: true,
            isPrimary: true,
            lastLoginAt: true,
            createdAt: true,
            updatedAt: true,
            person: { select: PERSON_SELECT },
            client: { select: CLIENT_SELECT },
          },
        })
      : await fastify.db.clientUser.findFirst({
          where: { personId: id },
          select: {
            id: true,
            clientId: true,
            userType: true,
            isPrimary: true,
            lastLoginAt: true,
            createdAt: true,
            updatedAt: true,
            person: { select: PERSON_SELECT },
            client: { select: CLIENT_SELECT },
          },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        });

    if (!cu) return reply.code(404).send({ error: 'Person not found' });

    if (!(await assertClientInScope(request, cu.clientId))) {
      return reply.code(403).send({ error: 'Forbidden: client not in scope' });
    }

    const email = rawEmail?.trim();
    const emailLower = email?.toLowerCase();
    if (emailLower) {
      const existing = await fastify.db.person.findUnique({ where: { emailLower } });
      if (existing && existing.id !== id) {
        return reply.code(409).send({ error: 'Email is already in use by another person' });
      }
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

    const resolvedUserType =
      userType === ClientUserType.ADMIN
        ? ClientUserType.ADMIN
        : userType === ClientUserType.USER
          ? ClientUserType.USER
          : undefined;

    const updated = await fastify.db.$transaction(async (tx) => {
      await tx.person.update({
        where: { id },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email, emailLower: email.toLowerCase() }),
          ...(phone !== undefined && { phone }),
          ...(isActive !== undefined && { isActive }),
          ...(passwordHash !== undefined && { passwordHash }),
        },
      });

      return tx.clientUser.update({
        where: { id: cu.id },
        data: {
          ...(resolvedUserType !== undefined && { userType: resolvedUserType }),
          ...(isPrimary !== undefined && { isPrimary }),
        },
        select: {
          id: true,
          clientId: true,
          userType: true,
          isPrimary: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          person: { select: PERSON_SELECT },
          client: { select: CLIENT_SELECT },
        },
      });
    });

    return formatPerson(updated);
  });

  /**
   * DELETE /api/people/:id
   * Revoke a person's access to a client (removes the ClientUser record).
   * `id` is the Person.id. Optional `?clientId=X` scopes which link to remove.
   */
  fastify.delete<{ Params: { id: string }; Querystring: { clientId?: string } }>(
    '/api/people/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { clientId: queryClientId } = request.query;

      // Resolve the ClientUser to remove
      const cu = queryClientId
        ? await fastify.db.clientUser.findFirst({
            where: { personId: id, clientId: queryClientId },
          })
        : await fastify.db.clientUser.findFirst({
            where: { personId: id },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          });

      if (!cu) return reply.code(404).send({ error: 'Person not found' });

      if (!(await assertClientInScope(request, cu.clientId))) {
        return reply.code(403).send({ error: 'Forbidden: client not in scope' });
      }

      await fastify.db.$transaction(async (tx) => {
        await tx.clientUser.delete({ where: { id: cu.id } });

        // Revoke active portal tokens for this client scope
        await tx.personRefreshToken.updateMany({
          where: { personId: id, accessType: 'CLIENT_USER', revokedAt: null },
          data: { revokedAt: new Date() },
        });

        // If Person has no remaining ClientUser AND no Operator, null the passwordHash
        // so they cannot log in even if re-added later with stale credentials.
        const remaining = await tx.person.findUnique({
          where: { id },
          include: {
            operator: { select: { id: true } },
            _count: { select: { clientUsers: true } },
          },
        });
        if (remaining && !remaining.operator && remaining._count.clientUsers === 0) {
          await tx.person.update({ where: { id }, data: { passwordHash: null } });
        }
      });

      return { message: 'Person removed from client' };
    },
  );

  /**
   * POST /api/people/:id/reset-password
   * Reset a portal user's password. `id` is the Person.id.
   */
  fastify.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/people/:id/reset-password',
    async (request, reply) => {
      const { id } = request.params;
      const { password } = request.body ?? {};
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      // Scope check: the person must have a ClientUser in the caller's scope
      const cu = await fastify.db.clientUser.findFirst({
        where: { personId: id },
        select: { clientId: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      });
      if (!cu) return reply.code(404).send({ error: 'Person not found' });

      if (!(await assertClientInScope(request, cu.clientId))) {
        return reply.code(403).send({ error: 'Forbidden: client not in scope' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await fastify.db.person.update({ where: { id }, data: { passwordHash } });
      return { message: 'Password reset successfully' };
    },
  );
}
