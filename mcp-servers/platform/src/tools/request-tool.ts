import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolRequestRationaleSource } from '@bronco/shared-types';
import type { ServerDeps } from '../server.js';
import { normalizeRequestedName, registerToolRequest } from '@bronco/shared-utils';

const SETTING_KEY = 'tool-request-rate-limit-per-run';
const DEFAULT_LIMIT_PER_RUN = 5;
/**
 * #306 will introduce an explicit per-run tracker. Until then, we use the
 * ticket's lastAnalyzedAt (or a 1h window) as a pragmatic run-start proxy.
 */
const FALLBACK_RUN_WINDOW_MS = 60 * 60 * 1000;

function parseLimit(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (raw && typeof raw === 'object' && 'limit' in raw) {
    const v = (raw as { limit: unknown }).limit;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return DEFAULT_LIMIT_PER_RUN;
}

export function registerRequestToolTool(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'request_tool',
    [
      'Flag a missing tool capability discovered during analysis.',
      'Call when no existing tool fits and you are about to improvise with a',
      'generic tool or abandon a line of investigation. Describe the tool you',
      'wish existed so an operator can evaluate and implement it.',
    ].join(' '),
    {
      ticketId: z.string().uuid().describe('Ticket being analyzed when the gap was encountered'),
      clientId: z.string().uuid().describe('Client the ticket belongs to'),
      requestedName: z
        .string()
        .min(3)
        .max(100)
        .describe('Proposed snake_case tool name (e.g. "analyze_execution_plan")'),
      displayTitle: z
        .string()
        .min(3)
        .max(200)
        .describe('Short human-readable title for the missing tool'),
      description: z
        .string()
        .min(20)
        .describe('What the tool should do, inputs, outputs, and expected shape'),
      rationale: z
        .string()
        .min(20)
        .describe('Why this tool was needed for THIS ticket — specific to current work'),
      suggestedInputs: z
        .record(z.unknown())
        .optional()
        .describe('Optional JSON sketch of input parameters'),
      exampleUsage: z
        .string()
        .optional()
        .describe('Optional example invocation or pseudo-code showing how the tool would be used'),
    },
    async (params) => {
      const ticket = await db.ticket.findUnique({
        where: { id: params.ticketId },
        select: { id: true, lastAnalyzedAt: true },
      });
      if (!ticket) {
        return {
          isError: true,
          content: [
            { type: 'text', text: `ERROR: ticket ${params.ticketId} not found` },
          ],
        };
      }

      const setting = await db.appSetting.findUnique({ where: { key: SETTING_KEY } });
      const limit = parseLimit(setting?.value);

      // Pragmatic run window: the current analysis run started no earlier than
      // the ticket's lastAnalyzedAt; fall back to a 1h window if this is the
      // first run. #306 will replace this with an explicit per-run tracker.
      const runStart =
        ticket.lastAnalyzedAt ?? new Date(Date.now() - FALLBACK_RUN_WINDOW_MS);

      const priorInRun = await db.toolRequestRationale.findMany({
        where: {
          ticketId: params.ticketId,
          source: ToolRequestRationaleSource.INLINE_AGENT_REQUEST,
          createdAt: { gte: runStart },
        },
        select: { toolRequest: { select: { requestedName: true } } },
        orderBy: { createdAt: 'asc' },
      });

      if (priorInRun.length >= limit) {
        const names = priorInRun
          .map((r) => r.toolRequest?.requestedName)
          .filter((n): n is string => !!n);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `ERROR: request_tool rate limit reached for this analysis run (limit=${limit}). ` +
                `Already requested in this run: [${names.join(', ')}]. ` +
                `Focus on the current question with existing tools, or stop and summarize findings.`,
            },
          ],
        };
      }

      let normalizedName: string;
      try {
        normalizedName = normalizeRequestedName(params.requestedName);
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: 'text', text: `ERROR: ${(err as Error).message}` },
          ],
        };
      }

      const result = await registerToolRequest(db, {
        clientId: params.clientId,
        ticketId: params.ticketId,
        requestedName: params.requestedName,
        displayTitle: params.displayTitle,
        description: params.description,
        rationale: params.rationale,
        suggestedInputs: params.suggestedInputs,
        exampleUsage: params.exampleUsage,
        source: ToolRequestRationaleSource.INLINE_AGENT_REQUEST,
      });

      const existing = await db.toolRequest.findUnique({
        where: { id: result.toolRequestId },
        select: { requestCount: true, status: true },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                toolRequestId: result.toolRequestId,
                isNew: result.isNew,
                normalizedName,
                requestCount: existing?.requestCount ?? 1,
                status: existing?.status ?? 'PROPOSED',
                message: result.isNew
                  ? 'Recorded new tool request. Continue analysis with available tools.'
                  : 'Appended rationale to existing tool request. Continue analysis with available tools.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
