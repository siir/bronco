import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Job } from 'bullmq';
import { Prisma } from '@bronco/db';
import type { PrismaClient } from '@bronco/db';
import type { TicketCategory, Priority, TicketStatus, TicketSource, AnalysisJob } from '@bronco/shared-types';
import { AIRouter } from '@bronco/ai-provider';
import { TaskType, RouteStepType, isClosedStatus, AnalysisStatus, SufficiencyStatus, SufficiencyConfidence } from '@bronco/shared-types';
import { createLogger, AppLogger, createPrismaLogWriter, decrypt, looksEncrypted, MCP_TOOL_TIMEOUT_MS, mcpUrl, callMcpToolViaSdk, notifyOperators as notifyOperatorsFn } from '@bronco/shared-utils';
import type { AIToolDefinition, AIMessage, AIToolUseBlock, AITextBlock, AIToolResponse, AIToolResultBlock } from '@bronco/shared-types';
import type { Mailer, ReplyOptions } from '@bronco/shared-utils';

const execFileAsync = promisify(execFile);
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

/** Max events to include in ticket summary prompts to bound prompt size. */
const SUMMARY_EVENT_LIMIT = 50;

const DEFAULT_REPO_BASE_DIR = '/tmp/bronco-repos';

/** Timeout (ms) for git clone/fetch operations to prevent indefinite blocking. */
const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Canonical list of AI action types — used in both the LLM prompt and runtime validation. */
const KNOWN_ACTIONS = [
  'set_status', 'set_priority', 'set_category', 'add_comment',
  'trigger_code_fix', 'send_followup_email', 'escalate_deep_analysis', 'check_database_health',
] as const;

/** Strip embedded credentials from URLs in error messages (e.g., https://user:token@host/repo). */
function redactUrls(msg: string): string {
  return msg.replace(/https?:\/\/[^@]+@/g, 'https://***@');
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

// ---------------------------------------------------------------------------
// In-process mutex for bare-clone fetch/clone operations
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<void>>();

function acquireRepoLock(repoName: string): { wait: Promise<void>; release: () => void } {
  const prev = repoLocks.get(repoName) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  const chain = prev.then(() => next);
  repoLocks.set(repoName, chain);
  chain.finally(() => {
    if (repoLocks.get(repoName) === chain) {
      repoLocks.delete(repoName);
    }
  });
  return { wait: prev, release };
}

interface WorktreeResult {
  worktreePath: string;
  cleanup: () => Promise<void>;
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
    select: { clientId: true, subject: true, source: true, description: true, followers: { where: { followerType: 'REQUESTER' }, select: { contact: { select: { email: true } } }, orderBy: { createdAt: 'asc' }, take: 1 } },
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
      emailFrom: ticket.followers[0]?.contact?.email ?? undefined,
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
      followers: { where: { followerType: 'REQUESTER' }, include: { contact: { select: { name: true, email: true } } }, orderBy: { createdAt: 'asc' }, take: 1 },
      events: { orderBy: { createdAt: 'desc' }, take: SUMMARY_EVENT_LIMIT },
    },
  });
  if (!ticket) return;

  const requester = ticket.followers[0]?.contact;

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
  // 1. Check if there's a contact record with a name (scoped to client to prevent cross-tenant leakage)
  const contact = await db.contact.findFirst({
    where: {
      email: { equals: emailFrom, mode: 'insensitive' },
      ...(clientId ? { clientId } : {}),
    },
    select: { name: true },
  });
  if (contact?.name) return contact.name;

  // 2. Check the ticket's requester follower
  const requesterFollower = await db.ticketFollower.findFirst({
    where: { ticketId, followerType: 'REQUESTER' },
    include: { contact: { select: { name: true } } },
  });
  if (requesterFollower?.contact?.name) return requesterFollower.contact.name;

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
 * Clone or pull a git repository to a local directory.
 */
function validateGitArgument(value: string, kind: 'branch' | 'url'): string {
  if (value.startsWith('-')) {
    throw new Error(`Invalid git ${kind}: must not start with '-'`);
  }
  if (kind === 'url') {
    // Only allow https:// and git@ (SSH) URLs
    if (!/^(https:\/\/|git@)/.test(value)) {
      throw new Error('Invalid git url: only https:// and git@ (SSH) URLs are allowed');
    }
  }
  if (kind === 'branch') {
    // git branch names: alphanumeric, slashes, dashes, dots, underscores
    if (!/^[a-zA-Z0-9._\/-]+$/.test(value)) {
      throw new Error('Invalid git branch: contains disallowed characters');
    }
    // Disallow path traversal sequences in branch names
    if (value.includes('..')) {
      throw new Error('Invalid git branch: must not contain ".."');
    }
  }
  return value;
}

/** Sanitize a search term for use with git grep to prevent argument injection. */
function sanitizeSearchTerm(term: string): string {
  // Strip control characters and limit length
  return term.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
}

