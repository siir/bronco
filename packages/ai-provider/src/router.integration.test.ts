/**
 * Integration tests for AIRouter.generate() / generateWithTools().
 *
 * These tests hit the real Postgres test DB to verify that:
 *   - ClientMemoryResolver reads live rows and injects them into the system prompt
 *   - ModelConfigResolver reads live AiModelConfig rows for maxTokens / provider / model
 *   - usageWriter entries are written to ai_usage_logs with correct entity context
 *   - skipClientMemory suppresses injection end-to-end
 *
 * Requires TEST_DATABASE_URL to be set. Skipped automatically when it is not.
 * Run with: TEST_DATABASE_URL=... pnpm test:integration
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import {
  getTestDb,
  truncateAll,
  createClient,
  createAiModelConfig,
  createClientMemory,
} from '@bronco/test-utils';
import { AIRouter } from './router.js';
import { TaskType, AIProvider } from '@bronco/shared-types';
import type { AIRequest, AIToolRequest, AIResponse, AIToolResponse } from '@bronco/shared-types';
import type { AIProviderClient } from './types.js';
import type { AiUsageEntry, AiUsageWriter } from './types.js';
import { ClientMemoryResolver, type ClientMemoryRow } from './client-memory-resolver.js';
import { ModelConfigResolver } from './model-config-resolver.js';

const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(overrides: Partial<AIResponse> = {}): AIResponse {
  return {
    provider: AIProvider.LOCAL,
    content: 'Test response from mock',
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 10,
    ...overrides,
  };
}

function makeToolResponse(overrides: Partial<AIToolResponse> = {}): AIToolResponse {
  return {
    provider: AIProvider.LOCAL,
    content: 'Test tool response from mock',
    model: 'mock-model',
    usage: { inputTokens: 20, outputTokens: 8 },
    durationMs: 15,
    stopReason: 'end_turn',
    contentBlocks: [{ type: 'text', text: 'Tool response' }],
    ...overrides,
  };
}

function makeMockProviderClient(): AIProviderClient {
  return {
    generate: vi.fn().mockResolvedValue(makeResponse()),
    generateWithTools: vi.fn().mockResolvedValue(makeToolResponse()),
  };
}

/**
 * Build a ClientMemoryResolver that reads from the test DB.
 * TTL=0 so every resolve hits the DB (no cache for test isolation).
 */
function makeDbMemoryResolver(db: PrismaClient): ClientMemoryResolver {
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
    { cacheTtlMs: 0 },
  );
}

/**
 * Build a ModelConfigResolver that reads from the test DB.
 * TTL=0 so every resolve hits the DB.
 */
function makeDbModelConfigResolver(db: PrismaClient): ModelConfigResolver {
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
    { cacheTtlMs: 0 },
  );
}

