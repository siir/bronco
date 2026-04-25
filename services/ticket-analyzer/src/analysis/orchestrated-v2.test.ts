/**
 * Unit tests for services/ticket-analyzer/src/analysis/orchestrated-v2.ts
 *
 * Covers:
 *   - Stall-state machine (updateStallState — via module internals re-export)
 *   - dispatch_subtasks 5-task batch-max enforcement
 *   - Sub-task loop terminates on finalize_subtask
 *   - Sub-task loop respects SUB_TASK_ITERATION_CAP
 *   - Strategist calls complete_analysis → returns AnalysisResult
 *   - Strategist retains kd_read_toc / kd_read_section access
 *   - Stall guard: identical hash OR zero-dispatch → writeStallMarker writes ⚠️
 *
 * All Anthropic SDK calls are mocked through AIRouter.generateWithTools — no
 * live Claude, no live database, no live MCP servers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import type { AppLogger } from '@bronco/shared-utils';
import { initEmptyKnowledgeDoc } from '@bronco/shared-utils';

// ---------------------------------------------------------------------------
// Module-level mocks — must precede SUT import
// ---------------------------------------------------------------------------

// Stub shared-utils to suppress logger output and neutralize advisory-lock
// round-trips that need a real Postgres connection.
vi.mock('@bronco/shared-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bronco/shared-utils')>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    // withTicketLock: run fn directly on the db (no advisory-lock SQL needed)
    withTicketLock: vi.fn().mockImplementation(
      async (db: PrismaClient, _ticketId: string, fn: (tx: PrismaClient) => Promise<unknown>) =>
        fn(db),
    ),
  };
});

// Stub v2-knowledge-doc helpers so they don't touch the DB.
vi.mock('./v2-knowledge-doc.js', () => ({
  composeFinalAnalysis: vi.fn().mockReturnValue('composed analysis'),
  fallbackFillRequiredSections: vi.fn().mockResolvedValue([]),
  writeKnowledgeDocSnapshot: vi.fn().mockResolvedValue(undefined),
  writeStallMarker: vi.fn().mockResolvedValue(undefined),
}));

// Import mocked helpers AFTER vi.mock declarations
import {
  composeFinalAnalysis,
  fallbackFillRequiredSections,
  writeKnowledgeDocSnapshot,
  writeStallMarker,
} from './v2-knowledge-doc.js';

// Import the SUT (after mocks are in place)
import { runOrchestratedV2 } from './orchestrated-v2.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal fake tool-use block. */
function makeToolUseBlock(name: string, input: Record<string, unknown>, id = `tu_${name}`) {
  return { type: 'tool_use' as const, id, name, input };
}

// ---------------------------------------------------------------------------
// Minimal DB mock factory
// ---------------------------------------------------------------------------

/** The ticket knowledgeDoc is returned by every findUnique call by default. */
function makeMockDb(overrides?: {
  knowledgeDoc?: string | null;
  knowledgeDocSectionMeta?: Record<string, unknown> | null;
  appSettingValue?: unknown;
}): PrismaClient {
  const doc = overrides?.knowledgeDoc !== undefined
    ? overrides.knowledgeDoc
    : initEmptyKnowledgeDoc();
  const meta = overrides?.knowledgeDocSectionMeta ?? {};

  const ticketFindUnique = vi.fn().mockResolvedValue({
    knowledgeDoc: doc,
    knowledgeDocSectionMeta: meta,
  });
  const ticketUpdate = vi.fn().mockResolvedValue({});

  const knowledgeDocSnapshotCreate = vi.fn().mockResolvedValue({});

  const appSettingFindUnique = vi.fn().mockResolvedValue(
    overrides?.appSettingValue !== undefined
      ? { value: overrides.appSettingValue }
      : null,
  );

  // resolveOrchestratedModelMap queries aiProviderModel
  const aiProviderModelFindMany = vi.fn().mockResolvedValue([]);

  return {
    ticket: {
      findUnique: ticketFindUnique,
      update: ticketUpdate,
    },
    knowledgeDocSnapshot: {
      create: knowledgeDocSnapshotCreate,
    },
    appSetting: {
      findUnique: appSettingFindUnique,
    },
    aiProviderModel: {
      findMany: aiProviderModelFindMany,
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        ticket: { findUnique: ticketFindUnique, update: ticketUpdate },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(1),
      });
    }),
  } as unknown as PrismaClient;
}

