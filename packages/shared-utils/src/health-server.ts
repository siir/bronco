import { createServer } from 'http';
import type { Server } from 'http';
import { createLogger } from './logger.js';

const logger = createLogger('health-server');

export interface HealthDetails {
  [key: string]: unknown;
}

export interface HealthCheck {
  /** Return service-specific details for the health response */
  getDetails: () => HealthDetails | Promise<HealthDetails>;
}

/**
 * Creates a lightweight HTTP health server for worker processes.
 * Returns JSON with process uptime, memory usage, and service-specific details.
 *
 * Usage:
 * ```ts
 * const health = createHealthServer('imap-worker', 3101, {
 *   getDetails: () => ({ lastPollAt: lastPoll?.toISOString(), imapConnected: true }),
 * });
 * // In shutdown handler:
 * await health.close();
 * ```
 */
export function createHealthServer(
  serviceName: string,
  port: number,
  check: HealthCheck,
): { server: Server; close: () => Promise<void> } {
  const startedAt = new Date();

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      try {
        const details = await check.getDetails();
        const mem = process.memoryUsage();

        const body = JSON.stringify({
          status: 'ok',
          service: serviceName,
          timestamp: new Date().toISOString(),
          startedAt: startedAt.toISOString(),
          uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
          memory: {
            rss: formatBytes(mem.rss),
            heapUsed: formatBytes(mem.heapUsed),
            heapTotal: formatBytes(mem.heapTotal),
          },
          ...details,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch (err) {
        const body = JSON.stringify({
          status: 'degraded',
          service: serviceName,
          timestamp: new Date().toISOString(),
          error: (err as Error).message,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(body);
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on('error', (err) => {
    logger.error(
      { service: serviceName, port, err },
      `Health server failed on port ${port}`,
    );
  });

  server.listen(port, () => {
    logger.info({ service: serviceName, port }, `Health server listening on port ${port}`);
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });

  return { server, close };
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}
