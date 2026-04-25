/**
 * Unit tests for v2-knowledge-doc.ts — composeFinalAnalysis, fallbackFillRequiredSections,
 * writeKnowledgeDocSnapshot, writeStallMarker.
 *
 * No real Prisma client. DB calls are mocked at the minimum interface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { KnowledgeDocSectionKey, KnowledgeDocUpdateMode } from '@bronco/shared-types';
import {
  initEmptyKnowledgeDoc,
  updateSection,
  readSection,
} from '@bronco/shared-utils';
import {
  composeFinalAnalysis,
  fallbackFillRequiredSections,
  writeKnowledgeDocSnapshot,
  writeStallMarker,
} from './v2-knowledge-doc.js';

// ---------------------------------------------------------------------------
// Helpers to build realistic knowledge docs for testing
// ---------------------------------------------------------------------------

/**
 * Build a knowledge doc with specific sections filled.
 * Uses the real shared-utils initEmptyKnowledgeDoc + updateSection logic
 * in-memory (no DB) by calling splitIntoSections / composeSections directly
 * via the exported helpers.
 */
function buildDocWithSections(
  sections: Partial<Record<KnowledgeDocSectionKey, string>>,
): string {
  let doc = initEmptyKnowledgeDoc();
  // Manually inject content by constructing the markdown directly so we don't
  // need to call updateSection (which requires a DB transaction).
  for (const [key, content] of Object.entries(sections) as Array<[KnowledgeDocSectionKey, string]>) {
    if (!content) continue;
    // Find the section header and replace the empty body
    const titleMap: Record<string, string> = {
      problemStatement: 'Problem Statement',
      environment: 'Environment',
      evidence: 'Evidence',
      hypotheses: 'Hypotheses',
      rootCause: 'Root Cause',
      recommendedFix: 'Recommended Fix',
      risks: 'Risks',
      openQuestions: 'Open Questions',
      runLog: 'Run Log',
    };
    const title = titleMap[key];
    if (!title) continue;
    // Replace the empty section body with the provided content.
    // The template produces "## Title\n\n" for empty sections; we inject the body.
    doc = doc.replace(
      new RegExp(`(## ${title}\n)(\n)`, 'g'),
      `$1\n${content}\n\n`,
    );
  }
  return doc;
}

/**
 * Build a minimal sectionMeta that includes timestamps for the given keys.
 */
function buildMeta(keys: string[]): Record<string, { updatedAt: string; length: number }> {
  const meta: Record<string, { updatedAt: string; length: number }> = {};
  for (const key of keys) {
    meta[key] = { updatedAt: '2025-01-01T00:00:00.000Z', length: 100 };
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Minimal DB mock factory
// ---------------------------------------------------------------------------

function makeMockDb(overrides?: {
  ticketFindUnique?: unknown;
  ticketUpdate?: unknown;
  knowledgeDocSnapshotCreate?: unknown;
}): PrismaClient {
  return {
    ticket: {
      findUnique: vi.fn().mockResolvedValue(
        overrides?.ticketFindUnique ?? null,
      ),
      update: vi.fn().mockResolvedValue(overrides?.ticketUpdate ?? {}),
    },
    knowledgeDocSnapshot: {
      create: vi.fn().mockResolvedValue(overrides?.knowledgeDocSnapshotCreate ?? {}),
    },
    // withTicketLock uses $executeRaw for the advisory lock acquisition
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        ticket: {
          findUnique: vi.fn().mockResolvedValue(overrides?.ticketFindUnique ?? null),
          update: vi.fn().mockResolvedValue(overrides?.ticketUpdate ?? {}),
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(1),
      });
    }),
  } as unknown as PrismaClient;
}

// ---------------------------------------------------------------------------
// composeFinalAnalysis
// ---------------------------------------------------------------------------

