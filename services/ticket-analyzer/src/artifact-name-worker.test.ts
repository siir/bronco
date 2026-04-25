/**
 * Unit tests for services/ticket-analyzer/src/artifact-name-worker.ts
 *
 * Mocks @bronco/shared-utils (createLogger), node:fs/promises (open),
 * and constructs in-memory PrismaClient + AIRouter doubles to exercise
 * the processor returned by createArtifactNameProcessor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock shared-utils so module-level createLogger() in SUT doesn't blow up.
// ---------------------------------------------------------------------------
vi.mock('@bronco/shared-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bronco/shared-utils')>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock node:fs/promises#open so we don't touch the real disk. The processor
// only calls open(...).read(...).close().
// ---------------------------------------------------------------------------
const fhRead = vi.fn();
const fhClose = vi.fn();
const open = vi.fn();
vi.mock('node:fs/promises', () => ({
  open: (...args: unknown[]) => open(...args),
}));

import { createArtifactNameProcessor } from './artifact-name-worker.js';

// ---------------------------------------------------------------------------
// Helpers — minimal Prisma + AIRouter doubles
// ---------------------------------------------------------------------------
type ArtifactRow = {
  id: string;
  ticketId: string;
  kind: string | null;
  displayName: string | null;
  filename: string;
  storagePath: string | null;
  sizeBytes: number;
  source: string | null;
  ticket: { clientId: string | null };
};

interface DbDouble {
  artifact: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}
interface AiDouble {
  generate: ReturnType<typeof vi.fn>;
}

function makeDb(): DbDouble {
  return {
    artifact: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
}

function makeAi(): AiDouble {
  return { generate: vi.fn() };
}

function eligibleArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: 'art-1',
    ticketId: 'tkt-1',
    kind: 'PROBE_RESULT',
    displayName: 'Probe: dm_exec_requests',
    filename: 'probe-1.json',
    storagePath: 'tickets/tkt-1/probe-1.json',
    sizeBytes: 1234,
    source: 'probe:dm_exec_requests',
    ticket: { clientId: 'client-1' },
    ...overrides,
  };
}

function setupOpenStub(content = '{"foo":"bar"}'): void {
  fhRead.mockReset();
  fhClose.mockReset();
  open.mockReset();
  open.mockImplementation(async () => ({
    read: fhRead.mockImplementation(async (buf: Buffer) => {
      const bytes = Buffer.from(content, 'utf-8');
      bytes.copy(buf);
      return { bytesRead: bytes.length, buffer: buf };
    }),
    close: fhClose.mockResolvedValue(undefined),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Skip when ineligible
// ---------------------------------------------------------------------------
describe('createArtifactNameProcessor — ineligibility', () => {
  it('skips when artifact.kind is EMAIL_ATTACHMENT (not in ELIGIBLE_KINDS)', async () => {
    const db = makeDb();
    const ai = makeAi();
    db.artifact.findUnique.mockResolvedValueOnce(
      eligibleArtifact({ kind: 'EMAIL_ATTACHMENT' }),
    );
    const processor = createArtifactNameProcessor({
      db: db as unknown as Parameters<typeof createArtifactNameProcessor>[0]['db'],
      ai: ai as unknown as Parameters<typeof createArtifactNameProcessor>[0]['ai'],
      artifactStoragePath: '/tmp/storage',
    });

    await processor({ data: { artifactId: 'art-1' } });

    expect(ai.generate).not.toHaveBeenCalled();
    expect(db.artifact.update).not.toHaveBeenCalled();
  });

  it('skips when displayName is non-templated (e.g. "My uploaded file.pdf")', async () => {
    const db = makeDb();
    const ai = makeAi();
    db.artifact.findUnique.mockResolvedValueOnce(
      eligibleArtifact({ displayName: 'My uploaded file.pdf' }),
    );
    const processor = createArtifactNameProcessor({
      db: db as unknown as Parameters<typeof createArtifactNameProcessor>[0]['db'],
      ai: ai as unknown as Parameters<typeof createArtifactNameProcessor>[0]['ai'],
      artifactStoragePath: '/tmp/storage',
    });

    await processor({ data: { artifactId: 'art-1' } });

    expect(ai.generate).not.toHaveBeenCalled();
    expect(db.artifact.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Strict JSON parsing
// ---------------------------------------------------------------------------
describe('createArtifactNameProcessor — strict JSON parsing', () => {
  it('updates the row given a clean JSON response', async () => {
    setupOpenStub('{"some":"preview"}');
    const db = makeDb();
    const ai = makeAi();
    db.artifact.findUnique
      .mockResolvedValueOnce(eligibleArtifact()) // initial load
      .mockResolvedValueOnce({ displayName: 'Probe: dm_exec_requests' }); // re-check
    ai.generate.mockResolvedValueOnce({
      content: '{"displayName":"Active query snapshot","description":"Snapshot of currently-running SQL queries from sys.dm_exec_requests."}',
    });
    db.artifact.update.mockResolvedValueOnce({});

    const processor = createArtifactNameProcessor({
      db: db as unknown as Parameters<typeof createArtifactNameProcessor>[0]['db'],
      ai: ai as unknown as Parameters<typeof createArtifactNameProcessor>[0]['ai'],
      artifactStoragePath: '/tmp/storage',
    });

    await processor({ data: { artifactId: 'art-1' } });

    expect(ai.generate).toHaveBeenCalledTimes(1);
    expect(db.artifact.update).toHaveBeenCalledTimes(1);
    expect(db.artifact.update).toHaveBeenCalledWith({
      where: { id: 'art-1' },
      data: {
        displayName: 'Active query snapshot',
        description: 'Snapshot of currently-running SQL queries from sys.dm_exec_requests.',
      },
    });
  });

  it('does NOT update the row given non-JSON garbage', async () => {
    setupOpenStub();
    const db = makeDb();
    const ai = makeAi();
    db.artifact.findUnique.mockResolvedValueOnce(eligibleArtifact());
    ai.generate.mockResolvedValueOnce({ content: 'this is not json at all' });

    const processor = createArtifactNameProcessor({
      db: db as unknown as Parameters<typeof createArtifactNameProcessor>[0]['db'],
      ai: ai as unknown as Parameters<typeof createArtifactNameProcessor>[0]['ai'],
      artifactStoragePath: '/tmp/storage',
    });

    await processor({ data: { artifactId: 'art-1' } });

    expect(ai.generate).toHaveBeenCalledTimes(1);
    expect(db.artifact.update).not.toHaveBeenCalled();
  });

  it('handles fenced ```json blocks by stripping fences before parsing', async () => {
    setupOpenStub();
    const db = makeDb();
    const ai = makeAi();
    db.artifact.findUnique
      .mockResolvedValueOnce(eligibleArtifact())
      .mockResolvedValueOnce({ displayName: 'Probe: dm_exec_requests' });
    ai.generate.mockResolvedValueOnce({
      content: '```json\n{"displayName":"Q snapshot","description":"A description."}\n```',
    });
    db.artifact.update.mockResolvedValueOnce({});

    const processor = createArtifactNameProcessor({
      db: db as unknown as Parameters<typeof createArtifactNameProcessor>[0]['db'],
      ai: ai as unknown as Parameters<typeof createArtifactNameProcessor>[0]['ai'],
      artifactStoragePath: '/tmp/storage',
    });

    await processor({ data: { artifactId: 'art-1' } });

    // Fenced JSON is currently accepted by the parser, so update IS called.
    expect(db.artifact.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. No-clobber on stale read
// ---------------------------------------------------------------------------
describe('createArtifactNameProcessor — no-clobber on stale read', () => {
  it('skips update if displayName changed during generation', async () => {
    setupOpenStub();
    const db = makeDb();
    const ai = makeAi();
    db.artifact.findUnique
      .mockResolvedValueOnce(eligibleArtifact()) // initial load — templated
      .mockResolvedValueOnce({ displayName: 'Operator-renamed thing' }); // re-check — operator edited
    ai.generate.mockResolvedValueOnce({
      content: '{"displayName":"AI Name","description":"AI desc."}',
    });

    const processor = createArtifactNameProcessor({
      db: db as unknown as Parameters<typeof createArtifactNameProcessor>[0]['db'],
      ai: ai as unknown as Parameters<typeof createArtifactNameProcessor>[0]['ai'],
      artifactStoragePath: '/tmp/storage',
    });

    await processor({ data: { artifactId: 'art-1' } });

    expect(ai.generate).toHaveBeenCalledTimes(1);
    expect(db.artifact.update).not.toHaveBeenCalled();
  });
});
