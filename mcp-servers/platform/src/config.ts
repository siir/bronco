import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().default(3110),
  API_KEY: z.string().optional(),
  MCP_AUTH_TOKEN: z.string().optional(),
  COPILOT_API_URL: z.string().default('http://copilot-api:3000'),
  LOG_LEVEL: z.string().default('info'),
  ARTIFACT_STORAGE_PATH: z.string().default('/mnt/qnap/artifacts'),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
