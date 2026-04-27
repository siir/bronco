/**
 * Unit tests for people routes.
 * Uses Fastify inject() with a mocked PrismaClient — no real DB or queues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { buildTestRouteApp, makeAdminUser, makeScopedUser } from '../test/app-builder.js';
import { peopleRoutes } from './people.js';

// ─── Mock db factory ───────────────────────────────────────────────────────────

function makeMockDb(overrides: Partial<Record<string, unknown>> = {}): PrismaClient {
  const clientUser = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(null),
  };

  const person = {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  };

  const personRefreshToken = {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };

  const operatorClient = {
    findMany: vi.fn().mockResolvedValue([]),
  };

  return {
    clientUser,
    person,
    personRefreshToken,
    operatorClient,
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      person: { create: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue(null) },
      clientUser: { create: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue(null), delete: vi.fn().mockResolvedValue(null) },
      personRefreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    })),
    ...overrides,
  } as unknown as PrismaClient;
}

/** Helper to build a full ClientUser row as returned by formatPerson */
function makeClientUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cu-1',
    clientId: 'client-1',
    userType: 'USER',
    isPrimary: true,
    lastLoginAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    person: {
      id: 'person-1',
      name: 'Alice Test',
      email: 'alice@example.com',
      phone: null,
      isActive: true,
      passwordHash: null,
    },
    client: { name: 'Acme', shortCode: 'ACM' },
    ...overrides,
  };
}

// ─── GET /api/search/people ────────────────────────────────────────────────────

describe('GET /api/search/people', () => {
  it('returns 400 when q is missing', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/people' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when q is 1 character', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/people?q=a' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when limit is > 50', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/people?q=alice&limit=51' });
    expect(res.statusCode).toBe(400);
  });

  it('returns search results for valid q', async () => {
    const db = makeMockDb();
    (db.clientUser.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'cu-1',
        clientId: 'client-1',
        userType: 'USER',
        isPrimary: true,
        person: { id: 'person-1', name: 'Alice Test', email: 'alice@example.com', isActive: true },
        client: { name: 'Acme', shortCode: 'ACM' },
      },
    ]);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search/people?q=alice' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ name: 'Alice Test', email: 'alice@example.com' });
  });

  it('scoped operator sees only their client results', async () => {
    const db = makeMockDb();
    (db.clientUser.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(peopleRoutes);

    await app.inject({ method: 'GET', url: '/api/search/people?q=alice' });

    const call = (db.clientUser.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.clientId).toBe('client-a');
  });
});

// ─── GET /api/people ──────────────────────────────────────────────────────────

describe('GET /api/people', () => {
  it('returns 200 with empty array when no people exist', async () => {
    const db = makeMockDb();
    (db.clientUser.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/people' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('returns 403 when scoped operator requests out-of-scope clientId', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/people?clientId=client-b' });
    expect(res.statusCode).toBe(403);
  });

  it('returns list of people with hasPortalAccess derived from passwordHash', async () => {
    const db = makeMockDb();
    const rows = [
      makeClientUserRow({ person: { id: 'p1', name: 'A', email: 'a@x.com', phone: null, isActive: true, passwordHash: 'hash123' } }),
      makeClientUserRow({ id: 'cu-2', person: { id: 'p2', name: 'B', email: 'b@x.com', phone: null, isActive: true, passwordHash: null } }),
    ];
    (db.clientUser.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/people' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body[0].hasPortalAccess).toBe(true);
    expect(body[1].hasPortalAccess).toBe(false);
    // Raw hash must not be in response
    expect(JSON.stringify(body)).not.toContain('hash123');
  });

  it('scoped operator sees only their client', async () => {
    const db = makeMockDb();
    (db.clientUser.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(peopleRoutes);

    await app.inject({ method: 'GET', url: '/api/people' });

    const call = (db.clientUser.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.clientId).toBe('client-a');
  });
});

// ─── GET /api/people/:id ──────────────────────────────────────────────────────

describe('GET /api/people/:id', () => {
  it('returns 404 when person does not exist', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/people/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('returns person with hasPortalAccess derived', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeClientUserRow({
      person: { id: 'person-1', name: 'Alice', email: 'alice@x.com', phone: null, isActive: true, passwordHash: 'somehash' },
    }));
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/people/person-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasPortalAccess).toBe(true);
    expect(body).not.toHaveProperty('passwordHash');
  });

  it('returns 403 when person belongs to out-of-scope client', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeClientUserRow({ clientId: 'client-b' }),
    );
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/people/person-1' });
    expect(res.statusCode).toBe(403);
  });
});

