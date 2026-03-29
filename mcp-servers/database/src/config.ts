import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadConfig, createLogger } from '@bronco/shared-utils';
import { DbEngine, AuthMethod, Environment } from '@bronco/shared-types';

const logger = createLogger('mcp-config');

const configSchema = z.object({
  // Path to JSON file containing system connection configs
  SYSTEMS_CONFIG_PATH: z.string(),

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

// --- Systems config file schema and loader ---

const systemConfigEntrySchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  clientCode: z.string(),
  name: z.string(),
  dbEngine: z.nativeEnum(DbEngine),
  host: z.string(),
  port: z.number().int(),
  connectionString: z.string().nullable().optional().default(null),
  instanceName: z.string().nullable().optional().default(null),
  defaultDatabase: z.string().nullable().optional().default('master'),
  authMethod: z.nativeEnum(AuthMethod),
  username: z.string().nullable().optional().default(null),
  password: z.string().nullable().optional().default(null),
  useTls: z.boolean().default(true),
  trustServerCert: z.boolean().default(false),
  connectionTimeout: z.number().int().default(30000),
  requestTimeout: z.number().int().default(30000),
  maxPoolSize: z.number().int().default(5),
  environment: z.nativeEnum(Environment),
});

const systemsConfigFileSchema = z.object({
  systems: z.array(systemConfigEntrySchema).min(1),
});

export type SystemConfigEntry = z.output<typeof systemConfigEntrySchema>;

export function loadSystemsConfig(filePath: string): SystemConfigEntry[] {
  logger.info({ filePath }, 'Loading systems config');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const validated = systemsConfigFileSchema.parse(parsed);
  logger.info({ count: validated.systems.length }, 'Loaded systems config');
  return validated.systems;
}