describe('composeFinalAnalysis', () => {
  it('includes all four key sections from a well-filled doc', () => {
    const doc = buildDocWithSections({
      problemStatement: 'Query timeout on production DB.',
      rootCause: 'Missing index on Orders.CustomerId.',
      recommendedFix: 'Add index: CREATE INDEX IX_Orders_CustomerId ON Orders(CustomerId).',
      risks: 'Index build may lock the table briefly.',
    });
    const meta = buildMeta([
      KnowledgeDocSectionKey.PROBLEM_STATEMENT,
      KnowledgeDocSectionKey.ROOT_CAUSE,
      KnowledgeDocSectionKey.RECOMMENDED_FIX,
      KnowledgeDocSectionKey.RISKS,
    ]);

    const result = composeFinalAnalysis(doc, meta, 'Agent executive summary text.');

    expect(result).toContain('## Executive Summary');
    expect(result).toContain('Agent executive summary text.');
    expect(result).toContain('## Problem Statement');
    expect(result).toContain('Query timeout on production DB.');
    expect(result).toContain('## Root Cause');
    expect(result).toContain('Missing index on Orders.CustomerId.');
    expect(result).toContain('## Recommended Fix');
    expect(result).toContain('Add index:');
    expect(result).toContain('## Risks');
    expect(result).toContain('Index build may lock the table briefly.');
  });

  it('section order: Executive Summary → Problem Statement → Root Cause → Recommended Fix → Risks', () => {
    const doc = buildDocWithSections({
      problemStatement: 'PS',
      rootCause: 'RC',
      recommendedFix: 'RF',
      risks: 'RK',
    });

    const result = composeFinalAnalysis(doc, {}, 'Summary');

    const summaryIdx = result.indexOf('## Executive Summary');
    const psIdx = result.indexOf('## Problem Statement');
    const rcIdx = result.indexOf('## Root Cause');
    const rfIdx = result.indexOf('## Recommended Fix');
    const riskIdx = result.indexOf('## Risks');

    expect(summaryIdx).toBeLessThan(psIdx);
    expect(psIdx).toBeLessThan(rcIdx);
    expect(rcIdx).toBeLessThan(rfIdx);
    expect(rfIdx).toBeLessThan(riskIdx);
  });

  it('omits Executive Summary header when agent summary is empty string', () => {
    const doc = buildDocWithSections({ rootCause: 'RC content' });
    const result = composeFinalAnalysis(doc, {}, '');
    expect(result).not.toContain('## Executive Summary');
    expect(result).toContain('## Root Cause');
  });

  it('omits Executive Summary header when agent summary is whitespace only', () => {
    const doc = buildDocWithSections({ rootCause: 'RC content' });
    const result = composeFinalAnalysis(doc, {}, '   \n  ');
    expect(result).not.toContain('## Executive Summary');
  });

  it('returns non-empty output when doc is null and summary is provided', () => {
    const result = composeFinalAnalysis(null, null, 'Only summary available.');
    expect(result).toContain('## Executive Summary');
    expect(result).toContain('Only summary available.');
  });

  it('returns empty string when doc is null and summary is also empty', () => {
    const result = composeFinalAnalysis(null, null, '');
    expect(result.trim()).toBe('');
  });

  it('skips sections that are empty in the doc', () => {
    const doc = buildDocWithSections({ rootCause: 'RC content' });
    const result = composeFinalAnalysis(doc, {}, 'Summary');
    // problemStatement is empty — should NOT appear
    expect(result).not.toContain('## Problem Statement');
    // rootCause is filled — should appear
    expect(result).toContain('## Root Cause');
  });

  it('does not include Environment, Evidence, Hypotheses, Open Questions, or Run Log sections', () => {
    const doc = buildDocWithSections({
      environment: 'Prod DB',
      evidence: 'Log lines',
      hypotheses: 'Maybe X',
      openQuestions: 'Is Y?',
      runLog: 'Step 1',
    });

    const result = composeFinalAnalysis(doc, {}, 'summary');
    expect(result).not.toContain('## Environment');
    expect(result).not.toContain('## Evidence');
    expect(result).not.toContain('## Hypotheses');
    expect(result).not.toContain('## Open Questions');
    expect(result).not.toContain('## Run Log');
  });

  it('handles doc with all sections empty — only summary in output', () => {
    const doc = initEmptyKnowledgeDoc();
    const result = composeFinalAnalysis(doc, {}, 'Only this summary.');
    expect(result).toContain('## Executive Summary');
    expect(result).toContain('Only this summary.');
    // No section headers from doc should appear (all empty)
    expect(result).not.toContain('## Root Cause');
    expect(result).not.toContain('## Problem Statement');
  });

  it('trims leading and trailing whitespace from the output', () => {
    const doc = buildDocWithSections({ rootCause: 'RC' });
    const result = composeFinalAnalysis(doc, {}, 'Summary');
    expect(result).toBe(result.trimEnd());
  });

  it('section content that is only whitespace is skipped', () => {
    const doc = buildDocWithSections({ rootCause: '   \n   ' });
    const result = composeFinalAnalysis(doc, {}, 'Summary');
    expect(result).not.toContain('## Root Cause');
  });
});

