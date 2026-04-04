import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),
  // SMTP — read from DB (system-config-smtp) at startup; env vars are fallback only
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().optional().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),
  EMAIL_SENDER_NAME: z.string().optional().default('Support Team'),
  MCP_REPO_URL: z.string().url().optional(),
  HEALTH_PORT: z.coerce.number().default(3107),
  ARTIFACT_STORAGE_PATH: z.string().default('/var/lib/bronco/artifacts'),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
