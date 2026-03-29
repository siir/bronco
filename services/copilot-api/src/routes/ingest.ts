import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { TicketSource, TicketCategory } from '@bronco/shared-types';
import type { IngestionJob } from '@bronco/shared-types';

const VALID_CATEGORIES = new Set<string>(Object.values(TicketCategory));

interface IngestOpts {
  ingestQueue: Queue<IngestionJob>;
}

export async function ingestRoutes(
  fastify: FastifyInstance,
  opts: IngestOpts,
): Promise<void> {
  const { ingestQueue } = opts;

  /**
   * POST /api/ingest/probe — Accept raw probe results for ingestion.
   * The ingestion engine will match an INGESTION route by source=SCHEDULED
   * and run the configured steps (CATEGORIZE, GENERATE_TITLE, CREATE_TICKET, etc.).
   */
  fastify.post<{
    Body: {
      probeId: string;
      clientId: string;
      probeName: string;
      toolName: string;
      toolResult: string;
      category?: string;
      integrationId?: string;
      operatorEmail?: string;
    };
  }>('/api/ingest/probe', async (request, reply) => {
    const { probeId, clientId, probeName, toolName, toolResult, category, integrationId, operatorEmail } = request.body;

    if (!probeId || !clientId || !toolName) {
      return fastify.httpErrors.badRequest('probeId, clientId, and toolName are required.');
    }
    if (!toolResult) {
      return fastify.httpErrors.badRequest('toolResult is required (cannot ingest empty results).');
    }

    // Verify client exists
    const client = await fastify.db.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!client) {
      return fastify.httpErrors.badRequest(`Client "${clientId}" not found.`);
    }

    const job: IngestionJob = {
      source: TicketSource.SCHEDULED,
      clientId,
      payload: {
        probeId,
        probeName: probeName || toolName,
        toolName,
        toolResult: toolResult.slice(0, 50_000),
        ...(category && VALID_CATEGORIES.has(category) && { category }),
        ...(integrationId && { integrationId }),
        ...(operatorEmail && { operatorEmail }),
      },
    };

    await ingestQueue.add('ticket-ingest', job, {
      jobId: `ingest-probe-${probeId}-${Date.now()}`,
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
    });

    reply.code(202);
    return { queued: true, source: TicketSource.SCHEDULED, clientId };
  });

  // ── Ingestion Run History ──────────────────────────────────────────

  /**
   * GET /api/ingest/runs — List recent ingestion runs with optional filtering.
   */
  fastify.get<{
    Querystring: { clientId?: string; status?: string; limit?: string; offset?: string };
  }>('/api/ingest/runs', async (request) => {
    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);
    const { clientId, status } = request.query;

    const where: Record<string, unknown> = {};
    if (clientId) where.clientId = clientId;
    if (status) where.status = status;

    const [runs, total] = await Promise.all([
      fastify.db.ingestionRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          client: { select: { shortCode: true, name: true } },
          // For the list view, return only lightweight step metadata to avoid large payloads.
          // output/error can be up to tens of KB per step; reserve those for the detail endpoint.
          steps: {
            orderBy: { stepOrder: 'asc' },
            select: {
              id: true,
              stepOrder: true,
              stepType: true,
              stepName: true,
              status: true,
              durationMs: true,
              startedAt: true,
              completedAt: true,
            },
          },
        },
      }),
      fastify.db.ingestionRun.count({ where }),
    ]);

    return { runs, total };
  });

  /**
   * GET /api/ingest/runs/:id — Single ingestion run with all steps.
   */
  fastify.get<{ Params: { id: string } }>('/api/ingest/runs/:id', async (request) => {
    const run = await fastify.db.ingestionRun.findUnique({
      where: { id: request.params.id },
      include: {
        client: { select: { shortCode: true, name: true } },
        steps: { orderBy: { stepOrder: 'asc' } },
      },
    });
    if (!run) return fastify.httpErrors.notFound('Ingestion run not found');
    return run;
  });
}
