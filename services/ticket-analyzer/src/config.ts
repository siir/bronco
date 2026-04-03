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
  // MCP database server (defaults to internal mcp-database service for DB issue analysis)
  MCP_DATABASE_URL: z.string().url().optional().default('http://mcp-database:3100'),
  // MCP repo server (defaults to internal mcp-repo service for code repository access)
  MCP_REPO_URL: z.string().default('http://mcp-repo:3111'),
  // Artifact storage is opt-in — only activated when explicitly set
  ARTIFACT_STORAGE_PATH: z.string().optional(),
  REPO_WORKSPACE_PATH: z.string().default('/tmp/bronco-repos'),
  REPO_RETENTION_DAYS: z.coerce.number().min(1).default(14),
  HEALTH_PORT: z.coerce.number().default(3106),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
