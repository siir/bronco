import { writeFile, mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '@bronco/db';
import { Prisma } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import {
  RouteStepType,
  TaskType,
  TicketCategory,
  TicketSource,
  isOpenStatus,
} from '@bronco/shared-types';
import type {
  IngestionJob,
  TicketCreatedJob,
  AnalysisJob,
  Priority,
} from '@bronco/shared-types';
import { createLogger } from '@bronco/shared-utils';
import type { AppLogger, Mailer, ReplyOptions } from '@bronco/shared-utils';
import { createIngestionRunTracker } from './ingestion-tracker.js';
import type { IngestionRunTracker } from './ingestion-tracker.js';
import { enqueueArtifactNameGeneration } from './artifact-name-queue.js';

const logger = createLogger('ingestion-engine');

/** No-op tracker used when the real tracker fails to initialize (e.g. missing tables). */
const noopTracker: IngestionRunTracker = {
  runId: 'noop',
  startStep: async () => 'noop',
  completeStep: async () => {},
  failStep: async () => {},
  skipStep: async () => {},
  completeRun: async () => {},
};

// ---------------------------------------------------------------------------
// AI call timeout — prevents hung Ollama calls from blocking the pipeline
// ---------------------------------------------------------------------------

const AI_STEP_TIMEOUT_MS = 120_000;

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${label} timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Tracked step error for post-creation visibility. */
interface StepError {
  step: RouteStepType;
  error: string;
  fallback: string;
}

const VALID_CATEGORIES = new Set<string>(Object.values(TicketCategory));
function isValidCategory(val: unknown): val is TicketCategory {
  return typeof val === 'string' && VALID_CATEGORIES.has(val);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestionDeps {
  db: PrismaClient;
  ai: AIRouter;
  mailer: Mailer | null;
  ticketCreatedQueue: Queue<TicketCreatedJob>;
  analysisQueue?: Queue<AnalysisJob>;
  senderSignature: string;
  smtpFrom: string;
  appLog?: AppLogger;
  artifactStoragePath?: string;
}

/** Route with steps included. */
type ResolvedRoute = Awaited<ReturnType<PrismaClient['ticketRoute']['findFirst']>> & {
  steps: Array<{
    id: string;
    stepOrder: number;
    name: string;
    stepType: string;
    taskTypeOverride: string | null;
    promptKeyOverride: string | null;
    config: unknown;
    isActive: boolean;
  }>;
};

/** Thread resolution result from RESOLVE_THREAD step. */
interface ThreadResolution {
  /** Whether the email matched an existing ticket thread. */
  isReply: boolean;
  /** Existing ticket ID if threaded to an existing ticket. */
  existingTicketId: string | null;
  /** How the thread was resolved. */
  method: 'message-id-reference' | 'subject-match' | 'none';
}

/** Mutable state accumulated across ingestion steps. */
interface IngestionContext {
  source: TicketSource;
  clientId: string;
  payload: Record<string, unknown>;
  // Accumulated by steps
  title: string;
  description: string;
  summary: string;
  category: string;
  priority: string;
  /** Set by CREATE_TICKET step. */
  ticketId: string | null;
  /** Person ID to add as requester follower. */
  requesterId: string | null;
  /** Set by RESOLVE_THREAD step — indicates whether this email is a reply to an existing ticket. */
  threadResolution: ThreadResolution | null;
}

// ---------------------------------------------------------------------------
// Ticket number generation (same pattern as probe-worker / imap-worker)
// ---------------------------------------------------------------------------

const MAX_TICKET_RETRIES = 3;

async function nextTicketNumber(db: PrismaClient, clientId: string): Promise<number> {
  const last = await db.ticket.findFirst({
    where: { clientId, ticketNumber: { gt: 0 } },
    orderBy: { ticketNumber: 'desc' },
    select: { ticketNumber: true },
  });
  return (last?.ticketNumber ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Route resolution — find INGESTION route matching source + client
// ---------------------------------------------------------------------------

async function resolveIngestionRoute(
  db: PrismaClient,
  source: TicketSource,
  clientId: string,
): Promise<ResolvedRoute | null> {
  const includeSteps = {
    steps: { where: { isActive: true }, orderBy: { stepOrder: 'asc' as const } },
  };

  // 1. Client-specific + source-specific
  const clientSourceRoute = await db.ticketRoute.findFirst({
    where: { routeType: 'INGESTION', clientId, source, isActive: true } as never,
    include: includeSteps,
    orderBy: { sortOrder: 'asc' },
  });
  if (clientSourceRoute && clientSourceRoute.steps.length > 0) return clientSourceRoute as ResolvedRoute;

  // 2. Client-specific + any-source
  const clientAnyRoute = await db.ticketRoute.findFirst({
    where: { routeType: 'INGESTION', clientId, source: null, isActive: true } as never,
    include: includeSteps,
    orderBy: { sortOrder: 'asc' },
  });
  if (clientAnyRoute && clientAnyRoute.steps.length > 0) return clientAnyRoute as ResolvedRoute;

  // 3. Global + source-specific
  const globalSourceRoute = await db.ticketRoute.findFirst({
    where: { routeType: 'INGESTION', clientId: null, source, isActive: true } as never,
    include: includeSteps,
    orderBy: { sortOrder: 'asc' },
  });
  if (globalSourceRoute && globalSourceRoute.steps.length > 0) return globalSourceRoute as ResolvedRoute;

  // 4. Global + any-source
  const globalAnyRoute = await db.ticketRoute.findFirst({
    where: { routeType: 'INGESTION', clientId: null, source: null, isActive: true } as never,
    include: includeSteps,
    orderBy: { sortOrder: 'asc' },
  });
  if (globalAnyRoute && globalAnyRoute.steps.length > 0) return globalAnyRoute as ResolvedRoute;

  return null;
}

// ---------------------------------------------------------------------------
// Payload helpers — read source-specific fields from the generic payload
// ---------------------------------------------------------------------------

function payloadStr(payload: Record<string, unknown>, key: string): string {
  const val = payload[key];
  return typeof val === 'string' ? val : '';
}

// ---------------------------------------------------------------------------
// Ingestion pipeline execution
// ---------------------------------------------------------------------------

async function executeIngestionPipeline(
  deps: IngestionDeps,
  route: ResolvedRoute,
  ctx: IngestionContext,
  tracker: IngestionRunTracker,
): Promise<void> {
  const { db, ai, mailer, ticketCreatedQueue, senderSignature } = deps;
  const { source, clientId, payload } = ctx;

  // Wrap tracker in a best-effort proxy so tracking failures never affect pipeline correctness.
  // BullMQ will retry failed jobs, and a tracking DB error after ticket creation would cause
  // duplicate tickets if the job is retried — so observability must be non-blocking.
  const safeTracker: IngestionRunTracker = {
    runId: tracker.runId,
    startStep: (...args) => tracker.startStep(...args).catch((err) => {
      logger.warn({ err }, 'Tracker startStep failed — continuing without tracking');
      return 'noop';
    }),
    completeStep: (...args) => tracker.completeStep(...args).catch((err) => {
      logger.warn({ err }, 'Tracker completeStep failed — continuing');
    }),
    failStep: (...args) => tracker.failStep(...args).catch((err) => {
      logger.warn({ err }, 'Tracker failStep failed — continuing');
    }),
    skipStep: (...args) => tracker.skipStep(...args).catch((err) => {
      logger.warn({ err }, 'Tracker skipStep failed — continuing');
    }),
    completeRun: (...args) => tracker.completeRun(...args).catch((err) => {
      logger.warn({ err }, 'Tracker completeRun failed — continuing');
    }),
  };

  const stepErrors: StepError[] = [];
  const pipelineStart = Date.now();
  let stepsSucceeded = 0;
  let stepsFailed = 0;
  let stepsSkipped = 0;

  logger.info({ source, clientId, routeId: route!.id, routeName: route!.name, steps: route!.steps.length }, 'Executing ingestion pipeline');

  // Track per-stepType run counter so logs can be grouped by (stepType, taskRun)
  const taskRunCounter = new Map<string, number>();

  for (const step of route!.steps) {
    const currentRun = (taskRunCounter.get(step.stepType) ?? 0) + 1;
    taskRunCounter.set(step.stepType, currentRun);

    logger.info({ stepType: step.stepType, stepName: step.name, clientId, taskRun: currentRun }, `Executing ingestion step: ${step.name}`);
    const stepId = await safeTracker.startStep(step.stepOrder, step.stepType, step.name);
    const stepStart = Date.now();

    switch (step.stepType) {
      // ── RESOLVE_THREAD ──────────────────────────────────────────────
      case RouteStepType.RESOLVE_THREAD: {
        // Only relevant for EMAIL source — skip for other sources
        if (source !== TicketSource.EMAIL) {
          logger.info({ clientId, source }, 'Skipping RESOLVE_THREAD — not an email source');
          await safeTracker.skipStep(stepId, 'Not an email source');
          stepsSkipped++;
          break;
        }

        const inReplyTo = payloadStr(payload, 'inReplyTo');
        const references = payload['references'] as string[] | undefined;
        const emailHash = payloadStr(payload, 'emailHash');
        const emailMessageId = payloadStr(payload, 'messageId');
        const emailSubject = payloadStr(payload, 'subject');
        const emailFrom = payloadStr(payload, 'from');
        const emailFromName = payloadStr(payload, 'fromName');
        const emailBody = payloadStr(payload, 'body');

        let existingTicketId: string | null = null;
        let threadMethod: 'message-id-reference' | 'subject-match' | 'none' = 'none';

        // 1. Try Message-ID reference matching
        if (inReplyTo || (references && references.length > 0)) {
          const refIds = [
            ...(inReplyTo ? [inReplyTo] : []),
            ...(references ?? []),
          ];

          logger.info({ refIds, clientId }, 'Attempting thread match by message references');

          const existingEvent = await db.ticketEvent.findFirst({
            where: {
              emailMessageId: { in: refIds },
              ticket: { clientId },
            },
            select: { ticketId: true },
          });

          if (existingEvent) {
            existingTicketId = existingEvent.ticketId;
            threadMethod = 'message-id-reference';
            logger.info({ ticketId: existingTicketId, clientId }, 'Threaded to existing ticket via message reference');
          } else {
            logger.info({ refIds, clientId }, 'No thread match found via message references');
          }
        }

        // 2. Fallback: subject matching within 7 days
        if (!existingTicketId) {
          const normalized = emailSubject.replace(/^(Re|Fwd|Fw):\s*/gi, '').trim();
          if (normalized) {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            logger.info({ normalized, clientId, since: sevenDaysAgo.toISOString() }, 'Attempting thread match by subject');

            const existingTicket = await db.ticket.findFirst({
              where: {
                clientId,
                subject: { contains: normalized, mode: 'insensitive' },
                createdAt: { gte: sevenDaysAgo },
                status: { not: 'CLOSED' },
              },
              orderBy: { createdAt: 'desc' },
            });

            if (existingTicket) {
              existingTicketId = existingTicket.id;
              threadMethod = 'subject-match';
              logger.info({ ticketId: existingTicketId, clientId }, 'Threaded to existing ticket via subject match');
            } else {
              logger.info({ normalized, clientId }, 'No thread match found by subject');
            }
          }
        }

        const isReply = existingTicketId !== null;
        ctx.threadResolution = { isReply, existingTicketId, method: threadMethod };

        if (isReply) {
          // --- Reply to existing ticket ---
          // Append EMAIL_INBOUND event to existing ticket
          const hasRealMessageId = emailMessageId && !emailMessageId.startsWith('uid-');
          await db.ticketEvent.create({
            data: {
              ticketId: existingTicketId!,
              eventType: 'EMAIL_INBOUND',
              content: emailBody.slice(0, 2000),
              emailMessageId: hasRealMessageId ? emailMessageId : null,
              emailHash: emailHash || null,
              metadata: {
                messageId: emailMessageId || null,
                from: emailFrom,
                fromName: emailFromName || null,
                subject: emailSubject,
                inReplyTo: inReplyTo || null,
                references: references ?? [],
                hasAttachments: payload['hasAttachments'] ?? false,
              },
              actor: `email:${emailFrom}`,
            },
          });

          logger.info({ ticketId: existingTicketId, threadMethod, clientId }, 'Reply appended to existing ticket');
          const stepDuration = Date.now() - stepStart;
          deps.appLog?.info(
            `Thread resolved: reply to existing ticket via ${threadMethod} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId: existingTicketId, threadMethod, from: emailFrom, subject: emailSubject, clientId, durationMs: stepDuration, taskRun: currentRun },
            existingTicketId!,
            'ticket',
          );

          // Trigger re-analysis if conditions are met
          if (deps.analysisQueue) {
            await maybeEnqueueReanalysis(db, deps.analysisQueue, existingTicketId!, emailFrom, deps.smtpFrom, logger);
          }

          // Set ticketId so downstream steps know this ticket already exists
          ctx.ticketId = existingTicketId;

          await safeTracker.completeStep(stepId, `Reply threaded to ticket ${existingTicketId} (${threadMethod})`);
          stepsSucceeded++;
        } else {
          // --- New email — continue pipeline ---
          const stepDuration = Date.now() - stepStart;
          logger.info({ clientId, subject: emailSubject }, 'No thread match — proceeding as new ticket');
          deps.appLog?.info(
            `Thread resolved: new email, no matching thread (${(stepDuration / 1000).toFixed(1)}s)`,
            { clientId, method: 'none', durationMs: stepDuration, taskRun: currentRun },
          );
          await safeTracker.completeStep(stepId, 'New email — no matching thread');
          stepsSucceeded++;
        }

        break;
      }

      // ── SUMMARIZE_EMAIL ─────────────────────────────────────────────
      case RouteStepType.SUMMARIZE_EMAIL: {
        if (ctx.threadResolution?.isReply) {
          await safeTracker.skipStep(stepId, 'Skipped for reply — ticket already exists');
          stepsSkipped++;
          break;
        }
        const body = payloadStr(payload, 'body');
        const subject = payloadStr(payload, 'subject');
        if (!body && !subject) {
          logger.info({ clientId }, 'Skipping SUMMARIZE_EMAIL — no email content in payload');
          await safeTracker.skipStep(stepId, 'No email content in payload');
          stepsSkipped++;
          break;
        }
        try {
          const promptKey = step.promptKeyOverride ?? 'imap.summarize.system';
          const taskType = (step.taskTypeOverride ?? TaskType.SUMMARIZE) as string;
          const summaryRes = await withTimeout(
            (signal) => ai.generate({
              taskType: taskType as typeof TaskType.SUMMARIZE,
              context: { clientId, taskRun: currentRun },
              prompt: `Summarize the following support email in 2-3 concise bullet points:\n\nSubject: ${subject}\n\n${body}`,
              promptKey,
              signal,
            }),
            AI_STEP_TIMEOUT_MS,
            'SUMMARIZE_EMAIL',
          );
          ctx.summary = summaryRes.content;
          if (!ctx.description) ctx.description = ctx.summary;
          const stepDuration = Date.now() - stepStart;
          deps.appLog?.info(
            `Email summarized: ${ctx.summary.length} chars via ${summaryRes.provider}/${summaryRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { clientId, summaryLength: ctx.summary.length, provider: summaryRes.provider, model: summaryRes.model, durationMs: stepDuration, taskRun: currentRun },
            ctx.ticketId ?? clientId,
            'ticket',
          );
          await safeTracker.completeStep(stepId, ctx.summary);
          stepsSucceeded++;
        } catch (err) {
          logger.error({ err, clientId, stepType: step.stepType }, 'Ingestion step failed — skipping summary');
          stepErrors.push({ step: RouteStepType.SUMMARIZE_EMAIL, error: err instanceof Error ? err.message : String(err), fallback: 'empty (use raw description)' });
          await safeTracker.failStep(stepId, err instanceof Error ? err.message : String(err));
          stepsFailed++;
        }
        break;
      }

      // ── CATEGORIZE ──────────────────────────────────────────────────
      case RouteStepType.CATEGORIZE: {
        if (ctx.threadResolution?.isReply) {
          await safeTracker.skipStep(stepId, 'Skipped for reply — ticket already exists');
          stepsSkipped++;
          break;
        }
        // Skip if operator explicitly provided a category in the payload
        if (payload['category'] && typeof payload['category'] === 'string' && isValidCategory(payload['category'] as string)) {
          logger.info({ clientId, category: ctx.category }, 'Skipping CATEGORIZE — operator-provided value');
          await safeTracker.skipStep(stepId, `Operator-provided category: ${ctx.category}`);
          stepsSkipped++;
          break;
        }
        try {
          const promptKey = step.promptKeyOverride ?? 'imap.categorize.system';
          const taskType = (step.taskTypeOverride ?? TaskType.CATEGORIZE) as string;
          // Use summary if available, otherwise payload content
          const content = ctx.summary || ctx.description || payloadStr(payload, 'body') || payloadStr(payload, 'toolResult') || payloadStr(payload, 'description');
          const subject = ctx.title || payloadStr(payload, 'subject') || payloadStr(payload, 'title');
          const categorizeRes = await withTimeout(
            (signal) => ai.generate({
              taskType: taskType as typeof TaskType.CATEGORIZE,
              context: { clientId, taskRun: currentRun },
              prompt: `Categorize this support request into exactly one of: DATABASE_PERF, BUG_FIX, FEATURE_REQUEST, SCHEMA_CHANGE, CODE_REVIEW, ARCHITECTURE, GENERAL.\n\nSubject: ${subject}\n\n${content}\n\nRespond with only the category name.`,
              promptKey,
              signal,
            }),
            AI_STEP_TIMEOUT_MS,
            'CATEGORIZE',
          );
          const rawCategory = categorizeRes.content.trim().toUpperCase();
          ctx.category = isValidCategory(rawCategory) ? rawCategory : TicketCategory.GENERAL;
          const stepDuration = Date.now() - stepStart;
          deps.appLog?.info(
            `Categorized as ${ctx.category} via ${categorizeRes.provider}/${categorizeRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { clientId, category: ctx.category, provider: categorizeRes.provider, model: categorizeRes.model, durationMs: stepDuration, taskRun: currentRun },
            ctx.ticketId ?? clientId,
            'ticket',
          );
          await safeTracker.completeStep(stepId, ctx.category);
          stepsSucceeded++;
        } catch (err) {
          logger.error({ err, clientId, stepType: step.stepType }, 'Ingestion step failed — using fallback');
          ctx.category = TicketCategory.GENERAL;
          stepErrors.push({ step: RouteStepType.CATEGORIZE, error: err instanceof Error ? err.message : String(err), fallback: 'GENERAL' });
          await safeTracker.failStep(stepId, err instanceof Error ? err.message : String(err));
          stepsFailed++;
        }
        break;
      }

      // ── TRIAGE_PRIORITY ─────────────────────────────────────────────
      case RouteStepType.TRIAGE_PRIORITY: {
        if (ctx.threadResolution?.isReply) {
          await safeTracker.skipStep(stepId, 'Skipped for reply — ticket already exists');
          stepsSkipped++;
          break;
        }
        // Skip if operator explicitly provided a priority in the payload
        const validPrioritiesCheck = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        if (payload['priority'] && typeof payload['priority'] === 'string' && validPrioritiesCheck.includes((payload['priority'] as string).toUpperCase())) {
          logger.info({ clientId, priority: ctx.priority }, 'Skipping TRIAGE_PRIORITY — operator-provided value');
          await safeTracker.skipStep(stepId, `Operator-provided priority: ${ctx.priority}`);
          stepsSkipped++;
          break;
        }
        try {
          const promptKey = step.promptKeyOverride ?? 'imap.triage.system';
          const taskType = (step.taskTypeOverride ?? TaskType.TRIAGE) as string;
          const content = ctx.summary || ctx.description || payloadStr(payload, 'body') || payloadStr(payload, 'toolResult');
          const subject = ctx.title || payloadStr(payload, 'subject') || payloadStr(payload, 'title');
          const triageRes = await withTimeout(
            (signal) => ai.generate({
              taskType: taskType as typeof TaskType.TRIAGE,
              context: { clientId, taskRun: currentRun },
              prompt: `Assess the priority of this support request. Choose one of: LOW, MEDIUM, HIGH, CRITICAL.\n\nSubject: ${subject}\n\n${content}\n\nRespond with only the priority level.`,
              promptKey,
              signal,
            }),
            AI_STEP_TIMEOUT_MS,
            'TRIAGE_PRIORITY',
          );
          const rawPriority = triageRes.content.trim().toUpperCase();
          const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
          ctx.priority = validPriorities.includes(rawPriority) ? rawPriority : 'MEDIUM';
          const stepDuration = Date.now() - stepStart;
          deps.appLog?.info(
            `Triaged as ${ctx.priority} via ${triageRes.provider}/${triageRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { clientId, priority: ctx.priority, provider: triageRes.provider, model: triageRes.model, durationMs: stepDuration, taskRun: currentRun },
            ctx.ticketId ?? clientId,
            'ticket',
          );
          await safeTracker.completeStep(stepId, ctx.priority);
          stepsSucceeded++;
        } catch (err) {
          logger.error({ err, clientId, stepType: step.stepType }, 'Ingestion step failed — using fallback');
          ctx.priority = 'MEDIUM';
          stepErrors.push({ step: RouteStepType.TRIAGE_PRIORITY, error: err instanceof Error ? err.message : String(err), fallback: 'MEDIUM' });
          await safeTracker.failStep(stepId, err instanceof Error ? err.message : String(err));
          stepsFailed++;
        }
        break;
      }

      // ── GENERATE_TITLE ──────────────────────────────────────────────
      case RouteStepType.GENERATE_TITLE: {
        if (ctx.threadResolution?.isReply) {
          await safeTracker.skipStep(stepId, 'Skipped for reply — ticket already exists');
          stepsSkipped++;
          break;
        }
        try {
          const promptKey = step.promptKeyOverride?.trim() || undefined;
          const taskType = (step.taskTypeOverride ?? TaskType.GENERATE_TITLE) as string;
          const content = ctx.summary || ctx.description || payloadStr(payload, 'body') || payloadStr(payload, 'toolResult');
          const titleRes = await withTimeout(
            (signal) => ai.generate({
              taskType: taskType as typeof TaskType.GENERATE_TITLE,
              context: { clientId, taskRun: currentRun },
              prompt: `Output ONLY a concise ticket title, max 80 characters. No quotes, no preamble, no explanation — just the title text.\n\n${content.slice(0, 1000)}`,
              ...(promptKey && { promptKey }),
              signal,
            }),
            AI_STEP_TIMEOUT_MS,
            'GENERATE_TITLE',
          );
          let newTitle = titleRes.content.trim();
          newTitle = newTitle.replace(/^["']|["']$/g, '');
          newTitle = newTitle.replace(/^(here'?s?\s+(a\s+)?(concise\s+)?ticket\s+title:?\s*)/i, '');
          newTitle = newTitle.replace(/^title:\s*/i, '');
          newTitle = newTitle.slice(0, 80);
          if (newTitle) ctx.title = newTitle;
          const stepDuration = Date.now() - stepStart;
          deps.appLog?.info(
            `Title generated: "${ctx.title.slice(0, 60)}" via ${titleRes.provider}/${titleRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { clientId, title: ctx.title, provider: titleRes.provider, model: titleRes.model, durationMs: stepDuration, taskRun: currentRun },
            ctx.ticketId ?? clientId,
            'ticket',
          );
          await safeTracker.completeStep(stepId, ctx.title);
          stepsSucceeded++;
        } catch (err) {
          logger.error({ err, clientId, stepType: step.stepType }, 'Ingestion step failed — keeping original title');
          stepErrors.push({ step: RouteStepType.GENERATE_TITLE, error: err instanceof Error ? err.message : String(err), fallback: 'original subject/probeName' });
          await safeTracker.failStep(stepId, err instanceof Error ? err.message : String(err));
          stepsFailed++;
        }
        break;
      }

      // ── CREATE_TICKET ───────────────────────────────────────────────
      case RouteStepType.CREATE_TICKET: {
        if (ctx.ticketId) {
          logger.warn({ clientId }, 'CREATE_TICKET skipped — ticket already created in this pipeline');
          await safeTracker.skipStep(stepId, 'Ticket already created in this pipeline');
          stepsSkipped++;
          break;
        }

        // Resolve requester person from payload
        const operatorEmail = payloadStr(payload, 'operatorEmail');
        const personId = payloadStr(payload, 'personId');
        let requesterPersonId: string | undefined;
        if (personId) {
          // Verify the payload personId is linked to this client via a
          // ClientUser row. If not, drop the requester association — without
          // this check we'd attach a follower from another tenant (or a
          // nonexistent person) to the new ticket.
          const verified = await db.person.findFirst({
            where: { id: personId, clientUsers: { some: { clientId } } },
            select: { id: true },
          });
          requesterPersonId = verified?.id ?? undefined;
        }
        if (!requesterPersonId && operatorEmail) {
          const person = await db.person.findFirst({
            where: {
              email: { equals: operatorEmail.trim(), mode: 'insensitive' },
              clientUsers: { some: { clientId } },
            },
            select: { id: true },
          });
          requesterPersonId = person?.id ?? undefined;
        }
        ctx.requesterId = requesterPersonId ?? null;

        // Build ticket subject — use accumulated title or fall back to payload
        const subject = ctx.title
          || payloadStr(payload, 'subject')
          || payloadStr(payload, 'title')
          || payloadStr(payload, 'probeName')
          || 'New ticket';

        // Build description — use accumulated description/summary or payload
        const description = (ctx.description || ctx.summary || payloadStr(payload, 'body') || payloadStr(payload, 'toolResult') || payloadStr(payload, 'description')).slice(0, 2000);

        // Build metadata from known payload fields
        const metadata: Record<string, unknown> = {};
        if (payload['probeId']) metadata['probeId'] = payload['probeId'];
        if (payload['toolName']) metadata['toolName'] = payload['toolName'];
        if (payload['integrationId']) metadata['integrationId'] = payload['integrationId'];
        if (payload['workItemId']) metadata['workItemId'] = payload['workItemId'];
        if (payload['messageId']) metadata['messageId'] = payload['messageId'];
        if (payload['portalCreatorId']) metadata['portalCreatorId'] = payload['portalCreatorId'];
        if (payload['devopsUrl']) metadata['devopsUrl'] = payload['devopsUrl'];

        // External ref for DevOps or email
        const externalRef = payloadStr(payload, 'externalRef') || payloadStr(payload, 'messageId') || null;

        for (let attempt = 0; attempt <= MAX_TICKET_RETRIES; attempt++) {
          const ticketNumber = await nextTicketNumber(db, clientId);
          try {
            // Optional system/environment from Manual/Portal payloads
            const systemId = payloadStr(payload, 'systemId') || undefined;
            const environmentId = payloadStr(payload, 'environmentId') || undefined;

            const ticket = await db.ticket.create({
              data: {
                clientId,
                subject: subject.slice(0, 200),
                description: description || null,
                summary: ctx.summary || null,
                status: 'NEW',
                source: source as never,
                category: ctx.category as TicketCategory | null,
                priority: ctx.priority as Priority,
                ticketNumber,
                externalRef,
                ...(systemId && { systemId }),
                ...(environmentId && { environmentId }),
                metadata: Object.keys(metadata).length > 0 ? (metadata as Prisma.InputJsonValue) : Prisma.DbNull,
                ...(requesterPersonId && {
                  followers: {
                    create: { personId: requesterPersonId, followerType: 'REQUESTER' },
                  },
                }),
              },
              select: { id: true },
            });
            ctx.ticketId = ticket.id;
            logger.info({ clientId, ticketId: ticket.id, source, category: ctx.category, priority: ctx.priority }, 'Ticket created via ingestion pipeline');
            break;
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_TICKET_RETRIES) {
              logger.warn({ attempt, clientId }, 'Ticket number conflict — retrying');
              await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
              continue;
            }
            throw err;
          }
        }

        if (!ctx.ticketId) {
          throw new Error('Failed to create ticket after max retries');
        }

        // Record initial inbound event based on source. For EMAIL we capture the event
        // id so attachments below can stamp originatingEventId without an extra query.
        let inboundEventId: string | null = null;
        if (source === TicketSource.EMAIL) {
          const inboundEvent = await db.ticketEvent.create({
            data: {
              ticketId: ctx.ticketId,
              eventType: 'EMAIL_INBOUND',
              content: description.slice(0, 2000),
              metadata: {
                messageId: payload['messageId'] ?? null,
                from: payload['from'] ?? null,
                fromName: payload['fromName'] ?? null,
                subject: payload['subject'] ?? null,
                inReplyTo: payload['inReplyTo'] ?? null,
                references: payload['references'] ?? null,
                hasAttachments: payload['hasAttachments'] ?? null,
              } as Prisma.InputJsonValue,
              actor: `system:ingestion:${source.toLowerCase()}`,
              ...(typeof payload['messageId'] === 'string' && !payload['messageId'].startsWith('uid-') ? { emailMessageId: payload['messageId'] as string } : {}),
              ...(typeof payload['emailHash'] === 'string' && payload['emailHash'].trim() !== '' ? { emailHash: payload['emailHash'] as string } : {}),
            },
            select: { id: true },
          });
          inboundEventId = inboundEvent.id;
        } else {
          await db.ticketEvent.create({
            data: {
              ticketId: ctx.ticketId,
              eventType: 'SYSTEM_NOTE',
              content: `Ticket created via ${source.toLowerCase()} ingestion.\n\n${ctx.summary || description.slice(0, 500)}`,
              metadata: { source, ...metadata },
              actor: `system:ingestion:${source.toLowerCase()}`,
            },
          });
        }

        // Link DevOpsSyncState to the newly created ticket (if this came from the DevOps ingestion path)
        const syncStateId = payloadStr(payload, 'syncStateId');
        if (syncStateId && source === TicketSource.AZURE_DEVOPS) {
          try {
            await db.devOpsSyncState.update({
              where: { id: syncStateId },
              data: { ticketId: ctx.ticketId },
            });
            logger.info({ syncStateId, ticketId: ctx.ticketId }, 'Linked DevOpsSyncState to ingested ticket');
          } catch (linkErr) {
            logger.warn({ linkErr, syncStateId, ticketId: ctx.ticketId }, 'Failed to link DevOpsSyncState — non-fatal');
          }
        }

        // Save raw probe result artifact when available, then stash the artifact ID
        // in ticket.metadata so the analyzer can reference it without re-fetching.
        const toolResult = payloadStr(payload, 'toolResult');
        const probeName = payloadStr(payload, 'probeName');
        const toolName = payloadStr(payload, 'toolName');
        if (toolResult && probeName && deps.artifactStoragePath) {
          const probeArtifactId = await saveProbeArtifact(db, ctx.ticketId, probeName, toolName, toolResult, deps.artifactStoragePath);
          if (probeArtifactId) {
            try {
              // Patch ticket.metadata to include the probe artifact ID so the analyzer
              // can build a full-content or preview-with-ref context without re-querying.
              // Use the in-scope `metadata` object (built above during ticket creation) to
              // avoid a round-trip `findUnique`. Guard against any non-object value in case
              // the DB column was written externally with a non-object JSON value.
              const safeMeta: Record<string, unknown> =
                typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
                  ? (metadata as Record<string, unknown>)
                  : {};
              await db.ticket.update({
                where: { id: ctx.ticketId },
                data: { metadata: { ...safeMeta, probeArtifactId } as Prisma.InputJsonValue },
              });
              logger.info({ ticketId: ctx.ticketId, probeArtifactId }, 'Probe artifact ID stored in ticket metadata');
            } catch (metaErr) {
              logger.warn({ metaErr, ticketId: ctx.ticketId }, 'Failed to store probe artifact ID in ticket metadata — continuing');
            }
          }
        }

        // Save email attachments when present in the payload (EMAIL source only).
        // We reuse the inboundEventId captured from the create() above instead of
        // re-querying ticketEvent for the row we just inserted.
        if (source === TicketSource.EMAIL && deps.artifactStoragePath) {
          const rawAttachments = payload['attachments'];
          if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
            const subject = payloadStr(payload, 'subject');
            const personId = typeof payload['personId'] === 'string' ? payload['personId'] : null;
            for (const att of rawAttachments) {
              if (
                typeof att !== 'object' || att === null ||
                typeof att['filename'] !== 'string' ||
                typeof att['content'] !== 'string'
              ) continue;
              await saveEmailAttachmentArtifact(
                db,
                ctx.ticketId,
                att as { filename: string; contentType: string; size: number; content: string },
                subject,
                personId,
                inboundEventId,
                deps.artifactStoragePath,
              );
            }
          }
        }

        const stepDuration = Date.now() - stepStart;
        deps.appLog?.info(
          `Ticket created: ${ctx.ticketId} (${source}, ${ctx.category}/${ctx.priority}) (${(stepDuration / 1000).toFixed(1)}s)`,
          { ticketId: ctx.ticketId, source, clientId, category: ctx.category, priority: ctx.priority, durationMs: stepDuration, taskRun: currentRun },
          ctx.ticketId,
          'ticket',
        );
        await safeTracker.completeStep(stepId, `Ticket created: ${ctx.ticketId}`);
        stepsSucceeded++;
        break;
      }

      // ── ADD_FOLLOWER ────────────────────────────────────────────────
      case RouteStepType.ADD_FOLLOWER: {
        if (!ctx.ticketId) {
          logger.warn({ clientId }, 'ADD_FOLLOWER skipped — no ticket created yet');
          await safeTracker.skipStep(stepId, 'No ticket created yet');
          stepsSkipped++;
          break;
        }
        try {
          const config = (step.config ?? {}) as Record<string, unknown>;
          const email = typeof config['email'] === 'string' ? config['email'] : '';
          const emailDomain = typeof config['emailDomain'] === 'string' ? config['emailDomain'] : '';
          const followerType = config['followerType'] === 'REQUESTER' ? 'REQUESTER' : 'FOLLOWER';

          let addedCount = 0;
          if (email) {
            const person = await db.person.findFirst({
              where: {
                email: { equals: email, mode: 'insensitive' },
                clientUsers: { some: { clientId } },
              },
              select: { id: true },
            });
            if (person) {
              await db.ticketFollower.create({
                data: { ticketId: ctx.ticketId, personId: person.id, followerType },
              }).catch((err) => {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
                throw err;
              });
              addedCount = 1;
            }
          } else if (emailDomain) {
            const people = await db.person.findMany({
              where: {
                email: { endsWith: `@${emailDomain}`, mode: 'insensitive' },
                clientUsers: { some: { clientId } },
              },
              select: { id: true },
            });
            if (people.length > 0) {
              await db.ticketFollower.createMany({
                data: people.map(p => ({ ticketId: ctx.ticketId!, personId: p.id, followerType })),
                skipDuplicates: true,
              });
              addedCount = people.length;
            }
          }
          const stepDuration = Date.now() - stepStart;
          deps.appLog?.info(
            `Added ${addedCount} follower(s) (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId: ctx.ticketId, addedCount, durationMs: stepDuration, clientId, taskRun: currentRun },
            ctx.ticketId ?? clientId,
            'ticket',
          );
          await safeTracker.completeStep(stepId, `Added ${addedCount} follower(s)`);
          stepsSucceeded++;
        } catch (err) {
          logger.warn({ err, clientId, stepType: step.stepType, ticketId: ctx.ticketId }, 'Ingestion step failed — skipping follower');
          stepErrors.push({ step: RouteStepType.ADD_FOLLOWER, error: err instanceof Error ? err.message : String(err), fallback: 'skipped' });
          await safeTracker.failStep(stepId, err instanceof Error ? err.message : String(err));
          stepsFailed++;
        }
        break;
      }

      // ── DRAFT_RECEIPT ───────────────────────────────────────────────
      case RouteStepType.DRAFT_RECEIPT: {
        if (ctx.threadResolution?.isReply) {
          await safeTracker.skipStep(stepId, 'Skipped for reply — no receipt needed');
          stepsSkipped++;
          break;
        }
        if (!ctx.ticketId) {
          logger.warn({ clientId }, 'DRAFT_RECEIPT skipped — no ticket created yet');
          await safeTracker.skipStep(stepId, 'No ticket created yet');
          stepsSkipped++;
          break;
        }
        const emailFrom = payloadStr(payload, 'from');
        if (!emailFrom) {
          logger.info({ clientId }, 'Skipping DRAFT_RECEIPT — no email sender in payload');
          await safeTracker.skipStep(stepId, 'No email sender in payload');
          stepsSkipped++;
          break;
        }
        try {
          // Resolve recipient name
          const fromName = payloadStr(payload, 'fromName');
          let recipientName = fromName;
          if (!recipientName) {
            const person = await db.person.findFirst({
              where: {
                email: { equals: emailFrom, mode: 'insensitive' },
                clientUsers: { some: { clientId } },
              },
              select: { name: true },
            });
            recipientName = person?.name || emailFrom.split('@')[0] || 'there';
          }
          const subject = ctx.title || payloadStr(payload, 'subject');
          const promptKey = step.promptKeyOverride ?? 'imap.draft-receipt.system';
          const taskType = (step.taskTypeOverride ?? TaskType.DRAFT_EMAIL) as string;
          const draftRes = await withTimeout(
            (signal) => ai.generate({
              taskType: taskType as typeof TaskType.DRAFT_EMAIL,
              context: { ticketId: ctx.ticketId, clientId, taskRun: currentRun },
              prompt: [
                'Draft a short, professional email confirming receipt of a support request.',
                `Recipient name: ${recipientName}`,
                `Sender name (sign as): ${senderSignature}`,
                `Ticket ID: ${ctx.ticketId}`,
                `Subject: ${subject}`,
                '', 'Issue summary:', ctx.summary, '',
                `Category: ${ctx.category}`, `Priority: ${ctx.priority}`, '',
                'The email should:',
                '- Acknowledge the request',
                '- Show awareness of the core issue',
                '- Set expectations for next steps',
                '- Be warm but concise (3-5 short paragraphs)',
              ].join('\n'),
              promptKey,
              signal,
            }),
            AI_STEP_TIMEOUT_MS,
            'DRAFT_RECEIPT',
          );

          if (!mailer) {
            logger.warn({ ticketId: ctx.ticketId }, 'Skipping receipt email — SMTP not configured');
            await safeTracker.completeStep(stepId, 'Skipped — SMTP not configured');
            stepsSkipped++;
          } else {
            try {
              const replySubject = /^re:\s*/i.test(subject) ? subject : `Re: ${subject}`;
              const origMessageId = payloadStr(payload, 'messageId');
              const origReferences = payload['references'];
              const replyOpts: ReplyOptions = {
                to: emailFrom,
                subject: replySubject,
                body: draftRes.content,
                ...(origMessageId && { inReplyTo: origMessageId }),
                ...(Array.isArray(origReferences) && { references: origReferences as string[] }),
              };
              const messageId = await mailer.sendReply(replyOpts);
              await db.ticketEvent.create({
                data: {
                  ticketId: ctx.ticketId,
                  eventType: 'EMAIL_OUTBOUND',
                  content: draftRes.content,
                  metadata: { type: 'receipt', to: emailFrom, outboundMessageId: messageId },
                  actor: 'system:ingestion',
                },
              });
              const stepDuration = Date.now() - stepStart;
              deps.appLog?.info(
                `Receipt email sent to ${emailFrom} via ${draftRes.provider}/${draftRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
                { ticketId: ctx.ticketId, to: emailFrom, provider: draftRes.provider, model: draftRes.model, durationMs: stepDuration, taskRun: currentRun },
                ctx.ticketId!,
                'ticket',
              );
              await safeTracker.completeStep(stepId, `Receipt sent to ${emailFrom}`);
              stepsSucceeded++;
            } catch (sendErr) {
              logger.warn({ err: sendErr, ticketId: ctx.ticketId }, 'Failed to send receipt email');
              stepErrors.push({ step: RouteStepType.DRAFT_RECEIPT, error: sendErr instanceof Error ? sendErr.message : String(sendErr), fallback: 'email send failed' });
              await safeTracker.failStep(stepId, sendErr instanceof Error ? sendErr.message : String(sendErr));
              stepsFailed++;
            }
          }
        } catch (err) {
          logger.warn({ err, clientId, stepType: step.stepType, ticketId: ctx.ticketId }, 'Ingestion step failed — skipping receipt draft');
          stepErrors.push({ step: RouteStepType.DRAFT_RECEIPT, error: err instanceof Error ? err.message : String(err), fallback: 'skipped' });
          await safeTracker.failStep(stepId, err instanceof Error ? err.message : String(err));
          stepsFailed++;
        }
        break;
      }

      default:
        logger.warn({ stepType: step.stepType, clientId }, `Unknown ingestion step type: ${step.stepType} — skipping`);
        await safeTracker.skipStep(stepId, `Unknown step type: ${step.stepType}`);
        stepsSkipped++;
        break;
    }
  }

  // Pipeline summary log
  const pipelineDuration = Date.now() - pipelineStart;
  const totalSteps = stepsSucceeded + stepsFailed + stepsSkipped;
  if (ctx.ticketId) {
    deps.appLog?.info(
      `Ingestion pipeline completed: ${totalSteps} steps, ${stepsSucceeded} succeeded, ${stepsFailed} failed${stepsFailed > 0 ? ' (fallback used)' : ''}, ${stepsSkipped} skipped, total ${(pipelineDuration / 1000).toFixed(1)}s`,
      { ticketId: ctx.ticketId, clientId, stepsSucceeded, stepsFailed, stepsSkipped, totalSteps, durationMs: pipelineDuration, routeId: route!.id },
      ctx.ticketId,
      'ticket',
    );
  } else {
    deps.appLog?.info(
      `Ingestion pipeline completed: ${totalSteps} steps, ${stepsSucceeded} succeeded, ${stepsFailed} failed${stepsFailed > 0 ? ' (fallback used)' : ''}, ${stepsSkipped} skipped, total ${(pipelineDuration / 1000).toFixed(1)}s`,
      { clientId, stepsSucceeded, stepsFailed, stepsSkipped, totalSteps, durationMs: pipelineDuration, routeId: route!.id },
    );
  }

  // Record any step errors as a ticket event so the operator can see them
  if (ctx.ticketId && stepErrors.length > 0) {
    try {
      const metadataErrors = stepErrors.map(({ step, error, fallback }) => ({ step, error, fallback }));
      await db.ticketEvent.create({
        data: {
          ticketId: ctx.ticketId,
          eventType: 'SYSTEM_NOTE',
          content: `Ingestion pipeline completed with ${stepErrors.length} step error(s):\n${stepErrors.map(e => `- ${e.step}: ${e.error} (fallback: ${e.fallback})`).join('\n')}`,
          metadata: { type: 'ingestion-errors', errors: metadataErrors } as Prisma.InputJsonValue,
          actor: 'system:ingestion',
        },
      });
    } catch (err) {
      logger.warn({ err, ticketId: ctx.ticketId }, 'Failed to record step errors as ticket event');
    }
  }
}

// ---------------------------------------------------------------------------
// Re-analysis detection — checks conditions and enqueues a re-analysis job
// (ported from imap-worker/processor.ts)
// ---------------------------------------------------------------------------

async function maybeEnqueueReanalysis(
  db: PrismaClient,
  analysisQueue: Queue<AnalysisJob>,
  ticketId: string,
  senderAddress: string,
  smtpFrom: string,
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<void> {
  // 1. Load ticket to check status
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { status: true, clientId: true },
  });
  if (!ticket) return;

  // Only re-analyze tickets in an open/active status (NEW, OPEN, IN_PROGRESS, WAITING).
  // NOTE: NEW passes this check but is effectively excluded by step 2 below — a NEW
  // ticket has no completed analysis (no findings email), so re-analysis is skipped there.
  if (!isOpenStatus(ticket.status)) {
    log.info({ ticketId, status: ticket.status }, 'Reply on closed ticket — re-analysis skipped');
    return;
  }

  // 2. Check the ticket has had a completed analysis (findings email was sent to requester).
  // NEW tickets are intentionally excluded here: the initial analyzer pipeline hasn't finished yet,
  // so there's nothing to "re-" analyze. The reply is already threaded onto the ticket and will
  // be picked up when the initial job reads the thread.
  const findingsEmail = await db.ticketEvent.findFirst({
    where: {
      ticketId,
      eventType: 'EMAIL_OUTBOUND',
      OR: [
        { metadata: { path: ['type'], equals: 'analysis_findings' } },
        { metadata: { path: ['type'], equals: 'reanalysis_findings' } },
      ],
    },
  });
  if (!findingsEmail) {
    log.info({ ticketId }, 'Ticket has no completed analysis (no findings email sent) — re-analysis skipped');
    return;
  }

  // 3. Prevent loops — check sender is not the system's own outbound email
  const normalizedSender = senderAddress.trim().toLowerCase();

  // Check against IMAP integration inboxes for this client
  if (ticket.clientId) {
    const imapIntegrations = await db.clientIntegration.findMany({
      where: { clientId: ticket.clientId, type: 'IMAP', isActive: true },
      select: { config: true },
    });
    const isOwnInbox = imapIntegrations.some((integ) => {
      const cfg = integ.config as Record<string, unknown>;
      const user = typeof cfg['user'] === 'string' ? cfg['user'].trim().toLowerCase() : '';
      return user === normalizedSender;
    });
    if (isOwnInbox) {
      log.info({ ticketId, from: senderAddress }, 'Reply from own IMAP inbox — re-analysis skipped (loop prevention)');
      return;
    }
  }

  // Check against the configured SMTP sender address
  if (normalizedSender === smtpFrom.trim().toLowerCase()) {
    log.info({ ticketId, from: senderAddress }, 'Reply from system outbound address — re-analysis skipped (loop prevention)');
    return;
  }

  // 4. Dedupe: scan for any in-flight re-analysis jobs for this ticket.
  //
  // #375: previously this path used a deterministic `reanalysis-<ticketId>` ID
  // and removed the old Job if it was in a terminal state. That worked in
  // practice because `removeOnComplete` wasn't set and completed jobs stayed
  // in Redis, but it made the call order fragile: if BullMQ had already been
  // asked to add the same ID elsewhere, the add() would silently dedupe.
  // Switching to a timestamped ID removes that failure mode outright; we
  // still skip enqueue if an active/waiting/delayed re-analysis exists so
  // rapid-fire replies don't queue up redundant work.
  const activeStates = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);
  const inflight = await analysisQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);
  const inflightMatch = inflight.find((j) => {
    if (!j.id) return false;
    return j.id.startsWith(`reanalysis-${ticketId}-`) || j.id === `reanalysis-${ticketId}`;
  });
  if (inflightMatch) {
    const state = await inflightMatch.getState();
    if (activeStates.has(state)) {
      log.info(
        { ticketId, jobId: inflightMatch.id, state },
        'Re-analysis job already pending for this ticket — skipping',
      );
      return;
    }
  }

  // 5. Find the trigger event (most recent EMAIL_INBOUND for this ticket)
  const triggerEvent = await db.ticketEvent.findFirst({
    where: { ticketId, eventType: 'EMAIL_INBOUND' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  // 5b. Author gate — skip if the most recent reply-type event (EMAIL_INBOUND or COMMENT)
  // is system-authored. This prevents a spurious UPDATE_ANALYSIS when the analyzer's own
  // auto-posted findings comment (actor: 'system:recommendation-executor' or the bare
  // Prisma default 'system') is the last event on the ticket and the re-analysis would
  // only "echo back" that comment (#384).
  //
  // EMAIL_INBOUND events created by RESOLVE_THREAD use actor `email:<address>` — never
  // system-prefixed — so this check only skips when no real inbound exists and the most
  // recent COMMENT is from the system itself.
  if (!triggerEvent) {
    const latestReplyEvent = await db.ticketEvent.findFirst({
      where: { ticketId, eventType: { in: ['EMAIL_INBOUND', 'COMMENT'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, actor: true },
    });
    if (latestReplyEvent?.actor === 'system' || latestReplyEvent?.actor?.startsWith('system:')) {
      log.info(
        { ticketId, actor: latestReplyEvent.actor, eventId: latestReplyEvent.id },
        'Most recent reply event is system-authored — skipping UPDATE_ANALYSIS enqueue (#384)',
      );
      return;
    }
  }

  // All conditions met — enqueue re-analysis with a unique, timestamped ID
  // so BullMQ cannot silently collapse this into a previously completed job.
  const reanalysisJobId = `reanalysis-${ticketId}-${Date.now()}`;
  await analysisQueue.add('analyze-ticket', {
    ticketId,
    clientId: ticket.clientId ?? undefined,
    reanalysis: true,
    triggerEventId: triggerEvent?.id,
  }, {
    jobId: reanalysisJobId,
    attempts: 4,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600, count: 1000 },
  });

  log.info({ ticketId, jobId: reanalysisJobId, triggerEventId: triggerEvent?.id }, 'Enqueued re-analysis for reply on analyzed ticket');
}

// ---------------------------------------------------------------------------
// Probe artifact storage (mirrors saveRawResultArtifact in probe-worker)
// ---------------------------------------------------------------------------

/**
 * Sanitize a string to be safe for use as a filename component.
 * Only allows alphanumerics, dots, hyphens, and underscores; replaces all
 * other characters (including path separators) with underscores and trims
 * to 64 characters to prevent path traversal or excessively long filenames.
 */
function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/**
 * Save the raw probe tool result as a file artifact and return the artifact ID.
 * Returns null on any error so callers can always proceed without blocking ticket creation.
 */
async function saveProbeArtifact(
  db: PrismaClient,
  ticketId: string,
  probeName: string,
  toolName: string,
  rawResult: string,
  storagePath: string,
): Promise<string | null> {
  try {
    let isJson = false;
    try { JSON.parse(rawResult); isJson = true; } catch { /* not JSON */ }
    const mimeType = isJson ? 'application/json' : 'text/plain';
    const ext = isJson ? 'json' : 'txt';
    const safeToolName = sanitizeFilenameSegment(toolName || 'unknown');
    const filename = `probe-${safeToolName}-${Date.now()}.${ext}`;
    const resolvedStorage = resolve(storagePath);
    const ticketDir = resolve(resolvedStorage, 'tickets', ticketId);
    // Guard: ensure the resolved path stays within storagePath to prevent traversal.
    // Use path.relative() rather than startsWith() so the check is correct on all
    // platforms (Windows uses backslash separators) and when resolvedStorage is '/'.
    const rel = relative(resolvedStorage, ticketDir);
    if (rel.startsWith('..') || rel === '') {
      logger.warn({ ticketId, ticketDir, resolvedStorage }, 'Probe artifact path escaped storage root — skipping');
      return null;
    }
    const fullPath = join(ticketDir, filename);
    await mkdir(ticketDir, { recursive: true });
    await writeFile(fullPath, rawResult, 'utf-8');
    const relativePath = `tickets/${ticketId}/${filename}`;
    const artifact = await db.artifact.create({
      data: {
        ticketId,
        filename,
        mimeType,
        sizeBytes: Buffer.byteLength(rawResult, 'utf-8'),
        storagePath: relativePath,
        description: `Raw MCP tool output from probe "${probeName}" (${toolName})`,
        kind: 'PROBE_RESULT',
        displayName: `Probe: ${probeName}`,
        source: `probe:${toolName}`,
        addedBySystem: 'probe-worker',
        addedByPersonId: null,
      },
      select: { id: true },
    });
    logger.info({ ticketId, filename, artifactId: artifact.id }, 'Probe artifact saved via ingestion engine');
    // Phase 2: best-effort enqueue Haiku friendly-name generation. No-op if queue not registered.
    void enqueueArtifactNameGeneration(artifact.id).catch((err) => {
      logger.warn({ err, ticketId, artifactId: artifact.id }, 'Failed to enqueue artifact friendly-name generation — continuing');
    });
    return artifact.id;
  } catch (err) {
    logger.warn({ err, ticketId }, 'Failed to save probe artifact — continuing');
    return null;
  }
}

async function saveEmailAttachmentArtifact(
  db: PrismaClient,
  ticketId: string,
  att: { filename: string; contentType: string; size: number; content: string },
  emailSubject: string,
  personId: string | null,
  originatingEventId: string | null,
  storagePath: string,
): Promise<void> {
  try {
    const safeFilename = sanitizeFilenameSegment(att.filename || 'attachment');
    // Append a randomUUID() segment so two attachments saved in the same millisecond
    // (same ticket, multiple parts) cannot collide on disk. Matches saveMcpToolArtifact.
    const filename = `email-${Date.now()}-${randomUUID()}-${safeFilename}`;
    const resolvedStorage = resolve(storagePath);
    const ticketDir = resolve(resolvedStorage, 'tickets', ticketId);
    const rel = relative(resolvedStorage, ticketDir);
    if (rel.startsWith('..') || rel === '') {
      logger.warn({ ticketId, ticketDir, resolvedStorage }, 'Email attachment path escaped storage root — skipping');
      return;
    }
    const fullPath = join(ticketDir, filename);
    await mkdir(ticketDir, { recursive: true });
    const contentBuffer = Buffer.from(att.content, 'base64');
    await writeFile(fullPath, contentBuffer);
    const relativePath = `tickets/${ticketId}/${filename}`;
    const sourceTag = `email:${emailSubject.slice(0, 80)}`;
    await db.artifact.create({
      data: {
        ticketId,
        filename: att.filename || 'attachment',
        mimeType: att.contentType || 'application/octet-stream',
        sizeBytes: contentBuffer.length,
        storagePath: relativePath,
        description: null,
        kind: 'EMAIL_ATTACHMENT',
        displayName: att.filename || 'attachment',
        source: sourceTag,
        addedByPersonId: personId,
        addedBySystem: 'imap-worker',
        originatingEventId: originatingEventId,
        originatingEventType: originatingEventId ? 'ticket_event' : null,
      },
    });
    logger.info({ ticketId, filename: att.filename }, 'Email attachment artifact saved');
  } catch (err) {
    logger.warn({ err, ticketId, filename: att.filename }, 'Failed to save email attachment artifact — continuing');
  }
}

// ---------------------------------------------------------------------------
// Public: create the BullMQ processor
// ---------------------------------------------------------------------------

export function createIngestionProcessor(deps: IngestionDeps) {
  return async function processIngestion(job: Job<IngestionJob>): Promise<void> {
    const { source, clientId, payload } = job.data;
    const jobId = job.id ?? `unknown-${Date.now()}`;

    logger.info({ source, clientId, jobId }, 'Processing ingestion job');

    // Verify client exists
    const client = await deps.db.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!client) {
      logger.error({ clientId }, 'Ingestion job references non-existent client — dropping');
      return;
    }

    // Resolve ingestion route — fall back to a synthetic default matching the architecture flowchart
    let route = await resolveIngestionRoute(deps.db, source as TicketSource, clientId);
    if (!route) {
      logger.info({ source, clientId }, 'No ingestion route found — using default flowchart pipeline');
      const isEmail = source === TicketSource.EMAIL;
      const defaultSteps = [
        ...(isEmail ? [{ id: 'default-resolve-thread', stepOrder: 1, name: 'Resolve Thread', stepType: RouteStepType.RESOLVE_THREAD, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true }] : []),
        { id: 'default-summarize', stepOrder: isEmail ? 2 : 1, name: 'Summarize', stepType: RouteStepType.SUMMARIZE_EMAIL, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 'default-categorize', stepOrder: isEmail ? 3 : 2, name: 'Categorize', stepType: RouteStepType.CATEGORIZE, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 'default-triage', stepOrder: isEmail ? 4 : 3, name: 'Triage Priority', stepType: RouteStepType.TRIAGE_PRIORITY, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 'default-title', stepOrder: isEmail ? 5 : 4, name: 'Generate Title', stepType: RouteStepType.GENERATE_TITLE, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 'default-create', stepOrder: isEmail ? 6 : 5, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        ...(isEmail ? [{ id: 'default-receipt', stepOrder: 7, name: 'Draft Receipt', stepType: RouteStepType.DRAFT_RECEIPT, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true }] : []),
      ];
      route = {
        id: null,
        name: `Default ${isEmail ? 'Email' : source} Ingestion (fallback)`,
        description: 'Built-in default ingestion pipeline — configure a route in the control panel to customize.',
        routeType: 'INGESTION',
        source: source as string,
        clientId: null,
        category: null,
        isActive: true,
        isDefault: true,
        sortOrder: 9999,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: defaultSteps,
      } as unknown as NonNullable<typeof route>;
    }

    // Create the run tracker — fall back to a no-op tracker if the ingestion_runs
    // tables aren't present yet (deploy ordering) or the DB insert fails, so
    // ingestion can proceed without observability.
    let tracker: IngestionRunTracker;
    try {
      tracker = await createIngestionRunTracker(
        deps.db,
        jobId,
        source as TicketSource,
        clientId,
        route.id,
        route.name,
      );
    } catch (err) {
      logger.warn({ err, jobId, clientId, source }, 'Failed to create ingestion run tracker — proceeding with no-op tracker');
      tracker = noopTracker;
    }

    // Build initial context from payload
    // Resolve initial priority: DevOps payloads use a numeric priority (1-4), others use string.
    let initialPriority = 'MEDIUM';
    if (typeof payload['priority'] === 'number') {
      // DevOps numeric mapping: 1=CRITICAL, 2=HIGH, 3=MEDIUM, 4=LOW
      const numMap: Record<number, string> = { 1: 'CRITICAL', 2: 'HIGH', 3: 'MEDIUM', 4: 'LOW' };
      initialPriority = numMap[payload['priority'] as number] ?? 'MEDIUM';
    } else if (typeof payload['priority'] === 'string') {
      const valid = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      initialPriority = valid.includes(payload['priority'].toUpperCase()) ? payload['priority'].toUpperCase() : 'MEDIUM';
    }

    const ctx: IngestionContext = {
      source: source as TicketSource,
      clientId,
      payload,
      title: payloadStr(payload, 'subject') || payloadStr(payload, 'title') || '',
      description: (payloadStr(payload, 'body') || payloadStr(payload, 'text') || payloadStr(payload, 'toolResult') || payloadStr(payload, 'description')).slice(0, 2000),
      summary: '',
      category: isValidCategory(payload['category']) ? (payload['category'] as string) : 'GENERAL',
      priority: initialPriority,
      ticketId: null,
      requesterId: null,
      threadResolution: null,
    };

    let pipelineError: unknown = undefined;
    try {
      // Execute the ingestion pipeline
      await executeIngestionPipeline(deps, route, ctx, tracker);

      // If a new ticket was created (not a reply threaded to existing), enqueue for analysis dispatch
      const isReply = ctx.threadResolution?.isReply === true;
      if (ctx.ticketId && !isReply) {
        await deps.ticketCreatedQueue.add('ticket-created', {
          ticketId: ctx.ticketId,
          clientId,
          source: source as TicketSource,
          category: ctx.category as TicketCreatedJob['category'],
        }, {
          jobId: `ticket-created-${ctx.ticketId}`,
          attempts: 4,
          backoff: { type: 'exponential', delay: 30_000 },
        });
        logger.info({ ticketId: ctx.ticketId, source, clientId }, 'Ingestion complete — enqueued ticket-created for analysis dispatch');
      } else if (isReply) {
        logger.info({ ticketId: ctx.ticketId, source, clientId }, 'Ingestion complete — reply threaded to existing ticket (re-analysis handled by RESOLVE_THREAD)');
      } else {
        logger.info({ source, clientId, routeId: route.id }, 'Ingestion pipeline completed without creating a ticket (no CREATE_TICKET step)');
      }
    } catch (err) {
      pipelineError = err;
      throw err;
    } finally {
      // Complete the run tracking in a finally block so a tracker DB failure never causes
      // the pipeline to appear failed or triggers a BullMQ retry that could duplicate tickets.
      const runStatus = pipelineError ? 'error' : 'success';
      const runError = pipelineError instanceof Error ? pipelineError.message : pipelineError != null ? String(pipelineError) : undefined;
      await tracker.completeRun(runStatus, ctx.ticketId ?? undefined, runError).catch((trackErr) => {
        logger.warn({ trackErr }, 'Failed to record ingestion run completion — tracking only, pipeline result unaffected');
      });
    }
  };
}
