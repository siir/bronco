import { createLogger, decrypt, looksEncrypted } from '@bronco/shared-utils';
import type { PrismaClient } from '@bronco/db';
import type { Config } from './config.js';
import { EmailNotifier } from './notifiers/email.js';
import { PushoverNotifier } from './notifiers/pushover.js';

const logger = createLogger('cloudflared-poller');

export interface CloudflaredTunnelState {
  healthy: boolean;
  readyConnections: number | null;
  consecutiveFailures: number;
  lastChecked: string | null;
  lastError: string | null;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isActive: boolean;
}

export class CloudflaredDriftPoller {
  private consecutiveFailures = 0;
  private alertFired = false;
  private lastReadyConnections: number | null = null;
  private lastChecked: string | null = null;
  private lastError: string | null = null;
  private healthy = true;

  private db: PrismaClient;
  private config: Config;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(db: PrismaClient, config: Config) {
    this.db = db;
    this.config = config;
  }

  start(): void {
    // Run immediately at startup, then on interval
    void this.probe();
    this.interval = setInterval(() => {
      void this.probe();
    }, this.config.CLOUDFLARED_DRIFT_POLL_INTERVAL_SECONDS * 1000);

    logger.info(
      {
        metricsUrl: this.config.CLOUDFLARED_METRICS_URL,
        intervalSeconds: this.config.CLOUDFLARED_DRIFT_POLL_INTERVAL_SECONDS,
        failThreshold: this.config.CLOUDFLARED_DRIFT_FAIL_THRESHOLD,
      },
      'Cloudflared drift poller started',
    );
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getState(): CloudflaredTunnelState {
    return {
      healthy: this.healthy,
      readyConnections: this.lastReadyConnections,
      consecutiveFailures: this.consecutiveFailures,
      lastChecked: this.lastChecked,
      lastError: this.lastError,
    };
  }

  private async probe(): Promise<void> {
    const url = `${this.config.CLOUDFLARED_METRICS_URL}/ready`;
    const wasHealthy = this.healthy;
    this.lastChecked = new Date().toISOString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let driftReason: string | null = null;

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        driftReason = `HTTP ${res.status} ${res.statusText}`;
        this.lastError = driftReason;
      } else {
        // 200 OK — parse readyConnections
        let readyConnections: number | null = null;
        try {
          const body = await res.json() as { readyConnections?: number };
          readyConnections = typeof body.readyConnections === 'number' ? body.readyConnections : null;
          this.lastReadyConnections = readyConnections;
        } catch {
          driftReason = 'Failed to parse /ready JSON response';
          this.lastError = driftReason;
        }

        if (driftReason === null && readyConnections !== null && readyConnections === 0) {
          driftReason = 'readyConnections === 0 (no active tunnel connections)';
          this.lastError = driftReason;
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      driftReason = `Request failed: ${message}`;
      this.lastError = driftReason;
    }

    if (driftReason === null) {
      // Probe succeeded
      const wasUnhealthy = !wasHealthy;
      this.consecutiveFailures = 0;
      this.healthy = true;
      this.alertFired = false;
      this.lastError = null;

      if (wasUnhealthy) {
        logger.info(
          { readyConnections: this.lastReadyConnections },
          'Cloudflared tunnel: DEGRADED → HEALTHY',
        );
      } else {
        logger.debug(
          { readyConnections: this.lastReadyConnections },
          'Cloudflared tunnel: probe OK',
        );
      }
    } else {
      // Probe failed
      this.consecutiveFailures++;
      this.healthy = false;

      const threshold = this.config.CLOUDFLARED_DRIFT_FAIL_THRESHOLD;
      logger.warn(
        {
          consecutiveFailures: this.consecutiveFailures,
          threshold,
          reason: driftReason,
          url,
        },
        'Cloudflared /ready probe failed',
      );

      if (this.consecutiveFailures >= threshold && !this.alertFired) {
        this.alertFired = true;
        logger.error(
          { consecutiveFailures: this.consecutiveFailures, threshold, reason: driftReason },
          'Cloudflared tunnel drift detected — emitting operational alert',
        );
        await this.emitAlert(driftReason);
      }
    }
  }

  private async emitAlert(lastError: string): Promise<void> {
    const subject = '[DEGRADED] cloudflared tunnel drift detected';
    const message = [
      `Service: cloudflared`,
      `State: DEGRADED — ${this.consecutiveFailures} consecutive /ready failures`,
      `Last error: ${lastError}`,
      `Endpoint: ${this.config.CLOUDFLARED_METRICS_URL}/ready`,
      ``,
      `Suggested operator action:`,
      `  ssh hugo-app "docker restart bronco-cloudflared-1"`,
      ``,
      `Monitor: check status-monitor /health for current state`,
      `Time: ${new Date().toISOString()}`,
    ].join('\n');

    // Load active notification channels from DB (same pattern as StatusMonitor.notify)
    let channels: ChannelRow[];
    try {
      channels = (await this.db.notificationChannel.findMany({
        where: { isActive: true },
      })) as unknown as ChannelRow[];
    } catch (err) {
      logger.error({ err }, 'Failed to load notification channels from DB for cloudflared alert');
      channels = [];
    }

    if (channels.length === 0) {
      logger.warn('Cloudflared drift alert: no active notification channels configured');
      return;
    }

    // Record the alert in the database
    try {
      await this.db.serviceAlert.create({
        data: {
          componentName: 'cloudflared',
          previousStatus: 'UP',
          newStatus: 'DEGRADED',
          notifiedVia: [],
          message,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to record cloudflared alert in database');
    }

    const notifiedVia: string[] = [];

    for (const channel of channels) {
      try {
        if (channel.type === 'EMAIL') {
          await this.sendEmail(channel.config, subject, message);
          notifiedVia.push(`email:${channel.name}`);
        } else if (channel.type === 'PUSHOVER') {
          await this.sendPushover(channel.config, subject, message, 1);
          notifiedVia.push(`pushover:${channel.name}`);
        }
      } catch (err) {
        logger.error({ err, channel: channel.name, type: channel.type }, 'Failed to send cloudflared drift alert via channel');
      }
    }

    logger.info({ notifiedVia }, 'Cloudflared drift alert dispatched');
  }

  private decryptIfNeeded(value: string): string {
    if (looksEncrypted(value)) {
      return decrypt(value, this.config.ENCRYPTION_KEY);
    }
    return value;
  }

  private async sendEmail(
    config: Record<string, unknown>,
    subject: string,
    body: string,
  ): Promise<void> {
    const notifier = new EmailNotifier({
      host: config.host as string,
      port: (config.port as number) ?? 587,
      user: config.user as string,
      password: this.decryptIfNeeded(config.password as string),
      from: config.from as string,
      to: config.to as string,
    });
    await notifier.send(`Bronco ${subject}`, body);
    notifier.close();
  }

  private async sendPushover(
    config: Record<string, unknown>,
    title: string,
    message: string,
    priority: -1 | 0 | 1,
  ): Promise<void> {
    const notifier = new PushoverNotifier({
      appToken: this.decryptIfNeeded(config.appToken as string),
      userKey: this.decryptIfNeeded(config.userKey as string),
    });
    await notifier.send(title, message, priority);
  }
}
