import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '@bronco/db';
import type { TicketCreatedJob, TicketCategory, TicketSource } from '@bronco/shared-types';
import { AnalysisStatus } from '@bronco/shared-types';
import { createLogger } from '@bronco/shared-utils';
import type { AnalysisJob } from './analyzer.js';

const logger = createLogger('route-dispatcher');

export function createRouteDispatcher(deps: {
  db: PrismaClient;
  analysisQueue: Queue<AnalysisJob>;
}) {
  return async function processTicketCreated(job: Job<TicketCreatedJob>): Promise<void> {
    const { ticketId, clientId, source, category } = job.data;

    logger.info({ ticketId, source, category }, 'Checking for matching route');

    // Check if any active ANALYSIS route matches this ticket's source/category/client.
    // This is a lightweight check — full route resolution (including AI selection)
    // happens inside the analysis worker. Ingestion routes are handled separately
    // by the ingestion engine (ticket-ingest queue).
    // Exclude re-analysis routes (those containing UPDATE_ANALYSIS steps) — they are
    // only valid for reply-triggered re-analysis, not new ticket-created events.
    const route = await deps.db.ticketRoute.findFirst({
      where: {
        isActive: true,
        routeType: 'ANALYSIS',
        steps: { none: { stepType: 'UPDATE_ANALYSIS', isActive: true } },
        OR: category != null
          ? [
              // Ticket has a known category — match routes for this exact category
              { clientId, category: category as TicketCategory, source: source as TicketSource },
              { clientId, category: category as TicketCategory, source: null },
              { clientId: null, category: category as TicketCategory, source: source as TicketSource },
              { clientId: null, category: category as TicketCategory, source: null },
              // Also match default catch-all routes (category: null, isDefault: true)
              { clientId, category: null, source: source as TicketSource, isDefault: true },
              { clientId, category: null, source: null, isDefault: true },
              { clientId: null, category: null, source: source as TicketSource, isDefault: true },
              { clientId: null, category: null, source: null, isDefault: true },
            ]
          : [
              // Ticket has no category — match any active catch-all routes (category: null),
              // regardless of isDefault, so that AI-selectable non-default routes are considered.
              { clientId, category: null, source: source as TicketSource },
              { clientId, category: null, source: null },
              { clientId: null, category: null, source: source as TicketSource },
              { clientId: null, category: null, source: null },
            ],
      },
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    });

    if (!route) {
      logger.info({ ticketId, source }, 'No DB route matched — enqueuing for default fallback analysis');
    } else {
      logger.info({ ticketId, routeId: route.id, routeName: route.name }, 'Route matched — enqueuing analysis');
    }

    await deps.db.ticket.update({
      where: { id: ticketId },
      data: { analysisStatus: AnalysisStatus.IN_PROGRESS },
    });

    // Deduplicate: use ticketId as job ID to prevent duplicate analysis
    await deps.analysisQueue.add('analyze-ticket', {
      ticketId,
      clientId,
    }, {
      jobId: `analysis-${ticketId}`,
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  };
}
