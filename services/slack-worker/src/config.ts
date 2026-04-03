import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),
  HEALTH_PORT: z.coerce.number().default(3108),
  MCP_PLATFORM_URL: z.string().default('http://mcp-platform:3110'),
  MCP_REPO_URL: z.string().url().default('http://mcp-repo:3111'),
  API_KEY: z.string().optional().transform(v => v || undefined),
  MCP_AUTH_TOKEN: z.string().optional().transform(v => v || undefined),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
