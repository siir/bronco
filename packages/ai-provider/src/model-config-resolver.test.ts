import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelConfigResolver, type ModelConfigRow } from './model-config-resolver.js';
import { TaskType, AIProvider } from '@bronco/shared-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<ModelConfigRow> = {}): ModelConfigRow {
  return {
    taskType: TaskType.DEEP_ANALYSIS,
    scope: 'APP_WIDE',
    clientId: null,
    provider: AIProvider.CLAUDE,
    model: 'custom-model',
    maxTokens: null,
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Resolution precedence
// ---------------------------------------------------------------------------

describe('ModelConfigResolver.resolve — precedence', () => {
  it('returns hardcoded DEFAULT when no DB rows exist', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('DEFAULT');
    expect(result.provider).toBe(AIProvider.CLAUDE);
  });

  it('returns APP_WIDE when there is an APP_WIDE row and no clientId', async () => {
    const row = makeRow({ scope: 'APP_WIDE', clientId: null, model: 'app-wide-model' });
    const fetcher = vi.fn().mockResolvedValue([row]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('APP_WIDE');
    expect(result.model).toBe('app-wide-model');
  });

  it('returns CLIENT over APP_WIDE when both exist and clientId is provided', async () => {
    const clientId = 'client-abc';
    const appWide = makeRow({ scope: 'APP_WIDE', clientId: null, model: 'app-wide-model' });
    const client = makeRow({ scope: 'CLIENT', clientId, model: 'client-model' });
    const fetcher = vi.fn().mockResolvedValue([appWide, client]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS, clientId);
    expect(result.source).toBe('CLIENT');
    expect(result.model).toBe('client-model');
  });

  it('falls back to APP_WIDE when CLIENT row exists for a different client', async () => {
    const appWide = makeRow({ scope: 'APP_WIDE', clientId: null, model: 'app-wide-model' });
    const client = makeRow({ scope: 'CLIENT', clientId: 'other-client', model: 'other-model' });
    const fetcher = vi.fn().mockResolvedValue([appWide, client]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS, 'my-client');
    expect(result.source).toBe('APP_WIDE');
    expect(result.model).toBe('app-wide-model');
  });

  it('falls back to DEFAULT when CLIENT row exists for a different client and no APP_WIDE', async () => {
    const client = makeRow({ scope: 'CLIENT', clientId: 'other-client', model: 'other-model' });
    const fetcher = vi.fn().mockResolvedValue([client]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS, 'my-client');
    expect(result.source).toBe('DEFAULT');
  });

  it('ignores inactive rows when resolving', async () => {
    const inactive = makeRow({ scope: 'APP_WIDE', clientId: null, model: 'inactive-model', isActive: false });
    const fetcher = vi.fn().mockResolvedValue([inactive]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('DEFAULT');
  });

  it('ignores rows for other task types', async () => {
    const row = makeRow({ scope: 'APP_WIDE', clientId: null, taskType: TaskType.TRIAGE, model: 'triage-model' });
    const fetcher = vi.fn().mockResolvedValue([row]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('DEFAULT');
  });

  it('ignores APP_WIDE rows that have a non-null clientId (malformed data)', async () => {
    // A row with scope=APP_WIDE but clientId set is invalid by schema unique constraint,
    // but the resolver should not pick it up as the APP_WIDE fallback — it checks clientId === null.
    const malformed = makeRow({ scope: 'APP_WIDE', clientId: 'some-client', model: 'malformed-model' });
    const fetcher = vi.fn().mockResolvedValue([malformed]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('DEFAULT');
  });
});

// ---------------------------------------------------------------------------
// maxTokens resolution
// ---------------------------------------------------------------------------

describe('ModelConfigResolver.resolve — maxTokens', () => {
  it('returns null maxTokens from DEFAULT when no DB config', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ModelConfigResolver(fetcher);
    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.maxTokens).toBeNull();
  });

  it('returns maxTokens from CLIENT row when set', async () => {
    const clientId = 'client-xyz';
    const row = makeRow({ scope: 'CLIENT', clientId, model: 'client-model', maxTokens: 4096 });
    const fetcher = vi.fn().mockResolvedValue([row]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS, clientId);
    expect(result.maxTokens).toBe(4096);
    expect(result.source).toBe('CLIENT');
  });

  it('returns maxTokens from APP_WIDE row when no CLIENT override', async () => {
    const row = makeRow({ scope: 'APP_WIDE', clientId: null, model: 'app-model', maxTokens: 8192 });
    const fetcher = vi.fn().mockResolvedValue([row]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS, 'any-client');
    expect(result.maxTokens).toBe(8192);
    expect(result.source).toBe('APP_WIDE');
  });

  it('returns null maxTokens from APP_WIDE row when maxTokens is null', async () => {
    const row = makeRow({ scope: 'APP_WIDE', clientId: null, model: 'app-model', maxTokens: null });
    const fetcher = vi.fn().mockResolvedValue([row]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.maxTokens).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe('ModelConfigResolver — cache', () => {
  it('issues only one DB query across two resolves for the same (taskType, clientId)', async () => {
    const row = makeRow({ scope: 'APP_WIDE', clientId: null });
    const fetcher = vi.fn().mockResolvedValue([row]);
    const resolver = new ModelConfigResolver(fetcher);

    await resolver.resolve(TaskType.DEEP_ANALYSIS);
    await resolver.resolve(TaskType.DEEP_ANALYSIS);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('issues only one DB query across resolves for different task types (shared cache)', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ModelConfigResolver(fetcher);

    await resolver.resolve(TaskType.DEEP_ANALYSIS);
    await resolver.resolve(TaskType.TRIAGE);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after invalidate() is called', async () => {
    const row = makeRow({ scope: 'APP_WIDE', clientId: null });
    const fetcher = vi.fn().mockResolvedValue([row]);
    const resolver = new ModelConfigResolver(fetcher);

    await resolver.resolve(TaskType.DEEP_ANALYSIS);
    resolver.invalidate();
    await resolver.resolve(TaskType.DEEP_ANALYSIS);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('respects a short cacheTtlMs and re-fetches after TTL expires', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ModelConfigResolver(fetcher, { cacheTtlMs: 0 }); // expires immediately

    await resolver.resolve(TaskType.DEEP_ANALYSIS);
    await resolver.resolve(TaskType.DEEP_ANALYSIS);

    // With TTL=0, every call should re-fetch because the cache is immediately stale
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns DEFAULT on fetcher failure (graceful degradation)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('DB is down'));
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('DEFAULT');
  });

  it('negative-caches on fetcher failure (does not hammer failing DB)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('DB is down'));
    const resolver = new ModelConfigResolver(fetcher);

    await resolver.resolve(TaskType.DEEP_ANALYSIS);
    await resolver.resolve(TaskType.DEEP_ANALYSIS);

    // The second call should hit the negative cache, not call the fetcher again
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Default provider routing
// ---------------------------------------------------------------------------

describe('ModelConfigResolver — hardcoded defaults', () => {
  it('LOCAL task types default to Ollama (AIProvider.LOCAL)', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.TRIAGE);
    expect(result.source).toBe('DEFAULT');
    expect(result.provider).toBe(AIProvider.LOCAL);
  });

  it('DETECT_TOOL_GAPS defaults to Claude (Haiku model)', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DETECT_TOOL_GAPS);
    expect(result.source).toBe('DEFAULT');
    expect(result.provider).toBe(AIProvider.CLAUDE);
    // Should be Haiku, not Sonnet
    expect(result.model).toContain('haiku');
  });

  it('DEEP_ANALYSIS defaults to Claude (Sonnet model)', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ModelConfigResolver(fetcher);

    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('DEFAULT');
    expect(result.provider).toBe(AIProvider.CLAUDE);
    expect(result.model).toContain('sonnet');
  });

  it('unknown taskType defaults to Claude Sonnet (safe fallback)', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const resolver = new ModelConfigResolver(fetcher);

    // An unknown task type should not throw; it should fall through to the Claude default
    const result = await resolver.resolve('UNKNOWN_TASK_TYPE_THAT_DOES_NOT_EXIST');
    expect(result.source).toBe('DEFAULT');
    expect(result.provider).toBe(AIProvider.CLAUDE);
  });
});
