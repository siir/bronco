import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),
  API_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PORTAL_JWT_SECRET: z.string().min(32),
  ARTIFACT_STORAGE_PATH: z.string().default('/tmp/artifacts'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  // Worker health endpoints (internal Docker network)
  IMAP_WORKER_HEALTH_URL: z.string().url().optional().default('http://imap-worker:3101'),
  DEVOPS_WORKER_HEALTH_URL: z.string().url().optional().default('http://devops-worker:3102'),
  ISSUE_RESOLVER_HEALTH_URL: z.string().url().optional().default('http://issue-resolver:3103'),
  STATUS_MONITOR_HEALTH_URL: z.string().url().optional().default('http://status-monitor:3105'),
  TICKET_ANALYZER_HEALTH_URL: z.string().url().optional().default('http://ticket-analyzer:3106'),
  PROBE_WORKER_HEALTH_URL: z.string().url().optional().default('http://probe-worker:3107'),
  MCP_DATABASE_HEALTH_URL: z.string().url().optional().default('http://mcp-database:3100'),
  SLACK_WORKER_HEALTH_URL: z.string().url().optional().default('http://slack-worker:3108'),
  SCHEDULER_WORKER_HEALTH_URL: z.string().url().optional().default('http://scheduler-worker:3109'),
  // Invoice storage
  INVOICE_STORAGE_PATH: z.string().default('/var/lib/copilot-api/invoices'),
  // GitHub (optional — required for manual release notes backfill)
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().default('siir/bronco'),
  BUILD_VERSION: z.string().default('dev'),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