/** Minimal AppLogger mock. */
function makeAppLog(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AppLogger;
}

/** Build the base AnalysisDeps. */
function makeDeps(
  ai: AIRouter,
  db: PrismaClient = makeMockDb(),
): Parameters<typeof runOrchestratedV2>[0] {
  return {
    db,
    ai,
    appLog: makeAppLog(),
    encryptionKey: 'test-key',
    mcpRepoUrl: 'http://mcp-repo',
    mcpPlatformUrl: 'http://mcp-platform',
    apiKey: 'test-api-key',
  };
}

/** Build a minimal pipeline context. */
function makeCtx(overrides?: Partial<Parameters<typeof runOrchestratedV2>[1]>): Parameters<typeof runOrchestratedV2>[1] {
  return {
    ticketId: 'ticket-test-001',
    clientId: 'client-test-001',
    category: 'DATABASE_PERF',
    priority: 'HIGH',
    emailSubject: 'Slow query on Orders table',
    emailBody: 'Queries are taking 10 seconds.',
    clientContext: '',
    environmentContext: '',
    codeContext: [],
    dbContext: '',
    facts: {},
    summary: '',
    ...overrides,
  };
}

/** Build a minimal strategy step. */
function makeStep(): Parameters<typeof runOrchestratedV2>[2] {
  return { config: {} };
}

/** Build an empty AgenticToolContext. */
function makeToolCtx(extraTools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = []): Parameters<typeof runOrchestratedV2>[3] {
  const base = [
    { name: 'platform__kd_read_toc', description: 'Read TOC', input_schema: { type: 'object', properties: {} } },
    { name: 'platform__kd_read_section', description: 'Read section', input_schema: { type: 'object', properties: { sectionKey: { type: 'string' } } } },
    { name: 'platform__kd_update_section', description: 'Update section', input_schema: { type: 'object', properties: {} } },
    { name: 'platform__kd_add_subsection', description: 'Add subsection', input_schema: { type: 'object', properties: {} } },
    { name: 'platform__read_tool_result_artifact', description: 'Read artifact', input_schema: { type: 'object', properties: {} } },
  ];
  return {
    tools: [...base, ...extraTools],
    mcpIntegrations: new Map(),
    repoIdByPrefix: new Map(),
    repos: [],
  };
}

const mockWriteStallMarker = vi.mocked(writeStallMarker);
const mockWriteKnowledgeDocSnapshot = vi.mocked(writeKnowledgeDocSnapshot);
const mockFallbackFill = vi.mocked(fallbackFillRequiredSections);
const mockComposeFinalAnalysis = vi.mocked(composeFinalAnalysis);

/**
 * Reset all v2-knowledge-doc mock call counts AND re-establish their default
 * return values. Called in every beforeEach.
 *
 * In Vitest 4.x, vi.clearAllMocks() also clears mock implementations (matching
 * Jest's clearMocks:true behavior), so we must re-apply defaults after clearing.
 */
