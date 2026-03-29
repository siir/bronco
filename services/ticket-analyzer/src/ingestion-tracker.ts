import type { PrismaClient } from '@bronco/db';
import type { TicketSource } from '@bronco/shared-types';

// ---------------------------------------------------------------------------
// Ingestion Run Tracker
// ---------------------------------------------------------------------------
// Mirrors the ProbeRunTracker pattern from probe-worker. Records per-step
// status, timing, and output so the operator can see what happened inside an
// ingestion pipeline execution.
// ---------------------------------------------------------------------------

export interface IngestionRunTracker {
  runId: string;
  startStep(stepOrder: number, stepType: string, stepName: string): Promise<string>;
  completeStep(stepId: string, output?: string): Promise<void>;
  failStep(stepId: string, error: string): Promise<void>;
  skipStep(stepId: string, reason?: string): Promise<void>;
  completeRun(status: 'success' | 'error' | 'no_route', ticketId?: string, error?: string): Promise<void>;
}

export async function createIngestionRunTracker(
  db: PrismaClient,
  jobId: string,
  source: TicketSource,
  clientId: string,
  routeId?: string,
  routeName?: string,
): Promise<IngestionRunTracker> {
  const run = await db.ingestionRun.create({
    data: {
      jobId,
      source: source as never,
      clientId,
      routeId: routeId ?? null,
      routeName: routeName ?? null,
      status: 'processing',
    },
  });

  // In-memory map of stepId -> startedAt to avoid extra DB round-trips on completion.
  const stepStartTimes = new Map<string, Date>();

  return {
    runId: run.id,

    async startStep(stepOrder: number, stepType: string, stepName: string): Promise<string> {
      const startedAt = new Date();
      const step = await db.ingestionRunStep.create({
        data: {
          runId: run.id,
          stepOrder,
          stepType,
          stepName,
          status: 'processing',
          startedAt,
        },
      });
      stepStartTimes.set(step.id, startedAt);
      return step.id;
    },

    async completeStep(stepId: string, output?: string): Promise<void> {
      const now = new Date();
      const startedAt = stepStartTimes.get(stepId);
      const durationMs = startedAt ? now.getTime() - startedAt.getTime() : null;
      await db.ingestionRunStep.update({
        where: { id: stepId },
        data: {
          status: 'success',
          completedAt: now,
          durationMs,
          output: output?.slice(0, 50_000) ?? null,
        },
      });
    },

    async failStep(stepId: string, error: string): Promise<void> {
      const now = new Date();
      const startedAt = stepStartTimes.get(stepId);
      const durationMs = startedAt ? now.getTime() - startedAt.getTime() : null;
      await db.ingestionRunStep.update({
        where: { id: stepId },
        data: {
          status: 'error',
          completedAt: now,
          durationMs,
          error: error.slice(0, 10_000),
        },
      });
    },

    async skipStep(stepId: string, reason?: string): Promise<void> {
      const now = new Date();
      const startedAt = stepStartTimes.get(stepId);
      const durationMs = startedAt ? now.getTime() - startedAt.getTime() : null;
      await db.ingestionRunStep.update({
        where: { id: stepId },
        data: {
          status: 'skipped',
          completedAt: now,
          durationMs,
          output: reason?.slice(0, 50_000) ?? null,
        },
      });
    },

    async completeRun(status: 'success' | 'error' | 'no_route', ticketId?: string, error?: string): Promise<void> {
      const completedAt = new Date();
      await db.ingestionRun.update({
        where: { id: run.id },
        data: {
          status,
          completedAt,
          ticketId: ticketId ?? null,
          error: error?.slice(0, 10_000) ?? null,
        },
      });
    },
  };
}
