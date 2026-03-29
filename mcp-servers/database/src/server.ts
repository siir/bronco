import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PoolManager } from './connections/pool-manager.js';
import type { AuditLogger } from './security/audit-logger.js';
import { registerAllTools } from './tools/index.js';

export interface ServerDeps {
  poolManager: PoolManager;
  auditLogger: AuditLogger;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: 'bronco-database',
      version: '0.1.0',
    },
    {
      capabilities: { logging: {} },
    },
  );

  registerAllTools(server, deps.poolManager, deps.auditLogger);

  return server;
}
