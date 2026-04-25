/**
 * Integration tests for the kd_* write path:
 *   - updateSection (replace / append)
 *   - addSubsection
 *   - withTicketLock advisory-lock serialisation
 *
 * Requires TEST_DATABASE_URL pointing at a real Postgres instance that has
 * been migrated with the Bronco schema (bronco_test DB on the local Docker container).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import {
  updateSection,
  addSubsection,
  loadKnowledgeDoc,
  KnowledgeDocError,
  readSection,
  initEmptyKnowledgeDoc,
} from '@bronco/shared-utils';
import { getTestDb, truncateAll } from './db.js';
import { createClient, createTicket } from './fixtures.js';

// ---------------------------------------------------------------------------
// Skip the whole suite when no real DB is available (unit-test runs).
// ---------------------------------------------------------------------------
const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

describe.skipIf(!hasDb)('integration: knowledge-doc write path', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  // -------------------------------------------------------------------------
  // 1. Single updateSection(replace) — correct content, meta, roundtrip
  // -------------------------------------------------------------------------
  describe('updateSection — basic replace', () => {
    it('writes content, updates sectionMeta length/updatedAt, and roundtrip holds', async () => {
      const client = await createClient(db, { name: 'Roundtrip Corp' });
      const ticket = await createTicket(db, { clientId: client.id });

      const body = 'CPU spike observed at 14:00 UTC.';
      const result = await updateSection(db, ticket.id, 'problemStatement', body, 'replace');

      expect(result.content).toBe(body);
      expect(result.length).toBe(body.length);
      expect(result.updatedAt).toBeTruthy();

      // Verify persisted state via loadKnowledgeDoc
      const loaded = await loadKnowledgeDoc(db, ticket.id);
      expect(loaded).not.toBeNull();

      // Parse the doc and read the section
      const sectionRead = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'problemStatement');
      expect(sectionRead.content).toBe(body);
      expect(sectionRead.length).toBe(body.length);

      // Sidecar meta
      const meta = loaded!.knowledgeDocSectionMeta as Record<string, { length: number; updatedAt: string }>;
      expect(meta['problemStatement']).toBeDefined();
      expect(meta['problemStatement'].length).toBe(body.length);
      expect(meta['problemStatement'].updatedAt).toBe(result.updatedAt);
    });

    it('second replace overwrites first — meta.length matches new content', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await updateSection(db, ticket.id, 'rootCause', 'First write.', 'replace');
      const second = 'Deadlock on orders table.';
      await updateSection(db, ticket.id, 'rootCause', second, 'replace');

      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const sectionRead = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'rootCause');
      expect(sectionRead.content).toBe(second);

      const meta = loaded!.knowledgeDocSectionMeta as Record<string, { length: number }>;
      expect(meta['rootCause'].length).toBe(second.length);
    });
  });

  // -------------------------------------------------------------------------
  // 1b. updateSection — APPEND mode
  // -------------------------------------------------------------------------
  describe('updateSection — append mode', () => {
    it('appends to existing content with double newline separator', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await updateSection(db, ticket.id, 'runLog', 'Step 1 complete.', 'replace');
      await updateSection(db, ticket.id, 'runLog', 'Step 2 complete.', 'append');

      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const sectionRead = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'runLog');
      expect(sectionRead.content).toBe('Step 1 complete.\n\nStep 2 complete.');
    });

    it('append on empty section behaves like replace (no leading newline)', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await updateSection(db, ticket.id, 'runLog', 'Only entry.', 'append');

      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const sectionRead = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'runLog');
      expect(sectionRead.content).toBe('Only entry.');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Concurrent updateSection on SAME ticket — serialization
  // -------------------------------------------------------------------------
  describe('concurrency — same ticket', () => {
    it('two concurrent REPLACE writes on the same section: second writer wins, meta is consistent', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const contentA = 'Writer A root cause.';
      const contentB = 'Writer B root cause.';

      // Launch both simultaneously — the advisory lock must serialize them.
      const [, ] = await Promise.all([
        updateSection(db, ticket.id, 'rootCause', contentA, 'replace'),
        updateSection(db, ticket.id, 'rootCause', contentB, 'replace'),
      ]);

      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const sectionRead = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'rootCause');

      // Final content must be exactly one of the two writers (no torn write).
      expect([contentA, contentB]).toContain(sectionRead.content);

      // Meta length must be consistent with whichever content won.
      const meta = loaded!.knowledgeDocSectionMeta as Record<string, { length: number }>;
      expect(meta['rootCause'].length).toBe(sectionRead.content.length);
    });

    it('two concurrent writes on DIFFERENT sections: both updates present in final doc', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const bodyA = 'Problem: slow queries.';
      const bodyB = 'Root cause: missing index.';

      await Promise.all([
        updateSection(db, ticket.id, 'problemStatement', bodyA, 'replace'),
        updateSection(db, ticket.id, 'rootCause', bodyB, 'replace'),
      ]);

      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const psRead = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'problemStatement');
      const rcRead = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'rootCause');

      expect(psRead.content).toBe(bodyA);
      expect(rcRead.content).toBe(bodyB);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Concurrent updateSection on DIFFERENT tickets — no mutual blocking
  // -------------------------------------------------------------------------
  describe('concurrency — different tickets', () => {
    it('writes to two distinct tickets both complete without clobbering each other', async () => {
      const client = await createClient(db);
      const ticketA = await createTicket(db, { clientId: client.id });
      const ticketB = await createTicket(db, { clientId: client.id });

      const bodyA = 'Ticket A evidence.';
      const bodyB = 'Ticket B evidence.';

      await Promise.all([
        updateSection(db, ticketA.id, 'evidence', bodyA, 'replace'),
        updateSection(db, ticketB.id, 'evidence', bodyB, 'replace'),
      ]);

      const [loadedA, loadedB] = await Promise.all([
        loadKnowledgeDoc(db, ticketA.id),
        loadKnowledgeDoc(db, ticketB.id),
      ]);

      const readA = readSection(loadedA!.knowledgeDoc, loadedA!.knowledgeDocSectionMeta, 'evidence');
      const readB = readSection(loadedB!.knowledgeDoc, loadedB!.knowledgeDocSectionMeta, 'evidence');

      expect(readA.content).toBe(bodyA);
      expect(readB.content).toBe(bodyB);
    });
  });

  // -------------------------------------------------------------------------
  // 4. addSubsection — permitted parent creates ### child
  // -------------------------------------------------------------------------
  describe('addSubsection — permitted parents', () => {
    it('adds a subsection under evidence with correct key and content', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const result = await addSubsection(db, ticket.id, 'evidence', 'Query Plan Analysis', 'SELECT * FROM orders...');

      expect(result.sectionKey).toBe('evidence.query-plan-analysis');
      expect(result.title).toBe('Query Plan Analysis');
      expect(result.content).toBe('SELECT * FROM orders...');
      expect(result.length).toBe('SELECT * FROM orders...'.length);

      // Confirm it round-trips through the doc
      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const sectionRead = readSection(
        loaded!.knowledgeDoc,
        loaded!.knowledgeDocSectionMeta,
        'evidence.query-plan-analysis',
      );
      expect(sectionRead.content).toBe('SELECT * FROM orders...');
    });

    it('adds subsections under hypotheses', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const result = await addSubsection(db, ticket.id, 'hypotheses', 'Index Fragmentation', 'Index may be > 80% fragmented.');

      expect(result.sectionKey).toBe('hypotheses.index-fragmentation');
      expect(result.title).toBe('Index Fragmentation');
    });

    it('adds subsections under openQuestions', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const result = await addSubsection(db, ticket.id, 'openQuestions', 'Repro Steps', 'Can the user reproduce consistently?');

      expect(result.sectionKey).toBe('openQuestions.repro-steps');
      expect(result.title).toBe('Repro Steps');
    });

    it('deduplicates slug when same title added twice', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const first = await addSubsection(db, ticket.id, 'evidence', 'Finding', 'First finding.');
      const second = await addSubsection(db, ticket.id, 'evidence', 'Finding', 'Second finding.');

      expect(first.sectionKey).toBe('evidence.finding');
      expect(second.sectionKey).toBe('evidence.finding-2');

      // Both survive in the doc
      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const r1 = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'evidence.finding');
      const r2 = readSection(loaded!.knowledgeDoc, loaded!.knowledgeDocSectionMeta, 'evidence.finding-2');
      expect(r1.content).toBe('First finding.');
      expect(r2.content).toBe('Second finding.');
    });

    it('updates parent sectionMeta.updatedAt when subsection is added', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const result = await addSubsection(db, ticket.id, 'evidence', 'Sub One', 'body');

      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const meta = loaded!.knowledgeDocSectionMeta as Record<string, { updatedAt: string }>;
      expect(meta['evidence']).toBeDefined();
      expect(meta['evidence'].updatedAt).toBe(result.updatedAt);
    });
  });

  // -------------------------------------------------------------------------
  // 5. addSubsection — non-permitted parent throws INVALID_PARENT
  // -------------------------------------------------------------------------
  describe('addSubsection — non-permitted parent', () => {
    it('throws INVALID_PARENT for environment', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await expect(
        addSubsection(db, ticket.id, 'environment', 'My Sub', 'content'),
      ).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    });

    it('throws INVALID_PARENT for problemStatement', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await expect(
        addSubsection(db, ticket.id, 'problemStatement', 'My Sub', 'content'),
      ).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    });

    it('throws INVALID_PARENT for rootCause', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await expect(
        addSubsection(db, ticket.id, 'rootCause', 'My Sub', 'content'),
      ).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    });
  });

  // -------------------------------------------------------------------------
  // 6. 10,000-char cap on updateSection
  // -------------------------------------------------------------------------
  describe('updateSection — 10,000-char cap', () => {
    it('content of exactly 10,000 chars is accepted', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const exactContent = 'x'.repeat(10000);
      const result = await updateSection(db, ticket.id, 'evidence', exactContent, 'replace');
      expect(result.length).toBe(10000);
    });

    it('content of 10,001 chars throws SECTION_TOO_LONG', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      const oversized = 'x'.repeat(10001);
      await expect(
        updateSection(db, ticket.id, 'evidence', oversized, 'replace'),
      ).rejects.toMatchObject({ code: 'SECTION_TOO_LONG' });
    });

    it('append that pushes total over 10,000 chars throws SECTION_TOO_LONG', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      // Write 9,000 chars first
      await updateSection(db, ticket.id, 'evidence', 'y'.repeat(9000), 'replace');

      // Appending 1,001 chars (9000 + \n\n separator ≈ 10003) should throw
      await expect(
        updateSection(db, ticket.id, 'evidence', 'z'.repeat(1001), 'append'),
      ).rejects.toMatchObject({ code: 'SECTION_TOO_LONG' });
    });
  });

  // -------------------------------------------------------------------------
  // 7. Invalid sectionKey throws INVALID_SECTION_KEY
  // -------------------------------------------------------------------------
  describe('updateSection — invalid sectionKey', () => {
    it('completely unknown key throws INVALID_SECTION_KEY', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await expect(
        updateSection(db, ticket.id, 'nonExistentKey', 'content', 'replace'),
      ).rejects.toMatchObject({ code: 'INVALID_SECTION_KEY' });
    });

    it('dotted subsection key passed to updateSection throws INVALID_SECTION_KEY', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await expect(
        updateSection(db, ticket.id, 'evidence.some-sub', 'content', 'replace'),
      ).rejects.toMatchObject({ code: 'INVALID_SECTION_KEY' });
    });
  });

  // -------------------------------------------------------------------------
  // 8. updatedByRunId is persisted in sectionMeta when provided
  // -------------------------------------------------------------------------
  describe('updateSection — optional updatedByRunId', () => {
    it('persists updatedByRunId in sectionMeta', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await updateSection(db, ticket.id, 'runLog', 'Log entry.', 'replace', { updatedByRunId: 'run-abc-123' });

      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const meta = loaded!.knowledgeDocSectionMeta as Record<string, { updatedByRunId?: string }>;
      expect(meta['runLog'].updatedByRunId).toBe('run-abc-123');
    });
  });

  // -------------------------------------------------------------------------
  // 9. All 9 template sections survive a full compose/parse roundtrip
  // -------------------------------------------------------------------------
  describe('compose/parse roundtrip', () => {
    it('all 9 template sections are present after writing to several', async () => {
      const client = await createClient(db);
      const ticket = await createTicket(db, { clientId: client.id });

      await updateSection(db, ticket.id, 'problemStatement', 'PS content', 'replace');
      await updateSection(db, ticket.id, 'rootCause', 'RC content', 'replace');
      await updateSection(db, ticket.id, 'recommendedFix', 'RF content', 'replace');

      const loaded = await loadKnowledgeDoc(db, ticket.id);
      const doc = loaded!.knowledgeDoc!;

      // All 9 top-level headers must be present
      const expectedTitles = [
        'Problem Statement',
        'Environment',
        'Evidence',
        'Hypotheses',
        'Root Cause',
        'Recommended Fix',
        'Risks',
        'Open Questions',
        'Run Log',
      ];
      for (const title of expectedTitles) {
        expect(doc).toContain(`## ${title}`);
      }

      // Written sections have the right content
      expect(doc).toContain('PS content');
      expect(doc).toContain('RC content');
      expect(doc).toContain('RF content');
    });
  });
});
