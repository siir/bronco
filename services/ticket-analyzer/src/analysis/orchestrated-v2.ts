import { createHash, randomUUID } from 'node:crypto';
import {
  createLogger,
  initEmptyKnowledgeDoc,
  loadKnowledgeDoc,
  readSection,
  updateSection,
  withTicketLock,
} from '@bronco/shared-utils';
import { KnowledgeDocSectionKey, KnowledgeDocUpdateMode, TaskType } from '@bronco/shared-types';
import type {
  AITextBlock,
  AIToolDefinition,
  AIToolResultBlock,
  AIToolUseBlock,
  AIMessage,
} from '@bronco/shared-types';
import {
  buildArtifactCatalog,
  buildRepoNudgeSnippet,
  buildTruncatedPreview,
  chunkArray,
  executeAgenticToolCall,
  getToolResultMaxTokens,
  IRRELEVANT_SIGNALS,
  ORCHESTRATED_SYSTEM_PROMPT,
  parseSufficiencyEvaluation,
  ReanalysisMode,
  resolveMaxParallelTasks,
  resolveOrchestratedModelMap,
  resolveTaskTools,
  saveMcpToolArtifact,
  shouldTruncate,
  type AgenticToolContext,
  type AnalysisDeps,
  type AnalysisPipelineContext,
  type AnalysisResult,
  type McpIntegrationInfo,
  type ReanalysisContext,
  type StrategyStep,
} from './shared.js';
import {
  composeFinalAnalysis,
  fallbackFillRequiredSections,
  writeKnowledgeDocSnapshot,
  writeStallMarker,
} from './v2-knowledge-doc.js';
import {
  AD_HOC_QUERY_PAIRING_SNIPPET,
  KD_SYSTEM_PROMPT_SNIPPET,
  NO_STALL_SYSTEM_PROMPT_SNIPPET,
  PREFER_EXISTING_TOOLS_SNIPPET,
  REQUEST_NEW_TOOL_SNIPPET,
  TOOL_ERROR_SYSTEM_PROMPT_SNIPPET,
  TRUNCATION_SYSTEM_PROMPT_SNIPPET,
} from './v2-prompts.js';
import {
  FINALIZE_SUBTASK_TOOL,
  DISPATCH_SUBTASKS_TOOL,
  COMPLETE_ANALYSIS_TOOL,
  SubTaskStopReason,
  type SubTaskRunResult,
} from './v2-subtask-tools.js';

const logger = createLogger('ticket-analyzer');

// ---------------------------------------------------------------------------
// Token budget constants
// ---------------------------------------------------------------------------

/**
 * Maximum output tokens for the orchestrator strategist (Opus) on a single
 * generateWithTools call. Set to 8192 — Anthropic's documented max output for
 * Opus without extended thinking. The strategist's final-iteration JSON envelope
 * can be large (accumulated findings + executive summary), so a low default
 * causes truncation and triggers the raw-text fallback (issue #383).
 *
 * Note: this file always sets `maxTokens` explicitly on each strategist request.
 * `deps.loadDefaultMaxTokens()` is consulted first; it reads the
 * `system-config-analysis-strategy` AppSetting's `defaultMaxTokens` field.
 * This constant is the hard-coded fallback when that setting is absent or zero.
 * Because `maxTokens` is always explicitly set, `AiModelConfig.maxTokens`
 * per-task/per-client overrides do NOT apply to strategist calls.
 */
const STRATEGIST_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Sub-task budget constants
// ---------------------------------------------------------------------------

/** Maximum model iterations per sub-task (each iteration = one generateWithTools call). */
const SUB_TASK_ITERATION_CAP = 8;
/** Maximum total tokens (input + output) a single sub-task may consume. */
const SUB_TASK_TOKEN_BUDGET = 50_000;
/** Maximum tool calls a single sub-task may make (not counting finalize_subtask). */
const SUB_TASK_CALL_BUDGET = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fallback content when a sub-task exhausts its budget without calling finalize_subtask.
 * Uses the first tool call's output preview so the Run Log still has something actionable.
 * Empty tool-calls array → placeholder string.
 */
function fallbackFromToolResults(toolCalls: SubTaskRunResult['toolCalls']): string {
  if (toolCalls.length === 0) return 'Sub-task produced no text output and no tool calls.';
  const first = toolCalls[0];
  const preview = (first.output ?? '').slice(0, 500);
  return `No summary text; first tool (${first.tool}) output preview:\n${preview}`;
}

/**
 * Read a KD section from an already-loaded ticket document and format it as a
 * context block for injection into a sub-task's user prompt.
 * Returns empty string when the section is empty.
 * The caller is responsible for loading the ticket once via `loadKnowledgeDoc`
 * to avoid N separate DB queries when multiple sections are requested.
 */
function formatKdSectionFromDoc(
  knowledgeDoc: string,
  sectionMeta: unknown,
  sectionKey: string,
): string {
  const { content } = readSection(knowledgeDoc, sectionMeta, sectionKey as KnowledgeDocSectionKey);
  if (!content.trim()) return '';
  return `### Knowledge Doc — ${sectionKey}\n${content.trim()}`;
}

// ---------------------------------------------------------------------------
// Sub-task stateful loop
// ---------------------------------------------------------------------------

/**
 * Run a single sub-task as a stateful message loop.
 *
 * The loop appends assistant responses and tool results to a growing `messages`
 * array on each iteration (flat-v2 pattern). The loop terminates when the model
 * calls `finalize_subtask`, when `stop_reason !== 'tool_use'`, or when any
 * budget is exhausted.
 *
 * The `finalize_subtask` tool is mixed into the tool list alongside whatever
 * `buildAgenticTools` returned — it is NOT part of `buildAgenticTools` because
 * it is orchestrated-v2–only and must not be visible to flat-v2 / v1 agents.
 */
