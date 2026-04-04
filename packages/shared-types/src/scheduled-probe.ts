export const ProbeAction = {
  CREATE_TICKET: 'create_ticket',
  EMAIL_DIRECT: 'email_direct',
  SILENT: 'silent',
} as const;
export type ProbeAction = (typeof ProbeAction)[keyof typeof ProbeAction];

export const ProbeRunStatus = {
  SUCCESS: 'success',
  ERROR: 'error',
  SKIPPED: 'skipped',
} as const;
export type ProbeRunStatus = (typeof ProbeRunStatus)[keyof typeof ProbeRunStatus];

// ---------------------------------------------------------------------------
// Built-in probe tools — tools that execute locally (no MCP server needed)
// ---------------------------------------------------------------------------

export interface BuiltinToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description: string; default?: unknown; enum?: string[] }>;
  };
}

export const BUILTIN_PROBE_TOOLS: BuiltinToolDefinition[] = [
  {
    name: 'scan_app_logs',
    description: 'Scan application error logs across all services',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Hours to look back (default: 6)', default: 6 },
        services: { type: 'string', description: 'Comma-separated service names or "all" (default: "all")', default: 'all' },
        minLevel: { type: 'string', description: 'Minimum log level: ERROR or WARN (default: ERROR)', default: 'ERROR', enum: ['ERROR', 'WARN'] },
        excludePatterns: { type: 'string', description: 'Comma-separated patterns to exclude from results (optional)' },
      },
    },
  },
  {
    name: 'analyze_app_health',
    description: 'Analyze Bronco app health: ticket patterns, AI usage trends, error logs, and codebase — generates SystemAnalysis improvement suggestions',
    inputSchema: {
      type: 'object',
      properties: {
        lookbackDays: { type: 'number', description: 'Days to look back for ticket/AI stats (default: 7)', default: 7 },
        repoUrl: { type: 'string', description: 'Git repo URL for code reading via mcp-repo' },
        mcpRepoUrl: { type: 'string', description: 'mcp-repo server URL (e.g. http://mcp-repo:3120)' },
      },
    },
  },
];

export const BUILTIN_PROBE_TOOL_NAMES = new Set(BUILTIN_PROBE_TOOLS.map((t) => t.name));

export interface ScheduledProbe {
  id: string;
  clientId: string;
  integrationId: string;
  name: string;
  description: string | null;
  toolName: string;
  toolParams: Record<string, unknown>;
  cronExpression: string;
  category: string | null;
  action: ProbeAction;
  actionConfig: Record<string, unknown> | null;
  isActive: boolean;
  lastRunAt: Date | null;
  lastRunStatus: ProbeRunStatus | null;
  lastRunResult: string | null;
  createdAt: Date;
  updatedAt: Date;
}
