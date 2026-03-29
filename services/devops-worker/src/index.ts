import { Redis } from 'ioredis';
import { getDb, disconnectDb } from '@bronco/db';
import { createLogger, createQueue, createWorker, decrypt, AppLogger, createPrismaLogWriter, setGlobalLogWriter, createHealthServer, createGracefulShutdown } from '@bronco/shared-utils';
import { createAIRouter } from '@bronco/ai-provider';
import type { TicketCreatedJob } from '@bronco/shared-types';
import { AzDoClient } from './client.js';
import { getConfig } from './config.js';
import { pollWorkItems } from './poller.js';
import { createDevOpsProcessor, initProcessorLogger } from './processor.js';
import type { DevOpsJob } from './processor.js';
import { WorkflowEngine, initWorkflowLogger } from './workflow.js';
import { OperationalTaskWorkflowTarget } from './workflow-target.js';
import type { Job } from 'bullmq';

/** Redis key prefix for per-integration poll watermarks. */
const WATERMARK_PREFIX = 'devops-worker:watermark:';
/** Redis key for the global (non-integration) poll watermark. */
const GLOBAL_WATERMARK_KEY = `${WATERMARK_PREFIX}global`;

const logger = createLogger('devops-worker');
const appLog = new AppLogger('devops-worker');

/** Read a per-integration watermark from Redis, falling back to the DB. */
async function restoreWatermark(
  redis: Redis,
  db: ReturnType<typeof getDb>,
  key: string,
  integrationId: string | null,
): Promise<Date | undefined> {
  try {
    const raw = await redis.get(key);
    if (raw) {
      const parsed = new Date(raw);
      if (!isNaN(parsed.getTime())) {
        logger.info({ watermark: parsed.toISOString(), integrationId }, 'Restored poll watermark from Redis');
        return parsed;
      }
      logger.warn({ watermark: raw, integrationId }, 'Invalid poll watermark in Redis — falling back to DB');
    }

    // Fall back to the most recent sync timestamp for this integration in the DB.
    const latest = await db.devOpsSyncState.findFirst({
      where: { integrationId },
      orderBy: { lastSyncedAt: 'desc' },
      select: { lastSyncedAt: true },
    });
    if (latest) {
      logger.info({ watermark: latest.lastSyncedAt.toISOString(), integrationId }, 'Restored poll watermark from DB');
      return latest.lastSyncedAt;
    }
  } catch (err) {
    logger.warn({ err, integrationId }, 'Failed to restore poll watermark — starting with full sync');
  }
  return undefined;
}

