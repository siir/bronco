import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolRequestKind, ToolRequestRationaleSource } from '@bronco/shared-types';
import type { ServerDeps } from '../server.js';
import { createLogger, normalizeRequestedName, registerToolRequest, buildClientToolCatalog } from '@bronco/shared-utils';

const logger = createLogger('request-tool');

const SETTING_KEY = 'tool-request-rate-limit-per-run';
const DEFAULT_LIMIT_PER_RUN = 5;
/**
 * Best-effort catalog lookup: if MCP servers are slow or unreachable, we skip
 * the "not found" warning rather than blocking the agent. Slow discoveries are
 * logged at warn level so the operator can see if this is consistently firing.
 */
const CATALOG_LOOKUP_TIMEOUT_MS = 3_000;
/**
 * #306 will introduce an explicit per-run tracker. Until then, we use the
 * ticket's lastAnalyzedAt (or a 1h window) as a pragmatic run-start proxy.
 */
const FALLBACK_RUN_WINDOW_MS = 60 * 60 * 1000;

const KIND_VALUES = Object.values(ToolRequestKind) as [string, ...string[]];

function parseLimit(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (raw && typeof raw === 'object' && 'limit' in raw) {
    const v = (raw as { limit: unknown }).limit;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return DEFAULT_LIMIT_PER_RUN;
}

export function registerRequestToolTool(server: McpServer, { db, config }: ServerDeps): void {
  server.tool(
    'request_tool',
    [
      'Flag a missing, broken, or improvable tool capability discovered during analysis.',
      'Use kind=NEW_TOOL (default) when no existing tool fits.',
      'Use kind=BROKEN_TOOL when an existing tool is malfunctioning (errors, timeouts, malformed output).',
      'Use kind=IMPROVE_TOOL when an existing tool works but is inadequate.',
      'Describe the tool or problem specifically so an operator can evaluate and act on it.',
    ].join(' '),
    {
      ticketId: z.string().uuid().describe('Ticket being analyzed when the gap was encountered'),
      requestedName: z
        .string()
        .min(3)
        .max(100)
        .describe(
          'For NEW_TOOL: proposed snake_case name (e.g. "analyze_execution_plan"). ' +
          'For BROKEN_TOOL / IMPROVE_TOOL: exact name of the failing/inadequate tool.',
        ),
      displayTitle: z
        .string()
        .min(3)
        .max(200)
        .describe('Short human-readable title for the request'),
      description: z
        .string()
        .min(20)
        .describe(
          'For NEW_TOOL: what the tool should do, inputs, outputs. ' +
          'For BROKEN_TOOL: observed failure details. ' +
          'For IMPROVE_TOOL: what improvement is needed and why.',
        ),
      rationale: z
        .string()
        .min(20)
        .describe('Why this was needed for THIS ticket — specific to current work'),
      kind: z
        .enum(KIND_VALUES)
        .default(ToolRequestKind.NEW_TOOL)
        .describe(
          'NEW_TOOL (default): no existing tool fits. ' +
          'BROKEN_TOOL: existing tool is failing. ' +
          'IMPROVE_TOOL: existing tool is inadequate.',
        ),
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
      // Derive clientId from the ticket — never trust caller-supplied values.
      const ticket = await db.ticket.findUnique({
        where: { id: params.ticketId },
        select: { id: true, clientId: true, lastAnalyzedAt: true },
      });
      if (!ticket) {
        return {
          isError: true,
          content: [
            { type: 'text', text: `ERROR: ticket ${params.ticketId} not found` },
          ],
        };
      }
      const clientId = ticket.clientId;

      // Normalize requestedName up-front so we can dedupe same-run repeats
      // before checking the rate limit (Copilot #3118042279).
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

      const priorNames = priorInRun
        .map((r) => r.toolRequest?.requestedName)
        .filter((n): n is string => !!n);

      // Reject repeated requests for the same normalizedName within one run —
      // the acceptance criteria require a rate-limit-style error when the
      // agent re-submits the same name without waiting for a different run.
      if (priorNames.includes(normalizedName)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `ERROR: "${normalizedName}" was already requested in this analysis run. ` +
                `Existing requests this run: [${priorNames.join(', ')}]. ` +
                `Either continue analysis with existing tools or request a different missing capability.`,
            },
          ],
        };
      }

      if (priorInRun.length >= limit) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `ERROR: request_tool rate limit reached for this analysis run (limit=${limit}). ` +
                `Already requested in this run: [${priorNames.join(', ')}]. ` +
                `Focus on the current question with existing tools, or stop and summarize findings.`,
            },
          ],
        };
      }

      const kind = (params.kind ?? ToolRequestKind.NEW_TOOL) as ToolRequestKind;

      const result = await registerToolRequest(db, {
        clientId,
        ticketId: params.ticketId,
        requestedName: params.requestedName,
        displayTitle: params.displayTitle,
        description: params.description,
        rationale: params.rationale,
        suggestedInputs: params.suggestedInputs,
        exampleUsage: params.exampleUsage,
        source: ToolRequestRationaleSource.INLINE_AGENT_REQUEST,
        kind,
      });

      const existing = await db.toolRequest.findUnique({
        where: { id: result.toolRequestId },
        select: { requestCount: true, status: true, kind: true },
      });

      // For BROKEN_TOOL / IMPROVE_TOOL, warn if the requestedName is absent from the
      // client's active tool catalog. The lookup is best-effort: if MCP servers are
      // slow or unreachable we skip the warning (don't block the agent on a slow/down
      // discovery service). Slow discoveries are logged at warn level for operator visibility.
      let kindWarning = '';
      if (kind !== ToolRequestKind.NEW_TOOL) {
        const startMs = Date.now();
        try {
          const catalogPromise = buildClientToolCatalog(db, clientId, {
            encryptionKey: config.ENCRYPTION_KEY,
            mcpPlatformUrl: config.MCP_PLATFORM_URL,
            mcpRepoUrl: config.MCP_REPO_URL,
            mcpDatabaseUrl: config.MCP_DATABASE_URL,
            platformApiKey: config.API_KEY,
          });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('catalog lookup timeout')),
              CATALOG_LOOKUP_TIMEOUT_MS,
            ),
          );
          const catalog = await Promise.race([catalogPromise, timeoutPromise]);
          const match = catalog.find((t) => t.toolName === normalizedName);
          if (!match) {
            kindWarning =
              ` Note: "${normalizedName}" was not found in this client's active tool catalog` +
              ` (scanned ${catalog.length} tool(s) across all MCP servers).` +
              ` Operator will review whether this is a typo or a tool that's not yet registered.`;
          }
        } catch (err) {
          // Best-effort — don't block the agent on slow/down MCP servers.
          // Log at warn so the operator can see if discovery is consistently slow.
          logger.warn(
            { clientId, normalizedName, elapsedMs: Date.now() - startMs, err: (err as Error).message },
            'Catalog lookup skipped for kindWarning (timeout or error)',
          );
          // No warning emitted — "we don't know" is better than a false positive.
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                toolRequestId: result.toolRequestId,
                isNew: result.isNew,
                normalizedName,
                kind: existing?.kind ?? kind,
                requestCount: existing?.requestCount ?? 1,
                status: existing?.status ?? 'PROPOSED',
                message:
                  (result.isNew
                    ? 'Recorded new tool request. Continue analysis with available tools.'
                    : 'Appended rationale to existing tool request. Continue analysis with available tools.') +
                  kindWarning,
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
