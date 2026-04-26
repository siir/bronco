/**
 * Unit tests for ingestion-engine.ts
 *
 * Tests the pure/mockable behaviour within the ingestion pipeline:
 *   - Category validation (CATEGORIZE step)
 *   - Priority validation and fallback (TRIAGE_PRIORITY step)
 *   - Title sanitisation / length-cap (GENERATE_TITLE step)
 *   - Initial context priority mapping from numeric payloads
 *   - Operator-provided category/priority skip behaviour
 *   - Step error accumulation: failed step → fallback value, pipeline continues
 *   - safeTracker proxy: tracker method that throws → pipeline proceeds
 *   - Empty route (no steps) completes without error
 *   - Unknown step type falls through to default (logged + skipped)
 *
 * Every test in this file mocks AIRouter, BullMQ queues, and PrismaClient
 * so no real DB or LLM is contacted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '@bronco/db';

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any SUT import so Vitest can
// hoist them to the top of the transformed module.
// ---------------------------------------------------------------------------

// Shared logger mock — hoisted so the SUT and the test both reference the same
// instance, allowing assertions on logger.warn/info calls (e.g. the "not
// implemented in ingestion phase" branch).
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@bronco/shared-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bronco/shared-utils')>();
  return {
    ...actual,
    createLogger: () => mockLogger,
  };
});

import { createIngestionProcessor } from './ingestion-engine.js';
import { TicketSource, TicketCategory } from '@bronco/shared-types';

// ---------------------------------------------------------------------------
// Helpers — build minimal fakes
// ---------------------------------------------------------------------------

/** Builds a minimal mock of PrismaClient with only the methods used by the
 * ingestion pipeline.  Fields are vi.fn() stubs so tests can override them. */
