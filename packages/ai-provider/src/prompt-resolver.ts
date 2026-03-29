import { createLogger } from '@bronco/shared-utils';
import { getPromptByKey } from './prompts/index.js';
import type { PromptDefinition } from './prompts/index.js';

const logger = createLogger('prompt-resolver');

/**
 * A row from the prompt_overrides table (or equivalent shape).
 */
export interface PromptOverrideRow {
  promptKey: string;
  scope: 'APP_WIDE' | 'CLIENT';
  clientId: string | null;
  position: 'PREPEND' | 'APPEND';
  content: string;
  isActive: boolean;
}

/**
 * Result of resolving and composing a prompt.
 */
export interface ResolvedPrompt {
  /** The final composed prompt text (base + overrides). */
  content: string;
  /** Temperature from the base prompt definition. */
  temperature: number | null;
  /** Max tokens from the base prompt definition. */
  maxTokens: number | null;
  /** Whether any overrides were applied. */
  hasOverrides: boolean;
}

/**
 * A function that fetches prompt overrides by prompt key.
 * Returns all overrides for the key (both APP_WIDE and CLIENT scoped).
 */
export type PromptFetcher = (promptKey: string) => Promise<PromptOverrideRow[]>;

/**
 * Replaces `{{token}}` placeholders in a prompt template with provided values.
 * Unresolved placeholders are left as-is.
 */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
    return values[token] ?? match;
  });
}

/**
 * Compose a final prompt from the hardcoded base + overrides.
 *
 * Layering order:
 *   1. PREPEND overrides (app-wide first, then client-specific)
 *   2. Base prompt content
 *   3. APPEND overrides (app-wide first, then client-specific)
 *
 * This means client-specific PREPEND text comes right before the base prompt,
 * and client-specific APPEND text comes at the very end — letting app-wide text
 * set general tone and client-specific text add specifics.
 */
export function composePrompt(
  base: PromptDefinition,
  overrides: PromptOverrideRow[],
  clientId?: string,
): string {
  const active = overrides.filter((o) => o.isActive && o.promptKey === base.key);

  // Split into the 4 buckets
  const appPrepend = active.filter((o) => o.scope === 'APP_WIDE' && o.position === 'PREPEND');
  const clientPrepend = clientId
    ? active.filter((o) => o.scope === 'CLIENT' && o.position === 'PREPEND' && o.clientId === clientId)
    : [];
  const appAppend = active.filter((o) => o.scope === 'APP_WIDE' && o.position === 'APPEND');
  const clientAppend = clientId
    ? active.filter((o) => o.scope === 'CLIENT' && o.position === 'APPEND' && o.clientId === clientId)
    : [];

  const parts: string[] = [
    ...appPrepend.map((o) => o.content),
    ...clientPrepend.map((o) => o.content),
    base.content,
    ...appAppend.map((o) => o.content),
    ...clientAppend.map((o) => o.content),
  ];

  return parts.join('\n\n');
}

/**
 * PromptResolver loads overrides from the database, composes them with
 * hardcoded base prompts, and caches the result.
 *
 * Usage:
 * ```ts
 * const resolver = new PromptResolver(async (key) => {
 *   return db.promptOverride.findMany({ where: { promptKey: key, isActive: true } });
 * });
 *
 * const { content, temperature } = await resolver.resolve('imap.triage.system');
 * // content = base prompt + any app-wide/client overrides
 * ```
 */
export class PromptResolver {
  private fetcher: PromptFetcher;
  private cache = new Map<string, { overrides: PromptOverrideRow[]; fetchedAt: number }>();
  private cacheTtlMs: number;

  constructor(fetcher: PromptFetcher, opts?: { cacheTtlMs?: number }) {
    this.fetcher = fetcher;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 5 * 60 * 1000; // 5 min default
  }

  /**
   * Resolve a prompt by key, composing the base definition with overrides.
   *
   * @param key       Prompt key, e.g. "imap.triage.system"
   * @param clientId  Optional client ID for client-specific overrides
   */
  async resolve(key: string, clientId?: string): Promise<ResolvedPrompt> {
    const base = getPromptByKey(key);
    if (!base) {
      throw new Error(`Unknown prompt key: "${key}". Check packages/ai-provider/src/prompts/.`);
    }

    const overrides = await this.fetchCached(key);
    const hasOverrides = overrides.length > 0;
    const content = hasOverrides ? composePrompt(base, overrides, clientId) : base.content;

    return {
      content,
      temperature: base.temperature,
      maxTokens: base.maxTokens,
      hasOverrides,
    };
  }

  /**
   * Resolve a prompt and interpolate keyword values into the result.
   */
  async resolveAndInterpolate(
    key: string,
    values: Record<string, string>,
    clientId?: string,
  ): Promise<ResolvedPrompt> {
    const result = await this.resolve(key, clientId);
    return {
      ...result,
      content: interpolate(result.content, values),
    };
  }

  /** Invalidate a single cached key or the entire cache. */
  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  private async fetchCached(key: string): Promise<PromptOverrideRow[]> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.overrides;
    }

    try {
      const overrides = await this.fetcher(key);
      this.cache.set(key, { overrides, fetchedAt: Date.now() });
      return overrides;
    } catch (err) {
      logger.warn({ key, err }, 'Failed to fetch prompt overrides, using base prompt only');
      // Negative-cache to avoid hammering a failing database on every resolve call
      this.cache.set(key, { overrides: [], fetchedAt: Date.now() });
      return [];
    }
  }
}
