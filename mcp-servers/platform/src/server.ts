import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '@bronco/db';
import type { Queue } from 'bullmq';
import type { Config } from './config.js';
import { registerAllTools } from './tools/index.js';

export interface ServerDeps {
  db: PrismaClient;
  config: Config;
  probeQueue: Queue;
  issueResolveQueue: Queue;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: 'bronco-platform',
      version: '0.1.0',
    },
    {
      capabilities: { logging: {} },
    },
  );

  registerAllTools(server, deps);

  return server;
}
