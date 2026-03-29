import type { TaskType, AIProvider, AIRequest, AIResponse, AIToolRequest, AIToolResponse } from '@bronco/shared-types';
import type { ClientMemoryResolver } from './client-memory-resolver.js';
import type { ModelConfigResolver } from './model-config-resolver.js';
import type { PromptResolver } from './prompt-resolver.js';
import type { ProviderConfigResolver } from './provider-config-resolver.js';

export type { TaskType, AIProvider, AIRequest, AIResponse, AIToolRequest, AIToolResponse };

export interface AIProviderClient {
  generate(request: AIRequest): Promise<AIResponse>;
  generateWithTools?(request: AIToolRequest): Promise<AIToolResponse>;
}

/** Entry written to persistent storage for every AI generation call. */
export interface AiUsageEntry {
  provider: string;
  model: string;
  taskType: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  costUsd: number | null;
  entityId: string | null;
  entityType: string | null;
  clientId: string | null;
  promptKey: string | null;
  promptText: string | null;
  responseText: string | null;
  billingMode?: string;
}

/** Callback that persists an AI usage entry — injected by the host service. */
export type AiUsageWriter = (entry: AiUsageEntry) => Promise<void>;

/** Callback that looks up cost per 1M tokens for a provider+model pair. Returns null if unknown. */
export type AiCostLookup = (provider: string, model: string) => Promise<{ inputCostPer1m: number; outputCostPer1m: number } | null>;

export interface AIRouterConfig {
  /** Optional DB-backed resolver for per-client operational knowledge injection. */
  clientMemoryResolver?: ClientMemoryResolver;
  /** Optional DB-backed resolver for dynamic per-task/per-client model config. */
  modelConfigResolver?: ModelConfigResolver;
  /** Optional DB-backed resolver for provider configs (auto-routing by capability). */
  providerConfigResolver?: ProviderConfigResolver;
  /** Optional DB-backed resolver for prompt overrides (prepend/append per client). */
  promptResolver?: PromptResolver;
  /** Optional writer to persist AI usage logs to the database. */
  usageWriter?: AiUsageWriter;
  /** Optional lookup to resolve per-model cost rates. */
  costLookup?: AiCostLookup;
  /** Optional resolver that returns a decrypted BYOK API key for a client+provider. */
  byokCredentialResolver?: (clientId: string, provider: string) => Promise<string | null>;
  /** Optional resolver that returns the client's aiMode ('platform' | 'byok'). */
  clientAiModeResolver?: (clientId: string) => Promise<string | null>;
}
