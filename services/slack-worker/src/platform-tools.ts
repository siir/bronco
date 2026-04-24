import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger, MCP_TOOL_TIMEOUT_MS } from '@bronco/shared-utils';
import type { AIToolDefinition } from '@bronco/shared-types';

const logger = createLogger('platform-tools');

interface CacheEntry {
  tools: AIToolDefinition[];
  timestamp: number;
}

/** Per-URL tool cache — keyed by MCP Platform URL so multi-instance setups don't collide. */
const toolsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch MCP Platform Server tools and convert them to AIToolDefinition format.
 * Results are cached per URL for 10 minutes since tools don't change at runtime.
 */
export async function getPlatformTools(mcpPlatformUrl: string, opts?: { apiKey?: string }): Promise<AIToolDefinition[]> {
  const now = Date.now();
  const cached = toolsCache.get(mcpPlatformUrl);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.tools;
  }

  const endpointUrl = new URL('/mcp', mcpPlatformUrl);

  const apiKey = typeof opts?.apiKey === 'string' && opts.apiKey.trim().length > 0 ? opts.apiKey.trim() : undefined;

  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;

  const transportOptions = Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined;
  const transport = new StreamableHTTPClientTransport(endpointUrl, transportOptions);
  const client = new Client({ name: 'slack-worker-discovery', version: '0.1.0' });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP Platform tool discovery timed out after ${MCP_TOOL_TIMEOUT_MS}ms`)),
      MCP_TOOL_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([client.connect(transport), timeoutPromise]);
    const { tools } = await Promise.race([client.listTools(), timeoutPromise]);

    const definitions: AIToolDefinition[] = tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));

    toolsCache.set(mcpPlatformUrl, { tools: definitions, timestamp: now });
    logger.info({ toolCount: definitions.length, mcpPlatformUrl }, 'MCP Platform tools discovered and cached');
    return definitions;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { await transport.close(); } catch { /* ignore close errors */ }
  }
}

/** Clear the cached tools (useful for testing). Clears all URLs or a specific URL. */
export function clearPlatformToolsCache(mcpPlatformUrl?: string): void {
  if (mcpPlatformUrl) {
    toolsCache.delete(mcpPlatformUrl);
  } else {
    toolsCache.clear();
  }
}