async function ensureRepo(
  url: string,
  branch: string,
  name: string,
  clientId: string,
  jobId: string,
  baseDir: string = DEFAULT_REPO_BASE_DIR,
): Promise<WorktreeResult> {
  const safeUrl = validateGitArgument(url, 'url');
  const safeBranch = validateGitArgument(branch, 'branch');

  // Sanitize repo name to prevent path traversal — use only the basename
  // and strip any characters that aren't alphanumeric, dash, dot, or underscore.
  const safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safeName) {
    throw new Error('Invalid repository name');
  }
  const safeJobId = basename(jobId).replace(/[^a-zA-Z0-9._-]/g, '_');

  // Sanitize clientId the same way as repo name to prevent path traversal
  const safeClientId = basename(clientId).replace(/[^a-zA-Z0-9._-]/g, '_');

  // Include clientId in path/lock key to avoid cross-client repo collisions
  const repoKey = `${safeClientId}_${safeName}`;

  const bareDir = join(baseDir, 'bare');
  const worktreeDir = join(baseDir, 'worktrees');

  await mkdir(bareDir, { recursive: true });
  await mkdir(worktreeDir, { recursive: true });

  const barePath = join(bareDir, `${repoKey}.git`);

  // Lock the bare clone so concurrent jobs for the same repo don't race
  const lock = acquireRepoLock(repoKey);
  await lock.wait;
  try {
    if (existsSync(join(barePath, 'HEAD'))) {
      // Fetch latest into the bare clone (shallow — full history not needed for analysis)
      await execFileAsync('git', ['-C', barePath, 'fetch', '--depth', '1', 'origin', safeBranch], { timeout: GIT_CLONE_TIMEOUT_MS });
      await execFileAsync('git', ['-C', barePath, 'worktree', 'prune']);
      // Verify the remote branch exists after fetch
      try {
        await execFileAsync('git', ['-C', barePath, 'rev-parse', '--verify', `origin/${safeBranch}`]);
      } catch {
        throw new Error(`Remote branch 'origin/${safeBranch}' not found in ${safeName}`);
      }
      logger.info({ repo: safeName, branch: safeBranch }, 'Bare repo fetched');
    } else {
      // If the directory exists without a valid bare repo, remove it first
      if (existsSync(barePath)) {
        logger.warn({ repo: safeName }, 'Removing corrupted bare repo directory');
        await rm(barePath, { recursive: true, force: true });
      }
      await execFileAsync('git', [
        'clone', '--bare', '--single-branch', '--branch', safeBranch,
        '--depth', '1',
        safeUrl, barePath,
      ], { timeout: GIT_CLONE_TIMEOUT_MS });
      logger.info({ repo: safeName, branch: safeBranch }, 'Bare repo cloned');
    }
  } finally {
    lock.release();
  }

  // Create a per-job worktree (no lock needed — path is unique)
  const worktreePath = join(worktreeDir, `${repoKey}-${safeJobId}`);

  // Clean up any stale worktree registration and directory before adding
  try {
    await execFileAsync('git', ['-C', barePath, 'worktree', 'remove', '--force', worktreePath]);
  } catch {
    // Worktree may not be registered — just clean up the directory
    if (existsSync(worktreePath)) {
      await rm(worktreePath, { recursive: true, force: true });
    }
  }
  try {
    await execFileAsync('git', ['-C', barePath, 'worktree', 'prune']);
  } catch { /* best effort */ }

  await execFileAsync('git', [
    '-C', barePath, 'worktree', 'add', '--detach', worktreePath, `origin/${safeBranch}`,
  ]);
  logger.info({ repo: safeName, worktree: worktreePath }, 'Worktree created');

  const cleanup = async () => {
    try {
      await execFileAsync('git', ['-C', barePath, 'worktree', 'remove', '--force', worktreePath]);
      logger.debug({ repo: safeName, worktree: worktreePath }, 'Worktree removed');
    } catch {
      // Fallback: just delete the directory and let prune clean up metadata
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  };

  return { worktreePath, cleanup };
}

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

/**
 * Read a set of files from a repo directory, returning their contents
 * truncated to a reasonable size for AI context. Uses a total byte budget
 * instead of an arbitrary file-count cap so that all mentioned files have
 * a chance to be included.
 */
