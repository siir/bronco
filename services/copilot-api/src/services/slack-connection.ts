import type { PrismaClient } from '@bronco/db';
import { SlackClient, createLogger, decrypt, looksEncrypted } from '@bronco/shared-utils';

const logger = createLogger('slack-connection');

const SETTINGS_KEY_SLACK = 'system-config-slack';

let activeClient: SlackClient | null = null;
let defaultChannelId: string | null = null;

export interface SlackConfig {
  botToken: string;
  appToken: string;
  defaultChannelId: string;
  enabled: boolean;
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
 * Returns the connected SlackClient (or null if Slack is not configured/enabled).
 */
export async function initSlackConnection(db: PrismaClient, encryptionKey: string): Promise<SlackClient | null> {
  const config = await loadSlackConfig(db, encryptionKey);
  if (!config) {
    logger.info('Slack not configured or disabled — skipping Socket Mode connection');
    return null;
  }

  try {
    const client = new SlackClient({ botToken: config.botToken, appToken: config.appToken });
    await client.connect();
    activeClient = client;
    defaultChannelId = config.defaultChannelId;
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
export async function reconnectSlack(db: PrismaClient, encryptionKey: string): Promise<SlackClient | null> {
  if (activeClient) {
    await activeClient.disconnect();
    activeClient = null;
    defaultChannelId = null;
  }
  return initSlackConnection(db, encryptionKey);
}

/**
 * Gracefully disconnect the Slack client (called on app shutdown).
 */
export async function disconnectSlack(): Promise<void> {
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
