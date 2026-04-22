import { getDb, disconnectDb } from '@bronco/db';
import { Prisma } from '@bronco/db';
import { createAIRouter } from '@bronco/ai-provider';
import { IntegrationType, SystemAnalysisTriggerType } from '@bronco/shared-types';
import { createLogger, createQueue, createWorker, AppLogger, createPrismaLogWriter, setGlobalLogWriter, createHealthServer, createGracefulShutdown, decrypt } from '@bronco/shared-utils';
import { z } from 'zod';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { getConfig } from './config.js';
import { summarizeTicketLogs, runSummarizationPass } from './log-summarizer.js';
import { runSystemAnalysis } from './system-analyzer.js';
import { discoverMcpServer } from './mcp-discovery.js';
import { refreshModelCatalog } from './model-catalog-refresher.js';
import { aggregateDailyUsage, generateInvoicePdf, nextInvoiceNumber, ensureInvoiceDir, computeNextPeriodEnd } from './invoice-generator.js';
import { startOperationalAlertChecker, stopOperationalAlertChecker } from './operational-alerts.js';

const logger = createLogger('scheduler-worker');
const appLog = new AppLogger('scheduler-worker');

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  // Initialize database loggers
  const logWriter = createPrismaLogWriter(db);
  appLog.setWriter(logWriter);
  setGlobalLogWriter(logWriter);
  appLog.info('Scheduler worker starting');

  // AI router (needed for log summarization, prompt retention)
  const { ai } = createAIRouter(db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  // --- BullMQ Queues ---
  const logSummarizeQueue = createQueue('log-summarize', config.REDIS_URL);
  const systemAnalysisQueue = createQueue('system-analysis', config.REDIS_URL);
  const mcpDiscoveryQueue = createQueue('mcp-discovery', config.REDIS_URL);
  const modelCatalogQueue = createQueue('model-catalog-refresh', config.REDIS_URL);
  const promptRetentionQueue = createQueue('prompt-retention', config.REDIS_URL);

  // --- BullMQ Workers ---

  // Log summarization worker
  const logSummarizeWorker = createWorker<{ ticketId?: string }>(
    'log-summarize',
    config.REDIS_URL,
    async (job) => {
      if (job.data.ticketId) {
        await summarizeTicketLogs(db, ai, job.data.ticketId);
      } else {
        await runSummarizationPass(db, ai);
      }
    },
  );

  logSummarizeWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Log summarization job failed');
  });

  // Schedule full log summarization every 30 minutes
  await logSummarizeQueue.upsertJobScheduler(
    'log-summarize-cron',
    { every: 30 * 60 * 1000 },
    { data: {} },
  );

  // System analysis worker (ticket-close + post-analysis triggers)
  const systemAnalysisWorker = createWorker<{ ticketId?: string; triggerType?: SystemAnalysisTriggerType }>(
    'system-analysis',
    config.REDIS_URL,
    async (job) => {
      await runSystemAnalysis(db, ai, job.data);
    },
  );

  systemAnalysisWorker.on('failed', (job, err) => {
    // Post-pipeline analysis is best-effort; exhausted retries are non-blocking.
    if (job?.name === 'analyze-post-pipeline') {
      logger.warn({ err, jobId: job?.id }, 'Post-pipeline analysis job failed (non-blocking)');
    } else {
      logger.error({ err, jobId: job?.id }, 'System analysis job failed');
    }
  });

  // MCP server discovery/verification worker
  const mcpDiscoveryWorker = createWorker<{ integrationId: string }>(
    'mcp-discovery',
    config.REDIS_URL,
    async (job) => {
      // Scheduled daily job: enqueue individual discovery for each active MCP integration
      if (job.data.integrationId === '__all__') {
        const integrations = await db.clientIntegration.findMany({
          where: { type: IntegrationType.MCP_DATABASE, isActive: true },
          select: { id: true },
        });
        for (const integ of integrations) {
          await mcpDiscoveryQueue.add('discover', { integrationId: integ.id });
        }
        logger.info({ count: integrations.length }, 'MCP discovery cron: enqueued verification for all integrations');
        return;
      }

      const integration = await db.clientIntegration.findUnique({
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
        await db.clientIntegration.update({
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
        // Decrypt apiKey if it was encrypted at rest
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
        await db.clientIntegration.update({
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
        await db.clientIntegration.update({
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

  // Schedule MCP re-verification daily
  await mcpDiscoveryQueue.upsertJobScheduler(
    'mcp-discovery-daily',
    { every: 24 * 60 * 60 * 1000 },
    { data: { integrationId: '__all__' } },
  );

  // Model catalog refresh worker (daily)
  const modelCatalogWorker = createWorker<Record<string, never>>(
    'model-catalog-refresh',
    config.REDIS_URL,
    async () => {
      await refreshModelCatalog(db, appLog);
    },
  );

  modelCatalogWorker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, 'Model catalog refresh job completed');
  });

  modelCatalogWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Model catalog refresh job failed');
  });

  // Schedule model catalog refresh daily
  await modelCatalogQueue.upsertJobScheduler(
    'model-catalog-daily',
    { every: 24 * 60 * 60 * 1000 },
    { data: {} },
  );

  // --- Prompt archive retention worker (nightly at 3am) ---
  const PROMPT_RETENTION_SETTINGS_KEY = 'system-config-prompt-retention';
  const DEFAULT_FULL_RETENTION_DAYS = 30;
  const DEFAULT_SUMMARY_RETENTION_DAYS = 90;
  const RETENTION_BATCH_SIZE = 10;

  const promptRetentionConfigSchema = z.object({
    fullRetentionDays: z.number().int().min(1).default(DEFAULT_FULL_RETENTION_DAYS),
    summaryRetentionDays: z.number().int().min(1).default(DEFAULT_SUMMARY_RETENTION_DAYS),
  });

  const promptRetentionWorker = createWorker<Record<string, never>>(
    'prompt-retention',
    config.REDIS_URL,
    async () => {
      // Load retention settings
      const settingRow = await db.appSetting.findUnique({
        where: { key: PROMPT_RETENTION_SETTINGS_KEY },
      });
      const retentionParseResult = promptRetentionConfigSchema.safeParse(settingRow?.value ?? {});
      const retentionCfg = retentionParseResult.success
        ? retentionParseResult.data
        : { fullRetentionDays: DEFAULT_FULL_RETENTION_DAYS, summaryRetentionDays: DEFAULT_SUMMARY_RETENTION_DAYS };
      const fullRetentionDays = retentionCfg.fullRetentionDays;
      const summaryRetentionDays = retentionCfg.summaryRetentionDays;

      const now = new Date();

      // --- Summarize pass ---
      const summarizeCutoff = new Date(now.getTime() - fullRetentionDays * 24 * 60 * 60 * 1000);
      let summarized = 0;

      // Process in batches
      while (true) {
        const archives = await db.aiPromptArchive.findMany({
          where: {
            createdAt: { lt: summarizeCutoff },
            summarizedAt: null,
            fullPrompt: { not: '' },
          },
          take: RETENTION_BATCH_SIZE,
          orderBy: { createdAt: 'asc' },
        });

        if (archives.length === 0) break;

        for (const archive of archives) {
          try {
            const summaryContent = [
              archive.systemPrompt ? `System prompt: ${archive.systemPrompt.slice(0, 500)}` : '',
              `User prompt: ${archive.fullPrompt.slice(0, 2000)}`,
              `Response: ${archive.fullResponse.slice(0, 2000)}`,
            ].filter(Boolean).join('\n\n');

            const summaryResponse = await ai.generate({
              taskType: 'CUSTOM_AI_QUERY',
              prompt: `Summarize this AI conversation into key points: what was asked, what context was provided, what tools were called, what was concluded.\n\n${summaryContent}`,
            });

            await db.aiPromptArchive.update({
              where: { id: archive.id },
              data: {
                summary: summaryResponse.content,
                summarizedAt: new Date(),
                fullPrompt: '',
                fullResponse: '',
                systemPrompt: null,
              },
            });
            summarized++;
          } catch (err) {
            logger.warn({ err, archiveId: archive.id }, 'Failed to summarize prompt archive');
          }
        }
      }

      // --- Delete pass ---
      const deleteCutoff = new Date(now.getTime() - summaryRetentionDays * 24 * 60 * 60 * 1000);
      const deleted = await db.aiPromptArchive.deleteMany({
        where: {
          summarizedAt: { not: null, lt: deleteCutoff },
        },
      });

      logger.info(
        { summarized, deleted: deleted.count, fullRetentionDays, summaryRetentionDays },
        'Prompt archive retention job completed',
      );
    },
  );

  promptRetentionWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Prompt retention job failed');
  });

  // Schedule nightly at 3am
  await promptRetentionQueue.upsertJobScheduler(
    'prompt-retention-nightly',
    { pattern: '0 3 * * *' },
    { data: {} },
  );

  // --- Auto-invoicing: check daily for clients with billing periods that have ended ---
  const invoiceStoragePath = config.INVOICE_STORAGE_PATH;
  ensureInvoiceDir(invoiceStoragePath);

  async function runAutoInvoiceCheck(): Promise<void> {
    try {
      const clients = await db.client.findMany({
        where: { billingPeriod: { not: 'disabled' }, isActive: true },
        select: { id: true, name: true, billingPeriod: true, billingAnchorDay: true, billingMarkupPercent: true },
      });

      for (const client of clients) {
        try {
          const markupMultiplier = Number(client.billingMarkupPercent);
          const MAX_INVOICES_PER_RUN = 12;
          let invoicesGenerated = 0;

          const seedInvoice = await db.invoice.findFirst({
            where: { clientId: client.id },
            orderBy: { periodEnd: 'desc' },
            select: { periodEnd: true },
          });
          let cursorPeriodEnd: Date | null = seedInvoice?.periodEnd ?? null;

          while (invoicesGenerated < MAX_INVOICES_PER_RUN) {
            const periodEnd = computeNextPeriodEnd(client.billingPeriod, client.billingAnchorDay, cursorPeriodEnd);
            if (!periodEnd || periodEnd > new Date()) break;

            const periodStart = cursorPeriodEnd ?? new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);

            if (periodEnd <= periodStart) {
              logger.warn({ clientId: client.id, periodStart, periodEnd }, 'Auto-invoice: periodEnd <= periodStart, skipping');
              break;
            }

            const usageData = await aggregateDailyUsage(db, client.id, periodStart, periodEnd, markupMultiplier);
            if (usageData.requestCount === 0) {
              cursorPeriodEnd = periodEnd;
              continue;
            }

            let invoiceCreated = false;
            for (let attempt = 0; attempt <= 3; attempt++) {
              const last = await db.invoice.findFirst({
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
                await db.invoice.create({
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
    db,
    redisUrl: config.REDIS_URL,
    encryptionKey: config.ENCRYPTION_KEY,
  });

  // Health server
  const health = createHealthServer('scheduler-worker', config.HEALTH_PORT, {
    getDetails: () => ({
      workers: ['log-summarize', 'system-analysis', 'mcp-discovery', 'model-catalog-refresh', 'prompt-retention'],
      intervals: ['auto-invoice', 'operational-alerts'],
    }),
  });

  logger.info({ healthPort: config.HEALTH_PORT }, 'Scheduler worker started');

  createGracefulShutdown(logger, [
    {
      fn: () => {
        clearInterval(autoInvoiceInterval);
        stopOperationalAlertChecker();
      },
    },
    health,
    promptRetentionWorker,
    promptRetentionQueue,
    logSummarizeWorker,
    logSummarizeQueue,
    systemAnalysisWorker,
    systemAnalysisQueue,
    mcpDiscoveryWorker,
    mcpDiscoveryQueue,
    modelCatalogWorker,
    modelCatalogQueue,
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start scheduler worker');
  process.exit(1);
});
