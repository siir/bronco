import type { PrismaClient } from '@bronco/db';
import { TaskType, AttentionLevel } from '@bronco/shared-types';
import type { AIRouter } from '@bronco/ai-provider';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('log-summarizer');

const VALID_ATTENTION_LEVELS = new Set<string>(Object.values(AttentionLevel));

/**
 * Parse the AI response which is now expected to be JSON:
 * {"summary": "...", "attentionLevel": "NONE|LOW|MEDIUM|HIGH"}
 *
 * Falls back to treating the whole response as a plain-text summary with
 * attentionLevel=NONE if parsing fails (backwards-compatible with older prompts).
 */
function parseAiResponse(raw: string): { summary: string; attentionLevel: AttentionLevel } {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : trimmed;
    const level = typeof parsed.attentionLevel === 'string' ? parsed.attentionLevel.trim().toUpperCase() : 'NONE';
    return {
      summary,
      attentionLevel: (VALID_ATTENTION_LEVELS.has(level) ? level : 'NONE') as AttentionLevel,
    };
  } catch {
    // LLM didn't return valid JSON — use the raw text as the summary
    return { summary: trimmed, attentionLevel: 'NONE' };
  }
}

/** How many log lines to send to Ollama per batch (keeps prompt size reasonable). */
const MAX_LOGS_PER_BATCH = 200;

/** Non-ticket logs are batched into 30-minute windows. */
const WINDOW_MS = 30 * 60 * 1000;

/**
 * Services that process individual tickets / would-be tickets.
 * Logs from these services without a ticketId are "orphaned" — they indicate
 * a ticket processing attempt that never produced (or linked to) a ticket.
 */
const TICKET_PROCESSING_SERVICES = [
  'email-processor',
  'ticket-analyzer',
  'azdo-processor',
  'azdo-workflow',
  'issue-resolver',
] as const;

/**
 * Known infrastructure / service-level services.
 * Logs from these services without a ticketId are normal background activity.
 */
const INFRASTRUCTURE_SERVICES = [
  'copilot-api',
  'imap-worker',
  'devops-worker',
  'log-summarizer',
] as const;

/** All known services — used to identify uncategorized logs from unknown services. */
const ALL_KNOWN_SERVICES = [
  ...TICKET_PROCESSING_SERVICES,
  ...INFRASTRUCTURE_SERVICES,
] as const;

interface SummarizeResult {
  created: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDigest(logs: Array<{ createdAt: Date; level: string; service: string; message: string; error: string | null }>): string {
  return logs
    .map((l) => {
      const ts = l.createdAt.toISOString().slice(11, 19); // HH:MM:SS
      const err = l.error ? ` [ERROR: ${l.error.slice(0, 100)}]` : '';
      return `[${ts}] ${l.level} ${l.service}: ${l.message.slice(0, 200)}${err}`;
    })
    .join('\n');
}

function uniqueServices(logs: Array<{ service: string }>): string[] {
  return [...new Set(logs.map((l) => l.service))];
}

// ---------------------------------------------------------------------------
// TICKET summaries — per-ticket, updated as new logs arrive
// ---------------------------------------------------------------------------

/**
 * Summarize logs for a specific ticket.
 *
 * Fetches all unsummarized logs (since the last summary's windowEnd, or all time),
 * sends them to Ollama, and persists a LogSummary record with summaryType=TICKET.
 */
export async function summarizeTicketLogs(
  db: PrismaClient,
  ai: AIRouter,
  ticketId: string,
): Promise<SummarizeResult> {
  const lastSummary = await db.logSummary.findFirst({
    where: { ticketId, summaryType: 'TICKET' },
    orderBy: { windowEnd: 'desc' },
    select: { windowEnd: true, cursorLogIds: true },
  });

  const since = lastSummary?.windowEnd ?? new Date(0);
  const excludeIds = lastSummary?.cursorLogIds ?? [];

  const logs = await db.appLog.findMany({
    where: {
      entityId: ticketId,
      entityType: 'ticket',
      createdAt: { gte: since },
      ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_LOGS_PER_BATCH,
  });

  if (logs.length === 0) {
    return { created: 0, skipped: 0 };
  }

  const windowStart = logs[0].createdAt;
  const windowEnd = logs[logs.length - 1].createdAt;

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { subject: true, status: true, clientId: true },
  });

