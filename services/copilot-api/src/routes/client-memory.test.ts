/**
 * Unit tests for client-memory routes.
 * Uses Fastify inject() with a mocked PrismaClient — no real DB or queues.
 * Verifies ClientMemoryResolver.invalidate() is called on create/update/delete.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import type { ClientMemoryResolver } from '@bronco/ai-provider';
import { buildTestRouteApp, makeAdminUser, makeScopedUser } from '../test/app-builder.js';
import { clientMemoryRoutes } from './client-memory.js';

// ─── Mock factory helpers ─────────────────────────────────────────────────────

function makeMockDb(overrides: Partial<Record<string, unknown>> = {}): PrismaClient {
  const clientMemory = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(null),
  };

  const operatorClient = {
    findMany: vi.fn().mockResolvedValue([]),
  };

  return {
    clientMemory,
    operatorClient,
    ...overrides,
  } as unknown as PrismaClient;
}

function makeMockResolver(): ClientMemoryResolver {
  return {
    invalidate: vi.fn(),
    resolve: vi.fn().mockResolvedValue({ markdown: '', count: 0 }),
  } as unknown as ClientMemoryResolver;
}

function makeMemoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    clientId: 'client-1',
    title: 'Test Playbook',
    memoryType: 'PLAYBOOK',
    category: null,
    tags: [],
    content: 'Step 1: do the thing',
    sortOrder: 0,
    source: 'MANUAL',
    isActive: true,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    client: { id: 'client-1', name: 'Acme', shortCode: 'ACM' },
    ...overrides,
  };
}

// ─── GET /api/client-memory ───────────────────────────────────────────────────

describe('GET /api/client-memory', () => {
  it('returns 200 with empty array when no entries exist', async () => {
    const db = makeMockDb();
    (db.clientMemory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'GET', url: '/api/client-memory' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('returns 400 for invalid category filter', async () => {
    const db = makeMockDb();
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'GET', url: '/api/client-memory?category=INVALID' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid memoryType filter', async () => {
    const db = makeMockDb();
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'GET', url: '/api/client-memory?memoryType=INVALID' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid isActive filter', async () => {
    const db = makeMockDb();
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'GET', url: '/api/client-memory?isActive=maybe' });
    expect(res.statusCode).toBe(400);
  });

  it('scoped operator sees only their client memories', async () => {
    const db = makeMockDb();
    (db.clientMemory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    await app.inject({ method: 'GET', url: '/api/client-memory' });

    const call = (db.clientMemory.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.clientId).toBe('client-a');
  });

  it('filters by clientId if provided and in scope', async () => {
    const db = makeMockDb();
    (db.clientMemory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeMemoryRow()]);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    await app.inject({ method: 'GET', url: '/api/client-memory?clientId=client-1' });

    const call = (db.clientMemory.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.clientId).toBe('client-1');
  });
});

// ─── GET /api/client-memory/:id ──────────────────────────────────────────────

describe('GET /api/client-memory/:id', () => {
  it('returns 404 when entry not found', async () => {
    const db = makeMockDb();
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'GET', url: '/api/client-memory/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('returns memory entry when found', async () => {
    const db = makeMockDb();
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemoryRow());
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'GET', url: '/api/client-memory/mem-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('mem-1');
    expect(body.title).toBe('Test Playbook');
  });
});

// ─── POST /api/client-memory ──────────────────────────────────────────────────

describe('POST /api/client-memory', () => {
  it('returns 400 when required fields missing', async () => {
    const db = makeMockDb();
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'POST',
      url: '/api/client-memory',
      payload: { clientId: 'client-1', title: 'Test' }, // missing content
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid memoryType', async () => {
    const db = makeMockDb();
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'POST',
      url: '/api/client-memory',
      payload: { clientId: 'client-1', title: 'Test', content: 'Content', memoryType: 'INVALID_TYPE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid category', async () => {
    const db = makeMockDb();
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'POST',
      url: '/api/client-memory',
      payload: { clientId: 'client-1', title: 'Test', content: 'Content', memoryType: 'CONTEXT', category: 'NOT_A_CATEGORY' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when scoped operator creates memory for out-of-scope client', async () => {
    const db = makeMockDb();
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'POST',
      url: '/api/client-memory',
      payload: { clientId: 'client-b', title: 'Test', content: 'Content', memoryType: 'CONTEXT' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates memory entry, returns 201, and calls resolver.invalidate()', async () => {
    const created = makeMemoryRow();
    const db = makeMockDb();
    (db.clientMemory.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'POST',
      url: '/api/client-memory',
      payload: { clientId: 'client-1', title: 'Test Playbook', content: 'Step 1', memoryType: 'PLAYBOOK' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('mem-1');
    // Cache invalidation must be called with the clientId
    expect(resolver.invalidate).toHaveBeenCalledWith('client-1');
  });
});

// ─── PATCH /api/client-memory/:id ────────────────────────────────────────────

describe('PATCH /api/client-memory/:id', () => {
  it('returns 404 when entry not found or out of scope', async () => {
    const db = makeMockDb();
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/client-memory/nonexistent',
      payload: { title: 'Updated' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid memoryType in update', async () => {
    const db = makeMockDb();
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem-1' });
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/client-memory/mem-1',
      payload: { memoryType: 'INVALID_TYPE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when title is set to empty string', async () => {
    const db = makeMockDb();
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem-1' });
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/client-memory/mem-1',
      payload: { title: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('updates entry and calls resolver.invalidate()', async () => {
    const updated = makeMemoryRow({ title: 'Updated Title' });
    const db = makeMockDb();
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem-1' });
    (db.clientMemory.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/client-memory/mem-1',
      payload: { title: 'Updated Title' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe('Updated Title');
    expect(resolver.invalidate).toHaveBeenCalledWith('client-1');
  });
});

// ─── DELETE /api/client-memory/:id ───────────────────────────────────────────

describe('DELETE /api/client-memory/:id', () => {
  it('returns 404 when entry not found', async () => {
    const db = makeMockDb();
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'DELETE', url: '/api/client-memory/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('deletes entry, returns 204, and calls resolver.invalidate()', async () => {
    const db = makeMockDb();
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemoryRow());
    (db.clientMemory.delete as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'DELETE', url: '/api/client-memory/mem-1' });
    expect(res.statusCode).toBe(204);
    expect(resolver.invalidate).toHaveBeenCalledWith('client-1');
  });

  it('scoped operator cannot delete entry from out-of-scope client', async () => {
    const db = makeMockDb();
    // findFirst with scopeToWhere will return null because the row is scoped
    (db.clientMemory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const resolver = makeMockResolver();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(clientMemoryRoutes, { clientMemoryResolver: resolver });

    const res = await app.inject({ method: 'DELETE', url: '/api/client-memory/mem-other' });
    expect(res.statusCode).toBe(404);
    expect(resolver.invalidate).not.toHaveBeenCalled();
  });
});
