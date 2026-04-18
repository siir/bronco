import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';
import { OperatorRole } from '@bronco/shared-types';

// Explicit Person select — never expose passwordHash or emailLower to MCP callers.
const PERSON_SELECT = { id: true, name: true, email: true, phone: true, isActive: true } as const;

const OPERATOR_SELECT = {
  id: true,
  personId: true,
  clientId: true,
  role: true,
  notifyEmail: true,
  notifySlack: true,
  slackUserId: true,
  createdAt: true,
  updatedAt: true,
  person: { select: PERSON_SELECT },
} as const;

function flattenOperator(op: {
  id: string;
  personId: string;
  clientId: string | null;
  role: string;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  person: { id: string; name: string; email: string; phone: string | null; isActive: boolean };
}) {
  return {
    id: op.id,
    personId: op.personId,
    name: op.person.name,
    email: op.person.email,
    phone: op.person.phone,
    isActive: op.person.isActive,
    role: op.role,
    clientId: op.clientId,
    notifyEmail: op.notifyEmail,
    notifySlack: op.notifySlack,
    slackUserId: op.slackUserId,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  };
}

export function registerOperatorTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_operators',
    'List all operators with their notification preferences.',
    {
      includeInactive: z.boolean().optional().describe('Include inactive operators (default false)'),
    },
    async (params) => {
      const { includeInactive = false } = params;
      const operators = await db.operator.findMany({
        where: includeInactive ? {} : { person: { isActive: true } },
        select: OPERATOR_SELECT,
        orderBy: { person: { name: 'asc' } },
      });
      return { content: [{ type: 'text', text: JSON.stringify(operators.map(flattenOperator), null, 2) }] };
    },
  );

  server.tool(
    'search_operators',
    'Search operators by name or email. Returns a lightweight projection for UI pickers.',
    {
      q: z.string().min(2).describe('Search query (name or email). Must be at least 2 characters.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20)'),
    },
    async (params) => {
      const { q, limit = 20 } = params;
      const qLower = q.toLowerCase();

      const operators = await db.operator.findMany({
        where: {
          person: {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          },
        },
        select: OPERATOR_SELECT,
        take: limit,
        orderBy: { person: { name: 'asc' } },
      });

      const results = operators.map(flattenOperator).sort((a, b) => {
        const getRank = (u: { name: string; email: string }) => {
          const nameLower = u.name.toLowerCase();
          const emailLower = u.email.toLowerCase();
          if (emailLower === qLower) return 0;
          if (nameLower.startsWith(qLower) || emailLower.startsWith(qLower)) return 1;
          return 2;
        };
        const rankDiff = getRank(a) - getRank(b);
        if (rankDiff !== 0) return rankDiff;
        return a.name.localeCompare(b.name);
      });

      return { content: [{ type: 'text', text: JSON.stringify(results.slice(0, limit), null, 2) }] };
    },
  );

  server.tool(
    'get_operator',
    'Get a single operator by their Operator ID.',
    {
      operatorId: z.string().uuid().describe('Operator ID'),
    },
    async (params) => {
      const operator = await db.operator.findUnique({
        where: { id: params.operatorId },
        select: OPERATOR_SELECT,
      });
      if (!operator) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Operator not found' }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(flattenOperator(operator), null, 2) }] };
    },
  );

  server.tool(
    'create_operator',
    'Create a new operator. If a Person with the given email already exists it is reactivated and promoted; ' +
      'if they already have an Operator record a conflict error is returned.',
    {
      name: z.string().min(1).describe('Full name'),
      email: z.string().email().describe('Email address'),
      role: z.enum([OperatorRole.ADMIN, OperatorRole.STANDARD]).optional().describe('Operator role (default STANDARD)'),
      clientId: z.string().uuid().optional().describe('Scope this operator to a specific client'),
      notifyEmail: z.boolean().optional().describe('Enable email notifications (default true)'),
      notifySlack: z.boolean().optional().describe('Enable Slack notifications (default false)'),
      slackUserId: z.string().optional().describe('Slack user ID'),
    },
    async (params) => {
      const { name, email, role, clientId, notifyEmail, notifySlack, slackUserId } = params;
      const emailLower = email.trim().toLowerCase();

      const existingPerson = await db.person.findUnique({
        where: { emailLower },
        select: { id: true, operator: { select: { id: true } } },
      });

      if (existingPerson?.operator) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'An operator with this email already exists.' }, null, 2) }],
        };
      }

      const trimmedSlackUserId = slackUserId !== undefined ? slackUserId.trim() || null : undefined;

      const operator = await db.$transaction(async (tx) => {
        const person = existingPerson
          ? await tx.person.update({
              where: { id: existingPerson.id },
              // Reactivate Person on promotion — isActive is the master auth switch.
              data: { name: name.trim(), isActive: true },
            })
          : await tx.person.create({
              data: { email: email.trim(), emailLower, name: name.trim() },
            });

        return tx.operator.create({
          data: {
            personId: person.id,
            ...(role !== undefined && { role }),
            ...(clientId !== undefined && { clientId }),
            ...(notifyEmail !== undefined && { notifyEmail }),
            ...(notifySlack !== undefined && { notifySlack }),
            ...(trimmedSlackUserId !== undefined && { slackUserId: trimmedSlackUserId }),
          },
          select: OPERATOR_SELECT,
        });
      });

      return { content: [{ type: 'text', text: JSON.stringify(flattenOperator(operator), null, 2) }] };
    },
  );

  server.tool(
    'update_operator',
    'Update operator fields: name, role, clientId, Slack user ID, or notification preferences.',
    {
      operatorId: z.string().uuid().describe('Operator ID'),
      name: z.string().optional().describe('New name'),
      role: z.enum([OperatorRole.ADMIN, OperatorRole.STANDARD]).optional().describe('New role'),
      clientId: z.string().uuid().nullable().optional().describe('Assign or clear client scope (null to clear)'),
      slackUserId: z.string().nullable().optional().describe('Slack user ID (null to clear)'),
      notifyEmail: z.boolean().optional().describe('Enable email notifications'),
      notifySlack: z.boolean().optional().describe('Enable Slack notifications'),
    },
    async (params) => {
      const { operatorId, name, role, clientId, slackUserId, notifyEmail, notifySlack } = params;

      const target = await db.operator.findUnique({
        where: { id: operatorId },
        select: { personId: true },
      });
      if (!target) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Operator not found' }, null, 2) }] };
      }

      const trimmedSlackUserId =
        slackUserId !== undefined
          ? typeof slackUserId === 'string'
            ? slackUserId.trim() || null
            : null
          : undefined;

      const result = await db.$transaction(async (tx) => {
        if (name !== undefined) {
          await tx.person.update({ where: { id: target.personId }, data: { name: name.trim() } });
        }

        return tx.operator.update({
          where: { id: operatorId },
          data: {
            ...(role !== undefined && { role }),
            ...(clientId !== undefined && { clientId }),
            ...(trimmedSlackUserId !== undefined && { slackUserId: trimmedSlackUserId }),
            ...(notifyEmail !== undefined && { notifyEmail }),
            ...(notifySlack !== undefined && { notifySlack }),
          },
          select: OPERATOR_SELECT,
        });
      });

      return { content: [{ type: 'text', text: JSON.stringify(flattenOperator(result), null, 2) }] };
    },
  );

  server.tool(
    'delete_operator',
    'Remove operator access. If the Person has no remaining ClientUser associations they are also deactivated.',
    {
      operatorId: z.string().uuid().describe('Operator ID'),
    },
    async (params) => {
      const { operatorId } = params;

      const target = await db.operator.findUnique({
        where: { id: operatorId },
        select: { personId: true },
      });
      if (!target) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Operator not found' }, null, 2) }] };
      }

      await db.$transaction(async (tx) => {
        await tx.operator.delete({ where: { id: operatorId } });

        // Revoke operator refresh tokens so existing sessions are invalidated.
        await tx.personRefreshToken.updateMany({
          where: { personId: target.personId, accessType: 'OPERATOR', revokedAt: null },
          data: { revokedAt: new Date() },
        });

        // If the Person has no remaining ClientUser records they have no way to
        // authenticate — deactivate them so isActive is accurate.
        const remaining = await tx.person.findUnique({
          where: { id: target.personId },
          select: { _count: { select: { clientUsers: true } } },
        });
        if (remaining && remaining._count.clientUsers === 0) {
          await tx.person.update({ where: { id: target.personId }, data: { isActive: false } });
        }
      });

      return { content: [{ type: 'text', text: JSON.stringify({ message: 'Operator deleted.' }, null, 2) }] };
    },
  );
}
