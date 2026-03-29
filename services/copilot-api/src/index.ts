import { createLogger, createGracefulShutdown } from '@bronco/shared-utils';
import { getConfig } from './config.js';
import { buildApp } from './app.js';

const logger = createLogger('copilot-api');

async function main(): Promise<void> {
  const config = getConfig();
  const app = await buildApp(config);

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'Copilot API listening');

  // app.close() stops accepting connections and triggers Fastify onClose hooks
  // (BullMQ workers/queues, Prisma disconnect)
  createGracefulShutdown(logger, [app]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start Copilot API');
  process.exit(1);
});
