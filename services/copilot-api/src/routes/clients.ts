import type { FastifyInstance } from 'fastify';
import { AiMode } from '@bronco/shared-types';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

const VALID_AI_MODES = new Set<string>(Object.values(AiMode));

// Basic domain format validation: alphanumeric labels separated by dots, no protocol prefix
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function validateDomainMappings(domains: string[] | undefined): string[] | undefined {
  if (!domains) return undefined;
  const cleaned = domains.map(d => d.trim().toLowerCase()).filter(Boolean);
  const invalid = cleaned.filter(d => !DOMAIN_RE.test(d));
  if (invalid.length > 0) {
    throw Object.assign(new Error(`Invalid domain format: ${invalid.join(', ')}`), { statusCode: 400 });
  }
  return cleaned;
}

export async function clientRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/search/clients — lightweight search for the command palette
  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search/clients',
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
      if (scope.type === 'assigned' && scope.clientIds.length === 0) return [];

      // Translate clientId scope to id filter (clients are queried by their own id).
      const scopeWhere = scopeToWhere(scope);
      const idFilter = scopeWhere.clientId !== undefined ? { id: scopeWhere.clientId } : {};

      const results = await fastify.db.client.findMany({
        where: {
          isInternal: false,
          ...idFilter,
          OR: [
            { name: { contains: rawQ, mode: 'insensitive' } },
            { shortCode: { contains: rawQ, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          name: true,
          shortCode: true,
          isActive: true,
        },
        take: limit * 2,
        orderBy: { name: 'asc' },
      });

      const qLower = rawQ.toLowerCase();
      const getRank = (name: string, shortCode: string): number => {
        const nameLower = name.toLowerCase();
        const shortCodeLower = shortCode.toLowerCase();
        if (shortCodeLower === qLower) return 0;
        if (shortCodeLower.startsWith(qLower)) return 1;
        if (nameLower === qLower) return 2;
        if (nameLower.startsWith(qLower)) return 3;
        return 4;
      };
      results.sort((a, b) => {
        const rankDiff = getRank(a.name, a.shortCode) - getRank(b.name, b.shortCode);
        if (rankDiff !== 0) return rankDiff;
        return a.name.localeCompare(b.name);
      });

      return results.slice(0, limit);
    },
  );

  fastify.get('/api/clients', async (request) => {
    const scope = await resolveClientScope(request);

    // Apply scope filter — translate clientId to client.id for direct client queries
    const scopeWhere = scopeToWhere(scope);
    const idFilter = scopeWhere.clientId !== undefined ? { id: scopeWhere.clientId } : {};

    return fastify.db.client.findMany({
      where: { isInternal: false, ...idFilter },
      include: { _count: { select: { tickets: true, systems: true } } },
      orderBy: { name: 'asc' },
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/clients/:id', async (request) => {
    const client = await fastify.db.client.findUnique({
      where: { id: request.params.id },
      include: {
        // Explicit projection — never spread Person directly. `passwordHash`
        // and `emailLower` on Person are sensitive and must not leak to API
        // consumers. Wave 2C will migrate the frontend to a proper ClientUser
        // DTO; until then this stays on the safe-field allowlist.
        clientUsers: {
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
              },
            },
          },
        },
        systems: true,
        _count: {
          select: {
            tickets: true,
            systems: true,
            codeRepos: true,
            integrations: true,
            clientMemories: true,
            environments: true,
            clientUsers: true,
            invoices: true,
          },
        },
      },
    });
    if (!client) return fastify.httpErrors.notFound('Client not found');

    // Sum invoiced amount
    const invoiceAgg = await fastify.db.invoice.aggregate({
      where: { clientId: request.params.id },
      _sum: { totalBilledCostUsd: true },
    });

    return {
      ...client,
      invoicedTotalUsd: invoiceAgg._sum.totalBilledCostUsd ?? 0,
    };
  });

  fastify.post<{ Body: { name: string; shortCode: string; notes?: string; domainMappings?: string[] } }>(
    '/api/clients',
    async (request, reply) => {
      const domainMappings = validateDomainMappings(request.body.domainMappings);
      const client = await fastify.db.client.create({
        data: { ...request.body, domainMappings },
      });
      reply.code(201);
      return client;
    },
  );

  fastify.patch<{ Params: { id: string }; Body: { name?: string; notes?: string; isActive?: boolean; autoRouteTickets?: boolean; allowSelfRegistration?: boolean; domainMappings?: string[]; companyProfile?: string | null; systemsProfile?: string | null; aiMode?: string; billingPeriod?: string; billingAnchorDay?: number; billingMarkupPercent?: number; slackChannelId?: string | null; notificationMode?: string } }>(
    '/api/clients/:id',
    async (request, reply) => {
      const { aiMode, billingPeriod, billingAnchorDay, billingMarkupPercent, notificationMode, ...rest } = request.body;
      if (aiMode !== undefined && !VALID_AI_MODES.has(aiMode)) {
        return reply.code(400).send({ error: `Invalid aiMode "${aiMode}". Valid: ${[...VALID_AI_MODES].join(', ')}` });
      }
      const VALID_BILLING_PERIODS = new Set(['disabled', 'weekly', 'biweekly', 'monthly']);
      if (billingPeriod !== undefined && !VALID_BILLING_PERIODS.has(billingPeriod)) {
        return reply.code(400).send({ error: 'Invalid billingPeriod' });
      }
      if (billingAnchorDay !== undefined && (billingAnchorDay < 1 || billingAnchorDay > 28)) {
        return reply.code(400).send({ error: 'billingAnchorDay must be 1\u201328' });
      }
      if (billingMarkupPercent !== undefined) {
        if (!Number.isFinite(billingMarkupPercent) || billingMarkupPercent < 1.0 || billingMarkupPercent > 10.0) {
          throw Object.assign(new Error('billingMarkupPercent must be a finite number between 1.0 and 10.0'), { statusCode: 400 });
        }
      }
      if (notificationMode !== undefined) {
        if (notificationMode !== 'client' && notificationMode !== 'operator') {
          return reply.code(400).send({ error: "notificationMode must be 'client' or 'operator'" });
        }
        // Only platform admins/operators may flip notification mode. Portal ops users are read-only on this field.
        if (!request.user) {
          return reply.code(403).send({ error: 'Only platform operators may change notificationMode' });
        }
      }
      const domainMappings = validateDomainMappings(rest.domainMappings);
      return fastify.db.client.update({
        where: { id: request.params.id },
        data: {
          ...rest,
          ...(domainMappings !== undefined && { domainMappings }),
          ...(aiMode !== undefined && { aiMode }),
          ...(billingPeriod !== undefined && { billingPeriod }),
          ...(billingAnchorDay !== undefined && { billingAnchorDay }),
          ...(billingMarkupPercent !== undefined && { billingMarkupPercent }),
          ...(notificationMode !== undefined && { notificationMode }),
        },
      });
    },
  );
}
