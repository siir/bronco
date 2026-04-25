/**
 * Unit tests for AIRouter.generate() and AIRouter.generateWithTools().
 *
 * All external dependencies (provider clients, resolvers, DB writers) are mocked
 * with vi.fn() stubs — no live Anthropic calls, no Postgres connection needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { AIRouter } from './router.js';
import { TaskType, AIProvider } from '@bronco/shared-types';
import type { AIRequest, AIToolRequest, AIResponse, AIToolResponse } from '@bronco/shared-types';
import type { AIProviderClient } from './types.js';
import type { ClientMemoryResolver } from './client-memory-resolver.js';
import type { ModelConfigResolver, ResolvedModelConfig } from './model-config-resolver.js';
import type { ProviderConfigResolver } from './provider-config-resolver.js';
import type { AiUsageWriter, AiUsageEntry } from './types.js';

// ---------------------------------------------------------------------------
// Shared fixtures / factories
// ---------------------------------------------------------------------------

function makeResponse(overrides: Partial<AIResponse> = {}): AIResponse {
  return {
    provider: AIProvider.CLAUDE,
    content: 'Test response',
    model: 'claude-test-model',
    usage: { inputTokens: 100, outputTokens: 50 },
    durationMs: 250,
    ...overrides,
  };
}

function makeToolResponse(overrides: Partial<AIToolResponse> = {}): AIToolResponse {
  return {
    provider: AIProvider.CLAUDE,
    content: 'Test tool response',
    model: 'claude-test-model',
    usage: { inputTokens: 200, outputTokens: 80 },
    durationMs: 500,
    stopReason: 'end_turn',
    contentBlocks: [{ type: 'text', text: 'Test tool response' }],
    ...overrides,
  };
}

/** Build a minimal mock provider client whose generate() resolves immediately. */
function makeProviderClient(
  generateResult?: Partial<AIResponse>,
  toolResult?: Partial<AIToolResponse>,
): AIProviderClient {
  return {
    generate: vi.fn().mockResolvedValue(makeResponse(generateResult)),
    generateWithTools: vi.fn().mockResolvedValue(makeToolResponse(toolResult)),
  };
}

/** Build a mock ClientMemoryResolver that returns a resolved memory block. */
function makeClientMemoryResolver(
  entryCount = 0,
  content = '',
): ClientMemoryResolver {
  const memoryResult = { entryCount, content, entries: [] };
  return {
    resolve: vi.fn().mockResolvedValue(memoryResult),
    invalidate: vi.fn(),
  } as unknown as ClientMemoryResolver;
}

/** Build a mock ModelConfigResolver that returns a given resolved config. */
function makeModelConfigResolver(
  resolved: Partial<ResolvedModelConfig> = {},
): ModelConfigResolver {
  const config: ResolvedModelConfig = {
    // Default to LOCAL so that when the router builds a provider from a non-DEFAULT
    // source it resolves through resolveByProvider() → LOCAL config → cache hit.
    provider: AIProvider.LOCAL,
    model: 'ollama-test',
    maxTokens: null,
    source: 'DEFAULT',
    ...resolved,
  };
  return {
    resolve: vi.fn().mockResolvedValue(config),
    invalidate: vi.fn(),
  } as unknown as ModelConfigResolver;
}

