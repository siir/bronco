import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // Global/default IMAP mailbox (optional when all IMAP configs are per-client)
  IMAP_HOST: z.string().optional().default(''),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_USER: z.string().optional().default(''),
  IMAP_PASSWORD: z.string().optional().default(''),
  POLL_INTERVAL_SECONDS: z.coerce.number().default(60),
  ENCRYPTION_KEY: z.string().min(64),
  // SMTP for outbound email replies
  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string(),
  SMTP_PASSWORD: z.string(),
  SMTP_FROM: z.string(),
  EMAIL_SENDER_NAME: z.string().default('Support Team'),
  HEALTH_PORT: z.coerce.number().default(3101),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
