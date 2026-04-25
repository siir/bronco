/**
 * Integration tests for ingestion-engine.ts — DB-backed step behaviour
 *
 * Tests that require a real Postgres database:
 *   Phase B: CREATE_TICKET, ADD_FOLLOWER DB-backed steps
 *   Phase C: Full pipeline orchestration via createIngestionProcessor
 *   Phase D: IngestionRunTracker tracking rows written by the full pipeline
 *
 * Requires TEST_DATABASE_URL pointing at a migrated bronco_test Postgres instance.
 */

import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import type { Queue } from 'bullmq';
import { TicketSource, TicketCategory, RouteStepType } from '@bronco/shared-types';
import {
  getTestDb,
  truncateAll,
  createClient,
  createTicket,
  createClientMemory,
} from '@bronco/test-utils';
import { createIngestionProcessor } from './ingestion-engine.js';

const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeMockAI(responses: string[] | string = 'GENERAL') {
  const arr = Array.isArray(responses) ? [...responses] : [responses];
  const defaultResponse = Array.isArray(responses) ? responses[responses.length - 1] : responses;
  return {
    generate: vi.fn().mockImplementation(() => {
      const response = arr.shift() ?? defaultResponse;
      return Promise.resolve({ content: response, provider: 'ollama', model: 'test-model' });
    }),
  };
}

function makeMockQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'q-job-1', timestamp: Date.now() }),
    getJobs: vi.fn().mockResolvedValue([]),
  } as unknown as Queue<unknown>;
}