async function runSubTaskLoop(
  deps: AnalysisDeps,
  ticketId: string,
  clientId: string,
  category: string,
  skipClientMemory: boolean,
  subTaskId: string,
  intent: string,
  contextKdSections: string[],
  tools: AIToolDefinition[],
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  repoIdByPrefix: Map<string, string>,
  subTaskSystemPrompt: string,
  model: string,
  orchestration?: { id: string; iteration: number; parentLogId?: string },
  toolResultMaxTokens?: number,
  defaultMaxTokens?: number,
): Promise<SubTaskRunResult> {
  const { ai, appLog } = deps;

  const toolCallLog: SubTaskRunResult['toolCalls'] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalToolCalls = 0;
  const failureTracker = new Map<string, number>();

  // Build the tool list: requested tools + finalize_subtask (always appended)
  const toolsWithFinalize: AIToolDefinition[] = [
    ...tools,
    FINALIZE_SUBTASK_TOOL,
  ];

  // Compose the user prompt for this sub-task
  const contextParts: string[] = [];
  if (contextKdSections.length > 0) {
    // Load the knowledge doc once and read all requested sections from it —
    // avoids N separate DB round-trips when multiple section keys are requested.
    const kdTicket = await loadKnowledgeDoc(deps.db, ticketId);
    if (kdTicket?.knowledgeDoc) {
      const sectionBlocks = contextKdSections.map(key =>
        formatKdSectionFromDoc(kdTicket.knowledgeDoc!, kdTicket.knowledgeDocSectionMeta, key),
      );
      const nonEmpty = sectionBlocks.filter(Boolean);
      if (nonEmpty.length > 0) {
        contextParts.push('## Context from Knowledge Document\n\n' + nonEmpty.join('\n\n'));
      }
    }
  }
  const budgetLine = `## Budget\nMax ${SUB_TASK_ITERATION_CAP} iterations, max ${SUB_TASK_TOKEN_BUDGET.toLocaleString()} tokens total, max ${SUB_TASK_CALL_BUDGET} tool calls. Call \`finalize_subtask\` once you are done — do not wait until budget is exhausted.`;
  const userPrompt = [
    '## Intent',
    intent,
    ...contextParts,
    budgetLine,
  ].join('\n\n');

  // Initialise the message array: [system is separate, first user turn here]
  const messages: AIMessage[] = [
    { role: 'user', content: userPrompt },
  ];

  const subTaskLogId = randomUUID();
  const orchCtx = orchestration
    ? {
        orchestrationId: orchestration.id,
        orchestrationIteration: orchestration.iteration,
        isSubTask: true,
        logId: subTaskLogId,
        ...(orchestration.parentLogId ? { parentLogId: orchestration.parentLogId, parentLogType: 'ai' as const } : {}),
      }
    : { logId: subTaskLogId };

  let lastIterationRun = 0;
  for (let iteration = 0; iteration < SUB_TASK_ITERATION_CAP; iteration++) {
    lastIterationRun = iteration + 1;
    const tokensSoFar = totalInputTokens + totalOutputTokens;
    if (tokensSoFar >= SUB_TASK_TOKEN_BUDGET) {
      appLog.info(
        `Sub-task ${subTaskId} exhausted token budget (${tokensSoFar} >= ${SUB_TASK_TOKEN_BUDGET}) at iteration ${iteration + 1}`,
        { ticketId, subTaskId, tokensSoFar, iteration: iteration + 1 },
        ticketId,
        'ticket',
      );
      break;
    }
    if (totalToolCalls >= SUB_TASK_CALL_BUDGET) {
      appLog.info(
        `Sub-task ${subTaskId} exhausted call budget (${totalToolCalls} >= ${SUB_TASK_CALL_BUDGET}) at iteration ${iteration + 1}`,
        { ticketId, subTaskId, totalToolCalls, iteration: iteration + 1 },
        ticketId,
        'ticket',
      );
      break;
    }

    appLog.info(
      `Sub-task ${subTaskId} iteration ${iteration + 1}/${SUB_TASK_ITERATION_CAP}`,
      { ticketId, subTaskId, iteration: iteration + 1, tokensSoFar },
      ticketId,
      'ticket',
    );

    let response;
    try {
      response = await ai.generateWithTools({
        taskType: TaskType.DEEP_ANALYSIS,
        context: {
          ticketId,
          clientId,
          entityId: ticketId,
          entityType: 'ticket',
          ticketCategory: category,
          skipClientMemory,
          strategy: 'orchestrated' as const,
          strategyVersion: 'v2' as const,
          ...orchCtx,
        },
        messages,
        tools: toolsWithFinalize,
        systemPrompt: subTaskSystemPrompt,
        providerOverride: 'CLAUDE',
        modelOverride: model,
        maxTokens: defaultMaxTokens ?? 4096,
      });
    } catch (error) {
      if (error instanceof Error && /tool/i.test(error.message) && /support/i.test(error.message)) {
        appLog.warn(
          `Sub-task ${subTaskId}: provider does not support tool use — returning early`,
          { ticketId, subTaskId, error: error.message },
          ticketId,
          'ticket',
        );
        return {
          subTaskId,
          intent,
          summary: `Sub-task could not run: provider does not support tool use (${error.message})`,
          updatedKdSections: [],
          iterationsUsed: iteration + 1,
          tokensUsed: totalInputTokens + totalOutputTokens,
          stopReason: SubTaskStopReason.TOOL_NOT_SUPPORTED,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolCalls: toolCallLog,
        };
      }
      throw error;
    }

    totalInputTokens += response.usage?.inputTokens ?? 0;
    totalOutputTokens += response.usage?.outputTokens ?? 0;

    // Append assistant turn to conversation
    messages.push({ role: 'assistant', content: response.contentBlocks });

    if (response.stopReason !== 'tool_use') {
      // Model ended turn without calling any tool (not even finalize_subtask)
      const textSummary = response.contentBlocks
        .filter((b): b is AITextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();

      appLog.info(
        `Sub-task ${subTaskId} ended without finalize_subtask at iteration ${iteration + 1} (stop_reason=${response.stopReason})`,
        { ticketId, subTaskId, iteration: iteration + 1, stopReason: response.stopReason },
        ticketId,
        'ticket',
      );

      return {
        subTaskId,
        intent,
        summary: textSummary || '(sub-task ended without finalize_subtask call)',
        updatedKdSections: [],
        iterationsUsed: iteration + 1,
        tokensUsed: totalInputTokens + totalOutputTokens,
        stopReason: SubTaskStopReason.NO_TOOL_USE_ENDED,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: toolCallLog,
      };
    }

    // Separate finalize_subtask from regular tool calls.
    // Execute all regular tools FIRST so that kd_* writes and data-gathering calls
    // are not silently dropped when finalize_subtask appears in the same assistant
    // turn. The finalize result is handled after the regular tool loop completes.
    const finalizeCall = response.contentBlocks.find(
      (b): b is AIToolUseBlock => b.type === 'tool_use' && b.name === 'finalize_subtask',
    );
    const toolUseBlocks = response.contentBlocks.filter(
      (b): b is AIToolUseBlock => b.type === 'tool_use' && b.name !== 'finalize_subtask',
    );

    const toolResults: AIToolResultBlock[] = [];

    for (const toolUse of toolUseBlocks) {
      const start = Date.now();
      const result = await executeAgenticToolCall(
        toolUse,
        mcpIntegrations,
        repoIdByPrefix,
        clientId,
        ticketId,
        failureTracker,
      );
      const elapsed = Date.now() - start;

      const fullResult = result.result;
      const fullSizeChars = fullResult.length;
      const threshold = toolResultMaxTokens ?? 4000;
      const artifactId = deps.artifactStoragePath && !result.isError ? randomUUID() : undefined;
      const truncated = !result.isError && !!artifactId && shouldTruncate(fullResult, threshold);
      const contentForModel = truncated && artifactId
        ? buildTruncatedPreview(fullResult, artifactId)
        : fullResult;

      toolCallLog.push({
        tool: toolUse.name,
        system: (toolUse.input as Record<string, unknown>)?.system_name as string | undefined,
        input: toolUse.input,
        output: fullResult.slice(0, 500),
        durationMs: elapsed,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: contentForModel,
        ...(result.isError ? { is_error: true } : {}),
      });

      if (deps.artifactStoragePath && !result.isError) {
        void saveMcpToolArtifact(deps.db, ticketId, toolUse.name, fullResult, deps.artifactStoragePath, artifactId).catch(err => {
          logger.warn({ err, ticketId, toolName: toolUse.name }, 'Failed to persist MCP tool artifact');
        });
      }

      appLog.info(
        `Sub-task ${subTaskId} tool call: ${toolUse.name} (${elapsed}ms)`,
        {
          ticketId,
          subTaskId,
          tool: toolUse.name,
          durationMs: elapsed,
          iteration: iteration + 1,
          params: toolUse.input ? JSON.stringify(toolUse.input).slice(0, 1000) : null,
          resultPreview: fullResult?.slice(0, 2000) ?? null,
          isError: result.isError ?? false,
          truncated,
          fullSizeChars,
          parentLogId: subTaskLogId,
          parentLogType: 'ai',
          ...(artifactId ? { artifactId } : {}),
        },
        ticketId,
        'ticket',
      );
    }

    totalToolCalls += toolResults.length;

    // Append regular tool results as next user turn (may be empty if only finalize_subtask was called)
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    // Now handle finalize_subtask — all sibling tool calls have been executed above
    // so their KD writes are flushed before we return control to the orchestrator.
    if (finalizeCall) {
      const input = finalizeCall.input as { summary?: string; updatedKdSections?: string[] };
      const summary = typeof input.summary === 'string' ? input.summary : '(sub-task called finalize_subtask without a summary)';
      const updatedKdSections = Array.isArray(input.updatedKdSections)
        ? (input.updatedKdSections as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];

      // Emit a synthetic tool_result so the conversation stays well-formed.
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: finalizeCall.id,
            content: 'Sub-task finalized. Control returned to orchestrator.',
          } satisfies AIToolResultBlock,
        ],
      });

      appLog.info(
        `Sub-task ${subTaskId} finalized at iteration ${iteration + 1}: ${summary.slice(0, 200)}`,
        { ticketId, subTaskId, iteration: iteration + 1, updatedKdSections, summaryPreview: summary.slice(0, 500) },
        ticketId,
        'ticket',
      );

      return {
        subTaskId,
        intent,
        summary,
        updatedKdSections,
        iterationsUsed: iteration + 1,
        tokensUsed: totalInputTokens + totalOutputTokens,
        stopReason: SubTaskStopReason.FINALIZED,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: toolCallLog,
      };
    }
  }

  // Budget exhausted — compose best-effort summary from last tool calls.
  // `lastIterationRun` is the actual number of iterations that started (including
  // the one that hit a budget ceiling at the top of the loop).
  const partialSummary = toolCallLog.length > 0
    ? fallbackFromToolResults(toolCallLog)
    : '(sub-task exhausted budget without producing a summary)';

  appLog.info(
    `Sub-task ${subTaskId} exhausted budget (iterationsUsed=${lastIterationRun}, toolCalls=${totalToolCalls})`,
    { ticketId, subTaskId, tokensUsed: totalInputTokens + totalOutputTokens, totalToolCalls },
    ticketId,
    'ticket',
  );

  return {
    subTaskId,
    intent,
    summary: partialSummary,
    updatedKdSections: [],
    iterationsUsed: lastIterationRun,
    tokensUsed: totalInputTokens + totalOutputTokens,
    stopReason: SubTaskStopReason.BUDGET_EXHAUSTED,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolCalls: toolCallLog,
  };
}

