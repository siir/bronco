import type { FastifyInstance } from 'fastify';
import { DbEngine } from '@bronco/shared-types';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

const VALID_DB_ENGINES = Object.values(DbEngine);

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export async function systemRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/systems',
    async (request) => {
      const scope = await resolveClientScope(request);
      const scopeWhere = scopeToWhere(scope);
      const { clientId } = request.query;
      // If a specific clientId is requested, it must fall within the caller's scope
      const effectiveClientId = clientId && (
        scope.type === 'all' ||
        (scope.type === 'single' && scope.clientId === clientId) ||
        (scope.type === 'assigned' && scope.clientIds.includes(clientId))
      ) ? clientId : undefined;
      return fastify.db.system.findMany({
        where: {
          ...scopeWhere,
          ...(effectiveClientId && { clientId: effectiveClientId }),
        },
        include: {
          client: { select: { name: true, shortCode: true } },
          _count: { select: { tickets: true, findings: true } },
        },
        orderBy: { name: 'asc' },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/systems/:id', async (request) => {
    const scope = await resolveClientScope(request);
    const system = await fastify.db.system.findFirst({
      where: { id: request.params.id, ...scopeToWhere(scope) },
      include: {
        client: { select: { name: true, shortCode: true } },
        findings: { orderBy: { detectedAt: 'desc' }, take: 10 },
      },
    });
    if (!system) return fastify.httpErrors.notFound('System not found');
    return system;
  });

  fastify.post<{
    Body: {
      clientId: string;
      name: string;
      dbEngine?: string;
      host: string;
      port?: number;
      connectionString?: string;
      instanceName?: string;
      defaultDatabase?: string;
      authMethod?: string;
      username?: string;
      encryptedPassword?: string;
      useTls?: boolean;
      trustServerCert?: boolean;
      connectionTimeout?: number;
      requestTimeout?: number;
      maxPoolSize?: number;
      environment?: string;
      environmentId?: string | null;
      notes?: string;
    };
  }>('/api/systems', async (request, reply) => {
    if (request.body.dbEngine && !VALID_DB_ENGINES.includes(request.body.dbEngine as DbEngine)) {
      return fastify.httpErrors.badRequest(
        `Invalid dbEngine. Must be one of: ${VALID_DB_ENGINES.join(', ')}`,
      );
    }
    const scope = await resolveClientScope(request);
    const { clientId, environmentId } = request.body;
    if (
      scope.type === 'single' && scope.clientId !== clientId ||
      scope.type === 'assigned' && !scope.clientIds.includes(clientId)
    ) {
      return fastify.httpErrors.forbidden('clientId not in your scope');
    }
    if (environmentId !== undefined && environmentId !== null) {
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== clientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
    }
    try {
      const system = await fastify.db.system.create({
        data: request.body as never,
      });
      reply.code(201);
      return system;
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A system with this name already exists for this client');
      }
      throw err;
    }
  });

  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      host?: string;
      port?: number;
      connectionString?: string;
      instanceName?: string;
      defaultDatabase?: string;
      authMethod?: string;
      username?: string;
      encryptedPassword?: string;
      useTls?: boolean;
      trustServerCert?: boolean;
      connectionTimeout?: number;
      requestTimeout?: number;
      maxPoolSize?: number;
      isActive?: boolean;
      environment?: string;
      environmentId?: string | null;
      notes?: string;
    };
  }>('/api/systems/:id', async (request) => {
    const scope = await resolveClientScope(request);
    const system = await fastify.db.system.findFirst({
      where: { id: request.params.id, ...scopeToWhere(scope) },
      select: { clientId: true },
    });
    if (!system) return fastify.httpErrors.notFound('System not found');

    if (request.body.environmentId !== undefined && request.body.environmentId !== null) {
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: request.body.environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== system.clientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
    }
    try {
      return await fastify.db.system.update({
        where: { id: request.params.id },
        data: request.body as never,
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('System not found');
      }
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/systems/:id', async (request, reply) => {
    const scope = await resolveClientScope(request);
    const system = await fastify.db.system.findFirst({
      where: { id: request.params.id, ...scopeToWhere(scope) },
      select: { id: true },
    });
    if (!system) return fastify.httpErrors.notFound('System not found');

    const ticketCount = await fastify.db.ticket.count({
      where: { systemId: request.params.id },
    });
    if (ticketCount > 0) {
      return fastify.httpErrors.conflict(
        `Cannot delete system with ${ticketCount} associated ticket(s). ` +
        'Deactivate the system instead via PATCH with { isActive: false }.',
      );
    }

    try {
      await fastify.db.system.delete({
        where: { id: request.params.id },
      });
      reply.code(204);
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('System not found');
      }
      throw err;
    }
  });
}
