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
    const { ticketId, clientId, source, category, reanalysis } = job.data;

    logger.info({ ticketId, source, category, reanalysis: reanalysis === true }, 'Checking for matching route');

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

    // Job ID strategy (#375):
    //   - Initial ticket-created dispatch uses the deterministic `analysis-<ticketId>`
    //     ID so a burst of duplicate ticket-created events collapses to one job.
    //   - Retries (operator-clicked Retry Analysis) use `reanalysis-<ticketId>-<ts>`
    //     so every click produces a unique job and is not silently deduped against
    //     the completed initial run. The timestamp also makes retries easy to count
    //     in Redis telemetry.
    //
    // `removeOnComplete` ages completed jobs out of Redis after 1 hour so the
    // initial-run ID can be reused if the pipeline genuinely needs to rerun later
    // (defence-in-depth against the same dedupe-on-completed failure class).
    const analysisJobId = reanalysis === true
      ? `reanalysis-${ticketId}-${Date.now()}`
      : `analysis-${ticketId}`;

    const enqueuedJob = await deps.analysisQueue.add('analyze-ticket', {
      ticketId,
      clientId,
      reanalysis: reanalysis === true ? true : undefined,
    }, {
      jobId: analysisJobId,
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    });

    // Defence-in-depth: if BullMQ returned a pre-existing job (dedupe hit on a
    // deterministic ID), the returned Job.timestamp will be much older than now.
    // Surface it as a warning so the operator-triggered path can't silently no-op.
    const DEDUPE_THRESHOLD_MS = 5_000;
    if (enqueuedJob.timestamp && Date.now() - enqueuedJob.timestamp > DEDUPE_THRESHOLD_MS) {
      logger.warn(
        { ticketId, jobId: analysisJobId, jobTimestamp: enqueuedJob.timestamp, reanalysis: reanalysis === true },
        'Analysis enqueue was a dedupe hit — existing job returned instead of creating a new one',
      );
    }
  };
}
