/**
 * Integration tests for tool-request-dedupe.ts — transactional persist path.
 *
 * Verifies:
 *   1. suggestedDuplicateOfId/suggestedDuplicateReason are written for dupe rows.
 *   2. suggestedImprovesExisting/suggestedImprovesReason are written for improve rows.
 *   3. dedupeAnalysisAt is stamped on every analyzed row.
 *   4. Prior stale suggestions are cleared for rows not flagged in current run.
 *   5. Rows with invalid IDs (not in validIds) are silently skipped.
 *   6. When the transaction body throws, NO suggestion fields are persisted
 *      (rollback semantics).
 *
 * The Anthropic SDK is NOT called. AIRouter.generate is mocked at the
 * instance level to return controlled JSON payloads.
 *
 * Requires TEST_DATABASE_URL pointing at a migrated Postgres instance.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import { getTestDb, truncateAll } from '@bronco/test-utils';
import { createClient } from '@bronco/test-utils';
import { runToolRequestDedupe } from './tool-request-dedupe.js';

// ---------------------------------------------------------------------------
// Skip suite when no real DB is available
// ---------------------------------------------------------------------------
const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

// ---------------------------------------------------------------------------
// Mock buildClientToolCatalog from @bronco/shared-utils
// — prevents HTTP calls to actual MCP servers during tests
// ---------------------------------------------------------------------------
vi.mock('@bronco/shared-utils', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@bronco/shared-utils')>();
  return {
    ...orig,
    buildClientToolCatalog: vi.fn().mockResolvedValue([]),
  };
});

// ---------------------------------------------------------------------------
// AIRouter mock factory
// — returns a minimal AIRouter that replays the provided JSON output
// ---------------------------------------------------------------------------
function makeAiRouter(output: unknown): AIRouter {
  return {
    generate: vi.fn().mockResolvedValue({
      content: JSON.stringify(output),
      model: 'mock-model',
      provider: 'mock',
      inputTokens: 0,
      outputTokens: 0,
    }),
  } as unknown as AIRouter;
}

// ---------------------------------------------------------------------------
// Seed helper — creates ToolRequest rows for a client
// ---------------------------------------------------------------------------
async function seedToolRequest(
  db: PrismaClient,
  clientId: string,
  overrides: {
    requestedName?: string;
    displayTitle?: string;
    description?: string;
    status?: string;
    kind?: string;
    suggestedDuplicateOfId?: string | null;
    suggestedDuplicateReason?: string | null;
    suggestedImprovesExisting?: string | null;
    suggestedImprovesReason?: string | null;
  } = {},
) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return db.toolRequest.create({
    data: {
      clientId,
      requestedName: overrides.requestedName ?? `tool_${suffix}`,
      displayTitle: overrides.displayTitle ?? `Tool ${suffix}`,
      description: overrides.description ?? `Describes tool ${suffix}`,
      status: (overrides.status ?? 'PROPOSED') as never,
      kind: (overrides.kind ?? 'NEW_TOOL') as never,
      suggestedDuplicateOfId: overrides.suggestedDuplicateOfId ?? null,
      suggestedDuplicateReason: overrides.suggestedDuplicateReason ?? null,
      suggestedImprovesExisting: overrides.suggestedImprovesExisting ?? null,
      suggestedImprovesReason: overrides.suggestedImprovesReason ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Stub encryption key (not used in tests since catalog is mocked)
// ---------------------------------------------------------------------------
const FAKE_KEY = 'a'.repeat(64);

describe.skipIf(!hasDb)('integration: runToolRequestDedupe — persistence', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  // -------------------------------------------------------------------------
  // 1. suggestedDuplicateOfId / suggestedDuplicateReason written correctly
  // -------------------------------------------------------------------------
  describe('duplicate group persistence', () => {
    it('writes suggestedDuplicateOfId and reason for rows the model flags as duplicates', async () => {
      const client = await createClient(db);
      const canonical = await seedToolRequest(db, client.id, { requestedName: 'search_schema' });
      const dup = await seedToolRequest(db, client.id, { requestedName: 'find_schema' });

      const ai = makeAiRouter({
        duplicateGroups: [
          {
            canonicalId: canonical.id,
            duplicateIds: [dup.id],
            reason: 'Both search schema objects.',
          },
        ],
        improvesExisting: [],
      });

      await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      const updatedDup = await db.toolRequest.findUniqueOrThrow({ where: { id: dup.id } });
      expect(updatedDup.suggestedDuplicateOfId).toBe(canonical.id);
      expect(updatedDup.suggestedDuplicateReason).toBe('Both search schema objects.');
      expect(updatedDup.dedupeAnalysisAt).not.toBeNull();
    });

    it('canonical row does not get suggestedDuplicateOfId set on itself', async () => {
      const client = await createClient(db);
      const canonical = await seedToolRequest(db, client.id, { requestedName: 'search_schema' });
      const dup = await seedToolRequest(db, client.id, { requestedName: 'find_schema' });

      const ai = makeAiRouter({
        duplicateGroups: [
          { canonicalId: canonical.id, duplicateIds: [dup.id], reason: 'Same purpose.' },
        ],
        improvesExisting: [],
      });

      await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      const updatedCanonical = await db.toolRequest.findUniqueOrThrow({ where: { id: canonical.id } });
      expect(updatedCanonical.suggestedDuplicateOfId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. suggestedImprovesExisting / suggestedImprovesReason written correctly
  // -------------------------------------------------------------------------
  describe('improvesExisting persistence', () => {
    it('writes suggestedImprovesExisting and reason for flagged rows', async () => {
      const client = await createClient(db);
      const req = await seedToolRequest(db, client.id, { requestedName: 'list_tables_enhanced' });

      const ai = makeAiRouter({
        duplicateGroups: [],
        improvesExisting: [
          {
            requestId: req.id,
            existingToolName: 'list_tables',
            reason: 'Adds schema filtering to existing list_tables.',
          },
        ],
      });

      await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      const updated = await db.toolRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(updated.suggestedImprovesExisting).toBe('list_tables');
      expect(updated.suggestedImprovesReason).toBe('Adds schema filtering to existing list_tables.');
      expect(updated.dedupeAnalysisAt).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. dedupeAnalysisAt stamped on ALL analyzed rows (not just flagged ones)
  // -------------------------------------------------------------------------
  describe('dedupeAnalysisAt stamping', () => {
    it('stamps dedupeAnalysisAt on every analyzed row even when no suggestions', async () => {
      const client = await createClient(db);
      const reqA = await seedToolRequest(db, client.id, { requestedName: 'tool_a' });
      const reqB = await seedToolRequest(db, client.id, { requestedName: 'tool_b' });

      const ai = makeAiRouter({ duplicateGroups: [], improvesExisting: [] });
      await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      const [a, b] = await Promise.all([
        db.toolRequest.findUniqueOrThrow({ where: { id: reqA.id } }),
        db.toolRequest.findUniqueOrThrow({ where: { id: reqB.id } }),
      ]);
      expect(a.dedupeAnalysisAt).not.toBeNull();
      expect(b.dedupeAnalysisAt).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Stale suggestions from prior runs are cleared
  // -------------------------------------------------------------------------
  describe('stale suggestion clearing', () => {
    it('clears suggestedDuplicateOfId from prior run when model no longer flags it', async () => {
      const client = await createClient(db);
      const canonical = await seedToolRequest(db, client.id, { requestedName: 'original_tool' });
      // Seed with stale suggestion from a previous run
      const stale = await seedToolRequest(db, client.id, {
        requestedName: 'old_dup',
        suggestedDuplicateOfId: canonical.id,
        suggestedDuplicateReason: 'Old stale reason',
      });

      // This run has no duplicate groups — model found nothing to flag
      const ai = makeAiRouter({ duplicateGroups: [], improvesExisting: [] });
      await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      const updated = await db.toolRequest.findUniqueOrThrow({ where: { id: stale.id } });
      expect(updated.suggestedDuplicateOfId).toBeNull();
      expect(updated.suggestedDuplicateReason).toBeNull();
    });

    it('clears suggestedImprovesExisting from prior run when not in current output', async () => {
      const client = await createClient(db);
      // Seed with stale improvesExisting suggestion
      const stale = await seedToolRequest(db, client.id, {
        requestedName: 'stale_improve',
        suggestedImprovesExisting: 'some_old_tool',
        suggestedImprovesReason: 'Old stale improve reason',
      });

      const ai = makeAiRouter({ duplicateGroups: [], improvesExisting: [] });
      await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      const updated = await db.toolRequest.findUniqueOrThrow({ where: { id: stale.id } });
      expect(updated.suggestedImprovesExisting).toBeNull();
      expect(updated.suggestedImprovesReason).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Invalid/foreign IDs are silently skipped
  // -------------------------------------------------------------------------
  describe('invalid ID handling', () => {
    it('skips duplicateGroup entries whose IDs are not in the analyzed set', async () => {
      const client = await createClient(db);
      const req = await seedToolRequest(db, client.id, { requestedName: 'valid_tool' });
      const FOREIGN_ID = '00000000-0000-0000-0000-000000000001';

      const ai = makeAiRouter({
        duplicateGroups: [
          {
            canonicalId: FOREIGN_ID,    // not in analyzed set
            duplicateIds: [req.id],
            reason: 'Should be skipped',
          },
        ],
        improvesExisting: [],
      });

      await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      const updated = await db.toolRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(updated.suggestedDuplicateOfId).toBeNull();
    });

    it('skips improvesExisting entries whose IDs are not in the analyzed set', async () => {
      const client = await createClient(db);
      await seedToolRequest(db, client.id, { requestedName: 'some_tool' });
      const FOREIGN_ID = '00000000-0000-0000-0000-000000000002';

      const ai = makeAiRouter({
        duplicateGroups: [],
        improvesExisting: [
          { requestId: FOREIGN_ID, existingToolName: 'existing', reason: 'Should skip' },
        ],
      });

      // Should not throw (UPDATE on unknown ID would simply match 0 rows)
      await expect(
        runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {}),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Rollback: if the $transaction callback throws, nothing is persisted
  // -------------------------------------------------------------------------
  describe('rollback semantics', () => {
    it('does not persist any suggestions when the transaction throws midway', async () => {
      const client = await createClient(db);
      const canonical = await seedToolRequest(db, client.id, { requestedName: 'tool_x' });
      const dup = await seedToolRequest(db, client.id, { requestedName: 'tool_y' });

      // Spy on $transaction to throw mid-execution
      const originalTransaction = db.$transaction.bind(db);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txSpy = vi.spyOn(db, '$transaction').mockImplementationOnce(async (_fn: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = _fn as (tx: any) => Promise<unknown>;
        // Start a real transaction, let it begin writing, then throw to trigger rollback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalTransaction as any)(async (tx: any) => {
          // Let the inner callback run (clears + stamps dedupeAnalysisAt)
          await fn(tx);
          // Force rollback by throwing after persistence
          throw new Error('Forced rollback for test');
        });
      });

      const ai = makeAiRouter({
        duplicateGroups: [
          { canonicalId: canonical.id, duplicateIds: [dup.id], reason: 'Dup' },
        ],
        improvesExisting: [],
      });

      await expect(
        runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {}),
      ).rejects.toThrow('Forced rollback for test');

      // After rollback, the DB rows must be unchanged
      const [updatedCanonical, updatedDup] = await Promise.all([
        db.toolRequest.findUniqueOrThrow({ where: { id: canonical.id } }),
        db.toolRequest.findUniqueOrThrow({ where: { id: dup.id } }),
      ]);

      expect(updatedDup.suggestedDuplicateOfId).toBeNull();
      expect(updatedDup.dedupeAnalysisAt).toBeNull();
      expect(updatedCanonical.dedupeAnalysisAt).toBeNull();

      txSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Empty requests set — returns early with zero counts
  // -------------------------------------------------------------------------
  describe('empty requests', () => {
    it('returns zero counts when no PROPOSED/APPROVED requests exist for client', async () => {
      const client = await createClient(db);
      // No tool requests seeded
      const ai = makeAiRouter({ duplicateGroups: [], improvesExisting: [] });
      const result = await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      expect(result.requestsAnalyzed).toBe(0);
      expect(result.duplicateGroupsCount).toBe(0);
      expect(result.improvesExistingCount).toBe(0);
    });

    it('ignores REJECTED and IMPLEMENTED requests (only PROPOSED and APPROVED are analyzed)', async () => {
      const client = await createClient(db);
      await seedToolRequest(db, client.id, { requestedName: 'rejected_tool', status: 'REJECTED' });
      await seedToolRequest(db, client.id, { requestedName: 'implemented_tool', status: 'IMPLEMENTED' });

      // ai.generate should NOT be called when there are no PROPOSED/APPROVED rows
      const ai = makeAiRouter({ duplicateGroups: [], improvesExisting: [] });
      const result = await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      expect(result.requestsAnalyzed).toBe(0);
      expect((ai.generate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Result counts match model output
  // -------------------------------------------------------------------------
  describe('result counts', () => {
    it('returns correct duplicateGroupsCount and improvesExistingCount', async () => {
      const client = await createClient(db);
      const r1 = await seedToolRequest(db, client.id, { requestedName: 'tool_1' });
      const r2 = await seedToolRequest(db, client.id, { requestedName: 'tool_2' });
      const r3 = await seedToolRequest(db, client.id, { requestedName: 'tool_3' });

      const ai = makeAiRouter({
        duplicateGroups: [
          { canonicalId: r1.id, duplicateIds: [r2.id], reason: 'Same tool.' },
        ],
        improvesExisting: [
          { requestId: r3.id, existingToolName: 'existing_tool', reason: 'Enhancement.' },
        ],
      });

      const result = await runToolRequestDedupe(db, ai, client.id, FAKE_KEY, {});

      expect(result.requestsAnalyzed).toBe(3);
      expect(result.duplicateGroupsCount).toBe(1);
      expect(result.improvesExistingCount).toBe(1);
    });
  });
});
