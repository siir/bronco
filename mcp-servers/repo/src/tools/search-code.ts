import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from '../repo-manager.js';
import { executeCommand } from '../command-validator.js';

const DEFAULT_FILE_EXTENSIONS = [
  '.cs', '.sql', '.ts', '.tsx', '.js', '.jsx',
  '.cshtml', '.razor', '.aspx', '.xml', '.config',
  '.json', '.yaml', '.yml', '.md', '.py', '.go',
  '.java', '.rb', '.rs', '.php',
] as const;

const MAX_OUTPUT_CHARS = 40_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function describeRepo(repo: { name: string; description: string | null }): string {
  return repo.description ? repo.description : 'Code repository';
}

export function registerSearchCodeTool(
  server: McpServer,
  deps: { db: PrismaClient; repoManager: RepoManager },
): void {
  const { db, repoManager } = deps;

  server.tool(
    'search_code',
    'Search for code patterns, symbols, class names, SQL procedure definitions, configuration keys, or any text across a registered code repository. Prefer this over run_custom_query when looking for object definitions, code references, or configuration values — only fall back to database queries when the repo lookup returns nothing.',
    {
      repoId: z.string().uuid().describe('The CodeRepo ID'),
      query: z.string().min(1).describe('Text or regex pattern to search for'),
      filePattern: z.string().optional().describe('Optional glob filter (e.g. "*.cs")'),
      fileExtensions: z.array(z.string()).optional().describe('Only include files matching these extensions (e.g. [".ts", ".sql"]). Falls back to the repo\'s configured extensions, or a sensible default list.'),
      caseSensitive: z.boolean().optional().describe('Case-sensitive match (default false)'),
      wordBoundary: z.boolean().optional().describe('Whole-word match (default false)'),
      maxResults: z.number().int().positive().optional().describe('Cap on returned matches (default 100)'),
      sessionId: z.string().optional().describe('Session ID for worktree reuse (auto-generated if omitted)'),
      clientId: z.string().uuid().optional().describe('Client ID for ownership validation'),
    },
    async ({ repoId, query, filePattern, fileExtensions, caseSensitive, wordBoundary, maxResults, sessionId, clientId }) => {
      const sid = sessionId ?? randomUUID();

      const repo = await db.codeRepo.findUnique({
        where: { id: repoId },
        select: { clientId: true, name: true, description: true, fileExtensions: true },
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

      const cap = Math.min(Math.max(maxResults ?? 100, 1), 500);
      const effectiveExtensions = (fileExtensions && fileExtensions.length > 0)
        ? fileExtensions
        : (repo.fileExtensions && repo.fileExtensions.length > 0)
          ? repo.fileExtensions
          : [...DEFAULT_FILE_EXTENSIONS];

      const flags: string[] = ['-rn', '-I'];
      if (!caseSensitive) flags.push('-i');
      if (wordBoundary) flags.push('-w');

      const includeArgs = effectiveExtensions
        .map(ext => {
          const clean = ext.startsWith('.') ? ext.slice(1) : ext;
          if (!/^[A-Za-z0-9._-]+$/.test(clean)) return null;
          return `--include=*.${clean}`;
        })
        .filter((v): v is string => v !== null);

      if (filePattern) {
        if (/^[A-Za-z0-9._*?\[\]/-]+$/.test(filePattern)) {
          includeArgs.push(`--include=${filePattern}`);
        }
      }

      const command = [
        'grep',
        ...flags,
        ...includeArgs,
        shellQuote(query),
        '.',
      ].join(' ');

      try {
        const worktreePath = await repoManager.getOrCreateWorktree(repoId, sid);
        const result = await executeCommand(command, worktreePath);

        // grep exits 1 when no match — not an error for us
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          const stderr = result.stderr || '(no stderr)';
          return {
            content: [{ type: 'text' as const, text: `[${describeRepo(repo)}] search_code error on ${repo.name}: exit=${result.exitCode}\n${stderr}` }],
            isError: true,
          };
        }

        const lines = result.stdout.split('\n').filter(l => l.length > 0);
        const files = new Set<string>();
        const outputLines: string[] = [];
        for (const line of lines) {
          if (outputLines.length >= cap) break;
          // grep -rn output format: ./path/to/file:<lineNo>:<matchingLine>
          const match = line.match(/^\.?\/?([^:]+):(\d+):(.*)$/);
          if (match) {
            const filePath = match[1];
            const lineNumber = match[2];
            const matchingLine = match[3];
            files.add(filePath);
            outputLines.push(`${filePath}:${lineNumber}: ${matchingLine}`);
          } else {
            outputLines.push(line);
          }
        }

        const truncatedNote = lines.length > cap ? ` (truncated — ${lines.length - cap} more)` : '';
        const footer = outputLines.length > 0
          ? `\n\n[found ${outputLines.length} matches across ${files.size} files${truncatedNote}]`
          : `[found 0 matches]`;

        let text = outputLines.length > 0
          ? outputLines.join('\n') + footer
          : footer;

        if (text.length > MAX_OUTPUT_CHARS) {
          text = text.slice(0, MAX_OUTPUT_CHARS) + '\n\n[output truncated — exceeded 40,000 characters]';
        }

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
