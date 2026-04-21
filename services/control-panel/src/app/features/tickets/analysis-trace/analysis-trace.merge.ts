import type { UnifiedLogEntry } from '../../../core/services/ticket.service.js';
import type {
  MergePipelineOptions,
  MergePipelineResult,
  TraceNode,
  TraceToolPill,
} from './analysis-trace.types.js';

export const DEFAULT_MAX_DEPTH = 8;
const PROMPT_MATCH_PREFIX = 500;
const TRUNCATED_PREVIEW_MARKER = '[truncated — full output saved as artifact]';

type Meta = Record<string, unknown> | null | undefined;

function getMeta(entry: UnifiedLogEntry): Record<string, unknown> {
  return (entry.conversationMetadata ?? {}) as Record<string, unknown>;
}

function getContext(entry: UnifiedLogEntry): Record<string, unknown> {
  return (entry.context ?? {}) as Record<string, unknown>;
}

function getOrchestrationId(meta: Meta): string | null {
  if (!meta) return null;
  const v = meta['orchestrationId'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isSubTask(meta: Meta): boolean {
  if (!meta) return false;
  return !!meta['isSubTask'];
}

function normalizePromptPrefix(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, PROMPT_MATCH_PREFIX);
}

/** Extract the first user-message text for an AI entry. Prefers archive.fullPrompt. */
export function firstUserMessageText(entry: UnifiedLogEntry): string | null {
  if (entry.type !== 'ai') return null;
  const text = entry.archive?.fullPrompt ?? entry.promptText ?? null;
  return text ?? null;
}

/** Byte-equal comparison after trim, within the first 500 chars. */
export function samePromptPrefix(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = normalizePromptPrefix(a);
  const pb = normalizePromptPrefix(b);
  if (pa === null || pb === null) return false;
  return pa === pb;
}

/** Assistant response text for an AI entry. */
export function responseText(entry: UnifiedLogEntry): string {
  return entry.archive?.fullResponse ?? entry.responseText ?? '';
}

/**
 * Pass 1 — Tree build.
 *
 * Attach each entry under its `parentLogId`. Entries lacking `parentLogId`
 * but sharing an `orchestrationId` with another AI entry nest under the
 * matching non-sub-task strategist call (legacy orchestration fallback).
 */
export function buildInitialTree(entries: UnifiedLogEntry[]): TraceNode[] {
  const byId = new Map<string, TraceNode>();
  for (const entry of entries) {
    byId.set(entry.id, {
      id: entry.id,
      entry,
      children: [],
      continuations: [],
      toolPills: [],
      depth: 0,
    });
  }

  const roots: TraceNode[] = [];
  const attached = new Set<string>();

  // Primary attach by parentLogId
  for (const entry of entries) {
    const node = byId.get(entry.id);
    if (!node) continue;
    const pid = entry.parentLogId;
    if (pid && byId.has(pid)) {
      byId.get(pid)!.children.push(node);
      attached.add(entry.id);
    }
  }

  // Fallback: orchestration-based nesting for AI sub-tasks that lack parentLogId.
  // Find the non-sub-task strategist with the same orchestrationId; attach under it.
  const strategistByOrchId = new Map<string, TraceNode>();
  for (const entry of entries) {
    if (entry.type !== 'ai') continue;
    const meta = getMeta(entry);
    const orchId = getOrchestrationId(meta);
    if (orchId && !isSubTask(meta)) {
      // Prefer the first strategist row seen per orchestrationId.
      if (!strategistByOrchId.has(orchId)) {
        const node = byId.get(entry.id);
        if (node) strategistByOrchId.set(orchId, node);
      }
    }
  }

  for (const entry of entries) {
    if (attached.has(entry.id)) continue;
    if (entry.type !== 'ai') continue;
    const meta = getMeta(entry);
    if (!isSubTask(meta)) continue;
    const orchId = getOrchestrationId(meta);
    if (!orchId) continue;
    const strategist = strategistByOrchId.get(orchId);
    if (!strategist || strategist.entry.id === entry.id) continue;
    const node = byId.get(entry.id);
    if (!node) continue;
    strategist.children.push(node);
    attached.add(entry.id);
  }

  for (const entry of entries) {
    if (attached.has(entry.id)) continue;
    const node = byId.get(entry.id);
    if (!node) continue;
    roots.push(node);
  }

  setDepths(roots, 0);
  return roots;
}

function setDepths(nodes: TraceNode[], depth: number): void {
  for (const node of nodes) {
    node.depth = depth;
    setDepths(node.children, depth + 1);
  }
}

/**
 * Pass 2 — Same-prompt merge.
 *
 * For each AI node, compare its first user-message text against its parent
 * AI node's first user-message text. Byte-equal merge on the first 500 chars
 * after trim. Merged child's response becomes a `continuation` appended to
 * parent; merged child's children re-parent to the grandparent (i.e. stay
 * under the absorbing parent). Applied recursively so stacks of duplicate
 * prompts collapse into a single card.
 */
export function mergeSamePrompts(roots: TraceNode[]): TraceNode[] {
  for (const root of roots) mergeOne(root);
  setDepths(roots, 0);
  return roots;
}

function mergeOne(node: TraceNode): void {
  // Walk children first — post-order — so deeper duplicates collapse first
  // and then bubble up.
  let i = 0;
  while (i < node.children.length) {
    const child = node.children[i];
    mergeOne(child);

    if (
      node.entry.type === 'ai' &&
      child.entry.type === 'ai' &&
      samePromptPrefix(firstUserMessageText(node.entry), firstUserMessageText(child.entry))
    ) {
      // Absorb child into node: response becomes a continuation, grandchildren
      // re-parent under node. toolPills and prior continuations on the child
      // also bubble up so merged nodes don't lose their collapsed tool pills.
      const childResponse = responseText(child.entry);
      if (childResponse.trim().length > 0) node.continuations.push(childResponse);
      if (child.continuations.length > 0) node.continuations.push(...child.continuations);
      if (child.toolPills.length > 0) node.toolPills.push(...child.toolPills);
      node.children.splice(i, 1, ...child.children);
      // Do not advance i: re-examine the spliced-in children against this parent.
      continue;
    }
    i++;
  }
}

/**
 * Pass 3 — Tool call collapse.
 *
 * For each AI node, pair its emitted tool_use content blocks with AppLog
 * entries whose `parentLogId === aiNode.id`. Match preferred by
 * `context.toolUseId`; fall back to same tool name + nearest timestamp within
 * that node's children. Render each pair as a single `TraceToolPill` inside
 * the AI card; remove both rows from the tree.
 */
export function collapseToolCalls(roots: TraceNode[]): TraceNode[] {
  for (const root of roots) collapseOne(root);
  setDepths(roots, 0);
  return roots;
}

interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown> | null;
}

