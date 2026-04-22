import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { Job, Queue } from 'bullmq';
import { type PrismaClient } from '@bronco/db';
import { TaskType, EmailClassification, EmailProcessingStatus, TicketSource } from '@bronco/shared-types';
import type { IngestionJob, EmailIngestionPayload } from '@bronco/shared-types';
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

export function createEmailProcessor(db: PrismaClient, ingestQueue: Queue<IngestionJob>, ai?: AIRouter) {
  return async function processEmail(job: Job<EmailJob>): Promise<void> {
    const { source, messageId } = job.data;
    const raw = Buffer.from(source, 'base64');
    const emailHash = hashEmailSource(raw);
    const startMs = Date.now();

    // Mutable state for email processing log
    let classification: EmailClassification = EmailClassification.TICKET_WORTHY;
    let logStatus: EmailProcessingStatus = EmailProcessingStatus.PROCESSED;
    let logClientId: string | null = null;
    let logErrorMessage: string | null = null;
    let fromAddress = 'unknown';
    let fromName: string | null = null;
    let subject = '(No subject)';
    let textBody = '';
    let htmlBody: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | string[] | undefined;
    let hasAttachments = false;
    let emailDate: string | undefined;

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
    htmlBody = parsed.html || undefined;
    inReplyTo = parsed.inReplyTo;
    references = parsed.references;
    hasAttachments = (parsed.attachments?.length ?? 0) > 0;
    emailDate = parsed.date?.toISOString();

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
          context: {
            entityType: 'email',
            entityId: messageId,
            clientId: null, // client not yet resolved at pre-ingest classification stage
          },
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
        // Non-fatal — proceed with ingestion if classification fails
        appLog.warn('Email classification failed — proceeding with ingestion', { err, messageId });
      }
    }

    // --- Person / client resolution ---
    // Under the unified identity model a Person is global — pick the first
    // ClientUser row to route the ticket. Wave 2A may refine the selection
    // logic (e.g. most-recent client, explicit portal clientId).
    const person = await db.person.findFirst({
      where: { email: { equals: fromAddress, mode: 'insensitive' } },
      include: {
        clientUsers: {
          include: { client: { select: { id: true, name: true } } },
          // Prefer the primary-contact row, then oldest — matches the portal
          // login resolution rule. Without this a Person linked to multiple
          // tenants could route email to the wrong client.
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 1,
        },
      },
    });
    const personClientId = person?.clientUsers[0]?.clientId ?? null;
    const personClientName = person?.clientUsers[0]?.client.name ?? null;

    appLog.info(
      person
        ? `Sender matched to person: ${person.name}${personClientName ? ` (client: ${personClientName})` : ' (no client linkage yet)'}`
        : `No person match for sender: ${fromAddress}`,
      { from: fromAddress, personId: person?.id, clientId: personClientId },
    );

    // Domain-based routing
    let domainClient: { id: string } | null = null;
    if (!person || !personClientId) {
      const domain = fromAddress.split('@')[1]?.toLowerCase();
      if (domain) {
        domainClient = await db.client.findFirst({
          where: { domainMappings: { has: domain }, isActive: true },
          select: { id: true },
        });
        if (domainClient) {
          appLog.warn(`Matched sender by domain mapping: ${domain} — no person record exists, consider adding one`, { domain, clientId: domainClient.id, from: fromAddress });
        } else {
          appLog.info(`No domain mapping match for: ${domain}`, { domain, from: fromAddress });
        }
      }
    }

    logClientId = personClientId ?? domainClient?.id ?? null;

    // --- Resolve client ID (fall back to _unknown) ---
    const clientId = personClientId ?? domainClient?.id ?? (
      await db.client.upsert({
        where: { shortCode: '_unknown' },
        create: { name: 'Unknown', shortCode: '_unknown' },
        update: {},
        select: { id: true },
      })
    ).id;
    logClientId = clientId;

    // --- Classify replies for email processing logs ---
    if (inReplyTo || (Array.isArray(references) ? references.length > 0 : !!references)) {
      classification = EmailClassification.THREAD_REPLY;
    }

    // --- Build payload and push to ingestion queue ---
    const refsArray = Array.isArray(references) ? references : references ? [references] : [];
    const emailPayload: EmailIngestionPayload = {
      from: fromAddress,
      fromName: fromName ?? undefined,
      subject,
      body: textBody,
      bodyHtml: htmlBody,
      messageId: hasRealMessageId ? messageId : undefined,
      inReplyTo,
      references: refsArray.length > 0 ? refsArray : undefined,
      date: emailDate,
      hasAttachments: hasAttachments || undefined,
      emailHash,
      personId: person?.id,
    };

    const ingestionJob: IngestionJob = {
      source: TicketSource.EMAIL,
      clientId,
      payload: emailPayload as unknown as Record<string, unknown>,
    };

    await ingestQueue.add('ticket-ingest', ingestionJob, {
      jobId: `ingest-email-${emailHash}`,
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
    });

    appLog.info('Email passed to ingestion queue', { messageId, clientId, from: fromAddress, subject });

    // Record successful processing log
    await recordEmailLog(db, { messageId, fromAddress, fromName, subject, classification, status: logStatus, clientId: logClientId, processingMs: Date.now() - startMs, textBody, inReplyTo, references, hasAttachments });

    } catch (err) {
      logStatus = EmailProcessingStatus.FAILED;
      logErrorMessage = err instanceof Error ? err.message : String(err);
      appLog.error('Email processing failed', { err, messageId, from: fromAddress, subject });

      // Record failure in email processing log
      await recordEmailLog(db, { messageId, fromAddress, fromName, subject, classification, status: logStatus, clientId: logClientId, errorMessage: logErrorMessage, processingMs: Date.now() - startMs, textBody, inReplyTo, references }).catch((logErr) => {
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
