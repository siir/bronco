import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import type { ServerDeps } from '../server.js';

/**
 * Four `kd_*` tools that let analysis agents maintain the templated knowledge
 * document on a ticket without round-tripping through copilot-api. Shared
 * core (parse / compose / advisory-lock) lives in `@bronco/shared-utils`.
 *
 * All writes are serialized per-ticket via `withTicketLock` inside the shared
 * helpers, so concurrent sub-task writes (orchestrated strategy with
 * `maxParallelTasks > 1`) don't clobber each other.
 */
export function registerKnowledgeDocTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'kd_read_toc',
    'Return the knowledge-doc table of contents for a ticket: top-level sections (Problem Statement, Environment, Evidence, Hypotheses, Root Cause, Recommended Fix, Risks, Open Questions, Run Log) with length, lastUpdatedAt, and any subsections under Evidence / Hypotheses / Open Questions. Call this before writing so you can see what has already been documented.',
    {
      ticketId: z.string().uuid().describe('The active ticket ID'),
    },
    async (params) => {
      const ticket = await loadKnowledgeDoc(db, params.ticketId);
      if (!ticket) {
        return { content: [{ type: 'text', text: 'ERROR: ticket not found' }], isError: true };
      }
      const toc = buildToc(ticket.knowledgeDoc, ticket.knowledgeDocSectionMeta);
      return { content: [{ type: 'text', text: JSON.stringify(toc, null, 2) }] };
    },
  );

  server.tool(
    'kd_read_section',
    'Read a single section of the knowledge doc. `sectionKey` is a top-level key (e.g. `evidence`) or a dotted subsection key (e.g. `evidence.blocking_on_sp_jobs`). Returns content + lastUpdatedAt + length. Returns an empty content string when the section does not exist yet.',
    {
      ticketId: z.string().uuid().describe('The active ticket ID'),
      sectionKey: z.string().min(1).describe('Top-level key (problemStatement, environment, evidence, hypotheses, rootCause, recommendedFix, risks, openQuestions, runLog) or dotted subsection key (evidence.<slug>, hypotheses.<slug>, openQuestions.<slug>)'),
    },
    async (params) => {
      const ticket = await loadKnowledgeDoc(db, params.ticketId);
      if (!ticket) {
        return { content: [{ type: 'text', text: 'ERROR: ticket not found' }], isError: true };
      }
      const result = readSection(ticket.knowledgeDoc, ticket.knowledgeDocSectionMeta, params.sectionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'kd_update_section',
    'Update a top-level knowledge-doc section. `sectionKey` must be one of: problemStatement, environment, evidence, hypotheses, rootCause, recommendedFix, risks, openQuestions, runLog. `mode: "replace"` overwrites the section body; `mode: "append"` concatenates. Subsection keys are rejected here — use kd_add_subsection. Content is capped at 10000 chars per section; over-cap returns an ERROR.',
    {
      ticketId: z.string().uuid().describe('The active ticket ID'),
      sectionKey: z.string().min(1).describe('Top-level section key'),
      content: z.string().describe('Section body content (markdown)'),
      mode: z.enum([KnowledgeDocUpdateMode.REPLACE, KnowledgeDocUpdateMode.APPEND]).default(KnowledgeDocUpdateMode.REPLACE).describe('"replace" overwrites the section; "append" concatenates after existing content'),
    },
    async (params) => {
      try {
        const result = await updateSection(
          db,
          params.ticketId,
          params.sectionKey,
          params.content,
          params.mode,
        );
        return { content: [{ type: 'text', text: JSON.stringify({ sectionKey: params.sectionKey, ...result }, null, 2) }] };
      } catch (err) {
        if (err instanceof KnowledgeDocError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'kd_add_subsection',
    'Add a subsection under one of: evidence, hypotheses, openQuestions. Title is deterministically slugified and collision-suffixed (`-2`, `-3`, …) so the returned full dotted key (e.g. `evidence.blocking_on_sp_jobs`) is unique under the parent. Content is capped at 10000 chars per subsection.',
    {
      ticketId: z.string().uuid().describe('The active ticket ID'),
      parentSectionKey: z.string().min(1).describe('Parent section key — must be one of: evidence, hypotheses, openQuestions'),
      title: z.string().min(1).describe('Human-readable subsection title (used to generate the slug)'),
      content: z.string().describe('Subsection body content (markdown)'),
    },
    async (params) => {
      try {
        const result = await addSubsection(
          db,
          params.ticketId,
          params.parentSectionKey,
          params.title,
          params.content,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof KnowledgeDocError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
      }
    },
  );
}
