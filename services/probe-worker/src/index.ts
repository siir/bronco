import { getDb, disconnectDb } from '@bronco/db';
import { createAIRouter } from '@bronco/ai-provider';
import { createLogger, createQueue, createWorker, Mailer, AppLogger, createPrismaLogWriter, setGlobalLogWriter, createHealthServer, createGracefulShutdown, loadSmtpFromDb } from '@bronco/shared-utils';
import type { TicketCreatedJob, IngestionJob } from '@bronco/shared-types';
import { getConfig } from './config.js';
import { ProbeScheduler, initProbeWorkerLogger } from './probe-worker.js';

const logger = createLogger('probe-worker');
const appLog = new AppLogger('probe-worker');

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  // Initialize database loggers
  const logWriter = createPrismaLogWriter(db);
  appLog.setWriter(logWriter);
  setGlobalLogWriter(logWriter);
  initProbeWorkerLogger(db);
  appLog.info('Probe worker starting');

  // --- SMTP mailer (DB config takes priority, env vars as fallback) ---
  let mailer: Mailer | null = null;
  const dbSmtp = await loadSmtpFromDb(db, config.ENCRYPTION_KEY);
  const smtpLoader = () => loadSmtpFromDb(db, config.ENCRYPTION_KEY);
  if (dbSmtp) {
    mailer = new Mailer(dbSmtp, smtpLoader);
  } else if (config.SMTP_HOST && config.SMTP_USER && config.SMTP_FROM && config.SMTP_PASSWORD) {
    logger.warn('No SMTP config in DB — falling back to env vars');
    mailer = new Mailer({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      from: config.SMTP_FROM,
      fromName: config.EMAIL_SENDER_NAME,
    });
  } else {
    logger.warn('No SMTP config available (DB or env vars) — email sending disabled');
  }

  // --- AI router (DB-backed provider config) ---
  const { ai } = createAIRouter(db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  // --- Ticket-created queue (legacy path for probes without ingestion routes) ---
  const ticketCreatedQueue = createQueue<TicketCreatedJob>('ticket-created', config.REDIS_URL);

  // --- Ingestion queue (new path — raw probe results processed by ingestion engine) ---
  const ingestQueue = createQueue<IngestionJob>('ticket-ingest', config.REDIS_URL);

  // --- Scheduled probe scheduler ---
  const probeScheduler = new ProbeScheduler({ db, ai, mailer, encryptionKey: config.ENCRYPTION_KEY, artifactStoragePath: config.ARTIFACT_STORAGE_PATH, mcpRepoUrl: config.MCP_REPO_URL, ticketCreatedQueue, ingestQueue });
  await probeScheduler.start();

  // BullMQ worker for one-off probe executions (triggered from API)
  const probeQueue = createQueue('probe-execution', config.REDIS_URL);
  const probeWorker = createWorker<{ probeId: string }>(
    'probe-execution',
    config.REDIS_URL,
    async (job) => {
      await probeScheduler.executeById(job.data.probeId);
    },
  );

  probeWorker.on('failed', (job, err) => {
    appLog.error(`Probe execution job failed: ${err.message}`, { err, probeId: job?.data.probeId });
  });

  const health = createHealthServer('probe-worker', config.HEALTH_PORT, {
    getDetails: () => ({
      probeSchedulerActive: true,
    }),
  });

  appLog.info('Probe worker started');

  createGracefulShutdown(logger, [
    health,
    probeWorker,
    probeQueue,
    ticketCreatedQueue,
    ingestQueue,
    ...(mailer ? [mailer] : []),
    { fn: () => probeScheduler.stop() },
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start probe worker');
  process.exit(1);
});