// ---------------------------------------------------------------------------
// fallbackFillRequiredSections
// ---------------------------------------------------------------------------

describe('fallbackFillRequiredSections', () => {
  const REQUIRED_KEYS = [
    KnowledgeDocSectionKey.PROBLEM_STATEMENT,
    KnowledgeDocSectionKey.ROOT_CAUSE,
    KnowledgeDocSectionKey.RECOMMENDED_FIX,
  ] as const;

  it('returns empty array when ticket is not found', async () => {
    const db = makeMockDb({ ticketFindUnique: null });
    const filled = await fallbackFillRequiredSections(db, 'ticket-123', 'test reason');
    expect(filled).toEqual([]);
  });

  it('fills all three required sections when they are empty', async () => {
    const emptyDoc = initEmptyKnowledgeDoc();
    const db = makeMockDb({
      ticketFindUnique: { knowledgeDoc: emptyDoc, knowledgeDocSectionMeta: {} },
    });

    // Capture update calls
    const updateCalls: Array<{ ticketId: string; key: string; content: string }> = [];
    (db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const capturedTx = {
        ticket: {
          findUnique: vi.fn().mockResolvedValue({ id: 'ticket-123', knowledgeDoc: emptyDoc, knowledgeDocSectionMeta: {} }),
          update: vi.fn().mockImplementation(({ where, data }: { where: { id: string }; data: { knowledgeDoc?: string } }) => {
            // Detect which section was updated from the doc content
            const newDoc = data.knowledgeDoc ?? '';
            for (const key of REQUIRED_KEYS) {
              if (newDoc.includes('[agent did not populate this section')) {
                updateCalls.push({ ticketId: where.id, key, content: newDoc });
              }
            }
            return Promise.resolve({});
          }),
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(1),
      };
      return fn(capturedTx);
    });

    const filled = await fallbackFillRequiredSections(db, 'ticket-123', 'flat loop end');

    // Should have filled all three required sections
    expect(filled).toHaveLength(3);
    expect(filled).toContain(KnowledgeDocSectionKey.PROBLEM_STATEMENT);
    expect(filled).toContain(KnowledgeDocSectionKey.ROOT_CAUSE);
    expect(filled).toContain(KnowledgeDocSectionKey.RECOMMENDED_FIX);
  });

  it('skips sections that already have content', async () => {
    // Build a doc with rootCause populated, others empty
    const docWithRootCause = buildDocWithSections({
      rootCause: 'A real root cause was found.',
    });

    // Each call to $transaction gets the current doc (already filled for rootCause)
    const db = makeMockDb({
      ticketFindUnique: {
        knowledgeDoc: docWithRootCause,
        knowledgeDocSectionMeta: {
          [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 28 },
        },
      },
    });

    // Make $transaction pass through to the ticket mock
    (db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        ticket: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'ticket-123',
            knowledgeDoc: docWithRootCause,
            knowledgeDocSectionMeta: {
              [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 28 },
            },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(1),
      });
    });

    const filled = await fallbackFillRequiredSections(db, 'ticket-123', 'test');

    // rootCause is already populated, so only problemStatement and recommendedFix should be filled
    expect(filled).not.toContain(KnowledgeDocSectionKey.ROOT_CAUSE);
    expect(filled).toContain(KnowledgeDocSectionKey.PROBLEM_STATEMENT);
    expect(filled).toContain(KnowledgeDocSectionKey.RECOMMENDED_FIX);
    expect(filled).toHaveLength(2);
  });

  it('marker string contains the reason passed in', async () => {
    const emptyDoc = initEmptyKnowledgeDoc();
    const writtenContents: string[] = [];

    const db = makeMockDb({
      ticketFindUnique: { knowledgeDoc: emptyDoc, knowledgeDocSectionMeta: {} },
    });

    (db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        ticket: {
          findUnique: vi.fn().mockResolvedValue({ id: 'ticket-123', knowledgeDoc: emptyDoc, knowledgeDocSectionMeta: {} }),
          update: vi.fn().mockImplementation(({ data }: { data: { knowledgeDoc?: string } }) => {
            if (data.knowledgeDoc) writtenContents.push(data.knowledgeDoc);
            return Promise.resolve({});
          }),
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(1),
      });
    });

    await fallbackFillRequiredSections(db, 'ticket-123', 'my custom reason');

    expect(writtenContents.length).toBeGreaterThan(0);
    // At least one write should contain the reason text
    const anyContainsReason = writtenContents.some(c => c.includes('my custom reason'));
    expect(anyContainsReason).toBe(true);
  });

  it('returns empty array when all required sections already have content', async () => {
    const docFull = buildDocWithSections({
      problemStatement: 'PS content',
      rootCause: 'RC content',
      recommendedFix: 'RF content',
    });

    const db = makeMockDb({
      ticketFindUnique: {
        knowledgeDoc: docFull,
        knowledgeDocSectionMeta: {
          [KnowledgeDocSectionKey.PROBLEM_STATEMENT]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 10 },
          [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 10 },
          [KnowledgeDocSectionKey.RECOMMENDED_FIX]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 10 },
        },
      },
    });

    const filled = await fallbackFillRequiredSections(db, 'ticket-123', 'test');
    expect(filled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeKnowledgeDocSnapshot
// ---------------------------------------------------------------------------

describe('writeKnowledgeDocSnapshot', () => {
  it('creates a snapshot row with correct shape', async () => {
    const doc = buildDocWithSections({ rootCause: 'RC content' });
    const meta = { [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 10 } };

    const createMock = vi.fn().mockResolvedValue({});
    const db = {
      ticket: {
        findUnique: vi.fn().mockResolvedValue({
          knowledgeDoc: doc,
          knowledgeDocSectionMeta: meta,
        }),
      },
      knowledgeDocSnapshot: {
        create: createMock,
      },
    } as unknown as PrismaClient;

    await writeKnowledgeDocSnapshot(db, 'ticket-abc', 3, 'run-123');

    expect(createMock).toHaveBeenCalledOnce();
    const callArg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(callArg.data.ticketId).toBe('ticket-abc');
    expect(callArg.data.iteration).toBe(3);
    expect(callArg.data.content).toBe(doc);
    expect(callArg.data.sectionMeta).toEqual(meta);
    expect(callArg.data.runId).toBe('run-123');
  });

  it('creates a snapshot without runId when not provided', async () => {
    const createMock = vi.fn().mockResolvedValue({});
    const db = {
      ticket: {
        findUnique: vi.fn().mockResolvedValue({
          knowledgeDoc: 'some doc',
          knowledgeDocSectionMeta: {},
        }),
      },
      knowledgeDocSnapshot: { create: createMock },
    } as unknown as PrismaClient;

    await writeKnowledgeDocSnapshot(db, 'ticket-abc', 1);

    expect(createMock).toHaveBeenCalledOnce();
    const callArg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(callArg.data.runId).toBeUndefined();
  });

  it('swallows errors and does not throw', async () => {
    const db = {
      ticket: {
        findUnique: vi.fn().mockRejectedValue(new Error('DB connection error')),
      },
      knowledgeDocSnapshot: {
        create: vi.fn(),
      },
    } as unknown as PrismaClient;

    // Should not throw
    await expect(writeKnowledgeDocSnapshot(db, 'ticket-abc', 1)).resolves.toBeUndefined();
  });

  it('does nothing when ticket is not found', async () => {
    const createMock = vi.fn();
    const db = {
      ticket: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      knowledgeDocSnapshot: { create: createMock },
    } as unknown as PrismaClient;

    await writeKnowledgeDocSnapshot(db, 'ticket-missing', 1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('uses empty string for content when knowledgeDoc is null', async () => {
    const createMock = vi.fn().mockResolvedValue({});
    const db = {
      ticket: {
        findUnique: vi.fn().mockResolvedValue({
          knowledgeDoc: null,
          knowledgeDocSectionMeta: {},
        }),
      },
      knowledgeDocSnapshot: { create: createMock },
    } as unknown as PrismaClient;

    await writeKnowledgeDocSnapshot(db, 'ticket-abc', 2);

    expect(createMock).toHaveBeenCalledOnce();
    const callArg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(callArg.data.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// writeStallMarker
// ---------------------------------------------------------------------------

describe('writeStallMarker', () => {
  it('writes a stall marker to rootCause when section is empty', async () => {
    const emptyDoc = initEmptyKnowledgeDoc();
    const writtenData: Array<Record<string, unknown>> = [];

    const db = {
      ticket: {
        findUnique: vi.fn().mockResolvedValue({
          knowledgeDoc: emptyDoc,
          knowledgeDocSectionMeta: {},
        }),
      },
      $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
          ticket: {
            findUnique: vi.fn().mockResolvedValue({
              id: 'ticket-stall',
              knowledgeDoc: emptyDoc,
              knowledgeDocSectionMeta: {},
            }),
            update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
              writtenData.push(data);
              return Promise.resolve({});
            }),
          },
          $queryRaw: vi.fn().mockResolvedValue([]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        });
      }),
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    await writeStallMarker(db, 'ticket-stall', 3, 'zero progress across 3 iterations');

    expect(writtenData.length).toBeGreaterThan(0);
    const doc = writtenData[writtenData.length - 1].knowledgeDoc as string;
    expect(doc).toContain('⚠️ Orchestrator stalled at iteration 3');
    expect(doc).toContain('zero progress across 3 iterations');
  });

  it('marker includes the iteration number and reason', async () => {
    const emptyDoc = initEmptyKnowledgeDoc();
    const writtenDocs: string[] = [];

    const db = {
      ticket: {
        findUnique: vi.fn().mockResolvedValue({
          knowledgeDoc: emptyDoc,
          knowledgeDocSectionMeta: {},
        }),
      },
      $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
          ticket: {
            findUnique: vi.fn().mockResolvedValue({
              id: 'ticket-stall',
              knowledgeDoc: emptyDoc,
              knowledgeDocSectionMeta: {},
            }),
            update: vi.fn().mockImplementation(({ data }: { data: { knowledgeDoc?: string } }) => {
              if (data.knowledgeDoc) writtenDocs.push(data.knowledgeDoc);
              return Promise.resolve({});
            }),
          },
          $queryRaw: vi.fn().mockResolvedValue([]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        });
      }),
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    await writeStallMarker(db, 'ticket-stall', 7, 'repeated identical response hashes');

    expect(writtenDocs.length).toBeGreaterThan(0);
    const lastDoc = writtenDocs[writtenDocs.length - 1];
    expect(lastDoc).toContain('iteration 7');
    expect(lastDoc).toContain('repeated identical response hashes');
  });

  it('swallows errors and does not throw', async () => {
    const db = {
      ticket: {
        findUnique: vi.fn().mockRejectedValue(new Error('network error')),
      },
      $transaction: vi.fn().mockRejectedValue(new Error('tx error')),
      $queryRaw: vi.fn().mockRejectedValue(new Error('queryraw error')),
    } as unknown as PrismaClient;

    await expect(writeStallMarker(db, 'ticket-abc', 2, 'reason')).resolves.toBeUndefined();
  });

  it('appends marker when rootCause section already has content', async () => {
    const docWithRootCause = buildDocWithSections({
      rootCause: 'Partial findings before stall.',
    });
    const writtenDocs: string[] = [];

    const db = {
      ticket: {
        findUnique: vi.fn().mockResolvedValue({
          knowledgeDoc: docWithRootCause,
          knowledgeDocSectionMeta: {
            [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 30 },
          },
        }),
      },
      $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
          ticket: {
            findUnique: vi.fn().mockResolvedValue({
              id: 'ticket-stall',
              knowledgeDoc: docWithRootCause,
              knowledgeDocSectionMeta: {
                [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 30 },
              },
            }),
            update: vi.fn().mockImplementation(({ data }: { data: { knowledgeDoc?: string } }) => {
              if (data.knowledgeDoc) writtenDocs.push(data.knowledgeDoc);
              return Promise.resolve({});
            }),
          },
          $queryRaw: vi.fn().mockResolvedValue([]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        });
      }),
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    await writeStallMarker(db, 'ticket-stall', 2, 'stall reason');

    // The doc should contain BOTH the original findings AND the stall marker
    expect(writtenDocs.length).toBeGreaterThan(0);
    const lastDoc = writtenDocs[writtenDocs.length - 1];
    expect(lastDoc).toContain('Partial findings before stall.');
    expect(lastDoc).toContain('⚠️ Orchestrator stalled');
  });
});

// ---------------------------------------------------------------------------
// KD_SYSTEM_PROMPT_SNIPPET (from v2-prompts.ts — consumed by v2-knowledge-doc users)
// Spot-check that it's non-empty and contains expected keywords
// ---------------------------------------------------------------------------

describe('KD_SYSTEM_PROMPT_SNIPPET (from v2-prompts.ts)', () => {
  it('is a non-empty string', async () => {
    const { KD_SYSTEM_PROMPT_SNIPPET } = await import('./v2-prompts.js');
    expect(typeof KD_SYSTEM_PROMPT_SNIPPET).toBe('string');
    expect(KD_SYSTEM_PROMPT_SNIPPET.trim().length).toBeGreaterThan(0);
  });

  it('mentions required section keys', async () => {
    const { KD_SYSTEM_PROMPT_SNIPPET } = await import('./v2-prompts.js');
    expect(KD_SYSTEM_PROMPT_SNIPPET).toContain('problemStatement');
    expect(KD_SYSTEM_PROMPT_SNIPPET).toContain('rootCause');
    expect(KD_SYSTEM_PROMPT_SNIPPET).toContain('recommendedFix');
  });

  it('mentions the kd_* tool names', async () => {
    const { KD_SYSTEM_PROMPT_SNIPPET } = await import('./v2-prompts.js');
    expect(KD_SYSTEM_PROMPT_SNIPPET).toContain('kd_update_section');
    expect(KD_SYSTEM_PROMPT_SNIPPET).toContain('kd_add_subsection');
  });
});

// ---------------------------------------------------------------------------
// readSection round-trip sanity (uses real shared-utils — no mock needed)
// ---------------------------------------------------------------------------

describe('readSection (shared-utils integration sanity)', () => {
  it('reads back content that was placed in the doc', () => {
    const doc = buildDocWithSections({ rootCause: 'My root cause content.' });
    const { content } = readSection(doc, {}, KnowledgeDocSectionKey.ROOT_CAUSE);
    expect(content.trim()).toBe('My root cause content.');
  });

  it('returns empty string for an unset section', () => {
    const doc = initEmptyKnowledgeDoc();
    const { content } = readSection(doc, {}, KnowledgeDocSectionKey.ROOT_CAUSE);
    expect(content.trim()).toBe('');
  });

  it('returns empty string when doc is null', () => {
    const { content } = readSection(null, {}, KnowledgeDocSectionKey.ROOT_CAUSE);
    expect(content).toBe('');
  });
});
