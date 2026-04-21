import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

/**
 * Above this file size, switch from full readFile to positional fs.open reads
 * to bound working memory. Common-case artifacts (truncated tool output, ~16k
 * chars) stay on the simple path; pathological large artifacts can't OOM the
 * mcp-platform process.
 */
const STREAM_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** Cap grep match output to bound the response size. */
const GREP_MAX_MATCHES = 200;

export function registerArtifactTools(server: McpServer, { db, config }: ServerDeps): void {
  server.tool(
    'read_tool_result_artifact',
    'Read a truncated tool-result artifact referenced by artifactId. Use when a prior tool result was truncated and you need to inspect more of it. Supports paging (offset + limit) and grep (regex search).',
    {
      artifactId: z.string().uuid().describe('The artifact ID from a prior truncated tool result'),
      ticketId: z.string().uuid().describe('The active ticket ID (server-injected for auth scope)'),
      offset: z.number().int().min(0).default(0).describe('Char offset to start reading from (byte offset for files >5MB)'),
      limit: z.number().int().min(1).max(16000).default(4000).describe('Max chars to return'),
      grep: z.string().optional().describe('Regex pattern to search for. When provided, offset/limit are ignored.'),
    },
    async (params) => {
      const artifact = await db.artifact.findUnique({ where: { id: params.artifactId } });
      if (!artifact || artifact.ticketId !== params.ticketId) {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }] };
      }

      // Defense-in-depth: validate the resolved path stays within the storage root.
      // storagePath comes from the DB; a poisoned/corrupted row could otherwise enable
      // path traversal. Same pattern as saveMcpToolArtifact in analysis/shared.ts.
      const resolvedStorage = resolve(config.ARTIFACT_STORAGE_PATH);
      const absPath = resolve(resolvedStorage, artifact.storagePath);
      const rel = relative(resolvedStorage, absPath);
      if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }] };
      }

      let fileSize: number;
      try {
        const stats = await stat(absPath);
        fileSize = stats.size;
      } catch {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }] };
      }

      // Grep mode — always stream line-by-line to keep memory bounded regardless of file size.
      if (params.grep) {
        let regex: RegExp;
        try {
          regex = new RegExp(params.grep);
        } catch (err) {
          return { content: [{ type: 'text', text: `ERROR: invalid regex pattern: ${err instanceof Error ? err.message : String(err)}` }] };
        }

        const matches: string[] = [];
        let lineNum = 0;
        let totalLines = 0;
        let truncatedMatches = false;

        try {
          const rl = createInterface({
            input: createReadStream(absPath, { encoding: 'utf-8' }),
            crlfDelay: Infinity,
          });
          for await (const line of rl) {
            lineNum++;
            totalLines = lineNum;
            if (matches.length < GREP_MAX_MATCHES && regex.test(line)) {
              matches.push(`line ${lineNum}: ${line}`);
              if (matches.length === GREP_MAX_MATCHES) truncatedMatches = true;
            }
          }
        } catch {
          return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }] };
        }

        if (matches.length === 0) {
          return { content: [{ type: 'text', text: `No matches for pattern: ${params.grep}` }] };
        }
        const footerSuffix = truncatedMatches ? ` (capped at ${GREP_MAX_MATCHES})` : '';
        const footer = `\n\n[matched ${matches.length} lines of ${totalLines} total${footerSuffix}]`;
        return { content: [{ type: 'text', text: `${matches.join('\n')}${footer}` }] };
      }

      // offset/limit mode — small files use exact char slicing for backward-compatible semantics;
      // large files switch to positional byte reads to bound memory. The schema documents the
      // boundary so callers know offset is char-based for ≤5MB, byte-based above.
      if (fileSize <= STREAM_THRESHOLD_BYTES) {
        let full: string;
        try {
          const handle = await open(absPath, 'r');
          try {
            const buf = Buffer.alloc(fileSize);
            await handle.read(buf, 0, fileSize, 0);
            full = buf.toString('utf-8');
          } finally {
            await handle.close();
          }
        } catch {
          return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }] };
        }
        const slice = full.slice(params.offset, params.offset + params.limit);
        const footer = `\n\n[returned ${slice.length} chars at offset ${params.offset} of total ${full.length}]`;
        return { content: [{ type: 'text', text: `${slice}${footer}` }] };
      }

      // Large file: positional byte read. offset/limit are interpreted as bytes here. Multi-byte
      // UTF-8 characters at the slice boundary may render as replacement chars — acceptable for
      // tool output (mostly ASCII: SQL results, log lines, JSON). The footer reports byte units
      // so callers can page predictably.
      try {
        const handle = await open(absPath, 'r');
        try {
          const safeOffset = Math.min(params.offset, fileSize);
          const remaining = Math.max(0, fileSize - safeOffset);
          const readLen = Math.min(params.limit, remaining);
          const buf = Buffer.alloc(readLen);
          let bytesRead = 0;
          if (readLen > 0) {
            const result = await handle.read(buf, 0, readLen, safeOffset);
            bytesRead = result.bytesRead;
          }
          const slice = buf.slice(0, bytesRead).toString('utf-8');
          const footer = `\n\n[returned ${bytesRead} bytes at offset ${safeOffset} of total ${fileSize} bytes (file >${STREAM_THRESHOLD_BYTES / 1024 / 1024}MB — offset/limit are bytes, not chars)]`;
          return { content: [{ type: 'text', text: `${slice}${footer}` }] };
        } finally {
          await handle.close();
        }
      } catch {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }] };
      }
    },
  );
}
