import { decrypt, createLogger } from '@bronco/shared-utils';
import { AIRouter } from './router.js';
import { ClientMemoryResolver } from './client-memory-resolver.js';
import type { ClientMemoryRow } from './client-memory-resolver.js';
import { ModelConfigResolver } from './model-config-resolver.js';
import type { ModelConfigRow } from './model-config-resolver.js';
import { ProviderConfigResolver } from './provider-config-resolver.js';
import type { ProviderConfigRow } from './provider-config-resolver.js';
import { PromptResolver } from './prompt-resolver.js';
import type { PromptOverrideRow } from './prompt-resolver.js';
import type { AiUsageEntry, AiArchiveEntry, AiCostLookup } from './types.js';

const log = createLogger('ai-router');

/**
 * Hardcoded fallback rates for known Anthropic (Claude) models.
 * Used when the ai_model_costs table doesn't have a row for the model —
 * which commonly happens for Haiku calls made before the catalog was seeded.
 *
 * Rates are per 1M tokens (USD). Source: Anthropic pricing page (2025-01).
 * TODO(#385): Remove once all deployments have seeded ai_model_costs with these models.
 * Key is a substring of the model ID for prefix-matching.
 */
const CLAUDE_FALLBACK_RATES: Array<{ pattern: RegExp; inputCostPer1m: number; outputCostPer1m: number }> = [
  // claude-haiku-4-5 (e.g. claude-haiku-4-5-20251001) — $0.80/$4.00 per 1M tokens
  { pattern: /claude-haiku-4-5/i, inputCostPer1m: 0.80, outputCostPer1m: 4.00 },
  // claude-haiku-3 — $0.25/$1.25 per 1M tokens
  { pattern: /claude-haiku-3/i, inputCostPer1m: 0.25, outputCostPer1m: 1.25 },
  // claude-3-5-haiku / claude-3-haiku aliases
  { pattern: /claude-3[-.]5-haiku/i, inputCostPer1m: 0.80, outputCostPer1m: 4.00 },
  { pattern: /claude-3-haiku/i, inputCostPer1m: 0.25, outputCostPer1m: 1.25 },
];

/**
 * Minimal database interface required by createAIRouter.
 * Matches the relevant Prisma model delegates so any PrismaClient works
 * without importing the generated client into this shared package.
 */
export interface AIRouterDb {
  clientMemory: {
    findMany(args: { where: { clientId: string; isActive: boolean } }): Promise<
      Array<{
        id: string;
        clientId: string;
        title: string;
        memoryType: string;
        category: string | null;
        tags: string[];
        content: string;
        isActive: boolean;
        sortOrder: number;
        source: string;
      }>
    >;
  };
  aiModelConfig: {
    findMany(args: { where: { isActive: boolean } }): Promise<
      Array<{
        taskType: string;
        scope: string;
        clientId: string | null;
        provider: string;
        model: string;
        maxTokens: number | null;
        isActive: boolean;
      }>
    >;
  };
  aiProvider: {
    findMany(args?: Record<string, unknown>): Promise<
      Array<{
        id: string;
        provider: string;
        baseUrl: string | null;
        encryptedApiKey: string | null;
        isActive: boolean;
      }>
    >;
  };
  promptOverride: {
    findMany(args: { where: { promptKey: string; isActive: boolean } }): Promise<
      Array<{
        promptKey: string;
        scope: string;
        clientId: string | null;
        position: string;
        content: string;
        isActive: boolean;
      }>
    >;
  };
  aiUsageLog: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  aiPromptArchive: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  clientAiCredential: {
    findFirst(args: {
      where: { clientId: string; provider: string; isActive: boolean };
      orderBy?: Record<string, 'asc' | 'desc'>;
    }): Promise<{ encryptedApiKey: string } | null>;
  };
  client: {
    findUnique(args: { where: { id: string }; select: { aiMode: true } }): Promise<{ aiMode: string } | null>;
  };
  aiModelCost: {
    findMany(args: { where: { isActive: boolean } }): Promise<
      Array<{
        provider: string;
        model: string;
        inputCostPer1m: number;
        outputCostPer1m: number;
      }>
    >;
  };
}

