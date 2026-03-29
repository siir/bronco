import { getDb, disconnectDb } from '@bronco/db';
import { createAIRouter } from '@bronco/ai-provider';
import { createLogger, createQueue, createWorker, decrypt, AppLogger, createPrismaLogWriter, setGlobalLogWriter, createHealthServer, createGracefulShutdown } from '@bronco/shared-utils';
import type { TicketCreatedJob, AnalysisJob } from '@bronco/shared-types';
import { getConfig } from './config.js';
import { pollEmails } from './poller.js';
import { createEmailProcessor, initEmailProcessorLogger } from './processor.js';
import { Mailer } from '@bronco/shared-utils';
import type { EmailJob } from './processor.js';

const logger = createLogger('imap-worker');
const appLog = new AppLogger('imap-worker');

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  // Initialize database loggers
  const logWriter = createPrismaLogWriter(db);
  appLog.setWriter(logWriter);
  setGlobalLogWriter(logWriter);
  initEmailProcessorLogger(db);
  appLog.info('IMAP worker starting');

  // --- SMTP mailer ---
  const mailer = new Mailer({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    user: config.SMTP_USER,
    password: config.SMTP_PASSWORD,
    from: config.SMTP_FROM,
    fromName: config.EMAIL_SENDER_NAME,
  });

  // --- AI router (DB-backed provider config) ---
  const { ai } = createAIRouter(db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  // Verify SMTP connectivity at startup to catch config issues early
  const smtpOk = await mailer.verify();
  if (smtpOk) {
    appLog.info('SMTP verification succeeded');
  } else {
    appLog.warn('SMTP verification failed — outbound emails will likely fail');
  }

  // --- Queues ---
  const emailQueue = createQueue('email-ingestion', config.REDIS_URL);
  const ticketCreatedQueue = createQueue<TicketCreatedJob>('ticket-created', config.REDIS_URL);
  const analysisQueue = createQueue<AnalysisJob>('ticket-analysis', config.REDIS_URL);

  // --- Workers ---
  const emailProcessor = createEmailProcessor(db, ticketCreatedQueue, ai, analysisQueue);
  const emailWorker = createWorker<EmailJob>('email-ingestion', config.REDIS_URL, emailProcessor);

  emailWorker.on('completed', (job) => {
    appLog.info('Email job completed', { jobId: job.id, messageId: job.data.messageId });
  });

  emailWorker.on('failed', (job, err) => {
    appLog.error(`Email job failed: ${err.message}`, { err, jobId: job?.id, messageId: job?.data.messageId });
  });

  const hasGlobalImap = !!(config.IMAP_HOST && config.IMAP_USER && config.IMAP_PASSWORD);

  // Health tracking state
  let lastPollAt: Date | undefined;
  let pollCount = 0;

  const health = createHealthServer('imap-worker', config.HEALTH_PORT, {
    getDetails: () => ({
      lastPollAt: lastPollAt?.toISOString() ?? null,
      pollCount,
      pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
      hasGlobalImap,
      smtpVerified: smtpOk,
    }),
  });

  // Poll a single IMAP mailbox and enqueue emails for processing.
  const pollMailbox = async (imapConfig: { host: string; port: number; user: string; password: string }, label: string) => {
    try {
      const emails = await pollEmails({
        host: imapConfig.host,
        port: imapConfig.port,
        user: imapConfig.user,
        password: imapConfig.password,
        tls: true,
      });

      for (const email of emails) {
        await emailQueue.add('process-email', {
          uid: email.uid,
          source: email.source.toString('base64'),
          messageId: email.messageId,
        });
      }

      if (emails.length > 0) {
        appLog.info(`Polled ${emails.length} email(s) from ${label}`, { count: emails.length, mailbox: label });
      }
    } catch (err) {
      appLog.error(`Poll cycle failed for mailbox: ${label}`, { err, mailbox: label });
    }
  };

  // Polling loop: polls the global IMAP mailbox + all active per-client IMAP integrations.
  const poll = async () => {
    lastPollAt = new Date();
    pollCount++;

    // 1. Poll the global/default mailbox (from env vars)
    if (hasGlobalImap) {
      await pollMailbox(
        { host: config.IMAP_HOST, port: config.IMAP_PORT, user: config.IMAP_USER, password: config.IMAP_PASSWORD },
        'global',
      );
    }

    // 2. Poll per-client IMAP integrations from the database
    try {
      const imapIntegrations = await db.clientIntegration.findMany({
        where: { type: 'IMAP', isActive: true },
        include: { client: { select: { name: true, shortCode: true } } },
      });

      for (const integ of imapIntegrations) {
        const rawCfg = integ.config as { host?: string; port?: number; user?: string; encryptedPassword?: string };
        let password = rawCfg.encryptedPassword;
        if (password) {
          const segments = password.split(':');
          const isEncrypted = segments.length === 3 && segments.every((s) => s.length > 0);
          if (isEncrypted) {
            try {
              password = decrypt(password, config.ENCRYPTION_KEY);
            } catch (err) {
              appLog.error('Failed to decrypt IMAP password; skipping', { err, integrationId: integ.id });
              continue;
            }
          }
        }
        if (rawCfg.host && rawCfg.user && password) {
          await pollMailbox(
            { host: rawCfg.host, port: rawCfg.port ?? 993, user: rawCfg.user, password },
            `${integ.client.shortCode}/${integ.label}`,
          );
        }
      }
    } catch (err) {
      appLog.error('Failed to poll per-client IMAP integrations', { err });
    }
  };

  if (!hasGlobalImap) {
    appLog.info('No global IMAP config — will poll per-client IMAP integrations only');
  }

  // Initial poll
  await poll();

  // Schedule recurring polls
  const interval = setInterval(poll, config.POLL_INTERVAL_SECONDS * 1000);

  appLog.info('IMAP worker started', { intervalSeconds: config.POLL_INTERVAL_SECONDS });

  createGracefulShutdown(logger, [
    { interval },
    health,
    emailWorker,
    emailQueue,
    ticketCreatedQueue,
    analysisQueue,
    mailer,
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start IMAP worker');
  process.exit(1);
});
