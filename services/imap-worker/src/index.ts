import { getDb, disconnectDb } from '@bronco/db';
import { createAIRouter } from '@bronco/ai-provider';
import { createLogger, createQueue, createWorker, decrypt, looksEncrypted, AppLogger, createPrismaLogWriter, setGlobalLogWriter, createHealthServer, createGracefulShutdown, loadImapFromDb } from '@bronco/shared-utils';
import type { IngestionJob } from '@bronco/shared-types';
import { getConfig } from './config.js';
import { pollEmails } from './poller.js';
import { createEmailProcessor, initEmailProcessorLogger } from './processor.js';
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

  // --- AI router (DB-backed provider config) ---
  const { ai } = createAIRouter(db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  // --- Queues ---
  const emailQueue = createQueue('email-ingestion', config.REDIS_URL);
  const ingestQueue = createQueue<IngestionJob>('ticket-ingest', config.REDIS_URL);

  // --- Workers ---
  const emailProcessor = createEmailProcessor(db, ingestQueue, ai);
  const emailWorker = createWorker<EmailJob>('email-ingestion', config.REDIS_URL, emailProcessor);

  emailWorker.on('completed', (job) => {
    appLog.info('Email job completed', { jobId: job.id, messageId: job.data.messageId });
  });

  emailWorker.on('failed', (job, err) => {
    appLog.error(`Email job failed: ${err.message}`, { err, jobId: job?.id, messageId: job?.data.messageId });
  });

  // Read global IMAP config from DB via shared loader (Zod-validated, decrypts password)
  const loadGlobalImapConfig = () => loadImapFromDb(db, config.ENCRYPTION_KEY);

  // Health tracking state
  let lastPollAt: Date | undefined;
  let pollCount = 0;
  let effectivePollInterval = config.POLL_INTERVAL_SECONDS;

  const health = createHealthServer('imap-worker', config.HEALTH_PORT, {
    getDetails: () => ({
      lastPollAt: lastPollAt?.toISOString() ?? null,
      pollCount,
      pollIntervalSeconds: effectivePollInterval,
    }),
  });

  // Poll a single IMAP mailbox and enqueue emails for processing.
  const pollMailbox = async (imapConfig: { host: string; port: number; user: string; password: string; secure?: boolean }, label: string) => {
    try {
      const emails = await pollEmails({
        host: imapConfig.host,
        port: imapConfig.port,
        user: imapConfig.user,
        password: imapConfig.password,
        tls: imapConfig.secure ?? imapConfig.port === 993,
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

  // Polling loop: polls the global IMAP mailbox (from DB) + all active per-client IMAP integrations.
  // Accepts the pre-loaded global config to avoid a redundant DB read (schedulePoll loads it once).
  const poll = async (globalImap: Awaited<ReturnType<typeof loadGlobalImapConfig>>) => {
    lastPollAt = new Date();
    pollCount++;

    // 1. Poll the global/default mailbox (from DB system settings)
    if (globalImap) {
      await pollMailbox(globalImap, 'global');
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
          const port = rawCfg.port ?? 993;
          await pollMailbox(
            { host: rawCfg.host, port, user: rawCfg.user, password, secure: port === 993 },
            `${integ.client.shortCode}/${integ.label}`,
          );
        }
      }
    } catch (err) {
      appLog.error('Failed to poll per-client IMAP integrations', { err });
    }
  };

  // Check initial state and log
  const initialConfig = await loadGlobalImapConfig();
  if (!initialConfig) {
    appLog.info('No global IMAP config in DB — will poll per-client IMAP integrations only');
  }

  // Self-scheduling poll loop: after each cycle, re-read the interval from DB so
  // changes to pollIntervalSeconds take effect without a worker restart.
  let pollTimeout: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedulePoll = async () => {
    if (stopped) return;
    // Load config once per cycle — used for both polling and interval scheduling.
    const currentDbConfig = await loadGlobalImapConfig();
    await poll(currentDbConfig);
    if (stopped) return;
    effectivePollInterval = currentDbConfig?.pollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS;
    pollTimeout = setTimeout(schedulePoll, effectivePollInterval * 1000);
  };

  // Set initial effective interval (from DB or env fallback) before first log line.
  effectivePollInterval = initialConfig?.pollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS;

  // Kick off the first poll immediately, then self-schedule.
  pollTimeout = setTimeout(schedulePoll, 0);

  appLog.info('IMAP worker started', { intervalSeconds: effectivePollInterval });

  createGracefulShutdown(logger, [
    {
      fn: () => {
        stopped = true;
        if (pollTimeout !== undefined) clearTimeout(pollTimeout);
      },
    },
    health,
    emailWorker,
    emailQueue,
    ingestQueue,
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start IMAP worker');
  process.exit(1);
});