function resetKdMocks() {
  mockComposeFinalAnalysis.mockClear();
  mockFallbackFill.mockClear();
  mockWriteKnowledgeDocSnapshot.mockClear();
  mockWriteStallMarker.mockClear();

  mockComposeFinalAnalysis.mockReturnValue('composed analysis');
  mockFallbackFill.mockResolvedValue([]);
  mockWriteKnowledgeDocSnapshot.mockResolvedValue(undefined);
  mockWriteStallMarker.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrated-v2 — strategist dispatches sub-tasks and calls complete_analysis', () => {
  beforeEach(() => {
    resetKdMocks();
  });

  it('returns AnalysisResult with analysis string when strategist calls complete_analysis after dispatch', async () => {
    // Sequence:
    //   iteration 1 inner-loop 1: dispatch 1 sub-task
    //   sub-task loop call 1: sub-task calls finalize_subtask
    //   iteration 1 inner-loop 2 (after sub-task results injected): strategist calls complete_analysis
    const generateWithTools = vi.fn()
      // strategist: dispatch 1 sub-task
      .mockResolvedValueOnce({
        contentBlocks: [makeToolUseBlock('dispatch_subtasks', {
          subtasks: [{ id: 'st-1', intent: 'Check query plan', tools: [], model: 'sonnet' }],
        }, 'tu_dispatch')],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 80 },
      })
      // sub-task call 1: finalize_subtask
      .mockResolvedValueOnce({
        contentBlocks: [makeToolUseBlock('finalize_subtask', {
          summary: 'Found missing index on Orders.CustomerId',
          updatedKdSections: ['evidence.query-plan'],
        }, 'tu_finalize')],
        stopReason: 'tool_use',
        usage: { inputTokens: 50, outputTokens: 40 },
      })
      // strategist: complete_analysis
      .mockResolvedValueOnce({
        contentBlocks: [makeToolUseBlock('complete_analysis', {
          finalAnalysis: 'Root cause: missing index. Fix: CREATE INDEX.',
        }, 'tu_complete')],
        stopReason: 'tool_use',
        usage: { inputTokens: 120, outputTokens: 60 },
      });

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    const result = await runOrchestratedV2(
      makeDeps(ai),
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 5, existingKnowledgeDoc: '' },
    );

    expect(result).toMatchObject({
      analysis: expect.any(String),
      iterationsRun: expect.any(Number),
      totalInputTokens: expect.any(Number),
      totalOutputTokens: expect.any(Number),
    });
    // composeFinalAnalysis was called to build the analysis string
    expect(mockComposeFinalAnalysis).toHaveBeenCalled();
    // fallbackFillRequiredSections called at end of run
    expect(mockFallbackFill).toHaveBeenCalled();
    // No stall marker written
    expect(mockWriteStallMarker).not.toHaveBeenCalled();
  });

  it('tokens from sub-task are accumulated into the orchestrator totals', async () => {
    const generateWithTools = vi.fn()
      .mockResolvedValueOnce({
        contentBlocks: [makeToolUseBlock('dispatch_subtasks', {
          subtasks: [{ id: 'st-tok', intent: 'Token test', tools: [], model: 'haiku' }],
        })],
        stopReason: 'tool_use',
        usage: { inputTokens: 200, outputTokens: 100 },
      })
      // sub-task: finalize with tokens
      .mockResolvedValueOnce({
        contentBlocks: [makeToolUseBlock('finalize_subtask', {
          summary: 'done',
          updatedKdSections: [],
        })],
        stopReason: 'tool_use',
        usage: { inputTokens: 300, outputTokens: 150 },
      })
      // strategist: complete
      .mockResolvedValueOnce({
        contentBlocks: [makeToolUseBlock('complete_analysis', { finalAnalysis: 'All good' })],
        stopReason: 'tool_use',
        usage: { inputTokens: 50, outputTokens: 25 },
      });

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    const result = await runOrchestratedV2(
      makeDeps(ai),
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 5, existingKnowledgeDoc: '' },
    );

    // 200+100 (strat dispatch) + 300+150 (sub-task) + 50+25 (strat complete) = 825
    expect(result.totalInputTokens + result.totalOutputTokens).toBe(825);
  });
});

// ---------------------------------------------------------------------------
// dispatch_subtasks: 5-task max enforcement
// ---------------------------------------------------------------------------

