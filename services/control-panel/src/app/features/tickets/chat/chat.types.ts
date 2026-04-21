import type { TicketEvent, UnifiedLogEntry } from '../../../core/services/ticket.service.js';

/** Re-analysis modes that can be driven from the Chat tab. */
export type ChatReanalysisMode = 'continue' | 'refine' | 'fresh_start';

/** Full label set returned by the Chat reply classifier. */
export type ChatIntentLabel = ChatReanalysisMode | 'not_a_question';

export const CHAT_REANALYSIS_MODES: ChatReanalysisMode[] = ['continue', 'refine', 'fresh_start'];

export interface ChatClassifiedIntent {
  label: ChatIntentLabel;
  confidence: number;
}

/** Response from POST /api/tickets/:id/chat-message. */
export interface ChatMessageResponse {
  decision: 'enqueued' | 'skipped' | 'needs_mode_pick';
  chatMessageId: string;
  reanalysisJobId?: string;
  classifiedIntent?: ChatClassifiedIntent;
}

export interface ChatPickModeResponse {
  decision: 'enqueued' | 'skipped';
  chatMessageId: string;
  reanalysisJobId?: string;
}

/** Response from GET /api/settings/analysis-strategy/:ticketId. */
export interface TicketAnalysisStrategyResponse {
  ticketId: string;
  configured: 'flat' | 'orchestrated';
  globalStrategy: 'flat' | 'orchestrated';
  stepOverride: 'flat' | 'orchestrated' | null;
}

export type ChatBubbleRole = 'user' | 'assistant' | 'system';

/** A single rendered item in the chat thread. */
export interface ChatThreadItem {
  id: string;
  role: ChatBubbleRole;
  kind: 'email_inbound' | 'chat_message' | 'analysis' | 'status_change' | 'placeholder';
  authorLabel: string;
  timestamp: string;
  /** Markdown body (for assistant + message kinds). */
  body: string;
  /** Raw event for direct access by children. */
  event?: TicketEvent;
  /** For analysis items: the run number (1-based) in chronological order. */
  runNumber?: number;
  /** For chat_message items returned from server — classifier output. */
  classifiedIntent?: ChatClassifiedIntent;
  /** For chat_message items awaiting operator mode pick. */
  needsModePick?: boolean;
  /** Operator-picked mode (post-pick-mode call) — suppresses the picker. */
  pickedMode?: ChatIntentLabel;
  /** Placeholder-only: short status string (e.g. "Analyzing…"). */
  placeholderText?: string;
}

/** Per-run pill summary derived from unified logs joined by parentLogId. */
export interface ChatRunToolSummary {
  id: string;
  tool: string;
  durationMs: number | null;
  resultSize: number | null;
  artifactId: string | null;
  timestamp: string;
}

export interface ChatRunMeta {
  runNumber: number;
  eventId: string;
  timestamp: string;
  /** Strategy phase recorded on the AI_ANALYSIS event metadata. */
  actualStrategy: 'flat' | 'orchestrated' | 'legacy';
  models: string[];
  durationMs: number | null;
  toolCount: number;
  subTaskCount: number;
  mode: ChatReanalysisMode | null;
  tools: ChatRunToolSummary[];
}

/** Derive run metadata from an AI_ANALYSIS TicketEvent and supporting unified logs. */
export function deriveRunMeta(
  event: TicketEvent,
  runNumber: number,
  logs: UnifiedLogEntry[],
): ChatRunMeta {
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const phase = typeof meta['phase'] === 'string' ? meta['phase'] : null;
  const actualStrategy: 'flat' | 'orchestrated' | 'legacy' =
    phase === 'orchestrated_analysis'
      ? 'orchestrated'
      : phase === 'deep_analysis' || phase === 'flat_analysis'
        ? 'flat'
        : 'legacy';

  const mode =
    typeof meta['reanalysisMode'] === 'string'
      ? (meta['reanalysisMode'] as ChatReanalysisMode)
      : typeof meta['chatReanalysisMode'] === 'string'
        ? (meta['chatReanalysisMode'] as ChatReanalysisMode)
        : null;

  const usage = (meta['usage'] ?? {}) as Record<string, unknown>;
  const durationMs = typeof meta['durationMs'] === 'number'
    ? meta['durationMs'] as number
    : typeof usage['durationMs'] === 'number'
      ? (usage['durationMs'] as number)
      : null;

  const model = typeof meta['aiModel'] === 'string' ? meta['aiModel'] as string : null;
  const models = model ? [model] : [];

  // Tool + sub-task counts from unified logs joined by the AI_ANALYSIS's `parentLogId` lineage.
  // We approximate: any tool-type entry within 2 minutes of the event contributes.
  const eventTime = new Date(event.createdAt).getTime();
  const WINDOW_MS = 2 * 60 * 1000;
  const nearLogs = logs.filter((l) => {
    const t = new Date(l.timestamp).getTime();
    return Math.abs(t - eventTime) <= WINDOW_MS;
  });

  const tools: ChatRunToolSummary[] = [];
  let subTaskCount = 0;
  for (const l of nearLogs) {
    if (l.type === 'tool') {
      const ctx = (l.context ?? {}) as Record<string, unknown>;
      tools.push({
        id: l.id,
        tool: typeof ctx['tool'] === 'string' ? (ctx['tool'] as string) : l.message || 'tool',
        durationMs: typeof ctx['durationMs'] === 'number' ? (ctx['durationMs'] as number) : null,
        resultSize: typeof ctx['resultSize'] === 'number' ? (ctx['resultSize'] as number) : null,
        artifactId: typeof ctx['artifactId'] === 'string' ? (ctx['artifactId'] as string) : null,
        timestamp: l.timestamp,
      });
    }
    if (l.type === 'ai') {
      const cm = (l.conversationMetadata ?? {}) as Record<string, unknown>;
      if (cm['isSubTask']) subTaskCount++;
    }
  }

  return {
    runNumber,
    eventId: event.id,
    timestamp: event.createdAt,
    actualStrategy,
    models,
    durationMs,
    toolCount: tools.length,
    subTaskCount,
    mode,
    tools,
  };
}

/** Formats the strategy stamp portion of a run-marker label. */
export function formatRunStrategyLabel(
  actual: 'flat' | 'orchestrated' | 'legacy',
  configured: 'flat' | 'orchestrated' | null,
): string {
  if (!configured) return actual;
  if (actual === configured) return actual;
  if (actual === 'legacy') return actual;
  return `${actual} (configured: ${configured})`;
}
