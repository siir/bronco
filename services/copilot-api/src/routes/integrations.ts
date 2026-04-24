import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { IntegrationType } from '@bronco/shared-types';
import { encrypt, looksEncrypted } from '@bronco/shared-utils';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

const VALID_INTEGRATION_TYPES = Object.values(IntegrationType);

const imapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  user: z.string().min(1),
  encryptedPassword: z.string().min(1),
  pollIntervalSeconds: z.number().positive(),
}).passthrough();

const azureDevOpsConfigSchema = z.object({
  orgUrl: z.string().url(),
  project: z.string().min(1),
  encryptedPat: z.string().min(1),
  assignedUser: z.string().min(1),
  pollIntervalSeconds: z.number().positive(),
}).passthrough();

/**
 * Validate that a path is a relative path starting with "/" and not an absolute URL.
 * Rejects values like "http://169.254.169.254/..." or "//169.254.169.254/..."
 * that would override the baseUrl when passed to `new URL(path, baseUrl)` (SSRF mitigation).
 */
const relativePathSchema = z.string().min(1)
  .refine((val) => val.startsWith('/'), {
    message: 'Path must start with "/"',
  })
  .refine((val) => !val.startsWith('//'), {
    message: 'Path must not start with "//"',
  })
  .refine((val) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(val), {
    message: 'Path must be a relative path, not an absolute URL or scheme-prefixed value',
  });

const mcpDatabaseConfigSchema = z.object({
  url: z.string().min(1),
  healthPath: relativePathSchema.nullable().optional(),
  mcpPath: relativePathSchema.optional(),
  apiKey: z.string().min(1).optional(),
  authHeader: z.enum(['bearer', 'x-api-key']).optional(),
  disabledTools: z.array(z.string()).optional(),
}).passthrough();

const slackConfigSchema = z.object({
  encryptedBotToken: z.string().min(1),
  encryptedAppToken: z.string().min(1),
  defaultChannelId: z.string().min(1),
  enabled: z.boolean(),
}).passthrough();

const githubHostSchema = z.string().min(1).optional();

const githubPatConfigSchema = z.object({
  kind: z.literal('pat'),
  encryptedToken: z.string().min(1),
  host: githubHostSchema,
}).passthrough();

const githubAppConfigSchema = z.object({
  kind: z.literal('github_app'),
  appId: z.string().min(1),
  installationId: z.string().min(1),
  encryptedPrivateKey: z.string().min(1),
  host: githubHostSchema,
}).passthrough();

const githubConfigSchema = z.discriminatedUnion('kind', [
  githubPatConfigSchema,
  githubAppConfigSchema,
]);

const configSchemaByType: Record<string, z.ZodType> = {
  [IntegrationType.IMAP]: imapConfigSchema,
  [IntegrationType.AZURE_DEVOPS]: azureDevOpsConfigSchema,
  [IntegrationType.MCP_DATABASE]: mcpDatabaseConfigSchema,
  [IntegrationType.SLACK]: slackConfigSchema,
  [IntegrationType.GITHUB]: githubConfigSchema,
};

function validateIntegrationConfig(type: string, config: unknown): string | null {
  const schema = configSchemaByType[type];
  if (!schema) return null;
  const result = schema.safeParse(config);
  if (!result.success) {
    return result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }
  return null;
}

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

/** Fields within integration config that hold secrets and should be encrypted. */
const SECRET_FIELDS: Record<string, string[]> = {
  [IntegrationType.IMAP]: ['encryptedPassword'],
  [IntegrationType.AZURE_DEVOPS]: ['encryptedPat'],
  [IntegrationType.MCP_DATABASE]: ['apiKey'],
  [IntegrationType.SLACK]: ['encryptedBotToken', 'encryptedAppToken'],
  // GitHub stores credentials under a discriminated union — both kinds have
  // secret fields (encryptedToken for PAT, encryptedPrivateKey for app).
  // encryptConfigSecrets() just checks each field name; fields absent from the
  // incoming config are skipped harmlessly.
  [IntegrationType.GITHUB]: ['encryptedToken', 'encryptedPrivateKey'],
};