/** Build a mock ProviderConfigResolver with a Claude capability provider. */
function makeProviderConfigResolver(
  apiKey = 'fake-api-key',
): ProviderConfigResolver {
  const claudeRow = {
    id: 'p1',
    providerId: 'prov1',
    name: 'Test Claude',
    provider: AIProvider.CLAUDE,
    baseUrl: null,
    apiKey,
    model: 'claude-test-model',
    capabilityLevel: 'DEEP_ADVANCED',
    isActive: true,
    providerActive: true,
    enabledApps: [],
  };
  return {
    resolveByCapability: vi.fn().mockResolvedValue({
      provider: AIProvider.CLAUDE,
      model: 'claude-test-model',
      baseUrl: null,
      apiKey,
      capabilityLevel: 'DEEP_ADVANCED',
      source: 'PROVIDER_DB',
    }),
    resolveByProvider: vi.fn().mockResolvedValue({
      provider: AIProvider.CLAUDE,
      model: 'claude-test-model',
      baseUrl: null,
      apiKey,
      capabilityLevel: 'DEEP_ADVANCED',
      source: 'PROVIDER_DB',
    }),
    isProviderEnabled: vi.fn().mockResolvedValue(true),
    getAll: vi.fn().mockResolvedValue([claudeRow]),
    getActiveModelsForProvider: vi.fn().mockResolvedValue([claudeRow]),
    invalidate: vi.fn(),
  } as unknown as ProviderConfigResolver;
}

/** Returns a router that will always use the mock provider client. */
function makeTestRouter(opts: {
  memoryResolver?: ClientMemoryResolver;
  modelConfigResolver?: ModelConfigResolver;
  usageWriter?: AiUsageWriter;
  defaultMaxTokensLoader?: () => Promise<number | undefined>;
} = {}): { router: AIRouter; mockClient: AIProviderClient } {
  const mockClient = makeProviderClient();
  const providerConfigResolver = makeProviderConfigResolver();

  // Both capability routing and named-provider routing return the same LOCAL entry.
  // This means the router always builds an OllamaClient(baseUrl, model), and we then
  // replace that cache entry with mockClient so no real HTTP calls happen.
  const localConfig = {
    provider: AIProvider.LOCAL,
    model: 'ollama-test',
    baseUrl: 'http://localhost:11434',
    apiKey: null,
    capabilityLevel: 'SIMPLE',
    source: 'PROVIDER_DB',
  };
  (providerConfigResolver.resolveByCapability as Mock).mockResolvedValue(localConfig);
  (providerConfigResolver.resolveByProvider as Mock).mockResolvedValue(localConfig);
  (providerConfigResolver.isProviderEnabled as Mock).mockResolvedValue(true);

  const router = new AIRouter({
    clientMemoryResolver: opts.memoryResolver,
    modelConfigResolver: opts.modelConfigResolver,
    providerConfigResolver,
    usageWriter: opts.usageWriter,
    defaultMaxTokensLoader: opts.defaultMaxTokensLoader,
  });

  // Override the cache entry so we intercept the exact key that would be built
  const r = router as unknown as { providerCache: Map<string, AIProviderClient> };
  r.providerCache.set('LOCAL:ollama-test:http://localhost:11434:', mockClient);

  return { router, mockClient };
}

// ---------------------------------------------------------------------------
// 1. Client memory auto-injection via generate()
// ---------------------------------------------------------------------------

