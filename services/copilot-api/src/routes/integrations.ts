import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { IntegrationType } from '@bronco/shared-types';
import { encrypt, looksEncrypted } from '@bronco/shared-utils';

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

const configSchemaByType: Record<string, z.ZodType> = {
  [IntegrationType.IMAP]: imapConfigSchema,
  [IntegrationType.AZURE_DEVOPS]: azureDevOpsConfigSchema,
  [IntegrationType.MCP_DATABASE]: mcpDatabaseConfigSchema,
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
}

export async function integrationRoutes(fastify: FastifyInstance, opts: IntegrationRouteOpts): Promise<void> {
  const { encryptionKey, mcpDiscoveryQueue } = opts;
  fastify.get<{ Querystring: { clientId?: string; type?: string } }>(
    '/api/integrations',
    async (request) => {
      const { clientId, type } = request.query;
      if (type && !VALID_INTEGRATION_TYPES.includes(type as IntegrationType)) {
        return fastify.httpErrors.badRequest(
          `Invalid type. Must be one of: ${VALID_INTEGRATION_TYPES.join(', ')}`,
        );
      }
      return fastify.db.clientIntegration.findMany({
        where: {
          ...(clientId && { clientId }),
          ...(type && { type: type as never }),
        },
        include: {
          client: { select: { name: true, shortCode: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/integrations/:id', async (request) => {
    const integration = await fastify.db.clientIntegration.findUnique({
      where: { id: request.params.id },
      include: {
        client: { select: { name: true, shortCode: true } },
      },
    });
    if (!integration) return fastify.httpErrors.notFound('Integration not found');
    return integration;
  });

  fastify.post<{
    Body: {
      clientId: string;
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
    const { clientId, environmentId } = request.body;
    if (environmentId !== undefined && environmentId !== null) {
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
        data: { ...request.body, config: encryptedConfig } as never,
      });
      // Trigger async MCP discovery for MCP_DATABASE integrations
      if (request.body.type === IntegrationType.MCP_DATABASE) {
        await mcpDiscoveryQueue.add('discover', { integrationId: integration.id });
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
    let existingType: string | undefined;
    const needsExisting = request.body.config !== undefined || request.body.environmentId !== undefined;
    let existingClientId: string | undefined;
    if (needsExisting) {
      const existing = await fastify.db.clientIntegration.findUnique({
        where: { id: request.params.id },
        select: { type: true, config: true, clientId: true },
      });
      if (!existing) return fastify.httpErrors.notFound('Integration not found');
      existingType = existing.type;
      existingClientId = existing.clientId;

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
    }
    if (request.body.environmentId !== undefined && request.body.environmentId !== null && existingClientId) {
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
    const integration = await fastify.db.clientIntegration.findUnique({
      where: { id: request.params.id },
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
    try {
      await fastify.db.clientIntegration.delete({
        where: { id: request.params.id },
      });
      reply.code(204);
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Integration not found');
      }
      throw err;
    }
  });
}
