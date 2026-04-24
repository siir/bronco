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

    const validApiKey = config.API_KEY && apiKey === config.API_KEY;

    // If no auth is configured, allow all (dev mode)
    if (!config.API_KEY) return next();

    if (validApiKey) return next();

    res.status(401).json({ error: 'Unauthorized' });
  });

  // --- Caller-name extraction middleware ---
  // Reads X-Caller-Name after API_KEY is validated. Attaches to the request
  // for use by the MCP request handler. Does not reject missing headers unless
  // REQUIRE_CALLER_NAME=true (soft-enforcement during rollout).
  //
  // The header value is validated against a conservative pattern to prevent
  // log-injection and unexpected characters in error payloads.
  const CALLER_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

  app.use((req, res, next) => {
    if (req.path === '/health') return next();

    const rawCallerName = (req.headers['x-caller-name'] as string | undefined)?.trim() || null;

    if (!rawCallerName) {
      if (config.REQUIRE_CALLER_NAME) {
        logger.warn({ path: req.path }, 'MCP request rejected: X-Caller-Name header missing (REQUIRE_CALLER_NAME=true)');
        res.status(401).json({ error: 'X-Caller-Name header is required' });
        return;
      }
      logger.warn({ path: req.path }, 'MCP request missing X-Caller-Name header — proceeding in grace mode');
      res.locals['callerName'] = null;
      next();
      return;
    }

    if (!CALLER_NAME_PATTERN.test(rawCallerName)) {
      logger.warn({ path: req.path }, 'MCP request rejected: X-Caller-Name header contains invalid characters');
      res.status(400).json({ error: 'X-Caller-Name header must match [a-z0-9-]{1,64}' });
      return;
    }

    res.locals['callerName'] = rawCallerName;
    next();
  });

  // --- MCP Streamable HTTP transport ---
  app.post('/mcp', async (req, res) => {
    try {
      const callerName = (res.locals['callerName'] as string | null | undefined) ?? null;
      const server = createMcpServer({ ...serverDeps, callerName });
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
