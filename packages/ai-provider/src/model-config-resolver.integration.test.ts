import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { getTestDb, truncateAll, createClient, createAiModelConfig } from '@bronco/test-utils';
import { ModelConfigResolver } from './model-config-resolver.js';
import { TaskType, AIProvider } from '@bronco/shared-types';

const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

describe.skipIf(!hasDb)('integration: ModelConfigResolver', () => {
  let db: PrismaClient;

  /** Build a resolver that reads from the test DB. */
  function makeResolver(cacheTtlMs = 60_000): ModelConfigResolver {
    return new ModelConfigResolver(
      () =>
        db.aiModelConfig.findMany({
          where: { isActive: true },
          select: {
            taskType: true,
            scope: true,
            clientId: true,
            provider: true,
            model: true,
            maxTokens: true,
            isActive: true,
          },
        }),
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
  // APP_WIDE resolution
  // -----------------------------------------------------------------------

  it('returns DEFAULT when DB has no configs', async () => {
    const resolver = makeResolver();
    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('DEFAULT');
  });

  it('returns APP_WIDE row when one exists for the task type', async () => {
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      provider: AIProvider.CLAUDE,
      model: 'claude-haiku-test',
    });

    const resolver = makeResolver(0); // TTL=0 so no caching between tests
    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('APP_WIDE');
    expect(result.model).toBe('claude-haiku-test');
    expect(result.provider).toBe(AIProvider.CLAUDE);
  });

  it('APP_WIDE row does not affect a different task type', async () => {
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      provider: AIProvider.CLAUDE,
      model: 'custom-deep',
    });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(TaskType.TRIAGE);
    expect(result.source).toBe('DEFAULT');
  });

  // -----------------------------------------------------------------------
  // CLIENT override resolution
  // -----------------------------------------------------------------------

  it('returns CLIENT override when both APP_WIDE and CLIENT rows exist', async () => {
    const client = await createClient(db);

    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      provider: AIProvider.CLAUDE,
      model: 'app-wide-model',
    });
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'CLIENT' as const,
      clientId: client.id,
      provider: AIProvider.LOCAL,
      model: 'client-local-model',
    });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS, client.id);
    expect(result.source).toBe('CLIENT');
    expect(result.model).toBe('client-local-model');
    expect(result.provider).toBe(AIProvider.LOCAL);
  });

  it('returns APP_WIDE when CLIENT row exists for a different client', async () => {
    const clientA = await createClient(db);
    const clientB = await createClient(db);

    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      model: 'app-wide-model',
    });
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'CLIENT' as const,
      clientId: clientA.id,
      model: 'client-a-model',
    });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS, clientB.id);
    expect(result.source).toBe('APP_WIDE');
    expect(result.model).toBe('app-wide-model');
  });

  // -----------------------------------------------------------------------
  // maxTokens
  // -----------------------------------------------------------------------

  it('returns maxTokens from DB row when set', async () => {
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      model: 'my-model',
      maxTokens: 16384,
    });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.maxTokens).toBe(16384);
  });

  it('returns null maxTokens when the DB row has maxTokens = null', async () => {
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      model: 'my-model',
      maxTokens: null,
    });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.maxTokens).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Inactive rows are excluded
  // -----------------------------------------------------------------------

  it('ignores inactive DB rows', async () => {
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      model: 'inactive-model',
      isActive: false,
    });

    const resolver = makeResolver(0);
    const result = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(result.source).toBe('DEFAULT');
  });

  // -----------------------------------------------------------------------
  // Cache invalidation
  // -----------------------------------------------------------------------

  it('cache hit: same resolver instance returns APP_WIDE from cache after DB row inserted', async () => {
    // Build resolver with a long TTL so it caches the initial empty result
    const resolver = makeResolver(60_000);

    // First resolve — populates cache with empty list
    const before = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(before.source).toBe('DEFAULT');

    // Insert a row without invalidating
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      model: 'new-model',
    });

    // Second resolve — should still return DEFAULT because cache is warm
    const cached = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(cached.source).toBe('DEFAULT');

    // After invalidation, should pick up the new row
    resolver.invalidate();
    const fresh = await resolver.resolve(TaskType.DEEP_ANALYSIS);
    expect(fresh.source).toBe('APP_WIDE');
    expect(fresh.model).toBe('new-model');
  });

  // -----------------------------------------------------------------------
  // Layering: APP_WIDE → CLIENT upgrade after invalidate
  // -----------------------------------------------------------------------

  it('layering upgrade: starts APP_WIDE, after invalidate + CLIENT row insert returns CLIENT', async () => {
    const client = await createClient(db);

    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'APP_WIDE' as const,
      clientId: null,
      model: 'app-wide-model',
    });

    const resolver = makeResolver(60_000);
    const initial = await resolver.resolve(TaskType.DEEP_ANALYSIS, client.id);
    expect(initial.source).toBe('APP_WIDE');

    // Add CLIENT override
    await createAiModelConfig(db, {
      taskType: TaskType.DEEP_ANALYSIS,
      scope: 'CLIENT' as const,
      clientId: client.id,
      model: 'client-override',
    });

    // Cached — still APP_WIDE
    const cached = await resolver.resolve(TaskType.DEEP_ANALYSIS, client.id);
    expect(cached.source).toBe('APP_WIDE');

    // Invalidate → now sees CLIENT
    resolver.invalidate();
    const fresh = await resolver.resolve(TaskType.DEEP_ANALYSIS, client.id);
    expect(fresh.source).toBe('CLIENT');
    expect(fresh.model).toBe('client-override');
  });
});
