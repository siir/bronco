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
      startDate: z.string().optional().describe('Start date (ISO 8601)'),
      endDate: z.string().optional().describe('End date (ISO 8601)'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;
      if (params.startDate || params.endDate) {
        const createdAt: Record<string, Date> = {};
        if (params.startDate) createdAt.gte = new Date(params.startDate);
        if (params.endDate) createdAt.lte = new Date(params.endDate);
        where.createdAt = createdAt;
      }

      const logs = await db.aiUsageLog.findMany({
        where,
        select: { provider: true, model: true, costUsd: true, inputTokens: true, outputTokens: true },
      });

      let totalCost = 0;
      let totalCalls = 0;
      const byProviderModel: Record<string, { cost: number; calls: number; inputTokens: number; outputTokens: number }> = {};

      for (const log of logs) {
        const cost = log.costUsd ?? 0;
        totalCost += cost;
        totalCalls += 1;
        const key = `${log.provider}/${log.model}`;
        if (!byProviderModel[key]) byProviderModel[key] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
        byProviderModel[key].cost += cost;
        byProviderModel[key].calls += 1;
        byProviderModel[key].inputTokens += log.inputTokens;
        byProviderModel[key].outputTokens += log.outputTokens;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ totalCost, totalCalls, byProviderModel }, null, 2),
        }],
      };
    },
  );
}
