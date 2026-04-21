import { describe, it, expect } from 'vitest';
import type { UnifiedLogEntry } from '../../../core/services/ticket.service.js';
import {
  DEFAULT_MAX_DEPTH,
  buildInitialTree,
  collapseToolCalls,
  condenseDeepNodes,
  mergeSamePrompts,
  runMergePipeline,
  samePromptPrefix,
} from './analysis-trace.merge.js';

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `id-${idSeq}`;
}

function aiEntry(
  partial: Partial<UnifiedLogEntry> & { prompt?: string; response?: string; parentId?: string },
): UnifiedLogEntry {
  const id = partial.id ?? nextId();
  return {
    id,
    type: 'ai',
    timestamp: partial.timestamp ?? new Date(1_700_000_000_000 + Number(id.split('-')[1]) * 1000).toISOString(),
    taskType: partial.taskType ?? 'DEEP_ANALYSIS',
    provider: partial.provider ?? 'CLAUDE',
    model: partial.model ?? 'claude-opus-4-6',
    inputTokens: partial.inputTokens ?? 100,
    outputTokens: partial.outputTokens ?? 50,
    promptText: partial.prompt ?? partial.promptText ?? '',
    responseText: partial.response ?? partial.responseText ?? '',
    parentLogId: partial.parentId ?? partial.parentLogId ?? null,
    parentLogType: partial.parentId || partial.parentLogId ? 'ai' : null,
    archive: partial.archive ?? null,
    conversationMetadata: partial.conversationMetadata ?? null,
  };
}

function toolEntry(partial: {
  id?: string;
  parentId: string;
  tool: string;
  toolUseId?: string;
  result?: string;
  durationMs?: number;
  isError?: boolean;
  timestamp?: string;
  artifactId?: string;
  truncated?: boolean;
}): UnifiedLogEntry {
  const id = partial.id ?? nextId();
  return {
    id,
    type: 'log',
    timestamp: partial.timestamp ?? new Date(1_700_000_000_000 + Number(id.split('-')[1]) * 1000).toISOString(),
    message: `Agentic tool call: ${partial.tool} (${partial.durationMs ?? 10}ms)`,
    level: 'INFO',
    service: 'ticket-analyzer',
    context: {
      tool: partial.tool,
      ...(partial.toolUseId ? { toolUseId: partial.toolUseId } : {}),
      ...(partial.result !== undefined ? { resultPreview: partial.result } : {}),
      ...(partial.artifactId ? { artifactId: partial.artifactId } : {}),
      ...(partial.truncated ? { truncated: true } : {}),
      ...(partial.isError ? { isError: true } : {}),
    },
    durationMs: partial.durationMs ?? 10,
    parentLogId: partial.parentId,
    parentLogType: 'ai',
  };
}

describe('samePromptPrefix', () => {
  it('matches byte-equal text after trimming whitespace', () => {
    expect(samePromptPrefix('  hello world  ', '\nhello world\n')).toBe(true);
  });

  it('matches when both texts share the first 500 chars', () => {
    const base = 'X'.repeat(500);
    expect(samePromptPrefix(base + 'AAA', base + 'BBB')).toBe(true);
  });

  it('returns false for empty strings', () => {
    expect(samePromptPrefix('', '')).toBe(false);
    expect(samePromptPrefix('   ', 'x')).toBe(false);
  });

  it('returns false for different prefixes', () => {
    expect(samePromptPrefix('investigate the ticket', 'summarize the ticket')).toBe(false);
  });
});

describe('buildInitialTree — parent-child + orchestration fallback', () => {
  it('builds a tree from parentLogId', () => {
    idSeq = 0;
    const root = aiEntry({ prompt: 'root' });
    const child = aiEntry({ prompt: 'c', parentId: root.id });
    const tree = buildInitialTree([root, child]);
    expect(tree.length).toBe(1);
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].entry.id).toBe(child.id);
  });

  it('falls back to orchestrationId when parentLogId missing', () => {
    idSeq = 0;
    const orchId = 'orch-1';
    const strategist = aiEntry({
      prompt: 'strategist',
      conversationMetadata: { orchestrationId: orchId, orchestrationIteration: 1, isSubTask: false },
    });
    const subTask = aiEntry({
      prompt: 'sub',
      conversationMetadata: { orchestrationId: orchId, orchestrationIteration: 1, isSubTask: true },
    });
    const tree = buildInitialTree([strategist, subTask]);
    expect(tree.length).toBe(1);
    expect(tree[0].entry.id).toBe(strategist.id);
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].entry.id).toBe(subTask.id);
  });
});

describe('Pass 2 — same-prompt merge', () => {
  it('collapses stacked duplicates into one card with continuations', () => {
    idSeq = 0;
    const root = aiEntry({ prompt: 'investigate', response: 'first' });
    const dup1 = aiEntry({ prompt: '  investigate  ', response: 'second', parentId: root.id });
    const dup2 = aiEntry({ prompt: 'investigate\n', response: 'third', parentId: dup1.id });

    const tree = buildInitialTree([root, dup1, dup2]);
    const merged = mergeSamePrompts(tree);
    expect(merged.length).toBe(1);
    const node = merged[0];
    expect(node.children.length).toBe(0);
    expect(node.continuations).toEqual(['second', 'third']);
  });

  it('re-parents children of merged nodes to the absorbing parent', () => {
    idSeq = 0;
    const root = aiEntry({ prompt: 'investigate', response: 'first' });
    const dup = aiEntry({ prompt: 'investigate', response: 'second', parentId: root.id });
    const grandchild = aiEntry({ prompt: 'follow-up', response: 'details', parentId: dup.id });

    const tree = buildInitialTree([root, dup, grandchild]);
    const merged = mergeSamePrompts(tree);
    expect(merged.length).toBe(1);
    expect(merged[0].continuations).toEqual(['second']);
    expect(merged[0].children.length).toBe(1);
    expect(merged[0].children[0].entry.id).toBe(grandchild.id);
  });

  it('does not merge when prompts differ', () => {
    idSeq = 0;
    const root = aiEntry({ prompt: 'investigate', response: 'a' });
    const child = aiEntry({ prompt: 'summarize', response: 'b', parentId: root.id });
    const tree = buildInitialTree([root, child]);
    const merged = mergeSamePrompts(tree);
    expect(merged[0].children.length).toBe(1);
    expect(merged[0].continuations.length).toBe(0);
  });
});

