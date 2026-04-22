import { PrismaClient } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import { TaskType, ToolRequestStatus } from '@bronco/shared-types';
import { buildClientToolCatalog } from '@bronco/shared-utils';

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
  const existingTools = await buildClientToolCatalog(db, clientId, {
    encryptionKey,
    mcpPlatformUrl: opts.mcpPlatformUrl,
    mcpRepoUrl: opts.mcpRepoUrl,
    mcpDatabaseUrl: opts.mcpDatabaseUrl,
    platformApiKey: opts.platformApiKey,
    warnings,
  });

  const userPayload = {
    existingTools,
    pendingRequests: requests.map((r) => ({
      id: r.id,
      kind: r.kind,
      requestedName: r.requestedName,
      displayTitle: r.displayTitle,
      description: r.description,
      rationales: r.rationales.map((ra) => ra.rationale),
    })),
    dedupeRules: [
      'When grouping duplicates, only merge requests that share the same kind.',
      'A BROKEN_TOOL report for "search_code" is NOT a duplicate of a NEW_TOOL request for "search_code".',
      'Format each candidate as "[<kind>] <requestedName> — <displayTitle>" in your reasoning.',
    ],
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

    // Clear suggestion fields for every analyzed row up-front so stale
    // suggestions from prior runs don't linger on rows the model didn't flag
    // this time (Copilot #3118042189). `dedupeAnalysisAt` is stamped here so
    // callers can distinguish "never analyzed" (null) from "analyzed, no
    // suggestions" (timestamp, all suggestion fields null).
    await tx.toolRequest.updateMany({
      where: { id: { in: [...validIds] } },
      data: {
        suggestedDuplicateOfId: null,
        suggestedDuplicateReason: null,
        suggestedImprovesExisting: null,
        suggestedImprovesReason: null,
        dedupeAnalysisAt: now,
      },
    });

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
