import type { FastifyInstance } from 'fastify';

const TAG_RE = /^[a-z0-9-]+$/;

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export async function clientEnvironmentRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/clients/:id/environments
  fastify.get<{ Params: { id: string } }>(
    '/api/clients/:id/environments',
    async (request) => {
      return fastify.db.clientEnvironment.findMany({
        where: { clientId: request.params.id },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    },
  );

  // POST /api/clients/:id/environments
  fastify.post<{
    Params: { id: string };
    Body: {
      name: string;
      tag: string;
      description?: string;
      operationalInstructions?: string;
      isDefault?: boolean;
      sortOrder?: number;
    };
  }>('/api/clients/:id/environments', async (request, reply) => {
    const { name, tag, description, operationalInstructions, isDefault, sortOrder } = request.body;

    const trimmedName = name?.trim();
    const trimmedTag = tag?.trim();
    if (!trimmedName) return reply.code(400).send({ error: 'name is required' });
    if (!trimmedTag) return reply.code(400).send({ error: 'tag is required' });
    if (!TAG_RE.test(trimmedTag)) {
      return reply.code(400).send({ error: 'tag must be lowercase alphanumeric with hyphens' });
    }

    try {
      const env = await fastify.db.$transaction(async (tx) => {
        if (isDefault) {
          await tx.clientEnvironment.updateMany({
            where: { clientId: request.params.id, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.clientEnvironment.create({
          data: {
            clientId: request.params.id,
            name: trimmedName,
            tag: trimmedTag,
            description,
            operationalInstructions,
            isDefault: isDefault ?? false,
            sortOrder: sortOrder ?? 0,
          },
        });
      });
      reply.code(201);
      return env;
    } catch (err) {
      if (isPrismaError(err, 'P2003')) {
        return reply.code(400).send({ error: 'Invalid clientId: client does not exist' });
      }
      if (isPrismaError(err, 'P2002')) {
        return reply.code(409).send({ error: 'An environment with this tag already exists for this client' });
      }
      throw err;
    }
  });

  // PATCH /api/clients/:id/environments/:envId
  fastify.patch<{
    Params: { id: string; envId: string };
    Body: {
      name?: string;
      tag?: string;
      description?: string;
      operationalInstructions?: string;
      isDefault?: boolean;
      isActive?: boolean;
      sortOrder?: number;
    };
  }>('/api/clients/:id/environments/:envId', async (request, reply) => {
    const { name, tag, description, operationalInstructions, isDefault, isActive, sortOrder } = request.body;

    if (name !== undefined && !name.trim()) {
      return reply.code(400).send({ error: 'name cannot be empty' });
    }
    const trimmedTag = tag !== undefined ? tag.trim() : undefined;
    if (trimmedTag !== undefined && !TAG_RE.test(trimmedTag)) {
      return reply.code(400).send({ error: 'tag must be lowercase alphanumeric with hyphens' });
    }

    try {
      return await fastify.db.$transaction(async (tx) => {
        if (isDefault) {
          await tx.clientEnvironment.updateMany({
            where: { clientId: request.params.id, isDefault: true, id: { not: request.params.envId } },
            data: { isDefault: false },
          });
        }
        return tx.clientEnvironment.update({
          where: { id: request.params.envId, clientId: request.params.id },
          data: {
            ...(name !== undefined && { name: name.trim() }),
            ...(trimmedTag !== undefined && { tag: trimmedTag }),
            ...(description !== undefined && { description }),
            ...(operationalInstructions !== undefined && { operationalInstructions }),
            ...(isDefault !== undefined && { isDefault }),
            ...(isActive !== undefined && { isActive }),
            ...(sortOrder !== undefined && { sortOrder }),
          },
        });
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return reply.code(404).send({ error: 'Environment not found' });
      }
      if (isPrismaError(err, 'P2002')) {
        return reply.code(409).send({ error: 'An environment with this tag already exists for this client' });
      }
      throw err;
    }
  });

  // DELETE /api/clients/:id/environments/:envId
  fastify.delete<{ Params: { id: string; envId: string } }>(
    '/api/clients/:id/environments/:envId',
    async (request, reply) => {
      // Verify the environment belongs to this client before modifying any linked resources
      const env = await fastify.db.clientEnvironment.findFirst({
        where: { id: request.params.envId, clientId: request.params.id },
      });
      if (!env) return reply.code(404).send({ error: 'Environment not found' });

      // Reject deletion if tickets reference this environment (FK is RESTRICT — ticket history is preserved)
      const ticketCount = await fastify.db.ticket.count({
        where: { environmentId: request.params.envId },
      });
      if (ticketCount > 0) {
        return reply.code(409).send({ error: `Cannot delete environment: ${ticketCount} ticket(s) reference it. Remove the environment from those tickets first.` });
      }

      // Null out environmentId on linked resources (scoped to this client) before deleting
      await fastify.db.clientIntegration.updateMany({
        where: { environmentId: request.params.envId, clientId: request.params.id },
        data: { environmentId: null },
      });
      await fastify.db.codeRepo.updateMany({
        where: { environmentId: request.params.envId, clientId: request.params.id },
        data: { environmentId: null },
      });
      await fastify.db.system.updateMany({
        where: { environmentId: request.params.envId, clientId: request.params.id },
        data: { environmentId: null },
      });

      await fastify.db.clientEnvironment.delete({
        where: { id: request.params.envId },
      });
      return reply.code(204).send();
    },
  );
}
