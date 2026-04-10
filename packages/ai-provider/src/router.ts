import { createHash } from 'node:crypto';
import { type TaskType, AIProvider, TASK_APP_SCOPE } from '@bronco/shared-types';
import type { AIRequest, AIToolRequest, AIToolResponse, AIMessage } from '@bronco/shared-types';
import { createLogger } from '@bronco/shared-utils';
import type { ClientMemoryResolver } from './client-memory-resolver.js';
import type { AIProviderClient, AIRouterConfig, AIResponse, AiUsageWriter, AiArchiveWriter, AiCostLookup, ConversationMetadata } from './types.js';
import { OllamaClient } from './ollama.js';
import { ClaudeClient } from './claude.js';
import { OpenAIClient } from './openai.js';
import type { ModelConfigResolver } from './model-config-resolver.js';
import type { ProviderConfigResolver } from './provider-config-resolver.js';
import type { PromptResolver } from './prompt-resolver.js';
import { TASK_CAPABILITY_REQUIREMENTS } from './task-capabilities.js';

const logger = createLogger('ai-usage');

/** Truncate a string to `maxLen` characters, returning null if the input is nullish or empty. */
function truncate(value: string | undefined | null, maxLen: number): string | null {
  if (!value) return null;
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

/** Extract the text content of the last user message from a messages array. */
function extractLastUserMessage(messages: AIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content;
      // For structured content blocks, concatenate text blocks
      if (Array.isArray(content)) {
        const textParts = content
          .filter((b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text')
          .map((b) => b.text);
        if (textParts.length > 0) return textParts.join('\n');
      }
      // No text content in this user message (e.g. tool_result-only) — keep scanning
      continue;
    }
  }
  return null;
}

/** Providers that have a concrete client implementation in getOrCreateProvider(). */
const ROUTABLE_PROVIDERS: Set<string> = new Set([AIProvider.LOCAL, AIProvider.CLAUDE, AIProvider.OPENAI, AIProvider.GROK]);

/**
 * Preview of the resolved provider + model for a given task type,
 * mirroring the runtime routing logic in getProvider().
 */
export interface ResolvedPreview {
  provider: string;
  model: string;
  source: 'CLIENT' | 'APP_WIDE' | 'DEFAULT' | 'CAPABILITY' | 'NONE';
  /** When true, the model-config override was skipped because the provider is unavailable. */
  overrideSkipped?: boolean;
}

/**
 * Thrown when an explicit provider/model override references a model that is
 * not registered as active for that provider. Maps to HTTP 400 via the
 * `statusCode` property picked up by copilot-api's generic error handler.
 */
export class InvalidModelError extends Error {
  public readonly statusCode = 400;
  public readonly provider: string;
  public readonly model: string;

  constructor(provider: string, model: string, available: string[]) {
    super(
      `Model "${model}" is not a valid active model for provider "${provider}". ` +
      `Available models: ${available.join(', ')}`,
    );
    this.name = 'InvalidModelError';
    this.provider = provider;
    this.model = model;
  }
}

/**
 * Thrown when a resolved provider has no client implementation (e.g. GOOGLE).
 * Callers should catch this and return a clean 422 instead of an unhandled 500.
 */
export class NoProviderImplementationError extends Error {
  public readonly provider: string;
  public readonly model: string;

  constructor(provider: string, model: string) {
    super(
      `AI provider "${provider}" with model "${model}" is registered but has no client implementation. ` +
      `Routable providers: ${[...ROUTABLE_PROVIDERS].join(', ')}.`,
    );
    this.name = 'NoProviderImplementationError';
    this.provider = provider;
    this.model = model;
  }
}

export class AIRouter {
  private clientMemoryResolver: ClientMemoryResolver | undefined;
  private modelConfigResolver: ModelConfigResolver | undefined;
  private providerConfigResolver: ProviderConfigResolver | undefined;
  private promptResolver: PromptResolver | undefined;
  private usageWriter: AiUsageWriter | undefined;
  private archiveWriter: AiArchiveWriter | undefined;
  private costLookup: AiCostLookup | undefined;
  private byokCredentialResolver: ((clientId: string, provider: string) => Promise<string | null>) | undefined;
  private clientAiModeResolver: ((clientId: string) => Promise<string | null>) | undefined;

  /** Cache of provider instances keyed by provider, model, baseUrl, and a hash of the apiKey (see getOrCreateProvider()). */
  private providerCache = new Map<string, AIProviderClient>();

  constructor(config: AIRouterConfig) {
    this.clientMemoryResolver = config.clientMemoryResolver;
    this.modelConfigResolver = config.modelConfigResolver;
    this.providerConfigResolver = config.providerConfigResolver;
    this.promptResolver = config.promptResolver;
    this.usageWriter = config.usageWriter;
    this.archiveWriter = config.archiveWriter;
    this.costLookup = config.costLookup;
    this.byokCredentialResolver = config.byokCredentialResolver;
    this.clientAiModeResolver = config.clientAiModeResolver;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const clientId = request.context?.clientId as string | undefined;

    // Resolve prompt overrides when a promptKey is provided
    let finalRequest = request;
    if (request.promptKey) {
      if (this.promptResolver) {
        const resolved = await this.promptResolver.resolve(request.promptKey, clientId);
        finalRequest = {
          ...request,
          systemPrompt: resolved.content,
          temperature: request.temperature ?? resolved.temperature ?? undefined,
          maxTokens: request.maxTokens ?? resolved.maxTokens ?? undefined,
        };
      } else {
        logger.warn(
          { promptKey: request.promptKey, clientId: clientId ?? null, taskType: request.taskType },
          'promptKey provided but no PromptResolver configured; proceeding without resolved systemPrompt',
        );
      }
    }

    // Auto-inject client memory into the system prompt when clientId is present.
    // The caller can disable this by setting context.skipClientMemory = true
    // (e.g., the LOAD_CLIENT_CONTEXT step handles injection itself).
    if (this.clientMemoryResolver && clientId && !request.context?.skipClientMemory) {
      const category = request.context?.ticketCategory as string | undefined;
      const memory = await this.clientMemoryResolver.resolve(clientId, { category });
      if (memory.entryCount > 0) {
        finalRequest = {
          ...finalRequest,
          systemPrompt: finalRequest.systemPrompt
            ? `${finalRequest.systemPrompt}\n\n${memory.content}`
            : memory.content,
        };
        logger.debug(
          { clientId, category, entryCount: memory.entryCount, taskType: request.taskType },
          'Injected client memory into AI request',
        );
      }
    }

    // Resolve model config for maxTokens fallback (DB config → prompt config → request)
    if (!finalRequest.maxTokens && this.modelConfigResolver) {
      const modelConfig = await this.modelConfigResolver.resolve(finalRequest.taskType, clientId);
      if (modelConfig.maxTokens) {
        finalRequest = { ...finalRequest, maxTokens: modelConfig.maxTokens };
      }
    }

    // Use explicit provider/model override if provided, bypassing normal routing.
    // Cache the clientAiMode result here so we don't call the resolver twice
    // (once in getProvider() and again below for billing mode).
    // Skip the resolver entirely when an explicit override is used — it is not
    // needed for routing and billing is always forced to 'platform' in that case.
    const usedExplicitOverride = !!(request.providerOverride && request.modelOverride);
    const cachedAiMode = !usedExplicitOverride && clientId
      ? (await this.clientAiModeResolver?.(clientId)) ?? null
      : null;
    const provider = usedExplicitOverride
      ? await this.getExplicitProvider(request.providerOverride!, request.modelOverride!, request.taskType)
      : await this.getProviderWithMode(finalRequest.taskType, clientId, cachedAiMode);
    const response = await provider.generate(finalRequest);

    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;

    // Compute cost before logging so it appears in the structured log context
    let costUsd: number | null = null;
    if (this.costLookup) {
      try {
        const rates = await this.costLookup(response.provider, response.model);
        if (rates) {
          costUsd = (inputTokens * rates.inputCostPer1m + outputTokens * rates.outputCostPer1m) / 1_000_000;
        }
      } catch {
        // Cost lookup failure is non-fatal
      }
    }

    // Structured token usage log — keyed by provider, model, and entity
    logger.info({
      taskType: request.taskType,
      provider: response.provider,
      model: response.model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      durationMs: response.durationMs,
      entityId: request.context?.entityId ?? null,
      entityType: request.context?.entityType ?? null,
      clientId: clientId ?? null,
      promptKey: request.promptKey ?? null,
    }, `AI token usage: ${response.provider}/${response.model} ${request.taskType}`);

    // Build lightweight conversation metadata (single-shot: just one user message)
    const convMeta: ConversationMetadata = {
      messageCount: 1,
      totalContextTokens: inputTokens,
      messages: [{ role: 'user', tokenCount: inputTokens }],
      ...(request.context?.orchestrationId ? { orchestrationId: request.context.orchestrationId as string } : {}),
      ...(request.context?.orchestrationIteration != null ? { orchestrationIteration: request.context.orchestrationIteration as number } : {}),
      ...(request.context?.isSubTask ? { isSubTask: true } : {}),
    };

    // Persist usage to database (fire-and-forget)
    if (this.usageWriter) {
      // Use 'platform' billing when an explicit provider/model override was used — those always
      // route through getExplicitProvider() which uses platform credentials, not BYOK keys.
      const billingMode = !usedExplicitOverride && cachedAiMode === 'byok' ? 'byok' : 'platform';
      const archiveWriter = this.archiveWriter;
      this.usageWriter({
        provider: response.provider,
        model: response.model,
        taskType: request.taskType,
        inputTokens,
        outputTokens,
        durationMs: response.durationMs ?? null,
        costUsd,
        entityId: (request.context?.entityId as string) ?? null,
        entityType: (request.context?.entityType as string) ?? null,
        clientId: clientId ?? null,
        promptKey: request.promptKey ?? null,
        promptText: truncate(finalRequest.prompt, 8000),
        systemPrompt: truncate(finalRequest.systemPrompt, 4000),
        responseText: response.content,
        billingMode,
        conversationMetadata: convMeta,
      }).then((usageLogId) => {
        if (archiveWriter && typeof usageLogId === 'string' && usageLogId) {
          archiveWriter({
            usageLogId,
            fullPrompt: finalRequest.prompt ?? '',
            fullResponse: response.content ?? '',
            systemPrompt: finalRequest.systemPrompt ?? null,
            conversationMessages: convMeta.messages,
            totalContextTokens: convMeta.totalContextTokens,
            messageCount: convMeta.messageCount,
          }).catch((err) => {
            logger.warn({ err }, 'Failed to persist AI prompt archive entry');
          });
        }
      }).catch((err) => {
        logger.warn({ err }, 'Failed to persist AI usage log entry');
      });
    }

    return response;
  }

  async generateWithTools(request: AIToolRequest): Promise<AIToolResponse> {
    const clientId = request.context?.clientId as string | undefined;

    // Resolve prompt overrides when a promptKey is provided
    let finalRequest = { ...request };
    if (request.promptKey && this.promptResolver) {
      const resolved = await this.promptResolver.resolve(request.promptKey, clientId);
      finalRequest.systemPrompt = resolved.content;
      finalRequest.temperature = request.temperature ?? resolved.temperature ?? undefined;
      finalRequest.maxTokens = request.maxTokens ?? resolved.maxTokens ?? undefined;
    }

    // Auto-inject client memory
    if (this.clientMemoryResolver && clientId && !request.context?.skipClientMemory) {
      const category = request.context?.ticketCategory as string | undefined;
      const memory = await this.clientMemoryResolver.resolve(clientId, { category });
      if (memory.entryCount > 0) {
        finalRequest.systemPrompt = finalRequest.systemPrompt
          ? `${finalRequest.systemPrompt}\n\n${memory.content}`
          : memory.content;
      }
    }

    // Resolve provider — must support generateWithTools.
    // Cache the clientAiMode result here so we don't call the resolver twice
    // (once in getProvider() and again below for billing mode).
    // Skip the resolver entirely when an explicit override is used — it is not
    // needed for routing and billing is always forced to 'platform' in that case.
    const usedExplicitOverride = !!(request.providerOverride && request.modelOverride);
    const cachedAiMode = !usedExplicitOverride && clientId
      ? (await this.clientAiModeResolver?.(clientId)) ?? null
      : null;
    const provider = usedExplicitOverride
      ? await this.getExplicitProvider(request.providerOverride!, request.modelOverride!, request.taskType)
      : await this.getProviderWithMode(finalRequest.taskType, clientId, cachedAiMode);

    if (!provider.generateWithTools) {
      throw new Error(
        `Provider does not support tool use. Only Claude providers support generateWithTools().`,
      );
    }

    const response = await provider.generateWithTools(finalRequest);

    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;

    let costUsd: number | null = null;
    if (this.costLookup) {
      try {
        const rates = await this.costLookup(response.provider, response.model);
        if (rates) {
          costUsd = (inputTokens * rates.inputCostPer1m + outputTokens * rates.outputCostPer1m) / 1_000_000;
        }
      } catch { /* non-fatal */ }
    }

    logger.info({
      taskType: request.taskType,
      provider: response.provider,
      model: response.model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      durationMs: response.durationMs,
      entityId: request.context?.entityId ?? null,
      entityType: request.context?.entityType ?? null,
      clientId: clientId ?? null,
      stopReason: response.stopReason,
    }, `AI tool-use token usage: ${response.provider}/${response.model} ${request.taskType}`);

    // Build conversation metadata from tool-use messages.
    // Per-message token counts are not available from the Anthropic API (only aggregate
    // usage.input_tokens/output_tokens); omit tokenCount to avoid misleading estimates.
    const convMessages: ConversationMetadata['messages'] = [];
    if (finalRequest.messages) {
      for (const msg of finalRequest.messages) {
        const entry: ConversationMetadata['messages'][number] = { role: msg.role };

        // Extract tool names from tool_use blocks (assistant messages)
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          const toolNames = (msg.content as Array<{ type: string; name?: string }>)
            .filter(block => block.type === 'tool_use')
            .map(block => block.name)
            .filter(Boolean);
          if (toolNames.length > 0) {
            entry.toolName = toolNames.join(', ');
          }
        }

        // Extract tool result count from tool_result blocks (user messages with results)
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const resultCount = (msg.content as Array<{ type: string }>)
            .filter(block => block.type === 'tool_result')
            .length;
          if (resultCount > 0) {
            entry.toolName = `results:${resultCount}`;
          }
        }

        convMessages.push(entry);
      }
    }
    const convMeta: ConversationMetadata = {
      messageCount: convMessages.length || 1,
      totalContextTokens: inputTokens,
      messages: convMessages.length > 0 ? convMessages : [{ role: 'user', tokenCount: inputTokens }],
      ...(request.context?.orchestrationId ? { orchestrationId: request.context.orchestrationId as string } : {}),
      ...(request.context?.orchestrationIteration != null ? { orchestrationIteration: request.context.orchestrationIteration as number } : {}),
      ...(request.context?.isSubTask ? { isSubTask: true } : {}),
    };

    if (this.usageWriter) {
      const billingMode = !usedExplicitOverride && cachedAiMode === 'byok' ? 'byok' : 'platform';
      // Extract prompt text from tool-use messages: use explicit prompt if set,
      // otherwise extract the last user message from the messages array.
      const toolPromptText = finalRequest.prompt ?? extractLastUserMessage(finalRequest.messages);
      const archiveWriter = this.archiveWriter;
      this.usageWriter({
        provider: response.provider,
        model: response.model,
        taskType: request.taskType,
        inputTokens,
        outputTokens,
        durationMs: response.durationMs ?? null,
        costUsd,
        entityId: (request.context?.entityId as string) ?? null,
        entityType: (request.context?.entityType as string) ?? null,
        clientId: clientId ?? null,
        promptKey: request.promptKey ?? null,
        promptText: truncate(toolPromptText, 8000),
        systemPrompt: truncate(finalRequest.systemPrompt, 4000),
        responseText: response.content,
        billingMode,
        conversationMetadata: convMeta,
      }).then((usageLogId) => {
        if (archiveWriter && typeof usageLogId === 'string' && usageLogId) {
          archiveWriter({
            usageLogId,
            fullPrompt: toolPromptText ?? '',
            fullResponse: response.content ?? '',
            systemPrompt: finalRequest.systemPrompt ?? null,
            conversationMessages: convMeta.messages,
            totalContextTokens: convMeta.totalContextTokens,
            messageCount: convMeta.messageCount,
          }).catch((err) => {
            logger.warn({ err }, 'Failed to persist AI prompt archive entry');
          });
        }
      }).catch((err) => {
        logger.warn({ err }, 'Failed to persist AI usage log entry');
      });
    }

    return response;
  }

  /**
   * Variant of getProvider() that accepts a pre-resolved aiMode string to avoid
   * calling clientAiModeResolver twice when the caller already has the value.
   */
  private async getProviderWithMode(taskType: string, clientId: string | undefined, cachedAiMode: string | null): Promise<AIProviderClient> {
    const appScope = TASK_APP_SCOPE[taskType as TaskType];

    // 0. BYOK mode — use client's own API key instead of platform key
    if (clientId && this.byokCredentialResolver && cachedAiMode === 'byok') {
      return this.getByokProvider(taskType, clientId, appScope);
    }

    // 1. Explicit model config overrides (CLIENT > APP_WIDE)
    if (this.modelConfigResolver) {
      const resolved = await this.modelConfigResolver.resolve(taskType, clientId);

      if (resolved.source !== 'DEFAULT') {
        const available = await this.isProviderAvailable(resolved.provider, appScope);
        if (available) {
          const providerConfig = this.providerConfigResolver
            ? await this.providerConfigResolver.resolveByProvider(resolved.provider, appScope)
            : null;
          return this.getOrCreateProvider(
            resolved.provider,
            resolved.model,
            providerConfig?.baseUrl,
            providerConfig?.apiKey,
          );
        }
        logger.warn(
          { taskType, provider: resolved.provider, model: resolved.model, source: resolved.source, appScope },
          `Model config override skipped: ${resolved.provider} provider is not available (disabled or not configured), falling back`,
        );
      }
    }

    // 2. Auto-routing via ProviderConfigResolver (capability-based)
    if (this.providerConfigResolver) {
      const requiredLevel = TASK_CAPABILITY_REQUIREMENTS[taskType];
      if (requiredLevel) {
        const resolved = await this.providerConfigResolver.resolveByCapability(requiredLevel, appScope);
        if (resolved) {
          return this.getOrCreateProvider(resolved.provider, resolved.model, resolved.baseUrl, resolved.apiKey);
        }
      }
    }

    throw new Error(
      `No AI provider configured for task type "${taskType}". Configure providers via the AI Providers page in the control panel.`,
    );
  }

  private async getProvider(taskType: string, clientId?: string): Promise<AIProviderClient> {
    const appScope = TASK_APP_SCOPE[taskType as TaskType];

    // 0. BYOK mode — use client's own API key instead of platform key
    if (clientId && this.clientAiModeResolver && this.byokCredentialResolver) {
      const aiMode = await this.clientAiModeResolver(clientId);
      if (aiMode === 'byok') {
        return this.getByokProvider(taskType, clientId, appScope);
      }
    }

    // 1. Explicit model config overrides (CLIENT > APP_WIDE)
    if (this.modelConfigResolver) {
      const resolved = await this.modelConfigResolver.resolve(taskType, clientId);

      if (resolved.source !== 'DEFAULT') {
        const available = await this.isProviderAvailable(resolved.provider, appScope);
        if (available) {
          // Resolve credentials from the provider config DB for this provider type
          const providerConfig = this.providerConfigResolver
            ? await this.providerConfigResolver.resolveByProvider(resolved.provider, appScope)
            : null;
          return this.getOrCreateProvider(
            resolved.provider,
            resolved.model,
            providerConfig?.baseUrl,
            providerConfig?.apiKey,
          );
        }
        logger.warn(
          { taskType, provider: resolved.provider, model: resolved.model, source: resolved.source, appScope },
          `Model config override skipped: ${resolved.provider} provider is not available (disabled or not configured), falling back`,
        );
      }
    }

    // 2. Auto-routing via ProviderConfigResolver (capability-based)
    if (this.providerConfigResolver) {
      const requiredLevel = TASK_CAPABILITY_REQUIREMENTS[taskType];
      if (requiredLevel) {
        const resolved = await this.providerConfigResolver.resolveByCapability(requiredLevel, appScope);
        if (resolved) {
          return this.getOrCreateProvider(resolved.provider, resolved.model, resolved.baseUrl, resolved.apiKey);
        }
      }
    }

    throw new Error(
      `No AI provider configured for task type "${taskType}". Configure providers via the AI Providers page in the control panel.`,
    );
  }

  /**
   * Resolve a provider using the client's own BYOK credentials.
   * Uses normal routing to determine which provider/model to use, then substitutes the client's API key.
   */
  private async getByokProvider(taskType: string, clientId: string, appScope?: string): Promise<AIProviderClient> {
    // Determine target provider + model via normal routing logic
    let resolvedProvider: string | undefined;
    let resolvedModel: string | undefined;
    let resolvedBaseUrl: string | null | undefined;

    // Try model config overrides first
    if (this.modelConfigResolver) {
      const resolved = await this.modelConfigResolver.resolve(taskType, clientId);
      if (resolved.source !== 'DEFAULT') {
        const available = await this.isProviderAvailable(resolved.provider, appScope);
        if (available) {
          resolvedProvider = resolved.provider;
          resolvedModel = resolved.model;
          const providerConfig = this.providerConfigResolver
            ? await this.providerConfigResolver.resolveByProvider(resolved.provider, appScope)
            : null;
          resolvedBaseUrl = providerConfig?.baseUrl;
        }
      }
    }

    // Fall back to capability-based routing
    if (!resolvedProvider && this.providerConfigResolver) {
      const requiredLevel = TASK_CAPABILITY_REQUIREMENTS[taskType];
      if (requiredLevel) {
        const resolved = await this.providerConfigResolver.resolveByCapability(requiredLevel, appScope);
        if (resolved) {
          resolvedProvider = resolved.provider;
          resolvedModel = resolved.model;
          resolvedBaseUrl = resolved.baseUrl;
        }
      }
    }

    if (!resolvedProvider || !resolvedModel) {
      throw new Error(
        `Client "${clientId}" is in BYOK mode but no provider could be resolved for task type "${taskType}".`,
      );
    }

    // Look up the client's BYOK credential for this provider
    const byokApiKey = await this.byokCredentialResolver!(clientId, resolvedProvider);
    if (!byokApiKey) {
      throw new Error(
        `Client "${clientId}" is in BYOK mode but has no active credential for provider "${resolvedProvider}". ` +
        `Add a credential via the AI Credentials tab in the client's settings.`,
      );
    }

    return this.getOrCreateProvider(resolvedProvider, resolvedModel, resolvedBaseUrl, byokApiKey);
  }

  /**
   * Check if a provider type is available for routing.
   * Returns true if at least one active config exists in the DB for the provider.
   * Returns false if configs exist but all are disabled, if the provider is
   * not managed in the DB (no configs), or if no ProviderConfigResolver is
   * configured (credentials unavailable).
   */
  private async isProviderAvailable(provider: string, appScope?: string): Promise<boolean> {
    if (this.providerConfigResolver) {
      const enabled = await this.providerConfigResolver.isProviderEnabled(provider, appScope);
      if (enabled !== null) return enabled;
    }
    return false;
  }

  /**
   * Returns true if a provider string has a concrete client implementation
   * in getOrCreateProvider(). Providers without an implementation (e.g. GOOGLE)
   * would throw NoProviderImplementationError at runtime.
   */
  private hasClientImplementation(provider: string): boolean {
    return ROUTABLE_PROVIDERS.has(provider);
  }

  /**
   * Shared capability-based routing for resolveForPreview().
   * Filters out providers that have no client implementation.
   * Returns a ResolvedPreview when a routable provider is found, or null.
   */
  private async resolveCapabilityPreview(
    taskType: string,
    appScope: string | undefined,
    overrideSkipped?: boolean,
  ): Promise<ResolvedPreview | null> {
    if (!this.providerConfigResolver) return null;
    const requiredLevel = TASK_CAPABILITY_REQUIREMENTS[taskType];
    if (!requiredLevel) return null;
    const resolved = await this.providerConfigResolver.resolveByCapability(requiredLevel, appScope);
    if (!resolved) return null;
    if (!this.hasClientImplementation(resolved.provider)) {
      logger.warn(
        { taskType, provider: resolved.provider, model: resolved.model, appScope },
        `Capability routing skipped: ${resolved.provider} has no client implementation`,
      );
      return null;
    }
    return {
      provider: resolved.provider,
      model: resolved.model,
      source: 'CAPABILITY',
      overrideSkipped,
    };
  }

  /**
   * Resolve a provider client from an explicit provider/model override (bypasses normal routing).
   * Looks up credentials from the provider config DB for the specified provider type.
   * Validates that the requested model is a known, active model for the given provider
   * AND the app scope derived from the task type, failing early with a clear error if not.
   */
  private async getExplicitProvider(provider: string, model: string, taskType: string): Promise<AIProviderClient> {
    if (!this.hasClientImplementation(provider)) {
      throw new NoProviderImplementationError(provider, model);
    }

    const appScope = TASK_APP_SCOPE[taskType as TaskType];

    // Validate that the model is a known, active model for this provider + app scope.
    // Filtering by scope prevents a model enabled for a different app from passing validation
    // only for resolveByProvider() to return null and cause a misleading "no API key" error.
    if (this.providerConfigResolver) {
      const allModels = await this.providerConfigResolver.getAll();
      const modelsForProvider = allModels.filter((m) => m.provider === provider);

      if (modelsForProvider.length > 0) {
        // Provider exists in DB — check models available for this specific scope
        const modelsForScope = await this.providerConfigResolver.getActiveModelsForProvider(provider, appScope);

        if (modelsForScope.length === 0) {
          // Provider is known but has no active models for the requested scope
          throw Object.assign(
            new Error(
              `Provider "${provider}" has no active models available for app scope "${appScope ?? 'unspecified'}". ` +
              `Configure models for this app scope via the AI Providers page.`,
            ),
            { statusCode: 400 },
          );
        }

        if (!modelsForScope.some((m) => m.model === model)) {
          const available = modelsForScope.map((m) => m.model);
          throw new InvalidModelError(provider, model, available);
        }
      }
    }

    const providerConfig = this.providerConfigResolver
      ? await this.providerConfigResolver.resolveByProvider(provider, appScope)
      : null;
    return this.getOrCreateProvider(provider, model, providerConfig?.baseUrl, providerConfig?.apiKey);
  }

  /**
   * Get or create a provider client for the given provider + model combination.
   * Caches instances to avoid creating new clients on every request.
   *
   * When baseUrl / apiKey are provided (from DB provider config), they take
   * precedence over constructor-level defaults.
   */
  private getOrCreateProvider(
    provider: string,
    model: string,
    baseUrl?: string | null,
    apiKey?: string | null,
  ): AIProviderClient {
    const keyHash = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 8) : '';
    const cacheKey = [provider, model, baseUrl ?? '', keyHash].join(':');
    const cached = this.providerCache.get(cacheKey);
    if (cached) return cached;

    // Guard against unbounded cache growth when BYOK keys introduce many distinct cache keys.
    if (this.providerCache.size >= 500) {
      this.providerCache.clear();
    }

    let client: AIProviderClient;

    if (provider === AIProvider.LOCAL) {
      if (!baseUrl) {
        throw new Error(
          `Model config specifies LOCAL provider with model "${model}" but no base URL is configured in the database`,
        );
      }
      client = new OllamaClient(baseUrl, model);
    } else if (provider === AIProvider.CLAUDE) {
      if (!apiKey) {
        throw new Error(
          `Model config specifies Claude provider with model "${model}" but no API key is configured in the database`,
        );
      }
      client = new ClaudeClient(apiKey, model);
    } else if (provider === AIProvider.OPENAI) {
      if (!apiKey) {
        throw new Error(
          `Model config specifies OpenAI provider with model "${model}" but no API key is configured in the database`,
        );
      }
      client = new OpenAIClient(apiKey, model, baseUrl?.trim() || undefined);
    } else if (provider === AIProvider.GROK) {
      if (!apiKey) {
        throw new Error(
          `Model config specifies Grok provider with model "${model}" but no API key is configured in the database`,
        );
      }
      client = new OpenAIClient(apiKey, model, baseUrl?.trim() || 'https://api.x.ai/v1', AIProvider.GROK);
    } else {
      throw new NoProviderImplementationError(provider, model);
    }

    this.providerCache.set(cacheKey, client);
    return client;
  }

  /**
   * Preview the resolved provider + model for a given task type,
   * mirroring the runtime routing logic in getProvider().
   * Used by the /api/ai-config/resolved endpoint.
   */
  async resolveForPreview(taskType: string, clientId?: string): Promise<ResolvedPreview> {
    const appScope = TASK_APP_SCOPE[taskType as TaskType];

    // 1. Explicit model config overrides (CLIENT > APP_WIDE)
    if (this.modelConfigResolver) {
      const resolved = await this.modelConfigResolver.resolve(taskType, clientId);

      if (resolved.source !== 'DEFAULT') {
        const available = await this.isProviderAvailable(resolved.provider, appScope);
        if (available && this.hasClientImplementation(resolved.provider)) {
          return {
            provider: resolved.provider,
            model: resolved.model,
            source: resolved.source,
          };
        }
        // Override exists but provider is unavailable or has no client — fall through
        if (available && !this.hasClientImplementation(resolved.provider)) {
          logger.warn(
            { taskType, provider: resolved.provider, model: resolved.model, source: resolved.source, appScope },
            `Model config override skipped: ${resolved.provider} has no client implementation, falling back`,
          );
        }

        // 2. Capability-based fallback after override skip
        const capPreview = await this.resolveCapabilityPreview(taskType, appScope, true);
        if (capPreview) return capPreview;

        return {
          provider: '',
          model: '',
          source: 'NONE',
          overrideSkipped: true,
        };
      }
    }

    // 2. Auto-routing via ProviderConfigResolver (capability-based)
    const capPreview = await this.resolveCapabilityPreview(taskType, appScope);
    if (capPreview) return capPreview;

    // No routable provider — matches runtime getProvider() which throws here
    return {
      provider: '',
      model: '',
      source: 'NONE',
    };
  }
}
