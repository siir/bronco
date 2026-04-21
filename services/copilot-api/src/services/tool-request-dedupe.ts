import { PrismaClient } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import { TaskType, ToolRequestStatus, IntegrationType } from '@bronco/shared-types';
import { createLogger, decrypt, looksEncrypted } from '@bronco/shared-utils';
import { discoverMcpServer } from './mcp-discovery.js';

const logger = createLogger('tool-request-dedupe');

interface SharedMcpServer {
  name: string;
  url: string;
}

export interface DedupeOptions {
  mcpPlatformUrl?: string;
  mcpRepoUrl?: string;
  mcpDatabaseUrl?: string;
  platformApiKey?: string;
}

export interface DedupeResult {
  duplicateGroupsCount: number;
  improvesExistingCount: number;
  requestsAnalyzed: number;
  warnings: string[];
  raw: unknown;
}

interface DuplicateGroup {
  canonicalId: string;
  duplicateIds: string[];
  reason: string;
}

interface ImprovesExistingEntry {
  requestId: string;
  existingToolName: string;
  reason: string;
}

interface DedupeModelOutput {
  duplicateGroups?: DuplicateGroup[];
  improvesExisting?: ImprovesExistingEntry[];
}

export async function runToolRequestDedupe(
  db: PrismaClient,
  ai: AIRouter,
  clientId: string,
  encryptionKey: string,
  opts: DedupeOptions,
): Promise<DedupeResult> {
  const requests = await db.toolRequest.findMany({
    where: {
      clientId,
      status: { in: [ToolRequestStatus.PROPOSED, ToolRequestStatus.APPROVED] },
    },
    include: {
      rationales: { take: 5, orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (requests.length === 0) {
    return {
      duplicateGroupsCount: 0,
      improvesExistingCount: 0,
      requestsAnalyzed: 0,
      warnings: [],
      raw: { duplicateGroups: [], improvesExisting: [] },
    };
  }

  const warnings: string[] = [];
  const existingTools: Array<{ serverName: string; toolName: string; description: string }> = [];

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
      const cfg = typeof integ.config === 'object' && integ.config !== null && !Array.isArray(integ.config)
        ? (integ.config as Record<string, unknown>)
        : {};
      const url = typeof cfg.url === 'string' ? cfg.url : undefined;
      if (!url) {
        warnings.push(`Integration ${integ.label ?? integ.id} missing url — skipped`);
        return null;
      }
      let apiKey: string | undefined;
      if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
        try {
          apiKey = looksEncrypted(cfg.apiKey) ? decrypt(cfg.apiKey, encryptionKey) : cfg.apiKey;
        } catch (err) {
          warnings.push(`Failed to decrypt apiKey for integration ${integ.label ?? integ.id}`);
          logger.warn({ err, integrationId: integ.id }, 'decrypt failed');
          return null;
        }
      }
      const authHeader = cfg.authHeader === 'x-api-key' ? 'x-api-key' : 'bearer';
      const mcpPath = typeof cfg.mcpPath === 'string' ? cfg.mcpPath : undefined;
      try {
        const result = await discoverMcpServer({ url, mcpPath, apiKey, authHeader });
        return { serverName: integ.label ?? result.serverName ?? 'mcp-integration', tools: result.tools };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Discovery failed for integration ${integ.label ?? integ.id}: ${msg}`);
        logger.warn({ err, integrationId: integ.id }, 'MCP integration discovery failed');
        return null;
      }
    }),
  );

  for (const d of integrationDiscoveries) {
    if (!d) continue;
    for (const t of d.tools) {
      existingTools.push({ serverName: d.serverName, toolName: t.name, description: t.description });
    }
  }

  const sharedServers: SharedMcpServer[] = [];
  if (opts.mcpPlatformUrl) sharedServers.push({ name: 'platform', url: opts.mcpPlatformUrl });
  if (opts.mcpRepoUrl) sharedServers.push({ name: 'repo', url: opts.mcpRepoUrl });
  if (opts.mcpDatabaseUrl) sharedServers.push({ name: 'database', url: opts.mcpDatabaseUrl });

  const sharedDiscoveries = await Promise.all(
    sharedServers.map(async (server) => {
      try {
        const result = await discoverMcpServer({
          url: server.url,
          apiKey: opts.platformApiKey,
          authHeader: 'x-api-key',
        });
        return { serverName: server.name, tools: result.tools };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Discovery failed for shared ${server.name} server: ${msg}`);
        logger.warn({ err, server: server.name }, 'Shared MCP discovery failed');
        return null;
      }
    }),
  );

  for (const d of sharedDiscoveries) {
    if (!d) continue;
    for (const t of d.tools) {
      existingTools.push({ serverName: d.serverName, toolName: t.name, description: t.description });
    }
  }

  const userPayload = {
    existingTools,
    pendingRequests: requests.map((r) => ({
      id: r.id,
      requestedName: r.requestedName,
      displayTitle: r.displayTitle,
      description: r.description,
      rationales: r.rationales.map((ra) => ra.rationale),
    })),
  };
  const userPrompt = JSON.stringify(userPayload, null, 2);

  const result = await ai.generate({
    taskType: TaskType.ANALYZE_TOOL_REQUESTS,
    context: { clientId, entityId: clientId, entityType: 'client' },
    prompt: userPrompt,
    promptKey: 'analyze-tool-requests.system',
  });

  const cleaned = result.content
    .trim()
    .replace(/^```(?:json)?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();

  let parsed: DedupeModelOutput;
  try {
    parsed = JSON.parse(cleaned) as DedupeModelOutput;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = new Error(`Dedupe analysis returned non-JSON output: ${message}`) as Error & {
      debugContent?: string;
    };
    error.debugContent = result.content;
    throw error;
  }

  const duplicateGroups = Array.isArray(parsed.duplicateGroups) ? parsed.duplicateGroups : [];
  const improvesExisting = Array.isArray(parsed.improvesExisting) ? parsed.improvesExisting : [];
  const validIds = new Set(requests.map((r) => r.id));

  await db.$transaction(async (tx) => {
    const now = new Date();
    for (const group of duplicateGroups) {
      if (!group || !validIds.has(group.canonicalId)) continue;
      const dupIds = Array.isArray(group.duplicateIds) ? group.duplicateIds : [];
      for (const dupId of dupIds) {
        if (!validIds.has(dupId) || dupId === group.canonicalId) continue;
        await tx.toolRequest.update({
          where: { id: dupId },
          data: {
            suggestedDuplicateOfId: group.canonicalId,
            suggestedDuplicateReason: group.reason ?? null,
            dedupeAnalysisAt: now,
          },
        });
      }
    }
    for (const entry of improvesExisting) {
      if (!entry || !validIds.has(entry.requestId)) continue;
      if (!entry.existingToolName) continue;
      await tx.toolRequest.update({
        where: { id: entry.requestId },
        data: {
          suggestedImprovesExisting: entry.existingToolName,
          suggestedImprovesReason: entry.reason ?? null,
          dedupeAnalysisAt: now,
        },
      });
    }
  });

  return {
    duplicateGroupsCount: duplicateGroups.length,
    improvesExistingCount: improvesExisting.length,
    requestsAnalyzed: requests.length,
    warnings,
    raw: parsed,
  };
}
