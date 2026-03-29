import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { Job, Queue } from 'bullmq';
import { type PrismaClient, Prisma, ensureClientUser } from '@bronco/db';
import { TaskType, EmailClassification, EmailProcessingStatus } from '@bronco/shared-types';
import type { TicketCreatedJob, AnalysisJob } from '@bronco/shared-types';
import type { AIRouter } from '@bronco/ai-provider';
import { AppLogger, createPrismaLogWriter } from '@bronco/shared-utils';

export const appLog = new AppLogger('email-processor');

export function initEmailProcessorLogger(db: PrismaClient): void {
  appLog.setWriter(createPrismaLogWriter(db));
}

export interface EmailJob {
  uid: number;
  source: string; // base64-encoded raw RFC822 email source
  messageId: string;
}

// ---------------------------------------------------------------------------
// Email noise filter — patterns for known automated / non-actionable senders
// ---------------------------------------------------------------------------

const NOISE_SENDER_PATTERNS = [
  /.*-noreply@google\.com$/i,
  /^noreply@/i,
  /^no-reply@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^notifications@github\.com$/i,
  /^notify@twitter\.com$/i,
  /^noreply@.*\.microsoft\.com$/i,
  /^noreply@medium\.com$/i,
];

const NOISE_SUBJECT_PATTERNS = [
  /explore your google workspace trial/i,
  /mandatory email service announcement/i,
  /your invoice is available/i,
  /newsletter/i,
  /unsubscribe/i,
];

function isNoiseSender(from: string): boolean {
  return NOISE_SENDER_PATTERNS.some((p) => p.test(from));
}

function isNoiseSubject(subject: string): boolean {
  return NOISE_SUBJECT_PATTERNS.some((p) => p.test(subject));
}

/**
 * Compute SHA-256 hash of raw email source for dedup when Message-ID
 * is missing or unreliable (e.g., generated UIDs like "uid-123").
 */
