import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from '../repo-manager.js';
import { validateCommand, executeCommand } from '../command-validator.js';

export function registerAllTools(
  server: McpServer,
  deps: { db: PrismaClient; repoManager: RepoManager },
): void {
  const { db, repoManager } = deps;

  server.tool(
    'repo_exec',
    'Execute a read-only shell command in a sandboxed repository worktree. Only allowlisted commands are permitted (grep, find, cat, head, tail, ls, tree, etc). Pipes to grep/sed/awk/sort are allowed. Write only to ./tmp/ directory.',
    {
      repoId: z.string().uuid().describe('The CodeRepo ID'),
      command: z.string().describe('The shell command to execute'),
      sessionId: z.string().optional().describe('Session ID for worktree reuse (auto-generated if omitted)'),
    },
    async ({ repoId, command, sessionId }) => {
      const sid = sessionId ?? randomUUID();

      // Validate before creating worktree
      const validation = validateCommand(command);
      if (!validation.valid) {
        return {
          content: [{ type: 'text' as const, text: `Command rejected: ${validation.error}` }],
          isError: true,
        };
      }

      try {
        const worktreePath = await repoManager.getOrCreateWorktree(repoId, sid);
        const result = await executeCommand(command, worktreePath);

        const parts: string[] = [`[session:${sid}]`];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
        if (parts.length === 1) parts.push('(no output)');

        return {
          content: [{ type: 'text' as const, text: parts.join('\n\n') }],
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'list_repos',
    'List available code repositories registered for a client.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
    },
    async ({ clientId }) => {
      const where: Record<string, unknown> = { isActive: true };
      if (clientId) where.clientId = clientId;

      const repos = await db.codeRepo.findMany({
        where,
        include: { client: { select: { name: true } } },
        orderBy: { name: 'asc' },
      });

      const rows = repos.map((r) => ({
        id: r.id,
        name: r.name,
        repoUrl: r.repoUrl,
        defaultBranch: r.defaultBranch,
        client: r.client.name,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: rows.length > 0
            ? JSON.stringify(rows, null, 2)
            : 'No repositories found.',
        }],
      };
    },
  );

  server.tool(
    'repo_cleanup',
    'Release a session\'s repository worktrees to free disk space.',
    {
      sessionId: z.string().describe('The session ID to clean up'),
    },
    async ({ sessionId }) => {
      await repoManager.cleanupSession(sessionId);
      return {
        content: [{ type: 'text' as const, text: `Session ${sessionId} worktrees cleaned up.` }],
      };
    },
  );
}
