import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('client-memory-resolver');

/**
 * A row from the client_memories table (or equivalent shape).
 */
export interface ClientMemoryRow {
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
}

/**
 * Resolved client memory — a composed block of knowledge ready for injection.
 */
export interface ResolvedClientMemory {
  /** Composed markdown text combining all relevant memory entries. */
  content: string;
  /** Number of memory entries that were composed. */
  entryCount: number;
  /** The individual entries that were included. */
  entries: ClientMemoryRow[];
}

/**
 * A function that fetches all active client memory entries for a given client.
 */
export type ClientMemoryFetcher = (clientId: string) => Promise<ClientMemoryRow[]>;

/**
 * ClientMemoryResolver loads per-client operational knowledge from the database
 * and composes it into a context block for AI prompt injection.
 *
 * Resolution:
 *   1. Fetch all active entries for the client
 *   2. Filter by category (entries with matching category + entries with no category)
 *   3. Optionally filter by tags
 *   4. Sort by sortOrder, then compose into markdown
 *
 * Cached per-client with a 5-min TTL (same pattern as ModelConfigResolver).
 */
export class ClientMemoryResolver {
  private fetcher: ClientMemoryFetcher;
  private cache = new Map<string, { rows: ClientMemoryRow[]; fetchedAt: number }>();
  private cacheTtlMs: number;

  constructor(fetcher: ClientMemoryFetcher, opts?: { cacheTtlMs?: number }) {
    this.fetcher = fetcher;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 5 * 60 * 1000;
  }

  /**
   * Resolve relevant memory entries for a client, optionally filtered by
   * ticket category and/or tags.
   *
   * Returns entries where:
   *   - category matches the provided category OR category is null (applies to all)
   *   - If tags are provided, at least one tag matches (OR logic)
   */
  async resolve(
    clientId: string,
    opts?: { category?: string | null; tags?: string[]; environmentInstructions?: string | null },
  ): Promise<ResolvedClientMemory> {
    const rows = await this.fetchCached(clientId);
    const active = rows.filter((r) => r.isActive);

    // Filter by category: entries scoped to this category + entries with no category.
    // When opts.category is falsy (no category provided), all active entries are returned
    // regardless of their category field. This is intentional: when the caller has no
    // category context (e.g. early in a workflow before categorization), all memories
    // are considered relevant rather than returning nothing.
    let filtered = active;
    if (opts?.category) {
      filtered = active.filter((r) => r.category === null || r.category === opts.category);
    }

    // Filter by tags (OR logic): at least one tag must match
    if (opts?.tags && opts.tags.length > 0) {
      const tagSet = new Set(opts.tags.map((t) => t.toLowerCase()));
      filtered = filtered.filter(
        (r) => r.tags.length === 0 || r.tags.some((t) => tagSet.has(t.toLowerCase())),
      );
    }

    // Sort by sortOrder ascending
    filtered.sort((a, b) => a.sortOrder - b.sortOrder);

    if (filtered.length === 0) {
      return { content: '', entryCount: 0, entries: [] };
    }

    // Compose into markdown sections
    const sections = filtered.map((entry) => {
      const typeLabel = entry.memoryType === 'PLAYBOOK' ? 'Playbook'
        : entry.memoryType === 'TOOL_GUIDANCE' ? 'Tool Guidance'
        : 'Context';
      return `### ${entry.title} (${typeLabel})\n\n${entry.content}`;
    });

    let content = `## Client Knowledge\n\n${sections.join('\n\n---\n\n')}`;

    if (opts?.environmentInstructions) {
      content = `## Environment Operational Instructions\n\n${opts.environmentInstructions}\n\n---\n\n${content}`;
    }

    return { content, entryCount: filtered.length, entries: filtered };
  }

  /** Invalidate cache for a specific client or the entire cache. */
  invalidate(clientId?: string): void {
    if (clientId) {
      this.cache.delete(clientId);
    } else {
      this.cache.clear();
    }
  }

  private async fetchCached(clientId: string): Promise<ClientMemoryRow[]> {
    const cached = this.cache.get(clientId);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.rows;
    }

    try {
      const rows = await this.fetcher(clientId);
      this.cache.set(clientId, { rows, fetchedAt: Date.now() });
      return rows;
    } catch (err) {
      logger.warn({ clientId, err }, 'Failed to fetch client memory entries');
      // Negative-cache to avoid hammering a failing database
      this.cache.set(clientId, { rows: [], fetchedAt: Date.now() });
      return [];
    }
  }
}
