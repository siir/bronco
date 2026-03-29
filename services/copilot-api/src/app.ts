import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { createLogger, createQueue, createWorker, AppLogger, createPrismaLogWriter, setGlobalLogWriter, decrypt } from '@bronco/shared-utils';
import { IntegrationType } from '@bronco/shared-types';
import type { Queue } from 'bullmq';
import type { TicketCreatedJob, IngestionJob } from '@bronco/shared-types';
import { createAIRouter, NoProviderImplementationError, InvalidModelError } from '@bronco/ai-provider';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { Prisma } from '@bronco/db';
import { aggregateDailyUsage, generateInvoicePdf, nextInvoiceNumber, ensureInvoiceDir, computeNextPeriodEnd } from './services/invoice-generator.js';
import type { Config } from './config.js';
import { prismaPlugin } from './plugins/prisma.js';
import { authPlugin } from './plugins/auth.js';
import { registerRoutes } from './routes/index.js';
import { summarizeTicketLogs, runSummarizationPass } from './services/log-summarizer.js';
import { analyzeTicketClosure } from './services/system-analyzer.js';
import { discoverMcpServer } from './services/mcp-discovery.js';
import { refreshModelCatalog } from './services/model-catalog-refresher.js';
import { startOperationalAlertChecker, stopOperationalAlertChecker } from './services/operational-alerts.js';

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

  // Additional Queue clients for queues owned by other services, used for cross-service
  // failed-job management (including retry/delete and other mutations)
  const emailIngestionQueue = createQueue('email-ingestion', config.REDIS_URL);
  const ticketAnalysisQueue = createQueue('ticket-analysis', config.REDIS_URL);
  const devopsSyncQueue = createQueue('devops-sync', config.REDIS_URL);

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
    ['probe-execution', probeQueue],
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
  await registerRoutes(app, { config, issueResolveQueue, logSummarizeQueue, systemAnalysisQueue, mcpDiscoveryQueue, probeQueue, ticketCreatedQueue, ingestQueue, queueMap, ai, clientMemoryResolver, modelConfigResolver, providerConfigResolver });

  // Wire up database log writer after Prisma is ready
  const logWriter = createPrismaLogWriter(app.db);
  appLog.setWriter(logWriter);
  setGlobalLogWriter(logWriter);
  appLog.info('Copilot API starting', { port: config.PORT });

  // BullMQ worker for log summarization jobs
  const logSummarizeWorker = createWorker<{ ticketId?: string }>(
    'log-summarize',
    config.REDIS_URL,
    async (job) => {
      if (job.data.ticketId) {
        await summarizeTicketLogs(app.db, ai, job.data.ticketId);
      } else {
        await runSummarizationPass(app.db, ai);
      }
    },
  );

  logSummarizeWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Log summarization job failed');
  });

  // Schedule full log summarization every 30 minutes (all log summary types: ticket, orphan, service, uncategorized)
  await logSummarizeQueue.upsertJobScheduler(
    'log-summarize-cron',
    { every: 30 * 60 * 1000 },
    { data: {} },
  );

  // BullMQ worker for ticket closure analysis jobs
  const systemAnalysisWorker = createWorker<{ ticketId: string }>(
    'system-analysis',
    config.REDIS_URL,
    async (job) => {
      await analyzeTicketClosure(app.db, ai, job.data.ticketId);
    },
  );

  systemAnalysisWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'System analysis job failed');
  });

  // BullMQ worker for MCP server discovery/verification jobs
  const mcpDiscoveryWorker = createWorker<{ integrationId: string }>(
    'mcp-discovery',
    config.REDIS_URL,
    async (job) => {
      // Scheduled daily job: enqueue individual discovery for each active MCP integration
      if (job.data.integrationId === '__all__') {
        const integrations = await app.db.clientIntegration.findMany({
          where: { type: IntegrationType.MCP_DATABASE, isActive: true },
          select: { id: true },
        });
        for (const integ of integrations) {
          await mcpDiscoveryQueue.add('discover', { integrationId: integ.id });
        }
        logger.info({ count: integrations.length }, 'MCP discovery cron: enqueued verification for all integrations');
        return;
      }

      const integration = await app.db.clientIntegration.findUnique({
        where: { id: job.data.integrationId },
        select: { id: true, config: true, metadata: true },
      });
      if (!integration) {
        logger.warn({ integrationId: job.data.integrationId }, 'MCP discovery: integration not found');
        return;
      }

      const cfg = typeof integration.config === 'object' && integration.config !== null && !Array.isArray(integration.config)
        ? integration.config as Record<string, unknown>
        : {};
      const url = typeof cfg['url'] === 'string' ? cfg['url'] : '';

      if (!url) {
        await app.db.clientIntegration.update({
          where: { id: integration.id },
          data: {
            metadata: {
              lastVerifiedAt: new Date().toISOString(),
              verificationStatus: 'failed',
              verificationError: 'No URL configured',
            },
          },
        });
        return;
      }

      try {
        // Decrypt apiKey if it was encrypted at rest (try/catch to handle plaintext keys with colons)
        let apiKey: string | undefined;
        const rawKey = typeof cfg['apiKey'] === 'string' ? cfg['apiKey'] : undefined;
        if (rawKey) {
          apiKey = rawKey;
          const segments = rawKey.split(':');
          if (segments.length === 3 && segments.every((s) => s.length > 0)) {
            try {
              apiKey = decrypt(rawKey, config.ENCRYPTION_KEY);
            } catch {
              logger.warn({ integrationId: integration.id }, 'MCP discovery: failed to decrypt apiKey, using raw value');
            }
          }
        }

        const result = await discoverMcpServer({
          url,
          mcpPath: typeof cfg['mcpPath'] === 'string' ? cfg['mcpPath'] : undefined,
          apiKey,
          authHeader: cfg['authHeader'] === 'x-api-key' ? 'x-api-key' : 'bearer',
        });
        await app.db.clientIntegration.update({
          where: { id: integration.id },
          data: { metadata: result as never },
        });
        logger.info({ integrationId: integration.id, tools: result.tools.length }, 'MCP discovery succeeded');
      } catch (err) {
        const errorMsg =
          err instanceof Error && err.message ? err.message : String(err);
        const prevMetadata = typeof integration.metadata === 'object' && integration.metadata !== null && !Array.isArray(integration.metadata)
          ? integration.metadata as Record<string, unknown>
          : {};
        await app.db.clientIntegration.update({
          where: { id: integration.id },
          data: {
            metadata: {
              ...prevMetadata,
              lastVerifiedAt: new Date().toISOString(),
              verificationStatus: 'failed',
              verificationError: errorMsg,
            },
          },
        });
        logger.warn({ err, integrationId: integration.id }, 'MCP discovery failed');
      }
    },
  );

  mcpDiscoveryWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'MCP discovery job failed');
  });

  // Schedule MCP re-verification daily via BullMQ (avoids duplicate jobs in multi-replica)
  await mcpDiscoveryQueue.upsertJobScheduler(
    'mcp-discovery-daily',
    { every: 24 * 60 * 60 * 1000 },
    { data: { integrationId: '__all__' } },
  );

  // BullMQ worker for daily model catalog refresh (OpenRouter + Ollama)
  const modelCatalogWorker = createWorker<Record<string, never>>(
    'model-catalog-refresh',
    config.REDIS_URL,
    async () => {
      await refreshModelCatalog(app.db, appLog);
    },
  );

  modelCatalogWorker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, 'Model catalog refresh job completed');
  });

  modelCatalogWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Model catalog refresh job failed');
  });

  // Schedule model catalog refresh daily (every 24 hours)
  await modelCatalogQueue.upsertJobScheduler(
    'model-catalog-daily',
    { every: 24 * 60 * 60 * 1000 },
    { data: {} },
  );

  // Auto-invoicing: check daily for clients with billing periods that have ended
  const invoiceStoragePath = config.INVOICE_STORAGE_PATH;
  ensureInvoiceDir(invoiceStoragePath);

  async function runAutoInvoiceCheck(): Promise<void> {
    try {
      const clients = await app.db.client.findMany({
        where: { billingPeriod: { not: 'disabled' }, isActive: true },
        select: { id: true, name: true, billingPeriod: true, billingAnchorDay: true, billingMarkupPercent: true },
      });

      for (const client of clients) {
        try {
          const markupMultiplier = Number(client.billingMarkupPercent);
          // Generate all overdue invoices for this client (multi-period catch-up).
          // Cap at 12 invoices per run to prevent runaway in misconfigured cases.
          const MAX_INVOICES_PER_RUN = 12;
          let invoicesGenerated = 0;

          // cursorPeriodEnd tracks the billing position independently of whether invoices were
          // created — this allows empty periods to advance the cursor without stalling the loop.
          const seedInvoice = await app.db.invoice.findFirst({
            where: { clientId: client.id },
            orderBy: { periodEnd: 'desc' },
            select: { periodEnd: true },
          });
          let cursorPeriodEnd: Date | null = seedInvoice?.periodEnd ?? null;

          while (invoicesGenerated < MAX_INVOICES_PER_RUN) {
            const periodEnd = computeNextPeriodEnd(client.billingPeriod, client.billingAnchorDay, cursorPeriodEnd);
            if (!periodEnd || periodEnd > new Date()) break;

            // Align periodStart with periodEnd's month on first invoice so the window is valid.
            // Fall back to start-of-periodEnd's month when there is no prior billing cursor.
            const periodStart = cursorPeriodEnd ?? new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);

            if (periodEnd <= periodStart) {
              logger.warn({ clientId: client.id, periodStart, periodEnd }, 'Auto-invoice: periodEnd <= periodStart, skipping further auto-invoicing for this client in this run; please correct billing configuration');
              break;
            }

            const usageData = await aggregateDailyUsage(app.db, client.id, periodStart, periodEnd, markupMultiplier);
            if (usageData.requestCount === 0) {
              // No usage this period — advance the cursor so the next run does not re-evaluate
              // this same period and permanently stall on it.
              cursorPeriodEnd = periodEnd;
              continue;
            }

            let invoiceCreated = false;
            for (let attempt = 0; attempt <= 3; attempt++) {
              const last = await app.db.invoice.findFirst({
                where: { clientId: client.id },
                orderBy: { invoiceNumber: 'desc' },
                select: { invoiceNumber: true },
              });
              const invoiceNumber = nextInvoiceNumber(last?.invoiceNumber ?? null);
              const fileName = `invoice-${client.id}-${invoiceNumber}.pdf`;
              const pdfPath = join(invoiceStoragePath, fileName);

              await generateInvoicePdf({
                clientName: client.name,
                invoiceNumber,
                markupMultiplier,
                ...usageData,
              }, pdfPath);

              try {
                await app.db.invoice.create({
                  data: {
                    clientId: client.id,
                    invoiceNumber,
                    periodStart,
                    periodEnd,
                    totalBaseCostUsd: usageData.totalBaseCostUsd,
                    totalBilledCostUsd: usageData.totalBilledCostUsd,
                    totalInputTokens: usageData.totalInputTokens,
                    totalOutputTokens: usageData.totalOutputTokens,
                    requestCount: usageData.requestCount,
                    markupPercent: markupMultiplier,
                    pdfPath,
                    status: 'final',
                  },
                });
                invoiceCreated = true;
                break;
              } catch (err) {
                await unlink(pdfPath).catch(() => { /* non-fatal */ });
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 3) {
                  continue;
                }
                throw err;
              }
            }

            if (invoiceCreated) {
              invoicesGenerated++;
              cursorPeriodEnd = periodEnd;
              logger.info({ clientId: client.id, invoicesGenerated }, 'Auto-generated invoice');
            } else {
              break;
            }
          }
        } catch (err) {
          // Isolate per-client errors so a single failure does not abort the entire billing run
          logger.error({ err, clientId: client.id }, 'Auto-invoice generation failed for client');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Auto-invoice check failed');
    }
  }

  // Run once at startup, then every 24 hours
  void runAutoInvoiceCheck();
  const autoInvoiceInterval = setInterval(() => void runAutoInvoiceCheck(), 24 * 60 * 60 * 1000);

  // Start operational alert checker (every 5 minutes)
  startOperationalAlertChecker({
    db: app.db,
    redisUrl: config.REDIS_URL,
    encryptionKey: config.ENCRYPTION_KEY,
  });

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
    clearInterval(autoInvoiceInterval);
    stopOperationalAlertChecker();
    await logSummarizeWorker.close();
    await logSummarizeQueue.close();
    await systemAnalysisWorker.close();
    await systemAnalysisQueue.close();
    await mcpDiscoveryWorker.close();
    await mcpDiscoveryQueue.close();
    await issueResolveQueue.close();
    await modelCatalogWorker.close();
    await modelCatalogQueue.close();
    await probeQueue.close();
    await ticketCreatedQueue.close();
    await ingestQueue.close();
    await emailIngestionQueue.close();
    await ticketAnalysisQueue.close();
    await devopsSyncQueue.close();
  });

  return app;
}
