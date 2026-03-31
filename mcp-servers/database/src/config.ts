import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';
import type { DbEngine, AuthMethod, Environment } from '@bronco/shared-types';

const configSchema = z.object({
  // Control plane DB
  DATABASE_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),

  // Server
  PORT: z.coerce.number().default(3100),
  API_KEY: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),

  // MCP auth token — required for Claude Code to connect via SSE
  MCP_AUTH_TOKEN: z.string().optional(),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}

export interface SystemConfigEntry {
  id: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  name: string;
  dbEngine: DbEngine;
  host: string;
  port: number;
  connectionString: string | null;
  instanceName: string | null;
  defaultDatabase: string | null;
  authMethod: AuthMethod;
  username: string | null;
  password: string | null;
  useTls: boolean;
  trustServerCert: boolean;
  connectionTimeout: number;
  requestTimeout: number;
  maxPoolSize: number;
  environment: Environment;
}
