import type { FastifyInstance } from 'fastify';
import { AiMode } from '@bronco/shared-types';

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
  fastify.get('/api/clients', async () => {
    return fastify.db.client.findMany({
      where: { isInternal: false },
      include: { _count: { select: { tickets: true, systems: true } } },
      orderBy: { name: 'asc' },
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/clients/:id', async (request) => {
    const client = await fastify.db.client.findUnique({
      where: { id: request.params.id },
      include: {
        contacts: true,
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

  fastify.patch<{ Params: { id: string }; Body: { name?: string; notes?: string; isActive?: boolean; autoRouteTickets?: boolean; allowSelfRegistration?: boolean; domainMappings?: string[]; companyProfile?: string | null; systemsProfile?: string | null; aiMode?: string; billingPeriod?: string; billingAnchorDay?: number; billingMarkupPercent?: number; slackChannelId?: string | null } }>(
    '/api/clients/:id',
    async (request, reply) => {
      const { aiMode, billingPeriod, billingAnchorDay, billingMarkupPercent, ...rest } = request.body;
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
        },
      });
    },
  );
}