describe('Pass 3 — tool pill pairing', () => {
  it('pairs tool_use AppLog rows under AI node as pills (preferred: toolUseId)', () => {
    idSeq = 0;
    const ai = aiEntry({ prompt: 'go' });
    const tool = toolEntry({
      parentId: ai.id,
      tool: 'inspect_schema',
      toolUseId: 'toolu_abc',
      result: 'some rows',
      durationMs: 42,
    });
    const tree = buildInitialTree([ai, tool]);
    collapseToolCalls(tree);
    expect(tree.length).toBe(1);
    expect(tree[0].children.length).toBe(0);
    expect(tree[0].toolPills.length).toBe(1);
    const pill = tree[0].toolPills[0];
    expect(pill.toolName).toBe('inspect_schema');
    expect(pill.toolUseId).toBe('toolu_abc');
    expect(pill.durationMs).toBe(42);
  });

  it('falls back to tool-name match when toolUseId is missing', () => {
    idSeq = 0;
    const ai = aiEntry({ prompt: 'go' });
    const tool = toolEntry({
      parentId: ai.id,
      tool: 'run_query',
      result: 'rows',
      durationMs: 7,
    });
    const tree = buildInitialTree([ai, tool]);
    collapseToolCalls(tree);
    expect(tree[0].children.length).toBe(0);
    expect(tree[0].toolPills.length).toBe(1);
    expect(tree[0].toolPills[0].toolUseId).toBeNull();
    expect(tree[0].toolPills[0].toolName).toBe('run_query');
  });

  it('marks pill as truncated when result starts with the truncated marker', () => {
    idSeq = 0;
    const ai = aiEntry({ prompt: 'go' });
    const tool = toolEntry({
      parentId: ai.id,
      tool: 'big',
      result: '[truncated — full output saved as artifact]\nfirst 2KB...',
      artifactId: 'art-1',
    });
    const tree = buildInitialTree([ai, tool]);
    collapseToolCalls(tree);
    expect(tree[0].toolPills[0].truncated).toBe(true);
    expect(tree[0].toolPills[0].artifactId).toBe('art-1');
  });
});

describe('Max-depth condensation', () => {
  it('condenses descendants beyond exactly depth 8', () => {
    idSeq = 0;
    const entries: UnifiedLogEntry[] = [];
    let prevId: string | undefined;
    // Build a chain of 12 AI nodes, each a child of the previous.
    for (let i = 0; i < 12; i++) {
      const e = aiEntry({ prompt: `step-${i}`, parentId: prevId });
      entries.push(e);
      prevId = e.id;
    }
    const tree = buildInitialTree(entries);
    const observed = condenseDeepNodes(tree, DEFAULT_MAX_DEPTH);

    // Walk down: every node at depth < 8 should have `children`, node at depth 8
    // should have `condensed` and no children.
    let node = tree[0];
    for (let d = 0; d < DEFAULT_MAX_DEPTH; d++) {
      expect(node.depth).toBe(d);
      expect(node.children.length).toBe(1);
      node = node.children[0];
    }
    // Node at depth 8 carries the condensed tail
    expect(node.depth).toBe(DEFAULT_MAX_DEPTH);
    expect(node.condensed).toBeDefined();
    expect(node.condensed!.length).toBe(1);
    expect(observed).toBeGreaterThanOrEqual(DEFAULT_MAX_DEPTH);
  });
});

describe('runMergePipeline — end-to-end', () => {
  it('applies all three passes and produces a single merged root with tool pills', () => {
    idSeq = 0;
    const root = aiEntry({ prompt: 'investigate the ticket', response: 'first pass findings' });
    const dup = aiEntry({ prompt: 'investigate the ticket', response: 'refined summary', parentId: root.id });
    const tool = toolEntry({
      parentId: root.id,
      tool: 'search_repo',
      toolUseId: 'toolu_x',
      result: 'found match',
    });

    const { roots, maxDepth } = runMergePipeline([root, dup, tool]);
    expect(roots.length).toBe(1);
    expect(roots[0].continuations).toEqual(['refined summary']);
    expect(roots[0].toolPills.length).toBe(1);
    expect(maxDepth).toBe(0);
  });

  it('debugUnmerged skips passes 2 and 3', () => {
    idSeq = 0;
    const root = aiEntry({ prompt: 'dup', response: 'a' });
    const dup = aiEntry({ prompt: 'dup', response: 'b', parentId: root.id });
    const tool = toolEntry({ parentId: root.id, tool: 't' });
    const { roots } = runMergePipeline([root, dup, tool], { debugUnmerged: true });
    expect(roots[0].continuations).toEqual([]);
    expect(roots[0].toolPills).toEqual([]);
    expect(roots[0].children.length).toBe(2);
  });
});