function encryptConfigSecrets(
  type: string,
  config: Record<string, unknown>,
  encryptionKey: string,
): Record<string, unknown> {
  const fields = SECRET_FIELDS[type];
  if (!fields) return config;

  const result = { ...config };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === 'string' && value.length > 0 && !looksEncrypted(value)) {
      result[field] = encrypt(value, encryptionKey);
    }
  }
  return result;
}

interface IntegrationRouteOpts {
  encryptionKey: string;
  mcpDiscoveryQueue: Queue;
  onSlackIntegrationChange?: () => void;
}

export async function integrationRoutes(fastify: FastifyInstance, opts: IntegrationRouteOpts): Promise<void> {
  const { encryptionKey, mcpDiscoveryQueue, onSlackIntegrationChange } = opts;
  fastify.get<{ Querystring: { clientId?: string; type?: string; scope?: string } }>(
    '/api/integrations',
    async (request) => {
      const { clientId, type, scope } = request.query;
      if (type && !VALID_INTEGRATION_TYPES.includes(type as IntegrationType)) {
        return fastify.httpErrors.badRequest(
          `Invalid type. Must be one of: ${VALID_INTEGRATION_TYPES.join(', ')}`,
        );
      }

      const callerScope = await resolveClientScope(request);

      // `scope=platform` narrows to platform-scoped (clientId IS NULL) rows.
      // `scope=client` narrows to client-scoped rows (clientId IS NOT NULL).
      // A `clientId` query param takes precedence when both are set.
      // For scoped callers: client-scoped rows are filtered to their tenants;
      // platform-scoped rows (clientId IS NULL) are shared infrastructure and
      // visible to all authenticated callers.
      const where: Record<string, unknown> = {};
      if (clientId) {
        // Validate the requested clientId is within the caller's scope
        const clientIdAllowed =
          callerScope.type === 'all' ||
          (callerScope.type === 'single' && callerScope.clientId === clientId) ||
          (callerScope.type === 'assigned' && callerScope.clientIds.includes(clientId));
        where.clientId = clientIdAllowed ? clientId : '__none__';
      } else if (scope === 'platform') {
        where.clientId = null;
      } else if (scope === 'client') {
        // Restrict to the caller's tenant(s) when filtering for client-scoped rows
        const scopeWhere = scopeToWhere(callerScope);
        if (scopeWhere.clientId !== undefined) {
          where.clientId = scopeWhere.clientId;
        } else {
          where.clientId = { not: null };
        }
      } else {
        // No explicit filter: for scoped callers, show only their tenant's rows
        // plus platform-scoped (null) rows.
        if (callerScope.type === 'single') {
          where.OR = [{ clientId: callerScope.clientId }, { clientId: null }];
        } else if (callerScope.type === 'assigned') {
          where.OR = [{ clientId: { in: callerScope.clientIds } }, { clientId: null }];
        }
        // type === 'all': no clientId filter — return everything
      }
      if (type) where.type = type;
      return fastify.db.clientIntegration.findMany({
        where,
        include: {
          client: { select: { name: true, shortCode: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/integrations/:id', async (request) => {
    const callerScope = await resolveClientScope(request);
    // Platform-scoped integrations (clientId IS NULL) are accessible to all callers.
    // Client-scoped integrations are restricted to the caller's tenant(s).
    const scopeFilter = callerScope.type === 'all'
      ? {}
      : { OR: [
          { clientId: null },
          callerScope.type === 'single'
            ? { clientId: callerScope.clientId }
            : { clientId: { in: callerScope.clientIds } },
        ] };
    const integration = await fastify.db.clientIntegration.findFirst({
      where: { id: request.params.id, ...scopeFilter },
      include: {
        client: { select: { name: true, shortCode: true } },
      },
    });
    if (!integration) return fastify.httpErrors.notFound('Integration not found');
    return integration;
  });

  fastify.post<{
    Body: {
      clientId?: string | null;
      type: string;
      label?: string;
      config: Record<string, unknown>;
      environmentId?: string | null;
      isActive?: boolean;
      notes?: string;
    };
  }>('/api/integrations', async (request, reply) => {
    if (!VALID_INTEGRATION_TYPES.includes(request.body.type as IntegrationType)) {
      return fastify.httpErrors.badRequest(
        `Invalid type. Must be one of: ${VALID_INTEGRATION_TYPES.join(', ')}`,
      );
    }
    const configError = validateIntegrationConfig(request.body.type, request.body.config);
    if (configError) {
      return fastify.httpErrors.badRequest(`Invalid config for ${request.body.type}: ${configError}`);
    }
    const { clientId, environmentId, type } = request.body;
    // Platform-scoped integrations are only supported for GITHUB today.
    // Other types always require a client.
    const isPlatformScoped = clientId === null || clientId === undefined;
    if (isPlatformScoped && type !== IntegrationType.GITHUB) {
      return fastify.httpErrors.badRequest(
        `clientId is required for ${type} integrations. Only GITHUB integrations may be platform-scoped.`,
      );
    }

    // Scope enforcement: validate the caller is authorized for the target client.
    // Platform-scoped (null clientId) integrations require 'all' scope — only ADMIN/API-key.
    const callerScope = await resolveClientScope(request);
    if (isPlatformScoped) {
      if (callerScope.type !== 'all') {
        return fastify.httpErrors.forbidden('clientId not in your scope');
      }
    } else if (
      callerScope.type === 'single' && callerScope.clientId !== clientId ||
      callerScope.type === 'assigned' && !callerScope.clientIds.includes(clientId!)
    ) {
      return fastify.httpErrors.forbidden('clientId not in your scope');
    }
    if (environmentId !== undefined && environmentId !== null) {
      if (!clientId) {
        return fastify.httpErrors.badRequest('environmentId cannot be set on a platform-scoped integration');
      }
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== clientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
    }
    const encryptedConfig = encryptConfigSecrets(request.body.type, request.body.config, encryptionKey);
    try {
      const integration = await fastify.db.clientIntegration.create({
        data: {
          ...request.body,
          clientId: clientId ?? null,
          config: encryptedConfig,
        } as never,
      });
      // Trigger async MCP discovery for MCP_DATABASE integrations
      if (request.body.type === IntegrationType.MCP_DATABASE) {
        await mcpDiscoveryQueue.add('discover', { integrationId: integration.id });
      }
      // Refresh client Slack connections when a SLACK integration is created
      if (request.body.type === IntegrationType.SLACK) {
        onSlackIntegrationChange?.();
      }
      reply.code(201);
      return integration;
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict(
          'An integration of this type with this label already exists for this client',
        );
      }
      throw err;
    }
  });

  fastify.patch<{
    Params: { id: string };
    Body: {
      label?: string;
      config?: Record<string, unknown>;
      environmentId?: string | null;
      isActive?: boolean;
      notes?: string;
    };
  }>('/api/integrations/:id', async (request) => {
    const callerScope = await resolveClientScope(request);
    // Platform-scoped rows (clientId IS NULL) are accessible to all callers.
    // Client-scoped rows are restricted to the caller's tenant(s).
    const scopeFilter = callerScope.type === 'all'
      ? {}
      : { OR: [
          { clientId: null },
          callerScope.type === 'single'
            ? { clientId: callerScope.clientId }
            : { clientId: { in: callerScope.clientIds } },
        ] };

    // Always fetch the existing row for scope guard and type/config merging
    const existing = await fastify.db.clientIntegration.findFirst({
      where: { id: request.params.id, ...scopeFilter },
      select: { type: true, config: true, clientId: true },
    });
    if (!existing) return fastify.httpErrors.notFound('Integration not found');
    const existingType = existing.type;
    const existingClientId = existing.clientId;

    if (request.body.config !== undefined) {
      // Merge incoming config with existing so that omitted fields (e.g. secrets) are preserved
      const existingConfig = typeof existing.config === 'object' && existing.config !== null && !Array.isArray(existing.config)
        ? existing.config as Record<string, unknown>
        : {};
      const mergedConfig = { ...existingConfig, ...request.body.config };

      const configError = validateIntegrationConfig(existing.type, mergedConfig);
      if (configError) {
        return fastify.httpErrors.badRequest(`Invalid config for ${existing.type}: ${configError}`);
      }

      request.body.config = encryptConfigSecrets(existing.type, mergedConfig, encryptionKey);
    }

    if (request.body.environmentId !== undefined && request.body.environmentId !== null) {
      if (!existingClientId) {
        return fastify.httpErrors.badRequest('environmentId cannot be set on a platform-scoped integration');
      }
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: request.body.environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== existingClientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
    }
    try {
      const updated = await fastify.db.clientIntegration.update({
        where: { id: request.params.id },
        data: request.body as never,
      });
      // Trigger async MCP discovery if config changed on an MCP_DATABASE integration
      if (existingType === IntegrationType.MCP_DATABASE && request.body.config !== undefined) {
        await mcpDiscoveryQueue.add('discover', { integrationId: updated.id });
      }
      // Refresh client Slack connections when a SLACK integration is updated
      if (existingType === IntegrationType.SLACK) {
        onSlackIntegrationChange?.();
      }
      return updated;
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Integration not found');
      }
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict(
          'An integration of this type with this label already exists for this client',
        );
      }
      throw err;
    }
  });

  // On-demand re-verification of MCP server discovery
  fastify.post<{ Params: { id: string } }>('/api/integrations/:id/verify', async (request) => {
    const callerScope = await resolveClientScope(request);
    const scopeFilter = callerScope.type === 'all'
      ? {}
      : { OR: [
          { clientId: null },
          callerScope.type === 'single'
            ? { clientId: callerScope.clientId }
            : { clientId: { in: callerScope.clientIds } },
        ] };
    const integration = await fastify.db.clientIntegration.findFirst({
      where: { id: request.params.id, ...scopeFilter },
      select: { id: true, type: true },
    });
    if (!integration) return fastify.httpErrors.notFound('Integration not found');
    if (integration.type !== IntegrationType.MCP_DATABASE) {
      return fastify.httpErrors.badRequest('Verification is only supported for MCP_DATABASE integrations');
    }
    await mcpDiscoveryQueue.add('discover', { integrationId: integration.id });
    return { message: 'Verification job enqueued' };
  });

  fastify.delete<{ Params: { id: string } }>('/api/integrations/:id', async (request, reply) => {
    const callerScope = await resolveClientScope(request);
    const scopeFilter = callerScope.type === 'all'
      ? {}
      : { OR: [
          { clientId: null },
          callerScope.type === 'single'
            ? { clientId: callerScope.clientId }
            : { clientId: { in: callerScope.clientIds } },
        ] };
    const integration = await fastify.db.clientIntegration.findFirst({
      where: { id: request.params.id, ...scopeFilter },
      select: { id: true, type: true },
    });
    if (!integration) return fastify.httpErrors.notFound('Integration not found');

    try {
      const deleted = await fastify.db.clientIntegration.delete({
        where: { id: request.params.id },
        select: { type: true },
      });
      // Refresh client Slack connections when a SLACK integration is deleted
      if (deleted.type === IntegrationType.SLACK) {
        onSlackIntegrationChange?.();
      }
      reply.code(204);
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Integration not found');
      }
      throw err;
    }
  });
}
