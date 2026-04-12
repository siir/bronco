import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Job } from 'bullmq';
import { Prisma } from '@bronco/db';
import type { PrismaClient } from '@bronco/db';
import type { TicketCategory, Priority, TicketStatus, TicketSource, AnalysisJob } from '@bronco/shared-types';
import { AIRouter } from '@bronco/ai-provider';
import { TaskType, RouteStepType, isClosedStatus, AnalysisStatus, SufficiencyStatus, SufficiencyConfidence, NotificationMode } from '@bronco/shared-types';
import { createLogger, AppLogger, createPrismaLogWriter, decrypt, looksEncrypted, MCP_TOOL_TIMEOUT_MS, mcpUrl, callMcpToolViaSdk, notifyOperators as notifyOperatorsFn, notifyClientOperators as notifyClientOperatorsFn, getSelfAnalysisConfig } from '@bronco/shared-utils';
import type { AIToolDefinition, AIMessage, AIToolUseBlock, AITextBlock, AIToolResponse, AIToolResultBlock } from '@bronco/shared-types';
import type { Mailer, ReplyOptions } from '@bronco/shared-utils';
import { executeRecommendations } from './recommendation-executor.js';
import type { ParsedAction } from './recommendation-executor.js';

const logger = createLogger('ticket-analyzer');
export const appLog = new AppLogger('ticket-analyzer');

export function initAnalyzerLogger(db: PrismaClient): void {
  appLog.setWriter(createPrismaLogWriter(db));
}

/** Sanitize a user-supplied name for safe inclusion in event content and log messages. */
function sanitizeName(raw: string, maxLen = 120): string {
  // Strip control characters (C0, C1, DEL) and trim whitespace, then truncate
  return raw.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, maxLen);
}

/**
 * Sanitize a file path for safe use in shell commands within repo worktrees.
 * Rejects absolute paths, paths with `..` segments, and strips leading `./`.
 * Returns null for invalid paths, the sanitized path for valid ones.
 */
function sanitizeFilePath(fp: string): string | null {
  if (!fp || fp.startsWith('/')) return null;
  const normalized = fp.replace(/\\/g, '/');
  if (normalized.split('/').some(seg => seg === '..')) return null;
  return normalized.replace(/^\.\//, '');
}

/** Max events to include in ticket summary prompts to bound prompt size. */
const SUMMARY_EVENT_LIMIT = 50;

/** Canonical list of AI action types — used in both the LLM prompt and runtime validation. */
const KNOWN_ACTIONS = [
  'set_status', 'set_priority', 'set_category', 'add_comment',
  'trigger_code_fix', 'send_followup_email', 'escalate_deep_analysis', 'check_database_health',
] as const;

/** Strip embedded credentials from URLs in error messages (e.g., https://user:token@host/repo). */
function redactUrls(msg: string): string {
  return msg.replace(/https?:\/\/[^@]+@/g, 'https://***@');
}

/**
 * Parse and validate the JSON action array from SUGGEST_NEXT_STEPS AI output.
 * Returns both the raw parsed array and the validated action objects.
 * Unknown action types are now passed through (the executor handles them).
 */
function parseNextStepsActions(ticketId: string, content: string): { actions: ParsedAction[]; rawActions: unknown[] } {
  let rawActions: unknown[] = [];
  try {
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    const parsed: unknown = JSON.parse(cleaned);
    rawActions = Array.isArray(parsed) ? parsed : [];
  } catch {
    logger.warn({ ticketId, raw: content.slice(0, 200) }, 'Failed to parse next steps JSON — storing as text recommendation');
    return { actions: [], rawActions: [] };
  }

  const actions: ParsedAction[] = [];
  for (const raw of rawActions) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      logger.warn({ ticketId, entry: String(raw).slice(0, 100) }, 'Skipping non-object action entry');
      continue;
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.action !== 'string' || !obj.action.trim()) {
      logger.warn({ ticketId, entry: JSON.stringify(raw).slice(0, 100) }, 'Skipping action entry with missing or non-string action field');
      continue;
    }
    if (obj.value !== undefined && typeof obj.value !== 'string') {
      logger.warn({ ticketId, action: obj.action, valueType: typeof obj.value }, 'Skipping action with non-string value');
      continue;
    }
    if (typeof obj.reason !== 'string' || !obj.reason.trim()) {
      logger.warn({ ticketId, action: obj.action }, 'Skipping action with missing or empty reason');
      continue;
    }
    actions.push({
      action: obj.action,
      value: typeof obj.value === 'string' ? obj.value : undefined,
      reason: obj.reason as string,
    });
  }

  return { actions, rawActions };
}

// ---------------------------------------------------------------------------
// Sufficiency evaluation parsing
// ---------------------------------------------------------------------------

const SUFFICIENCY_DELIMITER = '---SUFFICIENCY---';

interface SufficiencyEvaluation {
  status: SufficiencyStatus;
  questions: string[];
  confidence: SufficiencyConfidence;
  reason: string;
}

const VALID_SUFFICIENCY_STATUSES = new Set<string>(Object.values(SufficiencyStatus));
const VALID_SUFFICIENCY_CONFIDENCES = new Set<string>(Object.values(SufficiencyConfidence));

/**
 * Parse the structured sufficiency suffix from an analysis response.
 * Returns the clean analysis text (without the suffix) and the parsed evaluation.
 * If no suffix is found, defaults to SUFFICIENT to avoid blocking tickets.
 */
function parseSufficiencyEvaluation(rawAnalysis: string): { analysis: string; evaluation: SufficiencyEvaluation } {
  const delimIdx = rawAnalysis.lastIndexOf(SUFFICIENCY_DELIMITER);
  if (delimIdx === -1) {
    return {
      analysis: rawAnalysis,
      evaluation: { status: SufficiencyStatus.SUFFICIENT, questions: [], confidence: SufficiencyConfidence.MEDIUM, reason: 'No sufficiency evaluation provided — defaulting to SUFFICIENT' },
    };
  }

  const analysis = rawAnalysis.slice(0, delimIdx).trimEnd();
  const suffBlock = rawAnalysis.slice(delimIdx + SUFFICIENCY_DELIMITER.length).trim();

  let status: SufficiencyStatus = SufficiencyStatus.SUFFICIENT;
  let confidence: SufficiencyConfidence = SufficiencyConfidence.MEDIUM;
  let reason = '';
  const questions: string[] = [];

  let inQuestions = false;
  for (const line of suffBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('STATUS:')) {
      const val = trimmed.slice('STATUS:'.length).trim();
      if (VALID_SUFFICIENCY_STATUSES.has(val)) status = val as SufficiencyStatus;
      inQuestions = false;
    } else if (trimmed.startsWith('CONFIDENCE:')) {
      const val = trimmed.slice('CONFIDENCE:'.length).trim();
      if (VALID_SUFFICIENCY_CONFIDENCES.has(val)) confidence = val as SufficiencyConfidence;
      inQuestions = false;
    } else if (trimmed.startsWith('REASON:')) {
      reason = trimmed.slice('REASON:'.length).trim();
      inQuestions = false;
    } else if (trimmed.startsWith('QUESTIONS:')) {
      const inline = trimmed.slice('QUESTIONS:'.length).trim();
      if (inline) questions.push(inline);
      inQuestions = true;
    } else if (inQuestions && (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+[.)]/.test(trimmed))) {
      questions.push(trimmed.replace(/^[-*]\s*|^\d+[.)]\s*/, ''));
    }
  }

  return { analysis, evaluation: { status, questions, confidence, reason } };
}

/** Instructions appended to the agentic analysis system prompt for sufficiency evaluation. */
const SUFFICIENCY_EVAL_INSTRUCTIONS = [
  '',
  '## Sufficiency Evaluation',
  '',
  'Before providing your final analysis, evaluate whether you have enough information to propose a resolution plan.',
  'Consider: Do you understand the root cause? Do you have enough evidence? Are there gaps only the user can fill?',
  '',
  'After your analysis, include a structured suffix on new lines:',
  '',
  '```',
  '---SUFFICIENCY---',
  'STATUS: SUFFICIENT | NEEDS_USER_INPUT | INSUFFICIENT',
  'QUESTIONS: [only if NEEDS_USER_INPUT — specific questions for the user, one per line starting with -]',
  'CONFIDENCE: HIGH | MEDIUM | LOW',
  'REASON: [brief explanation of why this status was chosen]',
  '```',
  '',
  'Guidelines:',
  '- SUFFICIENT: You have enough context from system sources to propose a concrete resolution plan.',
  '- NEEDS_USER_INPUT: You have exhausted system sources (databases, code repos) but have specific questions only the user can answer. Ask targeted questions — not vague "can you tell me more?"',
  '- INSUFFICIENT: You cannot determine what is needed — the ticket may be too vague or the systems are inaccessible. Flag for operator review.',
  '- Always provide your best analysis regardless of sufficiency status.',
].join('\n');

// ---------------------------------------------------------------------------
// Retry configuration for outbound emails
// ---------------------------------------------------------------------------

/** Maximum number of retry attempts for sending receipt confirmation emails. */
const EMAIL_RETRY_MAX_ATTEMPTS = 3;
/** Initial backoff delay in ms — doubles after each failed attempt (2s, 4s). */
const EMAIL_RETRY_INITIAL_DELAY_MS = 2_000;

/**
 * Check if an email address matches any active IMAP integration inbox
 * for the given client. Prevents email loops where the system would
 * send automated replies to its own ingestion inbox.
 */
async function isImapInbox(
  db: PrismaClient,
  clientId: string | undefined,
  recipientEmail: string,
): Promise<boolean> {
  if (!clientId) return false;
  const normalised = recipientEmail.trim().toLowerCase();
  const imapIntegrations = await db.clientIntegration.findMany({
    where: { clientId, type: 'IMAP', isActive: true },
    select: { config: true },
  });
  return imapIntegrations.some((integ) => {
    const cfg = integ.config as Record<string, unknown>;
    const user = typeof cfg['user'] === 'string' ? cfg['user'].trim().toLowerCase() : '';
    return user === normalised;
  });
}

/**
 * Send an email via the mailer with exponential backoff retry.
 * Returns the outbound message ID on success, or throws after all attempts are exhausted.
 *
 * If the recipient matches an active IMAP inbox for the client, the send is
 * blocked to prevent email loops. A SYSTEM_NOTE ticket event is recorded and
 * `undefined` is returned (no message ID).
 */
async function sendReplyWithRetry(
  mailer: Mailer | null,
  opts: ReplyOptions,
  context: { ticketId: string; db?: PrismaClient; clientId?: string },
): Promise<string | undefined> {
  if (!mailer) {
    logger.warn({ ticketId: context.ticketId }, 'Skipping email send — SMTP not configured');
    return undefined;
  }
  // Loop guard: block sends to IMAP inbox addresses
  if (context.db && context.clientId && opts.to) {
    const blocked = await isImapInbox(context.db, context.clientId, opts.to);
    if (blocked) {
      const msg = `Email send blocked: recipient "${opts.to}" matches an active IMAP inbox. Sending to this address would create an email loop.`;
      logger.warn({ ticketId: context.ticketId, to: opts.to }, msg);
      appLog.warn(msg, { ticketId: context.ticketId, to: opts.to }, context.ticketId, 'ticket');
      await context.db.ticketEvent.create({
        data: {
          ticketId: context.ticketId,
          eventType: 'SYSTEM_NOTE',
          content: msg,
          metadata: { type: 'email_loop_blocked', to: opts.to },
          actor: 'system:analyzer',
        },
      });
      return undefined;
    }
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= EMAIL_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await mailer.sendReply(opts);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < EMAIL_RETRY_MAX_ATTEMPTS) {
        const backoffMs = EMAIL_RETRY_INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(
          { ticketId: context.ticketId, attempt, maxAttempts: EMAIL_RETRY_MAX_ATTEMPTS, backoffMs, err: lastError },
          `Receipt email send failed (attempt ${attempt}/${EMAIL_RETRY_MAX_ATTEMPTS}), retrying in ${backoffMs}ms`,
        );
        appLog.warn(
          `Email send attempt ${attempt}/${EMAIL_RETRY_MAX_ATTEMPTS} failed, retrying in ${backoffMs}ms: ${lastError.message}`,
          { ticketId: context.ticketId, attempt, backoffMs },
          context.ticketId,
          'ticket',
        );
        await delay(backoffMs);
      }
    }
  }

  // All attempts exhausted
  throw lastError ?? new Error('All email send attempts failed');
}

// Re-export AnalysisJob from shared-types for backward compatibility with existing imports.
export type { AnalysisJob } from '@bronco/shared-types';

/** Internal resolved context — loaded from DB at the start of the analysis pipeline. */
interface AnalysisContext {
  ticketId: string;
  clientId: string;
  emailFrom?: string;
  emailSubject: string;
  emailBody: string;
  emailMessageId?: string;
  /** The ticket's source (EMAIL, SCHEDULED, MANUAL, etc.) for route matching. */
  ticketSource: TicketSource;
  /** Populated by AGENTIC_ANALYSIS or UPDATE_ANALYSIS — consumed by DRAFT_FINDINGS_EMAIL. */
  sufficiencyEval?: SufficiencyEvaluation;
}

export interface AnalyzerDeps {
  db: PrismaClient;
  ai: AIRouter;
  mailer: Mailer | null;
  mcpDatabaseUrl?: string;
  /** Display name for signing outbound emails (e.g. "John Smith") */
  senderSignature: string;
  /** Base directory for repo clones. Defaults to /tmp/bronco-repos if not set. */
  repoWorkspacePath: string;
  /** AES-256-GCM encryption key for decrypting integration secrets (API keys, etc.). */
  encryptionKey: string;
  /** MCP repo server URL for code repository access via mcp-repo. */
  mcpRepoUrl: string;
  /** API key for authenticating to mcp-repo (x-api-key header). */
  apiKey?: string;
  /** MCP auth token for authenticating to mcp-repo (Bearer header, takes precedence over apiKey). */
  mcpAuthToken?: string;
  /** Optional BullMQ queue for self-analysis triggers (post-pipeline analysis). */
  selfAnalysisQueue?: import('bullmq').Queue;
  /** Optional path for storing full MCP tool result artifacts on disk. */
  artifactStoragePath?: string;
  /** Fetches the global default max tokens from DB settings (called per analysis). */
  loadDefaultMaxTokens?: () => Promise<number | undefined>;
}

// ---------------------------------------------------------------------------
// Helper: load full analysis context from the DB for a given ticket
// (email metadata, body, and general ticket fields used by the pipeline)
// ---------------------------------------------------------------------------

