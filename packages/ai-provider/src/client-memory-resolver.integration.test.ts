import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { getTestDb, truncateAll, createClient, createClientMemory } from '@bronco/test-utils';
import { ClientMemoryResolver, type ClientMemoryRow } from './client-memory-resolver.js';

const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

describe.skipIf(!hasDb)('integration: ClientMemoryResolver', () => {
  let db: PrismaClient;

  /** Build a resolver that reads from the test DB. */
  function makeResolver(cacheTtlMs = 60_000): ClientMemoryResolver {
    return new ClientMemoryResolver(
      (clientId: string) =>
        db.clientMemory.findMany({
          where: { clientId, isActive: true },
          select: {
            id: true,
            clientId: true,
            title: true,
            memoryType: true,
            category: true,
            tags: true,
            content: true,
            isActive: true,
            sortOrder: true,
            source: true,
          },
        }) as Promise<ClientMemoryRow[]>,
      { cacheTtlMs },
    );
  }

  beforeAll(async () => {
    db = getTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  // -----------------------------------------------------------------------
  // Basic round-trips
  // -----------------------------------------------------------------------

  it('returns empty result when client has no memories', async () => {
    const client = await createClient(db);
    const resolver = makeResolver(0);

    const result = await resolver.resolve(client.id);
    expect(result.entryCount).toBe(0);
    expect(result.content).toBe('');
  });

  it('returns memory content for a client with one active entry', async () => {
    const client = await createClient(db);
    await createClientMemory(db, {
      clientId: client.id,
      title: 'Deadlock Playbook',
      memoryType: 'PLAYBOOK',
      content: 'Run DBCC PAGE when deadlocks are detected.',
    });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(client.id);

    expect(result.entryCount).toBe(1);
    expect(result.content).toContain('## Client Knowledge');
    expect(result.content).toContain('### Deadlock Playbook (Playbook)');
    expect(result.content).toContain('Run DBCC PAGE when deadlocks are detected.');
  });

  // -----------------------------------------------------------------------
  // Inactive rows excluded
  // -----------------------------------------------------------------------

  it('excludes inactive memories from the resolved content', async () => {
    const client = await createClient(db);
    await createClientMemory(db, {
      clientId: client.id,
      title: 'Active Memory',
      isActive: true,
    });
    await createClientMemory(db, {
      clientId: client.id,
      title: 'Inactive Memory',
      isActive: false,
    });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(client.id);

    expect(result.entryCount).toBe(1);
    expect(result.content).toContain('Active Memory');
    expect(result.content).not.toContain('Inactive Memory');
  });

  // -----------------------------------------------------------------------
  // Category filtering
  // -----------------------------------------------------------------------

  it('with category filter: includes matching-category and null-category entries', async () => {
    const client = await createClient(db);
    await createClientMemory(db, {
      clientId: client.id,
      title: 'DB Perf Memory',
      category: 'DATABASE_PERF',
    });
    await createClientMemory(db, {
      clientId: client.id,
      title: 'Global Memory',
      category: null,
    });
    await createClientMemory(db, {
      clientId: client.id,
      title: 'Bug Fix Memory',
      category: 'BUG_FIX',
    });

    const resolver = makeResolver(0);
    const { entries } = await resolver.resolve(client.id, { category: 'DATABASE_PERF' });

    expect(entries).toHaveLength(2);
    const titles = entries.map((e) => e.title);
    expect(titles).toContain('DB Perf Memory');
    expect(titles).toContain('Global Memory');
    expect(titles).not.toContain('Bug Fix Memory');
  });

  it('without category filter: returns all active entries regardless of category', async () => {
    const client = await createClient(db);
    await createClientMemory(db, { clientId: client.id, title: 'A', category: 'DATABASE_PERF' });
    await createClientMemory(db, { clientId: client.id, title: 'B', category: 'BUG_FIX' });
    await createClientMemory(db, { clientId: client.id, title: 'C', category: null });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(client.id);

    expect(result.entryCount).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Per-client isolation
  // -----------------------------------------------------------------------

  it('does not return memories from a different client', async () => {
    const clientA = await createClient(db);
    const clientB = await createClient(db);

    await createClientMemory(db, { clientId: clientA.id, title: 'A Memory', content: 'Client A secret' });
    await createClientMemory(db, { clientId: clientB.id, title: 'B Memory', content: 'Client B secret' });

    const resolver = makeResolver(0);
    const resultA = await resolver.resolve(clientA.id);
    const resultB = await resolver.resolve(clientB.id);

    expect(resultA.content).toContain('Client A secret');
    expect(resultA.content).not.toContain('Client B secret');

    expect(resultB.content).toContain('Client B secret');
    expect(resultB.content).not.toContain('Client A secret');
  });

  // -----------------------------------------------------------------------
  // sortOrder
  // -----------------------------------------------------------------------

  it('entries are returned in sortOrder ascending order', async () => {
    const client = await createClient(db);
    await createClientMemory(db, { clientId: client.id, title: 'Third', sortOrder: 30 });
    await createClientMemory(db, { clientId: client.id, title: 'First', sortOrder: 10 });
    await createClientMemory(db, { clientId: client.id, title: 'Second', sortOrder: 20 });

    const resolver = makeResolver(0);
    const { entries } = await resolver.resolve(client.id);

    expect(entries.map((e) => e.title)).toEqual(['First', 'Second', 'Third']);
  });

  // -----------------------------------------------------------------------
  // Cache invalidation
  // -----------------------------------------------------------------------

  it('cache hit: resolver returns stale result before invalidation', async () => {
    const client = await createClient(db);
    const resolver = makeResolver(60_000); // long TTL

    // First resolve — empty, caches empty result
    const before = await resolver.resolve(client.id);
    expect(before.entryCount).toBe(0);

    // Insert a new memory without invalidating
    await createClientMemory(db, { clientId: client.id, title: 'New Memory' });

    // Second resolve — still cached, should return empty
    const cached = await resolver.resolve(client.id);
    expect(cached.entryCount).toBe(0);

    // Invalidate for this client, then re-resolve
    resolver.invalidate(client.id);
    const fresh = await resolver.resolve(client.id);
    expect(fresh.entryCount).toBe(1);
    expect(fresh.content).toContain('New Memory');
  });

  it('invalidate() without clientId clears cache for all clients', async () => {
    const clientA = await createClient(db);
    const clientB = await createClient(db);
    const resolver = makeResolver(60_000);

    await resolver.resolve(clientA.id);
    await resolver.resolve(clientB.id);

    await createClientMemory(db, { clientId: clientA.id, title: 'A New' });
    await createClientMemory(db, { clientId: clientB.id, title: 'B New' });

    // Without invalidation, still cached
    const cachedA = await resolver.resolve(clientA.id);
    expect(cachedA.entryCount).toBe(0);

    // Invalidate all
    resolver.invalidate();

    const freshA = await resolver.resolve(clientA.id);
    const freshB = await resolver.resolve(clientB.id);
    expect(freshA.entryCount).toBe(1);
    expect(freshB.entryCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Tags (integration smoke test)
  // -----------------------------------------------------------------------

  it('tag filtering works end-to-end with DB data', async () => {
    const client = await createClient(db);
    await createClientMemory(db, {
      clientId: client.id,
      title: 'Blocking Guide',
      tags: ['blocking', 'deadlocks'],
    });
    await createClientMemory(db, {
      clientId: client.id,
      title: 'Index Guide',
      tags: ['performance', 'indexing'],
    });
    await createClientMemory(db, {
      clientId: client.id,
      title: 'No Tags Entry',
      tags: [],
    });

    const resolver = makeResolver(0);
    const { entries } = await resolver.resolve(client.id, { tags: ['blocking'] });

    const titles = entries.map((e) => e.title);
    expect(titles).toContain('Blocking Guide');
    // Entries with no tags are included (tag filter is permissive for untagged)
    expect(titles).toContain('No Tags Entry');
    // Entries with non-matching tags are excluded
    expect(titles).not.toContain('Index Guide');
  });
});
