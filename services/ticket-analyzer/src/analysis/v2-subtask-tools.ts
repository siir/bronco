/**
 * v2-only tool definitions for the orchestrated-v2 sub-task / strategist loop.
 *
 * These tools are NOT added to `buildAgenticTools` (shared.ts) because they are
 * specific to the orchestrated-v2 architecture and must not be visible to flat-v2,
 * flat-v1, or orchestrated-v1 agents.
 *
 * Three tools are defined here:
 *
 * 1. `finalize_subtask` — emitted by a sub-task to return structured results to
 *    the strategist. The sub-task loop detects this call and breaks out of its
 *    iteration loop, returning control with a structured summary.
 *
 * 2. `dispatch_subtasks` — emitted by the strategist to request a batch of
 *    parallel sub-tasks. Each entry carries an intent string, optional KD section
 *    keys to pre-pack as context, and an optional tool allowlist.
 *
 * 3. `complete_analysis` — emitted by the strategist when it has enough information
 *    to conclude the investigation. Carries the final executive summary.
 */

import type { AIToolDefinition } from '@bronco/shared-types';

/**
 * Tool added to every sub-task's tool list (alongside `buildAgenticTools` output).
 * When the model calls this, the sub-task runner breaks its loop and returns a
 * structured result to the strategist.
 */
export const FINALIZE_SUBTASK_TOOL: AIToolDefinition = {
  name: 'finalize_subtask',
  description: [
    'Call when you have completed your sub-task. Returns control to the orchestrator strategist.',
    'Include a short summary (100-300 words) of what you found and a list of KD section keys',
    'you updated so the strategist can read them on its next planning pass.',
    'Do NOT call this until you have finished all tool calls you intend to make — use your',
    'remaining iterations to gather data, then call finalize_subtask once as the last action.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: [
          'Concise findings, 100-300 words.',
          'Do NOT restate raw tool output — distill what the strategist needs to know.',
          'Include: what you found, what hypothesis it supports or refutes, and any open questions.',
        ].join(' '),
      },
      updatedKdSections: {
        type: 'array',
        items: { type: 'string' },
        description: [
          'KD section keys you wrote content to during this sub-task',
          '(e.g. ["evidence.deadlock-graph", "hypotheses.lock-wait"]).',
          'Include both top-level keys (rootCause) and dotted subsection keys (evidence.foo).',
        ].join(' '),
      },
    },
    required: ['summary', 'updatedKdSections'],
  },
};

/**
 * Tool added to the strategist's tool list. The strategist emits this with a
 * batch of sub-task descriptors to request parallel investigation.
 */
export const DISPATCH_SUBTASKS_TOOL: AIToolDefinition = {
  name: 'dispatch_subtasks',
  description: [
    'Dispatch a batch of parallel sub-tasks for investigation. Each sub-task runs as a',
    'focused mini-agent with its own tool loop. After all sub-tasks complete, their',
    'summaries are returned to you as a tool_result so you can plan the next iteration.',
    'Use this instead of attempting to investigate everything yourself — sub-tasks have',
    'direct tool access and can write findings to the knowledge doc via kd_* tools.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      subtasks: {
        type: 'array',
        description: 'Array of sub-task descriptors. Run in parallel; max 5 per dispatch.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Short identifier for this sub-task (e.g. "st-1", "deadlock-investigation"). Used in the result to correlate summaries.',
            },
            intent: {
              type: 'string',
              description: [
                'Clear, specific goal for this sub-task (1-3 sentences).',
                'Be precise: include system names, time ranges, query patterns, or error codes',
                'so the sub-task can issue targeted tool calls immediately.',
              ].join(' '),
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: [
                'Exact tool names this sub-task should use (copy from the Available Tools list).',
                'Always include platform__kd_add_subsection if the sub-task should record findings.',
                'Leave empty to give the sub-task access to all available tools.',
              ].join(' '),
            },
            contextKdSectionKeys: {
              type: 'array',
              items: { type: 'string' },
              description: [
                'KD section keys to pre-load as context for this sub-task',
                '(e.g. ["problemStatement", "evidence.prior-investigation"]).',
                'The runner reads these sections and includes them in the sub-task\'s user prompt.',
                'The sub-task can also call kd_read_section itself if it needs more.',
              ].join(' '),
            },
            model: {
              type: 'string',
              enum: ['haiku', 'sonnet', 'opus'],
              description: 'Model tier for this sub-task. Use haiku for simple data gathering, sonnet for moderate analysis, opus for complex reasoning.',
            },
          },
          required: ['id', 'intent'],
        },
      },
    },
    required: ['subtasks'],
  },
};

/**
 * Tool added to the strategist's tool list. The strategist emits this when the
 * investigation is complete and it is ready to provide a final executive summary.
 */
export const COMPLETE_ANALYSIS_TOOL: AIToolDefinition = {
  name: 'complete_analysis',
  description: [
    'Call when the investigation is complete and you have a final conclusion.',
    'The executive summary you provide here will be combined with the knowledge document',
    '(Problem Statement, Root Cause, Recommended Fix, Risks) to produce the final analysis.',
    'Include a ---SUFFICIENCY--- block at the end of the finalAnalysis if you have enough',
    'information to propose a resolution plan (or if you need user input).',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      finalAnalysis: {
        type: 'string',
        description: [
          'Concise executive summary of findings (markdown). Keep it focused — the detail',
          'belongs in the knowledge doc sections (Root Cause, Recommended Fix, Risks, etc.).',
          'Optionally include a ---SUFFICIENCY--- block at the end.',
        ].join(' '),
      },
    },
    required: ['finalAnalysis'],
  },
};

// ---------------------------------------------------------------------------
// Sub-task run result — returned from the stateful loop per sub-task
// ---------------------------------------------------------------------------

export const SubTaskStopReason = {
  FINALIZED: 'FINALIZED',
  NO_TOOL_USE_ENDED: 'NO_TOOL_USE_ENDED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  TOOL_NOT_SUPPORTED: 'TOOL_NOT_SUPPORTED',
  ERROR: 'ERROR',
} as const;
export type SubTaskStopReason = (typeof SubTaskStopReason)[keyof typeof SubTaskStopReason];

export interface SubTaskRunResult {
  /** Short ID provided by the strategist in dispatch_subtasks (e.g. "st-1"). */
  subTaskId: string;
  /** The intent string from the dispatch_subtasks call. */
  intent: string;
  /** Distilled summary from finalize_subtask.summary, or a fallback message. */
  summary: string;
  /** KD section keys written during this sub-task (from finalize_subtask.updatedKdSections). */
  updatedKdSections: string[];
  /** Number of model iterations consumed. */
  iterationsUsed: number;
  /** Total tokens used (input + output) by this sub-task. */
  tokensUsed: number;
  /** Why the sub-task loop exited. */
  stopReason: SubTaskStopReason;
  /** Total input tokens for budget/accounting. */
  inputTokens: number;
  /** Total output tokens for budget/accounting. */
  outputTokens: number;
  /** Raw tool call log entries for telemetry. */
  toolCalls: Array<{ tool: string; system?: string; input: Record<string, unknown>; output: string; durationMs: number }>;
}
