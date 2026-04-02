import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger, MCP_TOOL_TIMEOUT_MS } from '@bronco/shared-utils';
import type { AIToolDefinition } from '@bronco/shared-types';

const logger = createLogger('platform-tools');

/** Cached tool definitions — tools don't change at runtime. */
let cachedTools: AIToolDefinition[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch MCP Platform Server tools and convert them to AIToolDefinition format.
 * Results are cached for 10 minutes since tools don't change at runtime.
 */
export async function getPlatformTools(mcpPlatformUrl: string): Promise<AIToolDefinition[]> {
  const now = Date.now();
  if (cachedTools && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedTools;
  }

  const endpointUrl = new URL('/mcp', mcpPlatformUrl);

  const transport = new StreamableHTTPClientTransport(endpointUrl, {});
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

    cachedTools = definitions;
    cacheTimestamp = now;
    logger.info({ toolCount: definitions.length }, 'MCP Platform tools discovered and cached');
    return definitions;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { await transport.close(); } catch { /* ignore close errors */ }
  }
}

/** Clear the cached tools (useful for testing). */
export function clearPlatformToolsCache(): void {
  cachedTools = null;
  cacheTimestamp = 0;
}
