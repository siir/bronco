import { z } from 'zod';
import { createLogger } from './logger.js';
import { decrypt, looksEncrypted } from './crypto.js';
import type { SmtpConfig } from './mailer.js';

const logger = createLogger('smtp-loader');

const SETTINGS_KEY_SMTP = 'system-config-smtp';

/** Zod schema for validating the SMTP config JSON stored in AppSetting. */
const smtpConfigSchema = z.object({
  host: z.string(),
  port: z.coerce.number(),
  user: z.string(),
  password: z.string(),
  from: z.string(),
  fromName: z.string().optional(),
});

/** Minimal DB interface so shared-utils doesn't depend on @bronco/db. */
interface SmtpSettingsDb {
  appSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: unknown } | null>;
  };
}

/**
 * Load SMTP configuration from the AppSetting table (key `system-config-smtp`).
 * Decrypts the password if it was stored encrypted.
 * Returns `null` if no config is found or if validation/decryption fails.
 */
export async function loadSmtpFromDb(
  db: SmtpSettingsDb,
  encryptionKey: string,
): Promise<SmtpConfig | null> {
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SMTP } });
  if (!row) {
    logger.info('No SMTP config found in DB (key=%s)', SETTINGS_KEY_SMTP);
    return null;
  }

  const parsed = smtpConfigSchema.safeParse(row.value);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'SMTP config in DB failed validation — ignoring');
    return null;
  }

  const { host, port, user, password: passwordRaw, from, fromName } = parsed.data;

  let password: string;
  try {
    password = looksEncrypted(passwordRaw)
      ? decrypt(passwordRaw, encryptionKey)
      : passwordRaw;
  } catch (err) {
    logger.error({ err }, 'Failed to decrypt SMTP password from DB — ignoring config');
    return null;
  }

  logger.info('Loaded SMTP config from DB (host=%s, port=%d)', host, port);
  return { host, port, user, password, from, fromName };
}
