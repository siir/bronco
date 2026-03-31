import type { PrismaClient } from '@bronco/db';
import type { Queue } from 'bullmq';
import { SlackClient, createLogger, decrypt, looksEncrypted } from '@bronco/shared-utils';
import { createBlockActionHandler, createThreadMessageHandler } from './slack-action-handler.js';
import { evictStaleThreads } from './slack-thread-store.js';

const logger = createLogger('slack-connection');

const SETTINGS_KEY_SLACK = 'system-config-slack';

let activeClient: SlackClient | null = null;
let defaultChannelId: string | null = null;
let evictionInterval: ReturnType<typeof setInterval> | null = null;

export interface SlackConfig {
  botToken: string;
  appToken: string;
  defaultChannelId: string;
  enabled: boolean;
}

/** Dependencies needed to register Slack interaction handlers. */
export interface SlackInteractionDeps {
  db: PrismaClient;
  issueResolveQueue: Queue;
}

function decryptToken(value: string, encryptionKey: string): string | null {
  if (!looksEncrypted(value)) return value;
  try {
    return decrypt(value, encryptionKey);
  } catch (err) {
    logger.warn({ err }, 'Failed to decrypt Slack token — skipping Slack connection');
    return null;
  }
}

async function loadSlackConfig(db: PrismaClient, encryptionKey: string): Promise<SlackConfig | null> {
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SLACK } });
  if (!row) return null;

  const config = row.value as Record<string, unknown>;
  if (!config.enabled) return null;

  const botToken = typeof config.botToken === 'string' ? decryptToken(config.botToken, encryptionKey) : null;
  const appToken = typeof config.appToken === 'string' ? decryptToken(config.appToken, encryptionKey) : null;
  const channel = typeof config.defaultChannelId === 'string' ? config.defaultChannelId : '';

  if (!botToken || !appToken || !channel) return null;

  return { botToken, appToken, defaultChannelId: channel, enabled: true };
}

/**
 * Initialize the Slack Socket Mode connection on copilot-api startup.
 * When interactionDeps is provided, registers handlers for button clicks and threaded replies.
 * Returns the connected SlackClient (or null if Slack is not configured/enabled).
 */
export async function initSlackConnection(
  db: PrismaClient,
  encryptionKey: string,
  interactionDeps?: SlackInteractionDeps,
): Promise<SlackClient | null> {
  const config = await loadSlackConfig(db, encryptionKey);
  if (!config) {
    logger.info('Slack not configured or disabled — skipping Socket Mode connection');
    return null;
  }

  try {
    const client = new SlackClient({ botToken: config.botToken, appToken: config.appToken });

    // Register interaction handlers before connecting so no events are missed
    if (interactionDeps) {
      const deps = { db: interactionDeps.db, slack: client, issueResolveQueue: interactionDeps.issueResolveQueue };
      client.onBlockAction(createBlockActionHandler(deps));
      client.onThreadMessage(createThreadMessageHandler(deps));
      logger.info('Slack interaction handlers registered');
    }

    await client.connect();
    activeClient = client;
    defaultChannelId = config.defaultChannelId;

    // Start periodic eviction of stale thread entries (every 6 hours)
    if (!evictionInterval) {
      evictionInterval = setInterval(() => evictStaleThreads(), 6 * 60 * 60 * 1000);
    }

    logger.info('Slack Socket Mode connection established');
    return client;
  } catch (err) {
    logger.error({ err }, 'Failed to establish Slack Socket Mode connection — notifications will be email-only');
    return null;
  }
}

/**
 * Reconnect Slack with updated config (called after PUT /api/settings/slack).
 */
export async function reconnectSlack(
  db: PrismaClient,
  encryptionKey: string,
  interactionDeps?: SlackInteractionDeps,
): Promise<SlackClient | null> {
  if (activeClient) {
    await activeClient.disconnect();
    activeClient = null;
    defaultChannelId = null;
  }
  return initSlackConnection(db, encryptionKey, interactionDeps);
}

/**
 * Gracefully disconnect the Slack client (called on app shutdown).
 */
export async function disconnectSlack(): Promise<void> {
  if (evictionInterval) {
    clearInterval(evictionInterval);
    evictionInterval = null;
  }
  if (activeClient) {
    await activeClient.disconnect();
    activeClient = null;
    defaultChannelId = null;
  }
}

/** Get the active Slack client (or null if not connected). */
export function getSlackClient(): SlackClient | null {
  return activeClient;
}

/** Get the configured default Slack channel ID. */
export function getDefaultSlackChannelId(): string | null {
  return defaultChannelId;
}
