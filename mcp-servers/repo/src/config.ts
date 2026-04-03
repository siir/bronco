import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),
  API_KEY: z.string().optional(),
  MCP_AUTH_TOKEN: z.string().optional(),
  PORT: z.coerce.number().default(3111),
  REPO_WORKSPACE_PATH: z.string().default('/var/lib/mcp-repo/repos'),
  WORKTREE_TTL_MINUTES: z.coerce.number().default(30),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
