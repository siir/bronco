import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { createLogger, createQueue, AppLogger, createPrismaLogWriter, setGlobalLogWriter } from '@bronco/shared-utils';
import type { Queue } from 'bullmq';
import type { TicketCreatedJob, IngestionJob, AnalysisJob } from '@bronco/shared-types';
import { createAIRouter, NoProviderImplementationError, InvalidModelError } from '@bronco/ai-provider';
import type { Config } from './config.js';
import { prismaPlugin } from './plugins/prisma.js';
import { authPlugin } from './plugins/auth.js';
import { registerRoutes } from './routes/index.js';

const logger = createLogger('copilot-api');
export const appLog = new AppLogger('copilot-api');

export async function buildApp(config: Config) {
  const app = Fastify({ logger: false, trustProxy: 1 });

  const issueResolveQueue = createQueue('issue-resolve', config.REDIS_URL);
  const logSummarizeQueue = createQueue('log-summarize', config.REDIS_URL);
  const systemAnalysisQueue = createQueue('system-analysis', config.REDIS_URL);
  const mcpDiscoveryQueue = createQueue('mcp-discovery', config.REDIS_URL);
  const modelCatalogQueue = createQueue('model-catalog-refresh', config.REDIS_URL);
  const probeQueue = createQueue('probe-execution', config.REDIS_URL);
  const ticketCreatedQueue = createQueue<TicketCreatedJob>('ticket-created', config.REDIS_URL);
  const ingestQueue = createQueue<IngestionJob>('ticket-ingest', config.REDIS_URL);
  const clientLearningQueue = createQueue('client-learning', config.REDIS_URL);

  // Additional Queue clients for queues owned by other services, used for cross-service
  // failed-job management (including retry/delete and other mutations)
  const emailIngestionQueue = createQueue('email-ingestion', config.REDIS_URL);
  const ticketAnalysisQueue = createQueue<AnalysisJob>('ticket-analysis', config.REDIS_URL);
  const devopsSyncQueue = createQueue('devops-sync', config.REDIS_URL);

  const promptRetentionQueue = createQueue('prompt-retention', config.REDIS_URL);

  const queueMap = new Map<string, Queue>([
    ['issue-resolve', issueResolveQueue],
    ['log-summarize', logSummarizeQueue],
    ['email-ingestion', emailIngestionQueue],
    ['ticket-analysis', ticketAnalysisQueue],
    ['ticket-created', ticketCreatedQueue],
    ['ticket-ingest', ingestQueue],
    ['devops-sync', devopsSyncQueue],
    ['mcp-discovery', mcpDiscoveryQueue],
    ['model-catalog-refresh', modelCatalogQueue],
    ['system-analysis', systemAnalysisQueue],
    ['client-learning', clientLearningQueue],
    ['probe-execution', probeQueue],
    ['prompt-retention', promptRetentionQueue],
  ]);

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { global: false });
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB
  await app.register(prismaPlugin);

  // AI router — created after Prisma plugin so app.db is available immediately
  const { ai, clientMemoryResolver, modelConfigResolver, providerConfigResolver } = createAIRouter(app.db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  await app.register(authPlugin, { apiKey: config.API_KEY, jwtSecret: config.JWT_SECRET, portalJwtSecret: config.PORTAL_JWT_SECRET });

  await registerRoutes(app, { config, issueResolveQueue, logSummarizeQueue, systemAnalysisQueue, clientLearningQueue, mcpDiscoveryQueue, probeQueue, ticketCreatedQueue, ticketAnalysisQueue, ingestQueue, queueMap, ai, clientMemoryResolver, modelConfigResolver, providerConfigResolver, onSlackIntegrationChange: () => { logger.info('Slack integration changed — slack-worker will pick up changes on next periodic refresh (every 5 minutes)'); } });

  // Wire up database log writer after Prisma is ready
  const logWriter = createPrismaLogWriter(app.db);
  appLog.setWriter(logWriter);
  setGlobalLogWriter(logWriter);
  appLog.info('Copilot API starting', { port: config.PORT });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Return clean 422 for non-routable AI provider errors instead of 500
    if (error instanceof NoProviderImplementationError) {
      logger.warn({ err: error, url: request.url, provider: error.provider, model: error.model }, 'Non-routable AI provider');
      reply.code(422).send({
        error: error.message,
        provider: error.provider,
        model: error.model,
      });
      return;
    }

    // Return 400 for invalid model override errors with structured provider/model context
    if (error instanceof InvalidModelError) {
      reply.code(400).send({
        error: error.message,
        provider: error.provider,
        model: error.model,
      });
      return;
    }

    appLog.error(`Request error: ${request.method} ${request.url} — ${error.message}`, {
      err: error,
      url: request.url,
      method: request.method,
      statusCode: error.statusCode ?? 500,
    });
    reply.code(error.statusCode ?? 500).send({
      error: error.message,
    });
  });

  app.addHook('onClose', async () => {
    await issueResolveQueue.close();
    await logSummarizeQueue.close();
    await systemAnalysisQueue.close();
    await mcpDiscoveryQueue.close();
    await modelCatalogQueue.close();
    await probeQueue.close();
    await ticketCreatedQueue.close();
    await ingestQueue.close();
    await emailIngestionQueue.close();
    await ticketAnalysisQueue.close();
    await devopsSyncQueue.close();
    await promptRetentionQueue.close();
    await clientLearningQueue.close();
  });

  return app;
}
