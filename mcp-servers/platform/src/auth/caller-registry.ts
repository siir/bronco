/**
 * Per-caller tool allowlist for MCP Platform Server.
 *
 * Defense-in-depth inside the API_KEY trust boundary. Each service that calls
 * the platform must identify itself via the X-Caller-Name header. The allowlist
 * below restricts which tools each caller may invoke.
 *
 * copilot-api receives '*' (full access) because it is already protected by
 * its own REST-level auth and operator RBAC — the MCP surface is a thin proxy
 * on top of the same Prisma layer the REST routes use.
 *
 * Worker callers (ticket-analyzer, issue-resolver, slack-worker, …) receive
 * tight allowlists scoped to the tools they actually call. Any tool not in
 * the set is denied with a structured MCP error.
 *
 * ROLLOUT: REQUIRE_CALLER_NAME defaults to false. Missing header logs WARN
 * but the request proceeds. Flip REQUIRE_CALLER_NAME=true in Hugo .env once
 * all callers are confirmed to be sending the header.
 */

/**
 * Sentinel value meaning "allow every tool".
 * Only used for copilot-api which has its own trust boundary.
 */
const ALLOW_ALL = '*' as const;

export const CALLER_ALLOWLIST: Record<string, Set<string> | typeof ALLOW_ALL> = {
  /**
   * copilot-api — full access.
   * The REST API is its own trust boundary (operator RBAC, Fastify auth hooks).
   * It is the platform control surface and must be able to call every tool.
   */
  'copilot-api': ALLOW_ALL,

  /**
   * ticket-analyzer — agentic analysis loop.
   * Reads tickets, clients, people; writes knowledge-doc sections; calls
   * request_tool / read_tool_result_artifact. No mutation of operators,
   * clients, plans, or issue jobs.
   */
  'ticket-analyzer': new Set([
    // Artifact / tool result access
    'read_tool_result_artifact',
    'query_artifact',
    // Knowledge-doc tools (agentic analysis writes to these)
    'kd_read_toc',
    'kd_read_section',
    'kd_update_section',
    'kd_add_subsection',
    // Gap / tool request
    'request_tool',
    'list_tool_requests',
    'get_tool_request',
    // Ticket read
    'get_ticket',
    'list_tickets',
    'search_tickets',
    'update_ticket',         // Analyzer sets status (NEW → OPEN/WAITING) at end-of-run
    'get_ticket_logs',
    // Client read
    'get_client',
    'list_clients',
    'search_clients',
    // People read
    'get_person',
    'list_people',
    'search_people',
    // Operator read (for analysis context)
    'get_operator',
    'list_operators',
    'search_operators',
    // User search (for context)
    'search_users',
    // Probe read (for context)
    'get_probe_runs',
    'list_probes',
    'search_scheduled_probes',
    // Client memory read (injected into analysis context)
    'list_client_memory',
    // System/settings read (operational context)
    'get_system',
    'list_systems',
    'get_system_settings',
    // AI usage (post-pipeline self-analysis)
    'get_ai_usage',
    'get_ai_cost_summary',
    'get_ticket_cost',
  ]),

  /**
   * issue-resolver — code generation worker.
   * Reads ticket/client/repo context; manages issue-job lifecycle;
   * calls approve/reject plan; writes client memory learnings.
   * No access to operator management or tool-request admin.
   */
  'issue-resolver': new Set([
    // Issue job lifecycle
    'get_issue_job',
    'list_issue_jobs',
    // Plan approval flow (approve_plan / reject_plan are used by the resolver's
    // plan approval endpoint — copilot-api proxies the operator action here)
    'approve_plan',
    'reject_plan',
    // Ticket read
    'get_ticket',
    'list_tickets',
    'search_tickets',
    'update_ticket',
    'get_ticket_logs',
    // Client read
    'get_client',
    'list_clients',
    // Client memory (learner writes learnings after plan approval/rejection)
    'list_client_memory',
    'create_client_memory',
    // AI usage
    'get_ticket_cost',
  ]),

  /**
   * scheduler-worker — cron jobs, system analysis, operational alerts.
   * Reads tickets/clients/AI usage for health analysis; no write access
   * beyond its own operational tasks.
   * NOTE: scheduler-worker does not currently call platform MCP tools directly
   * (system-analyzer.ts uses Prisma + AIRouter). This entry is a placeholder
   * so the allowlist is ready if/when scheduler adds MCP calls.
   * TODO(#407): verify if scheduler-worker actually calls any platform tools.
   */
  'scheduler-worker': new Set([
    'get_ticket',
    'list_tickets',
    'search_tickets',
    'get_client',
    'list_clients',
    'get_ai_usage',
    'get_ai_cost_summary',
    'get_system_settings',
    'get_service_health',
  ]),

  /**
   * slack-worker — Hugo Slack bot, operator-facing conversational interface.
   * Operators interact via Slack so this allowlist is broad — it mirrors
   * what operators can do via the control panel. Destructive admin operations
   * (delete_operator, delete_person) are excluded.
   */
  'slack-worker': new Set([
    // Tickets
    'get_ticket',
    'list_tickets',
    'search_tickets',
    'update_ticket',
    'create_ticket',
    'get_ticket_logs',
    'get_ticket_cost',
    // Clients
    'get_client',
    'list_clients',
    'search_clients',
    'update_client',
    // People
    'get_person',
    'list_people',
    'search_people',
    'create_person',
    'update_person',
    // Operators
    'get_operator',
    'list_operators',
    'search_operators',
    'update_operator',
    // Probes
    'get_probe_runs',
    'list_probes',
    'search_scheduled_probes',
    'run_probe',
    // Issue jobs
    'get_issue_job',
    'list_issue_jobs',
    // AI usage
    'get_ai_usage',
    'get_ai_cost_summary',
    'get_ticket_cost',
    // Tool requests (read-only for Hugo)
    'list_tool_requests',
    'get_tool_request',
    // Client memory (Hugo can read and create entries for clients)
    'list_client_memory',
    'create_client_memory',
    // Systems (read-only status checks)
    'get_system',
    'list_systems',
    'get_system_settings',
    'get_service_health',
    // Slack conversations (Hugo reads its own logs)
    'get_slack_conversation',
    'list_slack_conversations',
    // Knowledge doc (Hugo can read/update for operators)
    'kd_read_toc',
    'kd_read_section',
    'kd_update_section',
    'kd_add_subsection',
    // Pending actions
    'list_pending_actions',
    'approve_pending_action',
    'dismiss_pending_action',
    // Plans (Hugo can surface plan approval flow to operators)
    'approve_plan',
    'reject_plan',
    // Users
    'search_users',
  ]),

  /**
   * probe-worker — scheduled probe execution.
   * Calls client MCP database integrations (not platform). The only platform
   * interaction is through the create_ticket path if a probe triggers a ticket.
   * TODO(#407): verify probe-worker platform tool calls — may only call
   * database/repo integrations, not the platform server directly.
   */
  'probe-worker': new Set([
    'create_ticket',
    'get_ticket',
    'list_tickets',
    'update_ticket',
    'get_client',
    'list_clients',
    'list_probes',
    'get_probe_runs',
  ]),

  /**
   * devops-worker — Azure DevOps work item sync.
   * Creates tickets from work items; reads client context. Does not call
   * platform MCP directly today — uses Prisma directly. Placeholder ready.
   * TODO(#407): verify devops-worker platform tool calls.
   */
  'devops-worker': new Set([
    'create_ticket',
    'get_ticket',
    'list_tickets',
    'update_ticket',
    'get_client',
    'list_clients',
    'search_clients',
    'get_operator',
    'list_operators',
  ]),
};

/**
 * Check whether a given caller is allowed to invoke a specific tool.
 *
 * Returns true when:
 * - caller has ALLOW_ALL ('*') access
 * - caller's allowlist Set contains the toolName
 *
 * Returns false when:
 * - caller is unknown (not in CALLER_ALLOWLIST)
 * - caller's allowlist does not contain the toolName
 */
export function isCallerAllowed(caller: string, toolName: string): boolean {
  const allowed = CALLER_ALLOWLIST[caller];
  if (!allowed) return false;
  if (allowed === ALLOW_ALL) return true;
  return allowed.has(toolName);
}