describe('AIRouter.generate — client memory injection', () => {
  it('injects client memory into systemPrompt when clientId is present and memory exists', async () => {
    const memoryContent = '## Client Knowledge\n\n### Deadlock Guide (Playbook)\n\nUse sp_BlitzFirst.';
    const memoryResolver = makeClientMemoryResolver(1, memoryContent);
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Analyze this issue',
      systemPrompt: 'You are an expert DBA.',
      context: { clientId: 'client-abc', entityId: null, entityType: null },
    };

    await router.generate(req);

    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.systemPrompt).toContain('You are an expert DBA.');
    expect(calledWith.systemPrompt).toContain(memoryContent);
    expect(memoryResolver.resolve as Mock).toHaveBeenCalledWith('client-abc', expect.objectContaining({ category: undefined }));
  });

  it('appends memory to existing systemPrompt with a newline separator', async () => {
    const memoryContent = '## Client Knowledge\n\nSome knowledge.';
    const memoryResolver = makeClientMemoryResolver(1, memoryContent);
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      systemPrompt: 'Initial system prompt.',
      context: { clientId: 'client-abc', entityId: null, entityType: null },
    };

    await router.generate(req);

    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.systemPrompt).toBe(`Initial system prompt.\n\n${memoryContent}`);
  });

  it('uses memory as systemPrompt when no initial systemPrompt is set', async () => {
    const memoryContent = '## Client Knowledge\n\nSome knowledge.';
    const memoryResolver = makeClientMemoryResolver(1, memoryContent);
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      // no systemPrompt
      context: { clientId: 'client-abc', entityId: null, entityType: null },
    };

    await router.generate(req);

    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.systemPrompt).toBe(memoryContent);
  });

  it('does NOT inject memory when entryCount is 0 (no active entries)', async () => {
    const memoryResolver = makeClientMemoryResolver(0, '');
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      systemPrompt: 'Original.',
      context: { clientId: 'client-abc', entityId: null, entityType: null },
    };

    await router.generate(req);

    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.systemPrompt).toBe('Original.');
  });

  it('does NOT inject memory when no clientId is present', async () => {
    const memoryResolver = makeClientMemoryResolver(1, '## Client Knowledge\n\nSomething.');
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      systemPrompt: 'Original.',
      // no clientId
      context: { entityId: null, entityType: null },
    };

    await router.generate(req);

    // Memory resolve should not be called when there is no clientId
    expect(memoryResolver.resolve as Mock).not.toHaveBeenCalled();
    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.systemPrompt).toBe('Original.');
  });

  it('does NOT inject memory when no clientMemoryResolver is configured', async () => {
    const { router, mockClient } = makeTestRouter(); // no memoryResolver

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      systemPrompt: 'Original.',
      context: { clientId: 'client-abc', entityId: null, entityType: null },
    };

    await router.generate(req);

    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.systemPrompt).toBe('Original.');
  });
});

// ---------------------------------------------------------------------------
// 2. skipClientMemory suppresses injection
// ---------------------------------------------------------------------------

describe('AIRouter.generate — skipClientMemory', () => {
  it('suppresses memory injection when context.skipClientMemory = true', async () => {
    const memoryContent = '## Client Knowledge\n\nSome knowledge.';
    const memoryResolver = makeClientMemoryResolver(1, memoryContent);
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      systemPrompt: 'Original.',
      context: { clientId: 'client-abc', entityId: null, entityType: null, skipClientMemory: true },
    };

    await router.generate(req);

    expect(memoryResolver.resolve as Mock).not.toHaveBeenCalled();
    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.systemPrompt).toBe('Original.');
  });

  it('injects memory when skipClientMemory is false/absent', async () => {
    const memoryContent = '## Client Knowledge\n\nSome knowledge.';
    const memoryResolver = makeClientMemoryResolver(1, memoryContent);
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      systemPrompt: 'Original.',
      context: { clientId: 'client-abc', entityId: null, entityType: null, skipClientMemory: false },
    };

    await router.generate(req);

    expect(memoryResolver.resolve as Mock).toHaveBeenCalled();
    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.systemPrompt).toContain(memoryContent);
  });
});

// ---------------------------------------------------------------------------
// 3. generateWithTools — client memory injection
// ---------------------------------------------------------------------------

describe('AIRouter.generateWithTools — client memory injection', () => {
  it('injects client memory into systemPrompt', async () => {
    const memoryContent = '## Client Knowledge\n\nKnowledge block.';
    const memoryResolver = makeClientMemoryResolver(1, memoryContent);
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIToolRequest = {
      taskType: TaskType.TRIAGE,
      systemPrompt: 'Base system.',
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      context: { clientId: 'client-abc', entityId: null, entityType: null },
    };

    await router.generateWithTools(req);

    const calledWith = (mockClient.generateWithTools as Mock).mock.calls[0][0] as AIToolRequest;
    expect(calledWith.systemPrompt).toContain('Base system.');
    expect(calledWith.systemPrompt).toContain(memoryContent);
  });

  it('suppresses memory injection when skipClientMemory = true', async () => {
    const memoryResolver = makeClientMemoryResolver(1, '## Client Knowledge\n\nKnowledge.');
    const { router, mockClient } = makeTestRouter({ memoryResolver });

    const req: AIToolRequest = {
      taskType: TaskType.TRIAGE,
      systemPrompt: 'Base system.',
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      context: { clientId: 'client-abc', entityId: null, entityType: null, skipClientMemory: true },
    };

    await router.generateWithTools(req);

    expect(memoryResolver.resolve as Mock).not.toHaveBeenCalled();
    const calledWith = (mockClient.generateWithTools as Mock).mock.calls[0][0] as AIToolRequest;
    expect(calledWith.systemPrompt).toBe('Base system.');
  });
});

