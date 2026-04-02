import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerOperatorTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_operators',
    'List all operators with their notification preferences.',
    {},
    async () => {
      const operators = await db.operator.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          notifyEmail: true,
          notifySlack: true,
          slackUserId: true,
          createdAt: true,
        },
        orderBy: { name: 'asc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(operators, null, 2) }] };
    },
  );

  server.tool(
    'update_operator',
    'Update operator fields such as name, Slack user ID, or notification preferences.',
    {
      operatorId: z.string().uuid().describe('The operator ID'),
      name: z.string().optional().describe('New name'),
      slackUserId: z.string().optional().describe('Slack user ID'),
      notifyEmail: z.boolean().optional().describe('Enable email notifications'),
      notifySlack: z.boolean().optional().describe('Enable Slack notifications'),
    },
    async (params) => {
      const { operatorId, ...fields } = params;
      const data: Record<string, unknown> = {};
      if (fields.name !== undefined) data.name = fields.name;
      if (fields.slackUserId !== undefined) data.slackUserId = fields.slackUserId;
      if (fields.notifyEmail !== undefined) data.notifyEmail = fields.notifyEmail;
      if (fields.notifySlack !== undefined) data.notifySlack = fields.notifySlack;

      const operator = await db.operator.update({ where: { id: operatorId }, data });
      return { content: [{ type: 'text', text: JSON.stringify(operator, null, 2) }] };
    },
  );
}