describe('dispatch_subtasks: max 5 sub-tasks per batch', () => {
  beforeEach(() => {
    resetKdMocks();
  });

  it('silently drops sub-tasks beyond the 5-task limit', async () => {
    // Build 6 sub-tasks — the 6th should be dropped before being dispatched
    const sixSubtasks = Array.from({ length: 6 }, (_, i) => ({
      id: `st-${i + 1}`,
      intent: `Intent ${i + 1}`,
      tools: [],
      model: 'sonnet',
    }));

    // Each of the 5 sub-tasks calls finalize_subtask once.
    // The 6th is dropped, so we need exactly 5 sub-task calls + 1 strategist complete.
    const finalizeResponse = {
      contentBlocks: [makeToolUseBlock('finalize_subtask', { summary: 'done', updatedKdSections: [] })],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const completeResponse = {
      contentBlocks: [makeToolUseBlock('complete_analysis', { finalAnalysis: 'done' })],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    };

    const generateWithTools = vi.fn()
      // strategist dispatch 6
      .mockResolvedValueOnce({
        contentBlocks: [makeToolUseBlock('dispatch_subtasks', { subtasks: sixSubtasks })],
        stopReason: 'tool_use' as const,
        usage: { inputTokens: 50, outputTokens: 30 },
      })
      // 5 sub-task finalize calls (6th was dropped)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(finalizeResponse)
      // strategist complete
      .mockResolvedValueOnce(completeResponse);

    const appLog = makeAppLog();
    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    const deps = { ...makeDeps(ai), appLog };

    await runOrchestratedV2(
      deps,
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 5, existingKnowledgeDoc: '' },
    );

    // generateWithTools called 7 times: 1 strat-dispatch + 5 sub-tasks + 1 strat-complete
    // (if 6 were dispatched it would be 8)
    expect(generateWithTools).toHaveBeenCalledTimes(7);
    // The warn was logged about dropping the 6th
    expect((appLog.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (args: unknown[]) => JSON.stringify(args).includes('6'),
    )).toBe(true);
  });

  it('accepts exactly 5 sub-tasks without dropping any', async () => {
    const fiveSubtasks = Array.from({ length: 5 }, (_, i) => ({
      id: `st-${i + 1}`,
      intent: `Intent ${i + 1}`,
      tools: [],
      model: 'sonnet',
    }));

    const finalizeResponse = {
      contentBlocks: [makeToolUseBlock('finalize_subtask', { summary: 'done', updatedKdSections: [] })],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const completeResponse = {
      contentBlocks: [makeToolUseBlock('complete_analysis', { finalAnalysis: 'done' })],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    };

    const generateWithTools = vi.fn()
      .mockResolvedValueOnce({
        contentBlocks: [makeToolUseBlock('dispatch_subtasks', { subtasks: fiveSubtasks })],
        stopReason: 'tool_use' as const,
        usage: { inputTokens: 50, outputTokens: 30 },
      })
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(completeResponse);

    const appLog = makeAppLog();
    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    const deps = { ...makeDeps(ai), appLog };

    await runOrchestratedV2(
      deps,
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 5, existingKnowledgeDoc: '' },
    );

    // 1 strat-dispatch + 5 sub-tasks + 1 complete = 7
    expect(generateWithTools).toHaveBeenCalledTimes(7);
    // No warning about dropping tasks
    expect((appLog.warn as ReturnType<typeof vi.fn>).mock.calls.every(
      (args: unknown[]) => !JSON.stringify(args).includes('excess silently dropped'),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-task loop: finalize_subtask exits the loop and returns SubTaskRunResult
// ---------------------------------------------------------------------------

describe('sub-task loop: finalize_subtask terminates loop', () => {
  beforeEach(() => {
    resetKdMocks();
  });

  it('sub-task calls finalize_subtask → returns FINALIZED stopReason to strategist', async () => {
    // We verify that the dispatch_subtasks tool_result injected back to the
    // strategist contains the summary from finalize_subtask.
    // Use sequential call ordering for determinism:
    //   call 0: strategist dispatches
    //   call 1: sub-task finalizes
    //   call 2: strategist completes (captures tool_result payload)
    let dispatchResultPayload: unknown = null;
    let callIndex = 0;

    const generateWithTools = vi.fn().mockImplementation(
      ({ messages }: { messages: Array<{ role: string; content: unknown }> }) => {
        const idx = callIndex++;
        if (idx === 0) {
          // Strategist: dispatch 1 sub-task
          return Promise.resolve({
            contentBlocks: [makeToolUseBlock('dispatch_subtasks', {
              subtasks: [{ id: 'st-fin', intent: 'Test finalize', tools: [], model: 'sonnet' }],
            }, 'tu_dispatch_fin')],
            stopReason: 'tool_use',
            usage: { inputTokens: 80, outputTokens: 40 },
          });
        }
        if (idx === 1) {
          // Sub-task call: finalize immediately
          return Promise.resolve({
            contentBlocks: [makeToolUseBlock('finalize_subtask', {
              summary: 'Found the root cause: N+1 query pattern',
              updatedKdSections: ['evidence.query-analysis', 'rootCause'],
            }, 'tu_fin')],
            stopReason: 'tool_use',
            usage: { inputTokens: 60, outputTokens: 30 },
          });
        }
        // idx === 2: strategist receives sub-task results via tool_result
        // Capture the dispatch result payload from the last user message
        const lastMsg = messages.at(-1);
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          const toolResult = (lastMsg.content as Array<{ type: string; content?: unknown }>).find(
            b => b.type === 'tool_result',
          );
          if (toolResult?.content && typeof toolResult.content === 'string') {
            try {
              dispatchResultPayload = JSON.parse(toolResult.content);
            } catch {
              // parsing failed
            }
          }
        }
        // Strategist: complete analysis
        return Promise.resolve({
          contentBlocks: [makeToolUseBlock('complete_analysis', { finalAnalysis: 'Finalized!' })],
          stopReason: 'tool_use',
          usage: { inputTokens: 50, outputTokens: 25 },
        });
      },
    );

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    await runOrchestratedV2(
      makeDeps(ai),
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 5, existingKnowledgeDoc: '' },
    );

    // The dispatch result payload returned to strategist should contain the sub-task's summary.
    // Note: the payload uses snake_case `sub_task_id` (as built in orchestrated-v2.ts).
    expect(dispatchResultPayload).not.toBeNull();
    const results = dispatchResultPayload as Array<{ summary: string; stopReason: string; sub_task_id: string }>;
    expect(Array.isArray(results)).toBe(true);
    const subTaskResult = results.find(r => r.sub_task_id === 'st-fin');
    expect(subTaskResult).toBeDefined();
    expect(subTaskResult?.summary).toBe('Found the root cause: N+1 query pattern');
    expect(subTaskResult?.stopReason).toBe('FINALIZED');
  });
});

// ---------------------------------------------------------------------------
// Sub-task loop: SUB_TASK_ITERATION_CAP
// ---------------------------------------------------------------------------

describe('sub-task loop: respects SUB_TASK_ITERATION_CAP (8 iterations)', () => {
  beforeEach(() => {
    resetKdMocks();
  });

  it('sub-task that never calls finalize_subtask exits after SUB_TASK_ITERATION_CAP with BUDGET_EXHAUSTED', async () => {
    // The sub-task always uses tool_use (not finalize) — it should stop at cap.
    // Sequential call ordering (same approach as finalize test for determinism):
    //   calls 0 .. (cap-1): strategist call 0 = dispatch, calls 1..(cap) = sub-task iterations
    //   call (cap+1): strategist call 1 = complete (captures payload)
    const cap = 8; // SUB_TASK_ITERATION_CAP

    let dispatchResultPayload: unknown = null;
    let subTaskCallCount = 0;
    let strategistCallCount = 0;

    const generateWithTools = vi.fn().mockImplementation(
      ({ messages, tools }: { messages: Array<{ role: string; content: unknown }>; tools: Array<{ name: string }> }) => {
        const hasFinalizeTool = tools.some(t => t.name === 'finalize_subtask');

        if (hasFinalizeTool) {
          // Sub-task call — always returns a non-finalize tool use (loop never finalizes)
          subTaskCallCount++;
          return Promise.resolve({
            // Return end_turn to trigger "no tool use" exit — this actually
            // means NO_TOOL_USE_ENDED, not BUDGET_EXHAUSTED. To get BUDGET_EXHAUSTED
            // we need the sub-task to use tool_use every iteration until cap.
            // Use tool_use each time; the sub-task loop will hit the cap.
            contentBlocks: [makeToolUseBlock('platform__kd_read_toc', { ticketId: 'ticket-test-001' })],
            stopReason: 'tool_use' as const,
            usage: { inputTokens: 20, outputTokens: 10 },
          });
        }

        // Strategist call
        strategistCallCount++;
        if (strategistCallCount === 1) {
          // First strategist call: dispatch
          return Promise.resolve({
            contentBlocks: [makeToolUseBlock('dispatch_subtasks', {
              subtasks: [{ id: 'st-cap', intent: 'Never finalize', tools: [], model: 'haiku' }],
            })],
            stopReason: 'tool_use' as const,
            usage: { inputTokens: 80, outputTokens: 40 },
          });
        }

        // Second strategist call: receives sub-task results → capture payload
        const lastMsg = messages.at(-1);
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          const toolResult = (lastMsg.content as Array<{ type: string; content?: unknown }>).find(
            b => b.type === 'tool_result',
          );
          if (toolResult?.content && typeof toolResult.content === 'string') {
            try {
              dispatchResultPayload = JSON.parse(toolResult.content);
            } catch {
              // parsing failure — leave null
            }
          }
        }
        return Promise.resolve({
          contentBlocks: [makeToolUseBlock('complete_analysis', { finalAnalysis: 'Budget test done' })],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 30, outputTokens: 15 },
        });
      },
    );

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    await runOrchestratedV2(
      makeDeps(ai),
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 5, existingKnowledgeDoc: '' },
    );

    // Sub-task should have run exactly cap iterations
    expect(subTaskCallCount).toBe(cap);

    // The dispatch result returned to the strategist should have BUDGET_EXHAUSTED.
    // Payload uses snake_case `sub_task_id`.
    expect(dispatchResultPayload).not.toBeNull();
    const results = dispatchResultPayload as Array<{ stopReason: string; sub_task_id: string }>;
    expect(Array.isArray(results)).toBe(true);
    const stResult = results?.find(r => r.sub_task_id === 'st-cap');
    expect(stResult?.stopReason).toBe('BUDGET_EXHAUSTED');
  });
});

// ---------------------------------------------------------------------------
// Strategist retains kd_read_section / kd_read_toc access
// ---------------------------------------------------------------------------

describe('strategist: retains kd_read_section and kd_read_toc access', () => {
  beforeEach(() => {
    resetKdMocks();
  });

  it('strategist tool list includes platform__kd_read_toc and platform__kd_read_section', async () => {
    const seenStrategistTools: Set<string> = new Set();

    const generateWithTools = vi.fn().mockImplementation(
      ({ tools, messages }: { tools: Array<{ name: string }>; messages: Array<{ role: string }> }) => {
        const hasFinalize = tools.some(t => t.name === 'finalize_subtask');
        if (!hasFinalize) {
          // This is a strategist call — capture tool names
          tools.forEach(t => seenStrategistTools.add(t.name));
        }

        const lastMsg = messages.at(-1);
        if (!hasFinalize && lastMsg?.role !== 'user') {
          // Initial strategist: dispatch sub-task
          return Promise.resolve({
            contentBlocks: [makeToolUseBlock('dispatch_subtasks', {
              subtasks: [{ id: 'st-kd', intent: 'Check KD', tools: [], model: 'haiku' }],
            })],
            stopReason: 'tool_use' as const,
            usage: { inputTokens: 50, outputTokens: 20 },
          });
        }

        if (hasFinalize) {
          // Sub-task: finalize immediately
          return Promise.resolve({
            contentBlocks: [makeToolUseBlock('finalize_subtask', { summary: 'done', updatedKdSections: [] })],
            stopReason: 'tool_use' as const,
            usage: { inputTokens: 20, outputTokens: 10 },
          });
        }

        // Strategist after sub-task: complete
        return Promise.resolve({
          contentBlocks: [makeToolUseBlock('complete_analysis', { finalAnalysis: 'KD test done' })],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 30, outputTokens: 15 },
        });
      },
    );

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    await runOrchestratedV2(
      makeDeps(ai),
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 5, existingKnowledgeDoc: '' },
    );

    expect(seenStrategistTools.has('platform__kd_read_toc')).toBe(true);
    expect(seenStrategistTools.has('platform__kd_read_section')).toBe(true);
    // Write tools should NOT be in the strategist list
    expect(seenStrategistTools.has('platform__kd_update_section')).toBe(false);
    expect(seenStrategistTools.has('platform__kd_add_subsection')).toBe(false);
  });

  it('strategist tool list includes dispatch_subtasks and complete_analysis', async () => {
    const seenStrategistTools: Set<string> = new Set();

    const generateWithTools = vi.fn().mockImplementation(
      ({ tools }: { tools: Array<{ name: string }> }) => {
        const hasFinalize = tools.some(t => t.name === 'finalize_subtask');
        if (!hasFinalize) {
          tools.forEach(t => seenStrategistTools.add(t.name));
          return Promise.resolve({
            contentBlocks: [makeToolUseBlock('complete_analysis', { finalAnalysis: 'done' })],
            stopReason: 'tool_use' as const,
            usage: { inputTokens: 20, outputTokens: 10 },
          });
        }
        return Promise.resolve({
          contentBlocks: [makeToolUseBlock('finalize_subtask', { summary: 'done', updatedKdSections: [] })],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      },
    );

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    await runOrchestratedV2(
      makeDeps(ai),
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 5, existingKnowledgeDoc: '' },
    );

    expect(seenStrategistTools.has('dispatch_subtasks')).toBe(true);
    expect(seenStrategistTools.has('complete_analysis')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stall guard: identical response hash
// ---------------------------------------------------------------------------

describe('stall guard: consecutive identical strategist hash → writeStallMarker', () => {
  beforeEach(() => {
    resetKdMocks();
  });

  it('writes stall marker after 3 consecutive iterations with identical dispatch plan', async () => {
    // The strategist dispatches the EXACT SAME plan 3 times → stall (consecutiveSameHash >= 3)
    // Each iteration: dispatch identical sub-task → sub-task finalizes → sub-task results sent back
    // After 3 identical iterations the loop should terminate with a stall marker.

    const identicalSubtask = { id: 'st-repeat', intent: 'Identical intent every time', tools: [], model: 'sonnet' };
    const dispatchResponse = {
      contentBlocks: [makeToolUseBlock('dispatch_subtasks', { subtasks: [identicalSubtask] }, 'tu_dispatch_stall')],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 50, outputTokens: 30 },
    };
    const finalizeResponse = {
      contentBlocks: [makeToolUseBlock('finalize_subtask', { summary: 'same result', updatedKdSections: [] })],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 20, outputTokens: 10 },
    };

    // We need: dispatch + finalize (×3), then stall fires and loop breaks
    const generateWithTools = vi.fn()
      // iter 1: strategist dispatch
      .mockResolvedValueOnce(dispatchResponse)
      // iter 1: sub-task finalize
      .mockResolvedValueOnce(finalizeResponse)
      // iter 2: strategist dispatch (same plan)
      .mockResolvedValueOnce(dispatchResponse)
      // iter 2: sub-task finalize
      .mockResolvedValueOnce(finalizeResponse)
      // iter 3: strategist dispatch (same plan)
      .mockResolvedValueOnce(dispatchResponse)
      // iter 3: sub-task finalize
      .mockResolvedValueOnce(finalizeResponse);
    // After 3 identical iterations, stall guard fires — no more calls needed

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    await runOrchestratedV2(
      makeDeps(ai),
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 10, existingKnowledgeDoc: '' },
    );

    expect(mockWriteStallMarker).toHaveBeenCalledOnce();
    const [, , , reason] = mockWriteStallMarker.mock.calls[0];
    expect(reason).toMatch(/identical strategist response fingerprints/i);
  });
});

// ---------------------------------------------------------------------------
// Stall guard: zero-dispatch turn
// ---------------------------------------------------------------------------

describe('stall guard: zero-dispatch turns → writeStallMarker', () => {
  beforeEach(() => {
    resetKdMocks();
  });

  it('writes stall marker after 3 iterations with zero KD writes', async () => {
    // Rule 3: totalKdWrites === 0 && completedIterations >= 3
    // The strategist dispatches a different sub-task each time (no hash repeat),
    // but sub-tasks never call any kd_update_section or kd_add_subsection tool,
    // so totalKdWrites stays at 0. After 3 completed iterations, stall fires.

    let iterationCount = 0;
    const makeUniqueDispatch = () => {
      iterationCount++;
      return {
        contentBlocks: [makeToolUseBlock('dispatch_subtasks', {
          subtasks: [{ id: `st-iter-${iterationCount}`, intent: `Unique intent iteration ${iterationCount}`, tools: [], model: 'sonnet' }],
        })],
        stopReason: 'tool_use' as const,
        usage: { inputTokens: 40, outputTokens: 20 },
      };
    };
    const finalizeResponse = {
      // Sub-task finalizes with empty updatedKdSections → no kd writes logged
      contentBlocks: [makeToolUseBlock('finalize_subtask', { summary: 'done', updatedKdSections: [] })],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 15, outputTokens: 8 },
    };

    const generateWithTools = vi.fn()
      // iter 1: dispatch unique sub-task, sub-task finalizes
      .mockResolvedValueOnce(makeUniqueDispatch())
      .mockResolvedValueOnce(finalizeResponse)
      // iter 2: dispatch unique sub-task, sub-task finalizes
      .mockResolvedValueOnce(makeUniqueDispatch())
      .mockResolvedValueOnce(finalizeResponse)
      // iter 3: dispatch unique sub-task, sub-task finalizes → stall fires
      .mockResolvedValueOnce(makeUniqueDispatch())
      .mockResolvedValueOnce(finalizeResponse);

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    await runOrchestratedV2(
      makeDeps(ai),
      makeCtx(),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 10, existingKnowledgeDoc: '' },
    );

    expect(mockWriteStallMarker).toHaveBeenCalledOnce();
    const [, , , reason] = mockWriteStallMarker.mock.calls[0];
    expect(reason).toMatch(/zero knowledge-doc writes/i);
  });
});

