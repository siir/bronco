import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Prisma } from '@bronco/db';
import { ToolRequestStatus } from '@bronco/shared-types';
import type { ServerDeps } from '../server.js';

const STATUS_VALUES = Object.values(ToolRequestStatus) as [string, ...string[]];

export function registerToolRequestTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_tool_requests',
    'List agent-flagged tool requests (missing capability registry). Filterable by client and status.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
      status: z
        .array(z.enum(STATUS_VALUES))
        .optional()
        .describe('Filter by status values'),
    },
    async (params) => {
      const where: Prisma.ToolRequestWhereInput = {};
      if (params.clientId) where.clientId = params.clientId;
      if (params.status && params.status.length > 0) {
        where.status = { in: params.status as ToolRequestStatus[] };
      }

      const rows = await db.toolRequest.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      });

      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'get_tool_request',
    'Get a single tool request with its rationale history and duplicates.',
    {
      id: z.string().uuid().describe('Tool request ID'),
    },
    async (params) => {
      const row = await db.toolRequest.findUnique({
        where: { id: params.id },
        include: {
          rationales: { orderBy: { createdAt: 'desc' } },
          duplicates: { select: { id: true, requestedName: true, status: true } },
        },
      });
      if (!row) {
        return {
          isError: true,
          content: [{ type: 'text', text: `ERROR: tool request ${params.id} not found` }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    },
  );

  server.tool(
    'update_tool_request',
    'Update a tool request. On PROPOSED → APPROVED the approvedAt timestamp is set automatically (approvedBy stays null from the MCP path — set via REST).',
    {
      id: z.string().uuid().describe('Tool request ID'),
      status: z.enum(STATUS_VALUES).optional().describe('New status'),
      rejectedReason: z.string().optional().describe('Required when setting status to REJECTED'),
      duplicateOfId: z
        .string()
        .uuid()
        .optional()
        .describe('Required when setting status to DUPLICATE — the canonical ToolRequest ID'),
      implementedInCommit: z.string().optional().describe('Git commit SHA that implemented the tool'),
      implementedInIssue: z.string().optional().describe('GitHub issue number that tracked the work'),
      githubIssueUrl: z.string().url().optional().describe('Full URL to the GitHub issue'),
    },
    async (params) => {
      const existing = await db.toolRequest.findUnique({
        where: { id: params.id },
        select: { status: true },
      });
      if (!existing) {
        return {
          isError: true,
          content: [{ type: 'text', text: `ERROR: tool request ${params.id} not found` }],
        };
      }

      const data: Prisma.ToolRequestUpdateInput = {};
      if (params.status) {
        data.status = params.status as ToolRequestStatus;
        if (params.status === ToolRequestStatus.APPROVED && existing.status === ToolRequestStatus.PROPOSED) {
          data.approvedAt = new Date();
        }
      }
      if (params.rejectedReason !== undefined) data.rejectedReason = params.rejectedReason;
      if (params.duplicateOfId !== undefined) {
        data.duplicateOf = { connect: { id: params.duplicateOfId } };
      }
      if (params.implementedInCommit !== undefined) data.implementedInCommit = params.implementedInCommit;
      if (params.implementedInIssue !== undefined) data.implementedInIssue = params.implementedInIssue;
      if (params.githubIssueUrl !== undefined) data.githubIssueUrl = params.githubIssueUrl;

      const updated = await db.toolRequest.update({ where: { id: params.id }, data });
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    },
  );

  server.tool(
    'delete_tool_request',
    'Hard-delete a tool request (including its rationale history via cascade).',
    {
      id: z.string().uuid().describe('Tool request ID'),
    },
    async (params) => {
      await db.toolRequest.delete({ where: { id: params.id } });
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, id: params.id }) }] };
    },
  );
}
