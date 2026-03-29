import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('azdo-client');

/** Default Azure DevOps REST API version. */
const DEFAULT_API_VERSION = '7.1';
/** Default comments endpoint API version (preview). */
const DEFAULT_API_VERSION_COMMENTS = '7.1-preview.4';
/** Maximum work items per batch request (Azure DevOps limit). */
export const BATCH_CHUNK_SIZE = 200;
/** Maximum retries for transient API failures (429, 5xx, network errors). */
const MAX_RETRIES = 3;
/** Base delay in ms for exponential backoff between retries. */
const RETRY_BASE_DELAY_MS = 1000;

export interface AzDoConfig {
  orgUrl: string;
  project: string;
  pat: string;
  /** Override the default REST API version (default: 7.1). */
  apiVersion?: string;
  /** Override the comments endpoint API version (default: 7.1-preview.4). */
  apiVersionComments?: string;
}

// --- Azure DevOps API response types ---

export interface AzDoWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations?: AzDoRelation[];
  url: string;
}

export interface AzDoRelation {
  rel: string;
  url: string;
  attributes: Record<string, unknown>;
}

export interface AzDoComment {
  id: number;
  workItemId: number;
  text: string;
  createdBy: { displayName: string; uniqueName: string };
  createdDate: string;
  modifiedDate: string;
}

/**
 * Escape a string value for safe inclusion in a WIQL query.
 * WIQL uses single-quoted strings; we escape single quotes by doubling them.
 */
function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Lightweight Azure DevOps REST API client using native fetch (Node 20+).
 * Authenticates with a Personal Access Token (PAT) via Basic auth.
 */
export class AzDoClient {
  private headers: Record<string, string>;
  private baseUrl: string;
  private apiVersion: string;
  private apiVersionComments: string;

  constructor(private config: AzDoConfig) {
    const token = Buffer.from(`:${config.pat}`).toString('base64');
    this.headers = {
      Authorization: `Basic ${token}`,
      'Content-Type': 'application/json',
    };
    this.baseUrl = `${config.orgUrl}/${config.project}/_apis`;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.apiVersionComments = config.apiVersionComments ?? DEFAULT_API_VERSION_COMMENTS;
  }

  /**
   * Execute a WIQL query to find work items changed since a given date.
   * Returns work item IDs only (details fetched separately).
   */
  async queryWorkItems(since?: Date): Promise<number[]> {
    const sinceClause = since
      ? `AND [System.ChangedDate] >= '${escapeWiql(since.toISOString())}'`
      : '';

    const wiql = `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = '${escapeWiql(this.config.project)}'
      ${sinceClause}
      ORDER BY [System.ChangedDate] DESC
    `;

    const data = await this.fetchJson<{ workItems?: { id: number }[] }>(
      `${this.baseUrl}/wit/wiql?api-version=${this.apiVersion}`,
      { method: 'POST', body: JSON.stringify({ query: wiql }) },
    );

    return (data.workItems ?? []).map((wi) => wi.id);
  }

  /**
   * Get a single work item with relations expanded.
   */
  async getWorkItem(id: number): Promise<AzDoWorkItem> {
    return this.fetchJson<AzDoWorkItem>(
      `${this.baseUrl}/wit/workitems/${id}?$expand=relations&api-version=${this.apiVersion}`,
    );
  }

  /**
   * Batch-fetch work items (max {@link BATCH_CHUNK_SIZE} per request, auto-chunked).
   */
  async getWorkItems(ids: number[]): Promise<AzDoWorkItem[]> {
    if (ids.length === 0) return [];

    const results: AzDoWorkItem[] = [];
    for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
      const batch = ids.slice(i, i + BATCH_CHUNK_SIZE);
      const data = await this.fetchJson<{ value?: AzDoWorkItem[] }>(
        `${this.baseUrl}/wit/workitems?ids=${batch.join(',')}&$expand=relations&api-version=${this.apiVersion}`,
      );
      results.push(...(data.value ?? []));
    }
    return results;
  }

  /**
   * Get comments on a work item (newest first by default from API).
   */
  async getComments(workItemId: number): Promise<AzDoComment[]> {
    const data = await this.fetchJson<{ comments?: AzDoComment[] }>(
      `${this.baseUrl}/wit/workitems/${workItemId}/comments?api-version=${this.apiVersionComments}`,
    );
    return data.comments ?? [];
  }

  /**
   * Post a comment on a work item.
   */
  async addComment(workItemId: number, text: string): Promise<AzDoComment> {
    return this.fetchJson<AzDoComment>(
      `${this.baseUrl}/wit/workitems/${workItemId}/comments?api-version=${this.apiVersionComments}`,
      { method: 'POST', body: JSON.stringify({ text }) },
    );
  }

  /**
   * Build a browser URL for a work item.
   */
  getWorkItemUrl(workItemId: number): string {
    return `${this.config.orgUrl}/${this.config.project}/_workitems/edit/${workItemId}`;
  }

  /**
   * Make an HTTP request to the Azure DevOps REST API with automatic retry
   * for transient failures (HTTP 429, 5xx, and network errors).
   */
  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          ...init,
          headers: { ...this.headers, ...init?.headers },
        });

        // Retry on 429 (rate limit) or 5xx (server error)
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
          const retryAfter = response.headers.get('retry-after');
          let delayMs: number;

          if (retryAfter != null) {
            const seconds = Number.parseInt(retryAfter, 10);
            if (!Number.isNaN(seconds)) {
              delayMs = seconds * 1000;
            } else {
              const retryTimestamp = Date.parse(retryAfter);
              delayMs = !Number.isNaN(retryTimestamp) && retryTimestamp - Date.now() > 0
                ? retryTimestamp - Date.now()
                : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
            }
          } else {
            delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          }
          // Consume the response body to release the connection for reuse
          await response.text().catch(() => {});
          logger.warn(
            { status: response.status, url, attempt, delayMs },
            'Transient API error — retrying',
          );
          await sleep(delayMs);
          continue;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          logger.error({ status: response.status, url, body }, 'Azure DevOps API error');
          throw new Error(`Azure DevOps API ${response.status}: ${response.statusText}`);
        }

        return response.json() as Promise<T>;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry non-transient errors (our own thrown errors from !response.ok)
        if (lastError.message.startsWith('Azure DevOps API ')) throw lastError;

        if (attempt < MAX_RETRIES) {
          const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          logger.warn(
            { url, attempt, error: lastError.message, delayMs },
            'Network error — retrying',
          );
          await sleep(delayMs);
        }
      }
    }

    throw lastError ?? new Error('fetchJson: max retries exceeded');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