// ─── POST /api/people ─────────────────────────────────────────────────────────

describe('POST /api/people', () => {
  it('returns 400 when required fields are missing', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people',
      payload: { name: 'Alice' }, // missing clientId and email
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when password is shorter than 8 characters', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people',
      payload: { clientId: 'client-1', name: 'Alice', email: 'alice@x.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when scoped operator creates person for out-of-scope client', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people',
      payload: { clientId: 'client-b', name: 'Alice', email: 'alice@x.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 409 when person email already linked to this client', async () => {
    const db = makeMockDb();
    (db.person.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'person-1',
      clientUsers: [{ clientId: 'client-1' }],
    });
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people',
      payload: { clientId: 'client-1', name: 'Alice', email: 'alice@x.com' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('creates person and returns 201 with hasPortalAccess', async () => {
    const db = makeMockDb();
    (db.person.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const createdCu = makeClientUserRow({
      person: { id: 'new-p', name: 'Alice', email: 'alice@x.com', phone: null, isActive: true, passwordHash: null },
    });
    (db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        person: { create: vi.fn().mockResolvedValue({ id: 'new-p' }) },
        clientUser: { create: vi.fn().mockResolvedValue(createdCu) },
      };
      return fn(tx);
    });

    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people',
      payload: { clientId: 'client-1', name: 'Alice', email: 'alice@x.com' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.hasPortalAccess).toBe(false);
  });
});

// ─── PATCH /api/people/:id ────────────────────────────────────────────────────

describe('PATCH /api/people/:id', () => {
  it('returns 404 when person not found', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/people/nonexistent',
      payload: { name: 'Bob' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when password is too short', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/people/person-1',
      payload: { password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when person is in out-of-scope client', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeClientUserRow({ clientId: 'client-b' }),
    );
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/people/person-1',
      payload: { name: 'Bob' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('updates person and returns updated shape', async () => {
    const existingCu = makeClientUserRow();
    const updatedCu = makeClientUserRow({ person: { id: 'person-1', name: 'Bob Updated', email: 'alice@x.com', phone: null, isActive: true, passwordHash: null } });
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(existingCu);
    (db.person.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null); // no operator
    (db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        person: { update: vi.fn().mockResolvedValue(null) },
        clientUser: { update: vi.fn().mockResolvedValue(updatedCu) },
      };
      return fn(tx);
    });

    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/people/person-1',
      payload: { name: 'Bob Updated' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Bob Updated');
  });
});

// ─── DELETE /api/people/:id ───────────────────────────────────────────────────

describe('DELETE /api/people/:id', () => {
  it('returns 404 when person not found', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'DELETE', url: '/api/people/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when person is in out-of-scope client', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'cu-1', clientId: 'client-b' });
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'DELETE', url: '/api/people/person-1' });
    expect(res.statusCode).toBe(403);
  });

  it('deletes person and returns success message', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'cu-1', clientId: 'client-1' });
    (db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        personRefreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        clientUser: { delete: vi.fn().mockResolvedValue(null) },
        person: {
          findUnique: vi.fn().mockResolvedValue({
            operator: null,
            _count: { clientUsers: 0 },
          }),
          update: vi.fn().mockResolvedValue(null),
        },
      };
      return fn(tx);
    });

    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({ method: 'DELETE', url: '/api/people/person-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/removed/i);
  });
});

// ─── POST /api/people/:id/reset-password ─────────────────────────────────────

describe('POST /api/people/:id/reset-password', () => {
  it('returns 400 when password is too short', async () => {
    const db = makeMockDb();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people/person-1/reset-password',
      payload: { password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when person not found', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people/nonexistent/reset-password',
      payload: { password: 'validpassword123' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when person is out-of-scope', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ clientId: 'client-b' });
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people/person-1/reset-password',
      payload: { password: 'validpassword123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('resets password and returns success for admin', async () => {
    const db = makeMockDb();
    (db.clientUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ clientId: 'client-1' });
    (db.person.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ operator: null, clientUsers: [{ clientId: 'client-1' }] });
    (db.person.update as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(peopleRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/people/person-1/reset-password',
      payload: { password: 'newvalidpassword' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/reset/i);
    expect((db.person.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toHaveProperty('passwordHash');
  });
});
