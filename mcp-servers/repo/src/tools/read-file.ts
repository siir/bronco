import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from '../repo-manager.js';
import { executeCommand } from '../command-validator.js';

const DEFAULT_LIMIT = 4000;
const MAX_LIMIT = 16_000;

/**
 * Mirror of the sanitizeFilePath helper in ticket-analyzer — rejects absolute
 * paths, path-traversal segments, and strips a leading `./`.
 */
function sanitizeFilePath(fp: string): string | null {
  if (!fp || fp.startsWith('/')) return null;
  const normalized = fp.replace(/\\/g, '/');
  if (normalized.split('/').some(seg => seg === '..')) return null;
  return normalized.replace(/^\.\//, '');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function describeRepo(repo: { description: string | null }): string {
  return repo.description ? repo.description : 'Code repository';
}

export function registerReadFileTool(
  server: McpServer,
  deps: { db: PrismaClient; repoManager: RepoManager },
): void {
  const { db, repoManager } = deps;

  server.tool(
    'read_file',
    'Read the contents of a specific file in a registered code repository. Supports offset/limit paging for large files. Use this after search_code locates a file you want to inspect.',
    {
      repoId: z.string().uuid().describe('The CodeRepo ID'),
      filePath: z.string().min(1).describe('Repo-relative path to the file'),
      offset: z.number().int().nonnegative().optional().describe('Character offset to start reading from (default 0)'),
      limit: z.number().int().positive().optional().describe('Max chars to return (default 4000, max 16000)'),
      sessionId: z.string().optional().describe('Session ID for worktree reuse (auto-generated if omitted)'),
      clientId: z.string().uuid().optional().describe('Client ID for ownership validation'),
    },
    async ({ repoId, filePath, offset, limit, sessionId, clientId }) => {
      const sid = sessionId ?? randomUUID();

      const repo = await db.codeRepo.findUnique({
        where: { id: repoId },
        select: { clientId: true, name: true, description: true },
      });
      if (!repo) {
        return {
          content: [{ type: 'text' as const, text: `Repository not found: ${repoId}` }],
          isError: true,
        };
      }
      if (clientId && repo.clientId !== clientId) {
        return {
          content: [{ type: 'text' as const, text: 'Access denied: repository does not belong to the specified client.' }],
          isError: true,
        };
      }

      const safePath = sanitizeFilePath(filePath);
      if (!safePath) {
        return {
          content: [{ type: 'text' as const, text: `Invalid file path: ${filePath}` }],
          isError: true,
        };
      }

      const effectiveOffset = Math.max(offset ?? 0, 0);
      const effectiveLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

      try {
        const worktreePath = await repoManager.getOrCreateWorktree(repoId, sid);
        const result = await executeCommand(`cat ${shellQuote(safePath)}`, worktreePath);

        if (result.exitCode !== 0) {
          const stderr = result.stderr || '(no stderr)';
          return {
            content: [{ type: 'text' as const, text: `[${describeRepo(repo)}] read_file error on ${repo.name}:${safePath}: exit=${result.exitCode}\n${stderr}` }],
            isError: true,
          };
        }

        const fullContent = result.stdout;
        const totalChars = fullContent.length;
        const slice = fullContent.slice(effectiveOffset, effectiveOffset + effectiveLimit);

        // Number the lines for the slice. Line numbers are relative to the file start,
        // so we need to count newlines before the offset to get the starting line number.
        const startLine = effectiveOffset === 0
          ? 1
          : fullContent.slice(0, effectiveOffset).split('\n').length;

        const numbered = slice
          .split('\n')
          .map((line, idx) => `${startLine + idx}: ${line}`)
          .join('\n');

        const footer = `\n\n[returned ${slice.length} chars at offset ${effectiveOffset} of total ${totalChars}]`;

        return {
          content: [{ type: 'text' as const, text: numbered + footer }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