async function loadAnalysisContext(
  db: PrismaClient,
  job: AnalysisJob,
): Promise<AnalysisContext> {
  const { ticketId, reanalysis, triggerEventId } = job;

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { clientId: true, subject: true, source: true, description: true, followers: { where: { followerType: 'REQUESTER' }, select: { person: { select: { email: true } } }, orderBy: { createdAt: 'asc' }, take: 1 } },
  });

  if (!ticket) {
    throw new Error(`Ticket ${ticketId} not found — cannot load analysis context`);
  }

  // For re-analysis, prefer the trigger event for sender/messageId/body context.
  // This ensures replies are sent to the actual replier (not always the original sender)
  // and email threading uses the most recent message ID.
  if (reanalysis && triggerEventId) {
    const triggerEvent = await db.ticketEvent.findUnique({
      where: { id: triggerEventId },
      select: { content: true, emailMessageId: true, metadata: true },
    });
    if (triggerEvent) {
      const triggerMeta = triggerEvent.metadata as Record<string, unknown> | null;
      const triggerFrom = triggerMeta?.from as string | undefined;
      if (triggerFrom?.trim()) {
        return {
          ticketId,
          clientId: ticket.clientId,
          emailFrom: triggerFrom,
          emailSubject: ticket.subject ?? '(No subject)',
          emailBody: triggerEvent.content ?? '',
          emailMessageId: triggerEvent.emailMessageId ?? undefined,
          ticketSource: ticket.source,
        };
      }
    }
  }

  // Default: load from earliest inbound event (original email)
  const inboundEvent = await db.ticketEvent.findFirst({
    where: { ticketId, eventType: 'EMAIL_INBOUND' },
    orderBy: { createdAt: 'asc' },
    select: { content: true, emailMessageId: true, metadata: true },
  });

  if (!inboundEvent) {
    // Non-email ticket (probe, manual, AI-detected) — fall back to requester email for notifications
    logger.info({ ticketId, source: ticket.source }, 'No EMAIL_INBOUND event found — loading non-email context');
    return {
      ticketId,
      clientId: ticket.clientId,
      emailFrom: ticket.followers[0]?.person?.email ?? undefined,
      emailSubject: ticket.subject ?? '(No subject)',
      emailBody: ticket.description ?? '',
      emailMessageId: undefined,
      ticketSource: ticket.source,
    };
  }

  const meta = inboundEvent.metadata as Record<string, unknown> | null;
  const emailFrom = meta?.from as string | undefined;
  if (!emailFrom?.trim()) {
    // Email event exists but has no sender — treat as non-email context
    logger.warn({ ticketId }, 'EMAIL_INBOUND event missing from address — treating as non-email ticket');
    return {
      ticketId,
      clientId: ticket.clientId,
      emailFrom: undefined,
      emailSubject: ticket.subject ?? '(No subject)',
      emailBody: inboundEvent.content ?? '',
      emailMessageId: undefined,
      ticketSource: ticket.source,
    };
  }

  return {
    ticketId,
    clientId: ticket.clientId,
    emailFrom,
    emailSubject: ticket.subject ?? '(No subject)',
    emailBody: inboundEvent.content ?? '',
    emailMessageId: inboundEvent.emailMessageId ?? undefined,
    ticketSource: ticket.source,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a full RFC 2822 References chain from the inbound email
// ---------------------------------------------------------------------------

async function buildReferenceChain(
  db: PrismaClient,
  ticketId: string,
  emailMessageId: string | undefined,
  extraMessageIds: string[] = [],
): Promise<string[]> {
  // Look up the original inbound email event to get its existing References header
  const inboundEvent = await db.ticketEvent.findFirst({
    where: { ticketId, eventType: 'EMAIL_INBOUND' },
    orderBy: { createdAt: 'asc' },
    select: { metadata: true },
  });

  const meta = inboundEvent?.metadata as Record<string, unknown> | null;
  const rawRefs = meta?.references;
  let originalRefs: string[] = [];
  if (Array.isArray(rawRefs)) {
    originalRefs = rawRefs.filter((r): r is string => typeof r === 'string');
  } else if (typeof rawRefs === 'string') {
    originalRefs = rawRefs.split(/\s+/).map((r) => r.trim()).filter((r) => r.length > 0);
  }

  const refs: string[] = [...originalRefs];
  if (emailMessageId && !refs.includes(emailMessageId)) {
    refs.push(emailMessageId);
  }
  for (const id of extraMessageIds) {
    if (id && !refs.includes(id)) {
      refs.push(id);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Helper: generate and persist a comprehensive ticket summary
// ---------------------------------------------------------------------------

type TicketSummaryOverrides = {
  taskTypeOverride?: string | null;
  promptKeyOverride?: string | null;
};

async function updateTicketSummary(
  deps: AnalyzerDeps,
  ticketId: string,
  overrides?: TicketSummaryOverrides,
): Promise<void> {
  const { db, ai } = deps;

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      client: { select: { name: true } },
      followers: { where: { followerType: 'REQUESTER' }, include: { person: { select: { name: true, email: true } } }, orderBy: { createdAt: 'asc' }, take: 1 },
      events: { orderBy: { createdAt: 'desc' }, take: SUMMARY_EVENT_LIMIT },
    },
  });
  if (!ticket) return;

  const requester = ticket.followers[0]?.person;

  // Build a timeline digest for the LLM (most recent N events, chronological)
  const eventDigest = ticket.events
    .reverse()
    .map((e) => {
      const ts = e.createdAt.toISOString().slice(0, 16);
      const content = (e.content ?? '').slice(0, 500);
      return `[${ts}] ${e.eventType} (${e.actor}): ${content}`;
    })
    .join('\n');

  const promptParts: string[] = [
    'Generate a concise ticket summary (3-5 sentences) covering:',
    '- Who the requester is',
    '- What the problem or request is',
    '- Current status and what has been done so far',
    '- Any next steps or outstanding items',
    '',
    `Ticket ID: ${ticket.id}`,
    `Subject: ${ticket.subject}`,
    `Client: ${ticket.client?.name ?? 'Unknown'}`,
    `Requester: ${requester?.name ?? 'Unknown'} (${requester?.email ?? 'N/A'})`,
    `Status: ${ticket.status}`,
    `Priority: ${ticket.priority}`,
    `Category: ${ticket.category ?? 'Uncategorized'}`,
    '',
  ];

  // Include existing summary so the LLM can preserve context from older events
  if (ticket.summary) {
    promptParts.push(
      'Previous summary (may contain context from older events not shown below):',
      ticket.summary,
      '',
    );
  }

  promptParts.push('Event timeline:', eventDigest);

  const normalizedPromptKey = overrides?.promptKeyOverride?.trim();
  if (overrides?.promptKeyOverride != null && !normalizedPromptKey) {
    logger.warn({ ticketId }, 'promptKeyOverride is blank; falling back to default prompt key');
  }
  const promptKey = normalizedPromptKey || 'imap.summarize-ticket.system';
  const taskType = (overrides?.taskTypeOverride ?? TaskType.SUMMARIZE_TICKET) as TaskType;

  const summaryRes = await ai.generate({
    taskType,
    context: { entityId: ticketId, entityType: 'ticket', clientId: ticket.clientId },
    prompt: promptParts.join('\n'),
    promptKey,
  });

  await db.ticket.update({
    where: { id: ticketId },
    data: { summary: summaryRes.content.trim() },
  });

  logger.info({ ticketId }, 'Ticket summary updated');
}

// ---------------------------------------------------------------------------
// Phase 1: Receipt confirmation
// ---------------------------------------------------------------------------

async function resolveRecipientName(
  db: PrismaClient,
  ticketId: string,
  emailFrom: string,
  clientId?: string | null,
): Promise<string> {
  // 1. Check if there's a person record with a name (scoped to client to prevent cross-tenant leakage)
  const person = await db.person.findFirst({
    where: {
      email: { equals: emailFrom, mode: 'insensitive' },
      ...(clientId ? { clientId } : {}),
    },
    select: { name: true },
  });
  if (person?.name) return person.name;

  // 2. Check the ticket's requester follower
  const requesterFollower = await db.ticketFollower.findFirst({
    where: { ticketId, followerType: 'REQUESTER' },
    include: { person: { select: { name: true } } },
  });
  if (requesterFollower?.person?.name) return requesterFollower.person.name;

  // 3. Look for fromName in the inbound email event metadata
  const inboundEvent = await db.ticketEvent.findFirst({
    where: { ticketId, eventType: 'EMAIL_INBOUND' },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  });
  const meta = inboundEvent?.metadata as Record<string, unknown> | null;
  const fromName = meta?.fromName as string | undefined;
  if (fromName && fromName !== emailFrom) return fromName;

  // 4. Fallback to email address
  return emailFrom;
}

async function sendReceiptConfirmation(
  deps: AnalyzerDeps,
  ctx: AnalysisContext,
): Promise<{ triageSummaryPromise: Promise<void> }> {
  const { db, ai, mailer, senderSignature } = deps;
  const { ticketId, clientId, emailFrom, emailSubject, emailBody, emailMessageId } = ctx;

  appLog.info('Phase 1: Starting receipt confirmation', { ticketId, emailFrom, emailSubject }, ticketId, 'ticket');

  // Resolve the recipient's display name (emailFrom is guaranteed non-null by caller)
  const recipientName = await resolveRecipientName(db, ticketId, emailFrom!, clientId);
  appLog.info(`Recipient resolved: ${recipientName}`, { ticketId, recipientName }, ticketId, 'ticket');

  // Summarize the email
  const summaryRes = await ai.generate({
    taskType: TaskType.SUMMARIZE,
    context: { entityId: ticketId, entityType: 'ticket', clientId },
    prompt: `Summarize the following support email in 2-3 concise bullet points:\n\nSubject: ${emailSubject}\n\n${emailBody}`,
    promptKey: 'imap.summarize.system',
  });
  const summary = summaryRes.content;

  appLog.info('Email summarized via LLM', { ticketId, provider: summaryRes.provider, model: summaryRes.model }, ticketId, 'ticket');

  // Categorize the ticket
  const categorizeRes = await ai.generate({
    taskType: TaskType.CATEGORIZE,
    context: { entityId: ticketId, entityType: 'ticket', clientId },
    prompt: `Categorize this support request into exactly one of: DATABASE_PERF, BUG_FIX, FEATURE_REQUEST, SCHEMA_CHANGE, CODE_REVIEW, ARCHITECTURE, GENERAL.\n\nSubject: ${emailSubject}\n\n${emailBody}\n\nRespond with only the category name.`,
    promptKey: 'imap.categorize.system',
  });
  const rawCategory = categorizeRes.content.trim().toUpperCase();
  const validCategories = [
    'DATABASE_PERF', 'BUG_FIX', 'FEATURE_REQUEST', 'SCHEMA_CHANGE',
    'CODE_REVIEW', 'ARCHITECTURE', 'GENERAL',
  ];
  const category = validCategories.includes(rawCategory) ? rawCategory : 'GENERAL';

  // Triage for priority
  const triageRes = await ai.generate({
    taskType: TaskType.TRIAGE,
    context: { entityId: ticketId, entityType: 'ticket', clientId },
    prompt: `Assess the priority of this support request. Choose one of: LOW, MEDIUM, HIGH, CRITICAL.\n\nSubject: ${emailSubject}\n\n${emailBody}\n\nRespond with only the priority level.`,
    promptKey: 'imap.triage.system',
  });
  const rawPriority = triageRes.content.trim().toUpperCase();
  const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const priority = validPriorities.includes(rawPriority) ? rawPriority : 'MEDIUM';

  // Update ticket with category and priority
  await db.ticket.update({
    where: { id: ticketId },
    data: { category: category as TicketCategory, priority: priority as Priority },
  });

  appLog.info(`Ticket triaged: category=${category}, priority=${priority}`, { ticketId, category, priority }, ticketId, 'ticket');

  // Draft the receipt confirmation email
  const draftRes = await ai.generate({
    taskType: TaskType.DRAFT_EMAIL,
    context: { entityId: ticketId, entityType: 'ticket', clientId },
    prompt: [
      'Draft a short, professional email confirming receipt of a support request.',
      `Recipient name: ${recipientName}`,
      `Sender name (sign as): ${senderSignature}`,
      `Ticket ID: ${ticketId}`,
      `Subject: ${emailSubject}`,
      '',
      'Issue summary:',
      summary,
      '',
      `Category: ${category}`,
      `Priority: ${priority}`,
      '',
      'The email should:',
      `- Address the recipient by their first name (derived from "${recipientName}")`,
      '- Confirm we received the request and created a ticket',
      '- Include the ticket ID for reference',
      '- Restate the summarized issue so they know we understood',
      '- Let them know we are analyzing and will follow up with findings',
      '- Be concise (under 150 words)',
      `- Sign off with the sender name: ${senderSignature}`,
    ].join('\n'),
    promptKey: 'imap.draft-receipt.system',
  });

  const receiptBody = draftRes.content;

  // Build full threading reference chain
  const references = await buildReferenceChain(db, ticketId, emailMessageId);

  // Send the receipt email with retry
  const outboundMsgId = await sendReplyWithRetry(
    mailer,
    {
      to: emailFrom!,
      subject: emailSubject,
      body: receiptBody,
      inReplyTo: emailMessageId,
      references,
    },
    { ticketId, db, clientId },
  );

  // Record the outbound email as a ticket event (only if actually sent)
  if (outboundMsgId) {
    await db.ticketEvent.create({
      data: {
        ticketId,
        eventType: 'EMAIL_OUTBOUND',
        content: receiptBody,
        metadata: {
          type: 'receipt_confirmation',
          to: emailFrom!,
          subject: `Re: ${emailSubject}`,
          messageId: outboundMsgId,
          summary,
          category,
          priority,
        },
        actor: 'system:analyzer',
      },
    });
    appLog.info(`Receipt confirmation email sent to ${emailFrom}`, { ticketId, to: emailFrom }, ticketId, 'ticket');
  } else {
    appLog.info(`Receipt confirmation email skipped (send blocked by loop guard)`, { ticketId, to: emailFrom }, ticketId, 'ticket');
  }

  // Also record the AI analysis event with the triage results
  await db.ticketEvent.create({
    data: {
      ticketId,
      eventType: 'AI_ANALYSIS',
      content: `**Triage Summary**\n\nCategory: ${category}\nPriority: ${priority}\n\n${summary}`,
      metadata: {
        phase: 'triage',
        category,
        priority,
        summary,
        aiProvider: summaryRes.provider,
        aiModel: summaryRes.model,
      },
      actor: 'system:analyzer',
    },
  });

  // Generate initial ticket summary after triage (best-effort, non-blocking)
  const triageSummaryPromise = updateTicketSummary(deps, ticketId).catch((err) => {
    logger.warn({ err, ticketId }, 'Failed to update ticket summary after receipt confirmation');
  });

  return { triageSummaryPromise };
}

// ---------------------------------------------------------------------------
// Phase 2: Deep analysis — repos, MCP, and fix recommendation
// ---------------------------------------------------------------------------

/**
 * Remove bare repo clones and orphaned worktrees that haven't been
 * accessed within `retentionDays`. Runs best-effort — errors are logged
 * but never propagated.
 */
export async function cleanupStaleRepos(
  baseDir: string,
  retentionDays: number,
): Promise<void> {
  const bareDir = join(baseDir, 'bare');
  const worktreeDir = join(baseDir, 'worktrees');
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Clean up stale bare clones
  try {
    const entries = await readdir(bareDir).catch(() => [] as string[]);
    for (const entry of entries) {
      try {
        const entryPath = join(bareDir, entry);
        const info = await stat(entryPath);
        // Use mtime (last modified) as a proxy for last access — git fetch updates it
        if (info.mtimeMs < cutoff) {
          await rm(entryPath, { recursive: true, force: true });
          logger.info({ repo: entry, ageDays: Math.round((Date.now() - info.mtimeMs) / 86_400_000) }, 'Removed stale bare repo');
        }
      } catch (err) {
        logger.warn({ entry, err }, 'Failed to clean up bare repo entry');
      }
    }
  } catch (err) {
    logger.warn({ err, bareDir }, 'Failed to list bare repo directory for cleanup');
  }

  // Clean up orphaned worktrees (should be removed per-job, but belt-and-suspenders)
  try {
    const entries = await readdir(worktreeDir).catch(() => [] as string[]);
    for (const entry of entries) {
      try {
        const entryPath = join(worktreeDir, entry);
        const info = await stat(entryPath);
        if (info.mtimeMs < cutoff) {
          await rm(entryPath, { recursive: true, force: true });
          logger.info({ worktree: entry, ageDays: Math.round((Date.now() - info.mtimeMs) / 86_400_000) }, 'Removed orphaned worktree');
        }
      } catch (err) {
        logger.warn({ entry, err }, 'Failed to clean up worktree entry');
      }
    }
  } catch (err) {
    logger.warn({ err, worktreeDir }, 'Failed to list worktree directory for cleanup');
  }
}

/** Map MCP tool names (snake_case) to REST bridge paths (kebab-case, prefix stripped). */
const MCP_TOOL_TO_REST_PATH: Record<string, string> = {
  run_query:           'run-query',
  inspect_schema:      'inspect-schema',
  list_indexes:        'list-indexes',
  get_blocking_tree:   'blocking-tree',
  get_wait_stats:      'wait-stats',
  get_database_health: 'database-health',
  // Note: list_systems is NOT a /tools/* bridge endpoint — it is served as GET /systems.
  // Use the MCP server's /systems endpoint directly rather than via callMcpTool().
};

/**
 * Use the MCP database REST bridge to run a health check or query.
 */
async function callMcpTool(
  mcpUrl: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  const restPath = MCP_TOOL_TO_REST_PATH[toolName] ?? toolName;
  const res = await fetch(`${mcpUrl}/tools/${restPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`MCP ${toolName} failed: ${res.status}`);
  }
  const data = await res.json() as { content?: Array<{ text?: string }> };
  return data.content?.map((c) => c.text).join('\n') ?? JSON.stringify(data);
}

async function deepAnalysis(
  deps: AnalyzerDeps,
  ctx: AnalysisContext,
  bullmqJobId: string,
  triageSummaryPromise?: Promise<void>,
): Promise<void> {
  const { db, ai, mailer, mcpDatabaseUrl, senderSignature } = deps;
  const { ticketId, clientId, emailFrom, emailSubject, emailBody, emailMessageId } = ctx;

  appLog.info('Phase 2: Starting deep analysis', { ticketId, emailSubject }, ticketId, 'ticket');

  // Resolve recipient name for outbound emails; for non-email tickets, fall back to a generic name
  const recipientName = emailFrom
    ? await resolveRecipientName(db, ticketId, emailFrom, clientId)
    : 'there';

  // Load ticket with relations
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      client: { include: { repositories: { where: { isActive: true } } } },
      system: true,
    },
  });
  if (!ticket) {
    appLog.warn('Ticket not found for deep analysis — aborting', { ticketId }, ticketId, 'ticket');
    return;
  }

  appLog.info(`Ticket loaded for analysis: ${ticket.client.name}, ${ticket.client.repositories.length} repo(s), system: ${ticket.system?.name ?? 'none'}`, {
    ticketId, clientName: ticket.client.name, repoCount: ticket.client.repositories.length, systemName: ticket.system?.name,
  }, ticketId, 'ticket');

  // Extract facts: what systems, files, errors are mentioned
  const extractRes = await ai.generate({
    taskType: TaskType.EXTRACT_FACTS,
    context: { entityId: ticketId, entityType: 'ticket', clientId },
    prompt: [
      'Extract structured facts from this support email. Return a JSON object with:',
      '- "errorMessages": array of error messages or stack traces mentioned',
      '- "filesMentioned": array of file paths or module names mentioned',
      '- "servicesMentioned": array of service/app names mentioned',
      '- "databaseRelated": boolean, true if the issue involves database queries, performance, or schema',
      '- "keywords": array of technical keywords for searching code',
      '',
      `Subject: ${emailSubject}`,
      '',
      emailBody,
    ].join('\n'),
    promptKey: 'imap.extract-facts.system',
  });

  let facts: {
    errorMessages?: string[];
    filesMentioned?: string[];
    servicesMentioned?: string[];
    databaseRelated?: boolean;
    keywords?: string[];
  } = {};

  try {
    // Strip markdown code fences if the LLM wrapped its response
    const cleaned = extractRes.content.replace(/```json\n?|\n?```/g, '').trim();
    facts = JSON.parse(cleaned);
  } catch {
    logger.warn({ ticketId }, 'Failed to parse extracted facts, continuing with defaults');
  }

  // --- Gather context from repos ---
  const codeContext: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  const failedRepos: Array<{ name: string; error: string }> = [];

  try {
  const clientCodeRepos = await db.codeRepo.findMany({ where: { clientId: ticket.clientId, isActive: true } });
  const initialSessionId = `initial-${ticketId}`;
  const repoAuth = deps.mcpAuthToken || deps.apiKey;
  const repoAuthHeader = deps.mcpAuthToken ? 'bearer' : 'x-api-key';
  for (const repo of clientCodeRepos) {
    try {
      const searchTerms = [
        ...(facts.keywords ?? []),
        ...(facts.filesMentioned ?? []),
        ...(facts.errorMessages?.map((e) => e.slice(0, 60)) ?? []),
      ].slice(0, 5);

      const relevantFiles = new Set<string>();

      for (const rawTerm of searchTerms) {
        if (!rawTerm || rawTerm.replace(/[\x00-\x1f\x7f]/g, '').trim().length === 0) continue;
        const sanitized = rawTerm.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
        try {
          const grepResult = await callMcpToolViaSdk(
            deps.mcpRepoUrl, '/mcp', 'repo_exec',
            { repoId: repo.id, sessionId: initialSessionId, clientId: ticket.clientId, command: `grep -rnil "${sanitized.replace(/"/g, '\\"')}" .` },
            repoAuth, repoAuthHeader,
          );
          const exts = ['.sql', '.cs', '.ts'];
          for (const line of grepResult.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('[session:') && !trimmed.startsWith('[stderr]') && exts.some(e => trimmed.endsWith(e))) {
              relevantFiles.add(trimmed);
            }
          }
        } catch {
          // grep found nothing — that's fine
        }
      }

      for (const f of facts.filesMentioned ?? []) {
        relevantFiles.add(f);
      }

      if (relevantFiles.size > 0) {
        const fileParts: string[] = [];
        let totalBytes = 0;
        for (const rawFp of relevantFiles) {
          if (totalBytes >= 60_000) break;
          const fp = sanitizeFilePath(rawFp);
          if (!fp) continue;
          try {
            const catResult = await callMcpToolViaSdk(
              deps.mcpRepoUrl, '/mcp', 'repo_exec',
              { repoId: repo.id, sessionId: initialSessionId, clientId: ticket.clientId, command: `cat '${fp.replace(/'/g, "'\\''")}'` },
              repoAuth, repoAuthHeader,
            );
            const content = catResult.split('\n').filter(l => !l.startsWith('[session:')).join('\n');
            const truncated = content.slice(0, 3000);
            const formatted = `--- ${fp} ---\n${truncated}\n`;
            fileParts.push(formatted);
            totalBytes += formatted.length;
          } catch { /* file not found or unreadable */ }
        }
        if (fileParts.length > 0) {
          codeContext.push(`## Repository: ${repo.name}\n\n${fileParts.join('\n')}`);
        }
      }
    } catch (err) {
      const errMsg = redactUrls(err instanceof Error ? err.message : String(err));
      failedRepos.push({ name: repo.name, error: errMsg });
      appLog.warn(`Repo context unavailable for ${repo.name}: ${errMsg}`, { ticketId, repo: repo.name, err }, ticketId, 'ticket');
    }
  }
  // Clean up session worktrees
  try { await callMcpToolViaSdk(deps.mcpRepoUrl, '/mcp', 'repo_cleanup', { sessionId: initialSessionId }, repoAuth, repoAuthHeader); } catch { /* best effort */ }

  // --- Gather context from MCP (database) ---
  let dbContext = '';
  let mcpFailed = false;
  let mcpError = '';

  if (facts.databaseRelated && mcpDatabaseUrl && ticket.system) {
    try {
      const healthResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_database_health', {
        systemId: ticket.system.id,
      });
      dbContext += `## Database Health\n\n${healthResult}\n\n`;

      // If there are error messages that look like SQL, try to analyze
      const sqlErrors = (facts.errorMessages ?? []).filter((e) =>
        /select|insert|update|delete|timeout|deadlock|block/i.test(e),
      );
      if (sqlErrors.length > 0) {
        const blockingResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_blocking_tree', {
          systemId: ticket.system.id,
        });
        dbContext += `## Blocking Tree\n\n${blockingResult}\n\n`;

        const waitResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_wait_stats', {
          systemId: ticket.system.id,
          topN: 10,
        });
        dbContext += `## Wait Stats\n\n${waitResult}\n\n`;
      }
    } catch (err) {
      mcpFailed = true;
      mcpError = err instanceof Error ? err.message : String(err);
      appLog.warn(`MCP database context unavailable for system ${ticket.system.name}: ${mcpError}`, { ticketId, systemId: ticket.system.id, err }, ticketId, 'ticket');
    }
  }

  // --- Flag degraded context ---
  const degraded = failedRepos.length > 0 || mcpFailed;
  const degradedReasons: string[] = [];
  if (failedRepos.length > 0) {
    degradedReasons.push(`Repository context unavailable for: ${failedRepos.map((r) => r.name).join(', ')}`);
  }
  if (mcpFailed) {
    degradedReasons.push(`Database health context unavailable: ${mcpError}`);
  }
  if (degraded) {
    appLog.warn(`Analysis proceeding with degraded context: ${degradedReasons.join('; ')}`, { ticketId, failedRepos: failedRepos.map((r) => r.name), mcpFailed }, ticketId, 'ticket');
  }

  // --- Run deep analysis with Claude ---
  const categoryTaskMap: Record<string, typeof TaskType[keyof typeof TaskType]> = {
    BUG_FIX: TaskType.BUG_ANALYSIS,
    DATABASE_PERF: TaskType.ANALYZE_QUERY,
    FEATURE_REQUEST: TaskType.FEATURE_ANALYSIS,
    ARCHITECTURE: TaskType.ARCHITECTURE_REVIEW,
    SCHEMA_CHANGE: TaskType.SCHEMA_REVIEW,
    CODE_REVIEW: TaskType.REVIEW_CODE,
  };
  const analysisTaskType = categoryTaskMap[ticket.category ?? ''] ?? TaskType.DEEP_ANALYSIS;

  const analysisPrompt = [
    `Analyze this support issue and provide a clear diagnosis and recommended fix.`,
    '',
    `## Issue`,
    `Subject: ${emailSubject}`,
    `Category: ${ticket.category ?? 'GENERAL'}`,
    `Priority: ${ticket.priority}`,
    '',
    emailBody,
    '',
    ...(codeContext.length > 0
      ? ['## Relevant Source Code', '', ...codeContext, '']
      : []),
    ...(dbContext ? ['## Database Information', '', dbContext, ''] : []),
    ...(degraded
      ? ['## ⚠ Degraded Context', '', 'The following data sources were unavailable during analysis:', ...degradedReasons.map((r) => `- ${r}`), 'Take this into account — your recommendations may need verification against the missing sources.', '']
      : []),
    '',
    '## Instructions',
    'Provide:',
    '1. **Root Cause**: What is likely causing this issue',
    '2. **Affected Components**: Which files/services/tables are involved',
    '3. **Recommended Fix**: Step-by-step fix with code snippets where applicable',
    '4. **Risk Assessment**: What could go wrong, what to test',
  ].join('\n');

  const analysisRes = await ai.generate({
    taskType: analysisTaskType,
    context: { entityId: ticketId, entityType: 'ticket', clientId },
    prompt: analysisPrompt,
    promptKey: 'imap.deep-analysis.system',
  });

  // Append degraded-context notice directly into the stored analysis so it is
  // always visible — even if the AI itself ignores the instruction in the prompt.
  const degradedNotice = degraded
    ? `\n\n---\n**Note: This analysis was produced with incomplete context.**\n${degradedReasons.map((r) => `- ${r}`).join('\n')}\nRecommendations should be verified against the missing sources before acting.`
    : '';
  const analysis = analysisRes.content + degradedNotice;

  appLog.info(`Deep analysis complete (${analysisTaskType}) via ${analysisRes.provider}/${analysisRes.model}`, { ticketId, taskType: analysisTaskType, provider: analysisRes.provider, model: analysisRes.model, durationMs: analysisRes.durationMs }, ticketId, 'ticket');

  // Record the analysis as a ticket event
  await db.ticketEvent.create({
    data: {
      ticketId,
      eventType: 'AI_ANALYSIS',
      content: analysis,
      metadata: {
        phase: 'deep_analysis',
        taskType: analysisTaskType,
        aiProvider: analysisRes.provider,
        aiModel: analysisRes.model,
        reposAnalyzed: ticket.client.repositories.map((r) => r.name),
        databaseChecked: !!dbContext,
        durationMs: analysisRes.durationMs,
        usage: analysisRes.usage,
        degraded,
        ...(failedRepos.length > 0 && { failedRepos }),
        ...(mcpFailed && { mcpError }),
      },
      actor: 'system:analyzer',
    },
  });

  if (ctx.emailFrom) {
    // Draft the findings email using the AI analysis content WITHOUT the degraded-context
    // notice — that notice contains internal details (repo names, MCP errors) that should
    // not leak into customer-facing emails.
    const findingsEmailRes = await ai.generate({
      taskType: TaskType.DRAFT_EMAIL,
      context: { entityId: ticketId, entityType: 'ticket', clientId },
      prompt: [
        'Draft a professional email sharing the analysis findings for a support ticket.',
        `Recipient name: ${recipientName}`,
        `Sender name (sign as): ${senderSignature}`,
        `Ticket ID: ${ticketId}`,
        `Subject: ${emailSubject}`,
        '',
        'Analysis findings:',
        analysisRes.content,
        '',
        'The email should:',
        `- Address the recipient by their first name (derived from "${recipientName}")`,
        '- Reference the ticket ID',
        '- Summarize the root cause clearly for a non-technical reader',
        '- Include the recommended fix steps',
        '- Note any risks or things to verify',
        '- Offer to discuss further if needed',
        '- Be professional but not overly formal',
        '- Keep it under 300 words',
        `- Sign off with the sender name: ${senderSignature}`,
      ].join('\n'),
      promptKey: 'imap.draft-analysis-email.system',
    });

    const findingsBody = findingsEmailRes.content;

    // Build full threading reference chain including all prior message IDs
    const receiptEvent = await db.ticketEvent.findFirst({
      where: {
        ticketId,
        eventType: 'EMAIL_OUTBOUND',
        metadata: { path: ['type'], equals: 'receipt_confirmation' },
      },
      orderBy: { createdAt: 'desc' },
    });
    const receiptMsgId = (receiptEvent?.metadata as Record<string, unknown> | null)?.messageId as string | undefined;
    const references = await buildReferenceChain(db, ticketId, emailMessageId, receiptMsgId ? [receiptMsgId] : []);

    const outboundMsgId = mailer
      ? await mailer.sendReply({
          to: ctx.emailFrom,
          subject: emailSubject,
          body: findingsBody,
          inReplyTo: receiptMsgId ?? emailMessageId,
          references,
        })
      : undefined;

    // Record the outbound findings email, even if the provider did not return a messageId
    await db.ticketEvent.create({
      data: {
        ticketId,
        eventType: 'EMAIL_OUTBOUND',
        content: findingsBody,
        metadata: {
          type: 'analysis_findings',
          to: ctx.emailFrom,
          subject: `Re: ${emailSubject}`,
          analysisTaskType,
          ...(outboundMsgId ? { messageId: outboundMsgId } : {}),
        },
        actor: 'system:analyzer',
      },
    });

    if (outboundMsgId) {
      // Update ticket status to indicate we've responded
      await db.ticket.update({
        where: { id: ticketId },
        data: { status: 'WAITING', resolvedAt: null },
      });
      appLog.info(`Analysis findings email sent to ${ctx.emailFrom}`, { ticketId, to: ctx.emailFrom }, ticketId, 'ticket');
    } else {
      appLog.warn('Findings email send returned no messageId — status not updated', { ticketId, to: ctx.emailFrom }, ticketId, 'ticket');
    }
  } else {
    appLog.info('Skipping findings email — no email context (non-email ticket)', { ticketId }, ticketId, 'ticket');
  }

  // Suggest next steps as structured JSON action objects; these are auto-applied to the ticket
  // (e.g., status/priority/category updates) and recorded as audit events.
  const nextStepsRes = await ai.generate({
    taskType: TaskType.SUGGEST_NEXT_STEPS,
    context: { entityId: ticketId, entityType: 'ticket', clientId },
    prompt: [
      'Based on the analysis below, suggest 1-3 concrete next steps for resolving this ticket.',
      'You MUST respond with valid JSON only — an array of action objects.',
      '',
      `Ticket ID: ${ticketId}`,
      `Subject: ${emailSubject}`,
      `Category: ${ticket.category ?? 'GENERAL'}`,
      `Priority: ${ticket.priority}`,
      `Current status: WAITING`,
      '',
      'Analysis findings:',
      analysis,
      '',
      '## Available actions (use these exact "action" values)',
      '',
      '- { "action": "set_status", "value": "OPEN|IN_PROGRESS|WAITING|RESOLVED|CLOSED", "reason": "..." }',
      '- { "action": "set_priority", "value": "LOW|MEDIUM|HIGH|CRITICAL", "reason": "..." }',
      '- { "action": "set_category", "value": "DATABASE_PERF|BUG_FIX|FEATURE_REQUEST|SCHEMA_CHANGE|CODE_REVIEW|ARCHITECTURE|GENERAL", "reason": "..." }',
      '- { "action": "trigger_code_fix", "reason": "..." }  (for BUG_FIX/FEATURE_REQUEST with code repos)',
      '- { "action": "send_followup_email", "reason": "..." }  (ask requester for more info)',
      '- { "action": "escalate_deep_analysis", "reason": "..." }  (request Claude for deeper review)',
      '- { "action": "check_database_health", "reason": "..." }  (for DATABASE_PERF with linked systems)',
      '- { "action": "add_comment", "value": "the comment text", "reason": "..." }',
      '',
      'Example response: [{"action":"set_status","value":"RESOLVED","reason":"Analysis shows the fix is straightforward and has been communicated"}]',
      '',
      'Only suggest actions that make sense. Respond with the JSON array only, no markdown fences.',
    ].join('\n'),
    promptKey: 'imap.suggest-next-steps.system',
  });

  // Parse, validate, and execute the structured actions via the recommendation executor
  const { actions, rawActions } = parseNextStepsActions(ticketId, nextStepsRes.content);

  if (rawActions.length === 0 && actions.length === 0) {
    // Unparseable — stored as text recommendation by parseNextStepsActions
    await db.ticketEvent.create({
      data: {
        ticketId,
        eventType: 'AI_RECOMMENDATION',
        content: nextStepsRes.content,
        metadata: { phase: 'next_steps', aiProvider: nextStepsRes.provider, aiModel: nextStepsRes.model, parsed: false },
        actor: 'system:analyzer',
      },
    });
  }

  // Execute actions via the configurable safety executor
  const execResults = actions.length > 0
    ? await executeRecommendations({ db, mailer }, ticketId, actions)
    : [];

  // Build summary and record the AI_RECOMMENDATION event
  const autoExec = execResults.filter((r) => r.outcome === 'auto_executed');
  const pending = execResults.filter((r) => r.outcome === 'pending_approval');
  const skipped = execResults.filter((r) => r.outcome === 'skipped');

  const summaryParts: string[] = [];
  if (autoExec.length > 0) {
    summaryParts.push('**Auto-executed:**');
    for (const a of autoExec) summaryParts.push(`- ${a.action}${a.value ? ` → ${a.value}` : ''}: ${a.reason}`);
  }
  if (pending.length > 0) {
    summaryParts.push('**Pending approval:**');
    for (const a of pending) summaryParts.push(`- ${a.action}: ${a.reason}`);
  }
  if (skipped.length > 0) {
    summaryParts.push('**Skipped:**');
    for (const a of skipped) summaryParts.push(`- ${a.action}: ${a.reason}`);
  }

  if (execResults.length > 0) {
    await db.ticketEvent.create({
      data: {
        ticketId,
        eventType: 'AI_RECOMMENDATION',
        content: summaryParts.join('\n'),
        metadata: {
          phase: 'next_steps',
          aiProvider: nextStepsRes.provider,
          aiModel: nextStepsRes.model,
          actions: execResults as unknown as Prisma.InputJsonValue,
          autoExecutedCount: autoExec.length,
          pendingCount: pending.length,
          skippedCount: skipped.length,
        },
        actor: 'system:analyzer',
      },
    });
  }

  appLog.info(`Next steps processed: ${autoExec.length} auto-executed, ${pending.length} pending, ${skipped.length} skipped`, {
    ticketId,
    autoExecuted: autoExec.map((a) => `${a.action}${a.value ? `=${a.value}` : ''}`),
    pending: pending.map((a) => a.action),
  }, ticketId, 'ticket');

  // Ensure the triage summary finishes before we overwrite it with the deep-analysis summary
  if (triageSummaryPromise) {
    await triageSummaryPromise;
  }
  await updateTicketSummary(deps, ticketId);
  } finally {
    // Clean up all worktrees created during this job
    const results = await Promise.allSettled(cleanups.map((fn) => fn()));
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn({ err: r.reason }, 'Worktree cleanup failed');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Route Resolution — find the best TicketRoute for a ticket
// ---------------------------------------------------------------------------

interface ResolvedRoute {
  id: string;
  name: string;
  summary?: string | null;
  steps: Array<{
    id: string;
    stepType: string;
    stepOrder: number;
    name: string;
    taskTypeOverride: string | null;
    promptKeyOverride: string | null;
    config: unknown;
  }>;
}

/**
 * Resolve the best ticket route for processing a ticket.
 *
 * Resolution order:
 * 1. Client-specific route matching the ticket category
 * 2. Global route matching the ticket category
 * 3. AI-based selection using route summaries
 * 4. Default route (isDefault=true)
 * 5. null (fall back to a synthetic default route matching the architecture flowchart)
 */
async function resolveTicketRoute(
  deps: AnalyzerDeps,
  ticketId: string,
  clientId: string | undefined,
  category: string | null,
  /** When true, only check client+category and global+category matches — skip AI selection and default routes. */
  categoryMatchOnly = false,
  /** The ticket source for source-based route matching (e.g. 'SCHEDULED', 'MANUAL'). */
  ticketSource?: TicketSource,
): Promise<ResolvedRoute | null> {
  const { db, ai } = deps;

  const includeSteps = {
    steps: { where: { isActive: true }, orderBy: { stepOrder: 'asc' as const } },
  };

  // Helper: find the first matching route with optional source filter.
  // Tries source-specific match first, then falls back to source=null (any-source) routes.
  // Only considers ANALYSIS routes — ingestion routes are handled by the ingestion engine.
  async function findBestRoute(
    baseWhere: Record<string, unknown>,
  ): Promise<ResolvedRoute | null> {
    // Try source-specific match first
    if (ticketSource) {
      const sourceRoute = await db.ticketRoute.findFirst({
        where: { ...baseWhere, source: ticketSource, isActive: true, routeType: 'ANALYSIS' } as never,
        include: includeSteps,
        orderBy: { sortOrder: 'asc' },
      });
      if (sourceRoute && sourceRoute.steps.length > 0) return sourceRoute;
    }
    // Fall back to any-source route (source=null)
    const anySourceRoute = await db.ticketRoute.findFirst({
      where: { ...baseWhere, source: null, isActive: true, routeType: 'ANALYSIS' } as never,
      include: includeSteps,
      orderBy: { sortOrder: 'asc' },
    });
    if (anySourceRoute && anySourceRoute.steps.length > 0) return anySourceRoute;
    return null;
  }

  // 1. Client-specific route matching the ticket category
  if (clientId && category) {
    const clientCategoryRoute = await findBestRoute({ clientId, category: category as never });
    if (clientCategoryRoute) {
      logger.info({ ticketId, routeId: clientCategoryRoute.id, routeName: clientCategoryRoute.name, matchSource: 'client_category', ticketSource }, 'Route resolved via client + category match');
      return clientCategoryRoute;
    }
  }

  // 2. Global route matching the ticket category
  if (category) {
    const globalCategoryRoute = await findBestRoute({ clientId: null, category: category as never });
    if (globalCategoryRoute) {
      logger.info({ ticketId, routeId: globalCategoryRoute.id, routeName: globalCategoryRoute.name, matchSource: 'global_category', ticketSource }, 'Route resolved via global category match');
      return globalCategoryRoute;
    }
  }

  // When dispatching, only direct category matches are valid — skip AI selection and default fallback
  if (categoryMatchOnly) {
    logger.info({ ticketId, category, clientId }, 'Category-match-only resolution found no matching route');
    return null;
  }

  // 3. AI-based selection using route summaries (restricted to global + client routes)
  // Apply source-preference: try source-specific routes first, then any-source
  const clientFilter = clientId
    ? { OR: [{ clientId: null }, { clientId }] }
    : { clientId: null };

  let candidateRoutes: ResolvedRoute[] = [];

  // Exclude re-analysis routes (those containing UPDATE_ANALYSIS steps) from AI selection —
  // they are only valid for reply-triggered re-analysis, not first-time analysis.
  const excludeReanalysis = { steps: { none: { stepType: 'UPDATE_ANALYSIS', isActive: true } } };

  if (ticketSource) {
    const sourceRoutes = await db.ticketRoute.findMany({
      where: {
        isActive: true,
        isDefault: false,
        routeType: 'ANALYSIS',
        summary: { not: null },
        source: ticketSource,
        ...excludeReanalysis,
        ...clientFilter,
      } as never,
      include: includeSteps,
      orderBy: { sortOrder: 'asc' },
    });
    candidateRoutes = sourceRoutes.filter((r) => r.steps.length > 0 && r.summary);
  }

  if (candidateRoutes.length === 0) {
    const anySourceRoutes = await db.ticketRoute.findMany({
      where: {
        isActive: true,
        isDefault: false,
        routeType: 'ANALYSIS',
        summary: { not: null },
        source: null,
        ...excludeReanalysis,
        ...clientFilter,
      } as never,
      include: includeSteps,
      orderBy: { sortOrder: 'asc' },
    });
    candidateRoutes = anySourceRoutes.filter((r) => r.steps.length > 0 && r.summary);
  }

  if (candidateRoutes.length > 0) {
    const ticket = await db.ticket.findUnique({
      where: { id: ticketId },
      select: { subject: true, description: true, category: true, priority: true, summary: true },
    });

    if (ticket) {
      const routeList = candidateRoutes
        .map((r) => `- ID: ${r.id}\n  Name: ${r.name}\n  Summary: ${r.summary}`)
        .join('\n\n');

      const selectPrompt = [
        `Ticket subject: ${ticket.subject}`,
        ticket.description ? `Description: ${ticket.description}` : '',
        `Category: ${ticket.category ?? 'GENERAL'}`,
        `Priority: ${ticket.priority}`,
        ticket.summary ? `Triage summary: ${ticket.summary}` : '',
        '',
        'Available routes:',
        routeList,
      ].filter(Boolean).join('\n');

      try {
        const res = await ai.generate({
          taskType: TaskType.SELECT_ROUTE,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: selectPrompt,
          promptKey: 'routing.select-route.system',
        });

        const selectedId = res.content.trim();
        if (selectedId && selectedId !== 'NONE') {
          const selected = candidateRoutes.find((r) => r.id === selectedId);
          if (selected) {
            logger.info({ ticketId, routeId: selected.id, routeName: selected.name, source: 'ai_selection' }, 'Route resolved via AI selection');
            return selected;
          }
          logger.warn({ ticketId, selectedId }, 'AI selected an unknown route ID, falling through to default');
        }
      } catch (err) {
        logger.warn({ err, ticketId }, 'AI route selection failed, falling through to default');
      }
    }
  }

  // 4. Default route (source-specific first, then any-source)
  const defaultBaseWhere = {
    isDefault: true,
    isActive: true,
    routeType: 'ANALYSIS' as const,
    ...(clientId ? { OR: [{ clientId }, { clientId: null }] } : { clientId: null }),
  };

  if (ticketSource) {
    const sourceDefault = await db.ticketRoute.findFirst({
      where: { ...defaultBaseWhere, source: ticketSource } as never,
      include: includeSteps,
      orderBy: [{ clientId: 'desc' }, { sortOrder: 'asc' }],
    });
    if (sourceDefault && sourceDefault.steps.length > 0) {
      logger.info({ ticketId, routeId: sourceDefault.id, routeName: sourceDefault.name, source: 'default', ticketSource }, 'Route resolved via source-specific default route');
      return sourceDefault;
    }
  }

  const defaultRoute = await db.ticketRoute.findFirst({
    where: { ...defaultBaseWhere, source: null } as never,
    include: includeSteps,
    orderBy: [{ clientId: 'desc' }, { sortOrder: 'asc' }],
  });
  if (defaultRoute && defaultRoute.steps.length > 0) {
    logger.info({ ticketId, routeId: defaultRoute.id, routeName: defaultRoute.name, source: 'default' }, 'Route resolved via default route');
    return defaultRoute;
  }

  // 5. No route found — fall back to hardcoded pipeline
  logger.info({ ticketId }, 'No ticket route found, using hardcoded pipeline');
  return null;
}

// ---------------------------------------------------------------------------
// Agentic Analysis — tool definition builder, executor, and loop
// ---------------------------------------------------------------------------

interface McpIntegrationInfo {
  label: string;
  url: string;
  mcpPath?: string;
  apiKey?: string;
  authHeader?: string;
}

/**
 * Build Claude tool definitions from a client's active MCP_DATABASE integrations
 * and code repositories (via mcp-repo). MCP tool names are prefixed with the
 * integration label to disambiguate across servers (e.g. `prod-db__get_blocking_tree`).
 */
async function buildAgenticTools(
  db: PrismaClient,
  clientId: string,
  encryptionKey: string,
  mcpRepoUrl: string,
  apiKey?: string,
  mcpAuthToken?: string,
): Promise<{
  tools: AIToolDefinition[];
  mcpIntegrations: Map<string, McpIntegrationInfo>;
  repoIdByPrefix: Map<string, string>;
}> {
  const tools: AIToolDefinition[] = [];
  const mcpIntegrations = new Map<string, McpIntegrationInfo>();
  const repoIdByPrefix = new Map<string, string>();

  // Collect MCP_DATABASE integrations
  const integrations = await db.clientIntegration.findMany({
    where: { clientId, type: 'MCP_DATABASE', isActive: true },
  });

  for (const integ of integrations) {
    const cfg = integ.config as Record<string, unknown>;
    const meta = integ.metadata as Record<string, unknown> | null;
    const url = typeof cfg['url'] === 'string' ? cfg['url'] : '';
    if (!url) continue;

    // Decrypt API key if present
    let integApiKey: string | undefined;
    if (typeof cfg['apiKey'] === 'string' && cfg['apiKey']) {
      try {
        integApiKey = looksEncrypted(cfg['apiKey'])
          ? decrypt(cfg['apiKey'], encryptionKey)
          : cfg['apiKey'];
      } catch (err) {
        logger.warn({ err, integrationId: integ.id }, 'Failed to decrypt MCP API key, skipping integration');
        continue;
      }
    }

    const authHeader = typeof cfg['authHeader'] === 'string' ? cfg['authHeader'] : 'bearer';
    const labelSlug = integ.label.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const prefix = `${labelSlug}-${integ.id.slice(0, 8)}`;

    const mcpPath = typeof cfg['mcpPath'] === 'string' ? cfg['mcpPath'] : undefined;
    mcpIntegrations.set(prefix, { label: integ.label, url, mcpPath, apiKey: integApiKey, authHeader });

    // Read tool metadata — includes inputSchema from discovery
    const disabledTools = new Set(
      Array.isArray(cfg['disabledTools']) ? (cfg['disabledTools'] as string[]) : [],
    );
    const discoveredTools = Array.isArray(meta?.['tools']) ? meta['tools'] as Array<Record<string, unknown>> : [];
    for (const t of discoveredTools) {
      const name = typeof t['name'] === 'string' ? t['name'] : '';
      if (!name || disabledTools.has(name)) continue;
      const description = typeof t['description'] === 'string' ? t['description'] : '';
      const inputSchema = (t['inputSchema'] as Record<string, unknown>) ?? { type: 'object', properties: {} };

      tools.push({
        name: `${prefix}__${name}`,
        description: `[${integ.label}] ${description}`,
        input_schema: inputSchema,
      });
    }
  }

  // Discover mcp-repo tools for client repositories
  const repos = await db.codeRepo.findMany({ where: { clientId, isActive: true } });
  if (repos.length > 0) {
    // Resolve auth for mcp-repo — prefer MCP_AUTH_TOKEN, fall back to API_KEY
    const repoAuth = mcpAuthToken || apiKey;
    const repoAuthHeader = mcpAuthToken ? 'bearer' : 'x-api-key';

    // Register shared mcp-repo integration for list_repos and repo_cleanup
    mcpIntegrations.set('repo', { label: 'mcp-repo', url: mcpRepoUrl, mcpPath: '/mcp', apiKey: repoAuth, authHeader: repoAuthHeader });

    tools.push({
      name: 'repo__list_repos',
      description: 'List available code repositories registered for this client.',
      input_schema: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: 'Client ID to filter by' },
        },
        required: ['clientId'],
      },
    });

    tools.push({
      name: 'repo__repo_cleanup',
      description: 'Release a session\'s repository worktrees to free disk space.',
      input_schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session ID to clean up' },
        },
        required: ['sessionId'],
      },
    });

    // Register per-repo repo_exec tools with repoId baked in
    for (const repo of repos) {
      const prefix = `repo-${repo.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}-${repo.id.slice(0, 8)}`;
      repoIdByPrefix.set(prefix, repo.id);

      // Register this prefix to point at mcp-repo
      mcpIntegrations.set(prefix, { label: `repo:${repo.name}`, url: mcpRepoUrl, mcpPath: '/mcp', apiKey: repoAuth, authHeader: repoAuthHeader });

      // Build a modified input schema for repo_exec with repoId removed
      tools.push({
        name: `${prefix}__repo_exec`,
        description: `[${repo.name}] ${repo.description || 'Code repository'}. Execute a read-only shell command in a sandboxed worktree. Allowed: grep, find, cat, head, tail, ls, tree, diff, stat. Pipes to grep/sed/awk/sort allowed.`,
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute' },
            sessionId: { type: 'string', description: 'Session ID for worktree reuse (auto-generated if omitted)' },
          },
          required: ['command'],
        },
      });
    }
  }

  return { tools, mcpIntegrations, repoIdByPrefix };
}

