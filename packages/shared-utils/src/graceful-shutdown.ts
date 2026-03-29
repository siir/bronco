import type { Logger } from 'pino';

/** Any object with an async close method (health servers, BullMQ workers/queues, etc.) */
export interface Closeable {
  close(): Promise<void> | void;
}

/**
 * Registers SIGINT/SIGTERM handlers that close resources in order and exit.
 *
 * Resources are closed in array order — place items that should shut down
 * first (intervals, health servers) before workers, queues, and finally
 * the database connection.
 *
 * @example
 * ```ts
 * createGracefulShutdown(logger, [
 *   { interval },               // clearInterval first
 *   health,                     // close health server
 *   worker,                     // close BullMQ worker
 *   queue,                      // close BullMQ queue
 *   { fn: disconnectDb },       // tear down Prisma
 * ]);
 * ```
 */
export function createGracefulShutdown(
  logger: Logger,
  resources: Array<Closeable | { interval: NodeJS.Timeout } | { fn: () => Promise<void> | void }>,
): void {
  const shutdown = async () => {
    logger.info('Shutting down...');

    for (const r of resources) {
      try {
        if ('interval' in r) {
          clearInterval(r.interval);
        } else if ('fn' in r) {
          await r.fn();
        } else {
          await r.close();
        }
      } catch (err) {
        logger.warn({ err }, 'Error during shutdown');
      }
    }

    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