/** Config object accepted by createAIRouter. */
export interface CreateAIRouterConfig {
  /** Encryption key for decrypting API keys stored in the DB. */
  encryptionKey: string;
  /**
   * Optional loader for the global default maxTokens (AnalysisStrategy.defaultMaxTokens).
   * Used as the final fallback in the maxTokens resolution chain.
   */
  defaultMaxTokensLoader?: () => Promise<number | undefined>;
}

/**
 * Options for fine-tuning the factory behaviour.
 */
export interface CreateAIRouterOptions {
  /**
   * When true, DB fetchers return empty arrays / no-op until the caller
   * flips the returned `setDbReady` callback. Useful for Fastify-style
   * apps where the DB plugin registers after the AIRouter is constructed.
   */
  deferDb?: boolean;
}

export interface CreateAIRouterResult {
  ai: AIRouter;
  clientMemoryResolver: ClientMemoryResolver;
  modelConfigResolver: ModelConfigResolver;
  providerConfigResolver: ProviderConfigResolver;
  /**
   * Call this once the database is ready (only meaningful when
   * `deferDb: true` was passed to createAIRouter).
   */
  setDbReady: () => void;
}

/**
 * Factory that wires up an AIRouter with ModelConfigResolver, ProviderConfigResolver,
 * PromptResolver, usageWriter (persists to ai_usage_logs), and costLookup (5-min cached
 * read from ai_model_costs) — eliminating boilerplate per service.
 *
 * @param db     A Prisma client (or any object implementing {@link AIRouterDb})
 * @param config AI provider connection settings
 * @param opts   Optional tweaks (e.g. deferDb to delay DB reads until signalled)
 */
