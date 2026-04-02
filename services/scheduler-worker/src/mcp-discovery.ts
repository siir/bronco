import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('mcp-discovery');

export interface McpDiscoveryConfig {
  url: string;
  mcpPath?: string;
  apiKey?: string;
  authHeader?: 'bearer' | 'x-api-key';
  timeoutMs?: number;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpDiscoveryResult {
  serverName: string | null;
  serverVersion: string | null;
  tools: McpToolInfo[];
  systemsCount: number | null;
  lastVerifiedAt: string;
  verificationStatus: 'success' | 'failed';
  verificationError: string | null;
}

/** Strip trailing slashes and ensure https:// prefix. */
export function normalizeUrl(url: string): string {
  let normalized = url.trim().replace(/\/+$/, '');
  if (normalized && !/^https?:\/\//i.test(normalized)) {
    normalized = 'https://' + normalized;
  }
  return normalized;
}

/** Maximum number of discovery attempts (handles transient Azure App Service cold starts / ARR routing). */
const MAX_DISCOVERY_ATTEMPTS = 3;
const DISCOVERY_RETRY_DELAY_MS = 2_000;

/**
 * Connect to an MCP server via Streamable HTTP transport and discover
 * its tools, server version, and (optionally) systems count.
 *
 * Retries up to MAX_DISCOVERY_ATTEMPTS times to handle transient failures
 * (Azure cold starts, ARR affinity misrouting between instances).
 */
export async function discoverMcpServer(config: McpDiscoveryConfig): Promise<McpDiscoveryResult> {
  // Validate URL before the retry loop — config errors are not transient and should fail fast
  const baseUrl = normalizeUrl(config.url);
  const mcpPath = config.mcpPath ?? '/mcp';
  const mcpUrl = new URL(mcpPath, baseUrl); // throws on invalid URL — no retry

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_DISCOVERY_ATTEMPTS; attempt++) {
    try {
      return await discoverMcpServerOnce(mcpUrl, config);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_DISCOVERY_ATTEMPTS) {
        logger.warn({ attempt, maxAttempts: MAX_DISCOVERY_ATTEMPTS, err: lastError }, 'MCP discovery attempt failed, retrying');
        await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError ?? new Error('MCP discovery failed');
}

async function discoverMcpServerOnce(mcpUrl: URL, config: McpDiscoveryConfig): Promise<McpDiscoveryResult> {
  const timeoutMs = config.timeoutMs ?? 30_000;

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    if (config.authHeader === 'x-api-key') {
      headers['x-api-key'] = config.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
  });

  const client = new Client({ name: 'bronco-discovery', version: '0.1.0' });

  // Timeout to prevent indefinite hangs — cleared in finally block
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP discovery timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    await Promise.race([client.connect(transport), timeoutPromise]);

    const serverInfo = client.getServerVersion();
    const { tools } = await client.listTools();

    // Try to get systems count via list_systems tool (may not exist on third-party servers)
    let systemsCount: number | null = null;
    const hasListSystems = tools.some(t => t.name === 'list_systems');
    if (hasListSystems) {
      try {
        const result = await client.callTool({ name: 'list_systems', arguments: {} });
        // The tool typically returns content with a text entry containing JSON
        const contentArray = Array.isArray(result.content) ? result.content : [];
        const textContent = contentArray.find(
          (c: { type: string }) => c.type === 'text',
        ) as { type: 'text'; text: string } | undefined;
        if (textContent?.text) {
          const parsed = JSON.parse(textContent.text);
          systemsCount = Array.isArray(parsed) ? parsed.length : null;
        }
      } catch (err) {
        logger.debug({ err }, 'list_systems call failed (may not be supported)');
      }
    }

    return {
      serverName: serverInfo?.name ?? null,
      serverVersion: serverInfo?.version ?? null,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      })),
      systemsCount,
      lastVerifiedAt: new Date().toISOString(),
      verificationStatus: 'success',
      verificationError: null,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { await transport.close(); } catch { /* ignore close errors */ }
  }
}
