import type { UnifiedLogEntry } from '../../../core/services/ticket.service.js';

export type EntryType = UnifiedLogEntry['type'];

/** A collapsed tool_use + tool_result pair attached inline to an AI node. */
export interface TraceToolPill {
  /** Stable id derived from the AppLog entry (or tool_use block id). */
  id: string;
  toolName: string;
  toolUseId: string | null;
  /** Input arguments passed to the tool (from the tool_use block). */
  input: Record<string, unknown> | null;
  /** Result text (possibly preview when truncated). */
  result: string | null;
  durationMs: number | null;
  isError: boolean;
  truncated: boolean;
  artifactId: string | null;
  timestamp: string;
  /** The AppLog entry that recorded the tool call, when available. */
  appLogEntry: UnifiedLogEntry | null;
}

/** A merged, renderable node in the trace tree. */
export interface TraceNode {
  /** Unique within the tree. For merged nodes this is the absorbing parent's id. */
  id: string;
  /** Representative entry for this card (the parent after merge). */
  entry: UnifiedLogEntry;
  /** Child nodes after all merges. */
  children: TraceNode[];
  /** Extra assistant response blocks merged up from duplicate-prompt children. */
  continuations: string[];
  /** Collapsed tool pills attached to this AI card. */
  toolPills: TraceToolPill[];
  /** Depth in the merged tree (0 for roots). */
  depth: number;
  /**
   * When a descendant path exceeds the max-depth threshold, the node at the
   * boundary carries a `condensed` list of deeper descendants instead of
   * `children`. UI can expand inline.
   */
  condensed?: TraceNode[];
}

/** Options for the merge pipeline. */
export interface MergePipelineOptions {
  /** Max tree depth before we start condensing descendants. */
  maxDepth?: number;
  /** When true, skip Pass 2 (same-prompt merge) and Pass 3 (tool pill collapse). */
  debugUnmerged?: boolean;
}

/** Return value: merged roots plus the max depth actually observed. */
export interface MergePipelineResult {
  roots: TraceNode[];
  maxDepth: number;
}

/** Filters applied on top of the merged tree. */
export interface TraceFilters {
  showAi: boolean;
  showAppLogs: boolean;
  showToolCalls: boolean;
  errorsOnly: boolean;
}
