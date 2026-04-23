/**
 * v2-only knowledge-doc helpers. Composition of final analysis from the
 * templated section-keyed doc, fallback-fill for required sections the agent
 * didn't populate, and KnowledgeDocSnapshot persistence.
 *
 * v1 strategies MUST NOT import from this file — v1 writes the legacy
 * free-form knowledgeDoc blob directly and has no section-meta sidecar.
 */

import type { PrismaClient } from '@bronco/db';
import {
  KnowledgeDocSectionKey,
  KnowledgeDocUpdateMode,
} from '@bronco/shared-types';
import {
  createLogger,
  loadKnowledgeDoc,
  readSection,
  updateSection,
  REQUIRED_SECTION_KEYS,
} from '@bronco/shared-utils';

const logger = createLogger('ticket-analyzer');

const KD_REQUIRED_FALLBACK_SECTIONS: ReadonlyArray<KnowledgeDocSectionKey> = REQUIRED_SECTION_KEYS;

/**
 * Compose the final AI_ANALYSIS content from the knowledge doc's Problem
 * Statement / Root Cause / Recommended Fix / Risks sections, prefixing the
 * agent's own text-block response as the executive summary.
 *
 * Safe to call with a null doc — falls back to the agent summary alone.
 */
export function composeFinalAnalysis(
  knowledgeDoc: string | null,
  sectionMeta: unknown,
  agentExecutiveSummary: string,
): string {
  const parts: string[] = [];
  const summary = agentExecutiveSummary.trim();
  if (summary) {
    parts.push('## Executive Summary');
    parts.push('');
    parts.push(summary);
  }
  const sectionsToPull: Array<{ key: KnowledgeDocSectionKey; title: string }> = [
    { key: KnowledgeDocSectionKey.PROBLEM_STATEMENT, title: 'Problem Statement' },
    { key: KnowledgeDocSectionKey.ROOT_CAUSE, title: 'Root Cause' },
    { key: KnowledgeDocSectionKey.RECOMMENDED_FIX, title: 'Recommended Fix' },
    { key: KnowledgeDocSectionKey.RISKS, title: 'Risks' },
  ];
  for (const { key, title } of sectionsToPull) {
    const { content } = readSection(knowledgeDoc, sectionMeta, key);
    if (!content.trim()) continue;
    if (parts.length > 0) parts.push('');
    parts.push(`## ${title}`);
    parts.push('');
    parts.push(content.trim());
  }
  return parts.join('\n').trimEnd();
}

/**
 * Best-effort snapshot writer. Captures `knowledgeDoc` + `knowledgeDocSectionMeta`
 * as a `KnowledgeDocSnapshot` row so the future iteration-diff view has
 * per-iteration ground truth. Failures are logged and swallowed so the
 * analysis loop is never blocked by snapshot persistence.
 */
export async function writeKnowledgeDocSnapshot(
  db: PrismaClient,
  ticketId: string,
  iteration: number,
  runId?: string,
): Promise<void> {
  try {
    const ticket = await loadKnowledgeDoc(db, ticketId);
    if (!ticket) return;
    await db.knowledgeDocSnapshot.create({
      data: {
        ticketId,
        iteration,
        content: ticket.knowledgeDoc ?? '',
        sectionMeta: (ticket.knowledgeDocSectionMeta ?? undefined) as object | undefined,
        ...(runId ? { runId } : {}),
      },
    });
  } catch (err) {
    logger.warn({ err, ticketId, iteration }, 'Failed to persist KnowledgeDocSnapshot — continuing');
  }
}

/**
 * Write an operator-readable stall marker to the rootCause section when the
 * orchestrator loop terminates early because it detected no forward progress.
 *
 * Called BEFORE `fallbackFillRequiredSections` at end-of-run — once rootCause
 * has real content, the generic `[agent did not populate this section — …]`
 * fallback will skip it, so the Analysis Trace and composed email surface the
 * *real reason* the analysis is blank instead of the generic placeholder.
 *
 * If rootCause already has content (the agent wrote partial findings before
 * stalling), the marker is appended rather than replacing the existing text,
 * so real investigative findings are preserved for the operator.
 *
 * Swallows errors so a stall-marker write failure can't block the downstream
 * fallback-fill pass.
 */
export async function writeStallMarker(
  db: PrismaClient,
  ticketId: string,
  iteration: number,
  reason: string,
): Promise<void> {
  const body = [
    `⚠️ Orchestrator stalled at iteration ${iteration}: ${reason}.`,
    '',
    'See Run Log and iteration snapshots for context. This analysis was terminated',
    'early by the stall detector to avoid burning further budget on a non-progressing',
    'loop. The agent produced no investigative findings that could be composed into',
    'a root cause — escalate, re-run with more context, or flag as a prompt issue.',
  ].join('\n');
  try {
    const ticket = await loadKnowledgeDoc(db, ticketId);
    const existing = ticket
      ? readSection(ticket.knowledgeDoc, ticket.knowledgeDocSectionMeta, KnowledgeDocSectionKey.ROOT_CAUSE).content.trim()
      : '';
    // If the agent already wrote partial findings, append so real content is
    // preserved. If the section is empty, use REPLACE so the marker is the
    // first and only text (avoids a blank line before the marker).
    const mode = existing.length > 0 ? KnowledgeDocUpdateMode.APPEND : KnowledgeDocUpdateMode.REPLACE;
    await updateSection(
      db,
      ticketId,
      KnowledgeDocSectionKey.ROOT_CAUSE,
      body,
      mode,
    );
  } catch (err) {
    logger.warn({ err, ticketId, iteration, reason }, 'Failed to write stall marker to rootCause — continuing');
  }
}

/**
 * End-of-run guard: for every required section the agent didn't populate
 * (problemStatement / rootCause / recommendedFix), write a fallback marker so
 * downstream `composeFinalAnalysis` always has something to render. Returns
 * the list of keys that were fallback-filled.
 */
export async function fallbackFillRequiredSections(
  db: PrismaClient,
  ticketId: string,
  reason: string,
): Promise<string[]> {
  const ticket = await loadKnowledgeDoc(db, ticketId);
  if (!ticket) return [];
  const filled: string[] = [];
  for (const key of KD_REQUIRED_FALLBACK_SECTIONS) {
    const { content } = readSection(ticket.knowledgeDoc, ticket.knowledgeDocSectionMeta, key);
    if (content.trim().length > 0) continue;
    try {
      await updateSection(
        db,
        ticketId,
        key,
        `[agent did not populate this section — ${reason}]`,
        KnowledgeDocUpdateMode.REPLACE,
      );
      filled.push(key);
    } catch (err) {
      logger.warn({ err, ticketId, key }, 'Fallback-fill failed for required section');
    }
  }
  if (filled.length > 0) {
    logger.warn({ ticketId, filled, reason }, `Fallback-filled ${filled.length} required section(s)`);
  }
  return filled;
}