  const prompt = [
    `Ticket: ${ticket?.subject ?? 'Unknown'} (status: ${ticket?.status ?? 'Unknown'})`,
    `Time range: ${windowStart.toISOString()} to ${windowEnd.toISOString()}`,
    `Log count: ${logs.length}`,
    '',
    'Application logs:',
    buildDigest(logs),
  ].join('\n');

  const response = await ai.generate({
    taskType: TaskType.SUMMARIZE_LOGS,
    prompt,
    promptKey: 'logs.summarize-ticket.system',
    context: { entityId: ticketId, entityType: 'ticket', clientId: ticket?.clientId },
  });

  const { summary, attentionLevel } = parseAiResponse(response.content);

  // Store IDs of logs at the windowEnd boundary so the next pass can exclude
  // them when using gte (prevents re-summarizing logs at the exact boundary).
  const boundaryLogIds = logs
    .filter((l) => l.createdAt.getTime() === windowEnd.getTime())
    .map((l) => l.id);

  await db.logSummary.create({
    data: {
      ticketId,
      summaryType: 'TICKET',
      attentionLevel,
      windowStart,
      windowEnd,
      summary,
      logCount: logs.length,
      services: uniqueServices(logs),
      cursorLogIds: boundaryLogIds,
    },
  });

  logger.info({ ticketId, logCount: logs.length }, 'Created ticket log summary');
  return { created: 1, skipped: 0 };
}

// ---------------------------------------------------------------------------
// ORPHAN summaries — failed/abandoned ticket processing attempts
// ---------------------------------------------------------------------------

/**
 * Summarize orphan logs: logs from ticket-processing services that were never
 * linked to a ticket. Grouped by 30-minute windows. Loops over multiple 24-hour
 * chunks to avoid losing tail logs when the backlog is large.
 */
export async function summarizeOrphanLogs(
  db: PrismaClient,
  ai: AIRouter,
): Promise<SummarizeResult> {
  return summarizeChunkedWindowedLogs(db, ai, {
    summaryType: 'ORPHAN',
    serviceFilter: { in: [...TICKET_PROCESSING_SERVICES] },
    promptKey: 'logs.summarize-orphan.system',
  });
}

// ---------------------------------------------------------------------------
// SERVICE summaries — background infrastructure activity
// ---------------------------------------------------------------------------

/**
 * Summarize service logs: logs from infrastructure/service services that are
 * not linked to any ticket. Grouped by 30-minute windows. Loops over multiple
 * 24-hour chunks to avoid losing tail logs when the backlog is large.
 */
export async function summarizeServiceLogs(
  db: PrismaClient,
  ai: AIRouter,
): Promise<SummarizeResult> {
  return summarizeChunkedWindowedLogs(db, ai, {
    summaryType: 'SERVICE',
    serviceFilter: { in: [...INFRASTRUCTURE_SERVICES] },
    promptKey: 'logs.summarize-service.system',
  });
}

// ---------------------------------------------------------------------------
// UNCATEGORIZED summaries — catch-all for anything that slipped through
// ---------------------------------------------------------------------------

/**
 * Summarize uncategorized logs: any ticketId-null logs from services not in
 * the known ticket-processing or infrastructure lists. Loops over multiple
 * 24-hour chunks to avoid losing tail logs when the backlog is large.
 */
export async function summarizeUncategorizedLogs(
  db: PrismaClient,
  ai: AIRouter,
): Promise<SummarizeResult> {
  return summarizeChunkedWindowedLogs(db, ai, {
    summaryType: 'UNCATEGORIZED',
    serviceFilter: { notIn: [...ALL_KNOWN_SERVICES] },
    promptKey: 'logs.summarize-uncategorized.system',
  });
}

// ---------------------------------------------------------------------------
// Chunked fetch loop — processes backlogs over multiple 24h windows
// ---------------------------------------------------------------------------

