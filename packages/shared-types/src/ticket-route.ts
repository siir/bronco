import type { TicketCategory, TicketSource } from './ticket.js';

// --- Route Type (ingestion vs analysis) ---

/**
 * Distinguishes ingestion routes (source-specific ticket enrichment + creation)
 * from analysis routes (category-driven investigation after ticket exists).
 */
export const RouteType = {
  INGESTION: 'INGESTION',
  ANALYSIS: 'ANALYSIS',
} as const;
export type RouteType = (typeof RouteType)[keyof typeof RouteType];

// --- Route Step Types (code-defined processing functions available for routing) ---

/**
 * Built-in processing step types that can be included in ticket routes.
 * Each maps to a concrete function in the analyzer — the route just controls
 * which ones run and in what order.
 */
export const RouteStepType = {
  // Ingestion steps (source-specific ticket enrichment + creation)
  RESOLVE_THREAD: 'RESOLVE_THREAD',
  SUMMARIZE_EMAIL: 'SUMMARIZE_EMAIL',
  CATEGORIZE: 'CATEGORIZE',
  TRIAGE_PRIORITY: 'TRIAGE_PRIORITY',
  DRAFT_RECEIPT: 'DRAFT_RECEIPT',
  GENERATE_TITLE: 'GENERATE_TITLE',
  CREATE_TICKET: 'CREATE_TICKET',

  // Context loading steps
  LOAD_CLIENT_CONTEXT: 'LOAD_CLIENT_CONTEXT',
  LOAD_ENVIRONMENT_CONTEXT: 'LOAD_ENVIRONMENT_CONTEXT',

  // Analysis steps (category-driven investigation)
  EXTRACT_FACTS: 'EXTRACT_FACTS',
  GATHER_REPO_CONTEXT: 'GATHER_REPO_CONTEXT',
  GATHER_DB_CONTEXT: 'GATHER_DB_CONTEXT',
  DEEP_ANALYSIS: 'DEEP_ANALYSIS',
  AGENTIC_ANALYSIS: 'AGENTIC_ANALYSIS',
  DRAFT_FINDINGS_EMAIL: 'DRAFT_FINDINGS_EMAIL',
  SUGGEST_NEXT_STEPS: 'SUGGEST_NEXT_STEPS',
  UPDATE_TICKET_SUMMARY: 'UPDATE_TICKET_SUMMARY',
  DETECT_TOOL_GAPS: 'DETECT_TOOL_GAPS',

  // Notification step
  NOTIFY_OPERATOR: 'NOTIFY_OPERATOR',

  // Dispatch step
  DISPATCH_TO_ROUTE: 'DISPATCH_TO_ROUTE',

  // Follower management step
  ADD_FOLLOWER: 'ADD_FOLLOWER',

  // Incremental update analysis step (reply-triggered)
  UPDATE_ANALYSIS: 'UPDATE_ANALYSIS',

  // Custom AI query step
  CUSTOM_AI_QUERY: 'CUSTOM_AI_QUERY',
} as const;
export type RouteStepType = (typeof RouteStepType)[keyof typeof RouteStepType];

/** Metadata about a built-in route step type — used by the UI to show available steps. */
export interface RouteStepTypeInfo {
  type: RouteStepType;
  name: string;
  description: string;
  phase: 'ingestion' | 'analysis' | 'dispatch';
  /** The default AI task type used by this step (null for non-AI steps like repo cloning). */
  defaultTaskType: string | null;
  /** The default prompt key used by this step (null for non-AI steps). */
  defaultPromptKey: string | null;
}

// --- Ticket Route (DB-stored routing configuration) ---

export interface TicketRoute {
  id: string;
  name: string;
  description: string | null;
  /** AI-generated summary describing what this route does — used for route selection. */
  summary: string | null;
  /** INGESTION routes enrich + create tickets from a source. ANALYSIS routes investigate existing tickets. */
  routeType: RouteType;
  category: TicketCategory | null;
  /** Optional ticket source filter — when set, the route only matches tickets with this source. Null means any source. */
  source: TicketSource | null;
  clientId: string | null;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketRouteStep {
  id: string;
  routeId: string;
  stepOrder: number;
  name: string;
  /** The built-in step type to execute. */
  stepType: RouteStepType;
  /** Optional AI task type override (e.g. use BUG_ANALYSIS instead of DEEP_ANALYSIS). */
  taskTypeOverride: string | null;
  /** Optional prompt key override. */
  promptKeyOverride: string | null;
  /** Step-specific config (JSON). */
  config: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
