import { createLogger, AppLogger, createPrismaLogWriter, setGlobalLogWriter, createWorker, createHealthServer, createGracefulShutdown } from '@bronco/shared-utils';
import { getDb, disconnectDb } from '@bronco/db';
import { createAIRouter } from '@bronco/ai-provider';
import { getConfig } from './config.js';
import { createProcessor, initWorkerLogger } from './worker.js';
import { cleanupStaleClones } from './git.js';

const logger = createLogger('issue-resolver');
const appLog = new AppLogger('issue-resolver');

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  const logWriter = createPrismaLogWriter(db);
  appLog.setWriter(logWriter);
  setGlobalLogWriter(logWriter);
  initWorkerLogger(db);
  appLog.info('Issue resolver starting');

  const { ai, clientMemoryResolver } = createAIRouter(db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  const processor = createProcessor(config, ai, clientMemoryResolver);
  const worker = createWorker('issue-resolve', config.REDIS_URL, processor);

  let lastJobAt: Date | undefined;
  let jobsCompleted = 0;
  let jobsFailed = 0;

  worker.on('completed', (job) => {
    lastJobAt = new Date();
    jobsCompleted++;
    logger.info({ jobId: job?.id }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    lastJobAt = new Date();
    jobsFailed++;
    logger.error({ jobId: job?.id, err: err.message }, 'Job failed');
  });

  const health = createHealthServer('issue-resolver', config.HEALTH_PORT, {
    getDetails: () => ({
      lastJobAt: lastJobAt?.toISOString() ?? null,
      jobsCompleted,
      jobsFailed,
    }),
  });

  // Run repo cleanup at startup and then once daily
  const runRepoCleanup = () => {
    cleanupStaleClones(config.REPO_WORKSPACE_PATH, config.REPO_RETENTION_DAYS).catch((err) => {
      logger.error({ err }, 'Repo cleanup failed');
    });
  };
  runRepoCleanup();
  const cleanupInterval = setInterval(runRepoCleanup, 24 * 60 * 60 * 1000);

  logger.info('Issue resolver worker started');

  createGracefulShutdown(logger, [
    { interval: cleanupInterval },
    health,
    worker,
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start issue resolver');
  process.exit(1);
});