// ---------------------------------------------------------------------------
// Sub-task dispatcher (replaces executeOrchestratedSubTaskV2)
// ---------------------------------------------------------------------------

/**
 * Dispatch a single sub-task using the stateful loop.
 * Handles tool resolution, system-prompt construction, and fuzzy-tool-retry
 * logic (retained from the prior implementation for robustness).
 */
async function executeOrchestratedSubTaskV2(
  deps: AnalysisDeps,
  ticketId: string,
  clientId: string,
  category: string,
  clientContext: string,
  environmentContext: string,
  task: {
    id: string;
    prompt: string;
    tools: string[];
    model: string;
    contextKdSectionKeys?: string[];
    priorArtifactIds?: string[];
  },
  agenticTools: AIToolDefinition[],
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  repoIdByPrefix: Map<string, string>,
  orchestration?: { id: string; iteration: number; parentLogId?: string },
  modelMap?: Record<string, string>,
  toolResultMaxTokens?: number,
): Promise<SubTaskRunResult> {
  const map = modelMap ?? {};
  const model = map[task.model] ?? map.sonnet ?? 'claude-sonnet-4-6';
  const defaultMaxTokens = await deps.loadDefaultMaxTokens?.() ?? undefined;

  const skipClientMemory = !!clientContext;
  const combinedContext = [clientContext, environmentContext].filter(Boolean).join('\n\n');
  const subTaskInstructions = [
    'You are a focused investigator. Execute your sub-task intent thoroughly using the available tools.',
    'Record each finding by calling kd_* tools (platform__kd_add_subsection, platform__kd_update_section).',
    'Do NOT dump raw tool output into your response — the knowledge doc is the source of truth.',
    'When you have completed your investigation, call `finalize_subtask` with a concise summary (100-300 words)',
    'and the list of KD section keys you updated. Call `finalize_subtask` as the LAST action — do not call',
    'it before you have gathered all the data you need.',
  ].join(' ');

  const priorArtifactsHint = task.priorArtifactIds && task.priorArtifactIds.length > 0
    ? `\n\n## Prior Artifacts You May Need\nThese artifact IDs from prior runs may be relevant. Read them via \`platform__read_tool_result_artifact\` before re-querying:\n${task.priorArtifactIds.map(id => `- ${id}`).join('\n')}`
    : '';

  const subTaskSystemPrompt = combinedContext
    ? `${subTaskInstructions}\n\n${combinedContext}\n${TRUNCATION_SYSTEM_PROMPT_SNIPPET}\n${PREFER_EXISTING_TOOLS_SNIPPET}\n${AD_HOC_QUERY_PAIRING_SNIPPET}\n${REQUEST_NEW_TOOL_SNIPPET}\n${TOOL_ERROR_SYSTEM_PROMPT_SNIPPET}\n${KD_SYSTEM_PROMPT_SNIPPET}${priorArtifactsHint}`
    : `${subTaskInstructions}\n${TRUNCATION_SYSTEM_PROMPT_SNIPPET}\n${PREFER_EXISTING_TOOLS_SNIPPET}\n${AD_HOC_QUERY_PAIRING_SNIPPET}\n${REQUEST_NEW_TOOL_SNIPPET}\n${TOOL_ERROR_SYSTEM_PROMPT_SNIPPET}\n${KD_SYSTEM_PROMPT_SNIPPET}${priorArtifactsHint}`;

  // Resolve tools using ranked matching (exact → base name → substring → fuzzy)
  const resolution = task.tools.length > 0
    ? resolveTaskTools(task.tools, agenticTools)
    : { resolved: [] as AIToolDefinition[], fuzzy: new Map<string, Array<{ tool: AIToolDefinition; score: number }>>(), unmatched: [] as string[] };

  // Build initial tool set: resolved + top fuzzy candidate per entry + ALWAYS include kd_* tools
  const kdTools = agenticTools.filter(t => t.name.startsWith('platform__kd_'));
  const initialTools = [...resolution.resolved];
  const initialToolNames = new Set(initialTools.map(t => t.name));
  const fuzzyUsed = new Map<string, { tool: AIToolDefinition; score: number; candidateIndex: number }>();

  for (const [reqName, candidates] of resolution.fuzzy) {
    if (candidates.length > 0 && !initialToolNames.has(candidates[0].tool.name)) {
      initialTools.push(candidates[0].tool);
      initialToolNames.add(candidates[0].tool.name);
      fuzzyUsed.set(reqName, { ...candidates[0], candidateIndex: 0 });
    }
  }

  for (const kd of kdTools) {
    if (!initialToolNames.has(kd.name)) {
      initialTools.push(kd);
      initialToolNames.add(kd.name);
    }
  }

  // Also include read_tool_result_artifact so sub-tasks can page into artifacts
  const artifactTool = agenticTools.find(t => t.name === 'platform__read_tool_result_artifact');
  if (artifactTool && !initialToolNames.has(artifactTool.name)) {
    initialTools.push(artifactTool);
    initialToolNames.add(artifactTool.name);
  }

  // If tools were requested but none matched at all (kd_* tools excluded), return early with guidance
  const nonKdInitial = initialTools.filter(t => !t.name.startsWith('platform__kd_') && t.name !== 'platform__read_tool_result_artifact');
  if (task.tools.length > 0 && nonKdInitial.length === 0) {
    const MAX_TOOLS_IN_ERROR = 10;
    const toolNames = agenticTools.map(t => t.name);
    const availableList = toolNames.length > MAX_TOOLS_IN_ERROR
      ? `${toolNames.slice(0, MAX_TOOLS_IN_ERROR).join(', ')} … (${toolNames.length - MAX_TOOLS_IN_ERROR} more)`
      : toolNames.join(', ');
    return {
      subTaskId: task.id,
      intent: task.prompt,
      summary: `Tool resolution failed: requested [${task.tools.join(', ')}] but no matching tools found. Available tools: [${availableList}]. Use exact tool names from this list.`,
      updatedKdSections: [],
      iterationsUsed: 0,
      tokensUsed: 0,
      stopReason: SubTaskStopReason.ERROR,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
    };
  }

  // Run the stateful loop
  const firstResult = await runSubTaskLoop(
    deps,
    ticketId,
    clientId,
    category,
    skipClientMemory,
    task.id,
    task.prompt,
    task.contextKdSectionKeys ?? [],
    // When task.tools is empty, give the sub-task all available tools
    task.tools.length === 0 ? agenticTools : initialTools,
    mcpIntegrations,
    repoIdByPrefix,
    subTaskSystemPrompt,
    model,
    orchestration,
    toolResultMaxTokens,
    defaultMaxTokens,
  );

  // --- Retry with alternate fuzzy candidates if first pass seems irrelevant ---
  const lowered = firstResult.summary.slice(0, 500).toLowerCase();
  const seemsIrrelevant = firstResult.stopReason === SubTaskStopReason.ERROR
    || IRRELEVANT_SIGNALS.some(s => lowered.includes(s));

  if (seemsIrrelevant && fuzzyUsed.size > 0) {
    for (const [reqName, used] of fuzzyUsed) {
      const candidates = resolution.fuzzy.get(reqName);
      if (!candidates || candidates.length <= used.candidateIndex + 1) continue;

      const nextCandidate = candidates[used.candidateIndex + 1];
      const retryTools = initialTools
        .filter(t => t.name !== used.tool.name)
        .concat(nextCandidate.tool);

      const retryResult = await runSubTaskLoop(
        deps,
        ticketId,
        clientId,
        category,
        skipClientMemory,
        task.id,
        task.prompt,
        task.contextKdSectionKeys ?? [],
        retryTools,
        mcpIntegrations,
        repoIdByPrefix,
        subTaskSystemPrompt,
        model,
        orchestration,
        toolResultMaxTokens,
        defaultMaxTokens,
      );

      const retryLowered = retryResult.summary.slice(0, 500).toLowerCase();
      if (!IRRELEVANT_SIGNALS.some(s => retryLowered.includes(s))) {
        return retryResult;
      }

      // Last retry — annotate with warning
      return {
        ...retryResult,
        summary: `Warning: Tool match was uncertain (fuzzy match score: ${nextCandidate.score.toFixed(2)}) — results may not be fully relevant.\n\n${retryResult.summary}`,
      };
    }
  }

  return firstResult;
}

