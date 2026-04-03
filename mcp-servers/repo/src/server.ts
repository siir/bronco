import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { RepoManager } from './repo-manager.js';
import { registerAllTools } from './tools/index.js';

export interface ServerDeps {
  db: PrismaClient;
  repoManager: RepoManager;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: 'bronco-repo-server',
      version: '0.1.0',
    },
    {
      capabilities: { logging: {} },
    },
  );

  registerAllTools(server, deps);

  return server;
}
