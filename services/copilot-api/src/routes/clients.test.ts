/**
 * Unit tests for clients routes.
 * Uses Fastify inject() with a mocked PrismaClient — no real DB or queues.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { buildTestRouteApp, makeAdminUser, makeScopedUser } from '../test/app-builder.js';
import { clientRoutes } from './clients.js';

// ─── Mock db factory ───────────────────────────────────────────────────────────

function makeMockDb(overrides: Partial<Record<string, unknown>> = {}): PrismaClient {
  const client = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  };

  const invoice = {
    aggregate: vi.fn().mockResolvedValue({ _sum: { totalBilledCostUsd: null } }),
  };

  const operatorClient = {
    findMany: vi.fn().mockResolvedValue([]),
  };

  return {
    client,
    invoice,
    operatorClient,
    ...overrides,
  } as unknown as PrismaClient;
}

function makeClientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'client-1',
    name: 'Acme Corp',
    shortCode: 'ACM',
    isActive: true,
    isInternal: false,
    notes: null,
    domainMappings: [],
    _count: { tickets: 0, systems: 0 },
    ...overrides,
  };
}

// ─── GET /api/search/clients ──────────────────────────────────────────────────

describe('GET /api/search/clients', () => {
  it('returns 400 when q is missing', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/clients' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when q is 1 character', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/clients?q=a' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when limit exceeds 50', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/clients?q=ac&limit=51' });
    expect(res.statusCode).toBe(400);
  });

  it('returns search results for valid q', async () => {
    const db = makeMockDb();
    (db.client.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'client-1', name: 'Acme Corp', shortCode: 'ACM', isActive: true },
    ]);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/clients?q=ac' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].shortCode).toBe('ACM');
  });

  it('scoped operator sees only their client in search', async () => {
    const db = makeMockDb();
    (db.client.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(clientRoutes);

    await app.inject({ method: 'GET', url: '/api/search/clients?q=ac' });

    const call = (db.client.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // scope filter for single client maps to { id: 'client-a' }
    expect(call.where.id).toBe('client-a');
  });
});

// ─── GET /api/clients ─────────────────────────────────────────────────────────

describe('GET /api/clients', () => {
  it('returns 200 with empty array when no clients exist', async () => {
    const db = makeMockDb();
    (db.client.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('scoped operator sees only their client', async () => {
    const db = makeMockDb();
    (db.client.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(clientRoutes);

    await app.inject({ method: 'GET', url: '/api/clients' });

    const call = (db.client.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.id).toBe('client-a');
  });

  it('admin sees all non-internal clients', async () => {
    const db = makeMockDb();
    (db.client.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeClientRow()]);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
  });
});

// ─── GET /api/clients/:id ─────────────────────────────────────────────────────

describe('GET /api/clients/:id', () => {
  it('returns 404 when client does not exist', async () => {
    const db = makeMockDb();
    (db.client.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/clients/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('returns client with invoicedTotalUsd', async () => {
    const db = makeMockDb();
    (db.client.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...makeClientRow(),
      clientUsers: [],
      systems: [],
      _count: { tickets: 2, systems: 0, codeRepos: 0, integrations: 0, clientMemories: 0, environments: 0, clientUsers: 0, invoices: 1 },
    });
    (db.invoice.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _sum: { totalBilledCostUsd: 150.0 } });
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/clients/client-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.invoicedTotalUsd).toBe(150.0);
  });

  it('returns invoicedTotalUsd as 0 when no invoices', async () => {
    const db = makeMockDb();
    (db.client.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...makeClientRow(),
      clientUsers: [],
      systems: [],
      _count: { tickets: 0, systems: 0, codeRepos: 0, integrations: 0, clientMemories: 0, environments: 0, clientUsers: 0, invoices: 0 },
    });
    (db.invoice.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _sum: { totalBilledCostUsd: null } });
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/clients/client-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.invoicedTotalUsd).toBe(0);
  });
});

// ─── POST /api/clients ────────────────────────────────────────────────────────

describe('POST /api/clients', () => {
  it('creates a client and returns 201', async () => {
    const newClient = { id: 'client-new', name: 'New Corp', shortCode: 'NEW', isInternal: false, isActive: true };
    const db = makeMockDb();
    (db.client.create as ReturnType<typeof vi.fn>).mockResolvedValue(newClient);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      payload: { name: 'New Corp', shortCode: 'NEW' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.shortCode).toBe('NEW');
  });

  it('returns 400 for invalid domain mapping format', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      payload: { name: 'Corp', shortCode: 'CRP', domainMappings: ['not_a_domain!!!'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts valid domain mappings', async () => {
    const db = makeMockDb();
    (db.client.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c-1', name: 'Corp', shortCode: 'CRP', domainMappings: ['example.com'] });
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      payload: { name: 'Corp', shortCode: 'CRP', domainMappings: ['example.com'] },
    });
    expect(res.statusCode).toBe(201);
    const call = (db.client.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.domainMappings).toEqual(['example.com']);
  });
});

// ─── PATCH /api/clients/:id ───────────────────────────────────────────────────

describe('PATCH /api/clients/:id', () => {
  it('returns 400 for invalid aiMode', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { aiMode: 'INVALID_MODE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid billingPeriod', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { billingPeriod: 'quarterly' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid billingAnchorDay (0)', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { billingAnchorDay: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid billingAnchorDay (> 28)', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { billingAnchorDay: 29 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid billingMarkupPercent (below 1.0)', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { billingMarkupPercent: 0.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid billingMarkupPercent (above 10.0)', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { billingMarkupPercent: 11.0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid notificationMode', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { notificationMode: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when portal user tries to set notificationMode', async () => {
    const db = makeMockDb();
    // portalUser only — no operator user
    const app = await buildTestRouteApp({
      db,
      portalUser: { personId: 'p-1', clientUserId: 'cu-1', clientId: 'client-1', email: 'u@x.com', name: 'Portal User', userType: 'USER' as never },
    });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { notificationMode: 'operator' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('updates client and returns updated record', async () => {
    const updated = makeClientRow({ name: 'Acme Updated', isActive: false });
    const db = makeMockDb();
    (db.client.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { name: 'Acme Updated', isActive: false },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Acme Updated');
  });

  it('accepts valid billingAnchorDay on boundary (1)', async () => {
    const db = makeMockDb();
    (db.client.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeClientRow());
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { billingAnchorDay: 1 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts valid billingAnchorDay on boundary (28)', async () => {
    const db = makeMockDb();
    (db.client.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeClientRow());
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/clients/client-1',
      payload: { billingAnchorDay: 28 },
    });
    expect(res.statusCode).toBe(200);
  });
});
