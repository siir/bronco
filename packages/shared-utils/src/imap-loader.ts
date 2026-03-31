import { z } from 'zod';
import { createLogger } from './logger.js';
import { decrypt, looksEncrypted } from './crypto.js';

const logger = createLogger('imap-loader');

const SETTINGS_KEY_IMAP = 'system-config-imap';

/** Zod schema for validating the IMAP config JSON stored in AppSetting. */
const imapDbSchema = z.object({
  host: z.string(),
  port: z.coerce.number().default(993),
  user: z.string(),
  password: z.string(),
  pollIntervalSeconds: z.coerce.number().optional(),
});

export interface ImapDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** true for direct TLS (port 993); false for STARTTLS (port 143). */
  secure: boolean;
  pollIntervalSeconds: number | undefined;
}

/** Minimal DB interface so shared-utils doesn't depend on @bronco/db. */
interface ImapSettingsDb {
  appSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: unknown } | null>;
  };
}

/**
 * Load IMAP configuration from the AppSetting table (key `system-config-imap`).
 * Decrypts the password if it was stored encrypted.
 * Returns `null` if no config is found or if validation/decryption fails.
 */
export async function loadImapFromDb(
  db: ImapSettingsDb,
  encryptionKey: string,
): Promise<ImapDbConfig | null> {
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_IMAP } });
  if (!row) {
    logger.info('No IMAP config found in DB (key=%s)', SETTINGS_KEY_IMAP);
    return null;
  }

  const parsed = imapDbSchema.safeParse(row.value);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'IMAP config in DB failed validation — ignoring');
    return null;
  }

  const { host, port, user, password: passwordRaw, pollIntervalSeconds } = parsed.data;

  let password: string;
  try {
    password = looksEncrypted(passwordRaw)
      ? decrypt(passwordRaw, encryptionKey)
      : passwordRaw;
  } catch (err) {
    logger.error({ err }, 'Failed to decrypt IMAP password from DB — ignoring config');
    return null;
  }

  logger.info('Loaded IMAP config from DB (host=%s, port=%d)', host, port);
  return { host, port, user, password, secure: port === 993, pollIntervalSeconds };
}