// ---------------------------------------------------------------------------
// Strategist tool definitions (kd_* read-only + dispatch + complete)
// ---------------------------------------------------------------------------

/**
 * Build the tool list for the orchestrator strategist.
 * Includes:
 *   - platform__kd_read_toc — so the strategist can see what's been documented
 *   - platform__kd_read_section — so it can read specific sections
 *   - platform__read_tool_result_artifact — so it can page into sub-task artifacts
 *   - dispatch_subtasks — the primary work-dispatch mechanism
 *   - complete_analysis — the termination signal
 *
 * Write tools (kd_update_section, kd_add_subsection) are intentionally excluded
 * from the strategist — only sub-tasks should write to the knowledge doc.
 */
function buildStrategistTools(agenticTools: AIToolDefinition[]): AIToolDefinition[] {
  const kdReadToc = agenticTools.find(t => t.name === 'platform__kd_read_toc');
  const kdReadSection = agenticTools.find(t => t.name === 'platform__kd_read_section');
  const readArtifact = agenticTools.find(t => t.name === 'platform__read_tool_result_artifact');

  const tools: AIToolDefinition[] = [
    DISPATCH_SUBTASKS_TOOL,
    COMPLETE_ANALYSIS_TOOL,
  ];
  if (kdReadToc) tools.push(kdReadToc);
  if (kdReadSection) tools.push(kdReadSection);
  if (readArtifact) tools.push(readArtifact);
  return tools;
}

// ---------------------------------------------------------------------------
// Orchestrated v2 strategist system prompt (updated for tool-use loop)
// ---------------------------------------------------------------------------

const ORCHESTRATED_V2_STRATEGIST_PROMPT = [
  ORCHESTRATED_SYSTEM_PROMPT,
  '',
  '## Orchestration Tools (v2)',
  '',
  'You now have access to the following tools:',
  '',
  '**`dispatch_subtasks`** — Dispatch a batch of parallel sub-task agents to investigate specific questions.',
  'Each sub-task has its own tool loop and writes findings to the knowledge doc via kd_* tools.',
  'After sub-tasks complete, their summaries are returned to you as a tool_result.',
  '',
  '**`complete_analysis`** — Call when the investigation is complete. Include a concise executive summary.',
  'The knowledge doc (Root Cause, Recommended Fix, Risks) will be merged with your summary automatically.',
  '',
  '**`platform__kd_read_toc`** / **`platform__kd_read_section`** — Read the knowledge doc directly.',
  'Use these between sub-task batches to see what has been documented before planning the next batch.',
  '',
  '**`platform__read_tool_result_artifact`** — Page into a truncated tool-result artifact by ID.',
  '',
  '## Workflow',
  '1. On the first iteration, call `dispatch_subtasks` with an initial batch of sub-tasks.',
  '2. After sub-tasks return, optionally call `platform__kd_read_toc` and `platform__kd_read_section`',
  '   to review what was documented, then either dispatch another batch or call `complete_analysis`.',
  '3. Call `complete_analysis` when you have enough evidence for a root cause and recommendation.',
  '',
  '## Knowledge Document Discipline',
  'You are the PLANNER — sub-tasks are the WRITERS. Do not write to the knowledge doc yourself.',
  'Instruct sub-tasks to call platform__kd_add_subsection / platform__kd_update_section to record findings.',
  'Provide `contextKdSectionKeys` in dispatch_subtasks so sub-tasks receive relevant prior context.',
  '',
  TRUNCATION_SYSTEM_PROMPT_SNIPPET,
  PREFER_EXISTING_TOOLS_SNIPPET,
  AD_HOC_QUERY_PAIRING_SNIPPET,
  REQUEST_NEW_TOOL_SNIPPET,
  TOOL_ERROR_SYSTEM_PROMPT_SNIPPET,
  KD_SYSTEM_PROMPT_SNIPPET,
  NO_STALL_SYSTEM_PROMPT_SNIPPET,
].join('\n');

// ---------------------------------------------------------------------------
// Main orchestrated v2 entry point
// ---------------------------------------------------------------------------

/**
 * Tool names that count as a knowledge-doc write. Reads (kd_read_toc /
 * kd_read_section) do NOT count — the stall detector (#366) treats pure
 * reads as no-progress. Update in lockstep with MCP platform's kd_* tool
 * registration in `mcp-servers/platform/src/tools/knowledge-doc.ts`.
 */
