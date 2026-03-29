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

function requireUser(fastify: FastifyInstance, request: FastifyRequest): string {
  if (!request.user) throw fastify.httpErrors.unauthorized('Authentication required');
  return request.user.id;
}

export async function ticketFilterPresetRoutes(fastify: FastifyInstance): Promise<void> {
  // List all presets for the authenticated user
  fastify.get('/api/ticket-filter-presets', async (request) => {
    const userId = requireUser(fastify, request);
    return fastify.db.ticketFilterPreset.findMany({
      where: { userId },
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
      const userId = requireUser(fastify, request);
      const { name, statusFilter, categoryFilter, clientIdFilter, priorityFilter, isDefault } = parsed.data;

      try {
        const preset = await fastify.db.$transaction(async (tx) => {
          // If setting as default, clear other defaults first
          if (isDefault) {
            await tx.ticketFilterPreset.updateMany({
              where: { userId, isDefault: true },
              data: { isDefault: false },
            });
          }

          return tx.ticketFilterPreset.create({
            data: {
              userId,
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
      const userId = requireUser(fastify, request);
      const existing = await fastify.db.ticketFilterPreset.findUnique({
        where: { id: request.params.id },
      });
      if (!existing || existing.userId !== userId) {
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
              where: { userId, isDefault: true, id: { not: existing.id } },
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
      const userId = requireUser(fastify, request);
      const existing = await fastify.db.ticketFilterPreset.findUnique({
        where: { id: request.params.id },
      });
      if (!existing || existing.userId !== userId) {
        return reply.status(404).send({ error: 'Preset not found' });
      }

      await fastify.db.ticketFilterPreset.delete({ where: { id: existing.id } });
      return reply.status(204).send();
    },
  );
}