function hashEmailSource(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function createEmailProcessor(db: PrismaClient, ticketCreatedQueue?: Queue<TicketCreatedJob>, ai?: AIRouter, analysisQueue?: Queue<AnalysisJob>) {
  return async function processEmail(job: Job<EmailJob>): Promise<void> {
    const { source, messageId } = job.data;
    const raw = Buffer.from(source, 'base64');
    const emailHash = hashEmailSource(raw);
    const jobStartTime = new Date();
    const startMs = Date.now();

    // Mutable state for email processing log
    let classification: EmailClassification = EmailClassification.TICKET_WORTHY;
    let logStatus: EmailProcessingStatus = EmailProcessingStatus.PROCESSED;
    let logTicketId: string | null = null;
    let logClientId: string | null = null;
    let logErrorMessage: string | null = null;
    let fromAddress = 'unknown';
    let fromName: string | null = null;
    let subject = '(No subject)';
    let textBody = '';
    let inReplyTo: string | undefined;
    let references: string | string[] | undefined;
    let hasAttachments = false;

    appLog.info('Processing incoming email', { messageId, jobId: job.id });

    try {
    // --- Idempotency check ---
    const hasRealMessageId = messageId && !messageId.startsWith('uid-');

    if (hasRealMessageId) {
      const existing = await db.ticketEvent.findUnique({
        where: { emailMessageId: messageId },
        select: { id: true },
      });
      if (existing) {
        appLog.info('Skipping duplicate email (Message-ID match)', { messageId });
        return;
      }
    }

    const existingByHash = await db.ticketEvent.findUnique({
      where: { emailHash },
      select: { id: true },
    });
    if (existingByHash) {
      appLog.info('Skipping duplicate email (hash match)', { messageId, emailHash });
      return;
    }

    // --- Parse email ---
    const parsed = await simpleParser(raw);

    fromAddress = parsed.from?.value?.[0]?.address ?? 'unknown';
    fromName = parsed.from?.value?.[0]?.name ?? fromAddress;
    subject = parsed.subject ?? '(No subject)';
    textBody = parsed.text ?? '';
    inReplyTo = parsed.inReplyTo;
    references = parsed.references;
    hasAttachments = (parsed.attachments?.length ?? 0) > 0;

    appLog.info('Email parsed', { messageId, from: fromAddress, subject, hasInReplyTo: !!inReplyTo, referencesCount: Array.isArray(references) ? references.length : references ? 1 : 0 });

    // --- Noise filter (pattern-based) ---
    if (isNoiseSender(fromAddress)) {
      appLog.info('Filtered automated/noreply sender', { from: fromAddress, messageId });
      classification = EmailClassification.AUTO_REPLY;
      await recordEmailLog(db, { messageId, fromAddress, fromName, subject, classification, status: logStatus, processingMs: Date.now() - startMs, textBody, inReplyTo, references, hasAttachments });
      return;
    }
    if (isNoiseSubject(subject)) {
      appLog.info('Filtered noise email by subject', { subject, from: fromAddress, messageId });
      classification = EmailClassification.NOISE;
      await recordEmailLog(db, { messageId, fromAddress, fromName, subject, classification, status: logStatus, processingMs: Date.now() - startMs, textBody, inReplyTo, references, hasAttachments });
      return;
    }

    // --- AI-based noise classification (only for new emails, not replies) ---
    const isReply = !!inReplyTo || (Array.isArray(references) ? references.length > 0 : !!references);
    if (!isReply && ai) {
      try {
        const classifyRes = await ai.generate({
          taskType: TaskType.CLASSIFY_EMAIL,
          prompt: `Classify this email. Is it an actionable support request, bug report, feature request, or work item that should become a ticket? Or is it automated noise (marketing, newsletters, vendor promos, service announcements, delivery receipts)?

From: ${fromAddress}
Subject: ${subject}
Body (first 500 chars): ${textBody.slice(0, 500)}

Respond with ONLY one word: ACTIONABLE or NOISE`,
          systemPrompt: 'You classify emails as ACTIONABLE (support/work requests) or NOISE (automated, marketing, vendor promos). Respond with one word only.',
          maxTokens: 10,
        });
        const classificationResult = classifyRes.content.trim().toUpperCase();
        const firstToken = classificationResult.split(/\s+/)[0].replace(/[^A-Z]/g, '');
        if (firstToken === 'NOISE') {
          appLog.info('AI classified email as noise', { from: fromAddress, subject, messageId, model: classifyRes.model });
          classification = EmailClassification.NOISE;
          await recordEmailLog(db, { messageId, fromAddress, fromName, subject, classification, status: logStatus, processingMs: Date.now() - startMs, textBody, inReplyTo, references, hasAttachments });
          return;
        }
      } catch (err) {
        // Non-fatal — proceed with ticket creation if classification fails
        appLog.warn('Email classification failed — proceeding with ticket creation', { err, messageId });
      }
    }

    // Try to match sender to an existing contact
    const contact = await db.contact.findFirst({
      where: { email: { equals: fromAddress, mode: 'insensitive' } },
      include: { client: true },
    });

    appLog.info(contact ? `Sender matched to contact: ${contact.name} (client: ${contact.client.name})` : `No contact match for sender: ${fromAddress}`, { from: fromAddress, contactId: contact?.id, clientId: contact?.clientId });

    // Domain-based routing
    let domainClient: { id: string; autoRouteTickets: boolean } | null = null;
    if (!contact) {
      const domain = fromAddress.split('@')[1]?.toLowerCase();
      if (domain) {
        domainClient = await db.client.findFirst({
          where: { domainMappings: { has: domain }, isActive: true },
          select: { id: true, autoRouteTickets: true },
        });
        if (domainClient) {
          appLog.warn(`Matched sender by domain mapping: ${domain} — no contact record exists, consider adding a contact`, { domain, clientId: domainClient.id, from: fromAddress });
        } else {
          appLog.info(`No domain mapping match for: ${domain}`, { domain, from: fromAddress });
        }
      }
    }

    logClientId = contact?.clientId ?? domainClient?.id ?? null;

    // Auto-provision CLIENT user
    if (contact) {
      try {
        await ensureClientUser(db, {
          email: contact.email,
          name: contact.name,
          clientId: contact.clientId,
        });
      } catch (error) {
        appLog.error('Failed to auto-provision CLIENT user', { err: error, email: contact.email });
      }
    }

    // Try to find an existing ticket to thread into
    let ticketId: string | null = null;
    let isNewTicket = false;
    let threadMethod = 'none';

    if (inReplyTo || references) {
      const refIds = [
        ...(inReplyTo ? [inReplyTo] : []),
        ...(Array.isArray(references) ? references : references ? [references] : []),
      ];

      appLog.info('Attempting thread match by message references', { refIds });

      const existingEvent = await db.ticketEvent.findFirst({
        where: {
          emailMessageId: { in: refIds },
        },
        select: { ticketId: true },
      });

      if (existingEvent) {
        ticketId = existingEvent.ticketId;
        threadMethod = 'message-id-reference';
        appLog.info(`Threaded to existing ticket via message reference`, { ticketId }, ticketId, 'ticket');
      } else {
        appLog.info('No thread match found via message references', { refIds });
      }
    }

    // Fallback: match by normalized subject within 7 days
    const resolvedClientId = contact?.clientId ?? domainClient?.id;
    if (!ticketId && resolvedClientId) {
      const normalized = subject.replace(/^(Re|Fwd|Fw):\s*/gi, '').trim();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      appLog.info('Attempting thread match by subject', { normalized, clientId: resolvedClientId, since: sevenDaysAgo.toISOString() });

      const existingTicket = await db.ticket.findFirst({
        where: {
          clientId: resolvedClientId,
          subject: { contains: normalized, mode: 'insensitive' },
          createdAt: { gte: sevenDaysAgo },
          status: { not: 'CLOSED' },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (existingTicket) {
        ticketId = existingTicket.id;
        threadMethod = 'subject-match';
        appLog.info(`Threaded to existing ticket via subject match`, { ticketId, matchedSubject: existingTicket.subject }, ticketId, 'ticket');
      } else {
        appLog.info('No thread match found by subject', { normalized });
      }
    }

    // Set classification based on threading result
    if (ticketId) {
      classification = EmailClassification.THREAD_REPLY;
    }

    // Create new ticket if no thread match
    let resolvedTicketClientId: string | undefined;
    let resolvedAutoRouteTickets = true; // matches DB default
    if (!ticketId) {
      classification = EmailClassification.TICKET_WORTHY;
      const clientId = contact?.clientId ?? domainClient?.id ?? (
        await db.client.upsert({
          where: { shortCode: '_unknown' },
          create: { name: 'Unknown', shortCode: '_unknown' },
          update: {},
          select: { id: true },
        })
      ).id;

      logClientId = clientId;

      // AI-generated ticket title (falls back to email subject on failure)
      let ticketSubject = subject;
      if (ai) {
        try {
          const titleRes = await ai.generate({
            taskType: TaskType.GENERATE_TITLE,
            prompt: `Generate a short, descriptive ticket title (max 80 chars) for this email. The title should clearly describe the issue or request. Do NOT include "Re:", "Fwd:", ticket numbers, or the sender name. Return ONLY the title text, nothing else.

Subject: ${subject}
Body (first 500 chars): ${textBody.slice(0, 500)}`,
            systemPrompt: 'You generate concise, descriptive ticket titles from emails. Return only the title text, no quotes, no explanation.',
            maxTokens: 40,
          });
          const generated = titleRes.content.trim().replace(/^["']|["']$/g, '');
          if (generated.length > 5 && generated.length <= 80) {
            ticketSubject = generated;
          }
        } catch {
          // Non-fatal — use original subject
        }
      }

      let ticket: { id: string };
      for (let attempt = 0; attempt <= 3; attempt++) {
        const lastImapTicket = await db.ticket.findFirst({
          where: { clientId, ticketNumber: { gt: 0 } },
          orderBy: { ticketNumber: 'desc' },
          select: { ticketNumber: true },
        });
        const imapTicketNumber = (lastImapTicket?.ticketNumber ?? 0) + 1;

        try {
          ticket = await db.ticket.create({
            data: {
              clientId,
              subject: ticketSubject,
              description: textBody.slice(0, 2000),
              source: 'EMAIL',
              externalRef: messageId,
              ticketNumber: imapTicketNumber,
              ...(contact?.id && {
                followers: {
                  create: { contactId: contact.id, followerType: 'REQUESTER' },
                },
              }),
            },
          });
          break;
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 3) {
            appLog.warn(`Ticket number conflict — retrying (attempt ${attempt + 1})`, { clientId }, undefined, 'ticket');
            continue;
          }
          throw err;
        }
      }
      ticket = ticket!;
      ticketId = ticket.id;
      isNewTicket = true;
      resolvedTicketClientId = clientId;
      // Derive from already-fetched data — contact.client and domainClient are loaded above;
      // for the _unknown client the DB default (true) applies.
      resolvedAutoRouteTickets = contact?.client.autoRouteTickets ?? domainClient?.autoRouteTickets ?? true;
      appLog.info(`Created new ticket from email`, { ticketId, subject, clientId, from: fromAddress }, ticketId, 'ticket');
    }

    logTicketId = ticketId;

    // Retroactively tag pre-creation logs from this job with the resolved ticketId.
    // This ensures ticket summaries capture the full processing journey.
    await db.appLog.updateMany({
      where: {
        entityId: null,
        service: 'email-processor',
        createdAt: { gte: jobStartTime },
      },
      data: { entityId: ticketId, entityType: 'ticket' },
    });

    // Append email as ticket event
    await db.ticketEvent.create({
      data: {
        ticketId,
        eventType: 'EMAIL_INBOUND',
        content: textBody,
        emailMessageId: hasRealMessageId ? messageId : null,
        emailHash,
        metadata: {
          messageId,
          from: fromAddress,
          fromName,
          subject,
          inReplyTo,
          references: Array.isArray(references) ? references : references ? [references] : [],
          hasAttachments: (parsed.attachments?.length ?? 0) > 0,
        },
        actor: `email:${fromAddress}`,
      },
    });

    appLog.info(`Email processed — ${isNewTicket ? 'new ticket' : `threaded (${threadMethod})`}`, { ticketId, messageId, isNewTicket, threadMethod, from: fromAddress, subject }, ticketId, 'ticket');

    // --- Enqueue ticket-created event for new tickets ---
    if (isNewTicket && ticketCreatedQueue) {
      if (resolvedAutoRouteTickets === false) {
        appLog.info('Auto ticket routing disabled for client — AI analysis skipped', { ticketId, clientId: resolvedTicketClientId }, ticketId, 'ticket');
      } else {
        await ticketCreatedQueue.add('ticket-created', {
          ticketId,
          clientId: resolvedTicketClientId!,
          source: 'EMAIL' as const,
          category: null,
        }, {
          jobId: `ticket-created-${ticketId}`,
          attempts: 4,
          backoff: { type: 'exponential', delay: 30_000 },
        });
        appLog.info('Enqueued ticket-created event', { ticketId }, ticketId, 'ticket');
      }
    } else if (isNewTicket && !ticketCreatedQueue) {
      appLog.warn('New ticket created but no ticket-created queue available — analysis skipped', { ticketId }, ticketId, 'ticket');
    } else if (!isNewTicket && analysisQueue && ticketId) {
      // --- Check if this reply should trigger re-analysis ---
      await maybeEnqueueReanalysis(db, analysisQueue, ticketId, fromAddress, appLog);
    } else {
      appLog.info('Reply threaded to existing ticket — no new AI analysis', { ticketId, isNewTicket }, ticketId, 'ticket');
    }

    // Record successful processing log
    await recordEmailLog(db, { messageId, fromAddress, fromName, subject, classification, status: logStatus, clientId: logClientId, ticketId: logTicketId, processingMs: Date.now() - startMs, textBody, inReplyTo, references, hasAttachments });

    } catch (err) {
      logStatus = EmailProcessingStatus.FAILED;
      logErrorMessage = err instanceof Error ? err.message : String(err);
      appLog.error('Email processing failed', { err, messageId, from: fromAddress, subject });

      // Record failure in email processing log
      await recordEmailLog(db, { messageId, fromAddress, fromName, subject, classification, status: logStatus, clientId: logClientId, ticketId: logTicketId, errorMessage: logErrorMessage, processingMs: Date.now() - startMs, textBody, inReplyTo, references }).catch((logErr) => {
        appLog.error('Failed to record email processing log', { err: logErr, messageId });
      });

      throw err; // Re-throw so BullMQ can retry
    }
  };
}

// ---------------------------------------------------------------------------
// Email processing log — records each email's classification and processing result
// ---------------------------------------------------------------------------

interface EmailLogParams {
  messageId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  classification: EmailClassification;
  status: EmailProcessingStatus;
  clientId?: string | null;
  ticketId?: string | null;
  errorMessage?: string | null;
  processingMs: number;
  textBody: string;
  inReplyTo?: string;
  references?: string | string[];
  hasAttachments?: boolean;
}

async function recordEmailLog(db: PrismaClient, params: EmailLogParams): Promise<void> {
  const refsArray = Array.isArray(params.references)
    ? params.references
    : params.references ? [params.references] : [];

  const metadataValue = {
    body: params.textBody.slice(0, 50_000),
    inReplyTo: params.inReplyTo ?? null,
    references: refsArray,
    hasAttachments: params.hasAttachments ?? false,
  };

  await db.emailProcessingLog.upsert({
    where: { messageId: params.messageId },
    create: {
      messageId: params.messageId,
      from: params.fromAddress,
      fromName: params.fromName,
      subject: params.subject,
      receivedAt: new Date(),
      classification: params.classification,
      status: params.status,
      clientId: params.clientId ?? null,
      ticketId: params.ticketId ?? null,
      errorMessage: params.errorMessage ?? null,
      processingMs: params.processingMs,
      metadata: metadataValue,
    },
    update: {
      from: params.fromAddress,
      fromName: params.fromName,
      subject: params.subject,
      classification: params.classification,
      status: params.status,
      clientId: params.clientId ?? undefined,
      ticketId: params.ticketId ?? undefined,
      errorMessage: params.errorMessage ?? null,
      processingMs: params.processingMs,
      metadata: metadataValue,
    },
  });
}

// ---------------------------------------------------------------------------
// Re-analysis detection — checks conditions and enqueues a re-analysis job
// ---------------------------------------------------------------------------

async function maybeEnqueueReanalysis(
  db: PrismaClient,
  analysisQueue: Queue<AnalysisJob>,
  ticketId: string,
  senderAddress: string,
  log: AppLogger,
): Promise<void> {
  // 1. Load ticket to check status
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { status: true, clientId: true },
  });
  if (!ticket) return;

  // Only re-analyze tickets in WAITING or OPEN status
  if (ticket.status !== 'WAITING' && ticket.status !== 'OPEN') {
    log.info('Reply on non-active ticket — re-analysis skipped', { ticketId, status: ticket.status }, ticketId, 'ticket');
    return;
  }

  // 2. Check the ticket has had a completed analysis (findings email was sent to requester).
  // This prevents triggering re-analysis while initial analysis is still running — the
  // triage phase writes AI_ANALYSIS events early, but findings email is sent near the end.
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
    log.info('Ticket has no completed analysis (no findings email sent) — re-analysis skipped', { ticketId }, ticketId, 'ticket');
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
      log.info('Reply from own IMAP inbox — re-analysis skipped (loop prevention)', { ticketId, from: senderAddress }, ticketId, 'ticket');
      return;
    }
  }

  // Check against outbound email addresses used on this ticket
  const outboundEvents = await db.ticketEvent.findMany({
    where: { ticketId, eventType: 'EMAIL_OUTBOUND' },
    select: { metadata: true },
  });
  const outboundAddresses = new Set<string>();
  for (const ev of outboundEvents) {
    const meta = ev.metadata as Record<string, unknown> | null;
    if (typeof meta?.['from'] === 'string') {
      outboundAddresses.add(meta['from'].trim().toLowerCase());
    }
  }
  if (outboundAddresses.has(normalizedSender)) {
    log.info('Reply from system outbound address — re-analysis skipped (loop prevention)', { ticketId, from: senderAddress }, ticketId, 'ticket');
    return;
  }

  // 4. Dedupe: use deterministic jobId to prevent duplicate reanalysis jobs (O(1) lookup)
  const reanalysisJobId = `reanalysis-${ticketId}`;
  const existingJob = await analysisQueue.getJob(reanalysisJobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'active') {
      log.info('Re-analysis job already pending for this ticket — skipping', { ticketId, jobId: reanalysisJobId, state }, ticketId, 'ticket');
      return;
    }
    // Remove completed/failed job so the new one can reuse the deterministic ID
    try { await existingJob.remove(); } catch { /* job may have been cleaned up already */ }
  }

  // 5. Find the trigger event (most recent EMAIL_INBOUND for this ticket)
  const triggerEvent = await db.ticketEvent.findFirst({
    where: { ticketId, eventType: 'EMAIL_INBOUND' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  // All conditions met — enqueue re-analysis with deterministic jobId for dedup
  await analysisQueue.add('analyze-ticket', {
    ticketId,
    clientId: ticket.clientId ?? undefined,
    reanalysis: true,
    triggerEventId: triggerEvent?.id,
  }, {
    jobId: reanalysisJobId,
    attempts: 4,
    backoff: { type: 'exponential', delay: 30_000 },
  });

  log.info('Enqueued re-analysis for reply on analyzed ticket', { ticketId, triggerEventId: triggerEvent?.id }, ticketId, 'ticket');
}
