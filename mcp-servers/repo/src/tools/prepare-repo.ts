import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from '../repo-manager.js';

export function registerPrepareRepoTool(
  server: McpServer,
  deps: { db: PrismaClient; repoManager: RepoManager },
): void {
  const { db, repoManager } = deps;

  server.tool(
    'prepare_repo',
    'Ensure the bare clone for a repository is fetched and up to date. Called during pre-gather to warm the repo cache.',
    {
      repoId: z.string().uuid().describe('The CodeRepo ID'),
      clientId: z.string().uuid().optional().describe('Optional client ID used to validate repository ownership'),
    },
    async ({ repoId, clientId }) => {
      try {
        // Defense-in-depth: mirror the ownership check used by the other per-repo
        // tools (repo_exec, search_code, read_file, list_files). prepare_repo is
        // callable over MCP even though it isn't registered as an agentic tool.
        if (clientId) {
          const repo = await db.codeRepo.findUnique({
            where: { id: repoId },
            select: { clientId: true },
          });
          if (!repo || repo.clientId !== clientId) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ status: 'failed', message: 'Access denied: repository does not belong to the specified client.' }) }],
              isError: true,
            };
          }
        }
        await repoManager.clone(repoId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ready', message: `Repo ${repoId} is ready` }) }],
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'failed', message }) }],
          isError: true,
        };
      }
    },
  );
}