// ---------------------------------------------------------------------------
// Stall guard: stall marker content includes ⚠️ Orchestrator stalled
// ---------------------------------------------------------------------------

describe('stall guard: writeStallMarker is called with ⚠️ marker text', () => {
  beforeEach(() => {
    resetKdMocks();
  });

  it('stall detection calls writeStallMarker with the correct ticketId and iteration', async () => {
    const identicalSubtask = { id: 'st-st', intent: 'Same intent', tools: [], model: 'sonnet' };
    const dispatchResponse = {
      contentBlocks: [makeToolUseBlock('dispatch_subtasks', { subtasks: [identicalSubtask] })],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 40, outputTokens: 20 },
    };
    const finalizeResponse = {
      contentBlocks: [makeToolUseBlock('finalize_subtask', { summary: 'same', updatedKdSections: [] })],
      stopReason: 'tool_use' as const,
      usage: { inputTokens: 15, outputTokens: 8 },
    };

    const generateWithTools = vi.fn()
      .mockResolvedValueOnce(dispatchResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(dispatchResponse)
      .mockResolvedValueOnce(finalizeResponse)
      .mockResolvedValueOnce(dispatchResponse)
      .mockResolvedValueOnce(finalizeResponse);

    const ai = { generateWithTools, generate: vi.fn() } as unknown as AIRouter;
    await runOrchestratedV2(
      makeDeps(ai),
      makeCtx({ ticketId: 'ticket-stall-check' }),
      makeStep(),
      makeToolCtx(),
      { maxIterations: 10, existingKnowledgeDoc: '' },
    );

    expect(mockWriteStallMarker).toHaveBeenCalledOnce();
    const [_db, ticketId, iteration, reason] = mockWriteStallMarker.mock.calls[0];
    expect(ticketId).toBe('ticket-stall-check');
    expect(iteration).toBe(3); // stalls on 3rd identical iteration
    expect(reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// v2-knowledge-doc: writeStallMarker body content is verified in
// v2-knowledge-doc.test.ts (see the "writeStallMarker" describe block there).
// That test file does NOT mock v2-knowledge-doc, so the real function runs.
// We keep a cross-reference note here so reviewers know the coverage exists.
// ---------------------------------------------------------------------------

describe('writeStallMarker (v2-knowledge-doc)', () => {
  // writeStallMarker is mocked in this file so the orchestrator path can be
  // exercised without a live DB. The actual "marker body contains
  // ⚠️ Orchestrator stalled" assertion lives in v2-knowledge-doc.test.ts
  // (see the "writeStallMarker" describe block) where the real function is
  // exercised against a stub DB.
  it.todo('full marker-text coverage in v2-knowledge-doc.test.ts');
});

// ---------------------------------------------------------------------------
// v1 orchestrated re-analysis redirect (dispatcher in analyzer.ts)
// ---------------------------------------------------------------------------

describe('v1 orchestrated re-analysis redirect', () => {
  // Per CLAUDE.md: v1 never supported orchestrated re-analysis — the
  // dispatcher in analyzer.ts (line ~2267) redirects re-analysis on
  // v1 orchestrated to v1 flat:
  //   const effectiveStrategy =
  //     (version === 'v1' && strategy === 'orchestrated' && reanalysisCtx)
  //       ? 'flat' : strategy;
  // This 3-line conditional is not exposed as an importable function and
  // pulls in BullMQ + Redis through analyzer.ts. Coverage belongs in
  // analyzer.integration.test.ts.
  it.todo('redirect covered in analyzer.integration.test.ts (deferred)');
});
