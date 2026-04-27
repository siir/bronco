/**
 * Minimal Fastify app builder for unit tests.
 *
 * Registers only the plugins needed for a specific route plugin — skips
 * Redis queues, AI router, and other heavy dependencies unless provided.
 * The caller injects a mock `db` and optionally a mock `user` (for auth
 * scope testing).
 *
 * Usage:
 *   const app = await buildTestRouteApp({ db: mockDb, user: adminUser });
 *   await app.register(ticketRoutes, opts);
 *   const res = await app.inject({ method: 'GET', url: '/api/tickets' });
 */

import Fastify from 'fastify';
import fp from 'fastify-plugin';
import sensible from '@fastify/sensible';
import type { PrismaClient } from '@bronco/db';
import type { AuthUser, PortalUser } from '../plugins/auth.js';

export interface TestAppOpts {
  /** Pre-built mock or real PrismaClient injected as fastify.db */
  db: PrismaClient;
  /** If set, request.user is populated (operator auth). */
  user?: AuthUser;
  /** If set, request.portalUser is populated (portal auth). */
  portalUser?: PortalUser;
}

/**
 * Build a minimal Fastify instance wired with the db, sensible (httpErrors),
 * and an auth stub that sets request.user / request.portalUser from the
 * provided fixture — no JWT verification, no Redis, no AI router.
 */
export async function buildTestRouteApp(opts: TestAppOpts) {
  const app = Fastify({ logger: false });

  // Inject db directly (bypasses getDb() which reads DATABASE_URL)
  const dbPlugin = fp(async (fastify) => {
    fastify.decorate('db', opts.db);
  });

  // Stub auth — set user/portalUser on every request
  const authStub = fp(async (fastify) => {
    fastify.addHook('onRequest', async (request) => {
      if (opts.user !== undefined) {
        request.user = opts.user;
      }
      if (opts.portalUser !== undefined) {
        request.portalUser = opts.portalUser;
      }
    });
  });

  await app.register(sensible);
  await app.register(dbPlugin);
  await app.register(authStub);

  return app;
}

// ─── Shared mock factory helpers ──────────────────────────────────────────────

/**
 * Returns an AuthUser fixture for a platform ADMIN operator (no clientId).
 * This caller gets `scope.type === 'all'` in resolveClientScope.
 */
export function makeAdminUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    personId: 'person-admin-1',
    operatorId: 'op-admin-1',
    email: 'admin@test.com',
    role: 'ADMIN' as AuthUser['role'],
    clientId: null,
    ...overrides,
  };
}

/**
 * Returns an AuthUser fixture for a client-scoped STANDARD operator.
 * This caller gets `scope.type === 'single'`.
 */
export function makeScopedUser(clientId: string, overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    personId: 'person-scoped-1',
    operatorId: 'op-scoped-1',
    email: 'scoped@test.com',
    role: 'STANDARD' as AuthUser['role'],
    clientId,
    ...overrides,
  };
}

/**
 * Creates a simple mock function that returns the provided value.
 * This is a vi.fn()-compatible stand-in for use before vi is imported.
 */
export function mockFn<T>(returnValue: T): () => Promise<T> {
  return async () => returnValue;
}
