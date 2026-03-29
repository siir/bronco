import { z } from 'zod';
import { loadConfig } from '@bronco/shared-utils';

export const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Azure DevOps connection (optional — when omitted, polls per-client integrations only)
  // Empty strings are treated as unset so docker-compose can pass ${AZDO_*} without error.
  AZDO_ORG_URL: z.preprocess(v => v || undefined, z.string().url().optional()),
  AZDO_PROJECT: z.preprocess(v => v || undefined, z.string().optional()),
  AZDO_PAT: z.preprocess(v => v || undefined, z.string().min(1).optional()),

  // The user identity to action on — work items assigned to this user
  // trigger the conversational workflow. Matched against AssignedTo uniqueName
  // (email) or displayName, case-insensitive.
  AZDO_ASSIGNED_USER: z.preprocess(v => v || undefined, z.string().optional()),

  // Optional: map DevOps work items to an existing client by short code.
  // If omitted, auto-creates a client from the project name.
  AZDO_CLIENT_SHORT_CODE: z.preprocess(v => v || undefined, z.string().optional()),

  // Azure DevOps REST API version overrides (defaults match API_VERSION constants in client.ts)
  AZDO_API_VERSION: z.preprocess(v => v || undefined, z.string().default('7.1')),
  AZDO_API_VERSION_COMMENTS: z.preprocess(v => v || undefined, z.string().default('7.1-preview.4')),

  POLL_INTERVAL_SECONDS: z.coerce.number().default(120),

  // Maximum AI question-answer rounds before forcing a plan generation.
  MAX_QUESTION_ROUNDS: z.coerce.number().default(10),

  // Maximum length for work item description text stored in the ticket.
  MAX_DESCRIPTION_LENGTH: z.coerce.number().default(2000),

  ENCRYPTION_KEY: z.string().min(64),
  HEALTH_PORT: z.coerce.number().default(3102),
});

export type Config = z.output<typeof configSchema>;

export function getConfig(): Config {
  return loadConfig(configSchema) as Config;
}
