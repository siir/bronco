import { writeFile, mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import cron from 'node-cron';
import type { Queue } from 'bullmq';
import { type PrismaClient, Prisma } from '@bronco/db';
import { TaskType, BUILTIN_PROBE_TOOL_NAMES } from '@bronco/shared-types';
import type { TicketCategory, TicketCreatedJob, IngestionJob } from '@bronco/shared-types';
import type { AIRouter } from '@bronco/ai-provider';
import { createLogger, decrypt, looksEncrypted, callMcpToolViaSdk, buildUtcCron, AppLogger, createPrismaLogWriter } from '@bronco/shared-utils';
import type { Mailer } from '@bronco/shared-utils';
import { BUILTIN_TOOLS } from './builtin-tools.js';

const logger = createLogger('probe-worker');
export const appLog = new AppLogger('probe-worker');

export function initProbeWorkerLogger(db: PrismaClient): void {
  appLog.setWriter(createPrismaLogWriter(db));
}

/** Re-poll DB interval for new/modified probes (ms). */
const RELOAD_INTERVAL_MS = 5 * 60 * 1000;

interface ProbeConfig {
  id: string;
  clientId: string;
  integrationId: string | null;
  name: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  cronExpression: string;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  scheduleDaysOfWeek: string | null;
  scheduleTimezone: string | null;
  category: string | null;
  action: string;
  actionConfig: Record<string, unknown> | null;
  retentionDays: number;
  retentionMaxRuns: number;
}

interface ProbeWorkerDeps {
  db: PrismaClient;
  ai: AIRouter;
  mailer: Mailer | null;
  encryptionKey: string;
  artifactStoragePath: string;
  /** Optional BullMQ queue for ticket-created events — legacy path, used when no ingestion route is configured. */
  ticketCreatedQueue?: Queue<TicketCreatedJob>;
  /** BullMQ queue for the ingestion engine — probe results are submitted here for route-driven processing. */
  ingestQueue?: Queue<IngestionJob>;
}

// ---------------------------------------------------------------------------
// RunTracker — records ProbeRun + ProbeRunStep rows as a probe executes
// ---------------------------------------------------------------------------

interface RunTracker {
  runId: string;
  startStep(name: string): Promise<string>;
  completeStep(stepId: string, detail?: string): Promise<void>;
  failStep(stepId: string, error: string): Promise<void>;
  skipStep(stepId: string, reason?: string): Promise<void>;
  completeRun(status: string, result?: string, error?: string): Promise<void>;
}

async function createRunTracker(
  db: PrismaClient,
  probeId: string,
  triggeredBy: string,
): Promise<RunTracker> {
  const run = await db.probeRun.create({
    data: {
      probeId,
      status: 'running',
      triggeredBy,
    },
  });

  let stepCounter = 0;

  return {
    runId: run.id,

    async startStep(name: string): Promise<string> {
      stepCounter += 1;
      const step = await db.probeRunStep.create({
        data: {
          runId: run.id,
          stepOrder: stepCounter,
          stepName: name,
          status: 'running',
          startedAt: new Date(),
        },
      });
      return step.id;
    },

    async completeStep(stepId: string, detail?: string): Promise<void> {
      await db.probeRunStep.update({
        where: { id: stepId },
        data: {
          status: 'success',
          completedAt: new Date(),
          detail: detail?.slice(0, 50000) ?? null,
        },
      });
    },

    async failStep(stepId: string, error: string): Promise<void> {
      await db.probeRunStep.update({
        where: { id: stepId },
        data: {
          status: 'error',
          completedAt: new Date(),
          error: error.slice(0, 10000),
        },
      });
    },

    async skipStep(stepId: string, reason?: string): Promise<void> {
      await db.probeRunStep.update({
        where: { id: stepId },
        data: {
          status: 'skipped',
          completedAt: new Date(),
          detail: reason ?? null,
        },
      });
    },

    async completeRun(status: string, result?: string, error?: string): Promise<void> {
      const startedAt = run.startedAt;
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      await db.probeRun.update({
        where: { id: run.id },
        data: {
          status,
          completedAt,
          durationMs,
          result: result?.slice(0, 50000) ?? null,
          error: error?.slice(0, 10000) ?? null,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Retention cleanup
// ---------------------------------------------------------------------------

async function cleanupRetention(
  db: PrismaClient,
  probeId: string,
  retentionDays: number,
  retentionMaxRuns: number,
): Promise<void> {
  try {
    // Delete runs older than retentionDays, but keep at least the most recent 5
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const recentRuns = await db.probeRun.findMany({
      where: { probeId },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: { id: true },
    });
    const keepIds = new Set(recentRuns.map((r) => r.id));

    await db.probeRun.deleteMany({
      where: {
        probeId,
        startedAt: { lt: cutoff },
        id: { notIn: [...keepIds] },
      },
    });

    // Enforce max runs count (skip if retentionMaxRuns <= 0 to avoid wiping all runs)
    if (retentionMaxRuns <= 0) return;
    const totalCount = await db.probeRun.count({ where: { probeId } });
    if (totalCount > retentionMaxRuns) {
      const excess = await db.probeRun.findMany({
        where: { probeId },
        orderBy: { startedAt: 'desc' },
        skip: retentionMaxRuns,
        select: { id: true },
      });
      if (excess.length > 0) {
        await db.probeRun.deleteMany({
          where: { id: { in: excess.map((r) => r.id) } },
        });
      }
    }
  } catch (err) {
    logger.error({ err, probeId }, 'Failed to clean up probe run history');
  }
}

// ---------------------------------------------------------------------------
// Core probe execution
// ---------------------------------------------------------------------------

async function getIntegrationConfig(
  db: PrismaClient,
  integrationId: string,
  encryptionKey: string,
): Promise<{ url: string; mcpPath?: string; apiKey?: string; authHeader?: string } | null> {
  const integ = await db.clientIntegration.findUnique({
    where: { id: integrationId },
    select: { config: true, isActive: true },
  });
  if (!integ || !integ.isActive) return null;

  const cfg = integ.config as Record<string, unknown>;
  const url = typeof cfg['url'] === 'string' ? cfg['url'] : '';
  if (!url) return null;

  let apiKey: string | undefined;
  if (typeof cfg['apiKey'] === 'string' && cfg['apiKey']) {
    try {
      apiKey = looksEncrypted(cfg['apiKey'])
        ? decrypt(cfg['apiKey'], encryptionKey)
        : cfg['apiKey'];
    } catch {
      logger.warn({ integrationId }, 'Failed to decrypt MCP API key');
      return null;
    }
  }

  const authHeader = typeof cfg['authHeader'] === 'string' ? cfg['authHeader'] : 'bearer';
  const mcpPath = typeof cfg['mcpPath'] === 'string' ? cfg['mcpPath'] : undefined;
  return { url, mcpPath, apiKey, authHeader };
}

async function executeProbe(
  probe: ProbeConfig,
  deps: ProbeWorkerDeps,
  triggeredBy: string = 'schedule',
): Promise<void> {
  const { db, ai, mailer, encryptionKey } = deps;

  logger.info({ probeId: probe.id, tool: probe.toolName }, `Executing probe: ${probe.name}`);
  appLog.info(`Probe "${probe.name}" started`, { probeId: probe.id, toolName: probe.toolName, clientId: probe.clientId }, probe.id, 'probe');

  const tracker = await createRunTracker(db, probe.id, triggeredBy);

  try {
    let toolResult: string;
    const builtinHandler = BUILTIN_TOOLS[probe.toolName];
    try {
      if (builtinHandler) {
        // Built-in tool: execute locally, no MCP integration needed.
        const stepId = await tracker.startStep('Execute built-in tool');
        try {
          toolResult = await builtinHandler(probe.toolParams, { db });
          await tracker.completeStep(stepId, toolResult.slice(0, 4000));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, probeId: probe.id }, `Built-in tool failed: ${msg}`);
          await tracker.failStep(stepId, msg);
          await tracker.completeRun('error', undefined, msg);
          await updateProbeRun(db, probe.id, 'error', msg.slice(0, 2000));
          return;
        }
      } else if (BUILTIN_PROBE_TOOL_NAMES.has(probe.toolName)) {
        throw new Error(
          `Built-in tool "${probe.toolName}" is registered but has no handler — possible version mismatch`,
        );
      } else {
        // MCP tool: load integration config and call remote server
        if (!probe.integrationId) {
          const msg = `MCP tool "${probe.toolName}" requires an integration but none is configured`;
          await tracker.completeRun('error', undefined, msg);
          await updateProbeRun(db, probe.id, 'error', msg);
          return;
        }
        // Step 1: Load integration config
        let stepId = await tracker.startStep('Load integration config');
        let integConfig: { url: string; mcpPath?: string; apiKey?: string; authHeader?: string } | null;
        try {
          integConfig = await getIntegrationConfig(db, probe.integrationId, encryptionKey);
          if (!integConfig) {
            await tracker.failStep(stepId, 'Integration not available or inactive');
            await tracker.completeRun('error', undefined, 'Integration not available or inactive');
            await updateProbeRun(db, probe.id, 'error', 'Integration not available or inactive');
            return;
          }
          await tracker.completeStep(stepId, `URL: ${integConfig.url}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await tracker.failStep(stepId, msg);
          await tracker.completeRun('error', undefined, msg);
          await updateProbeRun(db, probe.id, 'error', msg.slice(0, 2000));
          return;
        }

        // Step 2: Call MCP tool
        stepId = await tracker.startStep('Call MCP tool');
        try {
          toolResult = await callMcpToolViaSdk(
            integConfig.url,
            integConfig.mcpPath,
            probe.toolName,
            probe.toolParams,
            integConfig.apiKey,
            integConfig.authHeader,
          );
          await tracker.completeStep(stepId, toolResult.slice(0, 4000));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, probeId: probe.id }, `Probe MCP call failed: ${msg}`);
          await tracker.failStep(stepId, msg);
          await tracker.completeRun('error', undefined, msg);
          await updateProbeRun(db, probe.id, 'error', msg.slice(0, 2000));
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, probeId: probe.id }, `Probe execution failed: ${msg}`);
      await tracker.completeRun('error', undefined, msg);
      await updateProbeRun(db, probe.id, 'error', msg.slice(0, 2000));
      return;
    }

    // Step 3: Evaluate result
    let stepId = await tracker.startStep('Evaluate result');
    if (!toolResult || toolResult.trim().length === 0) {
      appLog.info(`Probe "${probe.name}" skipped — empty result`, { probeId: probe.id, clientId: probe.clientId, toolName: probe.toolName }, probe.id, 'probe');
      await tracker.skipStep(stepId, 'Empty tool result');
      await tracker.completeRun('skipped', 'Empty tool result');
      await updateProbeRun(db, probe.id, 'skipped', 'Empty tool result');
      return;
    }
    await tracker.completeStep(stepId, 'Result non-empty, proceeding to action');

    const truncatedResult = toolResult.slice(0, 4000);

    // Step 4: Execute action
    try {
      if (probe.action === 'create_ticket') {
        // When an ingest queue is available, submit raw probe result to the
        // ingestion engine for route-driven processing (CATEGORIZE, GENERATE_TITLE,
        // CREATE_TICKET steps configured by the operator). Falls back to the
        // legacy inline path when no ingest queue is wired up.
        if (deps.ingestQueue) {
          stepId = await tracker.startStep('Enqueue to ingestion engine');
          const operatorEmail = (probe.actionConfig as Record<string, unknown> | null)?.['operatorEmail'];
          await deps.ingestQueue.add('ticket-ingest', {
            source: 'SCHEDULED',
            clientId: probe.clientId,
            payload: {
              probeId: probe.id,
              probeName: probe.name,
              toolName: probe.toolName,
              toolResult: toolResult.slice(0, 50000),
              ...(probe.category && { category: probe.category }),
              ...(probe.integrationId && { integrationId: probe.integrationId }),
              ...(typeof operatorEmail === 'string' && operatorEmail.trim() && { operatorEmail }),
            },
          }, {
            jobId: `ingest-probe-${probe.id}-${Date.now()}`,
            attempts: 4,
            backoff: { type: 'exponential', delay: 30_000 },
          });
          await tracker.completeStep(stepId, 'Submitted to ingestion engine');
          appLog.info(`Probe "${probe.name}" result queued for ingestion`, { probeId: probe.id, toolName: probe.toolName, clientId: probe.clientId, resultLength: Math.min(toolResult.length, 50000) }, probe.id, 'probe');
          await tracker.completeRun('success', `Ingestion queued. Result: ${truncatedResult.slice(0, 500)}`);
          await updateProbeRun(db, probe.id, 'success', `Ingestion queued. Result: ${truncatedResult.slice(0, 500)}`);
        } else {
          // Legacy path: AI summarize + title + create ticket inline
          stepId = await tracker.startStep('AI summarize for ticket');
          const summary = await summarizeForTicket(ai, probe, truncatedResult);
          await tracker.completeStep(stepId, summary.slice(0, 4000));

          stepId = await tracker.startStep('AI generate title');
          const title = await generateTicketTitle(ai, probe, summary);
          await tracker.completeStep(stepId, title);

          stepId = await tracker.startStep('Create ticket');
          const ticket = await createTicketFromProbe(db, probe, summary, title);
          await tracker.completeStep(stepId, `Ticket created: ${ticket.id}`);

          stepId = await tracker.startStep('Save raw result artifact');
          await saveRawResultArtifact(db, ticket.id, probe, toolResult, deps.artifactStoragePath);
          await tracker.completeStep(stepId, 'Artifact saved');

          if (deps.ticketCreatedQueue) {
            await deps.ticketCreatedQueue.add('ticket-created', {
              ticketId: ticket.id,
              clientId: ticket.clientId,
              source: 'SCHEDULED' as const,
              category: (probe.category ?? null) as TicketCreatedJob['category'],
            }, {
              jobId: `ticket-created-${ticket.id}`,
              attempts: 4,
              backoff: { type: 'exponential', delay: 30_000 },
            });
            logger.info({ probeId: probe.id, ticketId: ticket.id }, 'Enqueued ticket-created event');
          }
          await tracker.completeRun('success', `Ticket created. Result: ${truncatedResult.slice(0, 500)}`);
          await updateProbeRun(db, probe.id, 'success', `Ticket created. Result: ${truncatedResult.slice(0, 500)}`);
        }
      } else if (probe.action === 'email_direct') {
        stepId = await tracker.startStep('AI summarize for email');
        const summary = await summarizeForEmail(ai, probe, truncatedResult);
        await tracker.completeStep(stepId, summary.slice(0, 2000));

        const actionCfg = probe.actionConfig ?? {};
        const emailTo = typeof actionCfg['emailTo'] === 'string' ? actionCfg['emailTo'] : '';
        const emailSubject = typeof actionCfg['emailSubject'] === 'string'
          ? actionCfg['emailSubject']
          : `Probe Result: ${probe.name}`;

        if (!mailer) {
          stepId = await tracker.startStep('Send email');
          await tracker.failStep(stepId, 'SMTP not configured — email sending disabled');
          await tracker.completeRun('error', undefined, 'SMTP not configured — email sending disabled');
          await updateProbeRun(db, probe.id, 'error', 'SMTP not configured — email sending disabled');
        } else if (emailTo) {
          stepId = await tracker.startStep('Send email');
          try {
            await mailer.send({ to: emailTo, subject: emailSubject, body: summary });
            await tracker.completeStep(stepId, `Sent to ${emailTo}`);
            await tracker.completeRun('success', `Email sent to ${emailTo}`);
            await updateProbeRun(db, probe.id, 'success', `Email sent to ${emailTo}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err, probeId: probe.id }, 'Failed to send probe email');
            await tracker.failStep(stepId, msg);
            await tracker.completeRun('error', undefined, `Email send failed: ${msg.slice(0, 500)}`);
            await updateProbeRun(db, probe.id, 'error', `Email send failed: ${msg.slice(0, 500)}`);
          }
        } else {
          stepId = await tracker.startStep('Send email');
          await tracker.failStep(stepId, 'No emailTo configured in actionConfig');
          await tracker.completeRun('error', undefined, 'No emailTo configured in actionConfig');
          await updateProbeRun(db, probe.id, 'error', 'No emailTo configured in actionConfig');
        }
      } else if (probe.action === 'silent') {
        // Silent probes: classify actionability first, only ingest/create if actionable
        stepId = await tracker.startStep('AI classify actionability');
        const actionable = await classifyActionable(ai, probe, truncatedResult);
        await tracker.completeStep(stepId, actionable ? 'Actionable — creating ticket' : 'Not actionable');

        if (actionable) {
          if (deps.ingestQueue) {
            stepId = await tracker.startStep('Enqueue to ingestion engine');
            const operatorEmail = (probe.actionConfig as Record<string, unknown> | null)?.['operatorEmail'];
            await deps.ingestQueue.add('ticket-ingest', {
              source: 'SCHEDULED',
              clientId: probe.clientId,
              payload: {
                probeId: probe.id,
                probeName: probe.name,
                toolName: probe.toolName,
                toolResult: toolResult.slice(0, 50000),
                ...(probe.category && { category: probe.category }),
                ...(probe.integrationId && { integrationId: probe.integrationId }),
                ...(typeof operatorEmail === 'string' && operatorEmail.trim() && { operatorEmail }),
              },
            }, {
              jobId: `ingest-probe-${probe.id}-${Date.now()}`,
              attempts: 4,
              backoff: { type: 'exponential', delay: 30_000 },
            });
            await tracker.completeStep(stepId, 'Submitted to ingestion engine');
            appLog.info(`Probe "${probe.name}" result queued for ingestion`, { probeId: probe.id, toolName: probe.toolName, clientId: probe.clientId, resultLength: Math.min(toolResult.length, 50000) }, probe.id, 'probe');
            await tracker.completeRun('success', `Silent probe — ingestion queued. Result: ${truncatedResult.slice(0, 500)}`);
            await updateProbeRun(db, probe.id, 'success', `Silent probe — ingestion queued. Result: ${truncatedResult.slice(0, 500)}`);
          } else {
            // Legacy path
            stepId = await tracker.startStep('AI summarize for ticket');
            const silentSummary = await summarizeForTicket(ai, probe, truncatedResult);
            await tracker.completeStep(stepId, silentSummary.slice(0, 4000));

            stepId = await tracker.startStep('AI generate title');
            const silentTitle = await generateTicketTitle(ai, probe, silentSummary);
            await tracker.completeStep(stepId, silentTitle);

            stepId = await tracker.startStep('Create ticket');
            const ticket = await createTicketFromProbe(db, probe, silentSummary, silentTitle);
            await tracker.completeStep(stepId, `Ticket created: ${ticket.id}`);

            stepId = await tracker.startStep('Save raw result artifact');
            await saveRawResultArtifact(db, ticket.id, probe, toolResult, deps.artifactStoragePath);
            await tracker.completeStep(stepId, 'Artifact saved');

            if (deps.ticketCreatedQueue) {
              await deps.ticketCreatedQueue.add('ticket-created', {
                ticketId: ticket.id,
                clientId: ticket.clientId,
                source: 'SCHEDULED' as const,
                category: (probe.category ?? null) as TicketCreatedJob['category'],
              }, {
                jobId: `ticket-created-${ticket.id}`,
                attempts: 4,
                backoff: { type: 'exponential', delay: 30_000 },
              });
              logger.info({ probeId: probe.id, ticketId: ticket.id }, 'Enqueued ticket-created event (silent probe)');
            }
            await tracker.completeRun('success', `Silent probe triggered ticket. Result: ${truncatedResult.slice(0, 500)}`);
            await updateProbeRun(db, probe.id, 'success', `Silent probe triggered ticket. Result: ${truncatedResult.slice(0, 500)}`);
          }
        } else {
          await tracker.completeRun('skipped', `Silent — not actionable. Result: ${truncatedResult.slice(0, 500)}`);
          await updateProbeRun(db, probe.id, 'skipped', `Silent — not actionable. Result: ${truncatedResult.slice(0, 500)}`);
        }
      } else {
        await tracker.completeRun('error', undefined, `Unknown action: ${probe.action}`);
        await updateProbeRun(db, probe.id, 'error', `Unknown action: ${probe.action}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, probeId: probe.id }, `Probe action failed: ${msg}`);
      appLog.error(`Probe "${probe.name}" failed: ${msg}`, { probeId: probe.id, err, errorMessage: msg, clientId: probe.clientId, toolName: probe.toolName, ...(probe.integrationId && { integrationId: probe.integrationId }) }, probe.id, 'probe');
      await tracker.completeRun('error', undefined, msg);
      await updateProbeRun(db, probe.id, 'error', msg.slice(0, 2000));
    }
  } finally {
    await cleanupRetention(db, probe.id, probe.retentionDays, probe.retentionMaxRuns);
  }
}

async function classifyActionable(
  ai: AIRouter,
  probe: ProbeConfig,
  toolResult: string,
): Promise<boolean> {
  try {
    const res = await ai.generate({
      taskType: TaskType.CLASSIFY_INTENT,
      context: { clientId: probe.clientId, entityId: probe.id, entityType: 'probe' },
      prompt: `You are reviewing the output of a scheduled database monitoring probe.

Probe name: ${probe.name}
Tool called: ${probe.toolName}

Tool output:
${toolResult}

Does this tool output indicate a problem, issue, or anomaly that requires attention? Respond with only YES or NO followed by a one-line reason.

Examples:
- YES — Blocking chains detected involving 3+ sessions
- NO — No active blocking detected, system healthy
- YES — Wait stats show high PAGEIOLATCH waits indicating I/O pressure
- NO — All metrics within normal ranges`,
    });
    const answer = res.content.trim().toUpperCase();
    return answer.startsWith('YES');
  } catch (err) {
    logger.error({ err, probeId: probe.id }, 'Failed to classify probe result');
    return false;
  }
}

async function summarizeForEmail(
  ai: AIRouter,
  probe: ProbeConfig,
  toolResult: string,
): Promise<string> {
  try {
    const res = await ai.generate({
      taskType: TaskType.SUMMARIZE_LOGS,
      context: { clientId: probe.clientId, entityId: probe.id, entityType: 'probe' },
      prompt: `Summarize the following monitoring probe result into a clear, human-readable email body.

Probe: ${probe.name}
Tool: ${probe.toolName}

Raw output:
${toolResult}

Write a concise summary suitable for an email notification.`,
    });
    return res.content.trim();
  } catch {
    return `Probe "${probe.name}" completed.\n\nRaw result:\n${toolResult}`;
  }
}

async function summarizeForTicket(
  ai: AIRouter,
  probe: ProbeConfig,
  toolResult: string,
): Promise<string> {
  try {
    const res = await ai.generate({
      taskType: TaskType.SUMMARIZE_LOGS,
      context: { clientId: probe.clientId, entityId: probe.id, entityType: 'probe' },
      prompt: `Summarize the following monitoring probe result for a support ticket description.
Include key findings, error counts, severity levels, and any items requiring attention.
Format as clear plain text with sections, not raw JSON.

Probe: ${probe.name}
Tool: ${probe.toolName}

Raw output:
${toolResult}`,
    });
    return res.content.trim();
  } catch {
    return toolResult;
  }
}

async function generateTicketTitle(
  ai: AIRouter,
  probe: ProbeConfig,
  summary: string,
): Promise<string> {
  try {
    const res = await ai.generate({
      taskType: TaskType.GENERATE_TITLE,
      context: { clientId: probe.clientId, entityId: probe.id, entityType: 'probe' },
      prompt: `Output ONLY a concise ticket title, max 80 characters. No quotes, no preamble, no explanation, no "Here's a title" — just the title text itself.

Probe: ${probe.name}
Summary: ${summary.slice(0, 500)}`,
    });
    let title = res.content.trim();
    // Strip quotes and conversational wrappers
    title = title.replace(/^["']|["']$/g, '');
    title = title.replace(/^(here'?s?\s+(a\s+)?(concise\s+)?ticket\s+title:?\s*)/i, '');
    title = title.replace(/^title:\s*/i, '');
    return title.slice(0, 80) || `[Probe] ${probe.name}`;
  } catch {
    return `[Probe] ${probe.name}`;
  }
}

async function saveRawResultArtifact(
  db: PrismaClient,
  ticketId: string,
  probe: ProbeConfig,
  rawResult: string,
  artifactStoragePath: string,
): Promise<void> {
  try {
    // Detect whether the raw result is valid JSON or plain text
    let isJson = false;
    try {
      JSON.parse(rawResult);
      isJson = true;
    } catch {
      // not JSON — treat as plain text
    }
    const mimeType = isJson ? 'application/json' : 'text/plain';
    const ext = isJson ? 'json' : 'txt';

    const storagePath = artifactStoragePath;
    const safeToolName = probe.toolName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
    const filename = `probe-${safeToolName}-${Date.now()}.${ext}`;
    const ticketDir = resolve(storagePath, 'tickets', ticketId);
    const resolvedStorage = resolve(storagePath);
    // Use path.relative() rather than startsWith() so the check is correct on all
    // platforms (Windows uses backslash separators) and when resolvedStorage is '/'.
    const rel = relative(resolvedStorage, ticketDir);
    if (rel.startsWith('..') || rel === '') {
      throw new Error(`Path traversal detected: ${ticketDir}`);
    }
    const fullPath = join(ticketDir, filename);

    await mkdir(ticketDir, { recursive: true });
    await writeFile(fullPath, rawResult, 'utf-8');

    await db.artifact.create({
      data: {
        ticketId,
        filename,
        mimeType,
        sizeBytes: Buffer.byteLength(rawResult, 'utf-8'),
        storagePath: `tickets/${ticketId}/${filename}`,
        description: `Raw MCP tool output from probe "${probe.name}" (${probe.toolName})`,
      },
    });
  } catch (err) {
    logger.warn({ err, ticketId, probeId: probe.id }, 'Failed to save raw result artifact — continuing');
  }
}

async function nextTicketNumber(db: PrismaClient, clientId: string): Promise<number> {
  const last = await db.ticket.findFirst({
    where: { clientId, ticketNumber: { gt: 0 } },
    orderBy: { ticketNumber: 'desc' },
    select: { ticketNumber: true },
  });
  return (last?.ticketNumber ?? 0) + 1;
}

const MAX_TICKET_RETRIES = 3;

async function createTicketFromProbe(
  db: PrismaClient,
  probe: ProbeConfig,
  description: string,
  title?: string,
): Promise<{ id: string; clientId: string }> {
  // Resolve requester from operatorEmail in actionConfig
  let requesterContactId: string | undefined;
  const operatorEmail = (probe.actionConfig as Record<string, unknown> | null)?.['operatorEmail'];
  if (typeof operatorEmail === 'string' && operatorEmail.trim()) {
    const trimmedOperatorEmail = operatorEmail.trim();
    const contact = await db.contact.findFirst({
      where: { email: { equals: trimmedOperatorEmail, mode: 'insensitive' }, clientId: probe.clientId },
      select: { id: true },
    });
    requesterContactId = contact?.id ?? undefined;
    if (!requesterContactId) {
      logger.warn({ probeId: probe.id, operatorEmail }, 'operatorEmail specified but no matching contact found — ticket will have no requester');
    }
  }

  for (let attempt = 0; attempt <= MAX_TICKET_RETRIES; attempt++) {
    const ticketNumber = await nextTicketNumber(db, probe.clientId);

    try {
      const ticket = await db.ticket.create({
        data: {
          clientId: probe.clientId,
          subject: title ?? `[Probe] ${probe.name}: ${probe.toolName}`,
          description,
          source: 'SCHEDULED',
          category: (probe.category || null) as TicketCategory | null,
          ticketNumber,
          metadata: {
            probeId: probe.id,
            toolName: probe.toolName,
            integrationId: probe.integrationId,
          },
          ...(requesterContactId && {
            followers: {
              create: { contactId: requesterContactId, followerType: 'REQUESTER' },
            },
          }),
        },
        select: { id: true, clientId: true },
      });
      return ticket;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_TICKET_RETRIES) {
        logger.warn({ attempt, probeId: probe.id }, 'Ticket number conflict — retrying');
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to create ticket after max retries');
}

async function updateProbeRun(
  db: PrismaClient,
  probeId: string,
  status: string,
  result: string,
): Promise<void> {
  try {
    await db.scheduledProbe.update({
      where: { id: probeId },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: status,
        lastRunResult: result.slice(0, 4000),
      },
    });
  } catch (err) {
    logger.error({ err, probeId }, 'Failed to update probe run status');
  }
}

// ---------------------------------------------------------------------------
// Scheduler — manages cron tasks for all active probes
// ---------------------------------------------------------------------------

export class ProbeScheduler {
  private tasks = new Map<string, cron.ScheduledTask>();
  private taskCrons = new Map<string, string>();
  private runningProbes = new Set<string>();
  private reloadInterval: ReturnType<typeof setInterval> | null = null;
  private deps: ProbeWorkerDeps;

  constructor(deps: ProbeWorkerDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    logger.info('Probe scheduler starting');
    await this.reload();
    this.reloadInterval = setInterval(() => {
      this.reload().catch((err) => {
        logger.error({ err }, 'Failed to reload probes');
      });
    }, RELOAD_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.reloadInterval) {
      clearInterval(this.reloadInterval);
      this.reloadInterval = null;
    }
    for (const [id, task] of this.tasks) {
      task.stop();
      this.tasks.delete(id);
    }
    logger.info('Probe scheduler stopped');
  }

  /** Execute a single probe by ID (for one-off BullMQ jobs). */
  async executeById(probeId: string): Promise<void> {
    if (this.runningProbes.has(probeId)) {
      logger.info({ probeId }, 'Skipping manual execution — probe already running');
      return;
    }
    this.runningProbes.add(probeId);
    try {
      const probe = await this.deps.db.scheduledProbe.findUnique({
        where: { id: probeId },
      });
      if (!probe) {
        logger.warn({ probeId }, 'Probe not found for execution');
        return;
      }
      const config: ProbeConfig = {
        id: probe.id,
        clientId: probe.clientId,
        integrationId: probe.integrationId,
        name: probe.name,
        toolName: probe.toolName,
        toolParams: (probe.toolParams as Record<string, unknown>) ?? {},
        cronExpression: probe.cronExpression,
        scheduleHour: probe.scheduleHour,
        scheduleMinute: probe.scheduleMinute,
        scheduleDaysOfWeek: probe.scheduleDaysOfWeek,
        scheduleTimezone: probe.scheduleTimezone,
        category: probe.category,
        action: probe.action,
        actionConfig: probe.actionConfig as Record<string, unknown> | null,
        retentionDays: probe.retentionDays,
        retentionMaxRuns: probe.retentionMaxRuns,
      };
      await executeProbe(config, this.deps, 'manual');
    } finally {
      this.runningProbes.delete(probeId);
    }
  }

  private async reload(): Promise<void> {
    const probes = await this.deps.db.scheduledProbe.findMany({
      where: { isActive: true },
    });

    const activeIds = new Set(probes.map((p) => p.id));

    // Remove cron tasks for probes that are no longer active
    for (const [id, task] of this.tasks) {
      if (!activeIds.has(id)) {
        task.stop();
        this.tasks.delete(id);
        this.taskCrons.delete(id);
        logger.info({ probeId: id }, 'Removed inactive probe from scheduler');
      }
    }

    // Add or update cron tasks
    for (const probe of probes) {
      // Compute effective cron: use timezone fields if set and valid, otherwise raw cronExpression
      let effectiveCron = probe.cronExpression;
      if (probe.scheduleTimezone && probe.scheduleHour != null && probe.scheduleMinute != null) {
        try {
          effectiveCron = buildUtcCron({
            hour: probe.scheduleHour,
            minute: probe.scheduleMinute,
            daysOfWeek: probe.scheduleDaysOfWeek,
            timezone: probe.scheduleTimezone,
          });
        } catch (err) {
          logger.warn(
            { err, probeId: probe.id, timezone: probe.scheduleTimezone },
            'buildUtcCron failed — falling back to raw cronExpression',
          );
          effectiveCron = probe.cronExpression;
        }
      } else if (probe.scheduleTimezone && (probe.scheduleHour == null || probe.scheduleMinute == null)) {
        logger.warn(
          { probeId: probe.id, timezone: probe.scheduleTimezone },
          'scheduleTimezone set but scheduleHour/scheduleMinute are null — falling back to raw cronExpression',
        );
      }

      const existing = this.tasks.get(probe.id);
      const existingCron = this.taskCrons.get(probe.id);

      // Skip if already scheduled with same cron expression
      if (existing && existingCron === effectiveCron) continue;

      // Reschedule if cron expression changed
      if (existing) {
        existing.stop();
        this.tasks.delete(probe.id);
        this.taskCrons.delete(probe.id);
        logger.info({ probeId: probe.id, oldCron: existingCron, newCron: effectiveCron }, 'Rescheduling probe');
      }

      if (!cron.validate(effectiveCron)) {
        logger.warn({ probeId: probe.id, cron: effectiveCron }, 'Invalid cron expression, skipping');
        continue;
      }

      this.scheduleProbeTask(probe.id, effectiveCron);
      logger.info({ probeId: probe.id, name: probe.name, cron: effectiveCron }, 'Scheduled probe');
    }

    logger.info({ count: this.tasks.size }, 'Probe reload complete');
  }

  /** Create and register a cron task for a probe. Assumes the probe is not already in this.tasks. */
  private scheduleProbeTask(probeId: string, cronExpression: string): void {
    const task = cron.schedule(cronExpression, async () => {
      // Per-probe lock to prevent overlapping executions
      if (this.runningProbes.has(probeId)) {
        logger.info({ probeId }, 'Skipping overlapping probe execution');
        return;
      }
      this.runningProbes.add(probeId);
      try {
        // Re-fetch config from DB to pick up any changes
        const latestProbe = await this.deps.db.scheduledProbe.findUnique({
          where: { id: probeId },
        });
        if (!latestProbe || !latestProbe.isActive) {
          logger.info({ probeId }, 'Skipping probe execution — inactive or missing');
          return;
        }
        const runtimeConfig: ProbeConfig = {
          id: latestProbe.id,
          clientId: latestProbe.clientId,
          integrationId: latestProbe.integrationId,
          name: latestProbe.name,
          toolName: latestProbe.toolName,
          toolParams: (latestProbe.toolParams as Record<string, unknown>) ?? {},
          cronExpression: latestProbe.cronExpression,
          scheduleHour: latestProbe.scheduleHour,
          scheduleMinute: latestProbe.scheduleMinute,
          scheduleDaysOfWeek: latestProbe.scheduleDaysOfWeek,
          scheduleTimezone: latestProbe.scheduleTimezone,
          category: latestProbe.category,
          action: latestProbe.action,
          actionConfig: latestProbe.actionConfig as Record<string, unknown> | null,
          retentionDays: latestProbe.retentionDays,
          retentionMaxRuns: latestProbe.retentionMaxRuns,
        };
        await executeProbe(runtimeConfig, this.deps);

        // DST re-check: recompute UTC cron after execution and reschedule immediately if changed
        if (latestProbe.scheduleTimezone && latestProbe.scheduleHour != null && latestProbe.scheduleMinute != null) {
          let nextCron: string | undefined;
          try {
            nextCron = buildUtcCron({
              hour: latestProbe.scheduleHour,
              minute: latestProbe.scheduleMinute,
              daysOfWeek: latestProbe.scheduleDaysOfWeek,
              timezone: latestProbe.scheduleTimezone,
            });
          } catch (err) {
            logger.warn({ err, probeId, timezone: latestProbe.scheduleTimezone }, 'DST re-check: buildUtcCron failed');
          }
          if (nextCron && nextCron !== latestProbe.cronExpression) {
            logger.info(
              { probeId, oldCron: latestProbe.cronExpression, newCron: nextCron, timezone: latestProbe.scheduleTimezone },
              'DST adjustment detected — updating cron expression and rescheduling immediately',
            );
            await this.deps.db.scheduledProbe.update({
              where: { id: probeId },
              data: { cronExpression: nextCron },
            });
            // Stop the current task and reschedule immediately with the new cron
            const currentTask = this.tasks.get(probeId);
            if (currentTask) {
              currentTask.stop();
              this.tasks.delete(probeId);
              this.taskCrons.delete(probeId);
            }
            if (cron.validate(nextCron)) {
              this.scheduleProbeTask(probeId, nextCron);
            }
          }
        }
      } catch (err) {
        logger.error({ err, probeId }, 'Probe execution failed');
      } finally {
        this.runningProbes.delete(probeId);
      }
    });

    this.tasks.set(probeId, task);
    this.taskCrons.set(probeId, cronExpression);
  }
}
