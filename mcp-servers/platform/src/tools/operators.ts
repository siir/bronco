import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

// TODO: #219 Wave 2B — rework against the unified Person + Operator model.
// Wave 1 keeps the MCP surface working by joining Operator → Person for
// the identity fields (name/email/isActive) and accepting name updates on
// Person transparently.
export function registerOperatorTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_operators',
    'List all operators with their notification preferences.',
    {},
    async () => {
      const operators = await db.operator.findMany({
        include: { person: { select: { email: true, name: true, isActive: true } } },
        orderBy: { person: { name: 'asc' } },
      });
      const out = operators.map((op) => ({
        id: op.id,
        email: op.person.email,
        name: op.person.name,
        isActive: op.person.isActive,
        notifyEmail: op.notifyEmail,
        notifySlack: op.notifySlack,
        slackUserId: op.slackUserId,
        role: op.role,
        clientId: op.clientId,
        createdAt: op.createdAt,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
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
      const { operatorId, name, slackUserId, notifyEmail, notifySlack } = params;

      const result = await db.$transaction(async (tx) => {
        const target = await tx.operator.findUnique({ where: { id: operatorId } });
        if (!target) throw new Error(`Operator ${operatorId} not found`);

        if (name !== undefined) {
          await tx.person.update({ where: { id: target.personId }, data: { name } });
        }

        return tx.operator.update({
          where: { id: operatorId },
          data: {
            ...(slackUserId !== undefined && { slackUserId }),
            ...(notifyEmail !== undefined && { notifyEmail }),
            ...(notifySlack !== undefined && { notifySlack }),
          },
          include: { person: { select: { email: true, name: true, isActive: true } } },
        });
      });

      const out = {
        id: result.id,
        email: result.person.email,
        name: result.person.name,
        isActive: result.person.isActive,
        notifyEmail: result.notifyEmail,
        notifySlack: result.notifySlack,
        slackUserId: result.slackUserId,
        role: result.role,
        clientId: result.clientId,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  );
}
