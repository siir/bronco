import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClientMemoryResolver } from '@bronco/ai-provider';
import { MemoryType, MemorySource, TicketCategory } from '@bronco/shared-types';

const VALID_MEMORY_TYPES = new Set(Object.values(MemoryType));
const VALID_SOURCES = new Set(Object.values(MemorySource));
const VALID_CATEGORIES = new Set(Object.values(TicketCategory));

const listQuerySchema = z.object({
  clientId: z.string().optional(),
  category: z.enum(Object.values(TicketCategory) as [string, ...string[]]).optional(),
  memoryType: z.enum(Object.values(MemoryType) as [string, ...string[]]).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

interface ClientMemoryOpts {
  clientMemoryResolver: ClientMemoryResolver;
}

export async function clientMemoryRoutes(
  fastify: FastifyInstance,
  opts: ClientMemoryOpts,
): Promise<void> {
  const { clientMemoryResolver } = opts;

  // List memories for a client (with optional filters)
  fastify.get<{
    Querystring: { clientId?: string; category?: string; memoryType?: string; isActive?: string };
  }>('/api/client-memory', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw fastify.httpErrors.badRequest(parsed.error.errors[0]?.message ?? 'Invalid query parameters');
    }
    const { clientId, category, memoryType, isActive } = parsed.data;
    const where: Record<string, unknown> = {};
    if (clientId) where.clientId = clientId;
    if (category) where.category = category;
    if (memoryType) where.memoryType = memoryType;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    return fastify.db.clientMemory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      include: { client: { select: { id: true, name: true, shortCode: true } } },
    });
  });

  // Get single memory entry
  fastify.get<{ Params: { id: string } }>('/api/client-memory/:id', async (request) => {
    const entry = await fastify.db.clientMemory.findUnique({
      where: { id: request.params.id },
      include: { client: { select: { id: true, name: true, shortCode: true } } },
    });
    if (!entry) return fastify.httpErrors.notFound('Client memory entry not found');
    return entry;
  });

  // Create memory entry
  fastify.post<{
    Body: {
      clientId: string;
      title: string;
      memoryType: string;
      category?: string | null;
      tags?: string[];
      content: string;
      sortOrder?: number;
      source?: string;
    };
  }>('/api/client-memory', async (request, reply) => {
    const { clientId, title, memoryType, category, tags, content, sortOrder, source } = request.body;

    if (!clientId || !title?.trim() || !content?.trim()) {
      return fastify.httpErrors.badRequest('clientId, title, and content are required');
    }
    if (!VALID_MEMORY_TYPES.has(memoryType as MemoryType)) {
      return fastify.httpErrors.badRequest(`Invalid memoryType. Must be one of: ${[...VALID_MEMORY_TYPES].join(', ')}`);
    }
    if (category && !VALID_CATEGORIES.has(category as TicketCategory)) {
      return fastify.httpErrors.badRequest(`Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }
    if (source && !VALID_SOURCES.has(source as MemorySource)) {
      return fastify.httpErrors.badRequest(`Invalid source. Must be one of: ${[...VALID_SOURCES].join(', ')}`);
    }

    let entry;
    try {
      entry = await fastify.db.clientMemory.create({
        data: {
          clientId,
          title: title.trim(),
          memoryType,
          category: (category || null) as TicketCategory | null,
          tags: tags ?? [],
          content: content.trim(),
          sortOrder: sortOrder ?? 0,
          source: source ?? MemorySource.MANUAL,
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.badRequest('Invalid clientId: client does not exist');
      }
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A memory entry with this title already exists for this client');
      }
      throw err;
    }

    clientMemoryResolver.invalidate(clientId);
    reply.code(201);
    return entry;
  });

  // Update memory entry
  fastify.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      memoryType?: string;
      category?: string | null;
      tags?: string[];
      content?: string;
      isActive?: boolean;
      sortOrder?: number;
      source?: string;
    };
  }>('/api/client-memory/:id', async (request) => {
    const { memoryType, category, source, title, content, ...rest } = request.body;

    if (memoryType && !VALID_MEMORY_TYPES.has(memoryType as MemoryType)) {
      return fastify.httpErrors.badRequest(`Invalid memoryType. Must be one of: ${[...VALID_MEMORY_TYPES].join(', ')}`);
    }
    if (category !== undefined && category !== null && !VALID_CATEGORIES.has(category as TicketCategory)) {
      return fastify.httpErrors.badRequest(`Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }
    if (source && !VALID_SOURCES.has(source as MemorySource)) {
      return fastify.httpErrors.badRequest(`Invalid source. Must be one of: ${[...VALID_SOURCES].join(', ')}`);
    }

    const data: Record<string, unknown> = { ...rest };
    if (memoryType !== undefined) data.memoryType = memoryType;
    if (category !== undefined) data.category = category || null;
    if (source !== undefined) data.source = source;
    if (title !== undefined) {
      const trimmedTitle = title.trim();
      if (!trimmedTitle) return fastify.httpErrors.badRequest('title cannot be empty');
      data.title = trimmedTitle;
    }
    if (content !== undefined) {
      const trimmedContent = content.trim();
      if (!trimmedContent) return fastify.httpErrors.badRequest('content cannot be empty');
      data.content = trimmedContent;
    }

    let entry;
    try {
      entry = await fastify.db.clientMemory.update({
        where: { id: request.params.id },
        data,
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Client memory entry not found');
      }
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A memory entry with this title already exists for this client');
      }
      throw err;
    }

    clientMemoryResolver.invalidate(entry.clientId);
    return entry;
  });

  // Delete memory entry
  fastify.delete<{ Params: { id: string } }>('/api/client-memory/:id', async (request, reply) => {
    const entry = await fastify.db.clientMemory.findUnique({ where: { id: request.params.id } });
    if (!entry) return fastify.httpErrors.notFound('Client memory entry not found');

    await fastify.db.clientMemory.delete({ where: { id: request.params.id } });
    clientMemoryResolver.invalidate(entry.clientId);
    reply.code(204).send();
  });
}