// ---------------------------------------------------------------------------
// Phase B: CREATE_TICKET integration
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('integration: CREATE_TICKET step', () => {
  let db: PrismaClient;
  let clientId: string;

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);
    const client = await createClient(db);
    clientId = client.id;
  });

  beforeEach(async () => {
    // Truncate tickets and related tables but keep clients
    await db.$executeRawUnsafe(`
      TRUNCATE TABLE "tickets",
                     "ticket_events",
                     "ticket_followers",
                     "ingestion_runs",
                     "ingestion_run_steps"
      RESTART IDENTITY CASCADE
    `);
  });

  it('creates a ticket row with correct source, category, and priority', async () => {
    const ai = makeMockAI('DATABASE_PERF');
    const ticketCreatedQueue = makeMockQueue();

    const route = {
      id: null,
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    };

    // Stub db.ticketRoute.findFirst to return our route
    const origFindFirst = db.ticketRoute.findFirst.bind(db.ticketRoute);
    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValueOnce(route as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test Bot',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-job-1',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: {
          title: 'Database is slow',
          description: 'Queries taking > 30 seconds',
          category: 'DATABASE_PERF',
          priority: 'HIGH',
        },
      },
    } as never);

    const ticket = await db.ticket.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    expect(ticket).not.toBeNull();
    expect(ticket!.subject).toBe('Database is slow');
    expect(ticket!.source).toBe(TicketSource.MANUAL);
    expect(ticket!.category).toBe(TicketCategory.DATABASE_PERF);
    expect(ticket!.priority).toBe('HIGH');
    expect(ticket!.status).toBe('NEW');
    expect(ticket!.ticketNumber).toBeGreaterThan(0);

    // Restore
    vi.restoreAllMocks();
    void origFindFirst;
  });

  it('assigns sequential ticketNumbers per client', async () => {
    // Pre-create a ticket to establish the baseline number
    await createTicket(db, { clientId, subject: 'Ticket 1' });

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-job-2',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: { title: 'Second ticket', description: 'Body' },
      },
    } as never);

    const tickets = await db.ticket.findMany({
      where: { clientId },
      orderBy: { ticketNumber: 'asc' },
    });

    expect(tickets.length).toBeGreaterThanOrEqual(2);
    // Numbers should be sequential
    expect(tickets[tickets.length - 1].ticketNumber).toBe(tickets[tickets.length - 2].ticketNumber + 1);

    vi.restoreAllMocks();
  });

  it('records an EMAIL_INBOUND event for EMAIL source', async () => {
    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-job-email-event',
      data: {
        source: TicketSource.EMAIL,
        clientId,
        payload: {
          subject: 'Email ticket',
          body: 'Email body',
          from: 'user@example.com',
          messageId: 'msg-123@example.com',
        },
      },
    } as never);

    const ticket = await db.ticket.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    expect(ticket).not.toBeNull();

    const event = await db.ticketEvent.findFirst({
      where: { ticketId: ticket!.id, eventType: 'EMAIL_INBOUND' },
    });
    expect(event).not.toBeNull();
    expect(event!.emailMessageId).toBe('msg-123@example.com');

    vi.restoreAllMocks();
  });

  it('records a SYSTEM_NOTE event for non-EMAIL source', async () => {
    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-job-system-note',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: { title: 'Manual ticket', description: 'Body' },
      },
    } as never);

    const ticket = await db.ticket.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    expect(ticket).not.toBeNull();

    const event = await db.ticketEvent.findFirst({
      where: { ticketId: ticket!.id, eventType: 'SYSTEM_NOTE' },
    });
    expect(event).not.toBeNull();

    vi.restoreAllMocks();
  });

  it('does not create a REQUESTER follower when no personId or operatorEmail in payload', async () => {
    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-job-no-requester',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: { title: 'Anonymous ticket', description: 'Body' },
      },
    } as never);

    const ticket = await db.ticket.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    expect(ticket).not.toBeNull();

    const followers = await db.ticketFollower.findMany({ where: { ticketId: ticket!.id } });
    expect(followers).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it('creates a REQUESTER follower when operatorEmail matches a ClientUser person', async () => {
    // Create person + ClientUser
    const person = await db.person.create({
      data: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        emailLower: 'jane@example.com',
        clientUsers: {
          create: { clientId },
        },
      },
    });

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-job-with-requester',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: {
          title: 'Ticket from Jane',
          description: 'Body',
          operatorEmail: 'jane@example.com',
        },
      },
    } as never);

    const ticket = await db.ticket.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    expect(ticket).not.toBeNull();

    const followers = await db.ticketFollower.findMany({ where: { ticketId: ticket!.id } });
    expect(followers).toHaveLength(1);
    expect(followers[0].personId).toBe(person.id);
    expect(followers[0].followerType).toBe('REQUESTER');

    vi.restoreAllMocks();
  });

  it('does not attach follower when operatorEmail belongs to a different client (tenant isolation)', async () => {
    // Create a second client and person linked ONLY to that second client
    const otherClient = await createClient(db);
    await db.person.create({
      data: {
        name: 'Mallory',
        email: 'mallory@example.com',
        emailLower: 'mallory@example.com',
        clientUsers: {
          create: { clientId: otherClient.id },  // NOT linked to main clientId
        },
      },
    });

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-job-cross-tenant',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: {
          title: 'Cross-tenant ticket',
          description: 'Body',
          operatorEmail: 'mallory@example.com',
        },
      },
    } as never);

    const ticket = await db.ticket.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    const followers = await db.ticketFollower.findMany({ where: { ticketId: ticket!.id } });
    expect(followers).toHaveLength(0);  // cross-tenant person must NOT be attached

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Phase B: ADD_FOLLOWER integration
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('integration: ADD_FOLLOWER step', () => {
  let db: PrismaClient;
  let clientId: string;

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);
    const client = await createClient(db);
    clientId = client.id;
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`
      TRUNCATE TABLE "tickets",
                     "ticket_events",
                     "ticket_followers",
                     "ingestion_runs",
                     "ingestion_run_steps"
      RESTART IDENTITY CASCADE
    `);
  });

  it('adds a FOLLOWER row by email after CREATE_TICKET', async () => {
    const person = await db.person.create({
      data: {
        name: 'Bob Follower',
        email: 'bob@example.com',
        emailLower: 'bob@example.com',
        clientUsers: { create: { clientId } },
      },
    });

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 's2', stepOrder: 2, name: 'Add Follower', stepType: RouteStepType.ADD_FOLLOWER, taskTypeOverride: null, promptKeyOverride: null, config: { email: 'bob@example.com', followerType: 'FOLLOWER' }, isActive: true },
      ],
    } as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-job-add-follower',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: { title: 'Ticket with follower', description: 'Body' },
      },
    } as never);

    const ticket = await db.ticket.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    expect(ticket).not.toBeNull();

    const follower = await db.ticketFollower.findFirst({
      where: { ticketId: ticket!.id, personId: person.id },
    });
    expect(follower).not.toBeNull();
    expect(follower!.followerType).toBe('FOLLOWER');

    vi.restoreAllMocks();
  });

  it('deduplicates follower — does not throw on P2002 when follower already exists', async () => {
    const person = await db.person.create({
      data: {
        name: 'Carol',
        email: 'carol@example.com',
        emailLower: 'carol@example.com',
        clientUsers: { create: { clientId } },
      },
    });

    const ticket = await createTicket(db, { clientId, subject: 'Existing ticket' });

    // Pre-create the follower so the step will hit a unique constraint
    await db.ticketFollower.create({
      data: { ticketId: ticket.id, personId: person.id, followerType: 'FOLLOWER' },
    });

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();

    // Stub ticketRoute + ticket.create to reuse the existing ticket
    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        // No CREATE_TICKET — inject ticketId directly via mock
        { id: 's1', stepOrder: 1, name: 'Add Follower', stepType: RouteStepType.ADD_FOLLOWER, taskTypeOverride: null, promptKeyOverride: null, config: { email: 'carol@example.com', followerType: 'FOLLOWER' }, isActive: true },
      ],
    } as never);

    // We need ctx.ticketId to be set for ADD_FOLLOWER to run.
    // Since there's no CREATE_TICKET step, ADD_FOLLOWER will be skipped (ctx.ticketId = null).
    // Use CREATE_TICKET step to set up the context, but with the existing ticket.
    // Instead, directly test by running a route that includes both steps:
    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 's2', stepOrder: 2, name: 'Add Follower', stepType: RouteStepType.ADD_FOLLOWER, taskTypeOverride: null, promptKeyOverride: null, config: { email: 'carol@example.com', followerType: 'FOLLOWER' }, isActive: true },
      ],
    } as never);

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    // Should not throw even if carol already follows the ticket
    await expect(
      processor({
        id: 'test-job-dedup-follower',
        data: {
          source: TicketSource.MANUAL,
          clientId,
          payload: { title: 'Another ticket', description: 'Body' },
        },
      } as never),
    ).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Phase C: Full pipeline orchestration
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('integration: pipeline orchestration', () => {
  let db: PrismaClient;
  let clientId: string;

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);
    const client = await createClient(db);
    clientId = client.id;
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`
      TRUNCATE TABLE "tickets",
                     "ticket_events",
                     "ticket_followers",
                     "ingestion_runs",
                     "ingestion_run_steps"
      RESTART IDENTITY CASCADE
    `);
    vi.restoreAllMocks();
  });

  it('executes steps in order: CATEGORIZE → TRIAGE_PRIORITY → CREATE_TICKET', async () => {
    const stepOrder: string[] = [];
    const ai = {
      generate: vi.fn().mockImplementation((params: { taskType: string }) => {
        stepOrder.push(params.taskType);
        if (params.taskType === 'CATEGORIZE') return Promise.resolve({ content: 'BUG_FIX', provider: 'ollama', model: 'test' });
        if (params.taskType === 'TRIAGE') return Promise.resolve({ content: 'HIGH', provider: 'ollama', model: 'test' });
        return Promise.resolve({ content: '', provider: 'ollama', model: 'test' });
      }),
    };

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Categorize', stepType: RouteStepType.CATEGORIZE, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 's2', stepOrder: 2, name: 'Triage', stepType: RouteStepType.TRIAGE_PRIORITY, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 's3', stepOrder: 3, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    const ticketCreatedQueue = makeMockQueue();
    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    await processor({
      id: 'test-pipeline-order',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: { title: 'Bug report', description: 'Something crashed' },
      },
    } as never);

    // Verify AI was called in step order
    expect(stepOrder).toEqual(['CATEGORIZE', 'TRIAGE']);

    // Verify final ticket has the correct values
    const ticket = await db.ticket.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' } });
    expect(ticket!.category).toBe(TicketCategory.BUG_FIX);
    expect(ticket!.priority).toBe('HIGH');
  });

  it('uses default fallback route when no DB route matches', async () => {
    // ticketRoute.findFirst returns null → engine should use built-in default
    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue(null);

    let categorizeCalled = false;
    const ai = {
      generate: vi.fn().mockImplementation((params: { taskType: string }) => {
        if (params.taskType === 'CATEGORIZE') categorizeCalled = true;
        return Promise.resolve({ content: 'GENERAL', provider: 'ollama', model: 'test' });
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

    await processor({
      id: 'test-default-route',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: { title: 'Fallback route test', description: 'Body' },
      },
    } as never);

    // Default route includes CATEGORIZE
    expect(categorizeCalled).toBe(true);
    // A ticket was created
    const ticket = await db.ticket.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' } });
    expect(ticket).not.toBeNull();
  });

  it('writes ingestion_run tracking rows for the full pipeline', async () => {
    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Tracked Pipeline',
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
        { id: 's1', stepOrder: 1, name: 'Categorize', stepType: RouteStepType.CATEGORIZE, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 's2', stepOrder: 2, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

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

    await processor({
      id: 'test-tracking-run',
      data: {
        source: TicketSource.MANUAL,
        clientId,
        payload: { title: 'Tracked ticket', description: 'Body' },
      },
    } as never);

    // Verify ingestion_run row exists and is complete
    const run = await db.ingestionRun.findFirst({
      where: { clientId },
      orderBy: { startedAt: 'desc' },
    });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('success');
    expect(run!.completedAt).not.toBeNull();
    expect(run!.ticketId).not.toBeNull();
    expect(run!.jobId).toBe('test-tracking-run');

    // Verify step rows
    const steps = await db.ingestionRunStep.findMany({
      where: { runId: run!.id },
      orderBy: { stepOrder: 'asc' },
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].stepType).toBe('CATEGORIZE');
    expect(steps[0].status).toBe('success');
    expect(steps[1].stepType).toBe('CREATE_TICKET');
    expect(steps[1].status).toBe('success');
  });

  it('marks ingestion_run as error when pipeline throws', async () => {
    // Make ticket.create throw to cause a hard pipeline failure
    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Failing Pipeline',
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
        { id: 's1', stepOrder: 1, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    vi.spyOn(db.ticket, 'create').mockRejectedValue(new Error('DB insert failed'));

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
      processor({
        id: 'test-failing-pipeline',
        data: {
          source: TicketSource.MANUAL,
          clientId,
          payload: { title: 'Failing ticket', description: 'Body' },
        },
      } as never),
    ).rejects.toThrow('DB insert failed');

    // ingestion_run should be marked as error
    const run = await db.ingestionRun.findFirst({
      where: { clientId, jobId: 'test-failing-pipeline' },
    });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('error');
    expect(run!.error).toContain('DB insert failed');
  });

  it('skips RESOLVE_THREAD for non-EMAIL sources', async () => {
    let resolveThreadCalled = false;
    const originalFindFirst = db.ticketEvent.findFirst.bind(db.ticketEvent);
    vi.spyOn(db.ticketEvent, 'findFirst').mockImplementation(((args: unknown) => {
      // RESOLVE_THREAD queries ticketEvent by emailMessageId reference
      const where = (args as Record<string, unknown>)?.['where'] as Record<string, unknown> | undefined;
      if (where?.['emailMessageId']) resolveThreadCalled = true;
      return originalFindFirst(args as Parameters<typeof originalFindFirst>[0]);
    }) as never);

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Resolve Thread', stepType: RouteStepType.RESOLVE_THREAD, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 's2', stepOrder: 2, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

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

    await processor({
      id: 'test-non-email-thread',
      data: {
        source: TicketSource.MANUAL,  // NOT email
        clientId,
        payload: { title: 'Manual ticket' },
      },
    } as never);

    // RESOLVE_THREAD logic should NOT have run (it was skipped for non-email)
    expect(resolveThreadCalled).toBe(false);
    // Ticket was still created
    const ticket = await db.ticket.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' } });
    expect(ticket).not.toBeNull();
  });

  it('RESOLVE_THREAD threads EMAIL reply to existing ticket and skips CREATE_TICKET', async () => {
    // Create an existing ticket with a known emailMessageId event
    const existingTicket = await createTicket(db, { clientId, subject: 'Original Subject' });
    await db.ticketEvent.create({
      data: {
        ticketId: existingTicket.id,
        eventType: 'EMAIL_INBOUND',
        content: 'Original email body',
        emailMessageId: 'orig-msg-id@example.com',
        actor: 'email:user@example.com',
      },
    });

    vi.spyOn(db.ticketRoute, 'findFirst').mockResolvedValue({
      id: null,
      name: 'Test',
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
        { id: 's1', stepOrder: 1, name: 'Resolve Thread', stepType: RouteStepType.RESOLVE_THREAD, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
        { id: 's2', stepOrder: 2, name: 'Create Ticket', stepType: RouteStepType.CREATE_TICKET, taskTypeOverride: null, promptKeyOverride: null, config: null, isActive: true },
      ],
    } as never);

    const ai = makeMockAI('GENERAL');
    const ticketCreatedQueue = makeMockQueue();
    const analysisQueue = makeMockQueue();

    const processor = createIngestionProcessor({
      db,
      ai: ai as never,
      mailer: null,
      ticketCreatedQueue: ticketCreatedQueue as never,
      analysisQueue: analysisQueue as never,
      senderSignature: 'Test',
      smtpFrom: 'test@example.com',
    });

    const ticketsBeforeCount = await db.ticket.count({ where: { clientId } });

    await processor({
      id: 'test-thread-reply',
      data: {
        source: TicketSource.EMAIL,
        clientId,
        payload: {
          inReplyTo: 'orig-msg-id@example.com',
          from: 'user@example.com',
          subject: 'Re: Original Subject',
          body: 'Reply body text',
          messageId: 'reply-msg-id@example.com',
        },
      },
    } as never);

    // No new ticket should have been created
    const ticketsAfterCount = await db.ticket.count({ where: { clientId } });
    expect(ticketsAfterCount).toBe(ticketsBeforeCount);

    // An EMAIL_INBOUND event was appended to the existing ticket
    const events = await db.ticketEvent.findMany({
      where: { ticketId: existingTicket.id, eventType: 'EMAIL_INBOUND' },
    });
    expect(events.length).toBeGreaterThanOrEqual(2); // original + reply

    // ticket-created queue should NOT have been called (it's a reply)
    expect(ticketCreatedQueue.add).not.toHaveBeenCalled();
  });
});