/**
 * Execute a single tool call from the agentic loop.
 * Returns the tool result text and whether it was an error.
 */
async function executeAgenticToolCall(
  toolCall: AIToolUseBlock,
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  repoIdByPrefix: Map<string, string>,
  clientId?: string,
): Promise<{ toolUseId: string; result: string; isError: boolean }> {
  const { id: toolUseId, name, input } = toolCall;

  try {
    // MCP tool — parse prefix
    const sepIndex = name.indexOf('__');
    if (sepIndex === -1) {
      return { toolUseId, result: `Unknown tool: ${name}`, isError: true };
    }
    const prefix = name.slice(0, sepIndex);
    const actualToolName = name.slice(sepIndex + 2);
    const integration = mcpIntegrations.get(prefix);
    if (!integration) {
      return { toolUseId, result: `No MCP integration found for prefix "${prefix}"`, isError: true };
    }

    // For repo_exec, inject the baked-in repoId and clientId for defense-in-depth
    // For list_repos, inject clientId to prevent cross-client repo enumeration
    let toolInput = input;
    if (actualToolName === 'repo_exec') {
      const repoId = repoIdByPrefix.get(prefix);
      if (repoId) {
        toolInput = { ...input, repoId, ...(clientId ? { clientId } : {}) };
      }
    } else if (actualToolName === 'list_repos' && clientId) {
      toolInput = { ...input, clientId };
    }

    const result = await callMcpToolViaSdk(
      integration.url,
      integration.mcpPath,
      actualToolName,
      toolInput,
      integration.apiKey,
      integration.authHeader,
    );
    return { toolUseId, result, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolUseId, result: `Tool error: ${msg}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Orchestrated analysis helpers
// ---------------------------------------------------------------------------

const ORCHESTRATED_SYSTEM_PROMPT = `You are an expert DBA and systems analyst conducting a structured investigation.

You will investigate the issue step by step. On each iteration you receive:
- The ticket context and any client-specific knowledge (first iteration only)
- A "knowledge document" summarizing everything learned so far
- A prompt directing what to investigate next

Return a JSON object in a markdown code block with:
{
  "findings": "Markdown text summarizing what you've learned or concluded in this iteration",
  "tasks": [
    {
      "prompt": "A focused prompt for a sub-task",
      "tools": ["tool_name_1", "tool_name_2"],
      "model": "haiku|sonnet|opus"
    }
  ],
  "nextPrompt": "What should be investigated in the next iteration after these tasks complete",
  "done": false
}

Guidelines for task assignment:
- Use "haiku" for simple data gathering (fetching events, listing indexes, getting health stats)
- Use "sonnet" for moderate analysis (pattern recognition, correlation checking)
- Use "opus" for complex reasoning (root cause analysis, architecture decisions)
- Keep tasks focused — each task should have a clear, specific goal
- Maximum 5 tasks per iteration

CRITICAL: In the "tools" array, use EXACT tool names from the Available Tools list provided in the prompt. Do not abbreviate, rename, or invent tool names. Copy-paste the full tool name including any prefix (e.g. "ap-dbadmin-e5834180__run_query", not "run_query" or "run_sql_query"). If no available tool fits the task, leave the tools array empty and describe what data you need in the prompt text so the model can request it conversationally.

When you have enough information to provide a final analysis, set "done": true and include:
{
  "findings": "Final summary",
  "tasks": [],
  "nextPrompt": null,
  "done": true,
  "finalAnalysis": "Full detailed markdown analysis with root cause, evidence, recommendations..."
}

Include sufficiency evaluation in your final analysis using the ---SUFFICIENCY--- format.

Prior analysis runs (if any) may be summarized or referenced for historical context. Focus your investigation on the current run. Reference prior findings if relevant but don't repeat work already done.

Note: Full raw tool results from prior iterations are stored by the orchestrator but may not be included directly in this prompt. If you need to review specific historical or raw data, explicitly request it in a task prompt so it can be provided.`;

interface StrategistPlan {
  findings: string;
  tasks: Array<{ prompt: string; tools: string[]; model: string }>;
  nextPrompt: string | null;
  done: boolean;
  finalAnalysis?: string;
  parseError?: string;
}

function parseStrategistResponse(content: string): StrategistPlan {
  // Try to extract JSON from markdown code blocks first, then raw JSON
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : content.trim();

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      findings: typeof parsed['findings'] === 'string' ? parsed['findings'] : '',
      tasks: Array.isArray(parsed['tasks'])
        ? (parsed['tasks'] as Array<Record<string, unknown>>).map(t => ({
            prompt: typeof t['prompt'] === 'string' ? t['prompt'] : '',
            tools: Array.isArray(t['tools']) ? (t['tools'] as string[]) : [],
            model: typeof t['model'] === 'string' ? t['model'] : 'sonnet',
          }))
        : [],
      nextPrompt: typeof parsed['nextPrompt'] === 'string' ? parsed['nextPrompt'] : null,
      done: parsed['done'] === true,
      finalAnalysis: typeof parsed['finalAnalysis'] === 'string' ? parsed['finalAnalysis'] : undefined,
    };
  } catch (error) {
    logger.warn(
      { err: error, contentPreview: content.slice(0, 500) },
      'Failed to parse strategist JSON response; treating raw content as final analysis to avoid wasting iterations',
    );
    // Treat unparseable responses as done to avoid burning tokens on a retry loop.
    // The raw content is surfaced as the final analysis so no work is lost.
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      findings: content,
      tasks: [],
      nextPrompt: null,
      done: true,
      finalAnalysis: content,
      parseError: errMsg,
    };
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const normalizedSize = Number.isFinite(size) ? Math.floor(size) : NaN;
  if (!Number.isFinite(normalizedSize) || normalizedSize <= 0) {
    throw new Error(`chunkArray size must be a positive integer, got: ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += normalizedSize) {
    chunks.push(arr.slice(i, i + normalizedSize));
  }
  return chunks;
}

interface SubTaskResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: Array<{ tool: string; system?: string; input: Record<string, unknown>; output: string; durationMs: number }>;
}