/** Persist a watermark to Redis. */
async function saveWatermark(redis: Redis, key: string, time: Date): Promise<void> {
  await redis.set(key, time.toISOString()).catch((err) => {
    logger.warn({ err, key }, 'Failed to persist poll watermark to Redis');
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();

  // Initialize database loggers
  const logWriter = createPrismaLogWriter(db);
  appLog.setWriter(logWriter);
  setGlobalLogWriter(logWriter);
  initProcessorLogger(db);
  initWorkflowLogger(db);
  appLog.info('DevOps worker starting');

  const hasGlobalAzdo = !!(config.AZDO_ORG_URL && config.AZDO_PAT && config.AZDO_PROJECT && config.AZDO_ASSIGNED_USER);

  // AI router (DB-backed provider config)
  const { ai } = createAIRouter(db, {
    encryptionKey: config.ENCRYPTION_KEY,
  });

  // --- Ticket-created queue for route dispatch ---
  const ticketCreatedQueue = createQueue<TicketCreatedJob>('ticket-created', config.REDIS_URL);

  // Redis connection for watermark persistence
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await redis.connect();

  // Global Azure DevOps client + workflow (only when global config is set)
  let globalAzdo: AzDoClient | undefined;
  let globalWorkflow: WorkflowEngine | undefined;
  let globalProcessor: ((job: import('bullmq').Job<DevOpsJob>) => Promise<void>) | undefined;

  if (hasGlobalAzdo) {
    globalAzdo = new AzDoClient({
      orgUrl: config.AZDO_ORG_URL!,
      project: config.AZDO_PROJECT!,
      pat: config.AZDO_PAT!,
      apiVersion: config.AZDO_API_VERSION,
      apiVersionComments: config.AZDO_API_VERSION_COMMENTS,
    });
    const globalTarget = new OperationalTaskWorkflowTarget(db);
    globalWorkflow = new WorkflowEngine(db, ai, globalAzdo, {
      maxQuestionRounds: config.MAX_QUESTION_ROUNDS,
      integrationId: null,
      target: globalTarget,
    });
    globalProcessor = createDevOpsProcessor(
      db,
      globalAzdo,
      globalWorkflow,
      config.AZDO_ORG_URL!,
      config.AZDO_PROJECT!,
      config.AZDO_ASSIGNED_USER!,
      {
        maxDescriptionLength: config.MAX_DESCRIPTION_LENGTH,
        integrationId: null,
        mode: 'operational-task',
      },
    );
  }

  // Per-client integration processors, keyed by integration ID.
  const perClientProcessors = new Map<string, {
    processor: (job: Job<DevOpsJob>) => Promise<void>;
    client: AzDoClient;
    assignedUser: string;
    updatedAt: Date;
  }>();

  /** Per-integration poll watermarks. Global uses key "global". */
  const watermarks = new Map<string, Date | undefined>();

  // Restore the global watermark
  const globalWatermark = await restoreWatermark(redis, db, GLOBAL_WATERMARK_KEY, null);
  watermarks.set('global', globalWatermark);

  /**
   * Lazily initialize or return a cached per-client processor for a given integrationId.
   * Queries the DB if the cache is empty (covers the case where BullMQ dequeues a job
   * before the first pollPerClient cycle has run). Returns undefined if the integration
   * is no longer active or cannot be initialised.
   */
  const getOrCreateProcessor = async (integrationId: string): Promise<{
    processor: (job: Job<DevOpsJob>) => Promise<void>;
    client: AzDoClient;
    assignedUser: string;
    updatedAt: Date;
  } | undefined> => {
    const cached = perClientProcessors.get(integrationId);
    if (cached) return cached;

    // Cache miss — query the integration from the DB and build a processor on demand
    const integ = await db.clientIntegration.findUnique({
      where: { id: integrationId },
      include: { client: { select: { name: true, shortCode: true } } },
    });
    if (!integ || !integ.isActive || integ.type !== 'AZURE_DEVOPS') {
      logger.warn({ integrationId }, 'Integration not found or inactive — cannot create processor');
      return undefined;
    }

    const rawCfg = integ.config as {
      orgUrl?: string;
      project?: string;
      encryptedPat?: string;
      assignedUser?: string;
    };

    let pat = rawCfg.encryptedPat;
    if (pat) {
      const segments = pat.split(':');
      const isEncrypted = segments.length === 3 && segments.every((s) => s.length > 0);
      if (isEncrypted) {
        try {
          pat = decrypt(pat, config.ENCRYPTION_KEY);
        } catch (err) {
          logger.error({ err, integrationId }, 'Failed to decrypt Azure DevOps PAT on demand');
          return undefined;
        }
      }
    }

    if (!rawCfg.orgUrl || !rawCfg.project || !pat || !rawCfg.assignedUser) {
      logger.warn({ integrationId }, 'Incomplete Azure DevOps integration config on demand');
      return undefined;
    }

    const azdoClient = new AzDoClient({
      orgUrl: rawCfg.orgUrl,
      project: rawCfg.project,
      pat,
    });
    const wfEngine = new WorkflowEngine(db, ai, azdoClient, {
      maxQuestionRounds: config.MAX_QUESTION_ROUNDS,
      integrationId,
    });
    const processor = createDevOpsProcessor(
      db,
      azdoClient,
      wfEngine,
      rawCfg.orgUrl,
      rawCfg.project,
      rawCfg.assignedUser,
      {
        clientShortCode: integ.client.shortCode,
        maxDescriptionLength: config.MAX_DESCRIPTION_LENGTH,
        integrationId,
        ticketCreatedQueue,
      },
    );

    const entry = {
      processor,
      client: azdoClient,
      assignedUser: rawCfg.assignedUser,
      updatedAt: integ.updatedAt,
    };
    perClientProcessors.set(integrationId, entry);
    logger.info(
      { integrationId, client: integ.client.shortCode, project: rawCfg.project },
      'Lazily initialized per-client Azure DevOps processor',
    );
    return entry;
  };

  // BullMQ queue + worker
  const queue = createQueue('devops-sync', config.REDIS_URL);

  // Populate per-client processors BEFORE starting the BullMQ worker so the cache
  // is warm when any already-queued jobs from a previous run are dequeued (#154).
  await initPerClientProcessors();

  const worker = createWorker<DevOpsJob>('devops-sync', config.REDIS_URL, async (job) => {
    const { integrationId } = job.data;
    if (integrationId) {
      // Try cache first; lazily initialise on miss (#154).
      const entry = await getOrCreateProcessor(integrationId);
      if (entry) {
        await entry.processor(job);
      } else {
        logger.error({ integrationId }, 'No processor available for integration — cannot process job');
        throw new Error(`No processor available for integrationId=${integrationId}`);
      }
    } else if (globalProcessor) {
      await globalProcessor(job);
    }
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, workItemId: job.data.workItemId }, 'Work item sync completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, workItemId: job?.data.workItemId, err: err.message },
      'Work item sync failed',
    );
  });

  let lastPollAt: Date | undefined;
  let pollCount = 0;

  const health = createHealthServer('devops-worker', config.HEALTH_PORT, {
    getDetails: () => ({
      lastPollAt: lastPollAt?.toISOString() ?? null,
      pollCount,
      pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
      hasGlobalAzdo,
      azdoProject: config.AZDO_PROJECT ?? null,
    }),
  });

  const pollGlobal = async () => {
    if (!globalAzdo) return;

    const since = watermarks.get('global');
    const pollTime = new Date();

    try {
      const workItems = await pollWorkItems(globalAzdo, since);

      for (const wi of workItems) {
        // Include revision in job ID so updated work items are re-processed
        await queue.add(
          'sync-work-item',
          { workItemId: wi.id },
          {
            jobId: `wi-${wi.id}-rev${wi.rev}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          },
        );
      }

      if (workItems.length > 0) {
        logger.info({ count: workItems.length }, 'Enqueued work items for processing');
      }

      // Only advance watermark on success (#208)
      watermarks.set('global', pollTime);
      await saveWatermark(redis, GLOBAL_WATERMARK_KEY, pollTime);
    } catch (err) {
      logger.error({ err }, 'Global poll cycle failed — watermark not advanced');
    }
  };

  /**
   * Initialise per-client processors from the DB without polling for work items.
   * Called once at startup to warm the cache before the BullMQ worker starts (#154).
   */
  async function initPerClientProcessors(): Promise<void> {
    try {
      const integrations = await db.clientIntegration.findMany({
        where: { type: 'AZURE_DEVOPS', isActive: true },
        include: { client: { select: { name: true, shortCode: true } } },
      });

      for (const integ of integrations) {
        const rawCfg = integ.config as {
          orgUrl?: string;
          project?: string;
          encryptedPat?: string;
          assignedUser?: string;
        };

        let pat = rawCfg.encryptedPat;
        if (pat) {
          const segments = pat.split(':');
          const isEncrypted = segments.length === 3 && segments.every((s) => s.length > 0);
          if (isEncrypted) {
            try {
              pat = decrypt(pat, config.ENCRYPTION_KEY);
            } catch (err) {
              logger.error({ err, integrationId: integ.id }, 'Failed to decrypt Azure DevOps PAT during init; skipping');
              continue;
            }
          }
        }

        if (!rawCfg.orgUrl || !rawCfg.project || !pat || !rawCfg.assignedUser) {
          logger.warn({ integrationId: integ.id }, 'Incomplete Azure DevOps integration config during init; skipping');
          continue;
        }

        const azdoClient = new AzDoClient({
          orgUrl: rawCfg.orgUrl,
          project: rawCfg.project,
          pat,
        });
        const wfEngine = new WorkflowEngine(db, ai, azdoClient, {
          maxQuestionRounds: config.MAX_QUESTION_ROUNDS,
          integrationId: integ.id,
        });
        const processor = createDevOpsProcessor(
          db,
          azdoClient,
          wfEngine,
          rawCfg.orgUrl,
          rawCfg.project,
          rawCfg.assignedUser,
          {
            clientShortCode: integ.client.shortCode,
            maxDescriptionLength: config.MAX_DESCRIPTION_LENGTH,
            integrationId: integ.id,
            ticketCreatedQueue,
          },
        );
        perClientProcessors.set(integ.id, {
          processor,
          client: azdoClient,
          assignedUser: rawCfg.assignedUser,
          updatedAt: integ.updatedAt,
        });

        // Restore per-integration watermark
        const wm = await restoreWatermark(redis, db, `${WATERMARK_PREFIX}${integ.id}`, integ.id);
        watermarks.set(integ.id, wm);

        logger.info(
          { integrationId: integ.id, client: integ.client.shortCode, project: rawCfg.project },
          'Initialized per-client Azure DevOps processor',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to pre-populate per-client processors');
    }
  }

  // Poll per-client AZURE_DEVOPS integrations from ClientIntegration table.
  const pollPerClient = async () => {
    try {
      const integrations = await db.clientIntegration.findMany({
        where: { type: 'AZURE_DEVOPS', isActive: true },
        include: { client: { select: { name: true, shortCode: true } } },
      });

      for (const integ of integrations) {
        const rawCfg = integ.config as {
          orgUrl?: string;
          project?: string;
          encryptedPat?: string;
          assignedUser?: string;
        };

        // Decrypt the PAT
        let pat = rawCfg.encryptedPat;
        if (pat) {
          const segments = pat.split(':');
          const isEncrypted = segments.length === 3 && segments.every((s) => s.length > 0);
          if (isEncrypted) {
            try {
              pat = decrypt(pat, config.ENCRYPTION_KEY);
            } catch (err) {
              logger.error({ err, integrationId: integ.id }, 'Failed to decrypt Azure DevOps PAT; skipping');
              // Delete stale processor so queued jobs don't use old credentials (#208)
              perClientProcessors.delete(integ.id);
              continue;
            }
          }
        }

        if (!rawCfg.orgUrl || !rawCfg.project || !pat || !rawCfg.assignedUser) {
          logger.warn({ integrationId: integ.id }, 'Incomplete Azure DevOps integration config; skipping');
          continue;
        }

        // Create or reuse cached processor; recreate if integration config has changed
        const cached = perClientProcessors.get(integ.id);
        if (!cached || cached.updatedAt.getTime() !== integ.updatedAt.getTime()) {
          if (cached) {
            logger.info(
              { integrationId: integ.id, client: integ.client.shortCode },
              'Integration config changed — recreating processor',
            );
          }
          const azdoClient = new AzDoClient({
            orgUrl: rawCfg.orgUrl,
            project: rawCfg.project,
            pat,
          });
          const wfEngine = new WorkflowEngine(db, ai, azdoClient, {
            maxQuestionRounds: config.MAX_QUESTION_ROUNDS,
            integrationId: integ.id,
          });
          const processor = createDevOpsProcessor(
            db,
            azdoClient,
            wfEngine,
            rawCfg.orgUrl,
            rawCfg.project,
            rawCfg.assignedUser,
            {
              clientShortCode: integ.client.shortCode,
              maxDescriptionLength: config.MAX_DESCRIPTION_LENGTH,
              integrationId: integ.id,
              ticketCreatedQueue,
            },
          );
          perClientProcessors.set(integ.id, {
            processor,
            client: azdoClient,
            assignedUser: rawCfg.assignedUser,
            updatedAt: integ.updatedAt,
          });
          logger.info(
            { integrationId: integ.id, client: integ.client.shortCode, project: rawCfg.project },
            'Initialized per-client Azure DevOps processor',
          );
        }

        const entry = perClientProcessors.get(integ.id)!;
        const since = watermarks.get(integ.id);
        const pollTime = new Date();

        try {
          const workItems = await pollWorkItems(entry.client, since);
          for (const wi of workItems) {
            await queue.add(
              'sync-work-item',
              { workItemId: wi.id, integrationId: integ.id },
              {
                jobId: `wi-${integ.id}-${wi.id}-rev${wi.rev}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
              },
            );
          }
          if (workItems.length > 0) {
            logger.info(
              { integrationId: integ.id, client: integ.client.shortCode, count: workItems.length },
              'Enqueued per-client work items for processing',
            );
          }

          // Only advance watermark on success (#208)
          watermarks.set(integ.id, pollTime);
          await saveWatermark(redis, `${WATERMARK_PREFIX}${integ.id}`, pollTime);
        } catch (err) {
          logger.error(
            { err, integrationId: integ.id, client: integ.client.shortCode },
            'Per-client Azure DevOps poll failed — watermark not advanced',
          );
        }
      }

      // Remove processors for integrations that are no longer active.
      // Use a Set for O(1) lookups instead of O(N) .some() per cached entry (#208).
      const activeIds = new Set(integrations.map((i) => i.id));
      for (const cachedId of perClientProcessors.keys()) {
        if (!activeIds.has(cachedId)) {
          perClientProcessors.delete(cachedId);
          logger.info({ integrationId: cachedId }, 'Removed processor for deactivated integration');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to poll per-client Azure DevOps integrations');
    }
  };

  // Combined poll cycle.
  const pollAll = async () => {
    lastPollAt = new Date();
    pollCount++;

    await pollGlobal();
    await pollPerClient();
  };

  // Initial poll
  await pollAll();

  // Schedule recurring polls
  const interval = setInterval(pollAll, config.POLL_INTERVAL_SECONDS * 1000);

  if (!hasGlobalAzdo) {
    logger.info('No global Azure DevOps config — will poll per-client integrations only');
  } else {
    logger.info(
      {
        intervalSeconds: config.POLL_INTERVAL_SECONDS,
        org: config.AZDO_ORG_URL,
        project: config.AZDO_PROJECT,
        assignedUser: config.AZDO_ASSIGNED_USER,
      },
      'Azure DevOps worker started',
    );
  }

  logger.info({ intervalSeconds: config.POLL_INTERVAL_SECONDS }, 'DevOps worker started');

  createGracefulShutdown(logger, [
    { interval },
    health,
    worker,
    queue,
    ticketCreatedQueue,
    { fn: async () => { await redis.quit(); } },
    { fn: disconnectDb },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start Azure DevOps worker');
  process.exit(1);
});