const KD_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'platform__kd_update_section',
  'platform__kd_add_subsection',
]);

function countKdWrites(toolCalls: ReadonlyArray<{ tool: string }>): number {
  let n = 0;
  for (const tc of toolCalls) {
    if (KD_WRITE_TOOL_NAMES.has(tc.tool)) n++;
  }
  return n;
}

/**
 * Cheap fingerprint of an orchestrator response. Used to detect N consecutive
 * iterations that return nearly-identical plans (the #366 symptom). We strip
 * whitespace + lowercase before hashing so that trivial cosmetic deltas don't
 * mask a stuck agent; we take only the first 4k chars so huge pasted contexts
 * don't dominate the fingerprint.
 */
function hashOrchestratorResponse(content: string): string {
  const normalized = content.slice(0, 4000).replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha1').update(normalized).digest('hex');
}

/**
 * Stall-detection state for a single orchestrated-v2 run. The three rules map
 * 1:1 to #366:
 *   1. `consecutiveNoProgress >= 2` — two iterations in a row with zero
 *      sub-task dispatches AND zero KD writes.
 *   2. `consecutiveSameHash >= 3` — three iterations in a row with identical
 *      (normalized) strategist response hashes.
 *   3. `totalKdWrites === 0 && completedIterations >= 3` — the agent has had
 *      three full turns without touching the doc.
 *
 * Returns a human-readable reason string when any rule fires, otherwise null.
 * State is mutated in-place so the caller can keep running counters across the
 * loop; call this at the end of every iteration after the sub-task batch (and
 * its KD writes) has been accounted for.
 */
interface StallState {
  consecutiveNoProgress: number;
  consecutiveSameHash: number;
  lastResponseHash: string | null;
  totalKdWrites: number;
  completedIterations: number;
}

function updateStallState(
  state: StallState,
  iteration: { subTaskCount: number; kdWrites: number; responseHash: string },
): string | null {
  state.completedIterations += 1;
  state.totalKdWrites += iteration.kdWrites;

  if (iteration.subTaskCount === 0 && iteration.kdWrites === 0) {
    state.consecutiveNoProgress += 1;
  } else {
    state.consecutiveNoProgress = 0;
  }

  if (state.lastResponseHash !== null && state.lastResponseHash === iteration.responseHash) {
    state.consecutiveSameHash += 1;
  } else {
    state.consecutiveSameHash = 1;
  }
  state.lastResponseHash = iteration.responseHash;

  if (state.consecutiveNoProgress >= 2) {
    return `${state.consecutiveNoProgress} consecutive iterations with zero sub-task dispatch and zero knowledge-doc writes`;
  }
  if (state.consecutiveSameHash >= 3) {
    return `${state.consecutiveSameHash} consecutive iterations with identical strategist response fingerprints`;
  }
  if (state.totalKdWrites === 0 && state.completedIterations >= 3) {
    return `zero knowledge-doc writes across ${state.completedIterations} iterations`;
  }
  return null;
}

/**
 * Orchestrated v2 agentic analysis. The strategist plans iterative sub-tasks;
 * sub-tasks write findings exclusively via the kd_* MCP tools under the
 * advisory lock. The orchestrator never writes raw text into
 * `ticket.knowledgeDoc` — the only direct write is the one-time template
 * init at run start when the doc + sidecar are uninitialized.
 *
 * End of run: `fallbackFillRequiredSections` guarantees the required sections
 * are populated, then `composeFinalAnalysis` pulls Problem Statement / Root
 * Cause / Recommended Fix / Risks from the doc (prefixed by the agent's own
 * executive summary) as the final AI_ANALYSIS content.
 */
