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
  /**
   * Caller identity from the X-Caller-Name request header.
   * Null when the header is absent (grace-mode: request proceeds with a WARN).
   * Used by the tool-dispatch guard to enforce per-caller allowlists.
   */
  callerName: string | null;
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
