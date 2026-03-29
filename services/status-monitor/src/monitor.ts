import type { PrismaClient } from '@bronco/db';
import { createLogger, decrypt, looksEncrypted } from '@bronco/shared-utils';
import { EmailNotifier } from './notifiers/email.js';
import { PushoverNotifier } from './notifiers/pushover.js';
import type { Config } from './config.js';

const logger = createLogger('monitor');

const ServiceStatus = {
  UP: 'UP',
  DOWN: 'DOWN',
  DEGRADED: 'DEGRADED',
  UNKNOWN: 'UNKNOWN',
} as const;
type ServiceStatus = (typeof ServiceStatus)[keyof typeof ServiceStatus];

interface ComponentStatus {
  name: string;
  type: 'infrastructure' | 'service' | 'external';
  status: ServiceStatus;
  endpoint?: string;
  latencyMs?: number;
  uptime?: string;
  details?: Record<string, unknown>;
}

interface SystemStatusResponse {
  status: ServiceStatus;
  timestamp: string;
  components: ComponentStatus[];
}

interface ComponentState {
  status: ServiceStatus;
  since: Date;
  lastNotifiedAt?: Date;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isActive: boolean;
}

export class StatusMonitor {
  private state = new Map<string, ComponentState>();
  private db: PrismaClient;
  private config: Config;
  private firstPoll = true;
  public lastPollAt?: Date;
  public pollCount = 0;
  public lastPollError?: string;
  public activeChannelCount = 0;

  constructor(db: PrismaClient, config: Config) {
    this.db = db;
    this.config = config;
  }

  async poll(): Promise<void> {
    this.pollCount++;
    this.lastPollAt = new Date();
    this.lastPollError = undefined;

    let response: SystemStatusResponse;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(this.config.STATUS_API_URL, {
        signal: controller.signal,
        headers: { 'x-api-key': this.config.API_KEY },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      response = (await res.json()) as SystemStatusResponse;
    } catch (err) {
      const message = (err as Error).message;
      this.lastPollError = message;
      logger.error({ err: message }, 'Failed to fetch system status');

      // If we can't reach the API at all, that's itself an alert-worthy event.
      await this.processComponent({
        name: 'Copilot API',
        type: 'service',
        status: ServiceStatus.DOWN,
        details: { error: `Status API unreachable: ${message}` },
      });
      return;
    }

    for (const component of response.components) {
      await this.processComponent(component);
    }

    this.firstPoll = false;
  }

  private async processComponent(component: ComponentStatus): Promise<void> {
    const prev = this.state.get(component.name);
    const now = new Date();

    if (!prev) {
      this.state.set(component.name, { status: component.status, since: now });

      if (this.firstPoll && this.config.NOTIFY_ON_FIRST_POLL !== 'true') {
        logger.info(
          { component: component.name, status: component.status },
          'Initial state recorded (no notification)',
        );
        return;
      }

      if (
        this.firstPoll &&
        this.config.NOTIFY_ON_FIRST_POLL === 'true' &&
        component.status !== ServiceStatus.UP &&
        component.status !== ServiceStatus.UNKNOWN
      ) {
        await this.notify(component, 'UNKNOWN', component.status);
      }
      return;
    }

    if (prev.status === component.status) {
      return;
    }

    // Status changed — check cooldown
    if (prev.lastNotifiedAt) {
      const elapsed = (now.getTime() - prev.lastNotifiedAt.getTime()) / 1000;
      if (elapsed < this.config.COOLDOWN_SECONDS) {
        logger.info(
          {
            component: component.name,
            from: prev.status,
            to: component.status,
            cooldownRemaining: Math.ceil(this.config.COOLDOWN_SECONDS - elapsed),
          },
          'Status changed but within cooldown window — skipping notification',
        );
        this.state.set(component.name, {
          status: component.status,
          since: now,
          lastNotifiedAt: prev.lastNotifiedAt,
        });
        return;
      }
    }

    await this.notify(component, prev.status, component.status);

    this.state.set(component.name, {
      status: component.status,
      since: now,
      lastNotifiedAt: now,
    });
  }

  /**
   * Load active notification channels from the DB and send alerts through each.
   */
  private async notify(
    component: ComponentStatus,
    previousStatus: ServiceStatus | 'UNKNOWN',
    newStatus: ServiceStatus,
  ): Promise<void> {
    const isRecovery = newStatus === ServiceStatus.UP;
    const isDown = newStatus === ServiceStatus.DOWN;

    const tag = isRecovery ? '[RECOVERED]' : isDown ? '[DOWN]' : '[DEGRADED]';
    const title = `${tag} ${component.name}`;
    const errorDetail = component.details?.['error']
      ? `\nError: ${component.details['error']}`
      : '';
    const message = [
      `${component.name} changed from ${previousStatus} to ${newStatus}.`,
      component.endpoint ? `Endpoint: ${component.endpoint}` : '',
      errorDetail,
      `Time: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n');

    logger.info(
      { component: component.name, from: previousStatus, to: newStatus },
      `Status transition: ${title}`,
    );

    // Load active channels from DB on each notification (channels can change at any time)
    let channels: ChannelRow[];
    try {
      channels = (await this.db.notificationChannel.findMany({
        where: { isActive: true },
      })) as unknown as ChannelRow[];
      this.activeChannelCount = channels.length;
    } catch (err) {
      logger.error({ err }, 'Failed to load notification channels from DB');
      channels = [];
    }

    const notifiedVia: string[] = [];

    for (const channel of channels) {
      try {
        if (channel.type === 'EMAIL') {
          await this.sendEmail(channel.config, title, message);
          notifiedVia.push(`email:${channel.name}`);
        } else if (channel.type === 'PUSHOVER') {
          const priority = isDown ? 1 : isRecovery ? -1 : 0;
          await this.sendPushover(channel.config, title, message, priority as -1 | 0 | 1);
          notifiedVia.push(`pushover:${channel.name}`);
        }
      } catch (err) {
        logger.error({ err, channel: channel.name, type: channel.type }, 'Failed to send via channel');
      }
    }

    // Record in database
    try {
      await this.db.serviceAlert.create({
        data: {
          componentName: component.name,
          previousStatus,
          newStatus,
          notifiedVia,
          message,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to record service alert in database');
    }
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
