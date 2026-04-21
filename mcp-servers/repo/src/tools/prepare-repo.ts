import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from '../repo-manager.js';

export function registerPrepareRepoTool(
  server: McpServer,
  deps: { db: PrismaClient; repoManager: RepoManager },
): void {
  const { repoManager } = deps;

  server.tool(
    'prepare_repo',
    'Ensure the bare clone for a repository is fetched and up to date. Called during pre-gather to warm the repo cache.',
    {
      repoId: z.string().uuid().describe('The CodeRepo ID'),
    },
    async ({ repoId }) => {
      try {
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