export async function runOrchestratedV2(
  deps: AnalysisDeps,
  ctx: AnalysisPipelineContext,
  step: StrategyStep,
  tools: AgenticToolContext,
  opts: { maxIterations: number; existingKnowledgeDoc: string; reanalysisCtx?: ReanalysisContext },
): Promise<AnalysisResult> {
  const { db, ai, appLog } = deps;
  const { ticketId, clientId, category, priority, emailSubject, emailBody, clientContext, environmentContext, codeContext, dbContext, facts, summary } = ctx;
  const { maxIterations: orchMaxIterations, existingKnowledgeDoc, reanalysisCtx } = opts;
  const reanalysisMode = reanalysisCtx?.mode ?? ReanalysisMode.CONTINUE;
  const isReanalysis = !!reanalysisCtx && reanalysisMode !== ReanalysisMode.FRESH_START;
  const { tools: agenticTools, mcpIntegrations, repoIdByPrefix, repos: clientRepos } = tools;

  const defaultMaxTokens = await deps.loadDefaultMaxTokens?.() ?? undefined;
  const toolResultMaxTokens = await getToolResultMaxTokens(db);

  const maxParallelTasks = await resolveMaxParallelTasks(db);
  const orchModelMap = await resolveOrchestratedModelMap(db);

  // --- One-time knowledge-doc init -----------------------------------------
  const kdInitial = await loadKnowledgeDoc(db, ticketId);
  const needsInit = !kdInitial?.knowledgeDoc
    || !kdInitial.knowledgeDocSectionMeta
    || typeof kdInitial.knowledgeDocSectionMeta !== 'object'
    || Object.keys(kdInitial.knowledgeDocSectionMeta as Record<string, unknown>).length === 0;
  if (needsInit) {
    await withTicketLock(db, ticketId, async (tx) => {
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          knowledgeDoc: initEmptyKnowledgeDoc(),
          knowledgeDocSectionMeta: {} as object,
        },
      });
    });
  }

  let artifactCatalog = '';
  if (isReanalysis) {
    artifactCatalog = await buildArtifactCatalog(db, ticketId, { maxEntries: 20 });
  }

  let agentExecutiveSummary = '';
  let orchIterationsRun = 0;
  let orchTotalInputTokens = 0;
  let orchTotalOutputTokens = 0;
  const orchToolCallLog: Array<{ tool: string; system?: string; input: Record<string, unknown>; output: string; durationMs: number }> = [];

  // Build the initial context for the strategist
  const ticketContext = [
    `## Ticket`,
    `Subject: ${emailSubject}`,
    `Category: ${category}`,
    `Priority: ${priority}`,
    '', emailBody,
  ].join('\n');
  const contextParts: string[] = [ticketContext];
  if (summary) contextParts.push(`\n## Summary\n${summary}`);
  if (clientContext) contextParts.push(`\n${clientContext}`);
  if (environmentContext) contextParts.push(`\n${environmentContext}`);
  if (facts.keywords?.length) contextParts.push(`\n## Key Terms\n${facts.keywords.join(', ')}`);
  if (dbContext) contextParts.push(`\n## DB Context\n${dbContext}`);
  if (codeContext.length > 0) contextParts.push(`\n## Code Context\n${codeContext.join('\n')}`);

  const availableToolNames = agenticTools.map(t => t.name);
  const toolListSection = `\n## Available Tools\n${availableToolNames.join(', ')}`;
  contextParts.push(toolListSection);

  let priorRunsContext = '';
  if (existingKnowledgeDoc) {
    priorRunsContext = existingKnowledgeDoc.length > 2000
      ? `[Prior analysis truncated — full history available in the Knowledge tab]\n\n…${existingKnowledgeDoc.slice(-2000)}`
      : existingKnowledgeDoc;
  }

  // Build the strategist's tool list (read-only kd_* + dispatch + complete)
  const finalStrategistTools = buildStrategistTools(agenticTools);

  // Compose the updated strategist system prompt (includes tool-use discipline)
  const strategistSystemPrompt = [
    ORCHESTRATED_V2_STRATEGIST_PROMPT,
    buildRepoNudgeSnippet(clientRepos),
  ].join('\n');

  // Compose the initial user prompt for the strategist
  let initialStrategistPrompt: string;
  {
    const priorNote = priorRunsContext
      ? `\n\n## Prior Analysis Runs (for context)\n${priorRunsContext}\n\n---\n\n`
      : '';

    if (isReanalysis && reanalysisCtx) {
      const modeIntro = reanalysisMode === ReanalysisMode.REFINE
        ? [
            'The operator has replied asking for clarification or refinement. Use the prior',
            'knowledge document and artifacts as ground truth. Do NOT fire fresh MCP tool',
            'calls unless the operator\'s request explicitly requires new data — prefer',
            'reading prior artifacts via `platform__read_tool_result_artifact`.',
          ].join(' ')
        : [
            'The operator has replied. Plan the next iteration that addresses their reply.',
            'A catalog of prior tool-result artifacts is provided below — re-query only when',
            'necessary; prefer reading prior artifacts via `platform__read_tool_result_artifact`',
            'or hint at them via `contextKdSectionKeys` in a sub-task.',
          ].join(' ');

      const sections = [
        modeIntro,
        '',
        '## Operator Reply',
        reanalysisCtx.triggerReplyText || '(no reply text available — see conversation history)',
        '',
        '## Prior Knowledge Document',
        priorRunsContext || existingKnowledgeDoc || '(no prior knowledge document)',
      ];
      if (artifactCatalog) {
        sections.push('', '## Prior Artifacts', artifactCatalog);
      }
      sections.push('', '## Conversation History', reanalysisCtx.conversationHistory);
      sections.push('', '## Ticket Context', contextParts.join('\n'));

      initialStrategistPrompt = sections.join('\n');
    } else {
      const includePriorNote = reanalysisMode !== ReanalysisMode.FRESH_START;
      const effectivePriorNote = includePriorNote ? priorNote : '';
      initialStrategistPrompt = `Investigate this ticket. Here is the full context:\n\n${contextParts.join('\n')}${effectivePriorNote}`;
    }
  }

  // Stall-detection state — see updateStallState for the three rules (#366).
  const stallState: StallState = {
    consecutiveNoProgress: 0,
    consecutiveSameHash: 0,
    lastResponseHash: null,
    totalKdWrites: 0,
    completedIterations: 0,
  };
  let stallReason: string | null = null;
  let stallIteration = 0;

  // ---------------------------------------------------------------------------
  // Strategist message loop
  // ---------------------------------------------------------------------------
  // The strategist now uses generateWithTools so it can:
  //   - call dispatch_subtasks to request parallel sub-task batches
  //   - call complete_analysis to signal the end of investigation
  //   - call kd_read_toc / kd_read_section to inspect the knowledge doc
  //   - call read_tool_result_artifact to inspect prior artifacts
  //
  // The outer `for` loop represents strategist iterations (planning passes).
  // Within each iteration, the strategist may issue multiple tool calls (kd_read_*,
  // read_artifact) before dispatching sub-tasks or completing. The inner tool loop
  // handles those until the strategist emits dispatch_subtasks or complete_analysis.

  const strategistMessages: AIMessage[] = [
    { role: 'user', content: initialStrategistPrompt },
  ];

  for (let i = 0; i < orchMaxIterations; i++) {
    orchIterationsRun = i + 1;
    const orchestrationId = randomUUID();
    appLog.info(`Orchestrated analysis iteration ${i + 1}/${orchMaxIterations}`, { ticketId, iteration: i + 1, orchestrationId }, ticketId, 'ticket');

    const strategistLogId = randomUUID();

    // --- Inner tool loop: call generateWithTools until strategist dispatches or completes ---
    let innerDone = false;
    let dispatchSubtasksInput: { subtasks: Array<{ id: string; intent: string; tools?: string[]; contextKdSectionKeys?: string[]; model?: string }> } | null = null;
    let dispatchCallId: string | null = null; // track the tool_use_id of the current dispatch_subtasks call
    let completeAnalysisInput: { finalAnalysis: string } | null = null;

    for (let innerIter = 0; innerIter < 20; innerIter++) {
      // Each inner iteration is one generateWithTools call for the strategist
      const strategistResponse = await ai.generateWithTools({
        taskType: (step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS) as TaskType,
        context: {
          ticketId,
          clientId,
          entityId: ticketId,
          entityType: 'ticket',
          ticketCategory: category,
          skipClientMemory: !!clientContext,
          orchestrationId,
          orchestrationIteration: i + 1,
          logId: innerIter === 0 ? strategistLogId : randomUUID(),
          strategy: 'orchestrated' as const,
          strategyVersion: 'v2' as const,
        },
        messages: strategistMessages,
        tools: finalStrategistTools,
        systemPrompt: strategistSystemPrompt,
        providerOverride: 'CLAUDE',
        modelOverride: 'claude-opus-4-6',
        maxTokens: defaultMaxTokens ?? STRATEGIST_MAX_TOKENS,
      });

      orchTotalInputTokens += strategistResponse.usage?.inputTokens ?? 0;
      orchTotalOutputTokens += strategistResponse.usage?.outputTokens ?? 0;

      // Append assistant turn
      strategistMessages.push({ role: 'assistant', content: strategistResponse.contentBlocks });

      // Check for dispatch_subtasks or complete_analysis (decision tools)
      const dispatchCall = strategistResponse.contentBlocks.find(
        (b): b is AIToolUseBlock => b.type === 'tool_use' && b.name === 'dispatch_subtasks',
      );
      const completeCall = strategistResponse.contentBlocks.find(
        (b): b is AIToolUseBlock => b.type === 'tool_use' && b.name === 'complete_analysis',
      );

      if (completeCall) {
        const input = completeCall.input as { finalAnalysis?: string };
        completeAnalysisInput = {
          finalAnalysis: typeof input.finalAnalysis === 'string' ? input.finalAnalysis : '',
        };

        // Synthesize tool_result so the conversation stays valid
        strategistMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: completeCall.id,
              content: 'Analysis marked complete. Investigation concluded.',
            } satisfies AIToolResultBlock,
          ],
        });
        innerDone = true;
        break;
      }

      if (dispatchCall) {
        dispatchCallId = dispatchCall.id; // capture current iteration's tool_use_id
        const rawInput = dispatchCall.input as { subtasks?: unknown };
        const rawSubtasks = Array.isArray(rawInput.subtasks) ? rawInput.subtasks : [];
        // Clamp to 5 sub-tasks per dispatch regardless of what the model emits.
        // This mirrors the maxItems:5 constraint in the schema and is a hard
        // safety valve against runaway parallelism.
        const MAX_SUBTASKS_PER_DISPATCH = 5;
        const clampedSubtasks = (rawSubtasks as Array<Record<string, unknown>>).slice(0, MAX_SUBTASKS_PER_DISPATCH);
        if (rawSubtasks.length > MAX_SUBTASKS_PER_DISPATCH) {
          appLog.warn(
            `Orchestrated iteration ${i + 1}: strategist dispatched ${rawSubtasks.length} sub-tasks (max ${MAX_SUBTASKS_PER_DISPATCH}); excess silently dropped`,
            { ticketId, iteration: i + 1, requested: rawSubtasks.length, clamped: MAX_SUBTASKS_PER_DISPATCH },
            ticketId,
            'ticket',
          );
        }
        dispatchSubtasksInput = {
          subtasks: clampedSubtasks.map(st => ({
            id: typeof st['id'] === 'string' ? st['id'] : randomUUID(),
            intent: typeof st['intent'] === 'string' ? st['intent'] : '',
            tools: Array.isArray(st['tools']) ? (st['tools'] as string[]) : [],
            contextKdSectionKeys: Array.isArray(st['contextKdSectionKeys']) ? (st['contextKdSectionKeys'] as string[]) : [],
            model: typeof st['model'] === 'string' ? st['model'] : 'sonnet',
          })),
        };
        innerDone = true;
        break;
      }

      // No decision tool — handle any non-decision tool calls (kd_read_*, read_artifact)
      if (strategistResponse.stopReason !== 'tool_use') {
        // Strategist ended without calling any tool — treat as done
        appLog.info(
          `Strategist ended without decision tool at iteration ${i + 1} (inner ${innerIter + 1})`,
          { ticketId, iteration: i + 1, innerIter: innerIter + 1, stopReason: strategistResponse.stopReason },
          ticketId,
          'ticket',
        );
        // Extract any text as the final analysis
        const finalText = strategistResponse.contentBlocks
          .filter((b): b is AITextBlock => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();
        if (finalText) {
          completeAnalysisInput = { finalAnalysis: finalText };
        }
        innerDone = true;
        break;
      }

      // Execute non-decision tool calls (kd_read_toc, kd_read_section, read_tool_result_artifact)
      const nonDecisionToolUses = strategistResponse.contentBlocks.filter(
        (b): b is AIToolUseBlock =>
          b.type === 'tool_use' &&
          b.name !== 'dispatch_subtasks' &&
          b.name !== 'complete_analysis',
      );

      const toolResults: AIToolResultBlock[] = [];
      for (const toolUse of nonDecisionToolUses) {
        const start = Date.now();
        const result = await executeAgenticToolCall(
          toolUse,
          mcpIntegrations,
          repoIdByPrefix,
          clientId,
          ticketId,
          undefined, // no failure tracker for strategist read tools
        );
        const elapsed = Date.now() - start;

        // Apply the same truncation + artifact path used for sub-task tool results
        // so large kd_read_section / artifact reads don't balloon strategist history.
        const fullResult = result.result;
        const fullSizeChars = fullResult.length;
        const threshold = toolResultMaxTokens ?? 4000;
        const artifactId = deps.artifactStoragePath && !result.isError ? randomUUID() : undefined;
        const truncated = !result.isError && !!artifactId && shouldTruncate(fullResult, threshold);
        const contentForModel = truncated && artifactId
          ? buildTruncatedPreview(fullResult, artifactId)
          : fullResult;

        orchToolCallLog.push({
          tool: toolUse.name,
          system: (toolUse.input as Record<string, unknown>)?.system_name as string | undefined,
          input: toolUse.input,
          output: fullResult.slice(0, 500),
          durationMs: elapsed,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: contentForModel,
          ...(result.isError ? { is_error: true } : {}),
        });

        if (deps.artifactStoragePath && !result.isError) {
          void saveMcpToolArtifact(deps.db, ticketId, toolUse.name, fullResult, deps.artifactStoragePath, artifactId).catch(err => {
            logger.warn({ err, ticketId, toolName: toolUse.name }, 'Failed to persist strategist MCP tool artifact');
          });
        }

        appLog.info(
          `Strategist tool call: ${toolUse.name} (${elapsed}ms)`,
          {
            ticketId,
            tool: toolUse.name,
            durationMs: elapsed,
            iteration: i + 1,
            innerIter: innerIter + 1,
            truncated,
            fullSizeChars,
            ...(artifactId ? { artifactId } : {}),
          },
          ticketId,
          'ticket',
        );
      }

      if (toolResults.length > 0) {
        strategistMessages.push({ role: 'user', content: toolResults });
      }
    }

    // --- Handle complete_analysis ---
    if (completeAnalysisInput) {
      agentExecutiveSummary = completeAnalysisInput.finalAnalysis;
      await writeKnowledgeDocSnapshot(db, ticketId, i + 1);
      break;
    }

    // --- Handle dispatch_subtasks ---
    if (dispatchSubtasksInput && dispatchSubtasksInput.subtasks.length > 0) {
      const plan = dispatchSubtasksInput;

      appLog.info(
        `Orchestrated iteration ${i + 1}: dispatching ${plan.subtasks.length} sub-task(s)`,
        { ticketId, iteration: i + 1, subtaskCount: plan.subtasks.length, subtaskIds: plan.subtasks.map(s => s.id) },
        ticketId,
        'ticket',
      );

      // Record iteration start in Run Log
      try {
        const intentsSummary = plan.subtasks.map(s => `- ${s.id}: ${s.intent.slice(0, 100)}`).join('\n');
        const runLogEntry = `### Iteration ${i + 1} — Dispatched ${plan.subtasks.length} sub-task(s)\n${intentsSummary}\n`;
        await updateSection(db, ticketId, KnowledgeDocSectionKey.RUN_LOG, runLogEntry, KnowledgeDocUpdateMode.APPEND);
      } catch (err) {
        logger.warn({ err, ticketId, iteration: i + 1 }, 'Failed to append Run Log entry — continuing');
      }

      // Stall-detection accumulators for this iteration.
      // `iterationDispatchAttempts` is the number of sub-tasks dispatched
      // (counts attempts, not completions, so a batch where all fail still
      // registers as "tasks were dispatched" and doesn't falsely trip the
      // zero-dispatch rule). `iterationKdWrites` counts kd_update_section +
      // kd_add_subsection calls across this iteration's sub-task tool-call logs.
      const iterationDispatchAttempts = plan.subtasks.length;
      let iterationKdWrites = 0;

      // Execute sub-tasks in parallel batches
      const subtaskBatches = chunkArray(plan.subtasks, maxParallelTasks);
      const allSubTaskResults: SubTaskRunResult[] = [];

      for (const batch of subtaskBatches) {
        const batchResults = await Promise.allSettled(
          batch.map(subtask =>
            executeOrchestratedSubTaskV2(
              deps,
              ticketId,
              clientId,
              category,
              clientContext,
              environmentContext,
              {
                id: subtask.id,
                prompt: subtask.intent,
                tools: subtask.tools ?? [],
                model: subtask.model ?? 'sonnet',
                contextKdSectionKeys: subtask.contextKdSectionKeys ?? [],
              },
              agenticTools,
              mcpIntegrations,
              repoIdByPrefix,
              { id: orchestrationId, iteration: i + 1, parentLogId: strategistLogId },
              orchModelMap,
              toolResultMaxTokens,
            ),
          ),
        );

        for (let j = 0; j < batchResults.length; j++) {
          const result = batchResults[j];
          const subtask = batch[j];
          if (result.status === 'fulfilled') {
            orchTotalInputTokens += result.value.inputTokens;
            orchTotalOutputTokens += result.value.outputTokens;
            orchToolCallLog.push(...result.value.toolCalls);
            iterationKdWrites += countKdWrites(result.value.toolCalls);
            allSubTaskResults.push(result.value);
            appLog.info(
              `Sub-task ${subtask.id} complete (${result.value.stopReason}): ${result.value.summary.slice(0, 200)}`,
              {
                ticketId,
                subtaskId: subtask.id,
                iteration: i + 1,
                stopReason: result.value.stopReason,
                toolCallCount: result.value.toolCalls.length,
                updatedKdSections: result.value.updatedKdSections,
                tokensUsed: result.value.tokensUsed,
              },
              ticketId,
              'ticket',
            );
          } else {
            // Retry once on failure
            try {
              const retryResult = await executeOrchestratedSubTaskV2(
                deps,
                ticketId,
                clientId,
                category,
                clientContext,
                environmentContext,
                {
                  id: subtask.id,
                  prompt: subtask.intent,
                  tools: subtask.tools ?? [],
                  model: subtask.model ?? 'sonnet',
                  contextKdSectionKeys: subtask.contextKdSectionKeys ?? [],
                },
                agenticTools,
                mcpIntegrations,
                repoIdByPrefix,
                { id: orchestrationId, iteration: i + 1, parentLogId: strategistLogId },
                orchModelMap,
                toolResultMaxTokens,
              );
              orchTotalInputTokens += retryResult.inputTokens;
              orchTotalOutputTokens += retryResult.outputTokens;
              orchToolCallLog.push(...retryResult.toolCalls);
              iterationKdWrites += countKdWrites(retryResult.toolCalls);
              allSubTaskResults.push(retryResult);
              appLog.info(
                `Sub-task ${subtask.id} complete (retry, ${retryResult.stopReason}): ${retryResult.summary.slice(0, 200)}`,
                { ticketId, subtaskId: subtask.id, iteration: i + 1, stopReason: retryResult.stopReason },
                ticketId,
                'ticket',
              );
            } catch (retryErr) {
              appLog.warn(
                `Sub-task ${subtask.id} failed after retry`,
                { ticketId, subtaskId: subtask.id, err: retryErr },
                ticketId,
                'ticket',
              );
              // Add a stub result so the strategist gets a tool_result for this sub-task
              allSubTaskResults.push({
                subTaskId: subtask.id,
                intent: subtask.intent,
                summary: `Sub-task failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
                updatedKdSections: [],
                iterationsUsed: 0,
                tokensUsed: 0,
                stopReason: SubTaskStopReason.ERROR,
                inputTokens: 0,
                outputTokens: 0,
                toolCalls: [],
              });
            }
          }
        }
      }

      // Append sub-task results to strategist messages as tool_result for the dispatch_subtasks call.
      // Use the captured `dispatchCallId` from this iteration (not a history scan) to ensure
      // the tool_result is threaded onto the correct dispatch_subtasks tool_use block.
      if (dispatchCallId) {
        const resultPayload = allSubTaskResults.map(r => ({
          sub_task_id: r.subTaskId,
          intent: r.intent,
          summary: r.summary,
          updatedKdSections: r.updatedKdSections,
          stopReason: r.stopReason,
          iterationsUsed: r.iterationsUsed,
          tokensUsed: r.tokensUsed,
        }));

        strategistMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: dispatchCallId,
              content: JSON.stringify(resultPayload, null, 2),
            } satisfies AIToolResultBlock,
          ],
        });
      } else {
        // Fallback: append as a plain user message (shouldn't happen in practice)
        const resultSummary = allSubTaskResults.map(r =>
          `**Sub-task ${r.subTaskId}** (${r.stopReason}): ${r.summary}\nUpdated KD sections: ${r.updatedKdSections.join(', ') || 'none'}`,
        ).join('\n\n');
        strategistMessages.push({
          role: 'user',
          content: `## Sub-task Results\n\n${resultSummary}\n\nUse \`platform__kd_read_toc\` or \`platform__kd_read_section\` to review what was written, then either \`dispatch_subtasks\` for more investigation or \`complete_analysis\` if sufficient.`,
        });
      }

      await writeKnowledgeDocSnapshot(db, ticketId, i + 1);

      // --- Stall detection (#366) ------------------------------------------
      // After the sub-task batch completes and KD writes have been counted,
      // feed per-iteration signals into the stall state machine. The response
      // hash is computed from the serialised dispatch plan (the strategist's
      // intent for this iteration) rather than a raw text response, since the
      // v2 strategist uses generateWithTools and its "response" is tool calls.
      const dispatchPlanHash = hashOrchestratorResponse(JSON.stringify(plan.subtasks));
      const stallCheck = updateStallState(stallState, {
        subTaskCount: iterationDispatchAttempts,
        kdWrites: iterationKdWrites,
        responseHash: dispatchPlanHash,
      });
      if (stallCheck !== null) {
        stallReason = stallCheck;
        stallIteration = i + 1;
        appLog.warn(
          `Orchestrator stall detected at iteration ${i + 1}: ${stallCheck}. Terminating loop early.`,
          {
            ticketId,
            iteration: i + 1,
            stallReason: stallCheck,
            consecutiveNoProgress: stallState.consecutiveNoProgress,
            consecutiveSameHash: stallState.consecutiveSameHash,
            totalKdWrites: stallState.totalKdWrites,
          },
          ticketId,
          'ticket',
        );
        break;
      }
    } else if (innerDone) {
      // Strategist ended the inner loop but without a decision — treat as done
      await writeKnowledgeDocSnapshot(db, ticketId, i + 1);
      break;
    } else {
      // No dispatch and no complete — shouldn't happen but break to avoid infinite loop
      appLog.warn(
        `Orchestrated iteration ${i + 1}: strategist made no decision — breaking`,
        { ticketId, iteration: i + 1 },
        ticketId,
        'ticket',
      );
      await writeKnowledgeDocSnapshot(db, ticketId, i + 1);
      break;
    }
  }

  // --- End of loop: stall marker (if any) + fallback-fill + compose ------
  // When the stall detector fired we write a real rootCause marker BEFORE the
  // generic fallback-fill runs. `fallbackFillRequiredSections` only touches
  // empty required sections, so populating rootCause first means the operator
  // sees the actual stall reason in the composed analysis instead of the
  // generic `[agent did not populate this section — …]` placeholder.
  if (stallReason) {
    await writeStallMarker(db, ticketId, stallIteration, stallReason);
  }
  const fallbackReason = stallReason
    ? `orchestrated-v2 stalled at iteration ${stallIteration}`
    : 'orchestrated-v2 loop end';
  await fallbackFillRequiredSections(db, ticketId, fallbackReason);
  const kdAfter = await loadKnowledgeDoc(db, ticketId);
  const fallbackExecutiveSummary = stallReason
    ? `Orchestrated analysis terminated early by stall detector at iteration ${stallIteration}: ${stallReason}. No substantive findings were produced — see the Root Cause section for details.`
    : 'Orchestrated analysis reached maximum iterations without a final conclusion. Review the knowledge document for partial findings.';
  const composedAnalysis = composeFinalAnalysis(
    kdAfter?.knowledgeDoc ?? null,
    kdAfter?.knowledgeDocSectionMeta ?? null,
    agentExecutiveSummary || fallbackExecutiveSummary,
  );
  await writeKnowledgeDocSnapshot(db, ticketId, orchIterationsRun);

  const { analysis: cleanOrchAnalysis, evaluation: orchSufficiency } = parseSufficiencyEvaluation(composedAnalysis);

  return {
    analysis: cleanOrchAnalysis,
    toolCallLog: orchToolCallLog,
    totalInputTokens: orchTotalInputTokens,
    totalOutputTokens: orchTotalOutputTokens,
    iterationsRun: orchIterationsRun,
    sufficiencyEval: orchSufficiency,
  };
}

// Re-export public helpers consumed by the pipeline
export { composeFinalAnalysis } from './v2-knowledge-doc.js';
export { fallbackFillRequiredSections } from './v2-knowledge-doc.js';
