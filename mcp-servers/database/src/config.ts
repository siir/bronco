import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';
import type { DbEngine, AuthMethod, Environment } from '@bronco/shared-types';

const configSchema = z.object({
  // Control plane DB
  DATABASE_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(64),

  // Server
  PORT: z.coerce.number().default(3100),
  // Normalize: trim whitespace and treat empty string as unset so a compose
  // interpolation of ${API_KEY} with no value doesn't silently disable auth.
  API_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  LOG_LEVEL: z.string().default('info'),
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