/** Maximum time range per chunk to limit query size. */
const DAY_MS = 24 * 60 * 60 * 1000;

interface ChunkedOpts {
  summaryType: 'ORPHAN' | 'SERVICE' | 'UNCATEGORIZED';
  serviceFilter: { in: string[] } | { notIn: string[] };
  promptKey: string;
}

/**
 * Fetch and summarize non-ticket logs in 24-hour chunks, looping until the
 * backlog is fully processed up to the current window boundary.
 *
 * Previous implementation fetched a single capped batch across the entire
 * unsummarized range. When the take-limit truncated the result, the last
 * partial 30-minute window was dropped — and if the backlog spanned many days,
 * each cron pass only inched forward. By capping each fetch to a 24-hour chunk,
 * we keep the take-limit truncation rare and process the full backlog in one pass.
 */
async function summarizeChunkedWindowedLogs(
  db: PrismaClient,
  ai: AIRouter,
  opts: ChunkedOpts,
): Promise<SummarizeResult> {
  const { summaryType, serviceFilter, promptKey } = opts;
  const fetchLimit = MAX_LOGS_PER_BATCH * 3;

  const lastSummary = await db.logSummary.findFirst({
    where: { summaryType },
    orderBy: { windowEnd: 'desc' },
    select: { windowEnd: true },
  });

  let cursor = lastSummary?.windowEnd ?? new Date(0);
  const now = Date.now();
  const currentWindowStart = new Date(now - (now % WINDOW_MS));

  let totalCreated = 0;
  let totalSkipped = 0;

  while (cursor < currentWindowStart) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + DAY_MS, currentWindowStart.getTime()));

    const logs = await db.appLog.findMany({
      where: {
        entityId: null,
        service: serviceFilter as Record<string, string[]>,
        createdAt: { gte: cursor, lt: chunkEnd },
      },
      orderBy: { createdAt: 'asc' },
      take: fetchLimit,
    });

    if (logs.length === 0) {
      // No logs in this 24h chunk — skip ahead to the next one.
      cursor = chunkEnd;
      continue;
    }

    const result = await summarizeWindowedLogs(db, ai, logs, summaryType, promptKey, fetchLimit);
    totalCreated += result.created;
    totalSkipped += result.skipped;

    // Re-read cursor from DB — summarizeWindowedLogs created LogSummary records
    // whose windowEnd marks how far we progressed.
    const latestSummary = await db.logSummary.findFirst({
      where: { summaryType },
      orderBy: { windowEnd: 'desc' },
      select: { windowEnd: true },
    });
    const newCursor = latestSummary?.windowEnd ?? chunkEnd;

    // If cursor didn't advance (e.g. all windows were too small and skipped),
    // jump to the chunk boundary to avoid an infinite loop.
    if (newCursor.getTime() <= cursor.getTime()) {
      cursor = chunkEnd;
    } else {
      cursor = newCursor;
    }
  }

  return { created: totalCreated, skipped: totalSkipped };
}

// ---------------------------------------------------------------------------
// Shared windowed summarization logic
// ---------------------------------------------------------------------------

