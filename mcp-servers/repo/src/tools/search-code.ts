import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from '../repo-manager.js';

const execAsync = promisify(exec);

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

/**
 * Classify an `execAsync` rejection so the caller can distinguish
 * "ripgrep ran and found nothing" (exit 1) from real failures
 * (timeout / signal / system error / rg internal error). Without this, all
 * non-zero exits previously bucketed as `code ?? 1`, masking timeouts and
 * kills as silent "no matches" results (#465).
 *
 * Exported for unit testing.
 */
export interface ExecErrorClassification {
  /**
   *  - 'no-matches': rg exited 1 (no matches found, treat as empty result).
   *  - 'rg-error':   rg exited 2+ (e.g. invalid regex, IO error).
   *  - 'timeout':    process killed by execAsync's `timeout` option.
   *  - 'killed':     process killed by some other signal (OOM, SIGKILL, etc).
   *  - 'unknown':    rejection didn't carry a recognizable shape (rare).
   */
  kind: 'no-matches' | 'rg-error' | 'timeout' | 'killed' | 'unknown';
  exitCode?: number;
  signal?: string;
  stderr?: string;
}

export function classifyExecError(err: unknown): ExecErrorClassification {
  const e = err as {
    code?: number | string;
    signal?: NodeJS.Signals | string | null;
    killed?: boolean;
    stderr?: string;
  };

  const stderr = typeof e?.stderr === 'string' ? e.stderr : undefined;
  const codeNum = typeof e?.code === 'number' ? e.code : undefined;
  const signal = e?.signal ?? undefined;
  const killed = e?.killed === true;

  // execAsync sets `killed: true` and `signal: 'SIGTERM'` when the `timeout`
  // option fires. Treat any killed-by-signal rejection as a real error rather
  // than a "no matches" result. Distinguish timeout from other signals so the
  // operator-facing error message is actionable.
  if (killed || (signal && signal !== null)) {
    const sigName = typeof signal === 'string' ? signal : undefined;
    if (sigName === 'SIGTERM') {
      return { kind: 'timeout', signal: sigName, stderr };
    }
    return { kind: 'killed', signal: sigName, stderr };
  }

  if (codeNum === 1) {
    return { kind: 'no-matches', exitCode: 1, stderr };
  }
  if (codeNum !== undefined) {
    return { kind: 'rg-error', exitCode: codeNum, stderr };
  }

  return { kind: 'unknown', stderr };
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

      // Per-file match cap: give a representative sample without walking huge files fully.
      const perFileCap = Math.max(2, Math.ceil(cap / 8));

      const flags: string[] = ['-n', '--no-heading', '--color', 'never', '-m', String(perFileCap)];
      if (!caseSensitive) flags.push('-i');
      if (wordBoundary) flags.push('-w');

      const globArgs = effectiveExtensions
        .map(ext => {
          const clean = ext.startsWith('.') ? ext.slice(1) : ext;
          if (!/^[A-Za-z0-9._-]+$/.test(clean)) return null;
          return `--glob=*.${clean}`;
        })
        .filter((v): v is string => v !== null);

      if (filePattern) {
        if (/^[A-Za-z0-9._*?\[\]/-]+$/.test(filePattern)) {
          globArgs.push(`--glob=${filePattern}`);
        }
      }

      // Use `--` so patterns beginning with `-` are not treated as rg options.
      const command = [
        'rg',
        ...flags,
        ...globArgs,
        '--',
        shellQuote(query),
        '.',
      ].join(' ');

      // Direct exec rationale (#465 Item 3): we deliberately bypass the
      // command-validator/executeCommand path here. That path is built for
      // arbitrary operator commands via `repo_exec` (find/grep/cat/etc.) and
      // would require us to add `rg` to its base allowlist. Here, every shell
      // token is constructed under our control: flags are constants, globs go
      // through a strict `^[A-Za-z0-9._*?\[\]/-]+$` regex, the user query is
      // single-quoted via `shellQuote` and isolated by `--`. We also impose
      // an explicit timeout + maxBuffer below. The defense-in-depth concern
      // raised on PR #461 is real but the threat model here is different —
      // search_code is internal, not a generic shell.
      try {
        const worktreePath = await repoManager.getOrCreateWorktree(repoId, sid);

        let stdout = '';
        try {
          const result = await execAsync(command, { cwd: worktreePath, timeout: 30_000, maxBuffer: 1024 * 1024 });
          stdout = result.stdout;
        } catch (err: unknown) {
          const classification = classifyExecError(err);
          // rg's stdout up to the failure point can still contain partial
          // matches — keep it for the no-matches case.
          const partial = (err as { stdout?: string }).stdout ?? '';
          stdout = partial;

          const stderr = classification.stderr || '(no stderr)';
          switch (classification.kind) {
            case 'no-matches':
              // Expected — rg exits 1 when nothing matches. Fall through
              // to the empty-stdout output path below.
              break;
            case 'timeout':
              return {
                content: [{ type: 'text' as const, text: `[${describeRepo(repo)}] search_code timed out on ${repo.name} after 30s. The query may be too broad — try a more specific term, narrow the file extensions, or break the search into multiple calls.\n${stderr}` }],
                isError: true,
              };
            case 'killed':
              return {
                content: [{ type: 'text' as const, text: `[${describeRepo(repo)}] search_code was killed (signal=${classification.signal ?? 'unknown'}) on ${repo.name}. This usually indicates the host is under memory pressure or the worktree was cleaned up mid-search.\n${stderr}` }],
                isError: true,
              };
            case 'rg-error':
              return {
                content: [{ type: 'text' as const, text: `[${describeRepo(repo)}] search_code error on ${repo.name}: rg exit=${classification.exitCode}\n${stderr}` }],
                isError: true,
              };
            case 'unknown':
              return {
                content: [{ type: 'text' as const, text: `[${describeRepo(repo)}] search_code failed on ${repo.name} with no exit code and no signal — likely a child-process spawn or system error.\n${stderr}` }],
                isError: true,
              };
          }
        }

        const lines = stdout.split('\n').filter(l => l.length > 0);
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
