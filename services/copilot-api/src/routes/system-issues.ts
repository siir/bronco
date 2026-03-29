import type { FastifyInstance } from 'fastify';
import { createLogger } from '@bronco/shared-utils';
import { OPEN_STATUSES, CLOSED_STATUSES } from '@bronco/shared-types';
import { sendRedisCommand } from '../services/redis.js';

const logger = createLogger('system-issues');

interface FailedIssueJob {
  id: string;
  ticketId: string;
  ticketSubject: string;
  clientName: string;
  repoName: string;
  branchName: string;
  error: string | null;
  failedAt: string;
}

interface OpenFinding {
  id: string;
  systemId: string;
  systemName: string;
  clientName: string;
  title: string;
  severity: string;
  category: string;
  description: string;
  status: string;
  detectedAt: string;
}

interface RecentError {
  id: string;
  service: string;
  message: string;
  error: string | null;
  entityId: string | null;
  entityType: string | null;
  createdAt: string;
}

interface FailedQueueInfo {
  queue: string;
  failed: number;
}

interface SystemIssuesResponse {
  timestamp: string;
  totalIssues: number;
  failedIssueJobs: FailedIssueJob[];
  openFindings: OpenFinding[];
  recentErrors: RecentError[];
  failedQueues: FailedQueueInfo[];
}

interface SystemIssuesOpts {
  redisUrl: string;
}

