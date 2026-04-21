export const TaskType = {
  // Local LLM tasks (fast, cost-free — Ollama on Mac Mini)
  TRIAGE: 'TRIAGE',
  CATEGORIZE: 'CATEGORIZE',
  SUMMARIZE: 'SUMMARIZE',
  DRAFT_EMAIL: 'DRAFT_EMAIL',
  EXTRACT_FACTS: 'EXTRACT_FACTS',
  SUMMARIZE_TICKET: 'SUMMARIZE_TICKET',
  SUGGEST_NEXT_STEPS: 'SUGGEST_NEXT_STEPS',
  CLASSIFY_INTENT: 'CLASSIFY_INTENT',
  SUMMARIZE_LOGS: 'SUMMARIZE_LOGS',
  GENERATE_TITLE: 'GENERATE_TITLE',
  CLASSIFY_EMAIL: 'CLASSIFY_EMAIL',
  // Local LLM tasks — user-facing DevOps interactions
  ANALYZE_WORK_ITEM: 'ANALYZE_WORK_ITEM',
  DRAFT_COMMENT: 'DRAFT_COMMENT',
  GENERATE_DEVOPS_PLAN: 'GENERATE_DEVOPS_PLAN',
  // Claude API tasks (heavy reasoning)
  ANALYZE_QUERY: 'ANALYZE_QUERY',
  GENERATE_SQL: 'GENERATE_SQL',
  REVIEW_CODE: 'REVIEW_CODE',
  DEEP_ANALYSIS: 'DEEP_ANALYSIS',
  BUG_ANALYSIS: 'BUG_ANALYSIS',
  ARCHITECTURE_REVIEW: 'ARCHITECTURE_REVIEW',
  SCHEMA_REVIEW: 'SCHEMA_REVIEW',
  FEATURE_ANALYSIS: 'FEATURE_ANALYSIS',
  // Automated issue resolution (Claude API — agentic code generation)
  GENERATE_RESOLUTION_PLAN: 'GENERATE_RESOLUTION_PLAN',
  RESOLVE_ISSUE: 'RESOLVE_ISSUE',
  // Codebase modification (tiered by scope)
  CHANGE_CODEBASE_SMALL: 'CHANGE_CODEBASE_SMALL',
  CHANGE_CODEBASE_LARGE: 'CHANGE_CODEBASE_LARGE',
  // Post-closure ticket analysis — system improvement suggestions
  ANALYZE_TICKET_CLOSURE: 'ANALYZE_TICKET_CLOSURE',
  // Client learning extraction from resolved tickets
  EXTRACT_CLIENT_LEARNINGS: 'EXTRACT_CLIENT_LEARNINGS',
  // Release notes generation
  GENERATE_RELEASE_NOTE: 'GENERATE_RELEASE_NOTE',
  // Custom AI query (configurable per route step)
  CUSTOM_AI_QUERY: 'CUSTOM_AI_QUERY',
  // Ticket routing tasks (local LLM)
  SUMMARIZE_ROUTE: 'SUMMARIZE_ROUTE',
  SELECT_ROUTE: 'SELECT_ROUTE',
  // Self-analysis (scheduled app health)
  ANALYZE_APP_HEALTH: 'ANALYZE_APP_HEALTH',
  // Post-hoc capability-gap detection (Claude Haiku — cheap review)
  DETECT_TOOL_GAPS: 'DETECT_TOOL_GAPS',
  // Admin dedupe pass over pending ToolRequest rows (Claude Sonnet)
  ANALYZE_TOOL_REQUESTS: 'ANALYZE_TOOL_REQUESTS',
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

export const AIProvider = {
  LOCAL: 'LOCAL',
  CLAUDE: 'CLAUDE',
  OPENAI: 'OPENAI',
  GROK: 'GROK',
  GOOGLE: 'GOOGLE',
} as const;
export type AIProvider = (typeof AIProvider)[keyof typeof AIProvider];

// --- App Scopes (for restricting AI providers to specific apps) ---

export const AppScope = {
  CORE: 'CORE',
} as const;
export type AppScope = (typeof AppScope)[keyof typeof AppScope];

/** Display labels for each app scope. */
export const APP_SCOPE_LABELS: Record<AppScope, string> = {
  [AppScope.CORE]: 'Core Platform',
};

/** Maps each TaskType to its owning app scope. */
export const TASK_APP_SCOPE: Record<TaskType, AppScope> = {
  // Core platform tasks — local LLM
  [TaskType.TRIAGE]: AppScope.CORE,
  [TaskType.CATEGORIZE]: AppScope.CORE,
  [TaskType.SUMMARIZE]: AppScope.CORE,
  [TaskType.DRAFT_EMAIL]: AppScope.CORE,
  [TaskType.EXTRACT_FACTS]: AppScope.CORE,
  [TaskType.SUMMARIZE_TICKET]: AppScope.CORE,
  [TaskType.SUGGEST_NEXT_STEPS]: AppScope.CORE,
  [TaskType.CLASSIFY_INTENT]: AppScope.CORE,
  [TaskType.SUMMARIZE_LOGS]: AppScope.CORE,
  [TaskType.GENERATE_TITLE]: AppScope.CORE,
  [TaskType.CLASSIFY_EMAIL]: AppScope.CORE,
  [TaskType.ANALYZE_WORK_ITEM]: AppScope.CORE,
  [TaskType.DRAFT_COMMENT]: AppScope.CORE,
  [TaskType.GENERATE_DEVOPS_PLAN]: AppScope.CORE,
  [TaskType.GENERATE_RELEASE_NOTE]: AppScope.CORE,

  // Core platform tasks — Claude API
  [TaskType.ANALYZE_QUERY]: AppScope.CORE,
  [TaskType.GENERATE_SQL]: AppScope.CORE,
  [TaskType.REVIEW_CODE]: AppScope.CORE,
  [TaskType.DEEP_ANALYSIS]: AppScope.CORE,
  [TaskType.BUG_ANALYSIS]: AppScope.CORE,
  [TaskType.ARCHITECTURE_REVIEW]: AppScope.CORE,
  [TaskType.SCHEMA_REVIEW]: AppScope.CORE,
  [TaskType.FEATURE_ANALYSIS]: AppScope.CORE,
  [TaskType.GENERATE_RESOLUTION_PLAN]: AppScope.CORE,
  [TaskType.RESOLVE_ISSUE]: AppScope.CORE,
  [TaskType.CHANGE_CODEBASE_SMALL]: AppScope.CORE,
  [TaskType.CHANGE_CODEBASE_LARGE]: AppScope.CORE,
  [TaskType.ANALYZE_TICKET_CLOSURE]: AppScope.CORE,
  [TaskType.EXTRACT_CLIENT_LEARNINGS]: AppScope.CORE,

  // Custom AI query
  [TaskType.CUSTOM_AI_QUERY]: AppScope.CORE,

  // Ticket routing tasks
  [TaskType.SUMMARIZE_ROUTE]: AppScope.CORE,
  [TaskType.SELECT_ROUTE]: AppScope.CORE,

  // Self-analysis
  [TaskType.ANALYZE_APP_HEALTH]: AppScope.CORE,

  // Post-hoc capability-gap detection
  [TaskType.DETECT_TOOL_GAPS]: AppScope.CORE,

  // Admin dedupe pass
  [TaskType.ANALYZE_TOOL_REQUESTS]: AppScope.CORE,

} satisfies Record<TaskType, AppScope>;

export interface AIRequest {
  taskType: TaskType;
  prompt: string;
  context?: Record<string, unknown>;
  /** Optional prompt registry key (e.g. "imap.triage.system"). When provided,
   *  the AIRouter resolves overrides via PromptResolver and uses the composed
   *  system prompt. Falls back to `systemPrompt` if not set. */
  promptKey?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** Explicit provider override — bypasses normal routing when set. */
  providerOverride?: string;
  /** Explicit model override — bypasses normal routing when set. Must be paired with providerOverride. */
  modelOverride?: string;
  /** Optional abort signal — when aborted, the underlying HTTP request is cancelled. */
  signal?: AbortSignal;
}

export interface AIResponse {
  provider: AIProvider;
  content: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  durationMs: number;
}

// --- Tool Use Types (for agentic analysis with Claude tool_use) ---

export interface AIToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AITextBlock {
  type: 'text';
  text: string;
}

export interface AIToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AIToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type AIContentBlock = AITextBlock | AIToolUseBlock;

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string | AIContentBlock[] | AIToolResultBlock[];
}