async function summarizeWindowedLogs(
  db: PrismaClient,
  ai: AIRouter,
  logs: Array<{ id: string; createdAt: Date; level: string; service: string; message: string; error: string | null }>,
  summaryType: 'ORPHAN' | 'SERVICE' | 'UNCATEGORIZED',
  promptKey: string,
  fetchLimit: number,
): Promise<SummarizeResult> {
  // Group logs into 30-minute windows
  const windows = new Map<number, typeof logs>();
  for (const log of logs) {
    const ts = log.createdAt.getTime();
    const windowKey = ts - (ts % WINDOW_MS);
    const bucket = windows.get(windowKey);
    if (bucket) {
      bucket.push(log);
    } else {
      windows.set(windowKey, [log]);
    }
  }

  // When the fetch was truncated by the take limit, the last window may only
  // contain a partial set of logs. Drop it so the cursor doesn't advance past
  // unseen logs — they'll be picked up on the next pass.
  if (logs.length >= fetchLimit && windows.size > 1) {
    const lastWindowKey = Math.max(...windows.keys());
    windows.delete(lastWindowKey);
  }

  let created = 0;
  let skipped = 0;

  for (const [windowKey, windowLogs] of windows) {
    const windowStart = new Date(windowKey);
    const windowEnd = new Date(windowKey + WINDOW_MS);

    // Skip windows with very few logs (just noise)
    if (windowLogs.length < 2) {
      skipped++;
      continue;
    }

    const digest = buildDigest(windowLogs.slice(0, MAX_LOGS_PER_BATCH));

    const prompt = [
      `Time window: ${windowStart.toISOString()} to ${windowEnd.toISOString()}`,
      `Log count: ${windowLogs.length}`,
      '',
      'Application logs:',
      digest,
    ].join('\n');

    try {
      const response = await ai.generate({
        taskType: TaskType.SUMMARIZE_LOGS,
        prompt,
        promptKey,
      });

      const { summary, attentionLevel } = parseAiResponse(response.content);

      await db.logSummary.create({
        data: {
          ticketId: null,
          summaryType,
          attentionLevel,
          windowStart,
          windowEnd,
          summary,
          logCount: windowLogs.length,
          services: uniqueServices(windowLogs),
        },
      });

      created++;
      logger.info({ summaryType, windowStart: windowStart.toISOString(), logCount: windowLogs.length }, `Created ${summaryType.toLowerCase()} log summary`);
    } catch (err) {
      logger.error({ err, summaryType, windowStart: windowStart.toISOString() }, `Failed to summarize ${summaryType.toLowerCase()} log window`);
    }
  }

  return { created, skipped };
}

// ---------------------------------------------------------------------------
// Full summarization pass
// ---------------------------------------------------------------------------

export interface FullPassResult {
  ticketSummaries: number;
  orphanSummaries: number;
  serviceSummaries: number;
  uncategorizedSummaries: number;
}

/**
 * Run a full summarization pass: process all tickets with unsummarized logs,
 * then orphan logs, service logs, and uncategorized logs.
 */
export async function runSummarizationPass(
  db: PrismaClient,
  ai: AIRouter,
): Promise<FullPassResult> {
  // Find ticket IDs that have logs newer than their latest TICKET summary
  const ticketIdsWithLogs = await db.$queryRaw<Array<{ entityId: string }>>`
    SELECT DISTINCT al.entity_id AS "entityId"
    FROM app_logs al
    LEFT JOIN LATERAL (
      SELECT ls.window_end FROM log_summaries ls
      WHERE ls.ticket_id = al.entity_id
        AND ls.summary_type = 'TICKET'
      ORDER BY ls.window_end DESC LIMIT 1
    ) latest ON true
    WHERE al.entity_id IS NOT NULL
      AND al.entity_type = 'ticket'
      AND (latest.window_end IS NULL OR al.created_at > latest.window_end)
  `;

  let ticketSummaries = 0;

  for (const { entityId } of ticketIdsWithLogs) {
    if (!entityId) continue;
    try {
      const result = await summarizeTicketLogs(db, ai, entityId);
      ticketSummaries += result.created;
    } catch (err) {
      logger.error({ err, ticketId: entityId }, 'Failed to summarize ticket logs');
    }
  }

  // Orphan logs (ticket-processing services, no ticketId)
  const orphanResult = await summarizeOrphanLogs(db, ai);

  // Service logs (infrastructure services, no ticketId)
  const serviceResult = await summarizeServiceLogs(db, ai);

  // Uncategorized logs (catch-all)
  const uncategorizedResult = await summarizeUncategorizedLogs(db, ai);

  logger.info(
    {
      ticketSummaries,
      orphanSummaries: orphanResult.created,
      serviceSummaries: serviceResult.created,
      uncategorizedSummaries: uncategorizedResult.created,
    },
    'Log summarization pass complete',
  );

  return {
    ticketSummaries,
    orphanSummaries: orphanResult.created,
    serviceSummaries: serviceResult.created,
    uncategorizedSummaries: uncategorizedResult.created,
  };
}