export async function systemIssuesRoutes(
  fastify: FastifyInstance,
  opts: SystemIssuesOpts,
): Promise<void> {
  // GET /api/system-issues — aggregate unresolved issues from automated processes
  fastify.get<{
    Querystring: {
      errorWindowDays?: string;
    };
  }>('/api/system-issues', async (request, reply) => {
    let errorWindowDays = 7;
    if (request.query.errorWindowDays !== undefined) {
      const parsed = Number(request.query.errorWindowDays);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return reply.code(400).send({ error: 'errorWindowDays must be an integer between 1 and 30' });
      }
      errorWindowDays = Math.min(30, Math.max(1, parsed));
    }
    const errorWindowDate = new Date();
    errorWindowDate.setDate(errorWindowDate.getDate() - errorWindowDays);

    const [
      failedJobs,
      openFindings,
      recentErrors,
      failedQueues,
    ] = await Promise.all([
      // 1. Failed issue resolution jobs — only tickets where the LATEST job is FAILED
      // Uses Prisma distinct to get the latest job per ticket directly in the DB.
      // DISTINCT ON (Postgres) requires the distinct column first in ORDER BY,
      // so we order by ticketId then createdAt desc, then re-sort by createdAt.
      (async () => {
        const latestJobs = await fastify.db.issueJob.findMany({
          where: {
            ticket: { status: { in: [...OPEN_STATUSES] } },
          },
          distinct: ['ticketId'],
          select: {
            id: true,
            ticketId: true,
            status: true,
            branchName: true,
            error: true,
            completedAt: true,
            createdAt: true,
            ticket: { select: { subject: true, client: { select: { name: true } } } },
            repo: { select: { name: true } },
          },
          orderBy: [{ ticketId: 'asc' }, { createdAt: 'desc' }],
        });

        return latestJobs
          .filter(job => job.status === 'FAILED')
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 50);
      })(),

      // 2. Open findings (database issues with no resolution)
      fastify.db.finding.findMany({
        where: {
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        },
        select: {
          id: true,
          systemId: true,
          title: true,
          severity: true,
          category: true,
          description: true,
          status: true,
          detectedAt: true,
          system: {
            select: {
              name: true,
              client: { select: { name: true } },
            },
          },
        },
        orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
        take: 50,
      }),

      // 3. Recent error-level application logs not linked to resolved tickets
      fastify.db.appLog.findMany({
        where: {
          level: 'ERROR',
          createdAt: { gte: errorWindowDate },
          OR: [
            { entityId: null },
            {
              entityId: { not: null },
              // We'll filter resolved ticket-type entity errors in post-processing below
            },
          ],
        },
        select: {
          id: true,
          service: true,
          message: true,
          error: true,
          entityId: true,
          entityType: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),

      // 4. BullMQ queue stats (failed jobs)
      getFailedQueueStats(opts.redisUrl),
    ]);

    // Post-process: filter out error logs linked to resolved/closed tickets
    let filteredErrors = recentErrors;
    const ticketEntityIds = [...new Set(recentErrors.filter(e => e.entityId && e.entityType === 'ticket').map(e => e.entityId!))];
    if (ticketEntityIds.length > 0) {
      const resolvedTickets = await fastify.db.ticket.findMany({
        where: {
          id: { in: ticketEntityIds },
          status: { in: [...CLOSED_STATUSES] },
        },
        select: { id: true },
      });
      const resolvedSet = new Set(resolvedTickets.map(t => t.id));
      filteredErrors = recentErrors.filter(e => e.entityType !== 'ticket' || !e.entityId || !resolvedSet.has(e.entityId));
    }

    // Deduplicate errors by service+message (keep most recent)
    const errorMap = new Map<string, typeof filteredErrors[number]>();
    for (const err of filteredErrors) {
      const key = `${err.service}::${err.message}`;
      if (!errorMap.has(key)) {
        errorMap.set(key, err);
      }
    }
    const dedupedErrors = [...errorMap.values()].slice(0, 50);

    const mappedFailedJobs: FailedIssueJob[] = failedJobs.map(j => ({
      id: j.id,
      ticketId: j.ticketId,
      ticketSubject: j.ticket.subject,
      clientName: j.ticket.client.name,
      repoName: j.repo.name,
      branchName: j.branchName,
      error: j.error,
      failedAt: (j.completedAt ?? j.createdAt).toISOString(),
    }));

    const mappedFindings: OpenFinding[] = openFindings.map(f => ({
      id: f.id,
      systemId: f.systemId,
      systemName: f.system.name,
      clientName: f.system.client.name,
      title: f.title,
      severity: f.severity,
      category: f.category,
      description: f.description,
      status: f.status,
      detectedAt: f.detectedAt.toISOString(),
    }));

    const mappedErrors: RecentError[] = dedupedErrors.map(e => ({
      id: e.id,
      service: e.service,
      message: e.message,
      error: e.error,
      entityId: e.entityId,
      entityType: e.entityType,
      createdAt: e.createdAt.toISOString(),
    }));

    const totalIssues =
      mappedFailedJobs.length +
      mappedFindings.length +
      mappedErrors.length +
      failedQueues.filter(q => q.failed > 0).length;

    const response: SystemIssuesResponse = {
      timestamp: new Date().toISOString(),
      totalIssues,
      failedIssueJobs: mappedFailedJobs,
      openFindings: mappedFindings,
      recentErrors: mappedErrors,
      failedQueues,
    };

    logger.debug({ totalIssues }, 'System issues aggregated');
    return response;
  });
}

async function getFailedQueueStats(redisUrl: string): Promise<FailedQueueInfo[]> {
  try {
    const url = new URL(redisUrl);
    const host = url.hostname;
    const port = parseInt(url.port || '6379', 10);

    const queues = ['issue-resolve', 'log-summarize', 'email-ingestion', 'ticket-analysis', 'devops-sync', 'mcp-discovery', 'model-catalog-refresh', 'system-analysis'];
    const commands = queues.map(q => `ZCARD bull:${q}:failed`);

    const response = await sendRedisCommand(host, port, commands);
    const numbers = response.match(/:(\d+)/g)?.map(m => parseInt(m.slice(1), 10)) ?? [];

    return queues
      .map((q, i) => ({ queue: q, failed: numbers[i] ?? 0 }))
      .filter(q => q.failed > 0);
  } catch (err) {
    let safeRedisUrl: string | undefined;
    try { const u = new URL(redisUrl); u.username = ''; u.password = ''; safeRedisUrl = u.toString(); } catch { /* ignore */ }
    logger.warn({ err, redisUrl: safeRedisUrl ?? '[invalid]' }, 'Failed to retrieve failed queue stats from Redis');
    return [];
  }
}
