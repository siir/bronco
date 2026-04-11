import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Prisma } from '@bronco/db';
import type { ServerDeps } from '../server.js';

export function registerTicketTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_tickets',
    'List tickets with optional filters. Returns summary array with id, ticketNumber, subject, status, priority, category, client name, createdAt, and analysisStatus.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
      status: z.string().optional().describe('Filter by ticket status (OPEN, IN_PROGRESS, WAITING, RESOLVED, CLOSED)'),
      priority: z.string().optional().describe('Filter by priority (LOW, MEDIUM, HIGH, CRITICAL)'),
      category: z.string().optional().describe('Filter by category (DATABASE_PERF, BUG_FIX, FEATURE_REQUEST, SCHEMA_CHANGE, CODE_REVIEW, ARCHITECTURE, GENERAL)'),
      assignedOperatorId: z.string().uuid().optional().describe('Filter by assigned operator ID'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results to return (default 20)'),
      offset: z.number().int().min(0).optional().describe('Offset for pagination'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;
      if (params.status) where.status = params.status;
      if (params.priority) where.priority = params.priority;
      if (params.category) where.category = params.category;
      if (params.assignedOperatorId) where.assignedOperatorId = params.assignedOperatorId;

      const tickets = await db.ticket.findMany({
        where,
        select: {
          id: true,
          ticketNumber: true,
          subject: true,
          status: true,
          priority: true,
          category: true,
          analysisStatus: true,
          createdAt: true,
          client: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: params.limit ?? 20,
        skip: params.offset ?? 0,
      });

      return { content: [{ type: 'text', text: JSON.stringify(tickets, null, 2) }] };
    },
  );

  server.tool(
    'get_ticket',
    'Get full ticket details including events, followers, analysisStatus, sufficiencyStatus, and knowledgeDoc.',
    {
      ticketId: z.string().uuid().describe('The ticket ID'),
    },
    async (params) => {
      const ticket = await db.ticket.findUniqueOrThrow({
        where: { id: params.ticketId },
        include: {
          client: { select: { id: true, name: true, shortCode: true } },
          system: { select: { id: true, name: true, host: true } },
          assignedOperator: { select: { id: true, name: true, email: true } },
          followers: { include: { person: { select: { id: true, name: true, email: true } } } },
          events: { orderBy: { createdAt: 'desc' }, take: 50 },
          pendingActions: { where: { status: 'pending' } },
        },
      });

      return { content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }] };
    },
  );

  server.tool(
    'create_ticket',
    'Create a new ticket for a client.',
    {
      clientId: z.string().uuid().describe('The client ID'),
      subject: z.string().describe('Ticket subject'),
      description: z.string().optional().describe('Ticket description'),
      priority: z.string().optional().describe('Priority (LOW, MEDIUM, HIGH, CRITICAL)'),
      category: z.string().optional().describe('Category (DATABASE_PERF, BUG_FIX, FEATURE_REQUEST, SCHEMA_CHANGE, CODE_REVIEW, ARCHITECTURE, GENERAL)'),
      source: z.string().optional().describe('Ticket source (default MANUAL)'),
    },
    async (params) => {
      let ticket: Awaited<ReturnType<typeof db.ticket.create>>;
      for (let attempt = 0; attempt <= 3; attempt++) {
        const lastTicket = await db.ticket.findFirst({
          where: { clientId: params.clientId, ticketNumber: { gt: 0 } },
          orderBy: { ticketNumber: 'desc' },
          select: { ticketNumber: true },
        });
        const ticketNumber = (lastTicket?.ticketNumber ?? 0) + 1;

        const data: Prisma.TicketUncheckedCreateInput = {
          clientId: params.clientId,
          subject: params.subject,
          ticketNumber,
          ...(params.description && { description: params.description }),
          ...(params.priority && { priority: params.priority as never }),
          ...(params.category && { category: params.category as never }),
          ...(params.source && { source: params.source as never }),
        };

        try {
          ticket = await db.ticket.create({ data });
          break;
        } catch (err: unknown) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 3) {
            continue;
          }
          throw err;
        }
      }
      ticket = ticket!;

      return { content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }] };
    },
  );

  server.tool(
    'update_ticket',
    'Update ticket fields such as status, priority, category, assignedOperatorId, or sufficiencyStatus.',
    {
      ticketId: z.string().uuid().describe('The ticket ID'),
      status: z.string().optional().describe('New status'),
      priority: z.string().optional().describe('New priority'),
      category: z.string().optional().describe('New category'),
      assignedOperatorId: z.string().uuid().optional().describe('Assign to operator ID'),
      sufficiencyStatus: z.string().optional().describe('Sufficiency status (SUFFICIENT, NEEDS_USER_INPUT, INSUFFICIENT)'),
    },
    async (params) => {
      const { ticketId, ...fields } = params;
      const data: Prisma.TicketUncheckedUpdateInput = {};
      if (fields.status !== undefined) data.status = fields.status as never;
      if (fields.priority !== undefined) data.priority = fields.priority as never;
      if (fields.category !== undefined) data.category = fields.category as never;
      if (fields.assignedOperatorId !== undefined) data.assignedOperatorId = fields.assignedOperatorId;
      if (fields.sufficiencyStatus !== undefined) data.sufficiencyStatus = fields.sufficiencyStatus as never;

      const ticket = await db.ticket.update({ where: { id: ticketId }, data });

      return { content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }] };
    },
  );

  server.tool(
    'get_ticket_logs',
    'Get unified app_logs and ai_usage_logs for a ticket in chronological order.',
    {
      ticketId: z.string().uuid().describe('The ticket ID'),
      limit: z.number().int().min(1).max(200).optional().describe('Max entries to return (default 50)'),
    },
    async (params) => {
      const limit = params.limit ?? 50;

      const [appLogs, aiLogs] = await Promise.all([
        db.appLog.findMany({
          where: { entityId: params.ticketId, entityType: 'ticket' },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        db.aiUsageLog.findMany({
          where: { entityId: params.ticketId, entityType: 'ticket' },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            provider: true,
            model: true,
            taskType: true,
            inputTokens: true,
            outputTokens: true,
            durationMs: true,
            costUsd: true,
            createdAt: true,
          },
        }),
      ]);

      const unified = [
        ...appLogs.map((l: { createdAt: Date }) => ({ type: 'app_log', ...l })),
        ...aiLogs.map((l: { createdAt: Date }) => ({ type: 'ai_usage', ...l })),
      ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);

      return { content: [{ type: 'text', text: JSON.stringify(unified, null, 2) }] };
    },
  );

  server.tool(
    'get_ticket_cost',
    'Get total AI cost for a ticket with per-provider breakdown.',
    {
      ticketId: z.string().uuid().describe('The ticket ID'),
    },
    async (params) => {
      const where = { entityId: params.ticketId, entityType: 'ticket' as const };

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

      const byProvider: Record<string, { cost: number; calls: number; inputTokens: number; outputTokens: number }> = {};
      for (const row of grouped) {
        const key = `${row.provider}/${row.model}`;
        byProvider[key] = {
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
            ticketId: params.ticketId,
            totalCost: totals._sum.costUsd ?? 0,
            callCount: totals._count,
            byProvider,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'list_pending_actions',
    'List pending AI recommendations awaiting operator approval.',
    {
      ticketId: z.string().uuid().optional().describe('Filter by ticket ID'),
    },
    async (params) => {
      const where: Record<string, unknown> = { status: 'pending' };
      if (params.ticketId) where.ticketId = params.ticketId;

      const actions = await db.pendingAction.findMany({
        where,
        include: { ticket: { select: { id: true, ticketNumber: true, subject: true } } },
        orderBy: { createdAt: 'desc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(actions, null, 2) }] };
    },
  );

  server.tool(
    'approve_pending_action',
    'Approve a pending AI recommendation.',
    {
      actionId: z.string().uuid().describe('The pending action ID'),
    },
    async (params) => {
      const action = await db.pendingAction.update({
        where: { id: params.actionId },
        data: { status: 'approved', resolvedAt: new Date(), resolvedBy: 'mcp:platform' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(action, null, 2) }] };
    },
  );

  server.tool(
    'dismiss_pending_action',
    'Dismiss a pending AI recommendation.',
    {
      actionId: z.string().uuid().describe('The pending action ID'),
    },
    async (params) => {
      const action = await db.pendingAction.update({
        where: { id: params.actionId },
        data: { status: 'dismissed', resolvedAt: new Date(), resolvedBy: 'mcp:platform' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(action, null, 2) }] };
    },
  );
}
