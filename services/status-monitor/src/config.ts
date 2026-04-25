import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),
  // The copilot-api system-status endpoint to poll
  STATUS_API_URL: z.string().url().optional().default('http://copilot-api:3000/api/system-status'),
  API_KEY: z.string().min(1),
  // Polling interval in seconds
  POLL_INTERVAL_SECONDS: z.coerce.number().min(10).default(60),
  // Cooldown: suppress duplicate notifications for the same component within this window (seconds)
  COOLDOWN_SECONDS: z.coerce.number().min(0).default(300),
  // Whether to notify on the first poll (when no previous state exists).
  // Set to "true" to alert on services already DOWN at startup.
  NOTIFY_ON_FIRST_POLL: z.string().optional().default('false'),
  // Health server
  HEALTH_PORT: z.coerce.number().default(3105),
  // Cloudflared tunnel drift detection
  // Base URL of the cloudflared metrics server (inside Docker network)
  CLOUDFLARED_METRICS_URL: z.string().url().optional().default('http://cloudflared:2000'),
  // Number of consecutive /ready failures before emitting an operational alert
  CLOUDFLARED_DRIFT_FAIL_THRESHOLD: z.coerce.number().min(1).default(3),
  // How often to probe /ready (seconds)
  CLOUDFLARED_DRIFT_POLL_INTERVAL_SECONDS: z.coerce.number().min(5).default(30),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
