import { spawn } from 'node:child_process';
import express from 'express';
import { getDb, disconnectDb } from '@bronco/db';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger, createGracefulShutdown } from '@bronco/shared-utils';
import { getConfig } from './config.js';
import { createMcpServer } from './server.js';
import { RepoManager } from './repo-manager.js';

const logger = createLogger('mcp-repo');

// --- SSH reachability probe (cached) ---
// Checks whether `ssh -T git@github.com` authenticates, so the control
// panel's status page can flag mcp-repo instances that have missing or
// broken SSH keys before the operator tries to analyze a ticket whose
// repos are SSH-only. Cached for 60s to avoid spawning ssh on every
// health poll. See issue #367.
const SSH_PROBE_TTL_MS = 60_000;
let sshProbeCache: { value: boolean; at: number } | null = null;
let sshProbeInflight: Promise<boolean> | null = null;

function probeSshGithub(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      'ssh',
      [
        '-T',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        'git@github.com',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 8_000);

    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    // ssh -T against github exits non-zero even on success, so rely on output.
    child.on('close', () => {
      clearTimeout(timer);
      resolve(/successfully authenticated/i.test(out));
    });
  });
}

// Returns the cached SSH reachability value immediately (never waits for a live
// probe on the hot path). If the cache is cold or stale, kicks off a background
// refresh and returns `null` (unknown) until the first result arrives.  This
// keeps /health non-blocking so it always responds well within the docker-compose
// healthcheck timeout even when the 60-second cache has just expired.
function getSshGithubReachable(): boolean | null {
  const now = Date.now();
  if (sshProbeCache && now - sshProbeCache.at < SSH_PROBE_TTL_MS) {
    return sshProbeCache.value;
  }
  // Cache is cold or stale — kick off a refresh in the background if one is
  // not already running, then return null (unknown) for this request.
  if (!sshProbeInflight) {
    sshProbeInflight = probeSshGithub()
      .then((value) => {
        sshProbeCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        sshProbeInflight = null;
      });
  }
  return null;
}

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const repoManager = new RepoManager(db, config);
  repoManager.start();

  const serverDeps = { db, repoManager };

  const app = express();
  app.use(express.json());

  // --- Health check (no auth) ---
  // getSshGithubReachable() is synchronous and non-blocking: it returns the
  // cached value (true/false) or null when no result is available yet (probe
  // still running or cache cold).  Never awaits a live SSH probe here so the
  // healthcheck always responds quickly regardless of TTL expiry.
  app.get('/health', (_req, res) => {
    const sshGithubReachable = getSshGithubReachable();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      sshGithubReachable,
    });
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
    logger.info({ port: config.PORT }, 'MCP Repo Server listening');
    logger.info(`  MCP endpoint:   POST http://0.0.0.0:${config.PORT}/mcp`);
    logger.info(`  Health check:   GET  http://0.0.0.0:${config.PORT}/health`);
  });

  createGracefulShutdown(logger, [
    { fn: () => new Promise<void>((resolve) => httpServer.close(() => resolve())) },
    { fn: () => { repoManager.stop(); return Promise.resolve(); } },
    { fn: () => disconnectDb() },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start MCP Repo Server');
  process.exit(1);
});