function makeMockDb(overrides: Record<string, unknown> = {}): PrismaClient {
  const db = {
    client: { findUnique: vi.fn().mockResolvedValue({ id: 'client-1' }) },
    ticket: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ticket-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    ticketEvent: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    ticketRoute: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    person: { findFirst: vi.fn().mockResolvedValue(null) },
    ticketFollower: { create: vi.fn().mockResolvedValue({}) },
    ingestionRun: {
      create: vi.fn().mockResolvedValue({ id: 'run-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    ingestionRunStep: {
      create: vi.fn().mockResolvedValue({ id: 'step-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as unknown as PrismaClient;
  return db;
}

function makeMockAI(response: string = 'GENERAL') {
  return {
    generate: vi.fn().mockResolvedValue({
      content: response,
      provider: 'ollama',
      model: 'test-model',
    }),
    generateWithTools: vi.fn(),
  };
}

function makeMockQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'q-job-1', timestamp: Date.now() }),
    getJobs: vi.fn().mockResolvedValue([]),
  } as unknown as Queue<unknown>;
}

/** Builds a minimal Job wrapper around an IngestionJob payload */
function makeJob(data: Record<string, unknown>): Job<unknown> {
  return {
    id: 'test-job-1',
    data,
  } as unknown as Job<unknown>;
}

/** Builds a ResolvedRoute with the given step types */
function makeRoute(stepTypes: string[]) {
  return {
    id: 'route-1',
    name: 'Test Route',
    description: null,
    routeType: 'INGESTION',
    source: null,
    clientId: null,
    category: null,
    isActive: true,
    isDefault: false,
    sortOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    steps: stepTypes.map((type, i) => ({
      id: `step-${i}`,
      stepOrder: i + 1,
      name: type,
      stepType: type,
      taskTypeOverride: null,
      promptKeyOverride: null,
      config: null,
      isActive: true,
    })),
  };
}

// ---------------------------------------------------------------------------
// CATEGORIZE — category extraction and validation
// ---------------------------------------------------------------------------

describe('ingestion-engine: CATEGORIZE step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets ctx.category from a valid AI response', async () => {
    const db = makeMockDb();
    // The only route returned from DB is our mock route
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CATEGORIZE', 'CREATE_TICKET'])]);

    const ai = makeMockAI('DATABASE_PERF');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Database is slow' },
    }) as never);

    // Verify the ticket was created (which means CATEGORIZE ran and set a category)
    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: TicketCategory.DATABASE_PERF }),
      }),
    );
  });

  it('falls back to GENERAL for an unrecognised AI response', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CATEGORIZE', 'CREATE_TICKET'])]);

    const ai = makeMockAI('NOT_A_REAL_CATEGORY');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something weird' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: TicketCategory.GENERAL }),
      }),
    );
  });

  it('falls back to GENERAL when AI throws', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CATEGORIZE', 'CREATE_TICKET'])]);

    const ai = {
      generate: vi.fn().mockRejectedValue(new Error('Ollama offline')),
    };
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Some description' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: TicketCategory.GENERAL }),
      }),
    );
  });

  it('skips CATEGORIZE and uses payload category when operator provides a valid category', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CATEGORIZE', 'CREATE_TICKET'])]);

    const ai = makeMockAI('BUG_FIX');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something', category: 'ARCHITECTURE' },
    }) as never);

    // AI should NOT have been called for CATEGORIZE
    expect(ai.generate).not.toHaveBeenCalled();
    // Ticket created with operator-provided category
    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: 'ARCHITECTURE' }),
      }),
    );
  });

  it('trims and uppercases the AI response before checking validity', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CATEGORIZE', 'CREATE_TICKET'])]);

    // AI returns with leading/trailing whitespace and mixed case
    const ai = makeMockAI('  bug_fix  ');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Bug report' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: TicketCategory.BUG_FIX }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// TRIAGE_PRIORITY — priority extraction and validation
// ---------------------------------------------------------------------------

describe('ingestion-engine: TRIAGE_PRIORITY step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['LOW', 'LOW'],
    ['MEDIUM', 'MEDIUM'],
    ['HIGH', 'HIGH'],
    ['CRITICAL', 'CRITICAL'],
  ])('sets priority to %s from valid AI response %s', async (expected, aiResponse) => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['TRIAGE_PRIORITY', 'CREATE_TICKET'])]);

    const ai = makeMockAI(aiResponse);
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Priority test' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: expected }),
      }),
    );
  });

  it('falls back to MEDIUM for an unrecognised AI priority response', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['TRIAGE_PRIORITY', 'CREATE_TICKET'])]);

    const ai = makeMockAI('URGENT'); // not valid
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Priority test' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: 'MEDIUM' }),
      }),
    );
  });

  it('falls back to MEDIUM when AI throws', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['TRIAGE_PRIORITY', 'CREATE_TICKET'])]);

    const ai = { generate: vi.fn().mockRejectedValue(new Error('AI error')) };
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: 'MEDIUM' }),
      }),
    );
  });

  it('skips TRIAGE_PRIORITY and preserves payload priority when operator provides HIGH', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['TRIAGE_PRIORITY', 'CREATE_TICKET'])]);

    const ai = makeMockAI('LOW');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something', priority: 'HIGH' },
    }) as never);

    expect(ai.generate).not.toHaveBeenCalled();
    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: 'HIGH' }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// GENERATE_TITLE — title sanitisation and length cap
// ---------------------------------------------------------------------------

