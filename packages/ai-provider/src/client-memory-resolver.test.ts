import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClientMemoryResolver, type ClientMemoryRow } from './client-memory-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let rowCounter = 0;

function makeRow(overrides: Partial<ClientMemoryRow> = {}): ClientMemoryRow {
  rowCounter += 1;
  return {
    id: `row-${rowCounter}`,
    clientId: 'client-a',
    title: `Memory ${rowCounter}`,
    memoryType: 'CONTEXT',
    category: null,
    tags: [],
    content: `Content ${rowCounter}`,
    isActive: true,
    sortOrder: rowCounter,
    source: 'MANUAL',
    ...overrides,
  };
}

beforeEach(() => {
  rowCounter = 0;
});

// ---------------------------------------------------------------------------
// Empty / no entries
// ---------------------------------------------------------------------------

describe('ClientMemoryResolver.resolve — empty', () => {
  it('returns empty result when fetcher returns no rows', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ClientMemoryResolver(fetcher);

    const result = await resolver.resolve('client-a');
    expect(result.entryCount).toBe(0);
    expect(result.content).toBe('');
    expect(result.entries).toHaveLength(0);
  });

  it('returns empty result when all rows are inactive', async () => {
    const rows = [makeRow({ isActive: false }), makeRow({ isActive: false })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const result = await resolver.resolve('client-a');
    expect(result.entryCount).toBe(0);
    expect(result.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Markdown composition
// ---------------------------------------------------------------------------

describe('ClientMemoryResolver.resolve — markdown composition', () => {
  it('produces a "## Client Knowledge" header', async () => {
    const rows = [makeRow({ title: 'My Memory', content: 'Hello world', memoryType: 'CONTEXT' })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const result = await resolver.resolve('client-a');
    expect(result.content).toContain('## Client Knowledge');
  });

  it('uses "Context" label for CONTEXT memory type', async () => {
    const rows = [makeRow({ memoryType: 'CONTEXT', title: 'My Memory' })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { content } = await resolver.resolve('client-a');
    expect(content).toContain('### My Memory (Context)');
  });

  it('uses "Playbook" label for PLAYBOOK memory type', async () => {
    const rows = [makeRow({ memoryType: 'PLAYBOOK', title: 'My Playbook' })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { content } = await resolver.resolve('client-a');
    expect(content).toContain('### My Playbook (Playbook)');
  });

  it('uses "Tool Guidance" label for TOOL_GUIDANCE memory type', async () => {
    const rows = [makeRow({ memoryType: 'TOOL_GUIDANCE', title: 'My Guide' })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { content } = await resolver.resolve('client-a');
    expect(content).toContain('### My Guide (Tool Guidance)');
  });

  it('separates multiple entries with "---" dividers', async () => {
    const rows = [
      makeRow({ title: 'First', sortOrder: 1 }),
      makeRow({ title: 'Second', sortOrder: 2 }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { content } = await resolver.resolve('client-a');
    expect(content).toContain('---');
  });

  it('includes entry content verbatim', async () => {
    const rows = [makeRow({ content: 'Use sp_BlitzFirst for blocking analysis.' })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { content } = await resolver.resolve('client-a');
    expect(content).toContain('Use sp_BlitzFirst for blocking analysis.');
  });

  it('reports correct entryCount', async () => {
    const rows = [makeRow(), makeRow(), makeRow()];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const result = await resolver.resolve('client-a');
    expect(result.entryCount).toBe(3);
  });

  it('prepends environmentInstructions when provided', async () => {
    const rows = [makeRow({ title: 'My Memory' })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { content } = await resolver.resolve('client-a', {
      environmentInstructions: 'Production environment. Handle with care.',
    });
    expect(content).toContain('## Environment Operational Instructions');
    expect(content).toContain('Production environment. Handle with care.');
    // Environment instructions should come before Client Knowledge
    const envIdx = content.indexOf('## Environment Operational Instructions');
    const knowledgeIdx = content.indexOf('## Client Knowledge');
    expect(envIdx).toBeLessThan(knowledgeIdx);
  });

  it('does not include environment instructions header when environmentInstructions is falsy', async () => {
    const rows = [makeRow()];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { content } = await resolver.resolve('client-a');
    expect(content).not.toContain('## Environment Operational Instructions');
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('ClientMemoryResolver.resolve — sortOrder', () => {
  it('returns entries ordered by sortOrder ascending', async () => {
    const rows = [
      makeRow({ title: 'C', sortOrder: 30 }),
      makeRow({ title: 'A', sortOrder: 10 }),
      makeRow({ title: 'B', sortOrder: 20 }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { entries } = await resolver.resolve('client-a');
    expect(entries.map((e) => e.title)).toEqual(['A', 'B', 'C']);
  });
});

// ---------------------------------------------------------------------------
// Category filtering
// ---------------------------------------------------------------------------

describe('ClientMemoryResolver.resolve — category filtering', () => {
  it('returns all active entries when no category filter provided', async () => {
    const rows = [
      makeRow({ category: null }),
      makeRow({ category: 'DATABASE_PERF' }),
      makeRow({ category: 'BUG_FIX' }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const result = await resolver.resolve('client-a');
    expect(result.entryCount).toBe(3);
  });

  it('with category filter: includes entries with matching category', async () => {
    const rows = [
      makeRow({ category: 'DATABASE_PERF', title: 'DB Perf Memory' }),
      makeRow({ category: 'BUG_FIX', title: 'Bug Fix Memory' }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { entries } = await resolver.resolve('client-a', { category: 'DATABASE_PERF' });
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('DB Perf Memory');
  });

  it('with category filter: includes entries with null category (applies to all)', async () => {
    const rows = [
      makeRow({ category: null, title: 'Global Memory' }),
      makeRow({ category: 'BUG_FIX', title: 'Bug Fix Memory' }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { entries } = await resolver.resolve('client-a', { category: 'DATABASE_PERF' });
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Global Memory');
  });

  it('with category filter: excludes entries for a different category', async () => {
    const rows = [makeRow({ category: 'BUG_FIX', title: 'Bug Fix Memory' })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { entries } = await resolver.resolve('client-a', { category: 'DATABASE_PERF' });
    expect(entries).toHaveLength(0);
  });

  it('with null category filter: treats as no filter (all entries returned)', async () => {
    const rows = [
      makeRow({ category: null }),
      makeRow({ category: 'DATABASE_PERF' }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const result = await resolver.resolve('client-a', { category: null });
    expect(result.entryCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tag filtering
// ---------------------------------------------------------------------------

describe('ClientMemoryResolver.resolve — tag filtering', () => {
  it('includes entries with at least one matching tag (OR logic)', async () => {
    const rows = [
      makeRow({ title: 'A', tags: ['blocking', 'deadlocks'] }),
      makeRow({ title: 'B', tags: ['performance'] }),
      makeRow({ title: 'C', tags: ['other-thing'] }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { entries } = await resolver.resolve('client-a', { tags: ['blocking', 'performance'] });
    expect(entries.map((e) => e.title)).toContain('A');
    expect(entries.map((e) => e.title)).toContain('B');
    expect(entries.map((e) => e.title)).not.toContain('C');
  });

  it('includes entries with no tags (tag filter is additive, not restrictive)', async () => {
    // Entries with empty tags array are always included when tag filter is active
    const rows = [
      makeRow({ title: 'Tagged', tags: ['blocking'] }),
      makeRow({ title: 'Untagged', tags: [] }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { entries } = await resolver.resolve('client-a', { tags: ['blocking'] });
    expect(entries.map((e) => e.title)).toContain('Tagged');
    expect(entries.map((e) => e.title)).toContain('Untagged');
  });

  it('tag matching is case-insensitive', async () => {
    const rows = [makeRow({ title: 'A', tags: ['Blocking'] })];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const { entries } = await resolver.resolve('client-a', { tags: ['blocking'] });
    expect(entries).toHaveLength(1);
  });

  it('empty tags array means no tag filter is applied', async () => {
    const rows = [
      makeRow({ title: 'A', tags: ['blocking'] }),
      makeRow({ title: 'B', tags: [] }),
    ];
    const fetcher = vi.fn().mockResolvedValue(rows);
    const resolver = new ClientMemoryResolver(fetcher);

    const result = await resolver.resolve('client-a', { tags: [] });
    expect(result.entryCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe('ClientMemoryResolver — cache', () => {
  it('issues only one DB query for the same clientId across two resolves', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ClientMemoryResolver(fetcher);

    await resolver.resolve('client-a');
    await resolver.resolve('client-a');

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fetches separately for different clientIds (per-client cache)', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ClientMemoryResolver(fetcher);

    await resolver.resolve('client-a');
    await resolver.resolve('client-b');

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith('client-a');
    expect(fetcher).toHaveBeenCalledWith('client-b');
  });

  it('per-client isolation: client A rows never appear in client B response', async () => {
    const fetcherA = [makeRow({ clientId: 'client-a', title: 'A Memory' })];
    const fetcherB = [makeRow({ clientId: 'client-b', title: 'B Memory' })];
    const fetcher = vi.fn()
      .mockImplementation((id: string) =>
        Promise.resolve(id === 'client-a' ? fetcherA : fetcherB),
      );
    const resolver = new ClientMemoryResolver(fetcher);

    const resultA = await resolver.resolve('client-a');
    const resultB = await resolver.resolve('client-b');

    expect(resultA.entries.every((e) => e.title === 'A Memory')).toBe(true);
    expect(resultB.entries.every((e) => e.title === 'B Memory')).toBe(true);
  });

  it('invalidate(clientId) forces re-fetch for that client only', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ClientMemoryResolver(fetcher);

    await resolver.resolve('client-a');
    await resolver.resolve('client-b');
    resolver.invalidate('client-a');
    await resolver.resolve('client-a');
    await resolver.resolve('client-b');

    // client-a: fetched once before invalidate, once after = 2
    // client-b: fetched once before + once after BUT the second resolve('client-b') should hit cache = 1
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('invalidate() with no argument clears the entire cache', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ClientMemoryResolver(fetcher);

    await resolver.resolve('client-a');
    await resolver.resolve('client-b');
    resolver.invalidate();
    await resolver.resolve('client-a');
    await resolver.resolve('client-b');

    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('respects a short cacheTtlMs and re-fetches after TTL expires', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ClientMemoryResolver(fetcher, { cacheTtlMs: 0 });

    await resolver.resolve('client-a');
    await resolver.resolve('client-a');

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns empty result on fetcher failure (graceful degradation)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('DB error'));
    const resolver = new ClientMemoryResolver(fetcher);

    const result = await resolver.resolve('client-a');
    expect(result.entryCount).toBe(0);
    expect(result.content).toBe('');
  });

  it('negative-caches on fetcher failure (does not hammer failing DB)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('DB error'));
    const resolver = new ClientMemoryResolver(fetcher);

    await resolver.resolve('client-a');
    await resolver.resolve('client-a');

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
