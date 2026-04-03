import { getDb, disconnectDb } from '@bronco/db';
import { createAIRouter } from '@bronco/ai-provider';
import { createLogger, createQueue, createWorker, Mailer, AppLogger, createPrismaLogWriter, setGlobalLogWriter, createHealthServer, createGracefulShutdown, loadSmtpFromDb } from '@bronco/shared-utils';
import type { TicketCreatedJob, IngestionJob } from '@bronco/shared-types';
import { getConfig } from './config.js';
import { createAnalysisProcessor, initAnalyzerLogger, cleanupStaleRepos } from './analyzer.js';
import type { AnalysisJob } from './analyzer.js';
import { createRouteDispatcher } from './route-dispatcher.js';
import { createIngestionProcessor } from './ingestion-engine.js';

const logger = createLogger('ticket-analyzer');
const appLog = new AppLogger('ticket-analyzer');

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  // Initialize database loggers
  const logWriter = createPrismaLogWriter(db);
  appLog.setWriter(logWriter);
  setGlobalLogWriter(logWriter);
  initAnalyzerLogger(db);
  appLog.info('Ticket analyzer starting');

  // --- SMTP mailer (DB config takes priority, env vars as fallback) ---
  let mailer: Mailer | null = null;
  const dbSmtp = await loadSmtpFromDb(db, config.ENCRYPTION_KEY);
  if (dbSmtp) {
    mailer = new Mailer(dbSmtp);
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

  // Derive sender identity from DB config (preferred) or env vars (fallback)
  const smtpFrom = dbSmtp?.from || config.SMTP_FROM;
  const senderSignature = dbSmtp?.fromName || config.EMAIL_SENDER_NAME;

  // --- AI router (DB-backed provider config) ---
  const { ai } = createAIRouter(db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  // --- Queues ---
  const analysisQueue = createQueue<AnalysisJob>('ticket-analysis', config.REDIS_URL);

  // --- Analysis worker ---
  const analysisProcessor = createAnalysisProcessor({
    db,
    ai,
    mailer,
    mcpDatabaseUrl: config.MCP_DATABASE_URL,
    senderSignature,
    repoWorkspacePath: config.REPO_WORKSPACE_PATH,
    encryptionKey: config.ENCRYPTION_KEY,
    mcpRepoUrl: config.MCP_REPO_URL,
  });
  const analysisWorker = createWorker<AnalysisJob>(
    'ticket-analysis',
    config.REDIS_URL,
    analysisProcessor,
  );

  analysisWorker.on('completed', (job) => {
    appLog.info('Ticket analysis job completed', { ticketId: job.data.ticketId }, job.data.ticketId, 'ticket');
  });

  analysisWorker.on('failed', (job, err) => {
    appLog.error(`Ticket analysis job failed: ${err.message}`, { err, ticketId: job?.data.ticketId }, job?.data.ticketId, 'ticket');
  });

  // --- Ticket-created event queue (route dispatcher) ---
  const ticketCreatedQueue = createQueue<TicketCreatedJob>('ticket-created', config.REDIS_URL);
  const routeDispatcher = createRouteDispatcher({ db, analysisQueue });
  const ticketCreatedWorker = createWorker<TicketCreatedJob>(
    'ticket-created',
    config.REDIS_URL,
    routeDispatcher,
  );

  ticketCreatedWorker.on('completed', (job) => {
    appLog.info('Ticket-created dispatch completed', { ticketId: job.data.ticketId }, job.data.ticketId, 'ticket');
  });

  ticketCreatedWorker.on('failed', (job, err) => {
    appLog.error(`Ticket-created dispatch failed: ${err.message}`, { err, ticketId: job?.data.ticketId }, job?.data.ticketId, 'ticket');
  });

  // --- Ingestion queue (processes raw payloads into tickets) ---
  const ingestionProcessor = createIngestionProcessor({
    db,
    ai,
    mailer,
    ticketCreatedQueue,
    analysisQueue,
    senderSignature,
    smtpFrom,
    appLog,
    artifactStoragePath: config.ARTIFACT_STORAGE_PATH,
  });
  const ingestionWorker = createWorker<IngestionJob>(
    'ticket-ingest',
    config.REDIS_URL,
    ingestionProcessor,
  );

  ingestionWorker.on('completed', (job) => {
    appLog.info('Ingestion job completed', { source: job.data.source, clientId: job.data.clientId });
  });

  ingestionWorker.on('failed', (job, err) => {
    appLog.error(`Ingestion job failed: ${err.message}`, { err, source: job?.data.source, clientId: job?.data.clientId });
  });

  // Health tracking state
  let lastAnalysisAt: Date | undefined;
  let analysisCount = 0;

  analysisWorker.on('completed', () => {
    lastAnalysisAt = new Date();
    analysisCount++;
  });

  const health = createHealthServer('ticket-analyzer', config.HEALTH_PORT, {
    getDetails: () => ({
      lastAnalysisAt: lastAnalysisAt?.toISOString() ?? null,
      analysisCount,
    }),
  });

  // Run repo cleanup at startup and then once daily
  const runRepoCleanup = () => {
    cleanupStaleRepos(config.REPO_WORKSPACE_PATH, config.REPO_RETENTION_DAYS).catch((err) => {
      appLog.error('Repo cleanup failed', { err });
    });
  };
  runRepoCleanup();
  const cleanupInterval = setInterval(runRepoCleanup, 24 * 60 * 60 * 1000);

  appLog.info('Ticket analyzer started');

  createGracefulShutdown(logger, [
    { interval: cleanupInterval },
    health,
    ingestionWorker,
    ticketCreatedWorker,
    ticketCreatedQueue,
    analysisWorker,
    analysisQueue,
    ...(mailer ? [mailer] : []),
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start ticket analyzer');
  process.exit(1);
});
