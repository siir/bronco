import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from '../repo-manager.js';
import { executeCommand } from '../command-validator.js';

function sanitizeDirectory(dir: string): string | null {
  if (!dir) return '.';
  if (dir.startsWith('/')) return null;
  const normalized = dir.replace(/\\/g, '/');
  if (normalized.split('/').some(seg => seg === '..')) return null;
  return normalized.replace(/^\.\//, '') || '.';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function registerListFilesTool(
  server: McpServer,
  deps: { db: PrismaClient; repoManager: RepoManager },
): void {
  const { db, repoManager } = deps;

  server.tool(
    'list_files',
    'List files in a registered code repository, optionally filtered by glob pattern or directory. Use this for discovery when you aren\'t sure what files exist.',
    {
      repoId: z.string().uuid().describe('The CodeRepo ID'),
      pattern: z.string().optional().describe('Glob pattern to match (default "*")'),
      directory: z.string().optional().describe('Directory to search within (default ".")'),
      maxResults: z.number().int().positive().optional().describe('Cap on returned paths (default 200)'),
      sessionId: z.string().optional().describe('Session ID for worktree reuse (auto-generated if omitted)'),
      clientId: z.string().uuid().optional().describe('Client ID for ownership validation'),
    },
    async ({ repoId, pattern, directory, maxResults, sessionId, clientId }) => {
      const sid = sessionId ?? randomUUID();

      const repo = await db.codeRepo.findUnique({
        where: { id: repoId },
        select: { clientId: true, name: true },
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

      const safeDir = sanitizeDirectory(directory ?? '.');
      if (!safeDir) {
        return {
          content: [{ type: 'text' as const, text: `Invalid directory: ${directory}` }],
          isError: true,
        };
      }

      const effectivePattern = pattern && /^[A-Za-z0-9._*?\[\]/-]+$/.test(pattern) ? pattern : '*';
      const cap = Math.min(Math.max(maxResults ?? 200, 1), 2000);

      // `executeCommand` truncates stdout at 50k chars. To report an accurate
      // `total` even for large repos, count via a separate `find | wc -l` call
      // and return only the capped slice via `find | head`.
      const baseFind = `find ${shellQuote(safeDir)} -type f -name ${shellQuote(effectivePattern)}`;
      const countCommand = `${baseFind} | wc -l`;
      const listCommand = `${baseFind} | head -n ${cap}`;

      try {
        const worktreePath = await repoManager.getOrCreateWorktree(repoId, sid);

        const countResult = await executeCommand(countCommand, worktreePath);
        if (countResult.exitCode !== 0) {
          const stderr = countResult.stderr || '(no stderr)';
          return {
            content: [{ type: 'text' as const, text: `list_files error on ${repo.name}: exit=${countResult.exitCode}\n${stderr}` }],
            isError: true,
          };
        }
        const totalText = countResult.stdout.trim();
        const total = Number.parseInt(totalText, 10);
        if (!Number.isFinite(total) || total < 0) {
          return {
            content: [{ type: 'text' as const, text: `list_files error on ${repo.name}: unable to parse total count: ${totalText || '(empty stdout)'}` }],
            isError: true,
          };
        }

        const listResult = await executeCommand(listCommand, worktreePath);
        if (listResult.exitCode !== 0) {
          const stderr = listResult.stderr || '(no stderr)';
          return {
            content: [{ type: 'text' as const, text: `list_files error on ${repo.name}: exit=${listResult.exitCode}\n${stderr}` }],
            isError: true,
          };
        }

        const slice = listResult.stdout.split('\n').filter(l => l.length > 0);
        const footer = `\n\n[returned ${slice.length} of total ${total} matching]`;
        const text = slice.length > 0
          ? slice.join('\n') + footer
          : `[returned 0 of total ${total} matching]`;

        return {
          content: [{ type: 'text' as const, text }],
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
