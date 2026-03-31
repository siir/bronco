import { createLogger } from './logger.js';
import { decrypt, looksEncrypted } from './crypto.js';
import type { SmtpConfig } from './mailer.js';

const logger = createLogger('smtp-loader');

const SETTINGS_KEY_SMTP = 'system-config-smtp';

/** Minimal DB interface so shared-utils doesn't depend on @bronco/db. */
interface SmtpSettingsDb {
  appSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: unknown } | null>;
  };
}

/**
 * Load SMTP configuration from the AppSetting table (key `system-config-smtp`).
 * Decrypts the password if it was stored encrypted.
 * Returns `null` if no config is found.
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

  const raw = row.value as Record<string, unknown>;

  const host = raw.host as string | undefined;
  const port = raw.port as number | undefined;
  const user = raw.user as string | undefined;
  const passwordRaw = raw.password as string | undefined;
  const from = raw.from as string | undefined;
  const fromName = raw.fromName as string | undefined;

  if (!host || !port || !user || !passwordRaw || !from) {
    logger.warn('SMTP config in DB is incomplete — missing required fields');
    return null;
  }

  const password = looksEncrypted(passwordRaw)
    ? decrypt(passwordRaw, encryptionKey)
    : passwordRaw;

  logger.info('Loaded SMTP config from DB (host=%s, port=%d)', host, port);
  return { host, port, user, password, from, fromName };
}
