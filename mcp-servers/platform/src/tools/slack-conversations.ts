import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerSlackConversationTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_slack_conversations',
    'List Hugo Slack conversation logs with optional filters.',
    {
      operatorId: z.string().uuid().optional().describe('Filter by operator ID'),
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
      startDate: z.string().optional().describe('Start date (ISO 8601)'),
      endDate: z.string().optional().describe('End date (ISO 8601)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max entries (default 20)'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.operatorId) where.operatorId = params.operatorId;
      if (params.clientId) where.clientId = params.clientId;
      if (params.startDate || params.endDate) {
        const createdAt: Record<string, Date> = {};
        if (params.startDate) {
          const d = new Date(params.startDate);
          if (Number.isNaN(d.getTime())) {
            return { content: [{ type: 'text', text: `Invalid startDate: "${params.startDate}". Use ISO 8601 format (e.g. 2024-01-01T00:00:00Z).` }], isError: true };
          }
          createdAt.gte = d;
        }
        if (params.endDate) {
          const d = new Date(params.endDate);
          if (Number.isNaN(d.getTime())) {
            return { content: [{ type: 'text', text: `Invalid endDate: "${params.endDate}". Use ISO 8601 format (e.g. 2024-12-31T23:59:59Z).` }], isError: true };
          }
          createdAt.lte = d;
        }
        where.createdAt = createdAt;
      }

      const conversations = await db.slackConversationLog.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: params.limit ?? 20,
        select: {
          id: true,
          channelId: true,
          threadTs: true,
          messageCount: true,
          totalCost: true,
          totalInputTokens: true,
          totalOutputTokens: true,
          createdAt: true,
          updatedAt: true,
          operator: { select: { id: true, name: true } },
          client: { select: { id: true, name: true, shortCode: true } },
        },
      });

      return { content: [{ type: 'text', text: JSON.stringify(conversations, null, 2) }] };
    },
  );

  server.tool(
    'get_slack_conversation',
    'Get full details of a Hugo Slack conversation including messages and tool calls.',
    {
      id: z.string().uuid().describe('Conversation log ID'),
    },
    async (params) => {
      const conversation = await db.slackConversationLog.findUnique({
        where: { id: params.id },
        include: {
          operator: { select: { id: true, name: true } },
          client: { select: { id: true, name: true, shortCode: true } },
        },
      });

      if (!conversation) {
        return { content: [{ type: 'text', text: 'Conversation not found' }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify(conversation, null, 2) }] };
    },
  );
}
