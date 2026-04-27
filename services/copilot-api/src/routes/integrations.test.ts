/**
 * Unit tests for integrations routes.
 * Uses Fastify inject() with a mocked PrismaClient — no real DB or queues.
 * Verifies encrypt/decrypt boundary: secret fields are encrypted before DB write.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { looksEncrypted } from '@bronco/shared-utils';
import { buildTestRouteApp, makeAdminUser, makeScopedUser } from '../test/app-builder.js';
import { integrationRoutes } from './integrations.js';

// A valid 256-bit hex key for encryption tests
const TEST_ENCRYPTION_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

// ─── Mock factory helpers ─────────────────────────────────────────────────────

function makeMockDb(overrides: Partial<Record<string, unknown>> = {}): PrismaClient {
  const clientIntegration = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(null),
  };

  const clientEnvironment = {
    findUnique: vi.fn().mockResolvedValue(null),
  };

  const operatorClient = {
    findMany: vi.fn().mockResolvedValue([]),
  };

  return {
    clientIntegration,
    clientEnvironment,
    operatorClient,
    ...overrides,
  } as unknown as PrismaClient;
}

function makeMockQueue() {
  return { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
}

function makeIntegrationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'integ-1',
    clientId: 'client-1',
    type: 'IMAP',
    label: 'default',
    config: {},
    isActive: true,
    notes: null,
    environmentId: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    client: { name: 'Acme', shortCode: 'ACM' },
    ...overrides,
  };
}

function makeValidImapConfig() {
  return {
    host: 'imap.example.com',
    port: 993,
    user: 'user@example.com',
    encryptedPassword: 'plaintext-password',
    pollIntervalSeconds: 60,
  };
}

// ─── GET /api/integrations ────────────────────────────────────────────────────

describe('GET /api/integrations', () => {
  it('returns 200 with empty array when no integrations', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'GET', url: '/api/integrations' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('returns 400 for invalid type filter', async () => {
    const db = makeMockDb();
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'GET', url: '/api/integrations?type=INVALID_TYPE' });
    expect(res.statusCode).toBe(400);
  });

  it('scoped operator sees their client plus platform-scoped rows', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    await app.inject({ method: 'GET', url: '/api/integrations' });

    const call = (db.clientIntegration.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Single-scoped callers get an OR filter for their clientId plus null (platform)
    expect(call.where.OR).toBeDefined();
    const orClauses = call.where.OR as Array<Record<string, unknown>>;
    expect(orClauses.some((c) => c.clientId === 'client-a')).toBe(true);
    expect(orClauses.some((c) => c.clientId === null)).toBe(true);
  });

  it('returns 403 when scoped operator requests out-of-scope clientId', async () => {
    const db = makeMockDb();
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'GET', url: '/api/integrations?clientId=client-b' });
    expect(res.statusCode).toBe(403);
  });
});

// ─── GET /api/integrations/:id ────────────────────────────────────────────────

describe('GET /api/integrations/:id', () => {
  it('returns 404 when integration not found', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'GET', url: '/api/integrations/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('returns integration when found', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeIntegrationRow());
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'GET', url: '/api/integrations/integ-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('integ-1');
    expect(body.type).toBe('IMAP');
  });
});

// ─── POST /api/integrations ───────────────────────────────────────────────────

describe('POST /api/integrations', () => {
  it('returns 400 for invalid integration type', async () => {
    const db = makeMockDb();
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: { clientId: 'client-1', type: 'INVALID_TYPE', config: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when clientId is missing for non-GITHUB type', async () => {
    const db = makeMockDb();
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        type: 'IMAP',
        config: makeValidImapConfig(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid IMAP config (missing required fields)', async () => {
    const db = makeMockDb();
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        clientId: 'client-1',
        type: 'IMAP',
        config: { host: 'imap.example.com' }, // missing port, user, encryptedPassword, pollIntervalSeconds
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when scoped operator creates integration for out-of-scope client', async () => {
    const db = makeMockDb();
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        clientId: 'client-b',
        type: 'IMAP',
        config: makeValidImapConfig(),
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when non-admin creates platform-scoped GITHUB integration', async () => {
    const db = makeMockDb();
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: 'my-token' },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('encrypts secret fields before storing IMAP config', async () => {
    const created = makeIntegrationRow({ type: 'IMAP', config: { host: 'imap.example.com', port: 993, user: 'u@x.com', encryptedPassword: 'ENCRYPTED', pollIntervalSeconds: 60 } });
    const db = makeMockDb();
    (db.clientIntegration.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        clientId: 'client-1',
        type: 'IMAP',
        config: makeValidImapConfig(),
      },
    });
    expect(res.statusCode).toBe(201);

    const createCall = (db.clientIntegration.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedConfig = createCall.data.config as Record<string, unknown>;
    // The stored password must look encrypted — not plaintext
    expect(typeof storedConfig.encryptedPassword).toBe('string');
    expect(looksEncrypted(storedConfig.encryptedPassword as string)).toBe(true);
  });

  it('does not re-encrypt already-encrypted values', async () => {
    // Pre-encrypt a value and pass it in — route should not double-encrypt
    const { encrypt } = await import('@bronco/shared-utils');
    const preEncrypted = encrypt('plaintext-password', TEST_ENCRYPTION_KEY);

    const created = makeIntegrationRow({ type: 'IMAP' });
    const db = makeMockDb();
    (db.clientIntegration.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        clientId: 'client-1',
        type: 'IMAP',
        config: { ...makeValidImapConfig(), encryptedPassword: preEncrypted },
      },
    });

    const createCall = (db.clientIntegration.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedConfig = createCall.data.config as Record<string, unknown>;
    // Should still be the same already-encrypted value, not double-encrypted
    expect(storedConfig.encryptedPassword).toBe(preEncrypted);
  });

  it('enqueues MCP discovery job for MCP_DATABASE integration', async () => {
    const created = makeIntegrationRow({ id: 'integ-mcp', type: 'MCP_DATABASE', clientId: 'client-1', config: { url: 'http://mcp.example.com', apiKey: 'key123' } });
    const db = makeMockDb();
    (db.clientIntegration.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        clientId: 'client-1',
        type: 'MCP_DATABASE',
        config: { url: 'http://mcp.example.com', apiKey: 'key123' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(queue.add).toHaveBeenCalledWith('discover', { integrationId: 'integ-mcp' });
  });

  it('calls onSlackIntegrationChange for SLACK integration', async () => {
    const created = makeIntegrationRow({ type: 'SLACK', config: {
      encryptedBotToken: 'bot-token',
      encryptedAppToken: 'app-token',
      defaultChannelId: '#general',
      enabled: true,
    }});
    const db = makeMockDb();
    (db.clientIntegration.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);
    const queue = makeMockQueue();
    const slackChangeFn = vi.fn();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, {
      encryptionKey: TEST_ENCRYPTION_KEY,
      mcpDiscoveryQueue: queue as never,
      onSlackIntegrationChange: slackChangeFn,
    });

    await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        clientId: 'client-1',
        type: 'SLACK',
        config: {
          encryptedBotToken: 'bot-token',
          encryptedAppToken: 'app-token',
          defaultChannelId: '#general',
          enabled: true,
        },
      },
    });
    expect(slackChangeFn).toHaveBeenCalledOnce();
  });
});

// ─── PATCH /api/integrations/:id ─────────────────────────────────────────────

describe('PATCH /api/integrations/:id', () => {
  it('returns 404 when integration not found', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/integrations/nonexistent',
      payload: { label: 'updated' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when non-admin tries to update platform-scoped integration', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeIntegrationRow({ clientId: null, type: 'GITHUB' }),
    );
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/integrations/integ-1',
      payload: { label: 'updated' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('encrypts secret fields in config update', async () => {
    const existingConfig = { host: 'imap.example.com', port: 993, user: 'u@x.com', encryptedPassword: 'old-pass', pollIntervalSeconds: 60 };
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeIntegrationRow({ type: 'IMAP', config: existingConfig, clientId: 'client-1' }),
    );
    (db.clientIntegration.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeIntegrationRow());
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    await app.inject({
      method: 'PATCH',
      url: '/api/integrations/integ-1',
      payload: { config: { encryptedPassword: 'new-plaintext-password' } },
    });

    const updateCall = (db.clientIntegration.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedConfig = updateCall.data.config as Record<string, unknown>;
    expect(looksEncrypted(storedConfig.encryptedPassword as string)).toBe(true);
  });

  it('enqueues MCP discovery job when config changed on MCP_DATABASE', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeIntegrationRow({ type: 'MCP_DATABASE', clientId: 'client-1', config: { url: 'http://mcp.example.com', apiKey: 'key' } }),
    );
    (db.clientIntegration.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeIntegrationRow({ id: 'integ-1', type: 'MCP_DATABASE' }),
    );
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    await app.inject({
      method: 'PATCH',
      url: '/api/integrations/integ-1',
      payload: { config: { url: 'http://mcp-updated.example.com', apiKey: 'key' } },
    });
    expect(queue.add).toHaveBeenCalledWith('discover', { integrationId: 'integ-1' });
  });
});

// ─── DELETE /api/integrations/:id ────────────────────────────────────────────

describe('DELETE /api/integrations/:id', () => {
  it('returns 404 when integration not found', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'DELETE', url: '/api/integrations/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when non-admin tries to delete platform-scoped integration', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeIntegrationRow({ clientId: null, type: 'GITHUB' }),
    );
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeScopedUser('client-a') });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'DELETE', url: '/api/integrations/integ-1' });
    expect(res.statusCode).toBe(403);
  });

  it('deletes integration and returns 204', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeIntegrationRow());
    (db.clientIntegration.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ type: 'IMAP' });
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'DELETE', url: '/api/integrations/integ-1' });
    expect(res.statusCode).toBe(204);
  });

  it('calls onSlackIntegrationChange when SLACK integration deleted', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeIntegrationRow({ type: 'SLACK' }));
    (db.clientIntegration.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ type: 'SLACK' });
    const queue = makeMockQueue();
    const slackChangeFn = vi.fn();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, {
      encryptionKey: TEST_ENCRYPTION_KEY,
      mcpDiscoveryQueue: queue as never,
      onSlackIntegrationChange: slackChangeFn,
    });

    await app.inject({ method: 'DELETE', url: '/api/integrations/integ-1' });
    expect(slackChangeFn).toHaveBeenCalledOnce();
  });
});

// ─── POST /api/integrations/:id/verify ───────────────────────────────────────

describe('POST /api/integrations/:id/verify', () => {
  it('returns 404 when integration not found', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'POST', url: '/api/integrations/nonexistent/verify' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when integration type is not MCP_DATABASE', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeIntegrationRow({ type: 'IMAP' }));
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'POST', url: '/api/integrations/integ-1/verify' });
    expect(res.statusCode).toBe(400);
  });

  it('enqueues discovery and returns success for MCP_DATABASE', async () => {
    const db = makeMockDb();
    (db.clientIntegration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeIntegrationRow({ id: 'integ-mcp', type: 'MCP_DATABASE', clientId: 'client-1' }),
    );
    const queue = makeMockQueue();
    const app = await buildTestRouteApp({ db, user: makeAdminUser() });
    await app.register(integrationRoutes, { encryptionKey: TEST_ENCRYPTION_KEY, mcpDiscoveryQueue: queue as never });

    const res = await app.inject({ method: 'POST', url: '/api/integrations/integ-mcp/verify' });
    expect(res.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith('discover', { integrationId: 'integ-mcp' });
  });
});
