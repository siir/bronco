import type { FastifyInstance } from 'fastify';
import type { AIRouter } from '@bronco/ai-provider';
import { AttentionLevel } from '@bronco/shared-types';
import { summarizeTicketLogs, runSummarizationPass } from '../services/log-summarizer.js';

const VALID_TYPES = new Set(['ticket', 'orphan', 'service', 'uncategorized']);
const VALID_ATTENTION_LEVELS = new Set(Object.values(AttentionLevel));

interface LogSummaryRouteOpts {
  ai: AIRouter;
}

export async function logSummaryRoutes(fastify: FastifyInstance, opts: LogSummaryRouteOpts): Promise<void> {
  const { ai } = opts;

  // List log summaries with filters
  fastify.get<{
    Querystring: {
      ticketId?: string;
      type?: string; // "ticket" | "orphan" | "service" | "uncategorized"
      attentionLevel?: string; // "NONE" | "LOW" | "MEDIUM" | "HIGH"
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/log-summaries', async (request) => {
    const {
      ticketId,
      type,
      attentionLevel,
      since,
      until,
      limit: rawLimit = '50',
      offset: rawOffset = '0',
    } = request.query;

    const take = Math.trunc(Number(rawLimit));
    const skip = Math.trunc(Number(rawOffset));
    if (!Number.isFinite(take) || take < 0 || !Number.isFinite(skip) || skip < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }

    const where: Record<string, unknown> = {};

    if (ticketId) {
      where.ticketId = ticketId;
    }
    if (type && VALID_TYPES.has(type.toLowerCase())) {
      where.summaryType = type.toUpperCase();
    }
    if (attentionLevel && VALID_ATTENTION_LEVELS.has(attentionLevel.toUpperCase() as AttentionLevel)) {
      where.attentionLevel = attentionLevel.toUpperCase();
    }

    if (since || until) {
      const windowStart: Record<string, Date> = {};
      if (since) {
        const sinceDate = new Date(since);
        if (Number.isNaN(sinceDate.getTime())) {
          return fastify.httpErrors.badRequest('since must be a valid date');
        }
        windowStart.gte = sinceDate;
      }
      if (until) {
        const untilDate = new Date(until);
        if (Number.isNaN(untilDate.getTime())) {
          return fastify.httpErrors.badRequest('until must be a valid date');
        }
        windowStart.lte = untilDate;
      }
      where.windowStart = windowStart;
    }

    const [summaries, total] = await Promise.all([
      fastify.db.logSummary.findMany({
        where,
        orderBy: { windowStart: 'desc' },
        take: Math.min(take, 200),
        skip,
      }),
      fastify.db.logSummary.count({ where }),
    ]);

    return { summaries, total };
  });

  // On-demand: summarize logs for a specific ticket
  fastify.post<{
    Body: { ticketId: string };
  }>('/api/log-summaries/generate-ticket', async (request, reply) => {
    const { ticketId } = request.body;
    if (!ticketId) {
      return fastify.httpErrors.badRequest('ticketId is required');
    }

    const result = await summarizeTicketLogs(fastify.db, ai, ticketId);
    reply.code(201);
    return result;
  });

  // On-demand: run a full summarization pass (all types)
  fastify.post('/api/log-summaries/generate', async (_request, reply) => {
    const result = await runSummarizationPass(fastify.db, ai);
    reply.code(201);
    return result;
  });
}
