/**
 * Unit tests for tickets routes.
 * Uses Fastify inject() with a mocked PrismaClient — no real DB or queues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { buildTestRouteApp, makeAdminUser, makeScopedUser } from '../test/app-builder.js';
import { ticketRoutes } from './tickets.js';

// ─── Mock db factory ───────────────────────────────────────────────────────────

function makeMockDb(overrides: Partial<Record<keyof PrismaClient, unknown>> = {}): PrismaClient {
  const ticket = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
  };

  const ticketEvent = {
    create: vi.fn().mockResolvedValue({ id: 'evt-1', ticketId: 't-1', eventType: 'SYSTEM_NOTE', content: null, metadata: null, actor: null, createdAt: new Date() }),
    update: vi.fn().mockResolvedValue(null),
  };

  const person = {
    findFirst: vi.fn().mockResolvedValue(null),
  };

  const clientEnvironment = {
    findUnique: vi.fn().mockResolvedValue(null),
  };

  const operator = {
    findUnique: vi.fn().mockResolvedValue(null),
  };

  const appLog = {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  };

  const aiUsageLog = {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
  };

  const appSetting = {
    findUnique: vi.fn().mockResolvedValue(null),
  };

  return {
    ticket,
    ticketEvent,
    person,
    clientEnvironment,
    operator,
    appLog,
    aiUsageLog,
    appSetting,
    $queryRaw: vi.fn().mockResolvedValue([{ start_ms: null, end_ms: null, input_tokens: null, output_tokens: null }]),
    ...overrides,
  } as unknown as PrismaClient;
}

// ─── Ticket list ──────────────────────────────────────────────────────────────

describe('GET /api/tickets', () => {
  it('returns 200 with an empty array when no tickets exist', async () => {
    const db = makeMockDb();
    (db.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('returns 400 for invalid status filter', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets?status=NOT_A_STATUS' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid priority filter', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets?priority=BOGUS' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid source filter', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets?source=NONSENSE' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for negative limit', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets?limit=-1' });
    expect(res.statusCode).toBe(400);
  });

  it('accepts comma-separated status filter', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets?status=NEW,OPEN' });
    expect(res.statusCode).toBe(200);
    // Verify findMany was called with an 'in' filter
    const call = (db.ticket.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ['NEW', 'OPEN'] });
  });

  it('scoped operator (single) sees only their client tickets', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(ticketRoutes);

    await app.inject({ method: 'GET', url: '/api/tickets' });

    const call = (db.ticket.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.clientId).toBe('client-a');
  });

  it('scoped operator requesting out-of-scope clientId returns empty array', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets?clientId=client-b' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
    // findMany should NOT have been called because we returned early
    expect((db.ticket.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

// ─── GET /api/tickets/:id ─────────────────────────────────────────────────────

describe('GET /api/tickets/:id', () => {
  it('returns 404 when ticket does not exist', async () => {
    const db = makeMockDb();
    (db.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets/nonexistent-id' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with ticket data when found', async () => {
    const mockTicket = {
      id: 'ticket-1',
      subject: 'Test ticket',
      status: 'NEW',
      priority: 'MEDIUM',
      clientId: 'client-1',
      client: { name: 'Acme', shortCode: 'ACM' },
      system: null,
      followers: [],
      events: [],
      artifacts: [],
    };
    const db = makeMockDb();
    (db.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(mockTicket);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets/ticket-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('ticket-1');
    expect(body.subject).toBe('Test ticket');
  });
});

// ─── POST /api/tickets ────────────────────────────────────────────────────────

describe('POST /api/tickets (sync=true)', () => {
  it('creates a ticket in sync mode and returns 201', async () => {
    const newTicket = {
      id: 'ticket-new',
      clientId: 'client-1',
      subject: 'New ticket',
      status: 'NEW',
      priority: 'MEDIUM',
      ticketNumber: 1,
      source: 'MANUAL',
    };
    const db = makeMockDb();
    (db.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null); // no last ticket
    (db.ticket.create as ReturnType<typeof vi.fn>).mockResolvedValue(newTicket);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets?sync=true',
      payload: { clientId: 'client-1', subject: 'New ticket' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('ticket-new');
  });

  it('returns 400 for invalid priority on POST', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets?sync=true',
      payload: { clientId: 'client-1', subject: 'Test', priority: 'BOGUS' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when scoped operator creates ticket for out-of-scope client', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets?sync=true',
      payload: { clientId: 'client-b', subject: 'Forbidden ticket' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('enqueues job in async mode (no ?sync=true) and returns 202', async () => {
    const db = makeMockDb();
    const mockQueue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes, { ingestQueue: mockQueue as never });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { clientId: 'client-1', subject: 'Async ticket' },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ queued: true });
    expect(mockQueue.add).toHaveBeenCalledOnce();
  });
});

// ─── PATCH /api/tickets/:id ───────────────────────────────────────────────────

describe('PATCH /api/tickets/:id', () => {
  it('returns 404 when ticket not found', async () => {
    const db = makeMockDb();
    (db.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/tickets/nonexistent',
      payload: { status: 'OPEN' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid status value', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/tickets/ticket-1',
      payload: { status: 'NOT_REAL' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('updates ticket status and returns updated ticket', async () => {
    const existing = { status: 'NEW', clientId: 'client-1', assignedOperatorId: null };
    const updated = { id: 'ticket-1', status: 'OPEN', priority: 'HIGH', clientId: 'client-1' };
    const db = makeMockDb();
    (db.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    (db.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/tickets/ticket-1',
      payload: { status: 'OPEN' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('OPEN');
  });

  it('enqueues log summarization on status change', async () => {
    const existing = { status: 'NEW', clientId: 'client-1', assignedOperatorId: null };
    const updated = { id: 'ticket-1', status: 'OPEN', clientId: 'client-1' };
    const db = makeMockDb();
    (db.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    (db.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    const logQueue = { add: vi.fn().mockResolvedValue({}) };
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes, { logSummarizeQueue: logQueue as never });

    await app.inject({
      method: 'PATCH',
      url: '/api/tickets/ticket-1',
      payload: { status: 'OPEN' },
    });
    expect(logQueue.add).toHaveBeenCalledOnce();
  });
});

// ─── GET /api/tickets/stats ───────────────────────────────────────────────────

describe('GET /api/tickets/stats', () => {
  it('returns aggregate stats shape', async () => {
    const db = makeMockDb();
    (db.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (db.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      { status: 'NEW', _count: 3 },
      { status: 'OPEN', _count: 2 },
    ]);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/tickets/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('byStatus');
    expect(body).toHaveProperty('byPriority');
    expect(body).toHaveProperty('byCategory');
    expect(body).toHaveProperty('bySource');
  });
});

// ─── GET /api/search/tickets ──────────────────────────────────────────────────

describe('GET /api/search/tickets', () => {
  it('returns 400 when q is missing', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/tickets' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when q is 1 character', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/tickets?q=a' });
    expect(res.statusCode).toBe(400);
  });

  it('returns search results for valid q', async () => {
    const mockResults = [
      { id: 't-1', ticketNumber: 1, subject: 'slow query', status: 'OPEN', priority: 'HIGH', clientId: 'c-1', createdAt: new Date(), client: { name: 'Acme', shortCode: 'ACM' } },
    ];
    const db = makeMockDb();
    (db.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/tickets?q=slow' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it('returns 400 when limit is > 50', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/tickets?q=test&limit=51' });
    expect(res.statusCode).toBe(400);
  });
});

// ─── POST /api/tickets/:id/events ─────────────────────────────────────────────

describe('POST /api/tickets/:id/events', () => {
  it('returns 400 for invalid eventType', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets/ticket-1/events',
      payload: { eventType: 'INVALID_EVENT', content: 'test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when ticket not in scope', async () => {
    const db = makeMockDb();
    (db.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets/nonexistent/events',
      payload: { eventType: 'COMMENT', content: 'test note' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates event and returns 201 when ticket exists', async () => {
    const mockEvent = { id: 'evt-1', ticketId: 'ticket-1', eventType: 'COMMENT', content: 'test', actor: null, metadata: null, createdAt: new Date() };
    const db = makeMockDb();
    (db.ticket.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ticket-1' });
    (db.ticketEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockEvent);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(ticketRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets/ticket-1/events',
      payload: { eventType: 'COMMENT', content: 'test note' },
    });
    expect(res.statusCode).toBe(201);
  });
});
