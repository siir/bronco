import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const emailSchema = z.string().email('Invalid email format');

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export async function contactRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/contacts',
    async (request) => {
      const { clientId } = request.query;
      return fastify.db.contact.findMany({
        where: {
          ...(clientId && { clientId }),
        },
        include: {
          client: { select: { name: true, shortCode: true } },
        },
        orderBy: { name: 'asc' },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/contacts/:id', async (request) => {
    const contact = await fastify.db.contact.findUnique({
      where: { id: request.params.id },
      include: {
        client: { select: { name: true, shortCode: true } },
      },
    });
    if (!contact) return fastify.httpErrors.notFound('Contact not found');
    return contact;
  });

  fastify.post<{
    Body: {
      clientId: string;
      name: string;
      email: string;
      phone?: string;
      role?: string;
      slackUserId?: string;
      isPrimary?: boolean;
    };
  }>('/api/contacts', async (request, reply) => {
    const parsed = emailSchema.safeParse(request.body.email);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(parsed.error.issues[0].message);
    }
    const contact = await fastify.db.contact.create({
      data: request.body,
    });
    reply.code(201);
    return contact;
  });

  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      email?: string;
      phone?: string;
      role?: string;
      slackUserId?: string | null;
      isPrimary?: boolean;
    };
  }>('/api/contacts/:id', async (request) => {
    if (request.body.email !== undefined) {
      const parsed = emailSchema.safeParse(request.body.email);
      if (!parsed.success) {
        return fastify.httpErrors.badRequest(parsed.error.issues[0].message);
      }
    }
    try {
      return await fastify.db.contact.update({
        where: { id: request.params.id },
        data: request.body,
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Contact not found');
      }
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/contacts/:id', async (request, reply) => {
    try {
      await fastify.db.contact.delete({
        where: { id: request.params.id },
      });
      reply.code(204);
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Contact not found');
      }
      // P2003: foreign key constraint violation — contact is referenced by ticket followers
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.conflict('Cannot delete contact — they are a follower on one or more tickets. Remove them from tickets first.');
      }
      throw err;
    }
  });
}
