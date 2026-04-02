import { getDb, disconnectDb } from '@bronco/db';
import { createAIRouter } from '@bronco/ai-provider';
import { createLogger, createQueue, createHealthServer, createGracefulShutdown } from '@bronco/shared-utils';
import type { IngestionJob } from '@bronco/shared-types';
import { getConfig } from './config.js';
import { initSlackConnection, disconnectSlack } from './slack-connection.js';
import { ClientSlackManager } from './client-slack-manager.js';

const logger = createLogger('slack-worker');

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  // AI router (needed for future conversational bot features)
  const { ai } = createAIRouter(db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  // Queues — slack-worker needs issue-resolve (for plan approval actions) and ticket-ingest (for client Slack messages)
  const issueResolveQueue = createQueue('issue-resolve', config.REDIS_URL);
  const ingestQueue = createQueue<IngestionJob>('ticket-ingest', config.REDIS_URL);

  // Initialize per-client Slack connections
  const clientSlackManager = new ClientSlackManager(db, config.ENCRYPTION_KEY, ingestQueue);

  // Initialize the system-level Slack Socket Mode connection with interaction handlers
  void initSlackConnection(db, config.ENCRYPTION_KEY, {
    db,
    issueResolveQueue,
  });

  // Initialize per-client Slack connections (non-blocking)
  clientSlackManager.refreshConnections().catch((err) => logger.error({ err }, 'Failed to initialize client Slack connections'));

  // Health server
  const health = createHealthServer('slack-worker', config.HEALTH_PORT, {
    getDetails: () => ({
      systemSlackConnected: true,
      clientConnections: 'active',
    }),
  });

  logger.info({ healthPort: config.HEALTH_PORT }, 'Slack worker started');

  createGracefulShutdown(logger, [
    { fn: () => clientSlackManager.disconnectAll() },
    { fn: disconnectSlack },
    health,
    issueResolveQueue,
    ingestQueue,
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start Slack worker');
  process.exit(1);
});
