/**
 * Integration tests for IngestionRunTracker (ingestion-tracker.ts)
 *
 * Verifies that:
 *   - createIngestionRunTracker writes an ingestion_runs row with status=processing
 *   - startStep writes an ingestion_run_steps row linked to the run
 *   - completeStep updates the step row with status=success, durationMs, and output
 *   - failStep updates the step row with status=error and error message
 *   - skipStep updates the step row with status=skipped
 *   - Multiple steps in a run are all linked to the same runId
 *   - completeRun updates the run row with final status and ticketId
 *   - completeRun with status=error stores the error message
 */

import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { TicketSource } from '@bronco/shared-types';
import { getTestDb, truncateAll, createClient } from '@bronco/test-utils';
import { createIngestionRunTracker } from './ingestion-tracker.js';

const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

describe.skipIf(!hasDb)('integration: IngestionRunTracker', () => {
  let db: PrismaClient;
  let clientId: string;

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);
    const client = await createClient(db);
    clientId = client.id;
  });

  beforeEach(async () => {
    // Only truncate the tracking tables (not clients) to keep the client fixture
    await db.$executeRawUnsafe('TRUNCATE TABLE "ingestion_run_steps" RESTART IDENTITY CASCADE');
    await db.$executeRawUnsafe('TRUNCATE TABLE "ingestion_runs" RESTART IDENTITY CASCADE');
  });

  // -------------------------------------------------------------------------
  // Run creation
  // -------------------------------------------------------------------------

  it('creates an ingestion_runs row with status=processing', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-abc-1',
      TicketSource.MANUAL,
      clientId,
    );

    expect(tracker.runId).toBeTruthy();

    const run = await db.ingestionRun.findUnique({ where: { id: tracker.runId } });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('processing');
    expect(run!.jobId).toBe('job-abc-1');
    expect(run!.source).toBe(TicketSource.MANUAL);
    expect(run!.clientId).toBe(clientId);
    expect(run!.completedAt).toBeNull();
  });

  it('stores routeId and routeName when provided', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-with-route',
      TicketSource.EMAIL,
      clientId,
      undefined,   // routeId: no TicketRoute row — null ref is ok since schema uses SetNull
      'My Route Name',
    );

    const run = await db.ingestionRun.findUnique({ where: { id: tracker.runId } });
    expect(run!.routeId).toBeNull();   // no real TicketRoute row
    expect(run!.routeName).toBe('My Route Name');
  });

  // -------------------------------------------------------------------------
  // Step lifecycle: startStep → completeStep
  // -------------------------------------------------------------------------

  it('startStep creates an ingestion_run_steps row with status=processing', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-steps-1',
      TicketSource.MANUAL,
      clientId,
    );

    const stepId = await tracker.startStep(1, 'CATEGORIZE', 'Categorize ticket');

    const step = await db.ingestionRunStep.findUnique({ where: { id: stepId } });
    expect(step).not.toBeNull();
    expect(step!.runId).toBe(tracker.runId);
    expect(step!.stepOrder).toBe(1);
    expect(step!.stepType).toBe('CATEGORIZE');
    expect(step!.stepName).toBe('Categorize ticket');
    expect(step!.status).toBe('processing');
    expect(step!.startedAt).not.toBeNull();
  });

  it('completeStep updates step to status=success with output and durationMs', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-complete-step',
      TicketSource.MANUAL,
      clientId,
    );

    const stepId = await tracker.startStep(1, 'CATEGORIZE', 'Categorize ticket');
    await tracker.completeStep(stepId, 'DATABASE_PERF');

    const step = await db.ingestionRunStep.findUnique({ where: { id: stepId } });
    expect(step!.status).toBe('success');
    expect(step!.output).toBe('DATABASE_PERF');
    expect(step!.completedAt).not.toBeNull();
    expect(step!.durationMs).not.toBeNull();
    expect(typeof step!.durationMs).toBe('number');
    expect(step!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('completeStep with no output stores null', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-complete-no-output',
      TicketSource.MANUAL,
      clientId,
    );

    const stepId = await tracker.startStep(1, 'CREATE_TICKET', 'Create ticket');
    await tracker.completeStep(stepId);

    const step = await db.ingestionRunStep.findUnique({ where: { id: stepId } });
    expect(step!.status).toBe('success');
    expect(step!.output).toBeNull();
  });

  // -------------------------------------------------------------------------
  // failStep
  // -------------------------------------------------------------------------

  it('failStep updates step to status=error with error message', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-fail-step',
      TicketSource.MANUAL,
      clientId,
    );

    const stepId = await tracker.startStep(1, 'CATEGORIZE', 'Categorize ticket');
    await tracker.failStep(stepId, 'Ollama offline: connection refused');

    const step = await db.ingestionRunStep.findUnique({ where: { id: stepId } });
    expect(step!.status).toBe('error');
    expect(step!.error).toBe('Ollama offline: connection refused');
    expect(step!.completedAt).not.toBeNull();
  });

  it('failStep truncates error messages longer than 10 000 chars', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-fail-truncate',
      TicketSource.MANUAL,
      clientId,
    );

    const stepId = await tracker.startStep(1, 'CATEGORIZE', 'Categorize');
    const longError = 'E'.repeat(15_000);
    await tracker.failStep(stepId, longError);

    const step = await db.ingestionRunStep.findUnique({ where: { id: stepId } });
    expect(step!.error!.length).toBe(10_000);
  });

  // -------------------------------------------------------------------------
  // skipStep
  // -------------------------------------------------------------------------

  it('skipStep updates step to status=skipped with reason', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-skip-step',
      TicketSource.MANUAL,
      clientId,
    );

    const stepId = await tracker.startStep(1, 'RESOLVE_THREAD', 'Resolve Thread');
    await tracker.skipStep(stepId, 'Not an email source');

    const step = await db.ingestionRunStep.findUnique({ where: { id: stepId } });
    expect(step!.status).toBe('skipped');
    expect(step!.output).toBe('Not an email source');
    expect(step!.completedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Multiple steps linked to same run
  // -------------------------------------------------------------------------

  it('multiple steps in a run are all linked to the same runId', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-multi-steps',
      TicketSource.MANUAL,
      clientId,
    );

    const step1 = await tracker.startStep(1, 'CATEGORIZE', 'Categorize');
    const step2 = await tracker.startStep(2, 'TRIAGE_PRIORITY', 'Triage Priority');
    const step3 = await tracker.startStep(3, 'CREATE_TICKET', 'Create Ticket');

    await tracker.completeStep(step1, 'BUG_FIX');
    await tracker.completeStep(step2, 'HIGH');
    await tracker.completeStep(step3, 'Ticket created: ticket-xyz');

    const steps = await db.ingestionRunStep.findMany({
      where: { runId: tracker.runId },
      orderBy: { stepOrder: 'asc' },
    });

    expect(steps).toHaveLength(3);
    expect(steps.every((s) => s.runId === tracker.runId)).toBe(true);
    expect(steps[0].stepType).toBe('CATEGORIZE');
    expect(steps[1].stepType).toBe('TRIAGE_PRIORITY');
    expect(steps[2].stepType).toBe('CREATE_TICKET');
    expect(steps[0].output).toBe('BUG_FIX');
    expect(steps[1].output).toBe('HIGH');
  });

  // -------------------------------------------------------------------------
  // completeRun — success
  // -------------------------------------------------------------------------

  it('completeRun marks the run as success with ticketId', async () => {
    // Create a real ticket to link
    const { createTicket } = await import('@bronco/test-utils');
    const ticket = await createTicket(db, { clientId });

    const tracker = await createIngestionRunTracker(
      db,
      'job-complete-run-success',
      TicketSource.MANUAL,
      clientId,
    );

    await tracker.completeRun('success', ticket.id);

    const run = await db.ingestionRun.findUnique({ where: { id: tracker.runId } });
    expect(run!.status).toBe('success');
    expect(run!.completedAt).not.toBeNull();
    expect(run!.ticketId).toBe(ticket.id);
    expect(run!.error).toBeNull();
  });

  it('completeRun marks the run as error with error message', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-complete-run-error',
      TicketSource.MANUAL,
      clientId,
    );

    await tracker.completeRun('error', undefined, 'Pipeline threw: unexpected DB error');

    const run = await db.ingestionRun.findUnique({ where: { id: tracker.runId } });
    expect(run!.status).toBe('error');
    expect(run!.completedAt).not.toBeNull();
    expect(run!.ticketId).toBeNull();
    expect(run!.error).toBe('Pipeline threw: unexpected DB error');
  });

  it('completeRun with no_route status stores correct status', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-no-route',
      TicketSource.MANUAL,
      clientId,
    );

    await tracker.completeRun('no_route');

    const run = await db.ingestionRun.findUnique({ where: { id: tracker.runId } });
    expect(run!.status).toBe('no_route');
  });

  it('completeRun truncates error messages longer than 10 000 chars', async () => {
    const tracker = await createIngestionRunTracker(
      db,
      'job-error-truncate',
      TicketSource.MANUAL,
      clientId,
    );

    const longError = 'X'.repeat(15_000);
    await tracker.completeRun('error', undefined, longError);

    const run = await db.ingestionRun.findUnique({ where: { id: tracker.runId } });
    expect(run!.error!.length).toBe(10_000);
  });

  // -------------------------------------------------------------------------
  // Multiple trackers are independent
  // -------------------------------------------------------------------------

  it('two concurrent trackers produce separate runs', async () => {
    const t1 = await createIngestionRunTracker(db, 'job-t1', TicketSource.MANUAL, clientId);
    const t2 = await createIngestionRunTracker(db, 'job-t2', TicketSource.EMAIL, clientId);

    expect(t1.runId).not.toBe(t2.runId);

    const runs = await db.ingestionRun.findMany({ where: { clientId } });
    const runIds = runs.map((r) => r.id);
    expect(runIds).toContain(t1.runId);
    expect(runIds).toContain(t2.runId);
  });
});
