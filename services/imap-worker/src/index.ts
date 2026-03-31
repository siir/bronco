import { getDb, disconnectDb } from '@bronco/db';
import { createAIRouter } from '@bronco/ai-provider';
import { createLogger, createQueue, createWorker, decrypt, looksEncrypted, AppLogger, createPrismaLogWriter, setGlobalLogWriter, createHealthServer, createGracefulShutdown } from '@bronco/shared-utils';
import type { IngestionJob } from '@bronco/shared-types';
import { getConfig } from './config.js';
import { pollEmails } from './poller.js';
import { createEmailProcessor, initEmailProcessorLogger } from './processor.js';
import type { EmailJob } from './processor.js';

const SETTINGS_KEY_IMAP = 'system-config-imap';

const logger = createLogger('imap-worker');
const appLog = new AppLogger('imap-worker');

interface ImapDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  pollIntervalSeconds?: number;
}

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

  // Read global IMAP config from DB (AppSetting table)
  const loadGlobalImapConfig = async (): Promise<ImapDbConfig | null> => {
    try {
      const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_IMAP } });
      if (!row) return null;
      const cfg = row.value as Record<string, unknown>;
      if (!cfg.host || !cfg.user || !cfg.password) return null;
      const password = typeof cfg.password === 'string' && looksEncrypted(cfg.password)
        ? decrypt(cfg.password, config.ENCRYPTION_KEY)
        : cfg.password as string;
      return {
        host: cfg.host as string,
        port: (cfg.port as number) ?? 993,
        user: cfg.user as string,
        password,
        pollIntervalSeconds: cfg.pollIntervalSeconds as number | undefined,
      };
    } catch (err) {
      appLog.error('Failed to load global IMAP config from DB', { err });
      return null;
    }
  };

  // Health tracking state
  let lastPollAt: Date | undefined;
  let pollCount = 0;

  const health = createHealthServer('imap-worker', config.HEALTH_PORT, {
    getDetails: () => ({
      lastPollAt: lastPollAt?.toISOString() ?? null,
      pollCount,
      pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
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

  // Polling loop: polls the global IMAP mailbox (from DB) + all active per-client IMAP integrations.
  const poll = async () => {
    lastPollAt = new Date();
    pollCount++;

    // 1. Poll the global/default mailbox (from DB system settings)
    const globalImap = await loadGlobalImapConfig();
    if (globalImap) {
      await pollMailbox(
        { host: globalImap.host, port: globalImap.port, user: globalImap.user, password: globalImap.password },
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

  // Check initial state and log
  const initialConfig = await loadGlobalImapConfig();
  if (!initialConfig) {
    appLog.info('No global IMAP config in DB — will poll per-client IMAP integrations only');
  }

  // Initial poll
  await poll();

  // Schedule recurring polls (use DB poll interval if set, else env/default)
  const pollIntervalSeconds = initialConfig?.pollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS;
  const interval = setInterval(poll, pollIntervalSeconds * 1000);

  appLog.info('IMAP worker started', { intervalSeconds: pollIntervalSeconds });

  createGracefulShutdown(logger, [
    { interval },
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