// ---------------------------------------------------------------------------
// 4. ModelConfigResolver — maxTokens applied per call
// ---------------------------------------------------------------------------

describe('AIRouter.generate — ModelConfigResolver maxTokens', () => {
  it('picks up maxTokens from ModelConfigResolver when request has none', async () => {
    const modelConfigResolver = makeModelConfigResolver({
      source: 'APP_WIDE',
      provider: AIProvider.LOCAL,
      model: 'ollama-test',
      maxTokens: 4096,
    });
    const { router, mockClient } = makeTestRouter({ modelConfigResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      // no maxTokens
      context: { entityId: null, entityType: null },
    };

    await router.generate(req);

    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.maxTokens).toBe(4096);
  });

  it('request-level maxTokens wins over ModelConfigResolver value', async () => {
    const modelConfigResolver = makeModelConfigResolver({
      source: 'APP_WIDE',
      provider: AIProvider.LOCAL,
      model: 'ollama-test',
      maxTokens: 4096,
    });
    const { router, mockClient } = makeTestRouter({ modelConfigResolver });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      maxTokens: 1024,   // explicit — should win
      context: { entityId: null, entityType: null },
    };

    await router.generate(req);

    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.maxTokens).toBe(1024);
  });

  it('defaultMaxTokensLoader used when ModelConfigResolver returns null maxTokens', async () => {
    const modelConfigResolver = makeModelConfigResolver({ source: 'DEFAULT', maxTokens: null });
    const defaultMaxTokensLoader = vi.fn().mockResolvedValue(8192);
    const { router, mockClient } = makeTestRouter({ modelConfigResolver, defaultMaxTokensLoader });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      context: { entityId: null, entityType: null },
    };

    await router.generate(req);

    expect(defaultMaxTokensLoader).toHaveBeenCalled();
    const calledWith = (mockClient.generate as Mock).mock.calls[0][0] as AIRequest;
    expect(calledWith.maxTokens).toBe(8192);
  });

  it('ModelConfigResolver is consulted per call with the correct taskType and clientId', async () => {
    const modelConfigResolver = makeModelConfigResolver({ source: 'CLIENT', maxTokens: 2048 });
    const { router } = makeTestRouter({ modelConfigResolver });

    const req: AIRequest = {
      taskType: TaskType.DEEP_ANALYSIS,
      prompt: 'Prompt',
      context: { clientId: 'client-xyz', entityId: null, entityType: null },
    };

    await router.generate(req);

    expect(modelConfigResolver.resolve as Mock).toHaveBeenCalledWith(
      TaskType.DEEP_ANALYSIS,
      'client-xyz',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. ai_usage_logs row written per call (usageWriter)
// ---------------------------------------------------------------------------

describe('AIRouter.generate — usageWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls usageWriter once per generate call', async () => {
    const usageWriter: AiUsageWriter = vi.fn().mockResolvedValue('usage-log-id-1');
    const { router } = makeTestRouter({ usageWriter });

    const req: AIRequest = {
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      context: { entityId: null, entityType: null },
    };

    await router.generate(req);
    // usageWriter is fire-and-forget (no await), so we need to flush promises
    await vi.runAllTimersAsync();

    expect(usageWriter as Mock).toHaveBeenCalledTimes(1);
  });

  it('writes entityId and entityType from context', async () => {
    const writtenEntries: AiUsageEntry[] = [];
    const usageWriter: AiUsageWriter = vi.fn().mockImplementation(async (entry: AiUsageEntry) => {
      writtenEntries.push(entry);
      return 'log-id';
    });
    const { router } = makeTestRouter({ usageWriter });

    await router.generate({
      taskType: TaskType.TRIAGE,
      prompt: 'Analyze',
      context: {
        entityId: 'ticket-uuid-123',
        entityType: 'ticket',
        clientId: 'client-999',
      },
    });
    await vi.runAllTimersAsync();

    expect(writtenEntries).toHaveLength(1);
    expect(writtenEntries[0].entityId).toBe('ticket-uuid-123');
    expect(writtenEntries[0].entityType).toBe('ticket');
    expect(writtenEntries[0].clientId).toBe('client-999');
  });

  it('writes null entityId/entityType/clientId when explicit-null context is passed', async () => {
    const writtenEntries: AiUsageEntry[] = [];
    const usageWriter: AiUsageWriter = vi.fn().mockImplementation(async (entry: AiUsageEntry) => {
      writtenEntries.push(entry);
      return 'log-id';
    });
    const { router } = makeTestRouter({ usageWriter });

    await router.generate({
      taskType: TaskType.TRIAGE,
      prompt: 'Cross-ticket summary',
      context: {
        entityType: null,
        entityId: null,
        clientId: null,
      },
    });
    await vi.runAllTimersAsync();

    expect(writtenEntries).toHaveLength(1);
    expect(writtenEntries[0].entityId).toBeNull();
    expect(writtenEntries[0].entityType).toBeNull();
    expect(writtenEntries[0].clientId).toBeNull();
  });

  it('writes taskType, provider, and model from the response', async () => {
    const writtenEntries: AiUsageEntry[] = [];
    const usageWriter: AiUsageWriter = vi.fn().mockImplementation(async (entry: AiUsageEntry) => {
      writtenEntries.push(entry);
      return 'log-id';
    });
    const { router } = makeTestRouter({ usageWriter });

    await router.generate({
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      context: { entityId: null, entityType: null },
    });
    await vi.runAllTimersAsync();

    expect(writtenEntries[0].taskType).toBe(TaskType.TRIAGE);
    expect(writtenEntries[0].provider).toBeDefined();
    expect(writtenEntries[0].model).toBeDefined();
  });

  it('calls usageWriter once per generateWithTools call', async () => {
    const usageWriter: AiUsageWriter = vi.fn().mockResolvedValue('usage-log-id-1');
    const { router } = makeTestRouter({ usageWriter });

    await router.generateWithTools({
      taskType: TaskType.TRIAGE,
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      context: { entityId: null, entityType: null },
    });
    await vi.runAllTimersAsync();

    expect(usageWriter as Mock).toHaveBeenCalledTimes(1);
  });

  it('generateWithTools writes entityId and entityType from context', async () => {
    const writtenEntries: AiUsageEntry[] = [];
    const usageWriter: AiUsageWriter = vi.fn().mockImplementation(async (entry: AiUsageEntry) => {
      writtenEntries.push(entry);
      return 'log-id';
    });
    const { router } = makeTestRouter({ usageWriter });

    await router.generateWithTools({
      taskType: TaskType.TRIAGE,
      tools: [],
      messages: [{ role: 'user', content: 'Analyze' }],
      context: {
        entityId: 'ticket-uuid-456',
        entityType: 'ticket',
        clientId: 'client-777',
      },
    });
    await vi.runAllTimersAsync();

    expect(writtenEntries).toHaveLength(1);
    expect(writtenEntries[0].entityId).toBe('ticket-uuid-456');
    expect(writtenEntries[0].entityType).toBe('ticket');
    expect(writtenEntries[0].clientId).toBe('client-777');
  });
});

// ---------------------------------------------------------------------------
// 6. Explicit-null context is allowed and written correctly
// ---------------------------------------------------------------------------

describe('AIRouter — explicit-null context', () => {
  it('generate: accepts context with entityType/entityId/clientId all null', async () => {
    const usageWriter: AiUsageWriter = vi.fn().mockResolvedValue('log-id');
    const { router } = makeTestRouter({ usageWriter });

    await expect(router.generate({
      taskType: TaskType.TRIAGE,
      prompt: 'Cross-ticket',
      context: { entityType: null, entityId: null, clientId: null },
    })).resolves.toBeDefined();
  });

  it('generateWithTools: accepts context with entityType/entityId/clientId all null', async () => {
    const usageWriter: AiUsageWriter = vi.fn().mockResolvedValue('log-id');
    const { router } = makeTestRouter({ usageWriter });

    await expect(router.generateWithTools({
      taskType: TaskType.TRIAGE,
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      context: { entityType: null, entityId: null, clientId: null },
    })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. No usageWriter — fire-and-forget is safe (no crash)
// ---------------------------------------------------------------------------

describe('AIRouter — no usageWriter configured', () => {
  it('generate completes without throwing when usageWriter is not provided', async () => {
    const { router } = makeTestRouter(); // no usageWriter

    await expect(router.generate({
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      context: { entityId: null, entityType: null },
    })).resolves.toBeDefined();
  });

  it('generateWithTools completes without throwing when usageWriter is not provided', async () => {
    const { router } = makeTestRouter();

    await expect(router.generateWithTools({
      taskType: TaskType.TRIAGE,
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      context: { entityId: null, entityType: null },
    })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Provider throws NoProviderImplementationError when no providers configured
// ---------------------------------------------------------------------------

describe('AIRouter — no provider configured', () => {
  it('throws when no providerConfigResolver is set and no model overrides exist', async () => {
    const router = new AIRouter({
      // No resolvers — will hit the final throw in getProviderWithMode()
    });

    await expect(router.generate({
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      context: { entityId: null, entityType: null },
    })).rejects.toThrow('No AI provider configured');
  });
});

// ---------------------------------------------------------------------------
// 9. Memory injection also passes ticketCategory from context
// ---------------------------------------------------------------------------

describe('AIRouter.generate — ticketCategory forwarded to memory resolver', () => {
  it('passes ticketCategory from context to ClientMemoryResolver.resolve()', async () => {
    const memoryResolver = makeClientMemoryResolver(0, '');
    const { router } = makeTestRouter({ memoryResolver });

    await router.generate({
      taskType: TaskType.TRIAGE,
      prompt: 'Prompt',
      context: {
        clientId: 'client-abc',
        entityId: null,
        entityType: null,
        ticketCategory: 'DATABASE_PERF',
      },
    });

    expect(memoryResolver.resolve as Mock).toHaveBeenCalledWith(
      'client-abc',
      expect.objectContaining({ category: 'DATABASE_PERF' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. generateWithTools — throws when provider has no generateWithTools
// ---------------------------------------------------------------------------

describe('AIRouter.generateWithTools — provider capability check', () => {
  it('throws when provider does not support tool use', async () => {
    // Build a router whose mock client lacks generateWithTools
    const clientWithoutTools: AIProviderClient = {
      generate: vi.fn().mockResolvedValue(makeResponse()),
      // No generateWithTools
    };

    const providerConfigResolver = makeProviderConfigResolver('fake-key');
    (providerConfigResolver.resolveByCapability as Mock).mockResolvedValue({
      provider: AIProvider.LOCAL,
      model: 'ollama-no-tools',
      baseUrl: 'http://localhost:11434',
      apiKey: null,
      capabilityLevel: 'SIMPLE',
      source: 'PROVIDER_DB',
    });

    const router = new AIRouter({ providerConfigResolver });
    const r = router as unknown as { providerCache: Map<string, AIProviderClient> };
    r.providerCache.set('LOCAL:ollama-no-tools:http://localhost:11434:', clientWithoutTools);

    await expect(router.generateWithTools({
      taskType: TaskType.TRIAGE,
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      context: { entityId: null, entityType: null },
    })).rejects.toThrow('does not support tool use');
  });
});
