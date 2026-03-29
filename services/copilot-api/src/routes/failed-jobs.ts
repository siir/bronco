import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';

interface FailedJobRouteOpts {
  queueMap: Map<string, Queue>;
}

export async function failedJobRoutes(fastify: FastifyInstance, opts: FailedJobRouteOpts): Promise<void> {
  const { queueMap } = opts;
  const validQueues = [...queueMap.keys()];

  // List failed jobs across all queues (or filtered by queue)
  fastify.get<{ Querystring: { queue?: string; limit?: number; offset?: number } }>(
    '/api/failed-jobs',
    async (request) => {
      const { queue } = request.query;

      // Coerce and clamp pagination parameters since Fastify query params are strings at runtime
      const rawLimit = (request.query as { limit?: unknown }).limit;
      const rawOffset = (request.query as { offset?: unknown }).offset;

      let limit = Number(rawLimit ?? 50);
      let offset = Number(rawOffset ?? 0);

      if (!Number.isFinite(limit) || limit <= 0) {
        limit = 50;
      } else if (limit > 500) {
        limit = 500;
      }

      if (!Number.isFinite(offset) || offset < 0) {
        offset = 0;
      }

      const queuesToQuery = queue
        ? (queueMap.has(queue) ? [queue] : [])
        : validQueues;

      if (queuesToQuery.length === 0) {
        return { jobs: [], total: 0 };
      }

      // Get per-queue counts and jobs in parallel.
      // For each queue, fetch at most (offset + limit) jobs — no single queue
      // can contribute more than that to the first (offset + limit) positions
      // of the merged sorted result, so this bounds memory without skipping jobs.
      const fetchCount = offset + limit;
      const results = await Promise.all(
        queuesToQuery.map(async (qName) => {
          const q = queueMap.get(qName)!;
          const [count, failed] = await Promise.all([
            q.getFailedCount(),
            q.getFailed(0, fetchCount - 1),
          ]);
          return { qName, count, failed };
        }),
      );

      const allJobs: Array<{
        id: string;
        queue: string;
        name: string;
        data: unknown;
        failedReason: string;
        attemptsMade: number;
        maxAttempts: number;
        timestamp: number;
        processedOn: number | undefined;
        finishedOn: number | undefined;
        stacktrace: string[];
      }> = [];

      let total = 0;
      for (const { qName, count, failed } of results) {
        total += count;
        for (const job of failed) {
          if (job.id === undefined || job.id === null) continue;
          allJobs.push({
            id: String(job.id),
            queue: qName,
            name: job.name,
            data: job.data,
            failedReason: job.failedReason ?? '',
            attemptsMade: job.attemptsMade,
            maxAttempts: job.opts?.attempts ?? 0,
            timestamp: job.timestamp,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn,
            stacktrace: job.stacktrace ?? [],
          });
        }
      }

      // Sort by finishedOn descending (most recently failed first)
      allJobs.sort((a, b) => (b.finishedOn ?? b.timestamp) - (a.finishedOn ?? a.timestamp));

      const paged = allJobs.slice(offset, offset + limit);

      return { jobs: paged, total };
    },
  );

  // Retry a single failed job
  fastify.post<{ Params: { queue: string; jobId: string } }>(
    '/api/failed-jobs/:queue/:jobId/retry',
    async (request, reply) => {
      const { queue: qName, jobId } = request.params;
      const q = queueMap.get(qName);
      if (!q) {
        return reply.code(404).send({ error: `Queue '${qName}' not found` });
      }

      const job = await q.getJob(jobId);
      if (!job) {
        return reply.code(404).send({ error: `Job '${jobId}' not found in queue '${qName}'` });
      }

      const state = await job.getState();
      if (state !== 'failed') {
        return reply.code(400).send({ error: `Job is in '${state}' state, not 'failed'` });
      }

      await job.retry();
      return { retried: true };
    },
  );

  // Retry all failed jobs in a queue
  fastify.post<{ Params: { queue: string } }>(
    '/api/failed-jobs/:queue/retry-all',
    async (request, reply) => {
      const { queue: qName } = request.params;
      const q = queueMap.get(qName);
      if (!q) {
        return reply.code(404).send({ error: `Queue '${qName}' not found` });
      }

      // retryJobs uses cursor-based paging internally — no in-memory load needed
      const failedBefore = await q.getFailedCount();
      await q.retryJobs({ state: 'failed' });
      return { retriedCount: failedBefore, failedCount: 0 };
    },
  );

  // Discard a single failed job
  fastify.delete<{ Params: { queue: string; jobId: string } }>(
    '/api/failed-jobs/:queue/:jobId',
    async (request, reply) => {
      const { queue: qName, jobId } = request.params;
      const q = queueMap.get(qName);
      if (!q) {
        return reply.code(404).send({ error: `Queue '${qName}' not found` });
      }

      const job = await q.getJob(jobId);
      if (!job) {
        return reply.code(404).send({ error: `Job '${jobId}' not found in queue '${qName}'` });
      }

      const state = await job.getState();
      if (state !== 'failed') {
        return reply.code(400).send({ error: `Job is in '${state}' state, not 'failed'` });
      }

      await job.remove();
      return { removed: true };
    },
  );

  // Discard all failed jobs in a queue
  fastify.delete<{ Params: { queue: string } }>(
    '/api/failed-jobs/:queue',
    async (request, reply) => {
      const { queue: qName } = request.params;
      const q = queueMap.get(qName);
      if (!q) {
        return reply.code(404).send({ error: `Queue '${qName}' not found` });
      }

      const removed = await q.clean(0, 1_000_000, 'failed');
      return { removedCount: removed.length };
    },
  );
}
