import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from '../repo-manager.js';

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
        // Resolve absolute path and verify it's still inside the worktree —
        // belt-and-suspenders alongside sanitizeFilePath (guards against symlinks
        // escaping via `..` that survive the string-level check).
        const absolutePath = resolve(join(worktreePath, safePath));
        const relToWorktree = relative(worktreePath, absolutePath);
        if (relToWorktree === '' || relToWorktree.startsWith('..') || isAbsolute(relToWorktree)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid file path: ${filePath}` }],
            isError: true,
          };
        }

        // Stat first so we report the real total file size regardless of slice.
        let fileStat;
        try {
          fileStat = await stat(absolutePath);
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `[${describeRepo(repo)}] read_file error on ${repo.name}:${safePath}: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
        if (!fileStat.isFile()) {
          return {
            content: [{ type: 'text' as const, text: `[${describeRepo(repo)}] read_file error on ${repo.name}:${safePath}: not a regular file` }],
            isError: true,
          };
        }
        const totalChars = fileStat.size;

        // Bounded read: allocate only the slice. Read at position=offset so a
        // 1GB file with offset=10MB, limit=4k reads only 4k bytes.
        const fh = await open(absolutePath, 'r');
        try {
          const sliceBuffer = Buffer.alloc(effectiveLimit);
          const { bytesRead } = await fh.read(sliceBuffer, 0, effectiveLimit, effectiveOffset);
          const slice = sliceBuffer.slice(0, bytesRead).toString('utf8');

          // Compute startLine by streaming the prefix [0, offset) once.
          // Counts newlines directly to avoid holding the prefix in memory.
          let startLine = 1;
          if (effectiveOffset > 0) {
            const PREFIX_CHUNK = 64 * 1024;
            const prefixBuf = Buffer.alloc(PREFIX_CHUNK);
            let pos = 0;
            while (pos < effectiveOffset) {
              const readLen = Math.min(PREFIX_CHUNK, effectiveOffset - pos);
              const r = await fh.read(prefixBuf, 0, readLen, pos);
              if (r.bytesRead === 0) break;
              for (let i = 0; i < r.bytesRead; i++) {
                if (prefixBuf[i] === 0x0a /* \n */) startLine++;
              }
              pos += r.bytesRead;
            }
          }

          const numbered = slice
            .split('\n')
            .map((line, idx) => `${startLine + idx}: ${line}`)
            .join('\n');

          const footer = `\n\n[returned ${bytesRead} chars at offset ${effectiveOffset} of total ${totalChars}]`;

          return {
            content: [{ type: 'text' as const, text: numbered + footer }],
            isError: false,
          };
        } finally {
          await fh.close();
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
