/**
 * Unit tests for services/ticket-analyzer/src/analysis/flat-v2.ts
 *
 * No live Anthropic SDK, no live DB, no live MCP servers.
 * All external collaborators are mocked at the module boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import type { AIToolResponse } from '@bronco/shared-types';
import { KnowledgeDocSectionKey } from '@bronco/shared-types';
import { initEmptyKnowledgeDoc } from '@bronco/shared-utils';

// ---------------------------------------------------------------------------
// Mock @bronco/shared-utils so createLogger, loadKnowledgeDoc don't blow up
// ---------------------------------------------------------------------------
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
    callMcpToolViaSdk: vi.fn(),
    // loadKnowledgeDoc will be overridden per-test via the db mock
  };
});

// ---------------------------------------------------------------------------
// Mock v2-knowledge-doc collaborators so we can spy on them
// ---------------------------------------------------------------------------
vi.mock('./v2-knowledge-doc.js', () => ({
  fallbackFillRequiredSections: vi.fn().mockResolvedValue([]),
  writeKnowledgeDocSnapshot: vi.fn().mockResolvedValue(undefined),
  composeFinalAnalysis: vi.fn().mockReturnValue('composed analysis text'),
}));

// Partial mock of shared.ts — keep pure utilities untouched, replace side-effectful ones.
// Note: vi.mock factory is hoisted so no top-level variables can be referenced here.
vi.mock('./shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared.js')>();
  return {
    ...actual,
    executeAgenticToolCall: vi.fn().mockResolvedValue({
      toolUseId: 'mock-tool-id',
      result: '{"data":"ok"}',
      isError: false,
    }),
    getToolResultMaxTokens: vi.fn().mockResolvedValue(4000),
    saveMcpToolArtifact: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Now import the SUT (after mocks are in place)
// ---------------------------------------------------------------------------
import { runFlatV2 } from './flat-v2.js';
import { KD_SYSTEM_PROMPT_SNIPPET } from './v2-prompts.js';
import type { AnalysisDeps, AnalysisPipelineContext, AgenticToolContext, StrategyStep } from './shared.js';
import { executeAgenticToolCall } from './shared.js';
import {
  fallbackFillRequiredSections,
  writeKnowledgeDocSnapshot,
  composeFinalAnalysis,
} from './v2-knowledge-doc.js';

// Convenience aliases so tests can use .mockResolvedValue etc.
const executeAgenticToolCallMock = vi.mocked(executeAgenticToolCall);
const fallbackFillRequiredSectionsMock = vi.mocked(fallbackFillRequiredSections);
const writeKnowledgeDocSnapshotMock = vi.mocked(writeKnowledgeDocSnapshot);
const composeFinalAnalysisMock = vi.mocked(composeFinalAnalysis);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock PrismaClient. knowledgeDocResult controls what
 *  loadKnowledgeDoc returns (via ticket.findUnique). */
function makeMockDb(opts?: {
  knowledgeDocResult?: {
    knowledgeDoc: string | null;
    knowledgeDocSectionMeta: unknown;
  } | null;
}): PrismaClient {
  const kdResult = opts?.knowledgeDocResult ?? null;
  return {
    ticket: {
      findUnique: vi.fn().mockResolvedValue(kdResult),
    },
    appSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    knowledgeDocSnapshot: {
      create: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        ticket: {
          findUnique: vi.fn().mockResolvedValue(kdResult),
          update: vi.fn().mockResolvedValue({}),
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(1),
      });
    }),
  } as unknown as PrismaClient;
}