async function readRepoFiles(
  repoPath: string,
  filePaths: string[],
  maxPerFile = 3000,
  maxTotalBytes = 60_000,
): Promise<string> {
  const absRepoPath = resolve(repoPath);
  const parts: string[] = [];
  let totalBytes = 0;
  for (const fp of filePaths) {
    if (totalBytes >= maxTotalBytes) break;
    try {
      const full = resolve(absRepoPath, fp);
      // Ensure the resolved path stays within the repo directory
      if (!full.startsWith(absRepoPath + '/')) {
        logger.warn({ filePath: fp }, 'Skipping file outside repo boundary');
        continue;
      }
      const content = await readFile(full, 'utf-8');
      const truncated = content.slice(0, maxPerFile);
      const formatted = `--- ${fp} ---\n${truncated}\n`;
      parts.push(formatted);
      totalBytes += formatted.length;
    } catch {
      // File not found or unreadable — skip
    }
  }
  return parts.join('\n');
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
  for (const repo of ticket.client.repositories) {
    try {
      const { worktreePath, cleanup } = await ensureRepo(
        repo.url, repo.branch, repo.name, ticket.clientId, `${ticketId}-${bullmqJobId}`,
        deps.repoWorkspacePath,
      );
      cleanups.push(cleanup);

      // Use git grep to find relevant files based on keywords/errors
      const searchTerms = [
        ...(facts.keywords ?? []),
        ...(facts.filesMentioned ?? []),
        ...(facts.errorMessages?.map((e) => e.slice(0, 60)) ?? []),
      ].slice(0, 5);

      const relevantFiles = new Set<string>();

      for (const rawTerm of searchTerms) {
        const term = sanitizeSearchTerm(rawTerm);
        if (!term) continue;
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['-C', worktreePath, 'grep', '-l', '--max-count=3', '-i', '--', term],
            { timeout: 10_000 },
          );
          for (const line of stdout.trim().split('\n').filter(Boolean)) {
            relevantFiles.add(line);
          }
        } catch {
          // grep found nothing — that's fine
        }
      }

      // Also check explicitly mentioned files
      for (const f of facts.filesMentioned ?? []) {
        relevantFiles.add(f);
      }

      if (relevantFiles.size > 0) {
        const content = await readRepoFiles(worktreePath, [...relevantFiles]);
        if (content) {
          codeContext.push(`## Repository: ${repo.name}\n\n${content}`);
        }
      }
    } catch (err) {
      const errMsg = redactUrls(err instanceof Error ? err.message : String(err));
      failedRepos.push({ name: repo.name, error: errMsg });
      appLog.warn(`Repo context unavailable for ${repo.name}: ${errMsg}`, { ticketId, repo: repo.name, err }, ticketId, 'ticket');
    }
  }

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
      appLog.warn('Findings email send returned no messageId — status not updated', { ticketId, to: ctx.emailFrom }, ticketId);
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

  // Parse and execute the structured actions
  const executed: Array<{ action: string; value?: string; reason: string; applied: boolean }> = [];
  let rawActions: unknown[] = [];

  try {
    const cleaned = nextStepsRes.content.replace(/```json\n?|\n?```/g, '').trim();
    const parsed: unknown = JSON.parse(cleaned);
    rawActions = Array.isArray(parsed) ? parsed : [];
  } catch {
    logger.warn({ ticketId, raw: nextStepsRes.content.slice(0, 200) }, 'Failed to parse next steps JSON — storing as text recommendation');
    // Fall back to storing the raw text
    await db.ticketEvent.create({
      data: {
        ticketId,
        eventType: 'AI_RECOMMENDATION',
        content: nextStepsRes.content,
        metadata: { phase: 'next_steps', aiProvider: nextStepsRes.provider, aiModel: nextStepsRes.model, parsed: false },
        actor: 'system:analyzer',
      },
    });
    rawActions = [];
  }

  // Validate individual action objects — reject malformed entries from AI output
  const actions: Array<{ action: string; value?: string; reason: string }> = [];
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
    if (!KNOWN_ACTIONS.includes(obj.action as typeof KNOWN_ACTIONS[number])) {
      logger.warn({ ticketId, action: obj.action }, 'Skipping unrecognized action type');
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

  const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'];
  const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const VALID_CATEGORIES = ['DATABASE_PERF', 'BUG_FIX', 'FEATURE_REQUEST', 'SCHEMA_CHANGE', 'CODE_REVIEW', 'ARCHITECTURE', 'GENERAL'];

  // Track current field values locally so audit events capture accurate "previous" values
  let currentStatus: string = 'WAITING';
  let currentPriority: string = ticket.priority;
  let currentCategory: string | null = ticket.category;

  for (const step of actions.slice(0, 3)) {
    const reason = step.reason;
    const rawValue = typeof step.value === 'string' ? step.value.trim() : undefined;
    const value = rawValue?.toUpperCase();

    try {
      switch (step.action) {
        case 'set_status': {
          if (value && VALID_STATUSES.includes(value)) {
            const data: { status: TicketStatus; resolvedAt: Date | null } = {
              status: value as TicketStatus,
              resolvedAt: isClosedStatus(value) ? new Date() : null,
            };
            await db.ticket.update({ where: { id: ticketId }, data });
            await db.ticketEvent.create({
              data: {
                ticketId,
                eventType: 'STATUS_CHANGE',
                content: `Status changed to ${value} — ${reason}`,
                metadata: { previousStatus: currentStatus, newStatus: value, triggeredBy: 'ai' },
                actor: 'system:analyzer',
              },
            });
            executed.push({ action: 'set_status', value, reason, applied: true });
            logger.info({ ticketId, from: currentStatus, to: value }, 'AI auto-applied status change');
            currentStatus = value;
          } else {
            executed.push({ action: 'set_status', value, reason, applied: false });
          }
          break;
        }
        case 'set_priority': {
          if (value && VALID_PRIORITIES.includes(value)) {
            if (value === currentPriority) {
              executed.push({ action: 'set_priority', value, reason, applied: false });
              break;
            }
            await db.ticket.update({ where: { id: ticketId }, data: { priority: value as Priority } });
            await db.ticketEvent.create({
              data: {
                ticketId,
                eventType: 'PRIORITY_CHANGE',
                content: `Priority changed from ${currentPriority} to ${value} — ${reason}`,
                metadata: { previousPriority: currentPriority, newPriority: value, triggeredBy: 'ai' },
                actor: 'system:analyzer',
              },
            });
            executed.push({ action: 'set_priority', value, reason, applied: true });
            logger.info({ ticketId, from: currentPriority, to: value }, 'AI auto-applied priority change');
            currentPriority = value;
          } else {
            executed.push({ action: 'set_priority', value, reason, applied: false });
          }
          break;
        }
        case 'set_category': {
          if (value && VALID_CATEGORIES.includes(value)) {
            if (value === currentCategory) {
              executed.push({ action: 'set_category', value, reason, applied: false });
              break;
            }
            await db.ticket.update({ where: { id: ticketId }, data: { category: value as TicketCategory } });
            await db.ticketEvent.create({
              data: {
                ticketId,
                eventType: 'CATEGORY_CHANGE',
                content: `Category changed from ${currentCategory ?? '(unset)'} to ${value} — ${reason}`,
                metadata: { previousCategory: currentCategory ?? null, newCategory: value, triggeredBy: 'ai' },
                actor: 'system:analyzer',
              },
            });
            executed.push({ action: 'set_category', value, reason, applied: true });
            logger.info({ ticketId, from: currentCategory, to: value }, 'AI auto-applied category change');
            currentCategory = value;
          } else {
            executed.push({ action: 'set_category', value, reason, applied: false });
          }
          break;
        }
        case 'add_comment': {
          const commentText = step.value ?? reason;
          if (commentText) {
            await db.ticketEvent.create({
              data: {
                ticketId,
                eventType: 'COMMENT',
                content: commentText,
                metadata: { triggeredBy: 'ai' },
                actor: 'system:analyzer',
              },
            });
            executed.push({ action: 'add_comment', value: commentText.slice(0, 100), reason, applied: true });
          }
          break;
        }
        // Actions that require human review — log as recommendations only
        case 'trigger_code_fix':
        case 'send_followup_email':
        case 'escalate_deep_analysis':
        case 'check_database_health': {
          executed.push({ action: step.action, reason, applied: false });
          break;
        }
        default: {
          executed.push({ action: step.action, reason, applied: false });
          break;
        }
      }
    } catch (err) {
      logger.error({ err, ticketId, action: step.action }, 'Failed to execute AI-suggested action');
      executed.push({ action: step.action, value, reason, applied: false });
    }
  }

  // Record the actions and what was applied vs recommended
  const appliedActions = executed.filter((a) => a.applied);
  const recommendedActions = executed.filter((a) => !a.applied);

  const summaryParts: string[] = [];
  if (appliedActions.length > 0) {
    summaryParts.push('**Executed:**');
    for (const a of appliedActions) {
      summaryParts.push(`- ${a.action}${a.value ? ` → ${a.value}` : ''}: ${a.reason}`);
    }
  }
  if (recommendedActions.length > 0) {
    summaryParts.push('**Recommended (needs operator review):**');
    for (const a of recommendedActions) {
      summaryParts.push(`- ${a.action}: ${a.reason}`);
    }
  }

  if (executed.length > 0) {
    await db.ticketEvent.create({
      data: {
        ticketId,
        eventType: 'AI_RECOMMENDATION',
        content: summaryParts.join('\n'),
        metadata: {
          phase: 'next_steps',
          aiProvider: nextStepsRes.provider,
          aiModel: nextStepsRes.model,
          actions: executed,
          appliedCount: appliedActions.length,
          recommendedCount: recommendedActions.length,
        },
        actor: 'system:analyzer',
      },
    });
  }

  appLog.info(`Next steps processed: ${appliedActions.length} applied, ${recommendedActions.length} recommended`, {
    ticketId,
    applied: appliedActions.map((a) => `${a.action}${a.value ? `=${a.value}` : ''}`),
    recommended: recommendedActions.map((a) => a.action),
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
 * 5. null (fall back to hardcoded pipeline)
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

  if (ticketSource) {
    const sourceRoutes = await db.ticketRoute.findMany({
      where: {
        isActive: true,
        isDefault: false,
        routeType: 'ANALYSIS',
        summary: { not: null },
        source: ticketSource,
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
          context: { ticketId, clientId },
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
 * and code repositories. MCP tool names are prefixed with the integration label
 * to disambiguate across servers (e.g. `prod-db__get_blocking_tree`).
 */
async function buildAgenticTools(
  db: PrismaClient,
  clientId: string,
  encryptionKey: string,
  repos: Array<{ name: string; url: string; branch: string }>,
): Promise<{
  tools: AIToolDefinition[];
  mcpIntegrations: Map<string, McpIntegrationInfo>;
}> {
  const tools: AIToolDefinition[] = [];
  const mcpIntegrations = new Map<string, McpIntegrationInfo>();

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
    let apiKey: string | undefined;
    if (typeof cfg['apiKey'] === 'string' && cfg['apiKey']) {
      try {
        apiKey = looksEncrypted(cfg['apiKey'])
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
    mcpIntegrations.set(prefix, { label: integ.label, url, mcpPath, apiKey, authHeader });

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

  // Add repo tools if repos exist
  if (repos.length > 0) {
    const repoNames = repos.map((r) => r.name);
    tools.push({
      name: 'search_repo',
      description: `Search code repositories using git grep. Available repos: ${repoNames.join(', ')}`,
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository name', enum: repoNames },
          query: { type: 'string', description: 'Search pattern (git grep pattern)' },
        },
        required: ['repo', 'query'],
      },
    });
    tools.push({
      name: 'read_file',
      description: `Read a file from a code repository. Available repos: ${repoNames.join(', ')}`,
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository name', enum: repoNames },
          path: { type: 'string', description: 'File path relative to repo root' },
        },
        required: ['repo', 'path'],
      },
    });
  }

  return { tools, mcpIntegrations };
}

/**
 * Execute a single tool call from the agentic loop.
 * Returns the tool result text and whether it was an error.
 */
async function executeAgenticToolCall(
  toolCall: AIToolUseBlock,
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  worktrees: Map<string, string>,
): Promise<{ toolUseId: string; result: string; isError: boolean }> {
  const { id: toolUseId, name, input } = toolCall;

  try {
    // Check for repo tools first
    if (name === 'search_repo') {
      const repoName = input['repo'] as string;
      const query = input['query'] as string;
      const worktreePath = worktrees.get(repoName);
      if (!worktreePath) {
        return { toolUseId, result: `Repository "${repoName}" not available`, isError: true };
      }
      const sanitized = sanitizeSearchTerm(query);
      if (!sanitized) {
        return { toolUseId, result: 'Invalid search query', isError: true };
      }
      try {
        const { stdout } = await execFileAsync(
          'git', ['-C', worktreePath, 'grep', '-n', '--max-count=20', '-i', '--', sanitized],
          { timeout: 15_000, maxBuffer: 256 * 1024 },
        );
        return { toolUseId, result: stdout.trim() || 'No matches found', isError: false };
      } catch {
        return { toolUseId, result: 'No matches found', isError: false };
      }
    }

    if (name === 'read_file') {
      const repoName = input['repo'] as string;
      const filePath = input['path'] as string;
      const worktreePath = worktrees.get(repoName);
      if (!worktreePath) {
        return { toolUseId, result: `Repository "${repoName}" not available`, isError: true };
      }
      const content = await readRepoFiles(worktreePath, [filePath], 5000, 30_000);
      return { toolUseId, result: content || 'File not found or empty', isError: false };
    }

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

    const result = await callMcpToolViaSdk(
      integration.url,
      integration.mcpPath,
      actualToolName,
      input,
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

  const safeName = sanitizeName(route.name);
  appLog.info(`Executing route "${safeName}" (${route.steps.length} steps)`, { ticketId, routeId: route.id, routeName: safeName }, ticketId);

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
    appLog.warn('Ticket not found for route execution — aborting', { ticketId }, ticketId);
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
      appLog.info(`Skipping step during re-analysis: ${step.name} (${step.stepType})`, { ticketId, stepType: step.stepType }, ticketId);
      continue;
    }

    appLog.info(`Executing step: ${step.name} (${step.stepType})`, { ticketId, stepId: step.id, stepType: step.stepType }, ticketId);

    switch (step.stepType) {
      case RouteStepType.SUMMARIZE_EMAIL: {
        if (!ctx.emailFrom) {
          appLog.info('Skipping SUMMARIZE_EMAIL — no email context', { ticketId }, ticketId, 'ticket');
          break;
        }
        const promptKey = step.promptKeyOverride ?? 'imap.summarize.system';
        const taskType = (step.taskTypeOverride ?? TaskType.SUMMARIZE) as TaskType;
        const summaryRes = await ai.generate({
          taskType,
          context: { ticketId, clientId },
          prompt: `Summarize the following support email in 2-3 concise bullet points:\n\nSubject: ${emailSubject}\n\n${emailBody}`,
          promptKey,
        });
        summary = summaryRes.content;
        appLog.info('Email summarized via LLM', { ticketId, provider: summaryRes.provider, model: summaryRes.model }, ticketId);
        break;
      }

      case RouteStepType.CATEGORIZE: {
        const promptKey = step.promptKeyOverride ?? 'imap.categorize.system';
        const taskType = (step.taskTypeOverride ?? TaskType.CATEGORIZE) as TaskType;
        const categorizeRes = await ai.generate({
          taskType,
          context: { ticketId, clientId },
          prompt: `Categorize this support request into exactly one of: DATABASE_PERF, BUG_FIX, FEATURE_REQUEST, SCHEMA_CHANGE, CODE_REVIEW, ARCHITECTURE, GENERAL.\n\nSubject: ${emailSubject}\n\n${emailBody}\n\nRespond with only the category name.`,
          promptKey,
        });
        const rawCategory = categorizeRes.content.trim().toUpperCase();
        const validCategories = ['DATABASE_PERF', 'BUG_FIX', 'FEATURE_REQUEST', 'SCHEMA_CHANGE', 'CODE_REVIEW', 'ARCHITECTURE', 'GENERAL'];
        category = validCategories.includes(rawCategory) ? rawCategory : 'GENERAL';
        await db.ticket.update({ where: { id: ticketId }, data: { category: category as TicketCategory } });
        break;
      }

      case RouteStepType.TRIAGE_PRIORITY: {
        const promptKey = step.promptKeyOverride ?? 'imap.triage.system';
        const taskType = (step.taskTypeOverride ?? TaskType.TRIAGE) as TaskType;
        const triageRes = await ai.generate({
          taskType,
          context: { ticketId, clientId },
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
        appLog.info(`Ticket triaged: category=${category}, priority=${priority}`, { ticketId, category, priority }, ticketId);
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
          context: { ticketId, clientId },
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
        break;
      }

      case RouteStepType.DRAFT_RECEIPT: {
        if (!ctx.emailFrom) {
          appLog.info('Skipping DRAFT_RECEIPT — no email context', { ticketId }, ticketId, 'ticket');
          break;
        }
        if (!recipientName) {
          recipientName = await resolveRecipientName(db, ticketId, emailFrom!, clientId);
        }
        const promptKey = step.promptKeyOverride ?? 'imap.draft-receipt.system';
        const taskType = (step.taskTypeOverride ?? TaskType.DRAFT_EMAIL) as TaskType;
        const draftRes = await ai.generate({
          taskType,
          context: { ticketId, clientId },
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
          appLog.info(`Receipt confirmation email sent to ${emailFrom}`, { ticketId, to: emailFrom }, ticketId);
        }
        break;
      }

      case RouteStepType.LOAD_CLIENT_CONTEXT: {
        if (!clientId) {
          appLog.info('No client on ticket, skipping client context load', { ticketId }, ticketId);
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
          appLog.info(`Loaded ${relevant.length} client memory entries`, { ticketId, entryCount: relevant.length }, ticketId);
        }
        break;
      }

      case RouteStepType.EXTRACT_FACTS: {
        const promptKey = step.promptKeyOverride ?? 'imap.extract-facts.system';
        const taskType = (step.taskTypeOverride ?? TaskType.EXTRACT_FACTS) as TaskType;
        const extractRes = await ai.generate({
          taskType,
          context: { ticketId, clientId },
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
        break;
      }

      case RouteStepType.GATHER_REPO_CONTEXT: {
        // Reload ticket to get repos
        ticket = await db.ticket.findUnique({
          where: { id: ticketId },
          include: { client: { include: { repositories: { where: { isActive: true } } } }, system: true },
        });
        if (!ticket || !ticket.client) break;

        for (const repo of ticket.client.repositories) {
          try {
            const { worktreePath, cleanup } = await ensureRepo(
              repo.url, repo.branch, repo.name, ticket.clientId, `${ticketId}-${bullmqJobId}`,
              deps.repoWorkspacePath,
            );
            cleanups.push(cleanup);

            const searchTerms = [
              ...(facts.keywords ?? []),
              ...(facts.filesMentioned ?? []),
              ...(facts.errorMessages?.map((e) => e.slice(0, 60)) ?? []),
            ].slice(0, 5);

            const relevantFiles = new Set<string>();
            for (const rawTerm of searchTerms) {
              const term = sanitizeSearchTerm(rawTerm);
              if (!term) continue;
              try {
                const { stdout } = await execFileAsync(
                  'git', ['-C', worktreePath, 'grep', '-l', '--max-count=3', '-i', '--', term],
                  { timeout: 10_000 },
                );
                for (const line of stdout.trim().split('\n').filter(Boolean)) {
                  relevantFiles.add(line);
                }
              } catch { /* grep found nothing */ }
            }
            for (const f of facts.filesMentioned ?? []) {
              relevantFiles.add(f);
            }
            if (relevantFiles.size > 0) {
              const content = await readRepoFiles(worktreePath, [...relevantFiles]);
              if (content) {
                codeContext.push(`## Repository: ${repo.name}\n\n${content}`);
              }
            }
          } catch (err) {
            const errMsg = redactUrls(err instanceof Error ? err.message : String(err));
            appLog.warn(`Repo context unavailable for ${repo.name}: ${errMsg}`, { ticketId, repo: repo.name, err }, ticketId);
          }
        }
        break;
      }

      case RouteStepType.GATHER_DB_CONTEXT: {
        if (!facts.databaseRelated || !mcpDatabaseUrl || !ticket?.system) break;
        try {
          const healthResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_database_health', { systemId: ticket.system.id });
          dbContext += `## Database Health\n\n${healthResult}\n\n`;

          const sqlErrors = (facts.errorMessages ?? []).filter((e) =>
            /select|insert|update|delete|timeout|deadlock|block/i.test(e),
          );
          if (sqlErrors.length > 0) {
            const blockingResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_blocking_tree', { systemId: ticket.system.id });
            dbContext += `## Blocking Tree\n\n${blockingResult}\n\n`;
            const waitResult = await callMcpTool(mcpUrl(mcpDatabaseUrl), 'get_wait_stats', { systemId: ticket.system.id, topN: 10 });
            dbContext += `## Wait Stats\n\n${waitResult}\n\n`;
          }
        } catch (err) {
          appLog.warn(`MCP database context unavailable: ${err instanceof Error ? err.message : String(err)}`, { ticketId, err }, ticketId);
        }
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
          context: { ticketId, clientId, ticketCategory: category, skipClientMemory: !!clientContext },
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
        appLog.info(`Deep analysis complete (${analysisTaskType}) via ${analysisRes.provider}/${analysisRes.model}`, { ticketId, taskType: analysisTaskType }, ticketId);
        break;
      }

      case RouteStepType.AGENTIC_ANALYSIS: {
        const stepConfig = step.config as { maxIterations?: unknown; systemPromptOverride?: string } | null;
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
          appLog.warn('Ticket or client not found for agentic analysis', { ticketId }, ticketId);
          break;
        }

        const repos = ticket.client.repositories.map((r) => ({
          name: r.name, url: r.url, branch: r.branch,
        }));

        // Build tool definitions from MCP integrations and repos
        const { tools: agenticTools, mcpIntegrations } = await buildAgenticTools(
          db, ticket.clientId, deps.encryptionKey, repos,
        );

        if (agenticTools.length === 0) {
          appLog.info('No tools available for agentic analysis, skipping', { ticketId }, ticketId);
          break;
        }

        // Set up worktrees for repo tools
        const worktrees = new Map<string, string>();
        for (const repo of repos) {
          try {
            const { worktreePath, cleanup } = await ensureRepo(
              repo.url, repo.branch, repo.name, ticket.clientId,
              `${ticketId}-agentic-${bullmqJobId}`, deps.repoWorkspacePath,
            );
            worktrees.set(repo.name, worktreePath);
            cleanups.push(cleanup);
          } catch (err) {
            const errMsg = redactUrls(err instanceof Error ? err.message : String(err));
            appLog.warn(`Repo unavailable for agentic analysis: ${repo.name}: ${errMsg}`, { ticketId, repo: repo.name }, ticketId);
          }
        }

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
        const toolCallLog: Array<{ tool: string; input: Record<string, unknown>; output: string; durationMs: number }> = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        let finalAnalysis = '';
        let iterationsRun = 0;
        for (let i = 0; i < maxIterations; i++) {
          iterationsRun = i + 1;
          appLog.info(`Agentic analysis iteration ${i + 1}/${maxIterations}`, { ticketId, iteration: i + 1 }, ticketId);

          let response: AIToolResponse;
          try {
            response = await ai.generateWithTools({
              taskType: (step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS) as TaskType,
              systemPrompt: agenticSystemPrompt,
              tools: agenticTools,
              messages,
              context: { ticketId, clientId, ticketCategory: category, skipClientMemory: !!clientContext },
              maxTokens: 4096,
            });
          } catch (error) {
            if (error instanceof Error && /tool/i.test(error.message) && /support/i.test(error.message)) {
              appLog.error(
                'Agentic analysis skipped: AI provider does not support tool use',
                { ticketId, iteration: i + 1, error: error.message },
                ticketId,
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
          const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];

          for (const toolUse of toolUseBlocks) {
            const start = Date.now();
            const result = await executeAgenticToolCall(toolUse, mcpIntegrations, worktrees);
            const elapsed = Date.now() - start;
            toolCallLog.push({
              tool: toolUse.name,
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
            appLog.info(`Agentic tool call: ${toolUse.name} (${elapsed}ms)`, { ticketId, tool: toolUse.name, durationMs: elapsed }, ticketId);
          }

          // Append tool results as user message
          messages.push({ role: 'user', content: toolResults as AIToolResultBlock[] });
        }

        if (!finalAnalysis) {
          finalAnalysis = 'Agentic analysis reached maximum iterations without a final conclusion. Review the tool call log for partial findings.';
        }

        // Parse sufficiency evaluation from the analysis response
        const { analysis: cleanAnalysis, evaluation: sufficiency } = parseSufficiencyEvaluation(finalAnalysis);
        analysis = cleanAnalysis;

        // Store sufficiency questions in pipeline context so DRAFT_FINDINGS_EMAIL can include them
        ctx.sufficiencyEval = sufficiency;

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

        appLog.info(
          `Agentic analysis complete: ${toolCallLog.length} tool calls, sufficiency=${sufficiency.status}`,
          { ticketId, toolCalls: toolCallLog.length, sufficiencyStatus: sufficiency.status, sufficiencyConfidence: sufficiency.confidence },
          ticketId,
        );
        break;
      }

      case RouteStepType.UPDATE_ANALYSIS: {
        // Incremental analysis for replies — requires reanalysisCtx (conversation history + trigger reply).
        if (!reanalysisCtx) {
          appLog.warn(
            'UPDATE_ANALYSIS step requires reanalysisCtx but none was provided. This is likely a route configuration error; failing pipeline to avoid incomplete analysis.',
            { ticketId, routeId: route.id, stepType: RouteStepType.UPDATE_ANALYSIS },
            ticketId,
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
        if (summary) updatePromptParts.push('', '## Ticket Summary', summary);

        // Add sufficiency evaluation instructions so the update also signals readiness
        updatePromptParts.push(SUFFICIENCY_EVAL_INSTRUCTIONS);

        const updateRes = await ai.generate({
          taskType: updateTaskType,
          context: {
            ticketId,
            clientId,
            ticketCategory: category,
            skipClientMemory: !!clientContext,
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
          );
        }

        // Regenerate ticket summary from recent events if conclusions changed
        if (analysis && analysis.length > 20) {
          await updateTicketSummary(deps, ticketId);
        }

        appLog.info(`Update analysis complete via ${updateRes.provider}/${updateRes.model}`, { ticketId, taskType: updateTaskType }, ticketId);
        break;
      }

      case RouteStepType.CUSTOM_AI_QUERY: {
        const queryCfg = step.config as {
          prompt?: string;
          includeContext?: {
            ticket?: boolean;
            clientContext?: boolean;
            codeContext?: boolean;
            dbContext?: boolean;
            facts?: boolean;
            analysis?: boolean;
          };
          mcpQueries?: Array<{ toolName: string; params?: Record<string, unknown> }>;
          repoSearches?: Array<{ repoName?: string; searchTerms?: string[]; filePaths?: string[] }>;
        } | null;

        if (!queryCfg?.prompt) {
          appLog.warn('CUSTOM_AI_QUERY step missing prompt config, skipping', { ticketId }, ticketId);
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
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              appLog.warn(`CUSTOM_AI_QUERY MCP tool call failed: ${mq.toolName}: ${errMsg}`, { ticketId, tool: mq.toolName }, ticketId);
              freshMcpParts.push(`### ${mq.toolName}`, '', `(Error: ${errMsg})`, '');
            }
          }
          if (freshMcpParts.length > 0) {
            promptParts.push('## MCP Query Results', '', ...freshMcpParts);
          }
        }

        // Gather fresh repo context
        if (queryCfg.repoSearches?.length) {
          ticket = await db.ticket.findUnique({
            where: { id: ticketId },
            include: { client: { include: { repositories: { where: { isActive: true } } } }, system: true },
          });
          if (ticket?.client) {
            const freshRepoParts: string[] = [];
            // Cache worktree paths by repo id to avoid repeated ensureRepo calls
            // when the same repo appears across multiple searches.
            const repoWorktreeCache = new Map<string, string>();
            for (const rs of queryCfg.repoSearches) {
              const repos = rs.repoName
                ? ticket.client.repositories.filter((r) => r.name === rs.repoName)
                : ticket.client.repositories;

              for (const repo of repos) {
                try {
                  let worktreePath = repoWorktreeCache.get(repo.id);
                  if (!worktreePath) {
                    const { worktreePath: wtp, cleanup } = await ensureRepo(
                      repo.url, repo.branch, repo.name, ticket.clientId,
                      `${ticketId}-custom-${bullmqJobId}`, deps.repoWorkspacePath,
                    );
                    worktreePath = wtp;
                    repoWorktreeCache.set(repo.id, worktreePath);
                    cleanups.push(cleanup);
                  }

                  const relevantFiles = new Set<string>();

                  // Search by terms (skip non-string entries from untyped JSON config)
                  for (const rawTerm of rs.searchTerms ?? []) {
                    if (typeof rawTerm !== 'string') continue;
                    const term = sanitizeSearchTerm(rawTerm);
                    if (!term) continue;
                    try {
                      const { stdout } = await execFileAsync(
                        'git', ['-C', worktreePath, 'grep', '-l', '--max-count=3', '-i', '--', term],
                        { timeout: 10_000 },
                      );
                      for (const line of stdout.trim().split('\n').filter(Boolean)) {
                        relevantFiles.add(line);
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
                    const content = await readRepoFiles(worktreePath, [...relevantFiles]);
                    if (content) {
                      freshRepoParts.push(`### Repository: ${repo.name}`, '', content, '');
                    }
                  }
                } catch (err) {
                  const errMsg = redactUrls(err instanceof Error ? err.message : String(err));
                  appLog.warn(`CUSTOM_AI_QUERY repo search failed for ${repo.name}: ${errMsg}`, { ticketId, repo: repo.name }, ticketId);
                }
              }
            }
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
          context: { ticketId, clientId, ticketCategory: category, skipClientMemory: !!(inc?.clientContext && clientContext) },
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
        appLog.info(`Custom AI query complete via ${queryRes.provider}/${queryRes.model}`, { ticketId, taskType: queryTaskType, stepName: step.name }, ticketId);
        break;
      }

      case RouteStepType.DRAFT_FINDINGS_EMAIL: {
        if (!ctx.emailFrom) {
          appLog.info('Skipping DRAFT_FINDINGS_EMAIL — no email context', { ticketId }, ticketId, 'ticket');
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
          context: { ticketId, clientId },
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
          appLog.info(`${reanalysisCtx ? 'Re-analysis' : 'Analysis'} findings email sent to ${emailFrom}${needsUserInput ? ' (with questions)' : ''}`, { ticketId, to: emailFrom, reanalysis: !!reanalysisCtx, needsUserInput }, ticketId);
        } else {
          appLog.info(`${reanalysisCtx ? 'Re-analysis' : 'Analysis'} findings email skipped (send blocked by loop guard)`, { ticketId, to: emailFrom, reanalysis: !!reanalysisCtx }, ticketId);
        }
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
          context: { ticketId, clientId },
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

        // Parse and record (re-use existing action execution logic inline)
        try {
          const cleaned = nextStepsRes.content.replace(/```json\n?|\n?```/g, '').trim();
          const parsed: unknown = JSON.parse(cleaned);
          if (Array.isArray(parsed)) {
            await db.ticketEvent.create({
              data: {
                ticketId,
                eventType: 'AI_RECOMMENDATION',
                content: nextStepsRes.content,
                metadata: { phase: 'next_steps', aiProvider: nextStepsRes.provider, aiModel: nextStepsRes.model, routeId: route.id },
                actor: 'system:analyzer',
              },
            });
          }
        } catch {
          await db.ticketEvent.create({
            data: {
              ticketId,
              eventType: 'AI_RECOMMENDATION',
              content: nextStepsRes.content,
              metadata: { phase: 'next_steps', aiProvider: nextStepsRes.provider, aiModel: nextStepsRes.model, parsed: false, routeId: route.id },
              actor: 'system:analyzer',
            },
          });
        }
        break;
      }

      case RouteStepType.UPDATE_TICKET_SUMMARY: {
        await updateTicketSummary(deps, ticketId, {
          taskTypeOverride: step.taskTypeOverride,
          promptKeyOverride: step.promptKeyOverride,
        });
        break;
      }

      case RouteStepType.CREATE_TICKET: {
        // CREATE_TICKET is an ingestion-only step. In analysis routes the ticket already
        // exists, so this is a no-op.
        appLog.info('CREATE_TICKET step skipped — ticket already exists in analysis pipeline', { ticketId }, ticketId);
        break;
      }

      case RouteStepType.DISPATCH_TO_ROUTE: {
        if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
          logger.warn({ ticketId, routeId: route.id, dispatchDepth }, `Dispatch depth limit (${MAX_DISPATCH_DEPTH}) reached, skipping DISPATCH_TO_ROUTE`);
          appLog.warn(`Dispatch depth limit reached (${dispatchDepth}/${MAX_DISPATCH_DEPTH}), skipping dispatch`, { ticketId, routeId: route.id, dispatchDepth }, ticketId);
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
          appLog.info(`Dispatching to route "${safeDest}" (${mode}, depth ${dispatchDepth + 1})`, { ticketId, fromRouteId: route.id, toRouteId: dispatchedRoute.id, dispatchDepth: dispatchDepth + 1 }, ticketId);

          await executeRoutePipeline(
            deps,
            ctx,
            dispatchedRoute,
            bullmqJobId,
            { summary, category, priority, facts, clientContext },
            dispatchDepth + 1,
            reanalysisCtx,
          );

          appLog.info(`Dispatch to "${safeDest}" completed, ending current route`, { ticketId, routeId: route.id }, ticketId);
          return;
        }

        logger.info({ ticketId, routeId: route.id, category, mode }, 'No different route resolved for dispatch, continuing current route');
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
            appLog.info(`Operator notification sent to ${notifyTo}`, { ticketId, to: notifyTo }, ticketId);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            appLog.error(`NOTIFY_OPERATOR email failed: ${errMsg}`, { err, ticketId, to: notifyTo }, ticketId);
          }
        } else if (notifyTo !== '') {
          // Non-empty emailTo configured but invalid — warn and skip to avoid broad operator broadcast
          appLog.warn('NOTIFY_OPERATOR skipped — invalid emailTo configured', { ticketId, stepId: step.id, emailTo: notifyTo }, ticketId);
        } else if (mailer) {
          try {
            // No emailTo configured — look up assigned operator for targeted notification
            const ticket = ticketId ? await db.ticket.findUnique({ where: { id: ticketId }, select: { assignedOperatorId: true } }) : null;
            const notified = await notifyOperatorsFn(
              mailer,
              () => db.operator.findMany({ where: { isActive: true } }),
              { subject: notifySubject, body: notifyBody, operatorId: ticket?.assignedOperatorId ?? undefined },
            );
            if (notified.length > 0) {
              await db.ticketEvent.create({
                data: {
                  ticketId,
                  eventType: 'EMAIL_OUTBOUND',
                  content: notifyBody,
                  metadata: { type: 'operator_notification', to: notified, subject: notifySubject },
                  actor: 'system:analyzer',
                },
              });
              appLog.info(`Operator notifications sent to ${notified.join(', ')}`, { ticketId, to: notified }, ticketId);
            } else {
              appLog.warn('NOTIFY_OPERATOR skipped — no operators configured for email notifications', { ticketId, stepId: step.id }, ticketId);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            appLog.error(`NOTIFY_OPERATOR multi-operator email failed: ${errMsg}`, { err, ticketId }, ticketId);
          }
        }
        break;
      }

      case RouteStepType.ADD_FOLLOWER: {
        const stepConfig = step.config as Record<string, unknown> | null;
        const rawEmail = stepConfig?.['email'];
        const rawDomain = stepConfig?.['emailDomain'];
        const followerType = (stepConfig?.['followerType'] === 'REQUESTER' ? 'REQUESTER' : 'FOLLOWER') as 'REQUESTER' | 'FOLLOWER';

        const contactsToAdd: Array<{ id: string }> = [];

        if (typeof rawEmail === 'string' && rawEmail.trim()) {
          const contact = await db.contact.findFirst({
            where: { email: { equals: rawEmail.trim(), mode: 'insensitive' }, clientId: ctx.clientId },
            select: { id: true },
          });
          if (contact) {
            contactsToAdd.push(contact);
          } else {
            appLog.warn(`ADD_FOLLOWER skipped — no contact found for email "${rawEmail}"`, { ticketId, email: rawEmail }, ticketId);
          }
        } else if (typeof rawDomain === 'string' && rawDomain.trim()) {
          const domainContacts = await db.contact.findMany({
            where: { email: { endsWith: `@${rawDomain.trim().toLowerCase()}`, mode: 'insensitive' }, clientId: ctx.clientId },
            select: { id: true },
          });
          if (domainContacts.length > 0) {
            contactsToAdd.push(...domainContacts);
          } else {
            appLog.warn(`ADD_FOLLOWER skipped — no contacts found for domain "${rawDomain}"`, { ticketId, domain: rawDomain }, ticketId);
          }
        } else {
          appLog.warn('ADD_FOLLOWER skipped — no email or emailDomain in step config', { ticketId, stepId: step.id }, ticketId);
          break;
        }

        let addedCount = 0;
        for (const c of contactsToAdd) {
          try {
            await db.ticketFollower.upsert({
              where: { ticketId_contactId: { ticketId, contactId: c.id } },
              create: { ticketId, contactId: c.id, followerType },
              update: { followerType },
            });
            addedCount++;
          } catch (err) {
            logger.warn({ err, ticketId, contactId: c.id }, 'Failed to add follower');
          }
        }
        if (addedCount > 0) {
          appLog.info(`Added ${addedCount} follower(s) as ${followerType}`, { ticketId, count: addedCount, followerType }, ticketId);
        }
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

  appLog.info(`Route pipeline "${safeName}" completed`, { ticketId, routeId: route.id }, ticketId);
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
        );
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const analysisError = redactUrls(rawMsg).slice(0, 1000);
        await deps.db.ticket.update({
          where: { id: ticketId },
          data: { analysisStatus: AnalysisStatus.FAILED, analysisError },
        });
        appLog.error(`Re-analysis pipeline failed: ${rawMsg}`, { err, ticketId }, ticketId);
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

    if (route) {
      // Route-driven pipeline
      try {
        await executeRoutePipeline(deps, ctx, route, String(job.id ?? randomUUID()));
        await deps.db.ticket.update({
          where: { id: ticketId },
          data: { analysisStatus: AnalysisStatus.COMPLETED, analysisError: null, lastAnalyzedAt: new Date() },
        });
        appLog.info(
          'Ticket analysis pipeline completed successfully (route-driven)',
          { ticketId, routeId: route.id },
          ticketId,
        );
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const analysisError = redactUrls(rawMsg).slice(0, 1000);
        await deps.db.ticket.update({
          where: { id: ticketId },
          data: { analysisStatus: AnalysisStatus.FAILED, analysisError },
        });
        appLog.error(`Route pipeline failed: ${rawMsg}`, { err, ticketId, routeId: route.id }, ticketId);
        await deps.db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'SYSTEM_NOTE',
            content: `Route pipeline "${sanitizeName(route.name)}" failed: ${analysisError}`,
            actor: 'system:analyzer',
          },
        });
        throw err;
      }
      return;
    }

    // Phase 1: Send receipt confirmation (fast, Ollama-only) — skip for non-email tickets
    let triageSummaryPromise: Promise<void> | undefined;
    if (ctx.emailFrom) {
    try {
      const result = await sendReceiptConfirmation(deps, ctx);
      triageSummaryPromise = result.triageSummaryPromise;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      appLog.error(
        `Receipt confirmation failed after ${EMAIL_RETRY_MAX_ATTEMPTS} attempts — continuing to analysis: ${errMsg}`,
        { err, ticketId, attempts: EMAIL_RETRY_MAX_ATTEMPTS },
        ticketId,
        'ticket',
      );

      // Record a persistent alert on the ticket so the operator sees it.
      // Best-effort — analysis must continue even if this DB write fails.
      try {
        await deps.db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'SYSTEM_NOTE',
            content: [
              `⚠ Receipt confirmation email to ${ctx.emailFrom} failed after ${EMAIL_RETRY_MAX_ATTEMPTS} attempts.`,
              `Error: ${errMsg}`,
              'The analysis pipeline will continue, but the requester has not been notified.',
              'Please send a manual confirmation or check SMTP configuration.',
            ].join('\n'),
            metadata: {
              alertType: 'receipt_email_failure',
              to: ctx.emailFrom,
              attempts: EMAIL_RETRY_MAX_ATTEMPTS,
              error: errMsg,
            },
            actor: 'system:analyzer',
          },
        });
      } catch (eventErr) {
        appLog.error('Failed to create ticketEvent for receipt confirmation failure', { err: eventErr, ticketId }, ticketId, 'ticket');
      }
      // Continue to analysis even if receipt (or alert creation) fails
    }
    } else {
      appLog.info('Skipping receipt confirmation — no email context (non-email ticket)', { ticketId }, ticketId, 'ticket');
    }

    // Phase 2: Deep analysis and findings (involves repos, MCP, Claude)
    try {
      await deepAnalysis(deps, ctx, String(job.id ?? randomUUID()), triageSummaryPromise);
      await deps.db.ticket.update({
        where: { id: ticketId },
        data: { analysisStatus: AnalysisStatus.COMPLETED, analysisError: null, lastAnalyzedAt: new Date() },
      });
      appLog.info('Ticket analysis pipeline completed successfully', { ticketId }, ticketId, 'ticket');
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const analysisError = redactUrls(rawMsg).slice(0, 1000);
      await deps.db.ticket.update({
        where: { id: ticketId },
        data: { analysisStatus: AnalysisStatus.FAILED, analysisError },
      });
      appLog.error(`Deep analysis failed: ${rawMsg}`, { err, ticketId }, ticketId, 'ticket');
      // Record the failure as a system note
      await deps.db.ticketEvent.create({
        data: {
          ticketId,
          eventType: 'SYSTEM_NOTE',
          content: `Automated analysis failed: ${analysisError}`,
          actor: 'system:analyzer',
        },
      });
      throw err; // Let BullMQ handle retry
    }
  };
}