function extractToolUseBlocks(entry: UnifiedLogEntry): ToolUseBlock[] {
  // The AI response content blocks are not persisted on UnifiedLogEntry, but
  // the AppLog entries carry the tool_use_id per call in their context.
  // For pairing, we also check conversationMetadata.messages for toolName
  // hints — but tool_use ids live on the AppLog side, so we rely on
  // toolUseId matching below. Returning an empty list here keeps the
  // logic driven by AppLog ids, which is the authoritative signal.
  void entry;
  return [];
}

function collapseOne(node: TraceNode): void {
  if (node.entry.type === 'ai') {
    const pills: TraceToolPill[] = [];
    const remaining: TraceNode[] = [];

    for (const child of node.children) {
      if (isToolCallChild(child)) {
        pills.push(toolPillFromChild(child));
        continue;
      }
      remaining.push(child);
    }

    // Optional: pair-match by tool_use blocks (preferred toolUseId). Even
    // though we consume all tool children unconditionally above, we preserve
    // any tool_use blocks referenced but not yet paired (rare — no AppLog
    // row) so the UI can still show the pending call.
    const toolUses = extractToolUseBlocks(node.entry);
    if (toolUses.length > 0) {
      const paired = new Set<string>();
      for (const p of pills) if (p.toolUseId) paired.add(p.toolUseId);
      for (const block of toolUses) {
        if (paired.has(block.id)) continue;
        pills.push({
          id: block.id,
          toolName: block.name,
          toolUseId: block.id,
          input: block.input,
          result: null,
          durationMs: null,
          isError: false,
          truncated: false,
          artifactId: null,
          timestamp: node.entry.timestamp,
          appLogEntry: null,
        });
      }
    }

    node.toolPills.push(...pills);
    node.children = remaining;
  }

  for (const child of node.children) collapseOne(child);
}