export interface AIToolRequest extends Omit<AIRequest, 'prompt'> {
  prompt?: string;
  tools: AIToolDefinition[];
  messages: AIMessage[];
}

export interface AIToolResponse extends AIResponse {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  contentBlocks: AIContentBlock[];
}

// --- AI Model Configuration (per-task provider/model overrides) ---

export interface AiModelConfigRecord {
  id: string;
  taskType: string;
  scope: 'APP_WIDE' | 'CLIENT';
  clientId: string | null;
  provider: AIProvider;
  model: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Hardcoded default for a task type — used as fallback when no DB config exists.
 */
export interface TaskTypeDefault {
  taskType: TaskType;
  provider: AIProvider;
  model: string;
}

// --- Capability Levels (for auto-routing providers by task complexity) ---

export const CapabilityLevel = {
  SIMPLE: 'SIMPLE',
  BASIC: 'BASIC',
  STANDARD: 'STANDARD',
  ADVANCED: 'ADVANCED',
  DEEP_ADVANCED: 'DEEP_ADVANCED',
} as const;
export type CapabilityLevel = (typeof CapabilityLevel)[keyof typeof CapabilityLevel];

// --- AI Provider (one per provider type) ---

export interface AiProviderRecord {
  id: string;
  provider: AIProvider;
  baseUrl: string | null;
  isActive: boolean;
  hasApiKey: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// --- AI Provider Model (many per provider) ---

export interface AiProviderModelRecord {
  id: string;
  providerId: string;
  provider: AIProvider;
  name: string;
  model: string;
  capabilityLevel: CapabilityLevel;
  isActive: boolean;
  enabledApps: AppScope[];
  createdAt: Date;
  updatedAt: Date;
}
