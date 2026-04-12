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
  logId?: string;         // Pre-generated UUID for this entry's row ID
  parentLogId?: string;   // FK to parent log entry
  parentLogType?: 'ai' | 'app';
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
  systemPrompt: string | null;
  responseText: string | null;
  billingMode?: string;
  conversationMetadata?: ConversationMetadata | null;
  taskRun?: number | null;
}

/** Lightweight conversation metadata persisted permanently on the usage log. */
export interface ConversationMetadata {
  messageCount: number;
  totalContextTokens: number;
  messages: Array<{ role: string; tokenCount?: number; toolName?: string }>;
  orchestrationId?: string;
  orchestrationIteration?: number;
  isSubTask?: boolean;
}

/** Data written to the prompt archive table alongside a usage log entry. */
export interface AiArchiveEntry {
  usageLogId: string;
  fullPrompt: string;
  fullResponse: string;
  systemPrompt: string | null;
  conversationMessages: Array<{ role: string; tokenCount?: number; toolName?: string }> | null;
  totalContextTokens: number | null;
  messageCount: number | null;
}

/** Callback that persists an AI usage entry — injected by the host service. */
export type AiUsageWriter = (entry: AiUsageEntry) => Promise<string | void>;

/** Callback that persists an AI prompt archive entry — injected by the host service. */
export type AiArchiveWriter = (entry: AiArchiveEntry) => Promise<void>;

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
  /** Optional writer to persist full AI prompt/response archives to the database. */
  archiveWriter?: AiArchiveWriter;
  /** Optional lookup to resolve per-model cost rates. */
  costLookup?: AiCostLookup;
  /** Optional resolver that returns a decrypted BYOK API key for a client+provider. */
  byokCredentialResolver?: (clientId: string, provider: string) => Promise<string | null>;
  /** Optional resolver that returns the client's aiMode ('platform' | 'byok'). */
  clientAiModeResolver?: (clientId: string) => Promise<string | null>;
  /**
   * Optional loader for the global default maxTokens (AnalysisStrategy.defaultMaxTokens).
   * Used as the final fallback in the maxTokens resolution chain, after request,
   * prompt-resolved, and per-task/client AiModelConfig values.
   */
  defaultMaxTokensLoader?: () => Promise<number | undefined>;
}
