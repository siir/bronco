import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Prisma } from '@bronco/db';
import { ToolRequestKind, ToolRequestStatus } from '@bronco/shared-types';
import { createToolRequestGithubIssue } from '@bronco/shared-utils';
import type { ServerDeps } from '../server.js';

const STATUS_VALUES = Object.values(ToolRequestStatus) as [string, ...string[]];
const KIND_VALUES = Object.values(ToolRequestKind) as [string, ...string[]];

export function registerToolRequestTools(server: McpServer, { db, config }: ServerDeps): void {
  server.tool(
    'list_tool_requests',
    'List agent-flagged tool requests (missing capability registry). Filterable by client, status, and kind.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
      status: z
        .array(z.enum(STATUS_VALUES))
        .optional()
        .describe('Filter by status values'),
      kind: z
        .array(z.enum(KIND_VALUES))
        .optional()
        .describe('Filter by kind values (NEW_TOOL, BROKEN_TOOL, IMPROVE_TOOL)'),
    },
    async (params) => {
      const where: Prisma.ToolRequestWhereInput = {};
      if (params.clientId) where.clientId = params.clientId;
      if (params.status && params.status.length > 0) {
        where.status = { in: params.status as ToolRequestStatus[] };
      }
      if (params.kind && params.kind.length > 0) {
        where.kind = { in: params.kind as ToolRequestKind[] };
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
      kind: z.enum(KIND_VALUES).optional().describe('Correct the kind if the agent labeled it wrong (NEW_TOOL, BROKEN_TOOL, IMPROVE_TOOL)'),
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

      // Mirror the REST API's transition validation so invalid state combos
      // can't slip through via MCP (Copilot #3118042139). The REST handler in
      // services/copilot-api/src/routes/tool-requests.ts enforces these same
      // invariants.
      if (params.status === ToolRequestStatus.REJECTED && !params.rejectedReason) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'ERROR: rejectedReason is required when setting status to REJECTED' }],
        };
      }
      if (params.status === ToolRequestStatus.DUPLICATE && !params.duplicateOfId) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'ERROR: duplicateOfId is required when setting status to DUPLICATE' }],
        };
      }

      const data: Prisma.ToolRequestUpdateInput = {};
      if (params.status) {
        data.status = params.status as ToolRequestStatus;
        if (params.status === ToolRequestStatus.APPROVED && existing.status === ToolRequestStatus.PROPOSED) {
          data.approvedAt = new Date();
        }
      }
      if (params.kind !== undefined) data.kind = params.kind as ToolRequestKind;
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

  server.tool(
    'run_tool_request_dedupe',
    'Run the admin dedupe agent for a client: diffs PROPOSED/APPROVED tool requests against the live MCP tool catalog and populates suggestion fields (suggestedDuplicate*, suggestedImproves*) transactionally. Admin-only.',
    {
      clientId: z.string().uuid().describe('Client ID to run dedupe analysis for'),
    },
    async (params) => {
      try {
        const copilotApiUrl = config.COPILOT_API_URL;
        if (!copilotApiUrl) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'ERROR: COPILOT_API_URL is required to call /api/tool-requests/dedupe-analyses',
              },
            ],
          };
        }

        const apiKey = config.API_KEY;
        if (!apiKey) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'ERROR: API_KEY is required to call /api/tool-requests/dedupe-analyses',
              },
            ],
          };
        }

        // URL constructor tolerates a trailing slash on COPILOT_API_URL.
        const url = new URL('/api/tool-requests/dedupe-analyses', copilotApiUrl);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ clientId: params.clientId }),
          // dedupe analysis is slow: live MCP discovery + Claude call
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const text = await res.text();
          return {
            isError: true,
            content: [{ type: 'text', text: `ERROR: copilot-api returned ${res.status}: ${text.slice(0, 400)}` }],
          };
        }
        const result = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `ERROR: ${msg}` }],
        };
      }
    },
  );

  server.tool(
    'create_tool_request_github_issue',
    'Create a GitHub issue for a tool request using the configured default repo (or override). Persists githubIssueUrl + implementedInIssue on the row.',
    {
      id: z.string().uuid().describe('Tool request ID'),
      repoOwner: z.string().optional().describe('Override the default repo owner'),
      repoName: z.string().optional().describe('Override the default repo name'),
      labels: z.array(z.string()).optional().describe('GitHub labels (defaults to ["tool-request"])'),
    },
    async (params) => {
      try {
        const result = await createToolRequestGithubIssue(db, config.ENCRYPTION_KEY, {
          toolRequestId: params.id,
          repoOwner: params.repoOwner,
          repoName: params.repoName,
          labels: params.labels,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `ERROR: ${msg}` }],
        };
      }
    },
  );
}