/** Resolve the orchestrated model map from active Claude provider models.
 *  Maps short names (haiku/sonnet/opus) to the actual model IDs configured in the DB. */
async function resolveOrchestratedModelMap(db: PrismaClient): Promise<Record<string, string>> {
  const models = await db.aiProviderModel.findMany({
    where: { isActive: true, provider: { provider: 'CLAUDE' } },
    select: { model: true },
    orderBy: [{ model: 'asc' }],
  });
  const matches: Record<'haiku' | 'sonnet' | 'opus', string[]> = {
    haiku: [],
    sonnet: [],
    opus: [],
  };
  for (const { model } of models) {
    const lower = model.toLowerCase();
    if (lower.includes('haiku')) matches.haiku.push(model);
    else if (lower.includes('sonnet')) matches.sonnet.push(model);
    else if (lower.includes('opus')) matches.opus.push(model);
  }
  const map: Record<string, string> = {};
  for (const shortName of ['haiku', 'sonnet', 'opus'] as const) {
    const candidates = matches[shortName];
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      logger.warn(
        { shortName, candidates },
        'Multiple active Claude models matched orchestrated short name; using first from deterministic ordering',
      );
    }
    map[shortName] = candidates[0];
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tool resolution: exact → base-name → substring → fuzzy
// ---------------------------------------------------------------------------

interface ToolResolution {
  resolved: AIToolDefinition[];
  fuzzy: Map<string, Array<{ tool: AIToolDefinition; score: number }>>;
  unmatched: string[];
}

function resolveTaskTools(
  requestedNames: string[],
  availableTools: AIToolDefinition[],
): ToolResolution {
  const resolved: AIToolDefinition[] = [];
  const fuzzy = new Map<string, Array<{ tool: AIToolDefinition; score: number }>>();
  const unmatched: string[] = [];
  const resolvedSet = new Set<string>();

  // Normalize: trim whitespace and drop empty strings to prevent spurious substring matches
  const normalizedNames = requestedNames.map(n => n.trim()).filter(n => n.length > 0);

  for (const requested of normalizedNames) {
    // 1. Exact match
    const exact = availableTools.find(t => t.name === requested);
    if (exact) {
      if (!resolvedSet.has(exact.name)) {
        resolved.push(exact);
        resolvedSet.add(exact.name);
      }
      continue;
    }

    // 2. Base name exact (strip prefix before __) — only accept if unambiguous
    const baseNameMatches = availableTools.filter(
      t => (t.name.split('__').pop() ?? t.name) === requested,
    );
    if (baseNameMatches.length === 1) {
      const [baseName] = baseNameMatches;
      if (!resolvedSet.has(baseName.name)) {
        resolved.push(baseName);
        resolvedSet.add(baseName.name);
      }
      continue;
    }
    if (baseNameMatches.length > 1) {
      // Ambiguous base name — surface as fuzzy candidates rather than auto-selecting
      fuzzy.set(requested, baseNameMatches.slice(0, 3).map(tool => ({ tool, score: 1 })));
      continue;
    }

    // 3. Substring match on base name only — only accept if unambiguous
    const substringMatches = availableTools.filter(
      t => (t.name.split('__').pop() ?? t.name).includes(requested),
    );
    if (substringMatches.length === 1) {
      const [substring] = substringMatches;
      if (!resolvedSet.has(substring.name)) {
        resolved.push(substring);
        resolvedSet.add(substring.name);
      }
      continue;
    }
    if (substringMatches.length > 1) {
      // Ambiguous substring — fall through to fuzzy scoring
    }

    // 4. Fuzzy scoring
    const requestedWords = new Set(requested.toLowerCase().split(/[_-]/));
    const candidates: Array<{ tool: AIToolDefinition; score: number }> = [];

    for (const tool of availableTools) {
      const toolBase = (tool.name.split('__').pop() ?? tool.name).toLowerCase();
      const toolWords = new Set(toolBase.split(/[_-]/));

      // Jaccard similarity
      const intersection = new Set([...requestedWords].filter(w => toolWords.has(w)));
      const union = new Set([...requestedWords, ...toolWords]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;

      // Description match
      const descLower = (tool.description ?? '').toLowerCase();
      const reqWordArr = [...requestedWords];
      const descMatches = reqWordArr.filter(w => descLower.includes(w)).length;
      const descScore = reqWordArr.length > 0 ? descMatches / reqWordArr.length : 0;

      const score = jaccard * 0.7 + descScore * 0.3;
      if (score >= 0.3) {
        candidates.push({ tool, score });
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      fuzzy.set(requested, candidates.slice(0, 3));
    } else {
      unmatched.push(requested);
    }
  }

  return { resolved, fuzzy, unmatched };
}

/**
 * Sanitize a string to be safe for use as a filename component.
 * Only allows alphanumerics, dots, hyphens, and underscores; replaces all
 * other characters (including path separators) with underscores and trims
 * to 64 characters to prevent path traversal or excessively long filenames.
 */
function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

async function saveMcpToolArtifact(
  db: PrismaClient,
  ticketId: string,
  toolName: string,
  rawResult: string,
  storagePath: string,
  artifactId?: string,
): Promise<void> {
  try {
    let isJson = false;
    try { JSON.parse(rawResult); isJson = true; } catch { /* not JSON */ }
    const mimeType = isJson ? 'application/json' : 'text/plain';
    const ext = isJson ? 'json' : 'txt';
    const safeToolName = sanitizeFilenameSegment(toolName || 'unknown');
    const filename = `mcp-${safeToolName}-${Date.now()}-${randomUUID()}.${ext}`;
    const resolvedStorage = resolve(storagePath);
    const ticketDir = resolve(resolvedStorage, 'tickets', ticketId);
    const rel = relative(resolvedStorage, ticketDir);
    if (rel.startsWith('..') || rel === '') {
      logger.warn({ ticketId, ticketDir, resolvedStorage }, 'MCP artifact path escaped storage root — skipping');
      return;
    }
    const fullPath = join(ticketDir, filename);
    await mkdir(ticketDir, { recursive: true });
    await writeFile(fullPath, rawResult, 'utf-8');
    const relativePath = `tickets/${ticketId}/${filename}`;
    await db.artifact.create({
      data: {
        ...(artifactId ? { id: artifactId } : {}),
        ticketId,
        filename,
        mimeType,
        sizeBytes: Buffer.byteLength(rawResult, 'utf-8'),
        storagePath: relativePath,
        description: `Raw MCP tool output from agentic analysis (${toolName})`,
      },
    });
    logger.info({ ticketId, filename }, 'MCP tool artifact saved');
  } catch (err) {
    logger.warn({ err, ticketId }, 'Failed to save MCP tool artifact — continuing');
  }
}

// Signals indicating a sub-task result may be irrelevant (checked in first 500 chars)
const IRRELEVANT_SIGNALS = [
  'not relevant', 'unable to', 'cannot access', 'i cannot', "i don't have",
  'wrong tool', 'unexpected result', 'does not apply', 'no data returned',
  'tool returned an error',
];

async function executeOrchestratedSubTask(
  deps: AnalyzerDeps,
  ticketId: string,
  clientId: string,
  category: string,
  clientContext: string,
  environmentContext: string,
  task: { prompt: string; tools: string[]; model: string },
  agenticTools: AIToolDefinition[],
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  repoIdByPrefix: Map<string, string>,
  orchestration?: { id: string; iteration: number; parentLogId?: string },
  modelMap?: Record<string, string>,
): Promise<SubTaskResult> {
  const { ai } = deps;
  const map = modelMap ?? {};
  const model = map[task.model] ?? map.sonnet ?? 'claude-sonnet-4-6';
  const defaultMaxTokens = await deps.loadDefaultMaxTokens?.() ?? undefined;

  const toolCalls: SubTaskResult['toolCalls'] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  // If client/environment context was already injected into the strategist prompt, skip AIRouter
  // re-injection for sub-tasks to avoid duplicating it in every sub-task system prompt.
  const skipClientMemory = !!clientContext;
  const combinedContext = [clientContext, environmentContext].filter(Boolean).join('\n\n');
  const subTaskSystemPrompt = combinedContext
    ? `Execute the requested investigation step. Call the relevant tools, analyze the results, and return a structured summary of your findings.\n\n${combinedContext}`
    : 'Execute the requested investigation step. Call the relevant tools, analyze the results, and return a structured summary of your findings.';

  // Resolve tools using ranked matching (exact → base name → substring → fuzzy)
  const resolution = task.tools.length > 0
    ? resolveTaskTools(task.tools, agenticTools)
    : { resolved: [] as AIToolDefinition[], fuzzy: new Map<string, Array<{ tool: AIToolDefinition; score: number }>>(), unmatched: [] as string[] };

  // Build initial tool set: resolved + top fuzzy candidate per entry
  const initialTools = [...resolution.resolved];
  const initialToolNames = new Set(initialTools.map(t => t.name));
  const fuzzyUsed = new Map<string, { tool: AIToolDefinition; score: number; candidateIndex: number }>();

  for (const [reqName, candidates] of resolution.fuzzy) {
    if (candidates.length > 0 && !initialToolNames.has(candidates[0].tool.name)) {
      initialTools.push(candidates[0].tool);
      initialToolNames.add(candidates[0].tool.name);
      fuzzyUsed.set(reqName, { ...candidates[0], candidateIndex: 0 });
    }
  }

  // If tools were requested but none matched at all, return early with guidance
  if (task.tools.length > 0 && initialTools.length === 0) {
    const MAX_TOOLS_IN_ERROR = 10;
    const toolNames = agenticTools.map(t => t.name);
    const availableList = toolNames.length > MAX_TOOLS_IN_ERROR
      ? `${toolNames.slice(0, MAX_TOOLS_IN_ERROR).join(', ')} … (${toolNames.length - MAX_TOOLS_IN_ERROR} more)`
      : toolNames.join(', ');
    return {
      content: `Tool resolution failed: requested [${task.tools.join(', ')}] but no matching tools found. Available tools: [${availableList}]. Use exact tool names from this list.`,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
    };
  }

  /**
   * Run a sub-task with the given tool set and return the result plus
   * whether any "irrelevant" signals were detected.
   */
  async function runSubTaskPass(
    tools: AIToolDefinition[],
  ): Promise<{ result: SubTaskResult; seemsIrrelevant: boolean }> {
    const passToolCalls: SubTaskResult['toolCalls'] = [];
    let passInput = 0;
    let passOutput = 0;
    let hasToolError = false;

    if (tools.length > 0) {
      const subTaskLogId = randomUUID();
      const orchCtx = orchestration
        ? { orchestrationId: orchestration.id, orchestrationIteration: orchestration.iteration, isSubTask: true, logId: subTaskLogId, ...(orchestration.parentLogId ? { parentLogId: orchestration.parentLogId, parentLogType: 'ai' as const } : {}) }
        : { logId: subTaskLogId };
      const response = await ai.generateWithTools({
        taskType: TaskType.DEEP_ANALYSIS,
        context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory, ...orchCtx },
        messages: [{ role: 'user', content: task.prompt }],
        tools,
        systemPrompt: subTaskSystemPrompt,
        providerOverride: 'CLAUDE',
        modelOverride: model,
        maxTokens: defaultMaxTokens ?? 4096,
      });

      passInput += response.usage?.inputTokens ?? 0;
      passOutput += response.usage?.outputTokens ?? 0;

      const toolUseBlocks = response.contentBlocks.filter(
        (b): b is AIToolUseBlock => b.type === 'tool_use',
      );

      if (toolUseBlocks.length > 0) {
        const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];

        for (const toolUse of toolUseBlocks) {
          const start = Date.now();
          const result = await executeAgenticToolCall(toolUse, mcpIntegrations, repoIdByPrefix, clientId);
          const elapsed = Date.now() - start;
          passToolCalls.push({
            tool: toolUse.name,
            system: (toolUse.input as Record<string, unknown>)?.system_name as string | undefined,
            input: toolUse.input,
            output: result.result.slice(0, 500),
            durationMs: elapsed,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.result,
            ...(result.isError ? { is_error: true } : {}),
          });
          const artifactId = deps.artifactStoragePath && !result.isError ? randomUUID() : undefined;
          if (deps.artifactStoragePath && !result.isError) {
            void saveMcpToolArtifact(deps.db, ticketId, toolUse.name, result.result, deps.artifactStoragePath, artifactId).catch(error => {
              logger.warn({
                err: error,
                ticketId,
                toolName: toolUse.name,
              }, 'Failed to persist MCP tool artifact');
            });
          }
          if (result.isError) hasToolError = true;
          // Write AppLog for sub-task tool calls with lineage back to this sub-task's AI call
          appLog.info(
            `Sub-task tool call: ${toolUse.name} (${elapsed}ms)`,
            {
              ticketId,
              tool: toolUse.name,
              durationMs: elapsed,
              params: toolUse.input ? JSON.stringify(toolUse.input).slice(0, 1000) : null,
              resultPreview: result.result?.slice(0, 2000) ?? null,
              isError: result.isError ?? false,
              parentLogId: subTaskLogId,
              parentLogType: 'ai',
              ...(artifactId ? { artifactId } : {}),
            },
            ticketId,
            'ticket',
          );
        }

        const summaryLogId = randomUUID();
        const summaryOrchCtx = orchestration
          ? { orchestrationId: orchestration.id, orchestrationIteration: orchestration.iteration, isSubTask: true, logId: summaryLogId, parentLogId: subTaskLogId, parentLogType: 'ai' }
          : { logId: summaryLogId, parentLogId: subTaskLogId, parentLogType: 'ai' };
        const summaryResponse = await ai.generateWithTools({
          taskType: TaskType.DEEP_ANALYSIS,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory, ...summaryOrchCtx },
          messages: [
            { role: 'user', content: task.prompt },
            { role: 'assistant', content: response.contentBlocks },
            { role: 'user', content: toolResults as AIToolResultBlock[] },
          ],
          tools: [],
          systemPrompt: 'Summarize the tool results into a structured finding. Do not call additional tools.',
          providerOverride: 'CLAUDE',
          modelOverride: model,
          maxTokens: defaultMaxTokens ?? 4096,
        });

        passInput += summaryResponse.usage?.inputTokens ?? 0;
        passOutput += summaryResponse.usage?.outputTokens ?? 0;

        const summaryText = summaryResponse.contentBlocks
          .filter((b): b is AITextBlock => b.type === 'text')
          .map(b => b.text)
          .join('\n');

        const lowered = summaryText.slice(0, 500).toLowerCase();
        const hasIrrelevantSignal = IRRELEVANT_SIGNALS.some(s => lowered.includes(s));

        return {
          result: { content: summaryText, inputTokens: passInput, outputTokens: passOutput, toolCalls: passToolCalls },
          seemsIrrelevant: hasToolError || hasIrrelevantSignal,
        };
      }

      // No tool calls — just text response
      const textContent = response.contentBlocks
        .filter((b): b is AITextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const lowered = textContent.slice(0, 500).toLowerCase();
      const hasIrrelevantSignal = IRRELEVANT_SIGNALS.some(s => lowered.includes(s));

      return {
        result: { content: textContent, inputTokens: passInput, outputTokens: passOutput, toolCalls: passToolCalls },
        seemsIrrelevant: hasIrrelevantSignal,
      };
    }

    // No tools — pure analysis
    const pureLogId = randomUUID();
    const orchCtx = orchestration
      ? { orchestrationId: orchestration.id, orchestrationIteration: orchestration.iteration, isSubTask: true, logId: pureLogId, ...(orchestration.parentLogId ? { parentLogId: orchestration.parentLogId, parentLogType: 'ai' as const } : {}) }
      : { logId: pureLogId };
    const response = await ai.generate({
      taskType: TaskType.DEEP_ANALYSIS,
      context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory, ...orchCtx },
      prompt: task.prompt,
      providerOverride: 'CLAUDE',
      modelOverride: model,
      maxTokens: 4096,
    });

    passInput += response.usage?.inputTokens ?? 0;
    passOutput += response.usage?.outputTokens ?? 0;

    return {
      result: { content: response.content, inputTokens: passInput, outputTokens: passOutput, toolCalls: [] },
      seemsIrrelevant: false,
    };
  }

  // --- First pass ---
  const firstPass = await runSubTaskPass(initialTools);
  inputTokens += firstPass.result.inputTokens;
  outputTokens += firstPass.result.outputTokens;
  toolCalls.push(...firstPass.result.toolCalls);

  // --- Retry with alternate fuzzy candidates if first pass seems irrelevant ---
  if (firstPass.seemsIrrelevant && fuzzyUsed.size > 0) {
    // Try swapping in next candidate for each fuzzy-matched tool; return first non-irrelevant result
    let lastRetryResult: SubTaskResult | undefined;
    let lastRetryScore = 0;

    for (const [reqName, used] of fuzzyUsed) {
      const candidates = resolution.fuzzy.get(reqName);
      if (!candidates || candidates.length <= used.candidateIndex + 1) continue;

      const nextCandidate = candidates[used.candidateIndex + 1];
      const retryTools = initialTools
        .filter(t => t.name !== used.tool.name)
        .concat(nextCandidate.tool);

      const retryPass = await runSubTaskPass(retryTools);
      inputTokens += retryPass.result.inputTokens;
      outputTokens += retryPass.result.outputTokens;
      toolCalls.push(...retryPass.result.toolCalls);
      lastRetryResult = retryPass.result;
      lastRetryScore = nextCandidate.score;

      if (!retryPass.seemsIrrelevant) {
        return { content: retryPass.result.content, inputTokens, outputTokens, toolCalls };
      }
    }

    if (lastRetryResult !== undefined) {
      // All retries seemed irrelevant — use last retry result with warning
      return {
        content: `Warning: Tool match was uncertain (fuzzy match score: ${lastRetryScore.toFixed(2)}) — results may not be fully relevant.\n\n${lastRetryResult.content}`,
        inputTokens,
        outputTokens,
        toolCalls,
      };
    }

    // No alternate candidates available — return first pass with warning
    const topScore = [...fuzzyUsed.values()].reduce((max, v) => Math.max(max, v.score), 0);
    return {
      content: `Warning: Tool match was uncertain (fuzzy match score: ${topScore.toFixed(2)}) — results may not be fully relevant.\n\n${firstPass.result.content}`,
      inputTokens,
      outputTokens,
      toolCalls,
    };
  }

  return { content: firstPass.result.content, inputTokens, outputTokens, toolCalls };
}

// ---------------------------------------------------------------------------
// Route-driven pipeline execution
// ---------------------------------------------------------------------------

/** Maximum dispatch depth to guard against infinite route chaining loops. */
const MAX_DISPATCH_DEPTH = 2;

/** Context passed to the pipeline during re-analysis (reply-triggered). */
interface ReanalysisContext {
  /** Formatted markdown conversation history from all prior events. */
  conversationHistory: string;
  /** The raw reply text that triggered this re-analysis. */
  triggerReplyText: string;
  /** The ticket event ID that triggered this re-analysis (for metadata tracking). */
  triggerEventId?: string;
}

/** Pre-populated state passed into a dispatched route to avoid redundant work. */
interface PipelineInitialState {
  summary?: string;
  category?: string;
  priority?: string;
  facts?: {
    errorMessages?: string[];
    filesMentioned?: string[];
    servicesMentioned?: string[];
    databaseRelated?: boolean;
    keywords?: string[];
  };
  clientContext?: string;
  environmentContext?: string;
}

/**
 * Execute the ticket analysis pipeline using a resolved route.
 * Each step type maps to existing analyzer logic — the route controls
 * which steps run and in what order.
 *
 * @param initialState - Pre-populated state from a parent route (used when dispatched).
 * @param dispatchDepth - Current dispatch nesting depth (0 = top-level, guards against loops).
 * @param reanalysisCtx - Context for re-analysis (conversation history and trigger reply).
 */
