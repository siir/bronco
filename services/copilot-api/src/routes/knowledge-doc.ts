import type { FastifyInstance } from 'fastify';
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
      const ticket = await loadKnowledgeDoc(fastify.db, request.params.id);
      if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
      return buildToc(ticket.knowledgeDoc, ticket.knowledgeDocSectionMeta);
    },
  );

  // GET /api/tickets/:id/knowledge-doc/section/:sectionKey
  fastify.get<{ Params: { id: string; sectionKey: string } }>(
    '/api/tickets/:id/knowledge-doc/section/:sectionKey',
    async (request, reply) => {
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
