import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const bodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  statusFilter: z.string().max(200).optional().nullable(),
  categoryFilter: z.string().max(50).optional().nullable(),
  clientIdFilter: z.string().uuid().optional().nullable(),
  priorityFilter: z.string().max(50).optional().nullable(),
  isDefault: z.boolean().optional(),
});

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

function requireOperator(fastify: FastifyInstance, request: FastifyRequest): string {
  if (!request.user) throw fastify.httpErrors.unauthorized('Authentication required');
  return request.user.operatorId;
}

export async function ticketFilterPresetRoutes(fastify: FastifyInstance): Promise<void> {
  // List all presets for the authenticated operator
  fastify.get('/api/ticket-filter-presets', async (request) => {
    const operatorId = requireOperator(fastify, request);
    return fastify.db.ticketFilterPreset.findMany({
      where: { operatorId },
      orderBy: { name: 'asc' },
    });
  });

  // Create a new preset
  fastify.post<{ Body: z.input<typeof bodySchema> }>(
    '/api/ticket-filter-presets',
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.errors[0]?.message ?? 'Invalid body' });
      }
      const operatorId = requireOperator(fastify, request);
      const { name, statusFilter, categoryFilter, clientIdFilter, priorityFilter, isDefault } = parsed.data;

      try {
        const preset = await fastify.db.$transaction(async (tx) => {
          // If setting as default, clear other defaults first
          if (isDefault) {
            await tx.ticketFilterPreset.updateMany({
              where: { operatorId, isDefault: true },
              data: { isDefault: false },
            });
          }

          return tx.ticketFilterPreset.create({
            data: {
              operatorId,
              name,
              statusFilter: statusFilter ?? null,
              categoryFilter: categoryFilter ?? null,
              clientIdFilter: clientIdFilter ?? null,
              priorityFilter: priorityFilter ?? null,
              isDefault: isDefault ?? false,
            },
          });
        });
        return reply.status(201).send(preset);
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          return reply.status(409).send({ error: `A preset named "${name}" already exists` });
        }
        throw err;
      }
    },
  );

  // Update a preset
  fastify.patch<{ Params: { id: string }; Body: Partial<z.input<typeof bodySchema>> }>(
    '/api/ticket-filter-presets/:id',
    async (request, reply) => {
      const operatorId = requireOperator(fastify, request);
      const existing = await fastify.db.ticketFilterPreset.findUnique({
        where: { id: request.params.id },
      });
      if (!existing || existing.operatorId !== operatorId) {
        return reply.status(404).send({ error: 'Preset not found' });
      }

      const parsed = bodySchema.partial().safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.errors[0]?.message ?? 'Invalid body' });
      }
      const { name, statusFilter, categoryFilter, clientIdFilter, priorityFilter, isDefault } = parsed.data;

      try {
        const updated = await fastify.db.$transaction(async (tx) => {
          if (isDefault) {
            await tx.ticketFilterPreset.updateMany({
              where: { operatorId, isDefault: true, id: { not: existing.id } },
              data: { isDefault: false },
            });
          }

          return tx.ticketFilterPreset.update({
            where: { id: existing.id },
            data: {
              ...(name !== undefined && { name }),
              ...(statusFilter !== undefined && { statusFilter }),
              ...(categoryFilter !== undefined && { categoryFilter }),
              ...(clientIdFilter !== undefined && { clientIdFilter }),
              ...(priorityFilter !== undefined && { priorityFilter }),
              ...(isDefault !== undefined && { isDefault }),
            },
          });
        });
        return updated;
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          return reply.status(409).send({ error: `A preset named "${name}" already exists` });
        }
        throw err;
      }
    },
  );

  // Delete a preset
  fastify.delete<{ Params: { id: string } }>(
    '/api/ticket-filter-presets/:id',
    async (request, reply) => {
      const operatorId = requireOperator(fastify, request);
      const existing = await fastify.db.ticketFilterPreset.findUnique({
        where: { id: request.params.id },
      });
      if (!existing || existing.operatorId !== operatorId) {
        return reply.status(404).send({ error: 'Preset not found' });
      }

      await fastify.db.ticketFilterPreset.delete({ where: { id: existing.id } });
      return reply.status(204).send();
    },
  );
}
