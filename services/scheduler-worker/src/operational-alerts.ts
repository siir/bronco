import type { PrismaClient } from '@bronco/db';
import { DEFAULT_OPERATIONAL_ALERT_CONFIG } from '@bronco/shared-types';
import type { OperationalAlertConfig } from '@bronco/shared-types';
import { Mailer, createLogger, loadSmtpFromDb } from '@bronco/shared-utils';
import cronParser from 'cron-parser';
import { sendRedisCommand } from './redis.js';

const { parseExpression } = cronParser;

const logger = createLogger('operational-alerts');

const SETTINGS_KEY = 'operational-alerts';
const THROTTLE_SETTINGS_KEY = 'operational-alerts:throttle';

/** In-memory throttle map: alertKey → last-sent timestamp. */
const lastAlertSent = new Map<string, Date>();

function shouldAlert(alertKey: string, throttleMinutes: number): boolean {
  const last = lastAlertSent.get(alertKey);
  if (!last) return true;
  return Date.now() - last.getTime() > throttleMinutes * 60_000;
}

function markAlertSent(alertKey: string): void {
  lastAlertSent.set(alertKey, new Date());
}

async function loadThrottleState(db: PrismaClient): Promise<void> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: THROTTLE_SETTINGS_KEY } });
    if (row?.value && typeof row.value === 'object') {
      for (const [key, val] of Object.entries(row.value as Record<string, string>)) {
        const dbTime = new Date(val);
        const inMemTime = lastAlertSent.get(key);
        if (!inMemTime || dbTime > inMemTime) {
          lastAlertSent.set(key, dbTime);
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load alert throttle state from DB — using in-memory state');
  }
}

async function persistThrottleState(db: PrismaClient): Promise<void> {
  try {
    const state: Record<string, string> = {};
    for (const [key, val] of lastAlertSent.entries()) {
      state[key] = val.toISOString();
    }
    await db.appSetting.upsert({
      where: { key: THROTTLE_SETTINGS_KEY },
      create: { key: THROTTLE_SETTINGS_KEY, value: state as unknown as object },
      update: { value: state as unknown as object },
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to persist alert throttle state to DB — in-memory state retained');
  }
}

interface AlertMessage {
  key: string;
  subject: string;
  body: string;
}

// ─── Check functions ───

async function checkFailedJobs(redisUrl: string): Promise<AlertMessage[]> {
  const alerts: AlertMessage[] = [];
  try {
    const url = new URL(redisUrl);
    const host = url.hostname;
    const port = parseInt(url.port || '6379', 10);

    const queues = [
      'issue-resolve', 'log-summarize', 'email-ingestion', 'ticket-analysis',
      'ticket-created', 'ticket-ingest', 'devops-sync', 'mcp-discovery',
      'model-catalog-refresh', 'system-analysis', 'probe-execution', 'prompt-retention',
    ];

    const commands = queues.map(q => `ZCARD bull:${q}:failed`);
    const response = await sendRedisCommand(host, port, commands);
    const numbers = response.match(/:(\d+)/g)?.map(m => parseInt(m.slice(1), 10)) ?? [];

    const failedQueues: { name: string; count: number }[] = [];
    queues.forEach((q, i) => {
      const count = numbers[i] ?? 0;
      if (count > 0) failedQueues.push({ name: q, count });
    });

    if (failedQueues.length > 0) {
      const total = failedQueues.reduce((sum, q) => sum + q.count, 0);
      const queueList = failedQueues.map(q => `  - ${q.name}: ${q.count} failed`).join('\n');
      alerts.push({
        key: 'failed-jobs',
        subject: `[Bronco Alert] ${total} failed job${total > 1 ? 's' : ''} across ${failedQueues.length} queue${failedQueues.length > 1 ? 's' : ''}`,
        body: [
          `Bronco detected failed jobs in ${failedQueues.length} queue${failedQueues.length > 1 ? 's' : ''}:`,
          '',
          queueList,
          '',
          'Action required: Review failed jobs in Control Panel.',
          '',
          '---',
          'This is an automated alert from Bronco operational monitoring.',
          'To configure alerts: Control Panel → Settings → Operational Alerts.',
        ].join('\n'),
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to check BullMQ queue stats for alerts');
  }
  return alerts;
}

async function checkProbeMisses(db: PrismaClient): Promise<AlertMessage[]> {
  const alerts: AlertMessage[] = [];
  try {
    const activeProbes = await db.scheduledProbe.findMany({
      where: { isActive: true },
      select: { id: true, name: true, cronExpression: true, lastRunAt: true },
    });

    for (const probe of activeProbes) {
      if (!probe.lastRunAt) continue;

      // Use cron-parser to compute the expected interval between runs.
      // We derive it by comparing two consecutive scheduled times.
      let expectedIntervalMs = 24 * 60 * 60 * 1000; // fallback: daily
      try {
        const interval = parseExpression(probe.cronExpression, { utc: true });
        const next1 = interval.next().getTime();
        const next2 = interval.next().getTime();
        expectedIntervalMs = next2 - next1;
      } catch {
        // Unparseable expression — keep the daily fallback
      }

      // Add a buffer of 2x the interval (clamped: min 1 hour, max 2 hours) to avoid
      // noise from minor scheduling jitter.
      const bufferMs = Math.min(Math.max(2 * expectedIntervalMs, 60 * 60 * 1000), 2 * 60 * 60 * 1000);

      const sinceLastRun = Date.now() - probe.lastRunAt.getTime();
      if (sinceLastRun > expectedIntervalMs + bufferMs) {
        const hoursAgo = Math.round(sinceLastRun / (60 * 60 * 1000));
        alerts.push({
          key: `probe-miss:${probe.id}`,
          subject: `[Bronco Alert] Missed probe schedule: ${probe.name}`,
          body: [
            `Scheduled probe "${probe.name}" has not run in ${hoursAgo} hours.`,
            '',
            `Cron expression: ${probe.cronExpression}`,
            `Last run: ${probe.lastRunAt.toISOString()}`,
            '',
            'The probe-worker may have restarted or the schedule was missed.',
            '',
            'Action required: Check probe-worker health in Control Panel → System Status.',
            '',
            '---',
            'This is an automated alert from Bronco operational monitoring.',
            'To configure alerts: Control Panel → Settings → Operational Alerts.',
          ].join('\n'),
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to check probe schedules for alerts');
  }
  return alerts;
}

async function checkAiProviderHealth(db: PrismaClient): Promise<AlertMessage[]> {
  const alerts: AlertMessage[] = [];
  try {
    const providers = await db.aiProvider.findMany({
      where: { isActive: true },
      include: { models: { where: { isActive: true }, take: 1 } },
    });

    for (const provider of providers) {
      if (provider.models.length === 0) continue;
      const providerType = provider.provider.toUpperCase();

      if (providerType === 'LOCAL' && provider.baseUrl) {
        // Ollama: use /api/tags as a lightweight health check (no generation needed)
        try {
          const response = await fetch(`${provider.baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(5_000),
          });

          if (!response.ok) {
            alerts.push({
              key: `ai-down:${providerType}`,
              subject: `[Bronco Alert] AI provider unhealthy: ${provider.provider}`,
              body: [
                `Ollama at ${provider.baseUrl} returned HTTP ${response.status} on health check.`,
                '',
                'The Ollama server may be up but unable to list models.',
                '',
                'Action required: Check Ollama logs and GPU memory.',
                '',
                '---',
                'This is an automated alert from Bronco operational monitoring.',
                'To configure alerts: Control Panel → Settings → Operational Alerts.',
              ].join('\n'),
            });
          }
        } catch (err) {
          alerts.push({
            key: `ai-down:${providerType}`,
            subject: `[Bronco Alert] AI provider unreachable: ${provider.provider}`,
            body: [
              `Failed to reach Ollama at ${provider.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
              '',
              'Action required: Check if Ollama is running and reachable.',
              '',
              '---',
              'This is an automated alert from Bronco operational monitoring.',
              'To configure alerts: Control Panel → Settings → Operational Alerts.',
            ].join('\n'),
          });
        }
      } else if (providerType !== 'LOCAL' && provider.baseUrl) {
        // Cloud provider: just check reachability (HEAD request)
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          const response = await fetch(provider.baseUrl, {
            method: 'HEAD',
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (response.status >= 500) {
            alerts.push({
              key: `ai-down:${providerType}`,
              subject: `[Bronco Alert] AI provider error: ${provider.provider}`,
              body: [
                `${provider.provider} API at ${provider.baseUrl} returned HTTP ${response.status}.`,
                '',
                'Action required: Check the provider status page.',
                '',
                '---',
                'This is an automated alert from Bronco operational monitoring.',
                'To configure alerts: Control Panel → Settings → Operational Alerts.',
              ].join('\n'),
            });
          }
        } catch (err) {
          alerts.push({
            key: `ai-down:${providerType}`,
            subject: `[Bronco Alert] AI provider unreachable: ${provider.provider}`,
            body: [
              `Failed to reach ${provider.provider} at ${provider.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
              '',
              'Action required: Check network connectivity.',
              '',
              '---',
              'This is an automated alert from Bronco operational monitoring.',
              'To configure alerts: Control Panel → Settings → Operational Alerts.',
            ].join('\n'),
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to check AI provider health for alerts');
  }
  return alerts;
}

async function checkDevopsSyncStaleness(db: PrismaClient): Promise<AlertMessage[]> {
  const alerts: AlertMessage[] = [];
  try {
    const latest = await db.devOpsSyncState.findFirst({
      orderBy: { lastSyncedAt: 'desc' },
      select: { lastSyncedAt: true },
    });

    if (!latest) return alerts; // No sync state — DevOps integration not in use

    // Default poll interval is 120 seconds. Alert if no sync in > 2x that (4 minutes).
    // Use a floor of 10 minutes to avoid noise.
    const staleThresholdMs = 10 * 60 * 1000;
    const sinceLast = Date.now() - latest.lastSyncedAt.getTime();

    if (sinceLast > staleThresholdMs) {
      const minutesAgo = Math.round(sinceLast / (60 * 1000));
      alerts.push({
        key: 'devops-sync-stale',
        subject: `[Bronco Alert] DevOps sync stale (${minutesAgo}m since last sync)`,
        body: [
          `No Azure DevOps sync has occurred in ${minutesAgo} minutes.`,
          '',
          `Last sync: ${latest.lastSyncedAt.toISOString()}`,
          '',
          'Possible causes: PAT expired, API rate limit, devops-worker crashed.',
          '',
          'Action required: Check devops-worker health and Azure DevOps PAT expiry.',
          '',
          '---',
          'This is an automated alert from Bronco operational monitoring.',
          'To configure alerts: Control Panel → Settings → Operational Alerts.',
        ].join('\n'),
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to check DevOps sync staleness for alerts');
  }
  return alerts;
}

async function checkSummarizationStaleness(db: PrismaClient): Promise<AlertMessage[]> {
  const alerts: AlertMessage[] = [];
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const [latestSummary, unsummarizedCount] = await Promise.all([
      db.logSummary.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      db.appLog.count({
        where: {
          createdAt: { gte: twoHoursAgo },
        },
      }),
    ]);

    if (!latestSummary) return alerts; // No summaries yet — system is new

    const sinceLast = Date.now() - latestSummary.createdAt.getTime();
    const staleThresholdMs = 2 * 60 * 60 * 1000; // 2 hours

    if (sinceLast > staleThresholdMs && unsummarizedCount > 0) {
      const hoursAgo = Math.round(sinceLast / (60 * 60 * 1000));
      alerts.push({
        key: 'summarization-stale',
        subject: `[Bronco Alert] Log summarization stale (${hoursAgo}h since last summary)`,
        body: [
          `No log summary has been created in ${hoursAgo} hours, and there are ${unsummarizedCount} recent log entries.`,
          '',
          `Last summary: ${latestSummary.createdAt.toISOString()}`,
          '',
          'The log summarizer cron may be hanging on slow Ollama calls.',
          '',
          'Action required: Check scheduler-worker logs and Ollama availability.',
          '',
          '---',
          'This is an automated alert from Bronco operational monitoring.',
          'To configure alerts: Control Panel → Settings → Operational Alerts.',
        ].join('\n'),
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to check summarization staleness for alerts');
  }
  return alerts;
}

// ─── Main checker ───

interface OperationalAlertOpts {
  db: PrismaClient;
  redisUrl: string;
  encryptionKey: string;
}

async function createMailerFromSmtpSettings(
  db: PrismaClient,
  encryptionKey: string,
): Promise<Mailer | null> {
  const smtpConfig = await loadSmtpFromDb(db, encryptionKey);
  if (!smtpConfig) return null;
  return new Mailer(smtpConfig);
}

async function runAlertCheck(opts: OperationalAlertOpts): Promise<void> {
  const { db, redisUrl, encryptionKey } = opts;

  // Load config
  const settingRow = await db.appSetting.findUnique({
    where: { key: SETTINGS_KEY },
  });

  const config: OperationalAlertConfig = settingRow
    ? (settingRow.value as unknown as OperationalAlertConfig)
    : DEFAULT_OPERATIONAL_ALERT_CONFIG;

  if (!config.enabled || !config.recipientOperatorId) {
    logger.debug('Operational alerts disabled or no recipient operator — skipping');
    return;
  }

  // Restore throttle state from DB so restarts don't reset the throttle window
  await loadThrottleState(db);

  const operator = await db.operator.findUnique({
    where: { id: config.recipientOperatorId },
  });
  if (!operator) {
    logger.warn({ recipientOperatorId: config.recipientOperatorId }, 'Recipient operator not found — skipping alerts');
    return;
  }

  // Gather alerts from all enabled checks in parallel
  const checkPromises: Promise<AlertMessage[]>[] = [];

  if (config.alerts.failedJobs) {
    checkPromises.push(checkFailedJobs(redisUrl));
  }
  if (config.alerts.probeMisses) {
    checkPromises.push(checkProbeMisses(db));
  }
  if (config.alerts.aiProviderDown) {
    checkPromises.push(checkAiProviderHealth(db));
  }
  if (config.alerts.devopsSyncStale) {
    checkPromises.push(checkDevopsSyncStaleness(db));
  }
  if (config.alerts.summarizationStale) {
    checkPromises.push(checkSummarizationStaleness(db));
  }

  const results = await Promise.all(checkPromises);
  const allAlerts = results.flat();

  // Filter by throttle
  const alertsToSend = allAlerts.filter(a => shouldAlert(a.key, config.throttleMinutes));

  logger.debug(
    { totalDetected: allAlerts.length, afterThrottle: alertsToSend.length },
    'Operational alert check complete',
  );

  if (alertsToSend.length === 0) return;

  // Create mailer from System Settings SMTP config
  const mailer = await createMailerFromSmtpSettings(db, encryptionKey);
  if (!mailer) {
    logger.warn('SMTP not configured in System Settings — cannot send operational alerts');
    return;
  }

  try {
    for (const alert of alertsToSend) {
      try {
        await mailer.send({
          to: operator.email,
          subject: alert.subject,
          body: alert.body,
        });
        markAlertSent(alert.key);
        logger.info({ alertKey: alert.key, to: operator.email }, 'Operational alert sent');
      } catch (err) {
        logger.error({ err, alertKey: alert.key }, 'Failed to send operational alert email');
      }
    }
    // Persist throttle state so restarts don't re-send recently-sent alerts
    await persistThrottleState(db);
  } finally {
    await mailer.close();
  }
}

// ─── Public API ───

let intervalHandle: ReturnType<typeof setInterval> | undefined;
let initialTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
let isRunning = false;

export function startOperationalAlertChecker(opts: OperationalAlertOpts): void {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  logger.info('Starting operational alert checker (every 5 minutes)');

  // Run first check after a short delay (30s) to let everything start
  initialTimeoutHandle = setTimeout(() => {
    initialTimeoutHandle = undefined;
    if (isRunning) return;
    isRunning = true;
    runAlertCheck(opts)
      .catch(err => {
        logger.error({ err }, 'Operational alert check failed');
      })
      .finally(() => {
        isRunning = false;
      });
  }, 30_000);

  intervalHandle = setInterval(() => {
    if (isRunning) {
      logger.warn('Previous alert check still running — skipping this interval');
      return;
    }
    isRunning = true;
    runAlertCheck(opts)
      .catch(err => {
        logger.error({ err }, 'Operational alert check failed');
      })
      .finally(() => {
        isRunning = false;
      });
  }, CHECK_INTERVAL_MS);
}

export function stopOperationalAlertChecker(): void {
  if (initialTimeoutHandle) {
    clearTimeout(initialTimeoutHandle);
    initialTimeoutHandle = undefined;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
    logger.info('Operational alert checker stopped');
  }
}
