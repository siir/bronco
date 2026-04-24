import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PrismaClient } from '@bronco/db';
import { IntegrationType } from '@bronco/shared-types';
import { createLogger } from './logger.js';
import { decrypt, looksEncrypted } from './crypto.js';

const logger = createLogger('mcp-catalog');

export interface McpDiscoveryConfig {
  url: string;
  mcpPath?: string;
  apiKey?: string;
  authHeader?: 'bearer' | 'x-api-key';
  timeoutMs?: number;
  /** Sent as X-Caller-Name header for per-caller tool allowlist enforcement on the target server. */
  callerName?: string;
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
  const baseUrl = normalizeUrl(config.url);
  const mcpPath = config.mcpPath ?? '/mcp';
  const mcpUrl = new URL(mcpPath, baseUrl);

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_DISCOVERY_ATTEMPTS; attempt++) {
    try {
      return await discoverMcpServerOnce(mcpUrl, config);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_DISCOVERY_ATTEMPTS) {
        logger.warn(
          { attempt, maxAttempts: MAX_DISCOVERY_ATTEMPTS, err: lastError },
          'MCP discovery attempt failed, retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError ?? new Error('MCP discovery failed');
}

async function discoverMcpServerOnce(
  mcpUrl: URL,
  config: McpDiscoveryConfig,
): Promise<McpDiscoveryResult> {
  const timeoutMs = config.timeoutMs ?? 30_000;

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    if (config.authHeader === 'x-api-key') {
      headers['x-api-key'] = config.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }
  if (config.callerName) {
    headers['x-caller-name'] = config.callerName;
  }

  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
  });

  const client = new Client({ name: 'bronco-discovery', version: '0.1.0' });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP discovery timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([client.connect(transport), timeoutPromise]);

    const serverInfo = client.getServerVersion();
    const { tools } = await client.listTools();

    let systemsCount: number | null = null;
    const hasListSystems = tools.some((t) => t.name === 'list_systems');
    if (hasListSystems) {
      try {
        const result = await client.callTool({ name: 'list_systems', arguments: {} });
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
      tools: tools.map((t) => ({
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
    try {
      await transport.close();
    } catch {
      /* ignore close errors */
    }
  }
}

export interface ClientCatalogOpts {
  encryptionKey?: string;
  mcpPlatformUrl?: string;
  mcpRepoUrl?: string;
  mcpDatabaseUrl?: string;
  platformApiKey?: string;
  /** If provided, discovery warnings (skipped integrations, failed lookups) are pushed here. */
  warnings?: string[];
}

/**
 * Build the per-client active tool catalog by discovering all MCP integrations
 * (client-specific + shared platform) for the client. Returns each tool's
 * server name, tool name, and description.
 */
export async function buildClientToolCatalog(
  db: PrismaClient,
  clientId: string,
  opts?: ClientCatalogOpts,
): Promise<Array<{ serverName: string; toolName: string; description: string }>> {
  const catalog: Array<{ serverName: string; toolName: string; description: string }> = [];

  function pushWarning(msg: string): void {
    if (opts?.warnings) {
      opts.warnings.push(msg);
    } else {
      logger.warn(msg);
    }
  }

  const integrations = await db.clientIntegration.findMany({
    where: {
      clientId,
      type: IntegrationType.MCP_DATABASE,
      isActive: true,
    },
    select: { id: true, label: true, config: true },
  });

  const integrationDiscoveries = await Promise.all(
    integrations.map(async (integ) => {
      const cfg =
        typeof integ.config === 'object' &&
        integ.config !== null &&
        !Array.isArray(integ.config)
          ? (integ.config as Record<string, unknown>)
          : {};
      const url = typeof cfg.url === 'string' ? cfg.url : undefined;
      if (!url) {
        pushWarning(`Integration ${integ.label ?? integ.id} missing url — skipped`);
        return null;
      }
      let apiKey: string | undefined;
      if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
        if (looksEncrypted(cfg.apiKey)) {
          if (!opts?.encryptionKey) {
            pushWarning(
              `Cannot decrypt apiKey for integration ${integ.label ?? integ.id}: no encryptionKey provided`,
            );
            return null;
          }
          try {
            apiKey = decrypt(cfg.apiKey, opts.encryptionKey);
          } catch (err) {
            pushWarning(`Failed to decrypt apiKey for integration ${integ.label ?? integ.id}`);
            logger.warn({ err, integrationId: integ.id }, 'decrypt failed');
            return null;
          }
        } else {
          apiKey = cfg.apiKey;
        }
      }
      const authHeader = cfg.authHeader === 'x-api-key' ? 'x-api-key' : ('bearer' as const);
      const mcpPath = typeof cfg.mcpPath === 'string' ? cfg.mcpPath : undefined;
      try {
        const result = await discoverMcpServer({ url, mcpPath, apiKey, authHeader });
        return {
          serverName: integ.label ?? result.serverName ?? 'mcp-integration',
          tools: result.tools,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushWarning(`Discovery failed for integration ${integ.label ?? integ.id}: ${msg}`);
        logger.warn({ err, integrationId: integ.id }, 'MCP integration discovery failed');
        return null;
      }
    }),
  );

  for (const d of integrationDiscoveries) {
    if (!d) continue;
    for (const t of d.tools) {
      catalog.push({ serverName: d.serverName, toolName: t.name, description: t.description });
    }
  }

  const sharedServers: Array<{ name: string; url: string }> = [];
  if (opts?.mcpPlatformUrl) sharedServers.push({ name: 'platform', url: opts.mcpPlatformUrl });
  if (opts?.mcpRepoUrl) sharedServers.push({ name: 'repo', url: opts.mcpRepoUrl });
  if (opts?.mcpDatabaseUrl) sharedServers.push({ name: 'database', url: opts.mcpDatabaseUrl });

  const sharedDiscoveries = await Promise.all(
    sharedServers.map(async (server) => {
      try {
        const result = await discoverMcpServer({
          url: server.url,
          apiKey: opts?.platformApiKey,
          authHeader: 'x-api-key',
          callerName: 'copilot-api',
        });
        return { serverName: server.name, tools: result.tools };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushWarning(`Discovery failed for shared ${server.name} server: ${msg}`);
        logger.warn({ err, server: server.name }, 'Shared MCP discovery failed');
        return null;
      }
    }),
  );

  for (const d of sharedDiscoveries) {
    if (!d) continue;
    for (const t of d.tools) {
      catalog.push({ serverName: d.serverName, toolName: t.name, description: t.description });
    }
  }

  return catalog;
}