async function executeRoutePipeline(
  deps: AnalyzerDeps,
  ctx: AnalysisContext,
  route: ResolvedRoute,
  bullmqJobId: string,
  initialState?: PipelineInitialState,
  dispatchDepth = 0,
  reanalysisCtx?: ReanalysisContext,
): Promise<void> {
  const { db, ai, mailer, mcpDatabaseUrl, senderSignature } = deps;
  const { ticketId, clientId, emailFrom, emailSubject, emailBody, emailMessageId } = ctx;

  // Resolve default max tokens from DB settings (fresh read per pipeline execution)
  const defaultMaxTokens = await deps.loadDefaultMaxTokens?.() ?? undefined;

  const safeName = sanitizeName(route.name);
  appLog.info(`Executing route "${safeName}" (${route.steps.length} steps)`, { ticketId, routeId: route.id, routeName: safeName }, ticketId, 'ticket');

  const pipelineStart = Date.now();
  let stepsSucceeded = 0;
  let stepsFailed = 0;
  let stepsSkipped = 0;
  let totalToolCalls = 0;

  // Shared state accumulated across steps — seed from initialState if dispatched
  let summary = initialState?.summary ?? '';
  let category = initialState?.category ?? 'GENERAL';
  let priority = initialState?.priority ?? 'MEDIUM';
  let recipientName = '';
  let facts: {
    errorMessages?: string[];
    filesMentioned?: string[];
    servicesMentioned?: string[];
    databaseRelated?: boolean;
    keywords?: string[];
  } = initialState?.facts ?? {};
  let clientContext = initialState?.clientContext ?? '';
  let environmentContext = initialState?.environmentContext ?? '';
  let codeContext: string[] = [];
  let dbContext = '';
  let analysis = '';
  const cleanups: Array<() => Promise<void>> = [];

  // Load ticket for current state
  let ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      client: { include: { repositories: { where: { isActive: true } } } },
      system: true,
    },
  });
  if (!ticket) {
    appLog.warn('Ticket not found for route execution — aborting', { ticketId }, ticketId, 'ticket');
    return;
  }

  // Only override from DB when no initialState was provided (top-level call)
  if (!initialState) {
    category = ticket.category ?? 'GENERAL';
    priority = ticket.priority;
  }

  // Steps to skip during re-analysis (triage was already done on initial analysis)
  const REANALYSIS_SKIP_STEPS = new Set<string>([
    RouteStepType.SUMMARIZE_EMAIL,
    RouteStepType.CATEGORIZE,
    RouteStepType.TRIAGE_PRIORITY,
    RouteStepType.GENERATE_TITLE,
    RouteStepType.DRAFT_RECEIPT,
  ]);

  try {
  for (const step of route.steps) {
    // During re-analysis, skip triage steps — they were already done
    if (reanalysisCtx && REANALYSIS_SKIP_STEPS.has(step.stepType)) {
      appLog.info(`Skipping step during re-analysis: ${step.name} (${step.stepType})`, { ticketId, stepType: step.stepType }, ticketId, 'ticket');
      stepsSkipped++;
      continue;
    }

    appLog.info(`Executing step: ${step.name} (${step.stepType})`, { ticketId, stepId: step.id, stepType: step.stepType }, ticketId, 'ticket');
    const stepStart = Date.now();

    switch (step.stepType) {
      case RouteStepType.SUMMARIZE_EMAIL: {
        if (!ctx.emailFrom) {
          appLog.info('Skipping SUMMARIZE_EMAIL — no email context', { ticketId }, ticketId, 'ticket');
          stepsSkipped++;
          break;
        }
        const promptKey = step.promptKeyOverride ?? 'imap.summarize.system';
        const taskType = (step.taskTypeOverride ?? TaskType.SUMMARIZE) as TaskType;
        const summaryRes = await ai.generate({
          taskType,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: `Summarize the following support email in 2-3 concise bullet points:\n\nSubject: ${emailSubject}\n\n${emailBody}`,
          promptKey,
        });
        summary = summaryRes.content;
        const summarizeDuration = Date.now() - stepStart;
        appLog.info(
          `Email summarized: ${summary.length} chars via ${summaryRes.provider}/${summaryRes.model} (${(summarizeDuration / 1000).toFixed(1)}s)`,
          { ticketId, summaryLength: summary.length, provider: summaryRes.provider, model: summaryRes.model, durationMs: summarizeDuration },
          ticketId, 'ticket',
        );
        stepsSucceeded++;
        break;
      }

      case RouteStepType.CATEGORIZE: {
        const promptKey = step.promptKeyOverride ?? 'imap.categorize.system';
        const taskType = (step.taskTypeOverride ?? TaskType.CATEGORIZE) as TaskType;
        const categorizeRes = await ai.generate({
          taskType,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: `Categorize this support request into exactly one of: DATABASE_PERF, BUG_FIX, FEATURE_REQUEST, SCHEMA_CHANGE, CODE_REVIEW, ARCHITECTURE, GENERAL.\n\nSubject: ${emailSubject}\n\n${emailBody}\n\nRespond with only the category name.`,
          promptKey,
        });
        const rawCategory = categorizeRes.content.trim().toUpperCase();
        const validCategories = ['DATABASE_PERF', 'BUG_FIX', 'FEATURE_REQUEST', 'SCHEMA_CHANGE', 'CODE_REVIEW', 'ARCHITECTURE', 'GENERAL'];
        category = validCategories.includes(rawCategory) ? rawCategory : 'GENERAL';
        await db.ticket.update({ where: { id: ticketId }, data: { category: category as TicketCategory } });
        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Categorized as ${category} via ${categorizeRes.provider}/${categorizeRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, category, provider: categorizeRes.provider, model: categorizeRes.model, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.TRIAGE_PRIORITY: {
        const promptKey = step.promptKeyOverride ?? 'imap.triage.system';
        const taskType = (step.taskTypeOverride ?? TaskType.TRIAGE) as TaskType;
        const triageRes = await ai.generate({
          taskType,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: `Assess the priority of this support request. Choose one of: LOW, MEDIUM, HIGH, CRITICAL.\n\nSubject: ${emailSubject}\n\n${emailBody}\n\nRespond with only the priority level.`,
          promptKey,
        });
        const rawPriority = triageRes.content.trim().toUpperCase();
        const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        priority = validPriorities.includes(rawPriority) ? rawPriority : 'MEDIUM';
        await db.ticket.update({ where: { id: ticketId }, data: { priority: priority as Priority } });

        // Record triage event
        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'AI_ANALYSIS',
            content: `**Triage Summary**\n\nCategory: ${category}\nPriority: ${priority}\n\n${summary}`,
            metadata: { phase: 'triage', category, priority, summary, routeId: route.id, routeName: route.name },
            actor: 'system:analyzer',
          },
        });
        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Triaged as ${priority} via ${triageRes.provider}/${triageRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, category, priority, provider: triageRes.provider, model: triageRes.model, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.GENERATE_TITLE: {
        const promptKey = step.promptKeyOverride?.trim() || undefined;
        const taskType = (step.taskTypeOverride ?? TaskType.GENERATE_TITLE) as TaskType;
        const contentForTitle = ctx.emailFrom
          ? `Subject: ${emailSubject}\n\n${emailBody.slice(0, 1000)}`
          : `${emailSubject}\n\n${emailBody.slice(0, 1000)}`;
        const titleRes = await ai.generate({
          taskType,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: `Output ONLY a concise ticket title, max 80 characters. No quotes, no preamble, no explanation — just the title text.\n\n${contentForTitle}`,
          ...(promptKey && { promptKey }),
        });
        let newTitle = titleRes.content.trim();
        // Strip conversational wrappers
        newTitle = newTitle.replace(/^["']|["']$/g, '');
        newTitle = newTitle.replace(/^(here'?s?\s+(a\s+)?(concise\s+)?ticket\s+title:?\s*)/i, '');
        newTitle = newTitle.replace(/^title:\s*/i, '');
        newTitle = newTitle.slice(0, 80);
        if (newTitle) {
          await db.ticket.update({ where: { id: ticketId }, data: { subject: newTitle } });
        }
        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Title generated: "${(newTitle || emailSubject).slice(0, 60)}" via ${titleRes.provider}/${titleRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, title: newTitle || emailSubject, provider: titleRes.provider, model: titleRes.model, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.DRAFT_RECEIPT: {
        if (!ctx.emailFrom) {
          appLog.info('Skipping DRAFT_RECEIPT — no email context', { ticketId }, ticketId, 'ticket');
          stepsSkipped++;
          break;
        }
        if (!recipientName) {
          recipientName = await resolveRecipientName(db, ticketId, emailFrom!, clientId);
        }
        const promptKey = step.promptKeyOverride ?? 'imap.draft-receipt.system';
        const taskType = (step.taskTypeOverride ?? TaskType.DRAFT_EMAIL) as TaskType;
        const draftRes = await ai.generate({
          taskType,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: [
            'Draft a short, professional email confirming receipt of a support request.',
            `Recipient name: ${recipientName}`,
            `Sender name (sign as): ${senderSignature}`,
            `Ticket ID: ${ticketId}`,
            `Subject: ${emailSubject}`,
            '', 'Issue summary:', summary, '',
            `Category: ${category}`, `Priority: ${priority}`, '',
            'The email should:',
            `- Address the recipient by their first name (derived from "${recipientName}")`,
            '- Confirm we received the request and created a ticket',
            '- Include the ticket ID for reference',
            '- Restate the summarized issue so they know we understood',
            '- Let them know we are analyzing and will follow up with findings',
            '- Be concise (under 150 words)',
            `- Sign off with the sender name: ${senderSignature}`,
          ].join('\n'),
          promptKey,
        });
        const receiptBody = draftRes.content;
        const references = await buildReferenceChain(db, ticketId, emailMessageId);

        const outboundMsgId = await sendReplyWithRetry(
          mailer,
          { to: emailFrom!, subject: emailSubject, body: receiptBody, inReplyTo: emailMessageId, references },
          { ticketId, db, clientId },
        );

        {
          const stepDuration = Date.now() - stepStart;
          if (outboundMsgId) {
            await db.ticketEvent.create({
              data: {
                ticketId,
                eventType: 'EMAIL_OUTBOUND',
                content: receiptBody,
                metadata: { type: 'receipt_confirmation', to: emailFrom!, subject: `Re: ${emailSubject}`, messageId: outboundMsgId, summary, category, priority },
                actor: 'system:analyzer',
              },
            });
            appLog.info(
              `Receipt email sent to ${emailFrom} via ${draftRes.provider}/${draftRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
              { ticketId, to: emailFrom, provider: draftRes.provider, model: draftRes.model, durationMs: stepDuration },
              ticketId, 'ticket',
            );
          } else {
            appLog.info(
              `Receipt email skipped (send blocked by loop guard) (${(stepDuration / 1000).toFixed(1)}s)`,
              { ticketId, to: emailFrom, durationMs: stepDuration },
              ticketId, 'ticket',
            );
            stepsSkipped++;
            break;
          }
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.LOAD_CLIENT_CONTEXT: {
        if (!clientId) {
          appLog.info('No client on ticket, skipping client context load', { ticketId }, ticketId, 'ticket');
          stepsSkipped++;
          break;
        }
        // `category` reflects the ticket's current category at the time this step runs.
        // If a CATEGORIZE step precedes this step in the route, `category` will already
        // be the AI-assigned category. If LOAD_CLIENT_CONTEXT runs before CATEGORIZE,
        // it uses the category already persisted on the ticket (or 'GENERAL' if unset).
        // Route designers should order CATEGORIZE before LOAD_CLIENT_CONTEXT to ensure
        // category-scoped memories are selected correctly.
        const memories = await db.clientMemory.findMany({
          where: { clientId, isActive: true },
          orderBy: { sortOrder: 'asc' },
        });
        // Filter by category: entries scoped to this ticket's category + entries with no category
        const relevant = memories.filter((m) => m.category === null || m.category === category);
        if (relevant.length > 0) {
          const sections = relevant.map((m) => {
            const label = m.memoryType === 'PLAYBOOK' ? 'Playbook'
              : m.memoryType === 'TOOL_GUIDANCE' ? 'Tool Guidance'
              : 'Context';
            return `### ${m.title} (${label})\n\n${m.content}`;
          });
          clientContext = `## Client Knowledge\n\n${sections.join('\n\n---\n\n')}`;
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Loaded ${relevant.length} client memory entries (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, entryCount: relevant.length, totalMemories: memories.length, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.LOAD_ENVIRONMENT_CONTEXT: {
        if (!ticket?.environmentId) {
          appLog.info('No environment on ticket, skipping environment context load', { ticketId }, ticketId, 'ticket');
          stepsSkipped++;
          break;
        }
        const environment = await db.clientEnvironment.findFirst({
          where: { id: ticket.environmentId, clientId },
          select: { name: true, tag: true, operationalInstructions: true },
        });
        if (environment?.operationalInstructions?.trim()) {
          const label = environment.tag ? `${environment.name} (${environment.tag})` : environment.name;
          environmentContext = `## Environment: ${label}\n\n${environment.operationalInstructions.trim()}`;
          appLog.info(
            `Loaded environment context for "${environment.name}"`,
            { ticketId, environmentId: ticket.environmentId },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.EXTRACT_FACTS: {
        const promptKey = step.promptKeyOverride ?? 'imap.extract-facts.system';
        const taskType = (step.taskTypeOverride ?? TaskType.EXTRACT_FACTS) as TaskType;
        const extractRes = await ai.generate({
          taskType,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: [
            'Extract structured facts from this support email. Return a JSON object with:',
            '- "errorMessages": array of error messages or stack traces mentioned',
            '- "filesMentioned": array of file paths or module names mentioned',
            '- "servicesMentioned": array of service/app names mentioned',
            '- "databaseRelated": boolean, true if the issue involves database queries, performance, or schema',
            '- "keywords": array of technical keywords for searching code',
            '', `Subject: ${emailSubject}`, '', emailBody,
          ].join('\n'),
          promptKey,
        });
        try {
          const cleaned = extractRes.content.replace(/```json\n?|\n?```/g, '').trim();
          facts = JSON.parse(cleaned);
        } catch {
          logger.warn({ ticketId }, 'Failed to parse extracted facts, continuing with defaults');
        }
        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Facts extracted: databaseRelated=${facts.databaseRelated ?? false}, ${facts.keywords?.length ?? 0} keywords, ${facts.errorMessages?.length ?? 0} errors via ${extractRes.provider}/${extractRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, databaseRelated: facts.databaseRelated, keywordCount: facts.keywords?.length ?? 0, errorCount: facts.errorMessages?.length ?? 0, provider: extractRes.provider, model: extractRes.model, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.GATHER_REPO_CONTEXT: {
        if (!ticket) break;
        // Query client repos via CodeRepo model
        const clientRepos = await db.codeRepo.findMany({ where: { clientId: ticket.clientId, isActive: true } });
        if (clientRepos.length === 0) break;

        const gatherSessionId = `gather-${ticketId}`;
        const mcpRepoUrl = deps.mcpRepoUrl;
        const repoAuth = deps.mcpAuthToken || deps.apiKey;
        const repoAuthHeader = deps.mcpAuthToken ? 'bearer' : 'x-api-key';

        for (const repo of clientRepos) {
          try {
            const searchTerms = [
              ...(facts.keywords ?? []),
              ...(facts.filesMentioned ?? []),
              ...(facts.errorMessages?.map((e) => e.slice(0, 60)) ?? []),
            ].slice(0, 5);

            const relevantFiles = new Set<string>();
            for (const rawTerm of searchTerms) {
              if (!rawTerm || rawTerm.replace(/[\x00-\x1f\x7f]/g, '').trim().length === 0) continue;
              const sanitized = rawTerm.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
              try {
                const grepResult = await callMcpToolViaSdk(
                  mcpRepoUrl, '/mcp', 'repo_exec',
                  { repoId: repo.id, sessionId: gatherSessionId, clientId: ticket.clientId, command: `grep -rnil "${sanitized.replace(/"/g, '\\"')}" .` },
                  repoAuth, repoAuthHeader,
                );
                // Parse file paths from stdout (skip the [session:...] line)
                const exts = ['.sql', '.cs', '.ts'];
                for (const line of grepResult.split('\n')) {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith('[session:') && !trimmed.startsWith('[stderr]') && exts.some(e => trimmed.endsWith(e))) {
                    relevantFiles.add(trimmed);
                  }
                }
              } catch { /* grep found nothing */ }
            }
            for (const f of facts.filesMentioned ?? []) {
              relevantFiles.add(f);
            }

            if (relevantFiles.size > 0) {
              const fileParts: string[] = [];
              let totalBytes = 0;
              for (const rawFp of relevantFiles) {
                if (totalBytes >= 60_000) break;
                const fp = sanitizeFilePath(rawFp);
                if (!fp) continue;
                try {
                  const catResult = await callMcpToolViaSdk(
                    mcpRepoUrl, '/mcp', 'repo_exec',
                    { repoId: repo.id, sessionId: gatherSessionId, clientId: ticket.clientId, command: `cat '${fp.replace(/'/g, "'\\''")}'` },
                    repoAuth, repoAuthHeader,
                  );
                  // Strip the [session:...] prefix line
                  const content = catResult.split('\n').filter(l => !l.startsWith('[session:')).join('\n');
                  const truncated = content.slice(0, 3000);
                  const formatted = `--- ${fp} ---\n${truncated}\n`;
                  fileParts.push(formatted);
                  totalBytes += formatted.length;
                } catch { /* file not found or unreadable */ }
              }
              if (fileParts.length > 0) {
                codeContext.push(`## Repository: ${repo.name}\n\n${fileParts.join('\n')}`);
              }
            }
          } catch (err) {
            const errMsg = redactUrls(err instanceof Error ? err.message : String(err));
            appLog.warn(`Repo context unavailable for ${repo.name}: ${errMsg}`, { ticketId, repo: repo.name, err }, ticketId, 'ticket');
          }
        }

        // Clean up the gather session worktrees
        try {
          await callMcpToolViaSdk(mcpRepoUrl, '/mcp', 'repo_cleanup', { sessionId: gatherSessionId }, repoAuth, repoAuthHeader);
        } catch { /* best effort */ }

        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Repo context gathered: ${clientRepos.length} repos checked, ${codeContext.length} with results (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, reposChecked: clientRepos.length, reposWithResults: codeContext.length, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.GATHER_DB_CONTEXT: {
        if (!facts.databaseRelated || !mcpDatabaseUrl || !ticket?.system) {
          stepsSkipped++;
          break;
        }
        {
          const mcpToolsCalled: string[] = [];
          let dbContextError = false;
          try {
            const healthResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_database_health', { systemId: ticket.system.id });
            dbContext += `## Database Health\n\n${healthResult}\n\n`;
            mcpToolsCalled.push('get_database_health');

            const sqlErrors = (facts.errorMessages ?? []).filter((e) =>
              /select|insert|update|delete|timeout|deadlock|block/i.test(e),
            );
            if (sqlErrors.length > 0) {
              const blockingResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_blocking_tree', { systemId: ticket.system.id });
              dbContext += `## Blocking Tree\n\n${blockingResult}\n\n`;
              mcpToolsCalled.push('get_blocking_tree');
              const waitResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_wait_stats', { systemId: ticket.system.id, topN: 10 });
              dbContext += `## Wait Stats\n\n${waitResult}\n\n`;
              mcpToolsCalled.push('get_wait_stats');
            }
          } catch (err) {
            appLog.warn(`MCP database context unavailable: ${err instanceof Error ? err.message : String(err)}`, { ticketId, err }, ticketId, 'ticket');
            dbContextError = true;
            stepsFailed++;
          }
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `DB context gathered: ${mcpToolsCalled.length} MCP tools called [${mcpToolsCalled.join(', ')}] (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, mcpToolsCalled, toolCount: mcpToolsCalled.length, durationMs: stepDuration },
            ticketId, 'ticket',
          );
          totalToolCalls += mcpToolsCalled.length;
          if (dbContextError) break;
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.DEEP_ANALYSIS: {
        // Determine task type — check step override, then category-based mapping, then default
        const categoryTaskMap: Record<string, typeof TaskType[keyof typeof TaskType]> = {
          BUG_FIX: TaskType.BUG_ANALYSIS,
          DATABASE_PERF: TaskType.ANALYZE_QUERY,
          FEATURE_REQUEST: TaskType.FEATURE_ANALYSIS,
          ARCHITECTURE: TaskType.ARCHITECTURE_REVIEW,
          SCHEMA_CHANGE: TaskType.SCHEMA_REVIEW,
          CODE_REVIEW: TaskType.REVIEW_CODE,
        };
        const analysisTaskType = (step.taskTypeOverride ?? categoryTaskMap[category] ?? TaskType.DEEP_ANALYSIS) as TaskType;
        const promptKey = step.promptKeyOverride ?? 'imap.deep-analysis.system';

        const analysisPrompt = [
          'Analyze this support issue and provide a clear diagnosis and recommended fix.',
          '', '## Issue', `Subject: ${emailSubject}`, `Category: ${category}`, `Priority: ${priority}`, '', emailBody, '',
          ...(clientContext ? [clientContext, ''] : []),
          ...(environmentContext ? [environmentContext, ''] : []),
          ...(codeContext.length > 0 ? ['## Relevant Source Code', '', ...codeContext, ''] : []),
          ...(dbContext ? ['## Database Information', '', dbContext, ''] : []),
          '', '## Instructions', 'Provide:',
          '1. **Root Cause**: What is likely causing this issue',
          '2. **Affected Components**: Which files/services/tables are involved',
          '3. **Recommended Fix**: Step-by-step fix with code snippets where applicable',
          '4. **Risk Assessment**: What could go wrong, what to test',
        ].join('\n');

        const analysisRes = await ai.generate({
          taskType: analysisTaskType,
          // clientContext is already injected into the user prompt above by the LOAD_CLIENT_CONTEXT step.
          // Set skipClientMemory to prevent AIRouter from also injecting it into the system prompt.
          // Pass ticketCategory so that if skipClientMemory is not set (e.g. no prior LOAD_CLIENT_CONTEXT
          // step in this route), the router still applies the correct category scoping.
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory: !!clientContext },
          prompt: analysisPrompt,
          promptKey,
        });
        analysis = analysisRes.content;

        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'AI_ANALYSIS',
            content: analysis,
            metadata: {
              phase: 'deep_analysis', taskType: analysisTaskType,
              aiProvider: analysisRes.provider, aiModel: analysisRes.model,
              durationMs: analysisRes.durationMs, usage: analysisRes.usage,
              routeId: route.id, routeName: route.name,
            },
            actor: 'system:analyzer',
          },
        });
        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Deep analysis complete (${analysisTaskType}) via ${analysisRes.provider}/${analysisRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, taskType: analysisTaskType, provider: analysisRes.provider, model: analysisRes.model, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.AGENTIC_ANALYSIS: {
        const stepConfig = step.config as { maxIterations?: unknown; systemPromptOverride?: string; analysisStrategy?: string } | null;
        let maxIterations = 10;
        if (stepConfig?.maxIterations !== undefined && stepConfig.maxIterations !== null) {
          const coerced = Number(stepConfig.maxIterations);
          if (Number.isFinite(coerced)) {
            maxIterations = Math.min(50, Math.max(1, Math.trunc(coerced)));
          }
        }

        // Reload ticket for repos
        ticket = await db.ticket.findUnique({
          where: { id: ticketId },
          include: { client: { include: { repositories: { where: { isActive: true } } } }, system: true },
        });
        if (!ticket || !ticket.client) {
          appLog.warn('Ticket or client not found for agentic analysis', { ticketId }, ticketId, 'ticket');
          break;
        }

        // Build tool definitions from MCP integrations and mcp-repo
        const { tools: agenticTools, mcpIntegrations, repoIdByPrefix } = await buildAgenticTools(
          db, ticket.clientId, deps.encryptionKey, deps.mcpRepoUrl, deps.apiKey, deps.mcpAuthToken,
        );

        if (agenticTools.length === 0) {
          appLog.info('No tools available for agentic analysis, skipping', { ticketId }, ticketId, 'ticket');
          break;
        }

        // ── Strategy check: orchestrated vs full_context ──
        const strategySetting = await db.appSetting.findUnique({ where: { key: 'system-config-analysis-strategy' } });
        const strategyConfig = strategySetting?.value as { strategy?: string; maxParallelTasks?: number } | null;
        const effectiveStrategy = stepConfig?.analysisStrategy ?? strategyConfig?.strategy ?? 'full_context';

        if (effectiveStrategy === 'orchestrated' && !reanalysisCtx) {
          // ── Orchestrated analysis loop ──
          const rawMaxParallelTasks = strategyConfig?.maxParallelTasks;
          let maxParallelTasks = 3;
          if (rawMaxParallelTasks !== undefined && rawMaxParallelTasks !== null) {
            const coerced = Number(rawMaxParallelTasks);
            if (Number.isFinite(coerced)) {
              maxParallelTasks = Math.min(10, Math.max(1, Math.trunc(coerced)));
            }
          }
          const orchModelMap = await resolveOrchestratedModelMap(db);
          const orchMaxIterations = maxIterations;
          const existingDoc = ticket.knowledgeDoc ?? '';
          const runTimestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
          const runNumber = (existingDoc.match(/## Analysis Run \d+/g) ?? []).length + 1;

          const currentRunHeader = `## Analysis Run ${runNumber} — ${runTimestamp}\n`;
          let knowledgeDoc = existingDoc
            ? `${existingDoc}\n\n---\n\n${currentRunHeader}`
            : currentRunHeader;
          let orchNextPrompt = '';
          let orchIterationsRun = 0;
          let orchFinalAnalysis = '';
          let orchTotalInputTokens = 0;
          let orchTotalOutputTokens = 0;
          const orchToolCallLog: Array<{ tool: string; system?: string; input: Record<string, unknown>; output: string; durationMs: number }> = [];

          // Build the initial context for the strategist
          const ticketContext = [
            `## Ticket`,
            `Subject: ${emailSubject}`,
            `Category: ${category}`,
            `Priority: ${priority}`,
            '', emailBody,
          ].join('\n');
          const contextParts: string[] = [ticketContext];
          if (summary) contextParts.push(`\n## Summary\n${summary}`);
          if (clientContext) contextParts.push(`\n${clientContext}`);
          if (environmentContext) contextParts.push(`\n${environmentContext}`);
          if (facts.keywords?.length) contextParts.push(`\n## Key Terms\n${facts.keywords.join(', ')}`);
          if (dbContext) contextParts.push(`\n## DB Context\n${dbContext}`);
          if (codeContext.length > 0) contextParts.push(`\n## Code Context\n${codeContext.join('\n')}`);

          const availableToolNames = agenticTools.map(t => t.name);
          const toolListSection = `\n## Available Tools\n${availableToolNames.join(', ')}`;
          contextParts.push(toolListSection);

          // Build truncated prior-run context for the strategist prompt (max 2000 chars)
          let priorRunsContext = '';
          if (existingDoc) {
            priorRunsContext = existingDoc.length > 2000
              ? `[Prior analysis truncated — full history available in the Knowledge tab]\n\n…${existingDoc.slice(-2000)}`
              : existingDoc;
          }

          for (let i = 0; i < orchMaxIterations; i++) {
            orchIterationsRun = i + 1;
            const orchestrationId = randomUUID();
            appLog.info(`Orchestrated analysis iteration ${i + 1}/${orchMaxIterations}`, { ticketId, iteration: i + 1, orchestrationId }, ticketId, 'ticket');

            // Extract only the current run content (after the run header) for the strategist
            const currentRunStart = knowledgeDoc.lastIndexOf(currentRunHeader);
            const currentRunContent = currentRunStart >= 0
              ? knowledgeDoc.slice(currentRunStart)
              : knowledgeDoc;

            let strategistPrompt: string;
            if (i === 0) {
              const priorNote = priorRunsContext
                ? `\n\n## Prior Analysis Runs (for context)\n${priorRunsContext}\n\n---\n\n`
                : '';
              strategistPrompt = `Investigate this ticket. Here is the full context:\n\n${contextParts.join('\n')}${priorNote}`;
            } else {
              strategistPrompt = `Continue the investigation. Here is the knowledge document so far:\n\n${currentRunContent}\n\n## Next Investigation Step\n${orchNextPrompt}`;
            }

            const strategistLogId = randomUUID();
            const strategistResponse = await ai.generate({
              taskType: (step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS) as TaskType,
              context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory: !!clientContext, orchestrationId, orchestrationIteration: i + 1, logId: strategistLogId },
              prompt: strategistPrompt,
              systemPrompt: ORCHESTRATED_SYSTEM_PROMPT,
              providerOverride: 'CLAUDE',
              modelOverride: 'claude-opus-4-6',
              maxTokens: defaultMaxTokens ?? 4096,
            });

            orchTotalInputTokens += strategistResponse.usage?.inputTokens ?? 0;
            orchTotalOutputTokens += strategistResponse.usage?.outputTokens ?? 0;

            const plan = parseStrategistResponse(strategistResponse.content);

            if (plan.parseError) {
              appLog.error(
                `Strategist JSON parse failed: ${plan.parseError}. Raw content used as final analysis.`,
                { ticketId, iteration: i + 1, error: plan.parseError },
                ticketId, 'ticket',
              );
            }

            knowledgeDoc += `\n\n### Iteration ${i + 1}\n${plan.findings}`;

            await db.ticket.update({ where: { id: ticketId }, data: { knowledgeDoc } });

            appLog.info(
              `Orchestrated iteration ${i + 1}: ${plan.tasks.length} tasks, done=${plan.done}`,
              { ticketId, iteration: i + 1, taskCount: plan.tasks.length, done: plan.done },
              ticketId, 'ticket',
            );

            if (plan.done) {
              orchFinalAnalysis = plan.finalAnalysis ?? plan.findings;
              break;
            }

            orchNextPrompt = plan.nextPrompt ?? '';

            // Execute tasks in parallel batches
            const taskBatches = chunkArray(plan.tasks, maxParallelTasks);
            for (const batch of taskBatches) {
              const results = await Promise.allSettled(
                batch.map(task => executeOrchestratedSubTask(deps, ticketId, clientId, category, clientContext, environmentContext, task, agenticTools, mcpIntegrations, repoIdByPrefix, { id: orchestrationId, iteration: i + 1, parentLogId: strategistLogId }, orchModelMap)),
              );

              for (let j = 0; j < results.length; j++) {
                const result = results[j];
                const task = batch[j];
                if (result.status === 'fulfilled') {
                  knowledgeDoc += `\n\n#### ${task.prompt}\n${result.value.content}`;
                  orchTotalInputTokens += result.value.inputTokens;
                  orchTotalOutputTokens += result.value.outputTokens;
                  orchToolCallLog.push(...result.value.toolCalls);
                } else {
                  // Retry once on failure
                  try {
                    const retryResult = await executeOrchestratedSubTask(deps, ticketId, clientId, category, clientContext, environmentContext, task, agenticTools, mcpIntegrations, repoIdByPrefix, { id: orchestrationId, iteration: i + 1, parentLogId: strategistLogId }, orchModelMap);
                    knowledgeDoc += `\n\n#### ${task.prompt} (retry)\n${retryResult.content}`;
                    orchTotalInputTokens += retryResult.inputTokens;
                    orchTotalOutputTokens += retryResult.outputTokens;
                    orchToolCallLog.push(...retryResult.toolCalls);
                  } catch (retryErr) {
                    knowledgeDoc += `\n\n#### ${task.prompt}\n*Failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}*`;
                    appLog.warn(`Orchestrated task failed after retry: ${task.prompt}`, { ticketId, task: task.prompt, err: retryErr }, ticketId, 'ticket');
                  }
                }
              }

              await db.ticket.update({ where: { id: ticketId }, data: { knowledgeDoc } });
            }
          }

          if (!orchFinalAnalysis) {
            orchFinalAnalysis = 'Orchestrated analysis reached maximum iterations without a final conclusion. Review the knowledge document for partial findings.';
          }

          // Parse sufficiency evaluation from the final analysis
          const { analysis: cleanOrchAnalysis, evaluation: orchSufficiency } = parseSufficiencyEvaluation(orchFinalAnalysis);
          analysis = cleanOrchAnalysis;
          ctx.sufficiencyEval = orchSufficiency;

          // Compute cost
          const orchCostAgg = await db.aiUsageLog.aggregate({
            where: { entityId: ticketId, entityType: 'ticket', createdAt: { gte: new Date(stepStart) } },
            _sum: { costUsd: true },
          });
          const orchTotalCostUsd = orchCostAgg._sum.costUsd ?? 0;

          // Store AI_ANALYSIS event
          await db.ticketEvent.create({
            data: {
              ticketId,
              eventType: 'AI_ANALYSIS',
              content: analysis,
              metadata: JSON.parse(JSON.stringify({
                phase: 'orchestrated_analysis',
                taskType: step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS,
                iterationsRun: orchIterationsRun,
                toolCallCount: orchToolCallLog.length,
                maxIterations: orchMaxIterations,
                toolCalls: orchToolCallLog,
                totalUsage: { inputTokens: orchTotalInputTokens, outputTokens: orchTotalOutputTokens },
                totalCostUsd: orchTotalCostUsd,
                routeId: route.id,
                routeName: route.name,
                sufficiencyStatus: orchSufficiency.status,
                sufficiencyQuestions: orchSufficiency.questions,
                sufficiencyConfidence: orchSufficiency.confidence,
                sufficiencyReason: orchSufficiency.reason,
              })),
              actor: 'system:analyzer',
            },
          });

          // Update ticket sufficiency status
          const orchSuffUpdate: Prisma.TicketUpdateInput = { sufficiencyStatus: orchSufficiency.status };
          if (orchSufficiency.status === SufficiencyStatus.NEEDS_USER_INPUT) {
            orchSuffUpdate.status = 'WAITING';
            orchSuffUpdate.resolvedAt = null;
          }
          await db.ticket.update({ where: { id: ticketId }, data: orchSuffUpdate });

          {
            const stepDuration = Date.now() - stepStart;
            appLog.info(
              `Orchestrated analysis complete: ${orchToolCallLog.length} tool calls, ${orchIterationsRun} iterations, sufficiency=${orchSufficiency.status} (${(stepDuration / 1000).toFixed(1)}s)`,
              { ticketId, toolCalls: orchToolCallLog.length, iterations: orchIterationsRun, sufficiencyStatus: orchSufficiency.status, sufficiencyConfidence: orchSufficiency.confidence, durationMs: stepDuration },
              ticketId, 'ticket',
            );
            totalToolCalls += orchToolCallLog.length;
          }
          stepsSucceeded++;
          break;
        }

        // ── Full-context agentic loop (existing behavior) ──

        // Build system prompt with all available context
        const systemParts: string[] = [];

        if (reanalysisCtx) {
          // Re-analysis: conversation-aware system prompt
          systemParts.push(
            'You are an expert support engineer continuing an investigation on a ticket.',
            'The user has replied to your previous analysis with new instructions or questions.',
            'Follow their instructions. They may: ask you to investigate further, approve a fix (use the repo tools to make changes if applicable),',
            'ask clarifying questions, or request the analysis be emailed to someone else.',
            'Use the available tools as needed to fulfill the user\'s request.',
            '',
            `## Ticket`,
            `Subject: ${emailSubject}`,
            `Category: ${category}`,
            `Priority: ${priority}`,
            '',
            '## Conversation History',
            '',
            reanalysisCtx.conversationHistory,
          );
        } else {
          // Initial analysis: standard system prompt
          systemParts.push(
            'You are an expert support engineer investigating a ticket.',
            'Use the available tools to gather information needed for a thorough analysis.',
            'Query databases for health data, blocking, wait stats, and schema info.',
            'Search and read code repositories for relevant source code.',
            'When you have gathered enough information, provide your final analysis with:',
            '1. **Root Cause**: What is likely causing this issue',
            '2. **Evidence**: What tool results support your diagnosis',
            '3. **Affected Components**: Which files/services/tables are involved',
            '4. **Recommended Fix**: Step-by-step fix with code snippets where applicable',
            '5. **Risk Assessment**: What could go wrong, what to test',
            '',
            `## Ticket`,
            `Subject: ${emailSubject}`,
            `Category: ${category}`,
            `Priority: ${priority}`,
            '', emailBody,
          );
        }

        if (summary) systemParts.push('', `## Summary`, summary);
        if (clientContext) systemParts.push('', clientContext);
        if (environmentContext) systemParts.push('', environmentContext);
        if (facts.keywords?.length) systemParts.push('', `## Key Terms`, facts.keywords.join(', '));
        if (codeContext.length > 0) systemParts.push('', '## Previously Gathered Code Context', ...codeContext);
        if (dbContext) systemParts.push('', '## Previously Gathered DB Context', dbContext);
        if (stepConfig?.systemPromptOverride) systemParts.push('', stepConfig.systemPromptOverride);
        systemParts.push(SUFFICIENCY_EVAL_INSTRUCTIONS);

        const agenticSystemPrompt = systemParts.join('\n');

        // Agentic loop — use the reply text as the user message during re-analysis
        const initialUserMessage = reanalysisCtx
          ? reanalysisCtx.triggerReplyText || 'The user replied to the previous analysis. Please review the conversation history and continue the investigation.'
          : 'Investigate this ticket using the available tools. Query databases, search code, and read files as needed to understand the issue. When you have enough information, provide your final analysis.';
        const messages: AIMessage[] = [
          { role: 'user', content: initialUserMessage },
        ];
        const toolCallLog: Array<{ tool: string; system?: string; input: Record<string, unknown>; output: string; durationMs: number }> = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        let finalAnalysis = '';
        let iterationsRun = 0;
        let previousAiCallId: string | undefined;
        for (let i = 0; i < maxIterations; i++) {
          iterationsRun = i + 1;
          const aiCallId = randomUUID();
          appLog.info(`Agentic analysis iteration ${i + 1}/${maxIterations}`, { ticketId, iteration: i + 1 }, ticketId, 'ticket');

          let response: AIToolResponse;
          try {
            response = await ai.generateWithTools({
              taskType: (step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS) as TaskType,
              systemPrompt: agenticSystemPrompt,
              tools: agenticTools,
              messages,
              context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory: !!(clientContext || environmentContext), logId: aiCallId, ...(previousAiCallId ? { parentLogId: previousAiCallId, parentLogType: 'ai' as const } : {}) },
              maxTokens: defaultMaxTokens ?? 4096,
            });
          } catch (error) {
            if (error instanceof Error && /tool/i.test(error.message) && /support/i.test(error.message)) {
              appLog.error(
                'Agentic analysis skipped: AI provider does not support tool use',
                { ticketId, iteration: i + 1, error: error.message },
                ticketId,
                'ticket',
              );
              finalAnalysis = '';
              break;
            }
            throw error;
          }

          totalInputTokens += response.usage?.inputTokens ?? 0;
          totalOutputTokens += response.usage?.outputTokens ?? 0;

          // Append assistant response to conversation
          messages.push({ role: 'assistant', content: response.contentBlocks });

          if (response.stopReason !== 'tool_use') {
            // Claude finished — extract final text
            finalAnalysis = response.contentBlocks
              .filter((b): b is AITextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
            break;
          }

          // Execute tool calls
          const toolUseBlocks = response.contentBlocks.filter(
            (b): b is AIToolUseBlock => b.type === 'tool_use',
          );

          // Log Claude's reasoning from the response (text blocks alongside tool_use)
          const reasoningText = response.contentBlocks
            .filter((b): b is AITextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();

          if (reasoningText) {
            appLog.info(
              `Agentic reasoning (iteration ${i + 1}): ${reasoningText.slice(0, 200)}`,
              {
                ticketId,
                iteration: i + 1,
                reasoning: reasoningText.slice(0, 2000),
                toolsRequested: toolUseBlocks.map(t => t.name),
              },
              ticketId,
              'ticket',
            );
          }

          const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];

          for (const toolUse of toolUseBlocks) {
            const start = Date.now();
            const result = await executeAgenticToolCall(toolUse, mcpIntegrations, repoIdByPrefix, clientId);
            const elapsed = Date.now() - start;
            toolCallLog.push({
              tool: toolUse.name,
              system: (toolUse.input as Record<string, unknown>)?.system_name as string | undefined,
              input: toolUse.input,
              output: result.result.slice(0, 500), // truncate for metadata
              durationMs: elapsed,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result.result,
              ...(result.isError ? { is_error: true } : {}),
            });
            const agenticArtifactId = deps.artifactStoragePath && !result.isError ? randomUUID() : undefined;
            if (deps.artifactStoragePath && !result.isError) {
              void saveMcpToolArtifact(deps.db, ticketId, toolUse.name, result.result, deps.artifactStoragePath, agenticArtifactId).catch(error => {
                logger.warn({
                  err: error,
                  ticketId,
                  toolName: toolUse.name,
                }, 'Failed to persist MCP tool artifact');
              });
            }
            appLog.info(
              `Agentic tool call: ${toolUse.name} (${elapsed}ms)`,
              {
                ticketId,
                tool: toolUse.name,
                durationMs: elapsed,
                iteration: i + 1,
                params: toolUse.input ? JSON.stringify(toolUse.input).slice(0, 1000) : null,
                resultPreview: result.result?.slice(0, 2000) ?? null,
                isError: result.isError ?? false,
                parentLogId: aiCallId,
                parentLogType: 'ai',
                ...(agenticArtifactId ? { artifactId: agenticArtifactId } : {}),
              },
              ticketId,
              'ticket',
            );
          }

          // Append tool results as user message
          messages.push({ role: 'user', content: toolResults as AIToolResultBlock[] });
          previousAiCallId = aiCallId;
        }

        if (!finalAnalysis) {
          finalAnalysis = 'Agentic analysis reached maximum iterations without a final conclusion. Review the tool call log for partial findings.';
        }

        // Parse sufficiency evaluation from the analysis response
        const { analysis: cleanAnalysis, evaluation: sufficiency } = parseSufficiencyEvaluation(finalAnalysis);
        analysis = cleanAnalysis;

        // Store sufficiency questions in pipeline context so DRAFT_FINDINGS_EMAIL can include them
        ctx.sufficiencyEval = sufficiency;

        // Compute total cost from AI usage logs for this specific analysis run
        const costAgg = await db.aiUsageLog.aggregate({
          where: {
            entityId: ticketId,
            entityType: 'ticket',
            createdAt: { gte: new Date(stepStart) },
          },
          _sum: { costUsd: true },
        });
        const totalCostUsd = costAgg._sum.costUsd ?? 0;

        // Store as AI_ANALYSIS event with tool call log and sufficiency in metadata
        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'AI_ANALYSIS',
            content: analysis,
            metadata: JSON.parse(JSON.stringify({
              phase: 'agentic_analysis',
              taskType: step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS,
              iterationsRun,
              toolCallCount: toolCallLog.length,
              maxIterations,
              toolCalls: toolCallLog,
              totalUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
              totalCostUsd,
              routeId: route.id,
              routeName: route.name,
              sufficiencyStatus: sufficiency.status,
              sufficiencyQuestions: sufficiency.questions,
              sufficiencyConfidence: sufficiency.confidence,
              sufficiencyReason: sufficiency.reason,
            })),
            actor: 'system:analyzer',
          },
        });

        // Update ticket sufficiency status
        const suffTicketUpdate: Prisma.TicketUpdateInput = {
          sufficiencyStatus: sufficiency.status,
        };
        if (sufficiency.status === SufficiencyStatus.NEEDS_USER_INPUT) {
          suffTicketUpdate.status = 'WAITING';
          suffTicketUpdate.resolvedAt = null;
        }
        await db.ticket.update({ where: { id: ticketId }, data: suffTicketUpdate });

        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Agentic analysis complete: ${toolCallLog.length} tool calls, ${iterationsRun} iterations, sufficiency=${sufficiency.status} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, toolCalls: toolCallLog.length, iterations: iterationsRun, sufficiencyStatus: sufficiency.status, sufficiencyConfidence: sufficiency.confidence, durationMs: stepDuration },
            ticketId,
            'ticket',
          );
          totalToolCalls += toolCallLog.length;
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.UPDATE_ANALYSIS: {
        // Incremental analysis for replies — requires reanalysisCtx (conversation history + trigger reply).
        if (!reanalysisCtx) {
          appLog.warn(
            'UPDATE_ANALYSIS step requires reanalysisCtx but none was provided. This is likely a route configuration error; failing pipeline to avoid incomplete analysis.',
            { ticketId, routeId: route.id, stepType: RouteStepType.UPDATE_ANALYSIS },
            ticketId,
            'ticket',
          );
          throw new Error('UPDATE_ANALYSIS step requires reanalysis context (reanalysisCtx) but none was provided');
        }

        const updateTaskType = (step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS) as TaskType;

        // Load the ticket's prior sufficiency status to determine if re-evaluation is needed
        const priorTicket = await db.ticket.findUnique({
          where: { id: ticketId },
          select: { sufficiencyStatus: true, reanalysisCount: true },
        });
        const priorSufficiency = priorTicket?.sufficiencyStatus as SufficiencyStatus | null;
        const currentReanalysisCount = priorTicket?.reanalysisCount ?? 0;

        const updatePromptParts = [
          '## Prior Analysis Context',
          '',
          reanalysisCtx.conversationHistory,
          '',
          '## New Information from User',
          '',
          reanalysisCtx.triggerReplyText || '(No reply text available — the user replied but the content could not be extracted.)',
          '',
          '## Your Task',
          'Review the prior analysis in light of this new information. Report only:',
          '1. What conclusions have changed (and why)',
          '2. What gaps have been filled',
          '3. What open questions have been answered',
          '4. Any NEW questions or concerns raised by the reply',
          '',
          'If nothing has materially changed, say so briefly.',
        ];

        // Include accumulated pipeline context if available
        if (clientContext) updatePromptParts.push('', clientContext);
        if (environmentContext) updatePromptParts.push('', environmentContext);
        if (summary) updatePromptParts.push('', '## Ticket Summary', summary);

        // Add sufficiency evaluation instructions so the update also signals readiness
        updatePromptParts.push(SUFFICIENCY_EVAL_INSTRUCTIONS);

        const updateRes = await ai.generate({
          taskType: updateTaskType,
          context: {
            ticketId,
            clientId,
            entityId: ticketId,
            entityType: 'ticket',
            ticketCategory: category,
            skipClientMemory: !!(clientContext || environmentContext),
          },
          prompt: updatePromptParts.join('\n'),
          systemPrompt: 'You are reviewing a prior analysis in light of new information from the user. Focus on what has changed — do not repeat the full analysis. Be concise and specific.',
        });

        // Parse sufficiency from the update response
        const { analysis: cleanUpdate, evaluation: updateSufficiency } = parseSufficiencyEvaluation(updateRes.content);
        analysis = cleanUpdate;

        // Store sufficiency in pipeline context for downstream DRAFT_FINDINGS_EMAIL
        ctx.sufficiencyEval = updateSufficiency;

        // Diminishing returns guard: if still NEEDS_USER_INPUT after 3+ re-analysis cycles, escalate to INSUFFICIENT
        const effectiveSufficiency = (
          updateSufficiency.status === SufficiencyStatus.NEEDS_USER_INPUT && currentReanalysisCount >= 3
        )
          ? { ...updateSufficiency, status: SufficiencyStatus.INSUFFICIENT as SufficiencyStatus, reason: `Escalated to INSUFFICIENT after ${currentReanalysisCount} re-analysis cycles with no resolution` }
          : updateSufficiency;

        ctx.sufficiencyEval = effectiveSufficiency;

        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'AI_ANALYSIS',
            content: analysis,
            metadata: {
              type: 'update_analysis',
              triggerEventId: reanalysisCtx.triggerEventId ?? null,
              reanalysisCount: currentReanalysisCount,
              taskType: updateTaskType,
              aiProvider: updateRes.provider,
              aiModel: updateRes.model,
              durationMs: updateRes.durationMs,
              usage: updateRes.usage as Prisma.InputJsonValue,
              routeId: route.id,
              routeName: route.name,
              sufficiencyStatus: effectiveSufficiency.status,
              sufficiencyQuestions: effectiveSufficiency.questions,
              sufficiencyConfidence: effectiveSufficiency.confidence,
              sufficiencyReason: effectiveSufficiency.reason,
            },
            actor: 'system:analyzer',
          },
        });

        // Update ticket sufficiency status and adjust ticket status
        const updateSuffData: Prisma.TicketUpdateInput = {
          sufficiencyStatus: effectiveSufficiency.status,
        };
        if (effectiveSufficiency.status === SufficiencyStatus.SUFFICIENT && priorSufficiency !== SufficiencyStatus.SUFFICIENT) {
          // Transition from WAITING/NEEDS_USER_INPUT to IN_PROGRESS now that we have enough info
          updateSuffData.status = 'IN_PROGRESS';
          updateSuffData.resolvedAt = null;
        } else if (effectiveSufficiency.status === SufficiencyStatus.NEEDS_USER_INPUT) {
          updateSuffData.status = 'WAITING';
          updateSuffData.resolvedAt = null;
        }
        await db.ticket.update({ where: { id: ticketId }, data: updateSuffData });

        // If INSUFFICIENT after diminishing returns, create a system note for operator review
        if (effectiveSufficiency.status === SufficiencyStatus.INSUFFICIENT) {
          await db.ticketEvent.create({
            data: {
              ticketId,
              eventType: 'SYSTEM_NOTE',
              content: `Sufficiency evaluation: INSUFFICIENT after ${currentReanalysisCount} re-analysis cycles. This ticket requires manual operator review. Reason: ${effectiveSufficiency.reason}`,
              actor: 'system:analyzer',
            },
          });
          appLog.warn(
            `Sufficiency escalated to INSUFFICIENT after ${currentReanalysisCount} cycles`,
            { ticketId, reanalysisCount: currentReanalysisCount },
            ticketId,
            'ticket',
          );
        }

        // Regenerate ticket summary from recent events if conclusions changed
        if (analysis && analysis.length > 20) {
          await updateTicketSummary(deps, ticketId);
        }

        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Update analysis complete via ${updateRes.provider}/${updateRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, taskType: updateTaskType, provider: updateRes.provider, model: updateRes.model, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.CUSTOM_AI_QUERY: {
        const queryCfg = step.config as {
          prompt?: string;
          includeContext?: {
            ticket?: boolean;
            clientContext?: boolean;
            environmentContext?: boolean;
            codeContext?: boolean;
            dbContext?: boolean;
            facts?: boolean;
            analysis?: boolean;
          };
          mcpQueries?: Array<{ toolName: string; params?: Record<string, unknown> }>;
          repoSearches?: Array<{ repoName?: string; searchTerms?: string[]; filePaths?: string[] }>;
        } | null;

        if (!queryCfg?.prompt) {
          appLog.warn('CUSTOM_AI_QUERY step missing prompt config, skipping', { ticketId }, ticketId, 'ticket');
          stepsSkipped++;
          break;
        }

        const inc = queryCfg.includeContext ?? {};
        const promptParts: string[] = [];

        // Include selected prior pipeline context
        if (inc.ticket) {
          promptParts.push('## Ticket Info', `Subject: ${emailSubject}`, `Category: ${category}`, `Priority: ${priority}`, '', emailBody, '');
        }
        if (inc.clientContext && clientContext) {
          promptParts.push(clientContext, '');
        }
        if ((inc.environmentContext ?? inc.clientContext) && environmentContext) {
          promptParts.push(environmentContext, '');
        }
        if (inc.codeContext && codeContext.length > 0) {
          promptParts.push('## Code Context', '', ...codeContext, '');
        }
        if (inc.dbContext && dbContext) {
          promptParts.push('## Database Context', '', dbContext, '');
        }
        if (inc.facts) {
          promptParts.push('## Extracted Facts', '', JSON.stringify(facts, null, 2), '');
        }
        if (inc.analysis && analysis) {
          promptParts.push('## Prior Analysis', '', analysis, '');
        }

        // Gather fresh MCP context
        if (queryCfg.mcpQueries?.length && mcpDatabaseUrl && ticket?.system) {
          const freshMcpParts: string[] = [];
          for (const mq of queryCfg.mcpQueries) {
            try {
              // Apply systemId last so user-provided params cannot override it.
              const { systemId: _omit, ...safeParams } = (mq.params ?? {}) as Record<string, unknown>;
              const result = await callMcpTool(mcpUrl(mcpDatabaseUrl), mq.toolName, {
                ...safeParams,
                systemId: ticket.system.id,
              });
              freshMcpParts.push(`### ${mq.toolName}`, '', result, '');
              totalToolCalls++;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              appLog.warn(`CUSTOM_AI_QUERY MCP tool call failed: ${mq.toolName}: ${errMsg}`, { ticketId, tool: mq.toolName }, ticketId, 'ticket');
              freshMcpParts.push(`### ${mq.toolName}`, '', `(Error: ${errMsg})`, '');
            }
          }
          if (freshMcpParts.length > 0) {
            promptParts.push('## MCP Query Results', '', ...freshMcpParts);
          }
        }

        // Gather fresh repo context via mcp-repo
        if (queryCfg.repoSearches?.length) {
          const customRepos = await db.codeRepo.findMany({ where: { clientId, isActive: true } });
          if (customRepos.length > 0) {
            const freshRepoParts: string[] = [];
            const customSessionId = `custom-${ticketId}-${bullmqJobId}`;
            const customRepoAuth = deps.mcpAuthToken || deps.apiKey;
            const customRepoAuthHeader = deps.mcpAuthToken ? 'bearer' : 'x-api-key';
            for (const rs of queryCfg.repoSearches) {
              const targetRepos = rs.repoName
                ? customRepos.filter((r) => r.name === rs.repoName)
                : customRepos;

              for (const repo of targetRepos) {
                try {
                  const relevantFiles = new Set<string>();

                  // Search by terms (skip non-string entries from untyped JSON config)
                  for (const rawTerm of rs.searchTerms ?? []) {
                    if (typeof rawTerm !== 'string') continue;
                    const sanitized = rawTerm.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
                    if (!sanitized) continue;
                    try {
                      const grepResult = await callMcpToolViaSdk(
                        deps.mcpRepoUrl, '/mcp', 'repo_exec',
                        { repoId: repo.id, sessionId: customSessionId, clientId, command: `grep -rnil "${sanitized.replace(/"/g, '\\"')}" .` },
                        customRepoAuth, customRepoAuthHeader,
                      );
                      const exts = ['.sql', '.cs', '.ts'];
                      for (const line of grepResult.split('\n')) {
                        const trimmed = line.trim();
                        if (trimmed && !trimmed.startsWith('[session:') && !trimmed.startsWith('[stderr]') && exts.some(e => trimmed.endsWith(e))) {
                          relevantFiles.add(trimmed);
                        }
                      }
                    } catch { /* grep found nothing */ }
                  }

                  // Add explicit file paths, rejecting paths that could expose
                  // sensitive in-repo locations such as .git/config or dotfiles.
                  for (const f of (rs.filePaths ?? []).filter((v): v is string => typeof v === 'string')) {
                    const normalized = f.replace(/\\/g, '/').replace(/^\/+/, '');
                    const segments = normalized.split('/');
                    const isSafe =
                      !segments.some((seg) => seg.startsWith('.')) &&
                      !normalized.startsWith('.git/') &&
                      normalized !== '.git';
                    if (isSafe) relevantFiles.add(normalized);
                  }

                  if (relevantFiles.size > 0) {
                    const fileParts: string[] = [];
                    let totalBytes = 0;
                    for (const rawFp of relevantFiles) {
                      if (totalBytes >= 60_000) break;
                      const fp = sanitizeFilePath(rawFp);
                      if (!fp) continue;
                      try {
                        const catResult = await callMcpToolViaSdk(
                          deps.mcpRepoUrl, '/mcp', 'repo_exec',
                          { repoId: repo.id, sessionId: customSessionId, clientId, command: `cat '${fp.replace(/'/g, "'\\''")}'` },
                          customRepoAuth, customRepoAuthHeader,
                        );
                        const content = catResult.split('\n').filter(l => !l.startsWith('[session:')).join('\n');
                        const truncated = content.slice(0, 3000);
                        const formatted = `--- ${fp} ---\n${truncated}\n`;
                        fileParts.push(formatted);
                        totalBytes += formatted.length;
                      } catch { /* file not found or unreadable */ }
                    }
                    if (fileParts.length > 0) {
                      freshRepoParts.push(`### Repository: ${repo.name}`, '', fileParts.join('\n'), '');
                    }
                  }
                } catch (err) {
                  const errMsg = redactUrls(err instanceof Error ? err.message : String(err));
                  appLog.warn(`CUSTOM_AI_QUERY repo search failed for ${repo.name}: ${errMsg}`, { ticketId, repo: repo.name }, ticketId, 'ticket');
                }
              }
            }
            // Clean up session worktrees
            try { await callMcpToolViaSdk(deps.mcpRepoUrl, '/mcp', 'repo_cleanup', { sessionId: customSessionId }, customRepoAuth, customRepoAuthHeader); } catch { /* best effort */ }
            if (freshRepoParts.length > 0) {
              promptParts.push('## Fresh Repository Context', '', ...freshRepoParts);
            }
          }
        }

        // Append custom prompt last
        promptParts.push('## Instructions', '', queryCfg.prompt);

        const queryTaskType = (step.taskTypeOverride ?? TaskType.CUSTOM_AI_QUERY) as TaskType;
        const queryPromptKey = step.promptKeyOverride ?? undefined;

        const queryRes = await ai.generate({
          taskType: queryTaskType,
          // Skip AIRouter's automatic client-memory injection only when client context
          // was actually included in the prompt — not just when it happens to exist.
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory: !!(inc?.clientContext && clientContext) },
          prompt: promptParts.join('\n'),
          ...(queryPromptKey && { promptKey: queryPromptKey }),
        });

        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'AI_ANALYSIS',
            content: queryRes.content,
            metadata: {
              phase: 'custom_ai_query',
              taskType: queryTaskType,
              aiProvider: queryRes.provider,
              aiModel: queryRes.model,
              durationMs: queryRes.durationMs,
              usage: queryRes.usage,
              routeId: route.id,
              routeName: route.name,
              stepName: step.name,
              config: {
                includeContext: inc,
                mcpQueryCount: queryCfg.mcpQueries?.length ?? 0,
                repoSearchCount: queryCfg.repoSearches?.length ?? 0,
              },
            },
            actor: 'system:analyzer',
          },
        });
        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Custom AI query complete via ${queryRes.provider}/${queryRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, taskType: queryTaskType, stepName: step.name, provider: queryRes.provider, model: queryRes.model, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.DRAFT_FINDINGS_EMAIL: {
        if (!ctx.emailFrom) {
          appLog.info('Skipping DRAFT_FINDINGS_EMAIL — no email context', { ticketId }, ticketId, 'ticket');
          stepsSkipped++;
          break;
        }
        if (!recipientName) {
          recipientName = await resolveRecipientName(db, ticketId, emailFrom!, clientId);
        }
        const promptKey = step.promptKeyOverride ?? 'imap.draft-analysis-email.system';
        const taskType = (step.taskTypeOverride ?? TaskType.DRAFT_EMAIL) as TaskType;

        // Check if approaching re-analysis limit
        let loopGuardNote = '';
        if (reanalysisCtx) {
          const currentTicketForGuard = await db.ticket.findUnique({
            where: { id: ticketId },
            select: { reanalysisCount: true },
          });
          if (currentTicketForGuard && currentTicketForGuard.reanalysisCount >= MAX_REANALYSIS_COUNT) {
            loopGuardNote = '\n\nNote: This ticket has reached the maximum number of automated analysis cycles. Please review manually or reopen if further automated analysis is needed.';
          }
        }

        const needsUserInput = ctx.sufficiencyEval?.status === SufficiencyStatus.NEEDS_USER_INPUT;
        const suffQuestions = ctx.sufficiencyEval?.questions ?? [];

        const findingsPromptParts = [
          reanalysisCtx
            ? 'Draft a professional email sharing updated analysis findings in response to the user\'s reply on a support ticket.'
            : needsUserInput
              ? 'Draft a professional email sharing preliminary analysis findings and asking the user specific questions we need answered to continue.'
              : 'Draft a professional email sharing the analysis findings for a support ticket.',
          `Recipient name: ${recipientName}`,
          `Sender name (sign as): ${senderSignature}`,
          `Ticket ID: ${ticketId}`, `Subject: ${emailSubject}`, '',
          'Analysis findings:', analysis, '',
        ];
        if (needsUserInput && suffQuestions.length > 0) {
          findingsPromptParts.push(
            'IMPORTANT: The analysis is incomplete — we need the user to answer specific questions before we can propose a resolution.',
            'Include a clearly separated "Questions" section after the findings with these questions:',
            '',
            ...suffQuestions.map((q, i) => `${i + 1}. ${q}`),
            '',
            'Ask the user to reply with answers so we can continue the investigation.',
            '',
          );
        }
        findingsPromptParts.push(
          'The email should:',
          `- Address the recipient by their first name (derived from "${recipientName}")`,
          '- Reference the ticket ID',
        );
        if (reanalysisCtx) {
          findingsPromptParts.push('- Acknowledge the user\'s reply and address their specific request');
        }
        findingsPromptParts.push(
          '- Summarize the root cause clearly for a non-technical reader',
          '- Include the recommended fix steps',
          '- Note any risks or things to verify',
          '- Offer to discuss further if needed',
          '- Be professional but not overly formal',
          needsUserInput ? '- Keep it under 400 words (findings + questions)' : '- Keep it under 300 words',
          `- Sign off with the sender name: ${senderSignature}`,
        );
        if (loopGuardNote) {
          findingsPromptParts.push('', `IMPORTANT: Include this note at the end of the email: "${loopGuardNote.trim()}"`);
        }

        const findingsEmailRes = await ai.generate({
          taskType,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: findingsPromptParts.join('\n'),
          promptKey,
        });

        const findingsBody = findingsEmailRes.content;

        // For threading, find the most recent outbound message to reply to
        const lastOutboundEvent = await db.ticketEvent.findFirst({
          where: { ticketId, eventType: 'EMAIL_OUTBOUND' },
          orderBy: { createdAt: 'desc' },
        });
        const lastOutboundMsgId = (lastOutboundEvent?.metadata as Record<string, unknown> | null)?.messageId as string | undefined;
        const extraMsgIds = lastOutboundMsgId ? [lastOutboundMsgId] : [];
        const references = await buildReferenceChain(db, ticketId, emailMessageId, extraMsgIds);

        const outboundMsgId = await sendReplyWithRetry(
          mailer,
          { to: emailFrom!, subject: emailSubject, body: findingsBody, inReplyTo: lastOutboundMsgId ?? emailMessageId, references },
          { ticketId, db, clientId },
        );

        if (outboundMsgId) {
          await db.ticketEvent.create({
            data: {
              ticketId, eventType: 'EMAIL_OUTBOUND', content: findingsBody,
              metadata: {
                type: reanalysisCtx ? 'reanalysis_findings' : needsUserInput ? 'analysis_findings_with_questions' : 'analysis_findings',
                to: emailFrom!,
                subject: `Re: ${emailSubject}`,
                messageId: outboundMsgId,
                ...(needsUserInput && { sufficiencyQuestions: suffQuestions }),
              },
              actor: 'system:analyzer',
            },
          });
          // After sending findings:
          // - For needsUserInput, ensure the ticket is WAITING (AGENTIC_ANALYSIS should have set this already).
          // - Otherwise, avoid clobbering any existing status (e.g., IN_PROGRESS when sufficiency is SUFFICIENT).
          const ticketUpdateData: Prisma.TicketUpdateInput = needsUserInput
            ? { status: 'WAITING', resolvedAt: null }
            : { resolvedAt: null };
          await db.ticket.update({ where: { id: ticketId }, data: ticketUpdateData });
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `${reanalysisCtx ? 'Re-analysis' : 'Analysis'} findings email sent to ${emailFrom}${needsUserInput ? ' (with questions)' : ''} (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, to: emailFrom, reanalysis: !!reanalysisCtx, needsUserInput, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        } else {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `${reanalysisCtx ? 'Re-analysis' : 'Analysis'} findings email skipped (send blocked by loop guard) (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, to: emailFrom, reanalysis: !!reanalysisCtx, durationMs: stepDuration },
            ticketId, 'ticket',
          );
          stepsSkipped++;
          break;
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.SUGGEST_NEXT_STEPS: {
        // Re-use the existing next-steps logic from deepAnalysis
        // This calls the shared function which parses JSON actions and records
        // advisory suggestions as ticket events
        const promptKey = step.promptKeyOverride ?? 'imap.suggest-next-steps.system';
        const taskType = (step.taskTypeOverride ?? TaskType.SUGGEST_NEXT_STEPS) as TaskType;

        // Re-load current ticket state for accurate action execution
        const currentTicket = await db.ticket.findUnique({ where: { id: ticketId } });
        if (!currentTicket) break;

        const nextStepsRes = await ai.generate({
          taskType,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket' },
          prompt: [
            'Based on the analysis below, suggest 1-3 concrete next steps for resolving this ticket.',
            'You MUST respond with valid JSON only — an array of action objects.',
            '', `Ticket ID: ${ticketId}`, `Subject: ${emailSubject}`,
            `Category: ${currentTicket.category ?? 'GENERAL'}`, `Priority: ${currentTicket.priority}`,
            `Current status: ${currentTicket.status}`, '',
            'Analysis findings:', analysis, '',
            '## Available actions (use these exact "action" values)', '',
            '- { "action": "set_status", "value": "OPEN|IN_PROGRESS|WAITING|RESOLVED|CLOSED", "reason": "..." }',
            '- { "action": "set_priority", "value": "LOW|MEDIUM|HIGH|CRITICAL", "reason": "..." }',
            '- { "action": "set_category", "value": "DATABASE_PERF|BUG_FIX|FEATURE_REQUEST|SCHEMA_CHANGE|CODE_REVIEW|ARCHITECTURE|GENERAL", "reason": "..." }',
            '- { "action": "trigger_code_fix", "reason": "..." }',
            '- { "action": "send_followup_email", "reason": "..." }',
            '- { "action": "escalate_deep_analysis", "reason": "..." }',
            '- { "action": "check_database_health", "reason": "..." }',
            '- { "action": "add_comment", "value": "the comment text", "reason": "..." }',
            '', 'Only suggest actions that make sense. Respond with the JSON array only, no markdown fences.',
          ].join('\n'),
          promptKey,
        });

        // Parse and execute via the recommendation executor
        const { actions: nextActions } = parseNextStepsActions(ticketId, nextStepsRes.content);
        const execResults = nextActions.length > 0
          ? await executeRecommendations({ db, mailer }, ticketId, nextActions)
          : [];

        const autoExecCount = execResults.filter((r) => r.outcome === 'auto_executed').length;
        const pendingCount = execResults.filter((r) => r.outcome === 'pending_approval').length;

        // Build summary for the AI_RECOMMENDATION event
        const recParts: string[] = [];
        for (const r of execResults) {
          const prefix = r.outcome === 'auto_executed' ? 'Auto-executed' : r.outcome === 'pending_approval' ? 'Pending approval' : 'Skipped';
          recParts.push(`- ${prefix}: ${r.action}${r.value ? ` → ${r.value}` : ''}: ${r.reason}`);
        }

        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'AI_RECOMMENDATION',
            content: recParts.length > 0 ? recParts.join('\n') : nextStepsRes.content,
            metadata: {
              phase: 'next_steps',
              aiProvider: nextStepsRes.provider,
              aiModel: nextStepsRes.model,
              routeId: route.id,
              actions: execResults as unknown as Prisma.InputJsonValue,
              autoExecutedCount: autoExecCount,
              pendingCount,
              parsed: nextActions.length > 0,
            },
            actor: 'system:analyzer',
          },
        });

        const stepDuration = Date.now() - stepStart;
        appLog.info(
          `Next steps: ${autoExecCount} auto-executed, ${pendingCount} pending via ${nextStepsRes.provider}/${nextStepsRes.model} (${(stepDuration / 1000).toFixed(1)}s)`,
          { ticketId, autoExecutedCount: autoExecCount, pendingCount, provider: nextStepsRes.provider, model: nextStepsRes.model, durationMs: stepDuration },
          ticketId, 'ticket',
        );
        stepsSucceeded++;
        break;
      }

      case RouteStepType.UPDATE_TICKET_SUMMARY: {
        await updateTicketSummary(deps, ticketId, {
          taskTypeOverride: step.taskTypeOverride,
          promptKeyOverride: step.promptKeyOverride,
        });
        {
          const stepDuration = Date.now() - stepStart;
          appLog.info(
            `Ticket summary updated (${(stepDuration / 1000).toFixed(1)}s)`,
            { ticketId, durationMs: stepDuration },
            ticketId, 'ticket',
          );
        }
        stepsSucceeded++;
        break;
      }

      case RouteStepType.CREATE_TICKET: {
        // CREATE_TICKET is an ingestion-only step. In analysis routes the ticket already
        // exists, so this is a no-op.
        appLog.info('CREATE_TICKET step skipped — ticket already exists in analysis pipeline', { ticketId }, ticketId, 'ticket');
        stepsSkipped++;
        break;
      }

      case RouteStepType.DISPATCH_TO_ROUTE: {
        if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
          logger.warn({ ticketId, routeId: route.id, dispatchDepth }, `Dispatch depth limit (${MAX_DISPATCH_DEPTH}) reached, skipping DISPATCH_TO_ROUTE`);
          appLog.warn(`Dispatch depth limit reached (${dispatchDepth}/${MAX_DISPATCH_DEPTH}), skipping dispatch`, { ticketId, routeId: route.id, dispatchDepth }, ticketId, 'ticket');
          break;
        }

        const dispatchCfg = (step.config as { mode?: string; targetRouteId?: string; rules?: Array<{ category: string; targetRouteId: string }>; fallback?: string } | null) ?? { mode: 'auto' };
        const mode = dispatchCfg.mode ?? 'auto';

        let dispatchedRoute: ResolvedRoute | null = null;

        if (mode === 'pin' && dispatchCfg.targetRouteId) {
          const pinTarget = await db.ticketRoute.findUnique({
            where: { id: dispatchCfg.targetRouteId },
            include: { steps: { where: { isActive: true }, orderBy: { stepOrder: 'asc' as const } } },
          });
          if (pinTarget && pinTarget.isActive && pinTarget.steps.length > 0) {
            dispatchedRoute = pinTarget;
          } else {
            logger.warn({ ticketId, targetRouteId: dispatchCfg.targetRouteId }, 'Pinned dispatch target not found/inactive/empty, falling back to auto');
            dispatchedRoute = await resolveTicketRoute(deps, ticketId, clientId, category, true, ctx.ticketSource);
          }
        } else if (mode === 'rules' && Array.isArray(dispatchCfg.rules)) {
          const matchedRule = dispatchCfg.rules.find((r) => r.category === category);
          if (matchedRule) {
            const ruleTarget = await db.ticketRoute.findUnique({
              where: { id: matchedRule.targetRouteId },
              include: { steps: { where: { isActive: true }, orderBy: { stepOrder: 'asc' as const } } },
            });
            if (ruleTarget && ruleTarget.isActive && ruleTarget.steps.length > 0) {
              dispatchedRoute = ruleTarget;
            } else {
              logger.warn({ ticketId, targetRouteId: matchedRule.targetRouteId, category }, 'Rule dispatch target not found/inactive/empty, falling back');
              if (dispatchCfg.fallback !== 'stop') {
                dispatchedRoute = await resolveTicketRoute(deps, ticketId, clientId, category, true, ctx.ticketSource);
              }
            }
          } else {
            if (dispatchCfg.fallback !== 'stop') {
              dispatchedRoute = await resolveTicketRoute(deps, ticketId, clientId, category, true, ctx.ticketSource);
            } else {
              logger.info({ ticketId, category }, 'No dispatch rule matched and fallback is stop, continuing current route');
            }
          }
        } else {
          dispatchedRoute = await resolveTicketRoute(deps, ticketId, clientId, category, true, ctx.ticketSource);
        }

        if (dispatchedRoute && dispatchedRoute.id !== route.id) {
          const safeDest = sanitizeName(dispatchedRoute.name);
          appLog.info(`Dispatching to route "${safeDest}" (${mode}, depth ${dispatchDepth + 1})`, { ticketId, fromRouteId: route.id, toRouteId: dispatchedRoute.id, dispatchDepth: dispatchDepth + 1 }, ticketId, 'ticket');

          await executeRoutePipeline(
            deps,
            ctx,
            dispatchedRoute,
            bullmqJobId,
            { summary, category, priority, facts, clientContext, environmentContext },
            dispatchDepth + 1,
            reanalysisCtx,
          );

          appLog.info(`Dispatch to "${safeDest}" completed, ending current route`, { ticketId, routeId: route.id }, ticketId, 'ticket');
          return;
        }

        logger.info({ ticketId, routeId: route.id, category, mode }, 'No different route resolved for dispatch, continuing current route');
        stepsSucceeded++;
        break;
      }

      case RouteStepType.NOTIFY_OPERATOR: {
        const stepConfig = step.config as Record<string, unknown> | null;
        const rawEmailTo = stepConfig?.['emailTo'];
        const notifyTo = typeof rawEmailTo === 'string' ? rawEmailTo.trim() : '';
        const isValidEmail = notifyTo !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyTo);

        const notifySubject = `[Bronco] Ticket requires attention: ${emailSubject}`;
        const notifyBody = [
          `A ticket requires your attention.`,
          '',
          `**Ticket ID:** ${ticketId}`,
          `**Subject:** ${emailSubject}`,
          `**Category:** ${category}`,
          `**Priority:** ${priority}`,
          `**Source:** ${ctx.ticketSource ?? 'unknown'}`,
          '',
          analysis ? `**Analysis:**\n${analysis}` : (summary ? `**Summary:**\n${summary}` : ''),
          '',
          `View this ticket in the control panel to take action.`,
        ].filter(Boolean).join('\n');

        // If an explicit emailTo is configured, use it (legacy single-recipient mode).
        // Otherwise, notify all active operators via the Operator table.
        if (isValidEmail && mailer) {
          try {
            await mailer.send({ to: notifyTo, subject: notifySubject, body: notifyBody });
            await db.ticketEvent.create({
              data: {
                ticketId,
                eventType: 'EMAIL_OUTBOUND',
                content: notifyBody,
                metadata: { type: 'operator_notification', to: notifyTo, subject: notifySubject },
                actor: 'system:analyzer',
              },
            });
            const stepDuration = Date.now() - stepStart;
            appLog.info(`Operator notification sent to ${notifyTo} (${(stepDuration / 1000).toFixed(1)}s)`, { ticketId, to: notifyTo, durationMs: stepDuration }, ticketId, 'ticket');
            stepsSucceeded++;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            appLog.error(`NOTIFY_OPERATOR email failed: ${errMsg}`, { err, ticketId, to: notifyTo }, ticketId, 'ticket');
            stepsFailed++;
          }
        } else if (notifyTo !== '') {
          // Non-empty emailTo configured but invalid — warn and skip to avoid broad operator broadcast
          appLog.warn('NOTIFY_OPERATOR skipped — invalid emailTo configured', { ticketId, stepId: step.id, emailTo: notifyTo }, ticketId, 'ticket');
          stepsSkipped++;
        } else if (mailer) {
          try {
            // No emailTo configured — look up assigned operator for targeted notification
            const ticket = ticketId ? await db.ticket.findUnique({ where: { id: ticketId }, select: { assignedOperatorId: true } }) : null;
            const notified = await notifyOperatorsFn(
              mailer,
              () => db.operator.findMany({ where: { isActive: true } }),
              {
                subject: notifySubject,
                body: notifyBody,
                operatorId: ticket?.assignedOperatorId ?? undefined,
                event: 'ANALYSIS_COMPLETE',
                getPreference: (evt) => db.notificationPreference.findUnique({ where: { event: evt } }),
              },
            );

            // Also notify client operators if the client has notificationMode='operator'
            const clientNotified: string[] = [];
            try {
              const client = await db.client.findUnique({
                where: { id: ctx.clientId },
                select: { notificationMode: true, slackChannelId: true },
              });
              if (client && client.notificationMode === NotificationMode.OPERATOR) {
                const sent = await notifyClientOperatorsFn(
                  mailer,
                  async (clientId) => {
                    const rows = await db.person.findMany({
                      where: {
                        clientId,
                        userType: { in: ['OPERATOR', 'ADMIN'] },
                        isActive: true,
                        hasOpsAccess: true,
                      },
                      select: { id: true, email: true, name: true, userType: true, slackUserId: true },
                    });
                    return rows.map((r) => ({
                      id: r.id,
                      email: r.email,
                      name: r.name,
                      userType: r.userType ?? 'USER',
                      slackUserId: r.slackUserId,
                    }));
                  },
                  {
                    subject: notifySubject,
                    body: notifyBody,
                    clientId: ctx.clientId,
                    slackChannelId: client.slackChannelId ?? undefined,
                  },
                );
                clientNotified.push(...sent);
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              appLog.warn(`NOTIFY_OPERATOR client routing failed: ${errMsg}`, { err, ticketId }, ticketId, 'ticket');
            }

            const allNotified = [...notified, ...clientNotified];
            if (allNotified.length > 0) {
              await db.ticketEvent.create({
                data: {
                  ticketId,
                  eventType: 'EMAIL_OUTBOUND',
                  content: notifyBody,
                  metadata: { type: 'operator_notification', to: allNotified, subject: notifySubject },
                  actor: 'system:analyzer',
                },
              });
              const stepDuration = Date.now() - stepStart;
              appLog.info(`Operator notifications sent to ${allNotified.join(', ')} (${(stepDuration / 1000).toFixed(1)}s)`, { ticketId, to: allNotified, durationMs: stepDuration }, ticketId, 'ticket');
              stepsSucceeded++;
            } else {
              appLog.warn('NOTIFY_OPERATOR skipped — no operators configured for email notifications', { ticketId, stepId: step.id }, ticketId, 'ticket');
              stepsSkipped++;
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            appLog.error(`NOTIFY_OPERATOR multi-operator email failed: ${errMsg}`, { err, ticketId }, ticketId, 'ticket');
            stepsFailed++;
          }
        } else {
          // No mailer configured — skip
          appLog.warn('NOTIFY_OPERATOR skipped — no mailer configured', { ticketId, stepId: step.id }, ticketId, 'ticket');
          stepsSkipped++;
        }
        break;
      }

      case RouteStepType.ADD_FOLLOWER: {
        const stepConfig = step.config as Record<string, unknown> | null;
        const rawEmail = stepConfig?.['email'];
        const rawDomain = stepConfig?.['emailDomain'];
        const followerType = (stepConfig?.['followerType'] === 'REQUESTER' ? 'REQUESTER' : 'FOLLOWER') as 'REQUESTER' | 'FOLLOWER';

        const peopleToAdd: Array<{ id: string }> = [];

        if (typeof rawEmail === 'string' && rawEmail.trim()) {
          const person = await db.person.findFirst({
            where: { email: { equals: rawEmail.trim(), mode: 'insensitive' }, clientId: ctx.clientId },
            select: { id: true },
          });
          if (person) {
            peopleToAdd.push(person);
          } else {
            appLog.warn(`ADD_FOLLOWER skipped — no person found for email "${rawEmail}"`, { ticketId, email: rawEmail }, ticketId, 'ticket');
          }
        } else if (typeof rawDomain === 'string' && rawDomain.trim()) {
          const domainPeople = await db.person.findMany({
            where: { email: { endsWith: `@${rawDomain.trim().toLowerCase()}`, mode: 'insensitive' }, clientId: ctx.clientId },
            select: { id: true },
          });
          if (domainPeople.length > 0) {
            peopleToAdd.push(...domainPeople);
          } else {
            appLog.warn(`ADD_FOLLOWER skipped — no people found for domain "${rawDomain}"`, { ticketId, domain: rawDomain }, ticketId, 'ticket');
          }
        } else {
          appLog.warn('ADD_FOLLOWER skipped — no email or emailDomain in step config', { ticketId, stepId: step.id }, ticketId, 'ticket');
          break;
        }

        let addedCount = 0;
        for (const p of peopleToAdd) {
          try {
            await db.ticketFollower.upsert({
              where: { ticketId_personId: { ticketId, personId: p.id } },
              create: { ticketId, personId: p.id, followerType },
              update: { followerType },
            });
            addedCount++;
          } catch (err) {
            logger.warn({ err, ticketId, personId: p.id }, 'Failed to add follower');
          }
        }
        if (addedCount > 0) {
          const stepDuration = Date.now() - stepStart;
          appLog.info(`Added ${addedCount} follower(s) as ${followerType} (${(stepDuration / 1000).toFixed(1)}s)`, { ticketId, count: addedCount, followerType, durationMs: stepDuration }, ticketId, 'ticket');
        }
        stepsSucceeded++;
        break;
      }

      default:
        logger.warn({ ticketId, stepType: step.stepType }, `Unknown step type "${step.stepType}", skipping`);
    }
  }
  } finally {
    // Clean up all worktrees created during this job
    const results = await Promise.allSettled(cleanups.map((fn) => fn()));
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn({ err: r.reason }, 'Worktree cleanup failed');
      }
    }
  }

  const pipelineDuration = Date.now() - pipelineStart;
  const totalSteps = stepsSucceeded + stepsFailed + stepsSkipped;
  appLog.info(
    `Analysis pipeline completed: ${totalSteps} steps, ${stepsSucceeded} succeeded, ${stepsFailed} failed, ${stepsSkipped} skipped, ${totalToolCalls} tool calls, total ${(pipelineDuration / 1000).toFixed(1)}s`,
    { ticketId, routeId: route.id, routeName: safeName, stepsSucceeded, stepsFailed, stepsSkipped, totalSteps, totalToolCalls, durationMs: pipelineDuration },
    ticketId, 'ticket',
  );
}

// ---------------------------------------------------------------------------
// Exported processor for BullMQ
// ---------------------------------------------------------------------------

/** Maximum number of re-analysis cycles allowed per ticket. */
const MAX_REANALYSIS_COUNT = 10;

/**
 * Load conversation history from ticket events for re-analysis context.
 * Returns events ordered chronologically.
 */
async function loadConversationHistory(
  db: PrismaClient,
  ticketId: string,
): Promise<Array<{ eventType: string; content: string | null; metadata: unknown; actor: string; createdAt: Date }>> {
  return db.ticketEvent.findMany({
    where: {
      ticketId,
      eventType: { in: ['AI_ANALYSIS', 'COMMENT', 'EMAIL_OUTBOUND', 'AI_RECOMMENDATION', 'EMAIL_INBOUND'] },
    },
    orderBy: { createdAt: 'asc' },
    select: { eventType: true, content: true, metadata: true, actor: true, createdAt: true },
  });
}

/**
 * Format conversation history into a markdown thread for injection into AI prompts.
 */
function formatConversationHistory(
  events: Array<{ eventType: string; content: string | null; metadata: unknown; actor: string; createdAt: Date }>,
): string {
  if (events.length === 0) return '';

  const parts = events.map((e) => {
    const ts = e.createdAt.toISOString().slice(0, 16);
    const label =
      e.eventType === 'AI_ANALYSIS' ? 'AI Analysis'
        : e.eventType === 'AI_RECOMMENDATION' ? 'AI Recommendation'
        : e.eventType === 'EMAIL_OUTBOUND' ? 'Outbound Email'
        : e.eventType === 'EMAIL_INBOUND' ? 'Inbound Email'
        : e.eventType === 'COMMENT' ? 'Reply'
        : e.eventType;
    const content = (e.content ?? '').slice(0, 3000);

    // Include tool call summary for agentic analysis events so Claude sees
    // which tools were used and what data was gathered in prior analysis.
    let toolCallSummary = '';
    if (e.eventType === 'AI_ANALYSIS') {
      const meta = e.metadata as Record<string, unknown> | null;
      const toolCalls = meta?.toolCalls as Array<{ tool: string }> | undefined;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const toolCounts = new Map<string, number>();
        for (const tc of toolCalls) {
          toolCounts.set(tc.tool, (toolCounts.get(tc.tool) ?? 0) + 1);
        }
        const summary = [...toolCounts.entries()].map(([name, count]) => `${name} (×${count})`).join(', ');
        toolCallSummary = `\n\n**Tools used:** ${summary}`;
      }
    }

    return `### [${ts}] ${label} (${e.actor})\n\n${content}${toolCallSummary}`;
  });

  return parts.join('\n\n---\n\n');
}

export function createAnalysisProcessor(deps: AnalyzerDeps) {
  return async function processAnalysis(job: Job<AnalysisJob>): Promise<void> {
    const { ticketId, reanalysis, triggerEventId } = job.data;

    // Resolve ticket context from the DB instead of carrying it on the job payload
    const ctx = await loadAnalysisContext(deps.db, job.data);

    appLog.info(
      reanalysis ? 'Starting re-analysis pipeline (reply-triggered)' : 'Starting ticket analysis pipeline',
      { ticketId, emailFrom: ctx.emailFrom, emailSubject: ctx.emailSubject, reanalysis: !!reanalysis, triggerEventId },
      ticketId,
      'ticket',
    );

    // --- Re-analysis loop guard (atomic, first attempt only) ---
    // Only increment on the first attempt (attemptsMade === 0) to prevent retries
    // from burning through the limit. Uses an atomic conditional update to avoid
    // TOCTOU races between concurrent reanalysis jobs.
    if (reanalysis && job.attemptsMade === 0) {
      const updated = await deps.db.ticket.updateMany({
        where: { id: ticketId, reanalysisCount: { lt: MAX_REANALYSIS_COUNT } },
        data: { reanalysisCount: { increment: 1 } },
      });
      if (updated.count === 0) {
        const currentTicket = await deps.db.ticket.findUnique({
          where: { id: ticketId },
          select: { reanalysisCount: true },
        });
        appLog.warn(
          `Re-analysis limit reached (${currentTicket?.reanalysisCount ?? '?'}/${MAX_REANALYSIS_COUNT}), skipping`,
          { ticketId, reanalysisCount: currentTicket?.reanalysisCount },
          ticketId,
          'ticket',
        );
        await deps.db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'SYSTEM_NOTE',
            content: `This ticket has reached the maximum number of automated analysis cycles (${MAX_REANALYSIS_COUNT}). Please review manually or reopen.`,
            actor: 'system:analyzer',
          },
        });
        return;
      }
    }

    // Check for a DB-defined route first. If a route exists, use it for the
    // entire pipeline (triage + analysis). Otherwise fall back to the original
    // hardcoded two-phase flow.
    const ticket = await deps.db.ticket.findUnique({
      where: { id: ticketId },
      select: { category: true, clientId: true },
    });

    // --- Re-analysis: use a lightweight UPDATE_ANALYSIS + DRAFT_FINDINGS_EMAIL pipeline ---
    // Instead of re-running the full analysis route, build a synthetic two-step route
    // that performs incremental analysis on the new reply and sends updated findings.
    if (reanalysis) {
      try {
        const allHistory = await loadConversationHistory(deps.db, ticketId);
        // Limit to the most recent 20 events to keep UPDATE_ANALYSIS prompts lightweight.
        // Always includes the latest AI_ANALYSIS + trigger reply.
        const conversationHistory = allHistory.slice(-20);
        let triggerReplyText = '';
        if (triggerEventId) {
          const triggerEvent = await deps.db.ticketEvent.findFirst({
            where: { id: triggerEventId, ticketId },
            select: { content: true },
          });
          triggerReplyText = triggerEvent?.content ?? '';
        }
        // If no trigger event found, use the most recent inbound email/comment
        if (!triggerReplyText) {
          const latestReply = conversationHistory
            .filter((e) => e.eventType === 'EMAIL_INBOUND' || e.eventType === 'COMMENT')
            .pop();
          triggerReplyText = latestReply?.content ?? '';
        }
        const reanalysisContext: ReanalysisContext = {
          conversationHistory: formatConversationHistory(conversationHistory),
          triggerReplyText,
          triggerEventId,
        };

        // Synthetic re-analysis route: UPDATE_ANALYSIS → DRAFT_FINDINGS_EMAIL
        const syntheticRoute: ResolvedRoute = {
          id: 'synthetic-reanalysis',
          name: 'Re-analysis (Update)',
          steps: [
            {
              id: 'synthetic-update-analysis',
              stepOrder: 1,
              name: 'Update Analysis',
              stepType: RouteStepType.UPDATE_ANALYSIS,
              taskTypeOverride: null,
              promptKeyOverride: null,
              config: null,
            },
            {
              id: 'synthetic-draft-findings',
              stepOrder: 2,
              name: 'Draft Findings Email',
              stepType: RouteStepType.DRAFT_FINDINGS_EMAIL,
              taskTypeOverride: null,
              promptKeyOverride: null,
              config: null,
            },
          ],
        };

        await executeRoutePipeline(deps, ctx, syntheticRoute, String(job.id ?? randomUUID()), undefined, 0, reanalysisContext);
        await deps.db.ticket.update({
          where: { id: ticketId },
          data: { analysisStatus: AnalysisStatus.COMPLETED, analysisError: null, lastAnalyzedAt: new Date() },
        });
        appLog.info(
          'Re-analysis pipeline completed successfully (update analysis)',
          { ticketId },
          ticketId,
          'ticket',
        );
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const analysisError = redactUrls(rawMsg).slice(0, 1000);
        await deps.db.ticket.update({
          where: { id: ticketId },
          data: { analysisStatus: AnalysisStatus.FAILED, analysisError },
        });
        appLog.error(`Re-analysis pipeline failed: ${rawMsg}`, { err, ticketId }, ticketId, 'ticket');
        await deps.db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'SYSTEM_NOTE',
            content: `Re-analysis (update) pipeline failed: ${analysisError}`,
            actor: 'system:analyzer',
          },
        });
        throw err;
      }
      return;
    }

    const route = await resolveTicketRoute(deps, ticketId, ctx.clientId ?? ticket?.clientId ?? undefined, ticket?.category ?? null, false, ctx.ticketSource);

    // Use DB route if found, otherwise fall back to a synthetic route matching the architecture flowchart.
    // The fallback ensures tickets are always analyzed with the full pipeline (sufficiency evaluation,
    // agentic analysis, contact user) even without DB-configured routes.
    const analysisRoute = route ?? {
      id: 'default-analysis-fallback',
      name: 'Default Analysis (fallback)',
      steps: [
        { id: 'default-load-context', stepOrder: 1, name: 'Load Client Context', stepType: RouteStepType.LOAD_CLIENT_CONTEXT, taskTypeOverride: null, promptKeyOverride: null, config: null },
        { id: 'default-extract-facts', stepOrder: 2, name: 'Extract Facts', stepType: RouteStepType.EXTRACT_FACTS, taskTypeOverride: null, promptKeyOverride: null, config: null },
        { id: 'default-gather-repo', stepOrder: 3, name: 'Gather Repo Context', stepType: RouteStepType.GATHER_REPO_CONTEXT, taskTypeOverride: null, promptKeyOverride: null, config: null },
        { id: 'default-gather-db', stepOrder: 4, name: 'Gather DB Context', stepType: RouteStepType.GATHER_DB_CONTEXT, taskTypeOverride: null, promptKeyOverride: null, config: null },
        { id: 'default-agentic', stepOrder: 5, name: 'Agentic Analysis', stepType: RouteStepType.AGENTIC_ANALYSIS, taskTypeOverride: null, promptKeyOverride: null, config: null },
        { id: 'default-findings', stepOrder: 6, name: 'Draft Findings Email', stepType: RouteStepType.DRAFT_FINDINGS_EMAIL, taskTypeOverride: null, promptKeyOverride: null, config: null },
        { id: 'default-next-steps', stepOrder: 7, name: 'Suggest Next Steps', stepType: RouteStepType.SUGGEST_NEXT_STEPS, taskTypeOverride: null, promptKeyOverride: null, config: null },
        { id: 'default-summary', stepOrder: 8, name: 'Update Ticket Summary', stepType: RouteStepType.UPDATE_TICKET_SUMMARY, taskTypeOverride: null, promptKeyOverride: null, config: null },
      ],
    } satisfies ResolvedRoute;

    if (!route) {
      appLog.info('No analysis route found — using default flowchart pipeline', { ticketId }, ticketId, 'ticket');
    }

    try {
      await executeRoutePipeline(deps, ctx, analysisRoute, String(job.id ?? randomUUID()));
      await deps.db.ticket.update({
        where: { id: ticketId },
        data: { analysisStatus: AnalysisStatus.COMPLETED, analysisError: null, lastAnalyzedAt: new Date() },
      });
      appLog.info(
        `Ticket analysis pipeline completed successfully (${route ? 'route-driven' : 'default fallback'})`,
        { ticketId, routeId: analysisRoute.id },
        ticketId,
        'ticket',
      );

      // Post-analysis self-analysis trigger
      if (deps.selfAnalysisQueue) {
        try {
          const selfCfg = await getSelfAnalysisConfig(deps.db);
          if (selfCfg.postAnalysisTrigger && ticketId) {
            await deps.selfAnalysisQueue.add(
              'analyze-post-pipeline',
              { ticketId, triggerType: 'POST_ANALYSIS' },
              { jobId: `post-pipeline-${ticketId}-${Date.now()}` },
            );
          }
        } catch (triggerErr) {
          appLog.error('Failed to enqueue post-analysis self-analysis', { err: triggerErr, ticketId }, ticketId, 'ticket');
        }
      }
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const analysisError = redactUrls(rawMsg).slice(0, 1000);
      await deps.db.ticket.update({
        where: { id: ticketId },
        data: { analysisStatus: AnalysisStatus.FAILED, analysisError },
      });
      appLog.error(`Analysis pipeline failed: ${rawMsg}`, { err, ticketId, routeId: analysisRoute.id }, ticketId, 'ticket');
      await deps.db.ticketEvent.create({
        data: {
          ticketId,
          eventType: 'SYSTEM_NOTE',
          content: `Analysis pipeline "${sanitizeName(analysisRoute.name)}" failed: ${analysisError}`,
          actor: 'system:analyzer',
        },
      });
      throw err;
    }
  };
}
