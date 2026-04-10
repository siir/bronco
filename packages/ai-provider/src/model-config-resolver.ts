import { TaskType, AIProvider } from '@bronco/shared-types';
import type { TaskTypeDefault } from '@bronco/shared-types';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('model-config-resolver');

/**
 * A row from the ai_model_configs table (or equivalent shape).
 */
export interface ModelConfigRow {
  taskType: string;
  scope: 'APP_WIDE' | 'CLIENT';
  clientId: string | null;
  provider: string;
  model: string;
  maxTokens: number | null;
  isActive: boolean;
}

/**
 * Resolved provider + model for a given task type.
 */
export interface ResolvedModelConfig {
  provider: string;
  model: string;
  maxTokens: number | null;
  source: 'CLIENT' | 'APP_WIDE' | 'DEFAULT';
}

/**
 * A function that fetches all active model configs from the database.
 * Called periodically and cached.
 */
export type ModelConfigFetcher = () => Promise<ModelConfigRow[]>;

/**
 * Hardcoded default provider + model for each task type.
 * LOCAL_TASKS go to Ollama; everything else goes to Claude.
 */
const LOCAL_TASK_TYPES = new Set<string>([
  TaskType.TRIAGE,
  TaskType.CATEGORIZE,
  TaskType.SUMMARIZE,
  TaskType.DRAFT_EMAIL,
  TaskType.EXTRACT_FACTS,
  TaskType.SUMMARIZE_TICKET,
  TaskType.SUMMARIZE_LOGS,
  TaskType.GENERATE_TITLE,
  TaskType.CLASSIFY_EMAIL,
  TaskType.SUGGEST_NEXT_STEPS,
  TaskType.CLASSIFY_INTENT,
  TaskType.ANALYZE_WORK_ITEM,
  TaskType.DRAFT_COMMENT,
  TaskType.GENERATE_DEVOPS_PLAN,
]);

const DEFAULT_OLLAMA_MODEL = 'llama3.1:8b';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Returns the hardcoded defaults for all known task types.
 */
export function getTaskTypeDefaults(): TaskTypeDefault[] {
  return Object.values(TaskType).map((tt) => ({
    taskType: tt,
    provider: LOCAL_TASK_TYPES.has(tt) ? AIProvider.LOCAL : AIProvider.CLAUDE,
    model: LOCAL_TASK_TYPES.has(tt) ? DEFAULT_OLLAMA_MODEL : DEFAULT_CLAUDE_MODEL,
  }));
}

function getDefaultConfig(taskType: string): ResolvedModelConfig {
  const isLocal = LOCAL_TASK_TYPES.has(taskType);
  return {
    provider: isLocal ? AIProvider.LOCAL : AIProvider.CLAUDE,
    model: isLocal ? DEFAULT_OLLAMA_MODEL : DEFAULT_CLAUDE_MODEL,
    maxTokens: null,
    source: 'DEFAULT',
  };
}

/**
 * ModelConfigResolver loads AI model configs from the database,
 * resolves them with APP_WIDE / CLIENT layering, and caches the result.
 *
 * Resolution order (first match wins):
 *   1. CLIENT-scoped config for the given clientId
 *   2. APP_WIDE-scoped config
 *   3. Hardcoded defaults (LOCAL_TASK_TYPES set + default models)
 */
export class ModelConfigResolver {
  private fetcher: ModelConfigFetcher;
  private cache: { rows: ModelConfigRow[]; fetchedAt: number } | null = null;
  private cacheTtlMs: number;

  constructor(fetcher: ModelConfigFetcher, opts?: { cacheTtlMs?: number }) {
    this.fetcher = fetcher;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 5 * 60 * 1000; // 5 min default
  }

  /**
   * Resolve provider + model for a given task type, optionally scoped to a client.
   */
  async resolve(taskType: string, clientId?: string): Promise<ResolvedModelConfig> {
    const rows = await this.fetchCached();
    const active = rows.filter((r) => r.isActive && r.taskType === taskType);

    // 1. CLIENT-scoped override
    if (clientId) {
      const clientConfig = active.find(
        (r) => r.scope === 'CLIENT' && r.clientId === clientId,
      );
      if (clientConfig) {
        return { provider: clientConfig.provider, model: clientConfig.model, maxTokens: clientConfig.maxTokens, source: 'CLIENT' };
      }
    }

    // 2. APP_WIDE override (clientId must be null for a valid APP_WIDE row)
    const appConfig = active.find((r) => r.scope === 'APP_WIDE' && r.clientId === null);
    if (appConfig) {
      return { provider: appConfig.provider, model: appConfig.model, maxTokens: appConfig.maxTokens, source: 'APP_WIDE' };
    }

    // 3. Hardcoded default
    return getDefaultConfig(taskType);
  }

  /** Invalidate the cache (e.g., after a config change). */
  invalidate(): void {
    this.cache = null;
  }

  private async fetchCached(): Promise<ModelConfigRow[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.rows;
    }

    try {
      const rows = await this.fetcher();
      this.cache = { rows, fetchedAt: Date.now() };
      return rows;
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch AI model configs, using defaults');
      this.cache = { rows: [], fetchedAt: Date.now() };
      return [];
    }
  }
}