describe('ingestion-engine: GENERATE_TITLE step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips leading/trailing quotes from AI title', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['GENERATE_TITLE', 'CREATE_TICKET'])]);

    const ai = makeMockAI('"Database performance issue"');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subject: 'Database performance issue' }),
      }),
    );
  });

  it('strips "Here\'s a concise ticket title:" preamble', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['GENERATE_TITLE', 'CREATE_TICKET'])]);

    const ai = makeMockAI("Here's a concise ticket title: My Issue Title");
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subject: 'My Issue Title' }),
      }),
    );
  });

  it('strips "Title:" prefix', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['GENERATE_TITLE', 'CREATE_TICKET'])]);

    const ai = makeMockAI('Title: My Issue Title');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subject: 'My Issue Title' }),
      }),
    );
  });

  it('truncates title to 80 characters', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['GENERATE_TITLE', 'CREATE_TICKET'])]);

    const ai = makeMockAI('A'.repeat(150));
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    const createCall = (db.ticket.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.subject.length).toBeLessThanOrEqual(80);
  });

  it('keeps original title when AI returns empty string', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['GENERATE_TITLE', 'CREATE_TICKET'])]);

    const ai = makeMockAI('');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something', title: 'Original Title' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subject: 'Original Title' }),
      }),
    );
  });

  it('pipeline continues after GENERATE_TITLE failure — uses original title', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['GENERATE_TITLE', 'CREATE_TICKET'])]);

    const ai = { generate: vi.fn().mockRejectedValue(new Error('AI error')) };
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something', title: 'Fallback Title' },
    }) as never);

    // Pipeline continued — ticket was still created
    expect(db.ticket.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Numeric priority mapping (DevOps payloads)
// ---------------------------------------------------------------------------

describe('ingestion-engine: initial priority from numeric payload', () => {
  it.each([
    [1, 'CRITICAL'],
    [2, 'HIGH'],
    [3, 'MEDIUM'],
    [4, 'LOW'],
    [99, 'MEDIUM'],  // out of range → MEDIUM
  ])('maps numeric priority %d to %s', async (numericPriority, expectedPriority) => {
    const db = makeMockDb();
    // No route found → uses default fallback pipeline
    // Payload has a valid priority so TRIAGE_PRIORITY will skip (operator-provided)
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CREATE_TICKET'])]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.AZURE_DEVOPS,
      clientId: 'client-1',
      payload: { title: 'Work item', priority: numericPriority },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: expectedPriority }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// CREATE_TICKET step skipped when ticketId already set (reply path)
// ---------------------------------------------------------------------------

describe('ingestion-engine: CREATE_TICKET skip when ticket already exists', () => {
  it('does not call db.ticket.create when threadResolution.isReply is true', async () => {
    const db = makeMockDb();

    // Simulate a route with RESOLVE_THREAD + CREATE_TICKET
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['RESOLVE_THREAD', 'CREATE_TICKET'])]);

    // Simulate RESOLVE_THREAD finding an existing ticket
    (db.ticketEvent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      ticketId: 'existing-ticket-123',
    });
    // Ticket must exist and be open for re-analysis
    (db.ticket.findUnique as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue({
      status: 'NEW',
      clientId: 'client-1',
    });

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.EMAIL,
      clientId: 'client-1',
      payload: {
        inReplyTo: 'orig-message-id@example.com',
        from: 'user@example.com',
        subject: 'Re: Original Subject',
        body: 'Reply body',
        messageId: 'reply-message-id@example.com',
      },
    }) as never);

    // CREATE_TICKET should have been skipped
    expect(db.ticket.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pipeline step error accumulation — pipeline continues after step failure
// ---------------------------------------------------------------------------

describe('ingestion-engine: step error accumulation', () => {
  it('continues to CREATE_TICKET after CATEGORIZE failure', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CATEGORIZE', 'CREATE_TICKET'])]);

    const ai = { generate: vi.fn().mockRejectedValue(new Error('Categorize failed')) };
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    // Pipeline continued — ticket was still created
    expect(db.ticket.create).toHaveBeenCalled();
  });

  it('continues to CREATE_TICKET after both CATEGORIZE and TRIAGE_PRIORITY fail', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CATEGORIZE', 'TRIAGE_PRIORITY', 'CREATE_TICKET'])]);

    let callCount = 0;
    const ai = {
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject(new Error(`AI error ${callCount}`));
      }),
    };
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    // Fallbacks: GENERAL + MEDIUM
    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: TicketCategory.GENERAL,
          priority: 'MEDIUM',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// safeTracker proxy — tracker failures don't crash the pipeline
// ---------------------------------------------------------------------------

describe('ingestion-engine: safeTracker proxy', () => {
  it('proceeds when ingestionRun.create throws (tracker init failure)', async () => {
    const db = makeMockDb({
      ingestionRun: {
        create: vi.fn().mockRejectedValue(new Error('DB unavailable')),
        update: vi.fn().mockResolvedValue({}),
      },
    });
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CREATE_TICKET'])]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    // Should not throw even though tracker init failed
    await expect(
      processor(makeJob({
        source: TicketSource.MANUAL,
        clientId: 'client-1',
        payload: { description: 'Something' },
      }) as never),
    ).resolves.toBeUndefined();

    // Ticket was still created
    expect(db.ticket.create).toHaveBeenCalled();
  });

  it('proceeds when ingestionRunStep.create throws (startStep failure)', async () => {
    const db = makeMockDb({
      ingestionRunStep: {
        create: vi.fn().mockRejectedValue(new Error('DB step insert failed')),
        update: vi.fn().mockResolvedValue({}),
      },
    });
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CREATE_TICKET'])]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await expect(
      processor(makeJob({
        source: TicketSource.MANUAL,
        clientId: 'client-1',
        payload: { description: 'Something' },
      }) as never),
    ).resolves.toBeUndefined();

    expect(db.ticket.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Zero-step route falls back to built-in default pipeline
// ---------------------------------------------------------------------------

describe('ingestion-engine: zero-step route fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to built-in default pipeline when all DB routes have zero steps', async () => {
    // The route resolution logic skips routes with zero active steps and falls
    // through to null, causing the engine to use the built-in default pipeline.
    // This is the designed behavior: a zero-step route is not usable.
    const db = makeMockDb();
    // All 4 DB queries return a zero-step route → resolveIngestionRoute returns null
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute([])]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await expect(
      processor(makeJob({
        source: TicketSource.MANUAL,
        clientId: 'client-1',
        payload: { description: 'Something' },
      }) as never),
    ).resolves.toBeUndefined();

    // Built-in default includes CREATE_TICKET so a ticket IS created
    expect(db.ticket.create).toHaveBeenCalled();
  });

  it('no DB route and no-route mock → uses built-in default', async () => {
    const db = makeMockDb();
    // All DB queries return null → route falls back to built-in default
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await expect(
      processor(makeJob({
        source: TicketSource.MANUAL,
        clientId: 'client-1',
        payload: { description: 'Something' },
      }) as never),
    ).resolves.toBeUndefined();

    // Default pipeline includes CREATE_TICKET
    expect(db.ticket.create).toHaveBeenCalled();
  });

  it('emits WARN with the route id when a route has zero active steps', async () => {
    const db = makeMockDb();
    const emptyRoute = { ...makeRoute([]), id: 'empty-route-xyz', name: 'Empty Route' };
    // All four tier queries return the same empty route → cascade exhausts to null
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([emptyRoute]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    // WARN should have been emitted for each tier the empty route appeared in.
    // The mocked findMany returns the empty route on every tier query (4 total),
    // so we expect at least one WARN call referencing the route id.
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const matchingCalls = warnCalls.filter((call) => {
      const ctx = call[0] as { routeId?: string } | undefined;
      const msg = call[1] as string | undefined;
      return ctx?.routeId === 'empty-route-xyz' && typeof msg === 'string' && msg.includes('no active steps');
    });
    expect(matchingCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Within-tier preference: a non-empty route should win over an empty one with
// a lower sortOrder in the same tier (no shadowing).
// ---------------------------------------------------------------------------

describe('ingestion-engine: within-tier non-empty route preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects the non-empty route from a tier even when an empty route comes first', async () => {
    const db = makeMockDb();
    const emptyRoute = { ...makeRoute([]), id: 'empty-1', name: 'Empty', sortOrder: 1 };
    const workingRoute = {
      ...makeRoute(['CREATE_TICKET']),
      id: 'working-1',
      name: 'Working',
      sortOrder: 2,
    };

    // First (client+source) tier returns both; the resolver should skip the
    // empty one and pick the working one — no fallthrough to later tiers.
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([emptyRoute, workingRoute]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    // Ticket created via the working route's CREATE_TICKET step
    expect(db.ticket.create).toHaveBeenCalled();

    // Only one tier was queried (we returned a non-empty match) so there's
    // exactly one findMany call.
    expect(db.ticketRoute.findMany as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

    // WARN should fire for the empty route that was skipped within the tier
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const skipWarn = warnCalls.find((call) => {
      const ctx = call[0] as { routeId?: string } | undefined;
      return ctx?.routeId === 'empty-1';
    });
    expect(skipWarn).toBeDefined();
  });

  it('does not emit a WARN when the only route in a tier is non-empty', async () => {
    const db = makeMockDb();
    const workingRoute = makeRoute(['CREATE_TICKET']);

    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([workingRoute]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    expect(db.ticket.create).toHaveBeenCalled();

    // No empty route → no WARN about empty active steps
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const emptyWarn = warnCalls.find((call) => {
      const msg = call[1] as string | undefined;
      return typeof msg === 'string' && msg.includes('no active steps');
    });
    expect(emptyWarn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unknown step type falls to default (skipped, no throw)
// ---------------------------------------------------------------------------

describe('ingestion-engine: unknown step type', () => {
  it('skips unknown step type without throwing', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['UNKNOWN_FUTURE_STEP_TYPE', 'CREATE_TICKET'])]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await expect(
      processor(makeJob({
        source: TicketSource.MANUAL,
        clientId: 'client-1',
        payload: { description: 'Something' },
      }) as never),
    ).resolves.toBeUndefined();

    // Pipeline continued to CREATE_TICKET
    expect(db.ticket.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unhandled-but-known step types — analysis-phase steps that have no ingestion
// implementation must skip with a WARN log + tracker entry whose reason flags
// "not implemented in ingestion phase", NOT fall through to the unknown/default
// case path. (PR #451 — Copilot review feedback for issue #430.)
// ---------------------------------------------------------------------------

describe('ingestion-engine: unhandled-but-known step types skip with WARN + tracker entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'LOAD_CLIENT_CONTEXT',
    'LOAD_ENVIRONMENT_CONTEXT',
    'DISPATCH_TO_ROUTE',
    'NOTIFY_OPERATOR',
  ])('%s: emits logger.warn + tracker.skipStep with "not implemented in ingestion phase" reason', async (stepType) => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute([stepType, 'CREATE_TICKET'])]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    // 1. tracker.skipStep was called with status=skipped + reason matching
    //    "not implemented in ingestion phase" (skipStep updates the
    //    ingestionRunStep row to status=skipped with output=reason).
    const skipUpdateCalls = (db.ingestionRunStep.update as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => (call[0] as { data?: { status?: string } }).data?.status === 'skipped');
    expect(skipUpdateCalls.length).toBeGreaterThan(0);

    const reasonMatch = skipUpdateCalls.some((call) => {
      const data = (call[0] as { data?: { output?: string } }).data;
      return typeof data?.output === 'string' && data.output.includes('not implemented in ingestion phase');
    });
    expect(reasonMatch).toBe(true);

    // 2. logger.warn was invoked with the same "not implemented" message.
    const warnMatch = mockLogger.warn.mock.calls.some((call) => {
      // Logger calls follow Pino shape: (obj, message)
      const message = call[1];
      return typeof message === 'string' && message.includes('not implemented in ingestion phase');
    });
    expect(warnMatch).toBe(true);

    // 3. Did NOT fall through to the unknown/default case path. The default
    //    case logs "Unknown ingestion step type: <type>" — assert that
    //    message was never emitted for our known-but-unhandled step.
    const fellThroughToUnknown = mockLogger.warn.mock.calls.some((call) => {
      const message = call[1];
      return typeof message === 'string' && message.startsWith('Unknown ingestion step type:');
    });
    expect(fellThroughToUnknown).toBe(false);

    // Pipeline still continued — CREATE_TICKET ran after the skip.
    expect(db.ticket.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-existent client — processor returns early without creating ticket
// ---------------------------------------------------------------------------

describe('ingestion-engine: non-existent client', () => {
  it('returns early when client does not exist', async () => {
    const db = makeMockDb({
      client: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'nonexistent-client',
      payload: { description: 'Something' },
    }) as never);

    expect(db.ticket.create).not.toHaveBeenCalled();
    expect(ticketCreatedQueue.add).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADD_FOLLOWER step skip when no ticket created yet
// ---------------------------------------------------------------------------

describe('ingestion-engine: ADD_FOLLOWER step', () => {
  it('skips ADD_FOLLOWER when no ticket has been created', async () => {
    const db = makeMockDb();
    // Route with ADD_FOLLOWER first (no CREATE_TICKET before it)
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['ADD_FOLLOWER'])]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    expect(db.ticketFollower.create).not.toHaveBeenCalled();
  });

  it('adds follower by email after CREATE_TICKET', async () => {
    const db = makeMockDb();
    // Explicit route with config on the ADD_FOLLOWER step
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{
      id: 'route-1',
      name: 'Test Route',
      description: null,
      routeType: 'INGESTION',
      source: null,
      clientId: null,
      category: null,
      isActive: true,
      isDefault: false,
      sortOrder: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      steps: [
        { id: 'step-0', stepOrder: 1, name: 'CREATE_TICKET', stepType: 'CREATE_TICKET', taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 'step-1', stepOrder: 2, name: 'ADD_FOLLOWER', stepType: 'ADD_FOLLOWER', taskTypeOverride: null, promptKeyOverride: null, config: { email: 'follower@example.com', followerType: 'FOLLOWER' }, isActive: true },
      ],
    }]);

    (db.person.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'person-1' });

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    expect(db.ticketFollower.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          personId: 'person-1',
          followerType: 'FOLLOWER',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Context accumulation — summary flows into subsequent steps
// ---------------------------------------------------------------------------

describe('ingestion-engine: context accumulation', () => {
  it('uses summary from SUMMARIZE_EMAIL in CATEGORIZE prompt', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['SUMMARIZE_EMAIL', 'CATEGORIZE', 'CREATE_TICKET'])]);

    let callOrder: string[] = [];
    const ai = {
      generate: vi.fn().mockImplementation((params: { taskType: string; prompt: string }) => {
        callOrder.push(params.taskType);
        if (params.taskType === 'SUMMARIZE') {
          return Promise.resolve({ content: 'Email summary text', provider: 'ollama', model: 'test' });
        }
        // For CATEGORIZE — check that the summary text appears in the prompt
        if (params.taskType === 'CATEGORIZE') {
          if (!params.prompt.includes('Email summary text')) {
            return Promise.reject(new Error('CATEGORIZE prompt did not include summary'));
          }
          return Promise.resolve({ content: 'BUG_FIX', provider: 'ollama', model: 'test' });
        }
        return Promise.resolve({ content: '', provider: 'ollama', model: 'test' });
      }),
    };

    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.EMAIL,
      clientId: 'client-1',
      payload: { subject: 'Bug report', body: 'Some body text' },
    }) as never);

    expect(callOrder).toEqual(['SUMMARIZE', 'CATEGORIZE']);
    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: TicketCategory.BUG_FIX }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// ticket-created queue is enqueued after successful CREATE_TICKET
// ---------------------------------------------------------------------------

describe('ingestion-engine: ticket-created queue enqueue', () => {
  it('adds to ticketCreatedQueue after successful ticket creation', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CREATE_TICKET'])]);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something', title: 'My Title' },
    }) as never);

    expect(ticketCreatedQueue.add).toHaveBeenCalledWith(
      'ticket-created',
      expect.objectContaining({ ticketId: 'ticket-1', clientId: 'client-1' }),
      expect.objectContaining({ jobId: 'ticket-created-ticket-1' }),
    );
  });

  it('does NOT add to ticketCreatedQueue when no CREATE_TICKET step', async () => {
    const db = makeMockDb();
    (db.ticketRoute.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeRoute(['CATEGORIZE'])]);

    const ai = makeMockAI('BUG_FIX');
    const ticketCreatedQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor(makeJob({
      source: TicketSource.MANUAL,
      clientId: 'client-1',
      payload: { description: 'Something' },
    }) as never);

    expect(ticketCreatedQueue.add).not.toHaveBeenCalled();
  });
});
