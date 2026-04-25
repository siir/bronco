import { readFile } from 'node:fs/promises';
import { resolve as pathResolve, relative } from 'node:path';
import type { PrismaClient } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import { createLogger } from '@bronco/shared-utils';
import { TaskType } from '@bronco/shared-types';

const logger = createLogger('artifact-name-worker');

export interface ArtifactNameJob {
  artifactId: string;
}

/** Templated displayName prefixes from Phase 1 — only artifacts with these are eligible for friendly-name generation. */
const TEMPLATED_PREFIXES = ['Probe: ', 'Tool result: '];

/** Artifact kinds eligible for AI-generated friendly names. */
const ELIGIBLE_KINDS = new Set(['PROBE_RESULT', 'MCP_TOOL_RESULT']);

/** Max bytes of file content to read into the prompt preview. */
const PREVIEW_BYTES = 500;

interface ProcessorDeps {
  db: PrismaClient;
  ai: AIRouter;
  artifactStoragePath?: string;
}

function looksLikeTemplatedDefault(displayName: string | null): boolean {
  if (!displayName) return false;
  return TEMPLATED_PREFIXES.some((p) => displayName.startsWith(p));
}

function parseAiJson(text: string): { displayName: string; description: string } | null {
  // Strip code fences if present, then try parse.
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const displayName = typeof obj.displayName === 'string' ? obj.displayName.trim() : '';
    const description = typeof obj.description === 'string' ? obj.description.trim() : '';
    if (!displayName || !description) return null;
    // Sanity caps to keep DB clean.
    return {
      displayName: displayName.slice(0, 200),
      description: description.slice(0, 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Create the BullMQ processor for the `artifact-name-generation` queue.
 * One generation per artifact lifetime — bails if the displayName is no
 * longer a Phase 1 templated default. Best-effort: parse failures and
 * non-infra errors leave the templated default in place.
 */
export function createArtifactNameProcessor(deps: ProcessorDeps) {
  const { db, ai, artifactStoragePath } = deps;

  return async function processArtifactNameJob(job: { data: ArtifactNameJob }): Promise<void> {
    const { artifactId } = job.data;
    if (!artifactId) {
      logger.warn('artifact-name job missing artifactId — skipping');
      return;
    }

    // Load artifact + ticket clientId
    const artifact = await db.artifact.findUnique({
      where: { id: artifactId },
      select: {
        id: true,
        ticketId: true,
        kind: true,
        displayName: true,
        filename: true,
        storagePath: true,
        sizeBytes: true,
        source: true,
        ticket: { select: { clientId: true } },
      },
    });

    if (!artifact) {
      logger.warn({ artifactId }, 'Artifact not found — skipping');
      return;
    }

    // Defensive: only PROBE_RESULT and MCP_TOOL_RESULT are eligible.
    if (!artifact.kind || !ELIGIBLE_KINDS.has(artifact.kind)) {
      logger.debug({ artifactId, kind: artifact.kind }, 'Artifact kind not eligible — skipping');
      return;
    }

    // One-shot guard: skip if displayName has already been replaced (operator edit
    // or previous successful run) — only replace Phase 1 templated defaults.
    if (!looksLikeTemplatedDefault(artifact.displayName)) {
      logger.debug({ artifactId, displayName: artifact.displayName }, 'displayName not templated — skipping');
      return;
    }

    // Read up to PREVIEW_BYTES of file content
    let preview = '';
    if (artifactStoragePath && artifact.storagePath) {
      try {
        const resolvedRoot = pathResolve(artifactStoragePath);
        const fullPath = pathResolve(resolvedRoot, artifact.storagePath);
        // Path-traversal guard: keep within storage root.
        const rel = relative(resolvedRoot, fullPath);
        if (rel.startsWith('..')) {
          logger.warn({ artifactId, storagePath: artifact.storagePath }, 'Artifact path escaped storage root — skipping');
          return;
        }
        // Read only up to PREVIEW_BYTES; using a buffer + slice keeps us safe on large files.
        const buf = await readFile(fullPath);
        preview = buf.subarray(0, PREVIEW_BYTES).toString('utf-8');
      } catch (err) {
        logger.warn({ err, artifactId, storagePath: artifact.storagePath }, 'Failed to read artifact preview — skipping');
        return;
      }
    }

    // Derive a tool name hint from `source` (e.g. "probe:dm_exec_requests" or "mcp_tool:list_tickets").
    const toolNameHint = artifact.source?.includes(':') ? artifact.source.split(':').slice(1).join(':') : (artifact.source ?? 'unknown');

    const userPrompt = [
      `Artifact kind: ${artifact.kind}`,
      `Tool/source: ${toolNameHint}`,
      `Filename: ${artifact.filename}`,
      `Size: ${artifact.sizeBytes} bytes`,
      '',
      'Content preview (first 500 chars):',
      preview || '(empty or unreadable)',
    ].join('\n');

    let responseText: string;
    try {
      const result = await ai.generate({
        taskType: TaskType.GENERATE_ARTIFACT_NAME,
        promptKey: 'artifact.name.system',
        prompt: userPrompt,
        context: {
          entityType: 'artifact',
          entityId: artifactId,
          clientId: artifact.ticket?.clientId ?? null,
          skipClientMemory: true,
        },
      });
      responseText = result.content;
    } catch (err) {
      // True infra failure — log and let BullMQ decide via default retry policy. We don't add
      // explicit retries; default queue config (no retries) keeps this best-effort.
      logger.warn({ err, artifactId }, 'AI generate failed for artifact name — leaving Phase 1 default in place');
      return;
    }

    const parsed = parseAiJson(responseText);
    if (!parsed) {
      logger.warn({ artifactId, responseText: responseText.slice(0, 300) }, 'Failed to parse JSON for artifact name — leaving Phase 1 default in place');
      return;
    }

    // Re-check the row: an operator edit between dispatch and completion shouldn't be clobbered.
    const fresh = await db.artifact.findUnique({
      where: { id: artifactId },
      select: { displayName: true },
    });
    if (!fresh || !looksLikeTemplatedDefault(fresh.displayName)) {
      logger.debug({ artifactId }, 'displayName changed during generation — skipping update');
      return;
    }

    try {
      await db.artifact.update({
        where: { id: artifactId },
        data: {
          displayName: parsed.displayName,
          description: parsed.description,
        },
      });
      logger.info({ artifactId, displayName: parsed.displayName }, 'Artifact display name updated');
    } catch (err) {
      logger.warn({ err, artifactId }, 'Failed to persist artifact display name — leaving Phase 1 default in place');
    }
  };
}

// Re-export the queue name for convenience so callers don't need two imports.
export { ARTIFACT_NAME_QUEUE_NAME } from './artifact-name-queue.js';
