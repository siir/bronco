import type { PrismaClient } from '@bronco/db';
import { AIProvider } from '@bronco/shared-types';
import { createLogger, type AppLogger } from '@bronco/shared-utils';

const logger = createLogger('model-catalog-refresher');

// ---------------------------------------------------------------------------
// OpenRouter integration — single public API with models + pricing
// ---------------------------------------------------------------------------

/** Map OpenRouter provider prefixes to our AIProvider keys. */
const OPENROUTER_PROVIDER_MAP: Partial<Record<string, AIProvider>> = {
  anthropic: AIProvider.CLAUDE,
  openai: AIProvider.OPENAI,
  'x-ai': AIProvider.GROK,
  google: AIProvider.GOOGLE,
};

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  max_completion_tokens?: number;
  architecture?: { modality?: string; tokenizer?: string };
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { context_length?: number; max_completion_tokens?: number; is_moderated?: boolean };
}

export interface FetchedModel {
  provider: AIProvider;
  model: string;
  displayName: string;
  description: string | null;
  inputCostPer1m: number;
  outputCostPer1m: number;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  modality: string | null;
}

/**
 * Fetch the current model catalog + pricing from OpenRouter's public API.
 * No API key required. Returns models for CLAUDE, OPENAI, GROK, GOOGLE
 * with full metadata (pricing, context length, modality, etc.).
 */
export async function fetchFromOpenRouter(): Promise<FetchedModel[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'User-Agent': 'Bronco/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);

  const json = (await res.json()) as { data: OpenRouterModel[] };
  if (!Array.isArray(json.data)) throw new Error('Unexpected OpenRouter response shape');

  const results: FetchedModel[] = [];
  for (const m of json.data) {
    const slashIdx = m.id.indexOf('/');
    if (slashIdx === -1) continue;

    const prefix = m.id.substring(0, slashIdx);
    const provider = OPENROUTER_PROVIDER_MAP[prefix];
    if (!provider) continue;

    // Normalize model ID: Anthropic SDK returns dashes (claude-sonnet-4-6) but
    // OpenRouter uses dots (claude-sonnet-4.6). Align to what the SDK returns.
    const rawModelId = m.id.substring(slashIdx + 1);
    const modelId = provider === AIProvider.CLAUDE ? rawModelId.replace(/\./g, '-') : rawModelId;
    if (!m.pricing?.prompt || !m.pricing?.completion) continue;
    const inputPerToken = parseFloat(m.pricing.prompt);
    const outputPerToken = parseFloat(m.pricing.completion);
    if (!Number.isFinite(inputPerToken) || !Number.isFinite(outputPerToken)) continue;

    // Strip "Provider: " prefix from display name
    const displayName = m.name?.replace(/^[^:]+:\s*/, '') ?? modelId;

    results.push({
      provider,
      model: modelId,
      displayName,
      description: m.description ?? null,
      inputCostPer1m: Math.round(inputPerToken * 1_000_000 * 100) / 100,
      outputCostPer1m: Math.round(outputPerToken * 1_000_000 * 100) / 100,
      contextLength: m.top_provider?.context_length ?? m.context_length ?? null,
      maxCompletionTokens: m.top_provider?.max_completion_tokens ?? m.max_completion_tokens ?? null,
      modality: m.architecture?.modality ?? null,
    });
  }

  return results;
}

/**
 * Fetch installed models from a LOCAL (Ollama) instance — always $0 cost.
 */
export async function fetchOllamaModels(baseUrl: string): Promise<FetchedModel[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];

    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).map((m) => ({
      provider: AIProvider.LOCAL,
      model: m.name,
      displayName: `${m.name} (local)`,
      description: null,
      inputCostPer1m: 0,
      outputCostPer1m: 0,
      contextLength: null,
      maxCompletionTokens: null,
      modality: 'text->text',
    }));
  } catch {
    logger.warn({ baseUrl }, 'Failed to reach Ollama for model list');
    return [];
  }
}

/**
 * Run a full model catalog refresh — called by the daily scheduled job
 * and the manual refresh endpoint. Fetches from OpenRouter + Ollama,
 * upserts into the costs table, and logs results.
 */
export async function refreshModelCatalog(db: PrismaClient, appLog?: AppLogger): Promise<{
  source: string;
  updated: number;
  skipped: number;
  newModels: number;
}> {
  const start = Date.now();

  // Load custom cost models to protect
  const customCosts = await db.aiModelCost.findMany({
    where: { isCustomCost: true },
    select: { provider: true, model: true },
  });
  const customKeys = new Set(customCosts.map((c) => `${c.provider}:${c.model}`));

  // Load existing model keys for tracking new additions
  const existingModels = await db.aiModelCost.findMany({
    select: { provider: true, model: true },
  });
  const existingKeys = new Set(existingModels.map((c) => `${c.provider}:${c.model}`));

  let models: FetchedModel[] = [];
  let source = 'openrouter';

  // 1. Fetch from OpenRouter
  try {
    const openRouterModels = await fetchFromOpenRouter();
    models.push(...openRouterModels);
    logger.info({ count: openRouterModels.length }, 'Fetched models from OpenRouter');
  } catch (err) {
    logger.error({ err }, 'OpenRouter fetch failed during scheduled refresh');
    appLog?.error('Model catalog refresh failed: OpenRouter unreachable', {
      error: err instanceof Error ? err.message : 'Unknown',
    });
    source = 'failed';
  }

  // 2. Fetch LOCAL models from configured Ollama instances
  const localProviders = await db.aiProvider.findMany({
    where: { provider: 'LOCAL', isActive: true },
    select: { baseUrl: true },
  });
  for (const lp of localProviders) {
    if (lp.baseUrl) {
      const ollamaModels = await fetchOllamaModels(lp.baseUrl);
      models.push(...ollamaModels);
    }
  }

  // If no models were fetched from any source, throw so BullMQ marks the job as failed
  if (models.length === 0 && source === 'failed') {
    throw new Error('Model catalog refresh failed: no models fetched from any source');
  }

  // 3. Update existing model costs only — do not create new records
  let updated = 0;
  let skipped = 0;
  const newModels = 0;
  for (const m of models) {
    if (!m.provider || !m.model || !Number.isFinite(m.inputCostPer1m) || !Number.isFinite(m.outputCostPer1m)) continue;
    if (customKeys.has(`${m.provider}:${m.model}`)) {
      skipped++;
      continue;
    }
    if (!existingKeys.has(`${m.provider}:${m.model}`)) {
      skipped++;
      continue;
    }
    await db.aiModelCost.update({
      where: { provider_model: { provider: m.provider, model: m.model } },
      data: {
        displayName: m.displayName ?? null,
        description: m.description ?? undefined,
        inputCostPer1m: m.inputCostPer1m,
        outputCostPer1m: m.outputCostPer1m,
        contextLength: m.contextLength ?? undefined,
        maxCompletionTokens: m.maxCompletionTokens ?? undefined,
        modality: m.modality ?? undefined,
        isActive: true,
      },
    });
    updated++;
  }

  const durationMs = Date.now() - start;
  const summary = { source, updated, skipped, newModels, durationMs };
  logger.info(summary, 'Model catalog refresh completed');
  appLog?.info(
    `Model catalog refresh: ${updated} updated, ${newModels} new, ${skipped} custom-protected (${durationMs}ms via ${source})`,
    summary,
  );

  return { source, updated, skipped, newModels };
}
