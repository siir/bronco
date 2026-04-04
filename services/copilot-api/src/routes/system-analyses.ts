import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { SystemAnalysisStatus } from '@bronco/shared-types';

const VALID_STATUSES: Set<string> = new Set(Object.values(SystemAnalysisStatus));

interface SystemAnalysisRouteOpts {
  systemAnalysisQueue: Queue;
}

export async function systemAnalysisRoutes(
  fastify: FastifyInstance,
  opts: SystemAnalysisRouteOpts,
): Promise<void> {
  // GET /api/system-analyses — list analyses with optional filters
  fastify.get<{
    Querystring: {
      status?: string;
      clientId?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/system-analyses', async (request) => {
    const {
      status,
      clientId,
      limit: rawLimit = '50',
      offset: rawOffset = '0',
    } = request.query;

    const take = Math.min(Math.trunc(Number(rawLimit)), 200);
    const skip = Math.trunc(Number(rawOffset));
    if (!Number.isFinite(take) || take < 0 || !Number.isFinite(skip) || skip < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }

    if (status && !VALID_STATUSES.has(status)) {
      return fastify.httpErrors.badRequest(`Invalid status: ${status}`);
    }

    const where = {
      ...(status && { status: status as SystemAnalysisStatus }),
      ...(clientId && { clientId }),
    };

    const [total, analyses] = await Promise.all([
      fastify.db.systemAnalysis.count({ where }),
      fastify.db.systemAnalysis.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
    ]);

    return { analyses, total };
  });

  // GET /api/system-analyses/stats — counts by status
  fastify.get('/api/system-analyses/stats', async () => {
    const byStatus = await fastify.db.systemAnalysis.groupBy({
      by: ['status'],
      _count: true,
    });

    const stats: Record<string, number> = {};
    for (const row of byStatus) {
      stats[row.status] = row._count;
    }
    return { byStatus: stats, total: Object.values(stats).reduce((a, b) => a + b, 0) };
  });

  // GET /api/system-analyses/context — summaries of pending + rejected analyses for AI dedup
  fastify.get<{
    Querystring: { clientId: string };
  }>('/api/system-analyses/context', async (request) => {
    const { clientId } = request.query;
    if (!clientId) {
      return fastify.httpErrors.badRequest('clientId query parameter is required');
    }

    const [pending, rejected] = await Promise.all([
      fastify.db.systemAnalysis.findMany({
        where: { status: SystemAnalysisStatus.PENDING, clientId },
        select: { id: true, suggestions: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      fastify.db.systemAnalysis.findMany({
        where: { status: SystemAnalysisStatus.REJECTED, clientId },
        select: { id: true, suggestions: true, rejectionReason: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return { pending, rejected };
  });

  // GET /api/system-analyses/:id — single analysis
  fastify.get<{ Params: { id: string } }>(
    '/api/system-analyses/:id',
    async (request) => {
      const analysis = await fastify.db.systemAnalysis.findUnique({
        where: { id: request.params.id },
      });
      if (!analysis) return fastify.httpErrors.notFound('Analysis not found');
      return analysis;
    },
  );

  // PATCH /api/system-analyses/:id/acknowledge — mark as acknowledged
  fastify.patch<{ Params: { id: string } }>(
    '/api/system-analyses/:id/acknowledge',
    async (request) => {
      const existing = await fastify.db.systemAnalysis.findUnique({
        where: { id: request.params.id },
        select: { status: true },
      });
      if (!existing) return fastify.httpErrors.notFound('Analysis not found');
      if (existing.status !== 'PENDING') {
        return fastify.httpErrors.badRequest(`Cannot acknowledge analysis in ${existing.status} status`);
      }

      return fastify.db.systemAnalysis.update({
        where: { id: request.params.id },
        data: { status: 'ACKNOWLEDGED' },
      });
    },
  );

  // PATCH /api/system-analyses/:id/reject — mark as rejected with reason
  fastify.patch<{
    Params: { id: string };
    Body: { reason: string };
  }>(
    '/api/system-analyses/:id/reject',
    async (request) => {
      const { reason } = (request.body ?? {}) as { reason?: string };
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return fastify.httpErrors.badRequest('Rejection reason is required');
      }

      const existing = await fastify.db.systemAnalysis.findUnique({
        where: { id: request.params.id },
        select: { status: true },
      });
      if (!existing) return fastify.httpErrors.notFound('Analysis not found');
      if (existing.status !== 'PENDING') {
        return fastify.httpErrors.badRequest(`Cannot reject analysis in ${existing.status} status`);
      }

      return fastify.db.systemAnalysis.update({
        where: { id: request.params.id },
        data: { status: 'REJECTED', rejectionReason: reason.trim() },
      });
    },
  );

  // POST /api/system-analyses/:id/regenerate — re-run analysis for a ticket
  fastify.post<{ Params: { id: string } }>(
    '/api/system-analyses/:id/regenerate',
    async (request, reply) => {
      const existing = await fastify.db.systemAnalysis.findUnique({
        where: { id: request.params.id },
        select: { ticketId: true },
      });
      if (!existing) return fastify.httpErrors.notFound('Analysis not found');

      await opts.systemAnalysisQueue.add(
        'analyze-ticket-closure',
        { ticketId: existing.ticketId },
        { jobId: `regen-${existing.ticketId}-${Date.now()}` },
      );

      reply.code(202);
      return { message: 'Analysis regeneration queued' };
    },
  );

  // PATCH /api/system-analyses/:id/reopen — reset to PENDING so it can be re-reviewed
  fastify.patch<{ Params: { id: string } }>(
    '/api/system-analyses/:id/reopen',
    async (request) => {
      const existing = await fastify.db.systemAnalysis.findUnique({
        where: { id: request.params.id },
        select: { status: true },
      });
      if (!existing) return fastify.httpErrors.notFound('Analysis not found');
      if (existing.status === 'PENDING') {
        return fastify.httpErrors.badRequest('Analysis is already pending');
      }

      return fastify.db.systemAnalysis.update({
        where: { id: request.params.id },
        data: { status: 'PENDING', rejectionReason: null },
      });
    },
  );

  // DELETE /api/system-analyses/:id — permanently delete an analysis
  fastify.delete<{ Params: { id: string } }>(
    '/api/system-analyses/:id',
    async (request, reply) => {
      const existing = await fastify.db.systemAnalysis.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!existing) return fastify.httpErrors.notFound('Analysis not found');

      await fastify.db.systemAnalysis.delete({ where: { id: request.params.id } });
      reply.code(204);
    },
  );
}
