import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  addSubsection,
  buildToc,
  KnowledgeDocError,
  loadKnowledgeDoc,
  readSection,
  updateSection,
} from '@bronco/shared-utils';
import { KnowledgeDocUpdateMode } from '@bronco/shared-types';
import { resolveClientScope } from '../plugins/client-scope.js';

/**
 * Verify the caller's client scope covers the target ticket. Returns true if
 * allowed; returns false when the ticket is missing OR out of scope (callers
 * should treat both as 404 to avoid ticket-ID enumeration).
 */
async function ticketInScope(
  fastify: FastifyInstance,
  request: FastifyRequest,
  ticketId: string,
): Promise<boolean> {
  const ticket = await fastify.db.ticket.findUnique({
    where: { id: ticketId },
    select: { clientId: true },
  });
  if (!ticket) return false;
  const scope = await resolveClientScope(request);
  if (scope.type === 'all') return true;
  if (scope.type === 'single') return ticket.clientId === scope.clientId;
  return scope.clientIds.includes(ticket.clientId);
}

/**
 * REST mirrors for the four `kd_*` MCP platform tools. The control panel hits
 * these directly so the Knowledge tab can render the TOC + section bodies
 * without going through MCP. Core parse / compose / advisory-lock logic is
 * shared with the MCP handlers via `@bronco/shared-utils`.
 */
export async function knowledgeDocRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/tickets/:id/knowledge-doc/toc
  fastify.get<{ Params: { id: string } }>(
    '/api/tickets/:id/knowledge-doc/toc',
    async (request, reply) => {
      if (!(await ticketInScope(fastify, request, request.params.id))) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }
      const ticket = await loadKnowledgeDoc(fastify.db, request.params.id);
      if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
      return buildToc(ticket.knowledgeDoc, ticket.knowledgeDocSectionMeta);
    },
  );

  // GET /api/tickets/:id/knowledge-doc/section/:sectionKey
  fastify.get<{ Params: { id: string; sectionKey: string } }>(
    '/api/tickets/:id/knowledge-doc/section/:sectionKey',
    async (request, reply) => {
      if (!(await ticketInScope(fastify, request, request.params.id))) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }
      const ticket = await loadKnowledgeDoc(fastify.db, request.params.id);
      if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
      return readSection(ticket.knowledgeDoc, ticket.knowledgeDocSectionMeta, request.params.sectionKey);
    },
  );

  // PATCH /api/tickets/:id/knowledge-doc/section/:sectionKey
  const patchBodySchema = z.object({
    content: z.string(),
    mode: z.enum([KnowledgeDocUpdateMode.REPLACE, KnowledgeDocUpdateMode.APPEND]).default(KnowledgeDocUpdateMode.REPLACE),
  });
  fastify.patch<{
    Params: { id: string; sectionKey: string };
    Body: { content: string; mode?: string };
  }>(
    '/api/tickets/:id/knowledge-doc/section/:sectionKey',
    async (request, reply) => {
      if (!(await ticketInScope(fastify, request, request.params.id))) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }
      const parsed = patchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.errors[0]?.message ?? 'Invalid body' });
      }
      try {
        const result = await updateSection(
          fastify.db,
          request.params.id,
          request.params.sectionKey,
          parsed.data.content,
          parsed.data.mode,
        );
        return { sectionKey: request.params.sectionKey, ...result };
      } catch (err) {
        if (err instanceof KnowledgeDocError) {
          const code = err.code === 'TICKET_NOT_FOUND' ? 404
            : err.code === 'SECTION_TOO_LONG' ? 413
            : 400;
          return reply.code(code).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    },
  );

  // POST /api/tickets/:id/knowledge-doc/subsection
  const postBodySchema = z.object({
    parentSectionKey: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
  });
  fastify.post<{
    Params: { id: string };
    Body: { parentSectionKey: string; title: string; content: string };
  }>(
    '/api/tickets/:id/knowledge-doc/subsection',
    async (request, reply) => {
      if (!(await ticketInScope(fastify, request, request.params.id))) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }
      const parsed = postBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.errors[0]?.message ?? 'Invalid body' });
      }
      try {
        const result = await addSubsection(
          fastify.db,
          request.params.id,
          parsed.data.parentSectionKey,
          parsed.data.title,
          parsed.data.content,
        );
        return result;
      } catch (err) {
        if (err instanceof KnowledgeDocError) {
          const code = err.code === 'TICKET_NOT_FOUND' ? 404
            : err.code === 'SECTION_TOO_LONG' ? 413
            : 400;
          return reply.code(code).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    },
  );
}
