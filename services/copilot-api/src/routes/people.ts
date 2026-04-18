import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveClientScope, getOperatorClientIds } from '../plugins/client-scope.js';

// TODO: #219 Wave 2A — rewrite all of the CRUD routes below against the new
// Person + ClientUser model. The endpoints here used to expose a per-client
// Person with embedded portal/ops access flags; that shape no longer exists.
// For Wave 1 we expose read-only search/list endpoints (joined via
// ClientUser) so the command palette and ticket-requester dropdown keep
// working, and respond 501 for create/update/delete. Wave 2A delivers the
// full CRUD against the unified model.

async function assertClientInScope(
  fastify: FastifyInstance,
  request: FastifyRequest,
  clientId: string,
): Promise<boolean> {
  const scope = await resolveClientScope(request, (operatorId) =>
    getOperatorClientIds(fastify.db, operatorId),
  );
  if (scope.type === 'all') return true;
  if (scope.type === 'assigned') return scope.clientIds.includes(clientId);
  return scope.clientId === clientId;
}

export async function peopleRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/search/people
   * Lightweight search for the command palette — Wave 1 shim. Returns
   * ClientUser rows joined to Person + Client.
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

      const scope = await resolveClientScope(request, (operatorId) =>
        getOperatorClientIds(fastify.db, operatorId),
      );

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
   * Wave 1 shim: lists ClientUser rows joined to Person.
   */
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/people',
    async (request, reply) => {
      const { clientId } = request.query;
      const scope = await resolveClientScope(request, (operatorId) =>
        getOperatorClientIds(fastify.db, operatorId),
      );

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
          person: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isActive: true,
              // Select the hash to derive `hasPortalAccess` from presence;
              // never return the value itself to the API consumer.
              passwordHash: true,
            },
          },
          client: { select: { name: true, shortCode: true } },
        },
        orderBy: { person: { name: 'asc' } },
      });

      return rows.map((cu) => ({
        id: cu.person.id,
        clientId: cu.clientId,
        name: cu.person.name,
        email: cu.person.email,
        phone: cu.person.phone,
        role: null,
        slackUserId: null,
        isPrimary: cu.isPrimary,
        // A ClientUser row without a Person.passwordHash is "invited but not
        // credentialed" — can't actually log into the portal yet. Derive the
        // flag from presence so the UI doesn't lie.
        hasPortalAccess: cu.person.passwordHash !== null,
        hasOpsAccess: false,
        userType: cu.userType,
        isActive: cu.person.isActive,
        lastLoginAt: cu.lastLoginAt,
        createdAt: cu.createdAt,
        updatedAt: cu.updatedAt,
        client: cu.client,
      }));
    },
  );

  /**
   * GET /api/people/:id
   * Wave 1 shim. Returns the first ClientUser row for the person.
   */
  fastify.get<{ Params: { id: string } }>('/api/people/:id', async (request, reply) => {
    // Deterministic order: primary first, then oldest. Without this a Person
    // linked to multiple clients could return a nondeterministic ClientUser
    // row and trip the scope check below (or surface the wrong client).
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
        // Explicit Person projection — don't expose passwordHash or emailLower
        // to API consumers; use passwordHash only to derive hasPortalAccess.
        person: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            isActive: true,
            passwordHash: true,
          },
        },
        client: { select: { name: true, shortCode: true } },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (!cu) return fastify.httpErrors.notFound('Person not found');
    if (!(await assertClientInScope(fastify, request, cu.clientId))) {
      return reply.code(403).send({ error: 'Forbidden: client not in scope' });
    }
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
      hasOpsAccess: false,
      userType: cu.userType,
      isActive: cu.person.isActive,
      lastLoginAt: cu.lastLoginAt,
      createdAt: cu.createdAt,
      updatedAt: cu.updatedAt,
      client: cu.client,
    };
  });

  const notImplemented = (_req: FastifyRequest, reply: { code(c: number): { send(o: unknown): unknown } }) =>
    reply.code(501).send({ error: 'People CRUD is under migration in #219 Wave 2A', todo: '#219 Wave 2A' });

  fastify.post('/api/people', notImplemented);
  fastify.patch('/api/people/:id', notImplemented);
  fastify.delete('/api/people/:id', notImplemented);
  fastify.post('/api/people/:id/reset-password', notImplemented);
}
