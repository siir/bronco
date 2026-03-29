import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),
  REPO_WORKSPACE_PATH: z.string().default('/tmp/issue-resolver-repos'),
  GIT_CLONE_DEPTH: z.coerce.number().int().min(0).default(0),
  REPO_RETENTION_DAYS: z.coerce.number().min(1).default(14),
  GIT_AUTHOR_NAME: z.string().default('Bronco Bot'),
  GIT_AUTHOR_EMAIL: z.string().default('bot@bronco.dev'),
  LOG_LEVEL: z.string().default('info'),
  HEALTH_PORT: z.coerce.number().default(3103),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