export function createAIRouter(
  db: AIRouterDb,
  config: CreateAIRouterConfig,
  opts?: CreateAIRouterOptions,
): CreateAIRouterResult {
  let dbReady = !opts?.deferDb;

  const modelConfigResolver = new ModelConfigResolver(async () => {
    if (!dbReady) return [];
    const rows = await db.aiModelConfig.findMany({ where: { isActive: true } });
    return rows.map((r): ModelConfigRow => ({
      taskType: r.taskType,
      scope: r.scope as 'APP_WIDE' | 'CLIENT',
      clientId: r.clientId,
      provider: r.provider,
      model: r.model,
      maxTokens: r.maxTokens,
      isActive: r.isActive,
    }));
  });

  const providerConfigResolver = new ProviderConfigResolver(async () => {
    if (!dbReady) return [];
    // Fetch ALL providers with their models (both active and inactive)
    // so the resolver can distinguish "disabled" from "unmanaged".
    // Cast to include the `models` relation which is loaded via the `include` arg.
    const providers = await db.aiProvider.findMany({
      include: { models: true },
    } as Record<string, unknown>) as Array<{
      id: string;
      provider: string;
      baseUrl: string | null;
      encryptedApiKey: string | null;
      isActive: boolean;
      models: Array<{
        id: string;
        name: string;
        model: string;
        capabilityLevel: string;
        isActive: boolean;
        enabledApps: string[];
      }>;
    }>;

    const rows: ProviderConfigRow[] = [];
    for (const p of providers) {
      let apiKey: string | null = null;
      if (p.encryptedApiKey && config.encryptionKey) {
        try {
          apiKey = decrypt(p.encryptedApiKey, config.encryptionKey);
        } catch (err) {
          log.warn(
            { err, providerId: p.id, provider: p.provider },
            'Failed to decrypt API key for provider',
          );
          continue;
        }
      }

      for (const m of p.models) {
        rows.push({
          id: m.id,
          providerId: p.id,
          name: m.name,
          provider: p.provider,
          baseUrl: p.baseUrl,
          apiKey,
          model: m.model,
          capabilityLevel: m.capabilityLevel,
          isActive: m.isActive,
          providerActive: p.isActive,
          enabledApps: m.enabledApps,
        });
      }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  });

  const promptResolver = new PromptResolver(async (key) => {
    if (!dbReady) return [];
    const rows = await db.promptOverride.findMany({
      where: { promptKey: key, isActive: true },
    });
    return rows.map((r): PromptOverrideRow => ({
      promptKey: r.promptKey,
      scope: r.scope as 'APP_WIDE' | 'CLIENT',
      clientId: r.clientId,
      position: r.position as 'PREPEND' | 'APPEND',
      content: r.content,
      isActive: r.isActive,
    }));
  });

  const usageWriter = async (entry: AiUsageEntry): Promise<string | undefined> => {
    if (!dbReady) return undefined;
    // Prisma JSON fields need undefined (not null) for "no value" — strip null conversationMetadata
    const { conversationMetadata, logId, ...rest } = entry;
    const data = {
      ...(logId ? { id: logId } : {}),
      ...(conversationMetadata != null
        ? { ...rest, conversationMetadata: conversationMetadata as unknown as Record<string, unknown> }
        : rest),
    };
    const row = await db.aiUsageLog.create({ data: data as Record<string, unknown> });
    return row.id;
  };

  const archiveWriter = async (entry: AiArchiveEntry): Promise<void> => {
    if (!dbReady) return;
    // Cast conversationMessages to satisfy Prisma's JSON type
    const { conversationMessages, ...rest } = entry;
    const data: Record<string, unknown> = { ...rest };
    if (conversationMessages != null) {
      data.conversationMessages = conversationMessages;
    }
    await db.aiPromptArchive.create({ data });
  };

  let costCache: Map<string, { inputCostPer1m: number; outputCostPer1m: number }> | null = null;
  let costCacheAt = 0;
  const costLookup: AiCostLookup = async (provider, model) => {
    const now = Date.now();
    if (!costCache || now - costCacheAt > 5 * 60 * 1000) {
      if (!dbReady) return null;
      const rows = await db.aiModelCost.findMany({ where: { isActive: true } });
      costCache = new Map();
      for (const r of rows) {
        costCache.set(`${r.provider}:${r.model}`, {
          inputCostPer1m: r.inputCostPer1m,
          outputCostPer1m: r.outputCostPer1m,
        });
      }
      costCacheAt = now;
    }
    const dbRate = costCache.get(`${provider}:${model}`);
    if (dbRate) return dbRate;

    // Fallback: use hardcoded rates for known Anthropic Haiku model IDs that may
    // not yet be seeded in ai_model_costs. This prevents cost_usd from staying NULL
    // on Haiku calls (DETECT_TOOL_GAPS etc.) when the catalog hasn't been seeded.
    if (provider === 'CLAUDE') {
      for (const { pattern, inputCostPer1m, outputCostPer1m } of CLAUDE_FALLBACK_RATES) {
        if (pattern.test(model)) {
          return { inputCostPer1m, outputCostPer1m };
        }
      }
    }

    return null;
  };

  const clientMemoryResolver = new ClientMemoryResolver(async (clientId) => {
    if (!dbReady) return [];
    const rows = await db.clientMemory.findMany({
      where: { clientId, isActive: true },
    });
    return rows.map((r): ClientMemoryRow => ({
      id: r.id,
      clientId: r.clientId,
      title: r.title,
      memoryType: r.memoryType,
      category: r.category,
      tags: r.tags,
      content: r.content,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      source: r.source,
    }));
  });

  const byokCredentialResolver = async (clientId: string, provider: string): Promise<string | null> => {
    if (!dbReady) return null;
    const cred = await db.clientAiCredential.findFirst({
      where: { clientId, provider, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!cred) return null;
    try {
      return decrypt(cred.encryptedApiKey, config.encryptionKey);
    } catch {
      log.warn({ clientId, provider }, 'Failed to decrypt BYOK credential');
      return null;
    }
  };

  const clientAiModeResolver = async (clientId: string): Promise<string | null> => {
    if (!dbReady) return null;
    const c = await db.client.findUnique({ where: { id: clientId }, select: { aiMode: true } });

    return c?.aiMode ?? null;
  };

  const ai = new AIRouter({
    clientMemoryResolver,
    modelConfigResolver,
    providerConfigResolver,
    promptResolver,
    usageWriter,
    archiveWriter,
    costLookup,
    byokCredentialResolver,
    clientAiModeResolver,
    defaultMaxTokensLoader: config.defaultMaxTokensLoader,
  });

  return {
    ai,
    clientMemoryResolver,
    modelConfigResolver,
    providerConfigResolver,
    setDbReady: () => { dbReady = true; },
  };
}
