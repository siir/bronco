import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerAiUsageTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'get_ai_usage',
    'Get AI usage log entries with optional filters by client, ticket, date range.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
      ticketId: z.string().uuid().optional().describe('Filter by ticket ID (entityId)'),
      startDate: z.string().optional().describe('Start date (ISO 8601)'),
      endDate: z.string().optional().describe('End date (ISO 8601)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max entries (default 50)'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;
      if (params.ticketId) {
        where.entityId = params.ticketId;
        where.entityType = 'ticket';
      }
      if (params.startDate || params.endDate) {
        const createdAt: Record<string, Date> = {};
        if (params.startDate) createdAt.gte = new Date(params.startDate);
        if (params.endDate) createdAt.lte = new Date(params.endDate);
        where.createdAt = createdAt;
      }

      const logs = await db.aiUsageLog.findMany({
        where,
        select: {
          id: true,
          provider: true,
          model: true,
          taskType: true,
          inputTokens: true,
          outputTokens: true,
          durationMs: true,
          costUsd: true,
          entityId: true,
          entityType: true,
          clientId: true,
          billingMode: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: params.limit ?? 50,
      });

      return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
    },
  );

  server.tool(
    'get_ai_cost_summary',
    'Get aggregate AI cost by provider and model for a date range.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
      startDate: z.string().datetime().optional().describe('Start date (ISO 8601)'),
      endDate: z.string().datetime().optional().describe('End date (ISO 8601)'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;
      if (params.startDate || params.endDate) {
        const createdAt: Record<string, Date> = {};
        if (params.startDate) {
          const d = new Date(params.startDate);
          if (isNaN(d.getTime())) throw new Error(`Invalid startDate: ${params.startDate}`);
          createdAt.gte = d;
        }
        if (params.endDate) {
          const d = new Date(params.endDate);
          if (isNaN(d.getTime())) throw new Error(`Invalid endDate: ${params.endDate}`);
          createdAt.lte = d;
        }
        where.createdAt = createdAt;
      }

      const [totals, grouped] = await Promise.all([
        db.aiUsageLog.aggregate({
          where,
          _sum: { costUsd: true, inputTokens: true, outputTokens: true },
          _count: true,
        }),
        db.aiUsageLog.groupBy({
          by: ['provider', 'model'],
          where,
          _sum: { costUsd: true, inputTokens: true, outputTokens: true },
          _count: true,
        }),
      ]);

      const byProviderModel: Record<string, { cost: number; calls: number; inputTokens: number; outputTokens: number }> = {};
      for (const row of grouped) {
        const key = `${row.provider}/${row.model}`;
        byProviderModel[key] = {
          cost: row._sum.costUsd ?? 0,
          calls: row._count,
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            totalCost: totals._sum.costUsd ?? 0,
            totalCalls: totals._count,
            byProviderModel,
          }, null, 2),
        }],
      };
    },
  );
}
