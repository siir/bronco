import type { FastifyInstance } from 'fastify';
import { EmailClassification, EmailProcessingStatus } from '@bronco/shared-types';

const VALID_CLASSIFICATIONS = new Set<string>(Object.values(EmailClassification));
const VALID_STATUSES = new Set<string>(Object.values(EmailProcessingStatus));

export async function emailLogRoutes(fastify: FastifyInstance): Promise<void> {
  // --- List email processing logs with filtering ---
  fastify.get<{
    Querystring: {
      classification?: string;
      status?: string;
      clientId?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/email-logs', async (request) => {
    const {
      classification,
      status,
      clientId,
      from: fromDate,
      to: toDate,
      limit: rawLimit = '100',
      offset: rawOffset = '0',
    } = request.query;

    const takeNum = Number(rawLimit);
    const skipNum = Number(rawOffset);
    if (!Number.isFinite(takeNum) || !Number.isInteger(takeNum) || takeNum < 0 ||
        !Number.isFinite(skipNum) || !Number.isInteger(skipNum) || skipNum < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }

    const where: Record<string, unknown> = {};

    if (classification) {
      if (!VALID_CLASSIFICATIONS.has(classification)) {
        return fastify.httpErrors.badRequest(
          `Invalid classification "${classification}". Must be one of: ${[...VALID_CLASSIFICATIONS].join(', ')}.`,
        );
      }
      where.classification = classification;
    }

    if (status) {
      if (!VALID_STATUSES.has(status)) {
        return fastify.httpErrors.badRequest(
          `Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(', ')}.`,
        );
      }
      where.status = status;
    }

    if (clientId) where.clientId = clientId;

    if (fromDate || toDate) {
      const receivedAt: Record<string, Date> = {};
      if (fromDate) {
        const d = new Date(fromDate);
        if (Number.isNaN(d.getTime())) return fastify.httpErrors.badRequest('from must be a valid date');
        receivedAt.gte = d;
      }
      if (toDate) {
        const d = new Date(toDate);
        if (Number.isNaN(d.getTime())) return fastify.httpErrors.badRequest('to must be a valid date');
        receivedAt.lte = d;
      }
      where.receivedAt = receivedAt;
    }

    const [logs, total] = await Promise.all([
      fastify.db.emailProcessingLog.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: Math.min(takeNum, 500),
        skip: skipNum,
        select: {
          id: true,
          messageId: true,
          from: true,
          fromName: true,
          subject: true,
          receivedAt: true,
          classification: true,
          status: true,
          clientId: true,
          ticketId: true,
          errorMessage: true,
          processingMs: true,
          createdAt: true,
          client: { select: { id: true, name: true } },
          ticket: { select: { id: true, subject: true } },
        },
      }),
      fastify.db.emailProcessingLog.count({ where }),
    ]);

    return { logs, total };
  });

  // --- Stats summary ---
  fastify.get('/api/email-logs/stats', async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalToday, ticketsCreated, noiseFiltered, failures] = await Promise.all([
      fastify.db.emailProcessingLog.count({
        where: { createdAt: { gte: todayStart } },
      }),
      fastify.db.emailProcessingLog.count({
        where: {
          createdAt: { gte: todayStart },
          classification: EmailClassification.TICKET_WORTHY,
          status: EmailProcessingStatus.PROCESSED,
        },
      }),
      fastify.db.emailProcessingLog.count({
        where: {
          createdAt: { gte: todayStart },
          classification: { in: [EmailClassification.NOISE, EmailClassification.AUTO_REPLY] },
        },
      }),
      fastify.db.emailProcessingLog.count({
        where: {
          createdAt: { gte: todayStart },
          status: EmailProcessingStatus.FAILED,
        },
      }),
    ]);

    return { totalToday, ticketsCreated, noiseFiltered, failures };
  });

  // --- Retry a failed or misclassified email ---
  fastify.post<{ Params: { id: string } }>('/api/email-logs/:id/retry', async (request) => {
    const { id } = request.params;

    const log = await fastify.db.emailProcessingLog.findUnique({ where: { id } });
    if (!log) return fastify.httpErrors.notFound('Email processing log not found');

    if (log.status !== EmailProcessingStatus.FAILED && log.classification !== EmailClassification.NOISE && log.classification !== EmailClassification.AUTO_REPLY) {
      return fastify.httpErrors.badRequest('Only failed or noise-classified emails can be retried');
    }

    // Mark as retried
    await fastify.db.emailProcessingLog.update({
      where: { id },
      data: { status: EmailProcessingStatus.RETRIED },
    });

    return { success: true, message: 'Email marked as retried. Re-processing must be triggered manually via the IMAP worker.' };
  });

  // --- Reclassify an email ---
  fastify.patch<{
    Params: { id: string };
    Body: { classification: string };
  }>('/api/email-logs/:id', async (request) => {
    const { id } = request.params;
    const { classification: newClassification } = request.body as { classification: string };

    if (!newClassification || !VALID_CLASSIFICATIONS.has(newClassification)) {
      return fastify.httpErrors.badRequest(
        `Invalid classification. Must be one of: ${[...VALID_CLASSIFICATIONS].join(', ')}`,
      );
    }

    const log = await fastify.db.emailProcessingLog.findUnique({ where: { id } });
    if (!log) return fastify.httpErrors.notFound('Email processing log not found');

    const updated = await fastify.db.emailProcessingLog.update({
      where: { id },
      data: { classification: newClassification },
    });

    return updated;
  });
}