// ---------------------------------------------------------------------------
// Integration suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('integration: AIRouter', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = getTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  // -----------------------------------------------------------------------
  // Helper that builds a router with a mock provider and ProviderConfigResolver stub
  // -----------------------------------------------------------------------
  function buildIntegrationRouter(
    db: PrismaClient,
    opts: {
      usageWriter?: AiUsageWriter;
    } = {},
  ): { router: AIRouter; mockClient: AIProviderClient } {
    const mockClient = makeMockProviderClient();
    const memoryResolver = makeDbMemoryResolver(db);
    const modelConfigResolver = makeDbModelConfigResolver(db);

    // Minimal ProviderConfigResolver stub — returns LOCAL/mock so router can
    // build an OllamaClient, which we then replace in the cache.
    // Both resolveByCapability AND resolveByProvider must return the same LOCAL config
    // so that when ModelConfigResolver returns a non-DEFAULT row, the router can still
    // resolve credentials through resolveByProvider() and hit the cache.
    const localProviderConfig = {
      provider: AIProvider.LOCAL,
      model: 'mock-ollama',
      baseUrl: 'http://localhost:11434',
      apiKey: null,
      capabilityLevel: 'SIMPLE',
      source: 'PROVIDER_DB',
    };
    const mockProviderConfigResolver = {
      resolveByCapability: vi.fn().mockResolvedValue(localProviderConfig),
      resolveByProvider: vi.fn().mockResolvedValue(localProviderConfig),
      isProviderEnabled: vi.fn().mockResolvedValue(true),
      getAll: vi.fn().mockResolvedValue([]),
      getActiveModelsForProvider: vi.fn().mockResolvedValue([]),
      invalidate: vi.fn(),
    } as unknown as import('./provider-config-resolver.js').ProviderConfigResolver;

    const router = new AIRouter({
      clientMemoryResolver: memoryResolver,
      modelConfigResolver,
      providerConfigResolver: mockProviderConfigResolver,
      usageWriter: opts.usageWriter,
    });

    // Inject mock client into the provider cache
    const r = router as unknown as { providerCache: Map<string, AIProviderClient> };
    r.providerCache.set('LOCAL:mock-ollama:http://localhost:11434:', mockClient);

    return { router, mockClient };
  }

  // -----------------------------------------------------------------------
  // Client memory auto-injection
  // -----------------------------------------------------------------------

  describe('client memory injection', () => {
    it('injects memory from DB into systemPrompt when client has active entries', async () => {
      const client = await createClient(db);
      await createClientMemory(db, {
        clientId: client.id,
        title: 'Deadlock Playbook',
        memoryType: 'PLAYBOOK',
        content: 'Run sp_BlitzFirst when deadlocks are detected.',
      });

      const { router, mockClient } = buildIntegrationRouter(db);
      const capturedRequests: AIRequest[] = [];
      (mockClient.generate as ReturnType<typeof vi.fn>).mockImplementation(async (req: AIRequest) => {
        capturedRequests.push(req);
        return makeResponse();
      });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Analyze this issue',
        systemPrompt: 'You are an expert DBA.',
        context: { clientId: client.id, entityId: null, entityType: null },
      });

      expect(capturedRequests).toHaveLength(1);
      const systemPrompt = capturedRequests[0].systemPrompt ?? '';
      expect(systemPrompt).toContain('You are an expert DBA.');
      expect(systemPrompt).toContain('## Client Knowledge');
      expect(systemPrompt).toContain('### Deadlock Playbook (Playbook)');
      expect(systemPrompt).toContain('Run sp_BlitzFirst when deadlocks are detected.');
    });

    it('does not inject memory when client has no active entries', async () => {
      const client = await createClient(db);
      // No memory rows

      const { router, mockClient } = buildIntegrationRouter(db);
      const capturedRequests: AIRequest[] = [];
      (mockClient.generate as ReturnType<typeof vi.fn>).mockImplementation(async (req: AIRequest) => {
        capturedRequests.push(req);
        return makeResponse();
      });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Prompt',
        systemPrompt: 'Base system prompt.',
        context: { clientId: client.id, entityId: null, entityType: null },
      });

      expect(capturedRequests[0].systemPrompt).toBe('Base system prompt.');
    });

    it('respects category filtering — only injects matching-category and null-category entries', async () => {
      const client = await createClient(db);
      await createClientMemory(db, {
        clientId: client.id,
        title: 'DB Perf Guide',
        category: 'DATABASE_PERF',
        content: 'DB-specific content.',
      });
      await createClientMemory(db, {
        clientId: client.id,
        title: 'Bug Fix Guide',
        category: 'BUG_FIX',
        content: 'Bug-fix content.',
      });
      await createClientMemory(db, {
        clientId: client.id,
        title: 'Global Guide',
        category: null,
        content: 'Global content.',
      });

      const { router, mockClient } = buildIntegrationRouter(db);
      const capturedRequests: AIRequest[] = [];
      (mockClient.generate as ReturnType<typeof vi.fn>).mockImplementation(async (req: AIRequest) => {
        capturedRequests.push(req);
        return makeResponse();
      });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Prompt',
        systemPrompt: 'Base.',
        context: {
          clientId: client.id,
          entityId: null,
          entityType: null,
          ticketCategory: 'DATABASE_PERF',
        },
      });

      const systemPrompt = capturedRequests[0].systemPrompt ?? '';
      expect(systemPrompt).toContain('DB-specific content.');
      expect(systemPrompt).toContain('Global content.');
      expect(systemPrompt).not.toContain('Bug-fix content.');
    });

    it('skipClientMemory suppresses injection when client has memory rows', async () => {
      const client = await createClient(db);
      await createClientMemory(db, {
        clientId: client.id,
        title: 'Secret Guide',
        content: 'This should not appear.',
      });

      const { router, mockClient } = buildIntegrationRouter(db);
      const capturedRequests: AIRequest[] = [];
      (mockClient.generate as ReturnType<typeof vi.fn>).mockImplementation(async (req: AIRequest) => {
        capturedRequests.push(req);
        return makeResponse();
      });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Prompt',
        systemPrompt: 'Original system prompt.',
        context: {
          clientId: client.id,
          entityId: null,
          entityType: null,
          skipClientMemory: true,
        },
      });

      const systemPrompt = capturedRequests[0].systemPrompt ?? '';
      expect(systemPrompt).toBe('Original system prompt.');
      expect(systemPrompt).not.toContain('This should not appear.');
    });
  });

  // -----------------------------------------------------------------------
  // ModelConfigResolver — provider/model/maxTokens from DB
  // -----------------------------------------------------------------------

  describe('ModelConfigResolver integration', () => {
    it('picks up APP_WIDE maxTokens from DB', async () => {
      await createAiModelConfig(db, {
        taskType: TaskType.TRIAGE,
        scope: 'APP_WIDE',
        clientId: null,
        provider: AIProvider.LOCAL,
        model: 'mock-ollama',
        maxTokens: 3000,
      });

      const { router, mockClient } = buildIntegrationRouter(db);
      const capturedRequests: AIRequest[] = [];
      (mockClient.generate as ReturnType<typeof vi.fn>).mockImplementation(async (req: AIRequest) => {
        capturedRequests.push(req);
        return makeResponse();
      });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Prompt',
        // no maxTokens on request
        context: { entityId: null, entityType: null },
      });

      expect(capturedRequests[0].maxTokens).toBe(3000);
    });

    it('CLIENT-scoped maxTokens overrides APP_WIDE', async () => {
      const client = await createClient(db);

      await createAiModelConfig(db, {
        taskType: TaskType.TRIAGE,
        scope: 'APP_WIDE',
        clientId: null,
        provider: AIProvider.LOCAL,
        model: 'mock-ollama',
        maxTokens: 3000,
      });
      await createAiModelConfig(db, {
        taskType: TaskType.TRIAGE,
        scope: 'CLIENT',
        clientId: client.id,
        provider: AIProvider.LOCAL,
        model: 'mock-ollama',
        maxTokens: 1500,
      });

      const { router, mockClient } = buildIntegrationRouter(db);
      const capturedRequests: AIRequest[] = [];
      (mockClient.generate as ReturnType<typeof vi.fn>).mockImplementation(async (req: AIRequest) => {
        capturedRequests.push(req);
        return makeResponse();
      });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Prompt',
        context: { clientId: client.id, entityId: null, entityType: null },
      });

      expect(capturedRequests[0].maxTokens).toBe(1500);
    });

    it('request-level maxTokens is not overridden by DB config', async () => {
      await createAiModelConfig(db, {
        taskType: TaskType.TRIAGE,
        scope: 'APP_WIDE',
        clientId: null,
        provider: AIProvider.LOCAL,
        model: 'mock-ollama',
        maxTokens: 3000,
      });

      const { router, mockClient } = buildIntegrationRouter(db);
      const capturedRequests: AIRequest[] = [];
      (mockClient.generate as ReturnType<typeof vi.fn>).mockImplementation(async (req: AIRequest) => {
        capturedRequests.push(req);
        return makeResponse();
      });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Prompt',
        maxTokens: 512,
        context: { entityId: null, entityType: null },
      });

      expect(capturedRequests[0].maxTokens).toBe(512);
    });
  });

  // -----------------------------------------------------------------------
  // usageWriter — ai_usage_logs row written per call
  // -----------------------------------------------------------------------

  describe('usageWriter — ai_usage_logs written per generate()', () => {
    it('calls usageWriter with entityId, entityType, clientId from context', async () => {
      const client = await createClient(db);
      const writtenEntries: AiUsageEntry[] = [];
      const usageWriter: AiUsageWriter = vi.fn().mockImplementation(async (e: AiUsageEntry) => {
        writtenEntries.push(e);
        return 'log-id';
      });

      const { router } = buildIntegrationRouter(db, { usageWriter });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Prompt',
        context: {
          entityId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          entityType: 'ticket',
          clientId: client.id,
        },
      });
      // usageWriter is fire-and-forget; flush the microtask queue to let it settle.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(writtenEntries).toHaveLength(1);
      expect(writtenEntries[0].entityId).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
      expect(writtenEntries[0].entityType).toBe('ticket');
      expect(writtenEntries[0].clientId).toBe(client.id);
    });

    it('writes null entityId/entityType/clientId when explicit-null context', async () => {
      const writtenEntries: AiUsageEntry[] = [];
      const usageWriter: AiUsageWriter = vi.fn().mockImplementation(async (e: AiUsageEntry) => {
        writtenEntries.push(e);
        return 'log-id';
      });

      const { router } = buildIntegrationRouter(db, { usageWriter });

      await router.generate({
        taskType: TaskType.TRIAGE,
        prompt: 'Cross-ticket',
        context: { entityType: null, entityId: null, clientId: null },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(writtenEntries).toHaveLength(1);
      expect(writtenEntries[0].entityId).toBeNull();
      expect(writtenEntries[0].entityType).toBeNull();
      expect(writtenEntries[0].clientId).toBeNull();
    });

    it('calls usageWriter with entityId, entityType, clientId for generateWithTools', async () => {
      const client = await createClient(db);
      const writtenEntries: AiUsageEntry[] = [];
      const usageWriter: AiUsageWriter = vi.fn().mockImplementation(async (e: AiUsageEntry) => {
        writtenEntries.push(e);
        return 'log-id';
      });

      const { router } = buildIntegrationRouter(db, { usageWriter });

      await router.generateWithTools({
        taskType: TaskType.TRIAGE,
        tools: [],
        messages: [{ role: 'user', content: 'Analyze' }],
        context: {
          entityId: 'b1ffbc00-9c0b-4ef8-bb6d-6bb9bd380a22',
          entityType: 'operational_task',
          clientId: client.id,
        },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(writtenEntries).toHaveLength(1);
      expect(writtenEntries[0].entityId).toBe('b1ffbc00-9c0b-4ef8-bb6d-6bb9bd380a22');
      expect(writtenEntries[0].entityType).toBe('operational_task');
      expect(writtenEntries[0].clientId).toBe(client.id);
    });
  });
});