function isToolCallChild(child: TraceNode): boolean {
  const e = child.entry;
  if (e.type === 'tool') return true;
  if (e.type !== 'log') return false;
  const ctx = getContext(e);
  // AppLog rows for tool calls carry a `tool` field and `parentLogType: 'ai'`.
  return typeof ctx['tool'] === 'string' && ctx['tool'].length > 0;
}

function toolPillFromChild(child: TraceNode): TraceToolPill {
  const e = child.entry;
  const ctx = getContext(e);
  const toolName = (ctx['tool'] as string | undefined) ?? inferToolNameFromMessage(e.message) ?? 'tool';
  const toolUseId = (ctx['toolUseId'] as string | undefined) ?? null;
  const params = ctx['params'];
  const input = typeof params === 'string' ? safeParseJson(params) : (params as Record<string, unknown> | null | undefined) ?? null;
  const result = (ctx['resultPreview'] as string | undefined) ?? null;
  const artifactId = (ctx['artifactId'] as string | undefined) ?? null;
  const truncated = !!ctx['truncated'] || (typeof result === 'string' && result.startsWith(TRUNCATED_PREVIEW_MARKER));
  const isError = !!ctx['isError'] || !!e.error;
  return {
    id: e.id,
    toolName,
    toolUseId,
    input,
    result,
    durationMs: e.durationMs ?? null,
    isError,
    truncated,
    artifactId,
    timestamp: e.timestamp,
    appLogEntry: e,
  };
}

function inferToolNameFromMessage(message: string | undefined): string | null {
  if (!message) return null;
  // "Agentic tool call: foo_bar (42ms)" or "Sub-task tool call: foo_bar (42ms)"
  const match = message.match(/tool call:\s+([A-Za-z0-9_\-.]+)/i);
  return match ? match[1] : null;
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Max-depth condensation.
 *
 * After the three passes, if any path exceeds `maxDepth`, wrap descendants
 * beyond the threshold in a `condensed` stub on the boundary node.
 */
export function condenseDeepNodes(roots: TraceNode[], maxDepth: number): number {
  let observed = 0;
  const walk = (nodes: TraceNode[], depth: number): void => {
    for (const node of nodes) {
      node.depth = depth;
      if (depth > observed) observed = depth;
      if (depth >= maxDepth && node.children.length > 0) {
        node.condensed = node.children;
        node.children = [];
        // Still walk condensed to measure observed depth.
        walk(node.condensed, depth + 1);
        continue;
      }
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return observed;
}

/** Run all three passes and apply condensation. Pure and side-effect free. */
export function runMergePipeline(
  entries: UnifiedLogEntry[],
  opts: MergePipelineOptions = {},
): MergePipelineResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const roots = buildInitialTree(entries);
  if (opts.debugUnmerged) {
    const observed = condenseDeepNodes(roots, maxDepth);
    return { roots, maxDepth: observed };
  }
  mergeSamePrompts(roots);
  collapseToolCalls(roots);
  const observed = condenseDeepNodes(roots, maxDepth);
  return { roots, maxDepth: observed };
}

/** Walk the merged tree and return a flat list in render order with depth. */
export function flattenTree(roots: TraceNode[]): TraceNode[] {
  const out: TraceNode[] = [];
  const walk = (nodes: TraceNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}