/** Build a minimal AppLogger-shaped mock */
function makeMockAppLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build deps bag */
function makeDeps(db: PrismaClient, generateWithToolsFn: (...args: unknown[]) => unknown): AnalysisDeps {
  return {
    db,
    ai: {
      generateWithTools: generateWithToolsFn as AnalysisDeps['ai']['generateWithTools'],
      generate: vi.fn(),
    } as unknown as AnalysisDeps['ai'],
    appLog: makeMockAppLog() as unknown as AnalysisDeps['appLog'],
    encryptionKey: 'test-key',
    mcpRepoUrl: 'http://mcp-repo:3111',
    mcpPlatformUrl: 'http://mcp-platform:3110',
    loadDefaultMaxTokens: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build a minimal pipeline context */
function makePipelineCtx(overrides?: Partial<AnalysisPipelineContext>): AnalysisPipelineContext {
  return {
    ticketId: 'ticket-flat-v2-test',
    clientId: 'client-test-123',
    category: 'DATABASE_PERF',
    priority: 'HIGH',
    emailSubject: 'Query timing out on orders table',
    emailBody: 'The query SELECT * FROM Orders WHERE... is timing out.',
    clientContext: '',
    environmentContext: '',
    codeContext: [],
    dbContext: '',
    facts: { keywords: ['timeout', 'orders'] },
    summary: '',
    ...overrides,
  };
}

/** Build a minimal AgenticToolContext */
function makeToolCtx(): AgenticToolContext {
  return {
    tools: [
      { name: 'prod-db__run_query', description: 'Run query', input_schema: { type: 'object', properties: {} } },
    ],
    mcpIntegrations: new Map([
      ['prod-db', { label: 'prod-db', url: 'http://mcp-db:3100', mcpPath: '/mcp', apiKey: 'key', authHeader: 'bearer', callerName: 'ticket-analyzer' }],
    ]),
    repoIdByPrefix: new Map(),
    repos: [],
  };
}

/** Build a step with no overrides */
function makeStep(): StrategyStep {
  return { config: null, taskTypeOverride: null };
}

/** Minimal required fields for AIResponse base type */
const BASE_AI_RESPONSE = {
  provider: 'CLAUDE' as const,
  content: '',
  model: 'claude-test',
  durationMs: 0,
} as const;

/** Build a final-text response (stopReason=end_turn, text blocks) */
function makeFinalTextResponse(text: string): AIToolResponse {
  return {
    ...BASE_AI_RESPONSE,
    stopReason: 'end_turn',
    contentBlocks: [{ type: 'text', text }],
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

/** Build a tool_use response with one tool call */
function makeToolUseResponse(toolName: string, toolUseId = 'tu-001'): AIToolResponse {
  return {
    ...BASE_AI_RESPONSE,
    stopReason: 'tool_use',
    contentBlocks: [
      { type: 'tool_use', id: toolUseId, name: toolName, input: { sql: 'SELECT 1' } },
    ],
    usage: { inputTokens: 80, outputTokens: 30 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFlatV2', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-apply defaults after reset
    executeAgenticToolCallMock.mockResolvedValue({
      toolUseId: 'mock-tool-id',
      result: '{"data":"ok"}',
      isError: false,
    });
    fallbackFillRequiredSectionsMock.mockResolvedValue([]);
    writeKnowledgeDocSnapshotMock.mockResolvedValue(undefined);
    composeFinalAnalysisMock.mockReturnValue('composed analysis text');
  });

  // -------------------------------------------------------------------------
  // Iteration cap
  // -------------------------------------------------------------------------

  describe('iteration cap', () => {
    it('terminates after maxIterations when agent always returns tool_use', async () => {
      const db = makeMockDb(); // no kd sectionMeta → no kd pipeline
      const generateWithTools = vi.fn().mockResolvedValue(makeToolUseResponse('prod-db__run_query'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 3 });

      // generateWithTools called exactly maxIterations times
      expect(generateWithTools).toHaveBeenCalledTimes(3);
    });

    it('iterationsRun reflects the actual number of iterations executed', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn().mockResolvedValue(makeToolUseResponse('prod-db__run_query'));
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 5 });

      expect(result.iterationsRun).toBe(5);
    });

    it('terminates early when agent returns end_turn before cap', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('prod-db__run_query'))
        .mockResolvedValueOnce(makeFinalTextResponse('Here is my analysis.'));
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 10 });

      expect(generateWithTools).toHaveBeenCalledTimes(2);
      expect(result.iterationsRun).toBe(2);
    });

    it('returns a fallback analysis string when maxIterations is exhausted without end_turn', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn().mockResolvedValue(makeToolUseResponse('prod-db__run_query'));
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 2 });

      expect(result.analysis).toMatch(/maximum iterations/i);
    });

    it('cap of 1 runs exactly one iteration', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn().mockResolvedValue(makeToolUseResponse('prod-db__run_query'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(generateWithTools).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // KD_SYSTEM_PROMPT_SNIPPET in system prompt
  // -------------------------------------------------------------------------

  describe('system prompt contains KD_SYSTEM_PROMPT_SNIPPET', () => {
    it('appends KD_SYSTEM_PROMPT_SNIPPET to the system prompt on initial analysis', async () => {
      const db = makeMockDb();
      let capturedSystemPrompt = '';
      const generateWithTools = vi.fn().mockImplementation(async (req: { systemPrompt: string }) => {
        capturedSystemPrompt = req.systemPrompt;
        return makeFinalTextResponse('analysis done');
      });
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(capturedSystemPrompt).toContain(KD_SYSTEM_PROMPT_SNIPPET);
    });

    it('appends KD_SYSTEM_PROMPT_SNIPPET during re-analysis', async () => {
      const db = makeMockDb();
      let capturedSystemPrompt = '';
      const generateWithTools = vi.fn().mockImplementation(async (req: { systemPrompt: string }) => {
        capturedSystemPrompt = req.systemPrompt;
        return makeFinalTextResponse('re-analysis done');
      });
      const deps = makeDeps(db, generateWithTools);

      const reanalysisCtx = {
        conversationHistory: '## Prior analysis',
        triggerReplyText: 'Please investigate further.',
      };

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), {
        maxIterations: 1,
        reanalysisCtx,
      });

      expect(capturedSystemPrompt).toContain(KD_SYSTEM_PROMPT_SNIPPET);
    });

    it('system prompt includes the ticket subject and category', async () => {
      const db = makeMockDb();
      let capturedSystemPrompt = '';
      const generateWithTools = vi.fn().mockImplementation(async (req: { systemPrompt: string }) => {
        capturedSystemPrompt = req.systemPrompt;
        return makeFinalTextResponse('done');
      });
      const deps = makeDeps(db, generateWithTools);

      const ctx = makePipelineCtx({
        emailSubject: 'Index fragmentation on prod',
        category: 'DATABASE_PERF',
      });

      await runFlatV2(deps, ctx, makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(capturedSystemPrompt).toContain('Index fragmentation on prod');
      expect(capturedSystemPrompt).toContain('DATABASE_PERF');
    });
  });

  // -------------------------------------------------------------------------
  // Tool calls dispatched through executeAgenticToolCall
  // -------------------------------------------------------------------------

  describe('tool call dispatch via executeAgenticToolCall', () => {
    it('calls executeAgenticToolCall once per tool_use block', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn()
        .mockResolvedValueOnce({
          ...BASE_AI_RESPONSE,
          stopReason: 'tool_use',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'prod-db__run_query', input: { sql: 'SELECT 1' } },
            { type: 'tool_use', id: 'tu-2', name: 'prod-db__run_query', input: { sql: 'SELECT 2' } },
          ],
          usage: { inputTokens: 50, outputTokens: 20 },
        })
        .mockResolvedValueOnce(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 5 });

      // Two tool_use blocks in iteration 1 → two calls
      expect(executeAgenticToolCallMock).toHaveBeenCalledTimes(2);
    });

    it('passes ticketId and clientId to executeAgenticToolCall', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('prod-db__run_query'))
        .mockResolvedValueOnce(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      const ctx = makePipelineCtx({ ticketId: 'ticket-abc', clientId: 'client-xyz' });

      await runFlatV2(deps, ctx, makeStep(), makeToolCtx(), { maxIterations: 5 });

      // executeAgenticToolCall(toolUse, mcpIntegrations, repoIdByPrefix, clientId, ticketId, failureTracker)
      expect(executeAgenticToolCallMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_use' }),
        expect.any(Map),
        expect.any(Map),
        'client-xyz',
        'ticket-abc',
        expect.any(Map),
      );
    });

    it('sends tool results as user message to the next iteration', async () => {
      const db = makeMockDb();
      const capturedMessages: unknown[] = [];

      executeAgenticToolCallMock.mockResolvedValue({
        toolUseId: 'tu-001',
        result: '{"rows":[]}',
        isError: false,
      });

      const generateWithTools = vi.fn().mockImplementation(async (req: { messages: unknown[] }) => {
        capturedMessages.push(...req.messages);
        if (req.messages.some((m: unknown) => (m as { role?: string }).role === 'user'
          && Array.isArray((m as { content?: unknown }).content))) {
          return makeFinalTextResponse('done with tool result');
        }
        return makeToolUseResponse('prod-db__run_query');
      });
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 5 });

      // After tool_use iteration, messages should include a user message with tool_result blocks
      const toolResultMessages = capturedMessages.filter(
        (m: unknown) =>
          (m as { role?: string }).role === 'user' &&
          Array.isArray((m as { content?: unknown }).content) &&
          ((m as { content: Array<{ type?: string }> }).content).some(b => b.type === 'tool_result'),
      );
      expect(toolResultMessages.length).toBeGreaterThan(0);
    });

    it('shares the failureTracker (Map) across iterations of the same run', async () => {
      const db = makeMockDb();

      // Track what tracker is passed each call
      const trackerRefs: Map<string, number>[] = [];
      executeAgenticToolCallMock.mockImplementation(
        async (_toolUse: unknown, _mcp: unknown, _repo: unknown, _cid: unknown, _tid: unknown, tracker?: Map<string, number>) => {
          if (tracker) trackerRefs.push(tracker);
          return { toolUseId: 'tu-001', result: '{}', isError: false };
        },
      );

      const generateWithTools = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('prod-db__run_query', 'tu-iter1'))
        .mockResolvedValueOnce(makeToolUseResponse('prod-db__run_query', 'tu-iter2'))
        .mockResolvedValueOnce(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 10 });

      // Both iterations should share the same Map instance
      expect(trackerRefs.length).toBe(2);
      expect(trackerRefs[0]).toBe(trackerRefs[1]);
    });
  });

  // -------------------------------------------------------------------------
  // KnowledgeDocSnapshot written per-run
  // -------------------------------------------------------------------------

  describe('KnowledgeDocSnapshot written at end-of-run', () => {
    it('writes a snapshot when knowledgeDocSectionMeta is populated', async () => {
      const kdWithMeta = {
        knowledgeDoc: initEmptyKnowledgeDoc(),
        knowledgeDocSectionMeta: {
          [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 50 },
        },
      };
      const db = makeMockDb({ knowledgeDocResult: kdWithMeta });
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(writeKnowledgeDocSnapshotMock).toHaveBeenCalledOnce();
      expect(writeKnowledgeDocSnapshotMock).toHaveBeenCalledWith(
        db,
        'ticket-flat-v2-test',
        expect.any(Number),
      );
    });

    it('does NOT write a snapshot when knowledgeDocSectionMeta is empty', async () => {
      const db = makeMockDb({
        knowledgeDocResult: {
          knowledgeDoc: initEmptyKnowledgeDoc(),
          knowledgeDocSectionMeta: {},
        },
      });
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(writeKnowledgeDocSnapshotMock).not.toHaveBeenCalled();
    });

    it('does NOT write a snapshot when knowledgeDocSectionMeta is null', async () => {
      const db = makeMockDb({
        knowledgeDocResult: {
          knowledgeDoc: null,
          knowledgeDocSectionMeta: null,
        },
      });
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(writeKnowledgeDocSnapshotMock).not.toHaveBeenCalled();
    });

    it('snapshot iteration matches the number of iterations run', async () => {
      const kdWithMeta = {
        knowledgeDoc: initEmptyKnowledgeDoc(),
        knowledgeDocSectionMeta: {
          [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 50 },
        },
      };
      const db = makeMockDb({ knowledgeDocResult: kdWithMeta });
      const generateWithTools = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('prod-db__run_query'))
        .mockResolvedValueOnce(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 10 });

      const [, , iterationArg] = writeKnowledgeDocSnapshotMock.mock.calls[0] as [unknown, unknown, number];
      expect(iterationArg).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // fallbackFillRequiredSections called with correct reason
  // -------------------------------------------------------------------------

  describe('fallbackFillRequiredSections end-of-run', () => {
    it('calls fallbackFillRequiredSections with "flat loop end" reason', async () => {
      const kdWithMeta = {
        knowledgeDoc: initEmptyKnowledgeDoc(),
        knowledgeDocSectionMeta: {
          [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 10 },
        },
      };
      const db = makeMockDb({ knowledgeDocResult: kdWithMeta });
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(fallbackFillRequiredSectionsMock).toHaveBeenCalledOnce();
      expect(fallbackFillRequiredSectionsMock).toHaveBeenCalledWith(
        db,
        'ticket-flat-v2-test',
        'flat loop end',
      );
    });

    it('does NOT call fallbackFillRequiredSections when sectionMeta is empty', async () => {
      const db = makeMockDb({
        knowledgeDocResult: {
          knowledgeDoc: initEmptyKnowledgeDoc(),
          knowledgeDocSectionMeta: {},
        },
      });
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(fallbackFillRequiredSectionsMock).not.toHaveBeenCalled();
    });

    it('does NOT call fallbackFillRequiredSections when ticket has no kd at all', async () => {
      const db = makeMockDb({ knowledgeDocResult: null });
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(fallbackFillRequiredSectionsMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // composeFinalAnalysis produces AI_ANALYSIS event content
  // -------------------------------------------------------------------------

  describe('composeFinalAnalysis output becomes the analysis result', () => {
    it('uses composeFinalAnalysis output as the final analysis when sectionMeta is present', async () => {
      composeFinalAnalysisMock.mockReturnValue('## Executive Summary\n\nComposed from KD sections.');

      const kdWithMeta = {
        knowledgeDoc: initEmptyKnowledgeDoc(),
        knowledgeDocSectionMeta: {
          [KnowledgeDocSectionKey.PROBLEM_STATEMENT]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 20 },
        },
      };
      const db = makeMockDb({ knowledgeDocResult: kdWithMeta });
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('Agent summary text.'));
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(composeFinalAnalysisMock).toHaveBeenCalledOnce();
      // The result.analysis goes through parseSufficiencyEvaluation which strips the
      // sufficiency block but otherwise passes through the text
      expect(result.analysis).toContain('Composed from KD sections.');
    });

    it('passes the agent executive summary (text blocks) to composeFinalAnalysis', async () => {
      const kdWithMeta = {
        knowledgeDoc: initEmptyKnowledgeDoc(),
        knowledgeDocSectionMeta: {
          [KnowledgeDocSectionKey.ROOT_CAUSE]: { updatedAt: '2025-01-01T00:00:00.000Z', length: 10 },
        },
      };
      const db = makeMockDb({ knowledgeDocResult: kdWithMeta });
      const generateWithTools = vi.fn().mockResolvedValue(
        makeFinalTextResponse('The root cause is a missing index.'),
      );
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      // Third argument to composeFinalAnalysis should be the agent's text output
      const [, , summaryArg] = composeFinalAnalysisMock.mock.calls[0] as [unknown, unknown, string];
      expect(summaryArg).toContain('The root cause is a missing index.');
    });

    it('does NOT call composeFinalAnalysis when sectionMeta is empty', async () => {
      const db = makeMockDb({
        knowledgeDocResult: {
          knowledgeDoc: initEmptyKnowledgeDoc(),
          knowledgeDocSectionMeta: {},
        },
      });
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('Agent plain text.'));
      const deps = makeDeps(db, generateWithTools);

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(composeFinalAnalysisMock).not.toHaveBeenCalled();
    });

    it('falls back to raw agent text when sectionMeta is absent (no KD compose)', async () => {
      const db = makeMockDb({ knowledgeDocResult: null });
      const generateWithTools = vi.fn().mockResolvedValue(
        makeFinalTextResponse('Plain agent analysis without KD.'),
      );
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(result.analysis).toContain('Plain agent analysis without KD.');
    });
  });

  // -------------------------------------------------------------------------
  // Token accumulation and return shape
  // -------------------------------------------------------------------------

  describe('result shape and token accumulation', () => {
    it('accumulates input and output tokens across multiple iterations', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn()
        .mockResolvedValueOnce({
          ...BASE_AI_RESPONSE,
          stopReason: 'tool_use',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'prod-db__run_query', input: {} },
          ],
          usage: { inputTokens: 100, outputTokens: 40 },
        })
        .mockResolvedValueOnce({
          ...BASE_AI_RESPONSE,
          stopReason: 'end_turn',
          contentBlocks: [{ type: 'text', text: 'final' }],
          usage: { inputTokens: 200, outputTokens: 60 },
        });
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 5 });

      expect(result.totalInputTokens).toBe(300);
      expect(result.totalOutputTokens).toBe(100);
    });

    it('includes toolCallLog entries for each dispatched tool', async () => {
      const db = makeMockDb();
      executeAgenticToolCallMock.mockResolvedValue({
        toolUseId: 'tu-1',
        result: '{"rows":[1,2,3]}',
        isError: false,
      });
      const generateWithTools = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('prod-db__run_query'))
        .mockResolvedValueOnce(makeFinalTextResponse('done'));
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 5 });

      expect(result.toolCallLog).toHaveLength(1);
      expect(result.toolCallLog[0].tool).toBe('prod-db__run_query');
    });

    it('returns a sufficiencyEval on the result', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn().mockResolvedValue(makeFinalTextResponse('analysis'));
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 });

      expect(result.sufficiencyEval).toBeDefined();
      expect(result.sufficiencyEval.status).toBe('SUFFICIENT');
    });
  });

  // -------------------------------------------------------------------------
  // Re-analysis path
  // -------------------------------------------------------------------------

  describe('re-analysis context', () => {
    it('uses conversation history in system prompt during re-analysis', async () => {
      const db = makeMockDb();
      let capturedSystemPrompt = '';
      const generateWithTools = vi.fn().mockImplementation(async (req: { systemPrompt: string }) => {
        capturedSystemPrompt = req.systemPrompt;
        return makeFinalTextResponse('re-analysis done');
      });
      const deps = makeDeps(db, generateWithTools);

      const reanalysisCtx = {
        conversationHistory: '## Prior findings\n\nRoot cause was X.',
        triggerReplyText: 'Please verify fix Y.',
      };

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), {
        maxIterations: 1,
        reanalysisCtx,
      });

      expect(capturedSystemPrompt).toContain('Prior findings');
      expect(capturedSystemPrompt).toContain('Root cause was X.');
    });

    it('uses triggerReplyText as the initial user message during re-analysis', async () => {
      const db = makeMockDb();
      const capturedMessages: Array<{ role: string; content: unknown }> = [];
      const generateWithTools = vi.fn().mockImplementation(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
        capturedMessages.push(...req.messages);
        return makeFinalTextResponse('done');
      });
      const deps = makeDeps(db, generateWithTools);

      const reanalysisCtx = {
        conversationHistory: '## History',
        triggerReplyText: 'Can you check table fragmentation?',
      };

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), {
        maxIterations: 1,
        reanalysisCtx,
      });

      const userMsg = capturedMessages.find(m => m.role === 'user');
      expect(userMsg?.content).toContain('Can you check table fragmentation?');
    });

    it('surfaces priorExecutiveSummary as a dedicated section ahead of the conversation history (#48 Item 7)', async () => {
      const db = makeMockDb();
      let capturedSystemPrompt = '';
      const generateWithTools = vi.fn().mockImplementation(async (req: { systemPrompt: string }) => {
        capturedSystemPrompt = req.systemPrompt;
        return makeFinalTextResponse('re-analysis done');
      });
      const deps = makeDeps(db, generateWithTools);

      const reanalysisCtx = {
        conversationHistory: '### [2026-04-20 09:00] Reply (chad@example.com)\n\nFollow-up.',
        triggerReplyText: 'Continue from where you left off.',
        priorExecutiveSummary: [
          '## Executive Summary',
          '',
          'Identified deadlock between Orders and OrderLines transactions.',
          '',
          '## Continuation Notes',
          '',
          'Budget cap fired before validating fix on staging. Next run should rerun the trace test.',
        ].join('\n'),
      };

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), {
        maxIterations: 1,
        reanalysisCtx,
      });

      expect(capturedSystemPrompt).toContain('## Prior Executive Summary');
      expect(capturedSystemPrompt).toContain('Identified deadlock between Orders and OrderLines transactions.');
      expect(capturedSystemPrompt).toContain('## Continuation Notes');
      expect(capturedSystemPrompt).toContain('rerun the trace test');

      // Ordering: Prior Executive Summary comes before Conversation History so
      // the strategist sees the prior findings as primary steering input.
      const priorIdx = capturedSystemPrompt.indexOf('## Prior Executive Summary');
      const histIdx = capturedSystemPrompt.indexOf('## Conversation History');
      expect(priorIdx).toBeGreaterThan(-1);
      expect(histIdx).toBeGreaterThan(-1);
      expect(priorIdx).toBeLessThan(histIdx);
    });

    it('omits the Prior Executive Summary section when reanalysisCtx has no priorExecutiveSummary', async () => {
      const db = makeMockDb();
      let capturedSystemPrompt = '';
      const generateWithTools = vi.fn().mockImplementation(async (req: { systemPrompt: string }) => {
        capturedSystemPrompt = req.systemPrompt;
        return makeFinalTextResponse('re-analysis done');
      });
      const deps = makeDeps(db, generateWithTools);

      const reanalysisCtx = {
        conversationHistory: '## History',
        triggerReplyText: 'Continue.',
      };

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), {
        maxIterations: 1,
        reanalysisCtx,
      });

      expect(capturedSystemPrompt).not.toContain('## Prior Executive Summary');
    });

    it('truncates a prior executive summary that exceeds the cap, keeping the tail (Continuation Notes)', async () => {
      const db = makeMockDb();
      let capturedSystemPrompt = '';
      const generateWithTools = vi.fn().mockImplementation(async (req: { systemPrompt: string }) => {
        capturedSystemPrompt = req.systemPrompt;
        return makeFinalTextResponse('re-analysis done');
      });
      const deps = makeDeps(db, generateWithTools);

      // Build a > 8000-char summary with the Continuation Notes at the end.
      const filler = 'X'.repeat(9000);
      const tail = '## Continuation Notes\n\nResume sub-task 3 (index review) — sub-tasks 1 and 2 already wrote findings.';
      const reanalysisCtx = {
        conversationHistory: '## History',
        triggerReplyText: 'Continue.',
        priorExecutiveSummary: `${filler}\n\n${tail}`,
      };

      await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), {
        maxIterations: 1,
        reanalysisCtx,
      });

      expect(capturedSystemPrompt).toContain('Prior executive summary truncated');
      expect(capturedSystemPrompt).toContain('## Continuation Notes');
      expect(capturedSystemPrompt).toContain('Resume sub-task 3');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('breaks the loop and returns the max-iterations fallback when AI throws a "tool support" error', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn().mockRejectedValue(
        new Error('tool support not available for this model'),
      );
      const deps = makeDeps(db, generateWithTools);

      const result = await runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 3 });

      // Fallback message produced for empty analysis
      expect(result.analysis).toMatch(/maximum iterations|agentic analysis reached/i);
      expect(generateWithTools).toHaveBeenCalledTimes(1);
    });

    it('re-throws non-tool-support AI errors', async () => {
      const db = makeMockDb();
      const generateWithTools = vi.fn().mockRejectedValue(new Error('Network unreachable'));
      const deps = makeDeps(db, generateWithTools);

      await expect(
        runFlatV2(deps, makePipelineCtx(), makeStep(), makeToolCtx(), { maxIterations: 1 }),
      ).rejects.toThrow('Network unreachable');
    });
  });
});
