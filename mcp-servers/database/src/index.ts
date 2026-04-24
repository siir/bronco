import express from 'express';
import { getDb, disconnectDb } from '@bronco/db';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger, createGracefulShutdown } from '@bronco/shared-utils';
import { getConfig } from './config.js';
import { loadSystemsFromDb } from './systems-loader.js';
import { createMcpServer } from './server.js';
import { PoolManager } from './connections/pool-manager.js';
import { AuditLogger } from './security/audit-logger.js';
import { runQuery } from './tools/run-query.js';
import { inspectSchema } from './tools/inspect-schema.js';
import { listIndexes } from './tools/list-indexes.js';
import { getBlockingTree } from './tools/blocking-tree.js';
import { getWaitStats } from './tools/wait-stats.js';
import { getDatabaseHealth } from './tools/database-health.js';

const logger = createLogger('mcp-database');
const bridgeCaller = 'api:copilot';

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  const systems = await loadSystemsFromDb(db, config.ENCRYPTION_KEY);

  // Shared pool manager and audit logger for both MCP and bridge routes
  const poolManager = new PoolManager(systems);
  const auditLogger = new AuditLogger();

  // Register on-miss loader so new systems added via the control panel
  // are picked up automatically without a restart.
  poolManager.setOnMissLoader(() => loadSystemsFromDb(db, config.ENCRYPTION_KEY));

  // Shared deps for MCP tool registration
  const serverDeps = { poolManager, auditLogger };

  const app = express();
  app.use(express.json());

  // --- Health check (no auth) ---
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // --- Auth middleware for all other routes ---
  app.use((req, res, next) => {
    if (req.path === '/health') return next();

    // Check API key header
    const apiKey = req.headers['x-api-key'] as string | undefined;

    const validApiKey = config.API_KEY && apiKey === config.API_KEY;

    // If no auth is configured, allow all (dev mode)
    if (!config.API_KEY) return next();

    if (validApiKey) return next();

    res.status(401).json({ error: 'Unauthorized' });
  });

  // --- MCP Streamable HTTP transport (for Claude Code) ---
  // Each request creates a fresh server+transport pair (stateless mode).
  // createMcpServer is lightweight — it just registers tool handlers.
  // The poolManager and auditLogger are shared across all requests.
  app.post('/mcp', async (req, res) => {
    try {
      const server = createMcpServer(serverDeps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, 'MCP request failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/mcp', async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST for Streamable HTTP.' },
      id: null,
    }));
  });

  app.delete('/mcp', async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session termination not supported in stateless mode.' },
      id: null,
    }));
  });

  // --- REST bridge routes (for copilot-api on Hugo) ---
  app.get('/systems', async (_req, res) => {
    try {
      const systems = poolManager.listSystems();
      res.json(systems);
    } catch (err) {
      logger.error({ err }, 'list systems failed');
      res.status(500).json({ error: 'Failed to list systems' });
    }
  });

  app.post('/tools/run-query', async (req, res) => {
    try {
      const result = await runQuery(req.body, poolManager, auditLogger, bridgeCaller);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  app.post('/tools/inspect-schema', async (req, res) => {
    try {
      const result = await inspectSchema(req.body, poolManager, auditLogger, bridgeCaller);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  app.post('/tools/list-indexes', async (req, res) => {
    try {
      const result = await listIndexes(req.body, poolManager, auditLogger, bridgeCaller);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  app.post('/tools/blocking-tree', async (req, res) => {
    try {
      const result = await getBlockingTree(req.body, poolManager, auditLogger, bridgeCaller);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  app.post('/tools/wait-stats', async (req, res) => {
    try {
      const result = await getWaitStats(req.body, poolManager, auditLogger, bridgeCaller);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  app.post('/tools/database-health', async (req, res) => {
    try {
      const result = await getDatabaseHealth(req.body, poolManager, auditLogger, bridgeCaller);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // --- Start server ---
  const httpServer = app.listen(config.PORT, '0.0.0.0', () => {
    logger.info({ port: config.PORT }, 'MCP Database Server listening');
    logger.info(`  MCP endpoint:   POST http://0.0.0.0:${config.PORT}/mcp`);
    logger.info(`  Bridge routes:  POST http://0.0.0.0:${config.PORT}/tools/*`);
    logger.info(`  Health check:   GET  http://0.0.0.0:${config.PORT}/health`);
  });

  createGracefulShutdown(logger, [
    { fn: () => new Promise<void>((resolve) => httpServer.close(() => resolve())) },
    { fn: () => poolManager.closeAll() },
    { fn: () => disconnectDb() },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start MCP Database Server');
  process.exit(1);
});
