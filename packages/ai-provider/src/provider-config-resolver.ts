import { createLogger } from '@bronco/shared-utils';
import { meetsCapability, CAPABILITY_LEVEL_ORDER } from './task-capabilities.js';

const logger = createLogger('provider-config-resolver');

/**
 * A flattened row joining ai_providers + ai_provider_models.
 * The `apiKey` field is the decrypted plaintext key (only used at runtime, never persisted).
 * `providerActive` reflects the parent provider's isActive flag.
 */
export interface ProviderConfigRow {
  id: string;          // model id
  providerId: string;  // parent provider id
  name: string;        // model display name
  provider: string;    // provider type (LOCAL, CLAUDE, etc.)
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  capabilityLevel: string;
  isActive: boolean;          // model-level active flag
  providerActive: boolean;    // provider-level active flag
  enabledApps: string[];
}

/**
 * A function that fetches all provider configs from the database (both active and inactive).
 * Should decrypt API keys before returning. The resolver filters by isActive internally.
 */
export type ProviderConfigFetcher = () => Promise<ProviderConfigRow[]>;

/**
 * Resolved provider config for routing.
 */
export interface ResolvedProviderConfig {
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  capabilityLevel: string;
  source: 'PROVIDER_DB';
}

/**
 * ProviderConfigResolver loads AI provider configs from the database,
 * caches them, and resolves the best provider for a given capability level.
 *
 * A model is considered "effective active" when both the model's isActive
 * AND the parent provider's isActive are true.
 *
 * Resolution strategy for capability-based routing:
 * 1. Find all effectively-active models whose capability level >= required level
 * 2. Pick the one with the lowest sufficient capability (avoid over-provisioning)
 * 3. If multiple at the same level, pick the first (stable order from DB)
 */
export class ProviderConfigResolver {
  private fetcher: ProviderConfigFetcher;
  private cache: { rows: ProviderConfigRow[]; fetchedAt: number } | null = null;
  private cacheTtlMs: number;

  constructor(fetcher: ProviderConfigFetcher, opts?: { cacheTtlMs?: number }) {
    this.fetcher = fetcher;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 5 * 60 * 1000;
  }

  /**
   * Check if a row is effectively active (both provider and model active).
   */
  private isEffectivelyActive(row: ProviderConfigRow): boolean {
    return row.isActive && row.providerActive;
  }

  /**
   * Resolve the best provider for a given capability level.
   * When `appScope` is provided, only models enabled for that app (or with
   * an empty enabledApps list, meaning "all apps") are considered.
   * Returns null if no suitable provider is found.
   */
  async resolveByCapability(requiredLevel: string, appScope?: string): Promise<ResolvedProviderConfig | null> {
    const rows = await this.fetchCached();
    const suitable = rows
      .filter((r) => this.isEffectivelyActive(r) && meetsCapability(r.capabilityLevel, requiredLevel) && this.matchesAppScope(r, appScope))
      .sort((a, b) => {
        // Prefer the lowest sufficient level
        const aIdx = CAPABILITY_LEVEL_ORDER.indexOf(a.capabilityLevel);
        const bIdx = CAPABILITY_LEVEL_ORDER.indexOf(b.capabilityLevel);
        return aIdx - bIdx;
      });

    if (suitable.length === 0) return null;

    const best = suitable[0];
    return {
      provider: best.provider,
      model: best.model,
      baseUrl: best.baseUrl,
      apiKey: best.apiKey,
      capabilityLevel: best.capabilityLevel,
      source: 'PROVIDER_DB',
    };
  }

  /**
   * Resolve a provider by its provider type (e.g. "LOCAL", "CLAUDE").
   * When `appScope` is provided, only models enabled for that app are considered.
   * Returns the first effectively-active match.
   */
  async resolveByProvider(provider: string, appScope?: string): Promise<ResolvedProviderConfig | null> {
    const rows = await this.fetchCached();
    const match = rows.find((r) => this.isEffectivelyActive(r) && r.provider === provider && this.matchesAppScope(r, appScope));
    if (!match) return null;

    return {
      provider: match.provider,
      model: match.model,
      baseUrl: match.baseUrl,
      apiKey: match.apiKey,
      capabilityLevel: match.capabilityLevel,
      source: 'PROVIDER_DB',
    };
  }

  /**
   * Get all effectively-active provider config rows.
   */
  async getAll(): Promise<ProviderConfigRow[]> {
    const rows = await this.fetchCached();
    return rows.filter((r) => this.isEffectivelyActive(r));
  }

  /**
   * Get all effectively-active model rows for a given provider type,
   * filtered by app scope when provided.
   * Used for explicit-override validation so that scope is applied consistently.
   */
  async getActiveModelsForProvider(provider: string, appScope?: string): Promise<ProviderConfigRow[]> {
    const rows = await this.fetchCached();
    return rows.filter(
      (r) => this.isEffectivelyActive(r) && r.provider === provider && this.matchesAppScope(r, appScope),
    );
  }

  /**
   * Returns true if any effectively-active models are configured in the DB.
   */
  async hasProviders(): Promise<boolean> {
    const rows = await this.fetchCached();
    return rows.some((r) => this.isEffectivelyActive(r));
  }

  /**
   * Check the enabled state of a specific provider type (e.g. "LOCAL", "CLAUDE").
   * When `appScope` is provided, only models enabled for that app are considered.
   *
   * Returns:
   * - `true`  — at least one effectively-active model exists for this provider type (and scope)
   * - `false` — models exist but none are effectively active (provider or all models disabled),
   *             OR the provider exists but has no models matching the requested `appScope`
   * - `null`  — no models exist for this provider type at all (unmanaged, not in DB)
   *
   * The distinction between `false` and `null` allows callers to tell the difference
   * between a provider that is intentionally scoped to other apps (false) versus
   * one that has never been configured (null), avoiding misleading "not configured"
   * log messages when an operator has restricted models to specific apps.
   */
  async isProviderEnabled(provider: string, appScope?: string): Promise<boolean | null> {
    const rows = await this.fetchCached();
    // First, check whether this provider type exists in the DB at all (scope-independent).
    const forProviderAny = rows.filter((r) => r.provider === provider);
    if (forProviderAny.length === 0) return null;
    // Provider exists — now apply the scope filter.
    const forProvider = forProviderAny.filter((r) => this.matchesAppScope(r, appScope));
    if (forProvider.length === 0) return false;
    return forProvider.some((r) => this.isEffectivelyActive(r));
  }

  /** Invalidate the cache (e.g., after a config change). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Check if a model row matches the requested app scope.
   * Empty enabledApps means the model is available to all apps.
   * When no appScope is requested, all models match.
   */
  private matchesAppScope(row: ProviderConfigRow, appScope?: string): boolean {
    if (!appScope) return true;
    if (row.enabledApps.length === 0) return true;
    return row.enabledApps.includes(appScope);
  }

  private async fetchCached(): Promise<ProviderConfigRow[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.rows;
    }

    try {
      const rows = await this.fetcher();
      this.cache = { rows, fetchedAt: Date.now() };
      return rows;
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch AI provider configs');
      // Do not poison the cache with an empty value on error.
      // Return stale cache if available; otherwise return an uncached empty result.
      if (this.cache) {
        return this.cache.rows;
      }
      return [];
    }
  }
}
