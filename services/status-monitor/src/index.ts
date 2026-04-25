import { getDb, disconnectDb } from '@bronco/db';
import {
  createLogger,
  createPrismaLogWriter,
  setGlobalLogWriter,
  createHealthServer,
  createGracefulShutdown,
} from '@bronco/shared-utils';
import { getConfig } from './config.js';
import { StatusMonitor } from './monitor.js';
import { CloudflaredDriftPoller } from './cloudflared-poller.js';

const logger = createLogger('status-monitor');

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  setGlobalLogWriter(createPrismaLogWriter(db));
  logger.info('Status monitor starting');

  // --- Monitor (channels are loaded from DB on each notification) ---
  const monitor = new StatusMonitor(db, config);

  // --- Cloudflared drift poller ---
  const cloudflaredPoller = new CloudflaredDriftPoller(db, config);

  // --- Health server ---
  const health = createHealthServer('status-monitor', config.HEALTH_PORT, {
    getDetails: () => ({
      lastPollAt: monitor.lastPollAt?.toISOString() ?? null,
      pollCount: monitor.pollCount,
      lastPollError: monitor.lastPollError ?? null,
      pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
      cooldownSeconds: config.COOLDOWN_SECONDS,
      activeChannels: monitor.activeChannelCount,
      cloudflaredTunnel: cloudflaredPoller.getState(),
    }),
  });

  // --- Initial poll ---
  await monitor.poll();

  // --- Start cloudflared drift poller (independent interval, non-blocking) ---
  cloudflaredPoller.start();

  // --- Recurring polls (serialized — next poll only starts after previous completes) ---
  let pollRunning = false;
  const interval = setInterval(() => {
    if (pollRunning) return;
    pollRunning = true;
    monitor.poll().catch((err) => {
      logger.error({ err }, 'Poll cycle failed');
    }).finally(() => {
      pollRunning = false;
    });
  }, config.POLL_INTERVAL_SECONDS * 1000);

  logger.info(
    { intervalSeconds: config.POLL_INTERVAL_SECONDS },
    'Status monitor started',
  );

  createGracefulShutdown(logger, [
    { interval },
    { fn: () => cloudflaredPoller.stop() },
    health,
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start status monitor');
  process.exit(1);
});
