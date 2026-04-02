import express from 'express';
import { getDb, disconnectDb } from '@bronco/db';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger, createGracefulShutdown, createQueue } from '@bronco/shared-utils';
import { getConfig } from './config.js';
import { createMcpServer } from './server.js';

const logger = createLogger('mcp-platform');

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  const probeQueue = createQueue('probe-execution', config.REDIS_URL);
  const issueResolveQueue = createQueue('issue-resolve', config.REDIS_URL);

  const serverDeps = { db, config, probeQueue, issueResolveQueue };

  const app = express();
  app.use(express.json());

  // --- Health check (no auth) ---
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // --- Auth middleware for all other routes ---
  app.use((req, res, next) => {
    if (req.path === '/health') return next();

    const apiKey = req.headers['x-api-key'] as string | undefined;
    const authHeader = req.headers['authorization'] as string | undefined;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    const validApiKey = config.API_KEY && apiKey === config.API_KEY;
    const validBearer = config.MCP_AUTH_TOKEN && bearerToken === config.MCP_AUTH_TOKEN;

    // If neither auth method is configured, allow all (dev mode)
    if (!config.API_KEY && !config.MCP_AUTH_TOKEN) return next();

    if (validApiKey || validBearer) return next();

    res.status(401).json({ error: 'Unauthorized' });
  });

  // --- MCP Streamable HTTP transport ---
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

  // --- Start server ---
  const httpServer = app.listen(config.PORT, '0.0.0.0', () => {
    logger.info({ port: config.PORT }, 'MCP Platform Server listening');
    logger.info(`  MCP endpoint:   POST http://0.0.0.0:${config.PORT}/mcp`);
    logger.info(`  Health check:   GET  http://0.0.0.0:${config.PORT}/health`);
  });

  createGracefulShutdown(logger, [
    { fn: () => new Promise<void>((resolve) => httpServer.close(() => resolve())) },
    { fn: () => probeQueue.close() },
    { fn: () => issueResolveQueue.close() },
    { fn: () => disconnectDb() },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start MCP Platform Server');
  process.exit(1);
});
