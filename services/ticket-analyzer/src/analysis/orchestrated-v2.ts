import { randomUUID } from 'node:crypto';
import {
  createLogger,
  initEmptyKnowledgeDoc,
  loadKnowledgeDoc,
  updateSection,
  withTicketLock,
} from '@bronco/shared-utils';
import { KnowledgeDocSectionKey, KnowledgeDocUpdateMode, TaskType } from '@bronco/shared-types';
import type {
  AITextBlock,
  AIToolDefinition,
  AIToolResultBlock,
  AIToolUseBlock,
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
  parseStrategistResponse,
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
  type SubTaskResult,
} from './shared.js';
import {
  composeFinalAnalysis,
  fallbackFillRequiredSections,
  writeKnowledgeDocSnapshot,
} from './v2-knowledge-doc.js';
import {
  KD_SYSTEM_PROMPT_SNIPPET,
  PREFER_EXISTING_TOOLS_SNIPPET,
  REQUEST_NEW_TOOL_SNIPPET,
  TRUNCATION_SYSTEM_PROMPT_SNIPPET,
} from './v2-prompts.js';

const logger = createLogger('ticket-analyzer');

/**
 * Fallback content when a sub-task's initial response has no text blocks.
 * Uses the first tool call's output preview so the Run Log still has
 * something actionable. Empty tool-calls array → placeholder string.
 */
function fallbackFromToolResults(toolCalls: SubTaskResult['toolCalls']): string {
  if (toolCalls.length === 0) return 'Sub-task produced no text output and no tool calls.';
  const first = toolCalls[0];
  const preview = (first.output ?? '').slice(0, 500);
  return `No summary text; first tool (${first.tool}) output preview:\n${preview}`;
}

async function executeOrchestratedSubTaskV2(
  deps: AnalysisDeps,
  ticketId: string,
  clientId: string,
  category: string,
  clientContext: string,
  environmentContext: string,
  task: { prompt: string; tools: string[]; model: string; priorArtifactIds?: string[] },
  agenticTools: AIToolDefinition[],
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  repoIdByPrefix: Map<string, string>,
  orchestration?: { id: string; iteration: number; parentLogId?: string },
  modelMap?: Record<string, string>,
  toolResultMaxTokens?: number,
): Promise<SubTaskResult> {
  const { ai, appLog } = deps;
  const map = modelMap ?? {};
  const model = map[task.model] ?? map.sonnet ?? 'claude-sonnet-4-6';
  const defaultMaxTokens = await deps.loadDefaultMaxTokens?.() ?? undefined;

  const toolCalls: SubTaskResult['toolCalls'] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  // If client/environment context was already injected into the strategist prompt, skip AIRouter
  // re-injection for sub-tasks to avoid duplicating it in every sub-task system prompt.
  const skipClientMemory = !!clientContext;
  const combinedContext = [clientContext, environmentContext].filter(Boolean).join('\n\n');
  const subTaskInstructions = [
    'Execute the requested investigation step. Call the relevant tools, analyze the results,',
    'and record each finding by calling platform__kd_add_subsection(parentSectionKey="evidence",',
    'title, content) — do NOT dump the findings back into the response text for the orchestrator',
    'to concatenate; the knowledge doc is the source of truth. Your response text should only be',
    'a concise one-paragraph summary so the orchestrator can log progress.',
  ].join(' ');
  const priorArtifactsHint = task.priorArtifactIds && task.priorArtifactIds.length > 0
    ? `\n\n## Prior Artifacts You May Need\nThese artifact IDs from prior runs may be relevant. Read them via \`platform__read_tool_result_artifact\` before re-querying:\n${task.priorArtifactIds.map(id => `- ${id}`).join('\n')}`
    : '';
  const subTaskSystemPrompt = combinedContext
    ? `${subTaskInstructions}\n\n${combinedContext}\n${TRUNCATION_SYSTEM_PROMPT_SNIPPET}\n${PREFER_EXISTING_TOOLS_SNIPPET}\n${REQUEST_NEW_TOOL_SNIPPET}\n${KD_SYSTEM_PROMPT_SNIPPET}${priorArtifactsHint}`
    : `${subTaskInstructions}\n${TRUNCATION_SYSTEM_PROMPT_SNIPPET}\n${PREFER_EXISTING_TOOLS_SNIPPET}\n${REQUEST_NEW_TOOL_SNIPPET}\n${KD_SYSTEM_PROMPT_SNIPPET}${priorArtifactsHint}`;

  // Resolve tools using ranked matching (exact → base name → substring → fuzzy)
  const resolution = task.tools.length > 0
    ? resolveTaskTools(task.tools, agenticTools)
    : { resolved: [] as AIToolDefinition[], fuzzy: new Map<string, Array<{ tool: AIToolDefinition; score: number }>>(), unmatched: [] as string[] };

  // Build initial tool set: resolved + top fuzzy candidate per entry + ALWAYS include kd_* tools
  // so every sub-task can write findings via the templated doc, regardless of what the strategist listed.
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

  // If tools were requested but none matched at all (kd_* tools excluded), return early with guidance
  const nonKdInitial = initialTools.filter(t => !t.name.startsWith('platform__kd_'));
  if (task.tools.length > 0 && nonKdInitial.length === 0) {
    const MAX_TOOLS_IN_ERROR = 10;
    const toolNames = agenticTools.map(t => t.name);
    const availableList = toolNames.length > MAX_TOOLS_IN_ERROR
      ? `${toolNames.slice(0, MAX_TOOLS_IN_ERROR).join(', ')} … (${toolNames.length - MAX_TOOLS_IN_ERROR} more)`
      : toolNames.join(', ');
    return {
      content: `Tool resolution failed: requested [${task.tools.join(', ')}] but no matching tools found. Available tools: [${availableList}]. Use exact tool names from this list.`,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
    };
  }

  /**
   * Run a sub-task with the given tool set and return the result plus
   * whether any "irrelevant" signals were detected.
   */
  async function runSubTaskPass(
    tools: AIToolDefinition[],
  ): Promise<{ result: SubTaskResult; seemsIrrelevant: boolean }> {
    const passToolCalls: SubTaskResult['toolCalls'] = [];
    let passInput = 0;
    let passOutput = 0;
    let hasToolError = false;

    if (tools.length > 0) {
      const subTaskLogId = randomUUID();
      const orchCtx = orchestration
        ? { orchestrationId: orchestration.id, orchestrationIteration: orchestration.iteration, isSubTask: true, logId: subTaskLogId, ...(orchestration.parentLogId ? { parentLogId: orchestration.parentLogId, parentLogType: 'ai' as const } : {}) }
        : { logId: subTaskLogId };
      const response = await ai.generateWithTools({
        taskType: TaskType.DEEP_ANALYSIS,
        context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory, strategy: 'orchestrated' as const, strategyVersion: 'v2' as const, ...orchCtx },
        messages: [{ role: 'user', content: task.prompt }],
        tools,
        systemPrompt: subTaskSystemPrompt,
        providerOverride: 'CLAUDE',
        modelOverride: model,
        maxTokens: defaultMaxTokens ?? 4096,
      });

      passInput += response.usage?.inputTokens ?? 0;
      passOutput += response.usage?.outputTokens ?? 0;

      const toolUseBlocks = response.contentBlocks.filter(
        (b): b is AIToolUseBlock => b.type === 'tool_use',
      );

      if (toolUseBlocks.length > 0) {
        const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];

        for (const toolUse of toolUseBlocks) {
          const start = Date.now();
          const result = await executeAgenticToolCall(toolUse, mcpIntegrations, repoIdByPrefix, clientId, ticketId);
          const elapsed = Date.now() - start;

          const fullResult = result.result;
          const fullSizeChars = fullResult.length;
          const artifactId = deps.artifactStoragePath && !result.isError ? randomUUID() : undefined;
          const threshold = toolResultMaxTokens ?? 4000;
          const truncated = !result.isError && !!artifactId && shouldTruncate(fullResult, threshold);
          const contentForModel = truncated && artifactId
            ? buildTruncatedPreview(fullResult, artifactId)
            : fullResult;

          passToolCalls.push({
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
            void saveMcpToolArtifact(deps.db, ticketId, toolUse.name, fullResult, deps.artifactStoragePath, artifactId).catch(error => {
              logger.warn({
                err: error,
                ticketId,
                toolName: toolUse.name,
              }, 'Failed to persist MCP tool artifact');
            });
          }
          if (result.isError) hasToolError = true;
          appLog.info(
            `Sub-task tool call: ${toolUse.name} (${elapsed}ms)`,
            {
              ticketId,
              tool: toolUse.name,
              durationMs: elapsed,
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

        const textBlocks = response.contentBlocks.filter((b): b is AITextBlock => b.type === 'text');
        const initialText = textBlocks.map(b => b.text).join('\n').trim();
        const content = initialText || fallbackFromToolResults(passToolCalls);

        const lowered = content.slice(0, 500).toLowerCase();
        const hasIrrelevantSignal = IRRELEVANT_SIGNALS.some(s => lowered.includes(s));

        return {
          result: { content, inputTokens: passInput, outputTokens: passOutput, toolCalls: passToolCalls },
          seemsIrrelevant: hasToolError || hasIrrelevantSignal,
        };
      }

      // No tool calls — just text response
      const textContent = response.contentBlocks
        .filter((b): b is AITextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const lowered = textContent.slice(0, 500).toLowerCase();
      const hasIrrelevantSignal = IRRELEVANT_SIGNALS.some(s => lowered.includes(s));

      return {
        result: { content: textContent, inputTokens: passInput, outputTokens: passOutput, toolCalls: passToolCalls },
        seemsIrrelevant: hasIrrelevantSignal,
      };
    }

    // No tools — pure analysis
    const pureLogId = randomUUID();
    const orchCtx = orchestration
      ? { orchestrationId: orchestration.id, orchestrationIteration: orchestration.iteration, isSubTask: true, logId: pureLogId, ...(orchestration.parentLogId ? { parentLogId: orchestration.parentLogId, parentLogType: 'ai' as const } : {}) }
      : { logId: pureLogId };
    const response = await ai.generate({
      taskType: TaskType.DEEP_ANALYSIS,
      context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory, strategy: 'orchestrated' as const, strategyVersion: 'v2' as const, ...orchCtx },
      prompt: task.prompt,
      providerOverride: 'CLAUDE',
      modelOverride: model,
      maxTokens: 4096,
    });

    passInput += response.usage?.inputTokens ?? 0;
    passOutput += response.usage?.outputTokens ?? 0;

    return {
      result: { content: response.content, inputTokens: passInput, outputTokens: passOutput, toolCalls: [] },
      seemsIrrelevant: false,
    };
  }

  // --- First pass ---
  const firstPass = await runSubTaskPass(initialTools);
  inputTokens += firstPass.result.inputTokens;
  outputTokens += firstPass.result.outputTokens;
  toolCalls.push(...firstPass.result.toolCalls);

  // --- Retry with alternate fuzzy candidates if first pass seems irrelevant ---
  if (firstPass.seemsIrrelevant && fuzzyUsed.size > 0) {
    let lastRetryResult: SubTaskResult | undefined;
    let lastRetryScore = 0;

    for (const [reqName, used] of fuzzyUsed) {
      const candidates = resolution.fuzzy.get(reqName);
      if (!candidates || candidates.length <= used.candidateIndex + 1) continue;

      const nextCandidate = candidates[used.candidateIndex + 1];
      const retryTools = initialTools
        .filter(t => t.name !== used.tool.name)
        .concat(nextCandidate.tool);

      const retryPass = await runSubTaskPass(retryTools);
      inputTokens += retryPass.result.inputTokens;
      outputTokens += retryPass.result.outputTokens;
      toolCalls.push(...retryPass.result.toolCalls);
      lastRetryResult = retryPass.result;
      lastRetryScore = nextCandidate.score;

      if (!retryPass.seemsIrrelevant) {
        return { content: retryPass.result.content, inputTokens, outputTokens, toolCalls };
      }
    }

    if (lastRetryResult !== undefined) {
      return {
        content: `Warning: Tool match was uncertain (fuzzy match score: ${lastRetryScore.toFixed(2)}) — results may not be fully relevant.\n\n${lastRetryResult.content}`,
        inputTokens,
        outputTokens,
        toolCalls,
      };
    }

    const topScore = [...fuzzyUsed.values()].reduce((max, v) => Math.max(max, v.score), 0);
    return {
      content: `Warning: Tool match was uncertain (fuzzy match score: ${topScore.toFixed(2)}) — results may not be fully relevant.\n\n${firstPass.result.content}`,
      inputTokens,
      outputTokens,
      toolCalls,
    };
  }

  return { content: firstPass.result.content, inputTokens, outputTokens, toolCalls };
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
  // Guarantees that both `knowledgeDoc` (template skeleton) and
  // `knowledgeDocSectionMeta` (empty object, non-null) are populated from
  // iteration 0 forward, so `composeFinalAnalysis` / snapshot / fallback-fill
  // at loop end can rely on a consistent schema. This is the ONE permitted
  // raw write inside v2 orchestrated — every subsequent doc mutation flows
  // through the templated `kd_*` path (sub-task tool calls or shared-utils
  // `updateSection` from the orchestrator itself for the Run Log).
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

  let orchNextPrompt = '';
  let orchIterationsRun = 0;
  let agentExecutiveSummary = '';
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

  // For re-analysis surfaces, include a compact preview of the existing doc
  // (the fresh doc just got initialized, but prior content may exist on the
  // ticket from an earlier run).
  let priorRunsContext = '';
  if (existingKnowledgeDoc) {
    priorRunsContext = existingKnowledgeDoc.length > 2000
      ? `[Prior analysis truncated — full history available in the Knowledge tab]\n\n…${existingKnowledgeDoc.slice(-2000)}`
      : existingKnowledgeDoc;
  }

  const strategistSystemPrompt = [
    ORCHESTRATED_SYSTEM_PROMPT,
    '',
    '## Knowledge Document Discipline (v2)',
    'The knowledge doc is the source of truth for this investigation. Sub-tasks you dispatch MUST call',
    'platform__kd_add_subsection(parentSectionKey="evidence", title, content) to record each finding.',
    'In iteration 1, your FIRST task prompt should instruct the sub-task to call',
    'platform__kd_update_section(sectionKey="problemStatement", content=...) with a concise restatement',
    'of the issue before any tool-call investigation begins. Before planning each iteration after the',
    'first, assume the doc has been updated by prior sub-tasks — if you need to see what has been',
    'recorded, instruct a sub-task to call platform__kd_read_toc / platform__kd_read_section and return',
    'the summary.',
    '',
    'When setting "done": true, your finalAnalysis should be a concise executive summary. The detail',
    'belongs in the doc — Problem Statement / Root Cause / Recommended Fix / Risks sections will be',
    'merged into the final rendered analysis automatically.',
    TRUNCATION_SYSTEM_PROMPT_SNIPPET,
    PREFER_EXISTING_TOOLS_SNIPPET,
    REQUEST_NEW_TOOL_SNIPPET,
    KD_SYSTEM_PROMPT_SNIPPET,
    buildRepoNudgeSnippet(clientRepos),
  ].join('\n');

  for (let i = 0; i < orchMaxIterations; i++) {
    orchIterationsRun = i + 1;
    const orchestrationId = randomUUID();
    appLog.info(`Orchestrated analysis iteration ${i + 1}/${orchMaxIterations}`, { ticketId, iteration: i + 1, orchestrationId }, ticketId, 'ticket');

    let strategistPrompt: string;
    if (i === 0) {
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
              'or hint at them via `priorArtifactIds` in a sub-task.',
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

        strategistPrompt = sections.join('\n');
      } else {
        const includePriorNote = reanalysisMode !== ReanalysisMode.FRESH_START;
        const effectivePriorNote = includePriorNote ? priorNote : '';
        strategistPrompt = `Investigate this ticket. Here is the full context:\n\n${contextParts.join('\n')}${effectivePriorNote}`;
      }
    } else {
      strategistPrompt = `Continue the investigation. Sub-tasks from prior iterations have recorded their findings via platform__kd_add_subsection into the knowledge doc. Dispatch the next round of sub-tasks.\n\n## Next Investigation Step\n${orchNextPrompt}`;
    }

    const strategistLogId = randomUUID();
    const strategistResponse = await ai.generate({
      taskType: (step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS) as TaskType,
      context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory: !!clientContext, orchestrationId, orchestrationIteration: i + 1, logId: strategistLogId, strategy: 'orchestrated' as const, strategyVersion: 'v2' as const },
      prompt: strategistPrompt,
      systemPrompt: strategistSystemPrompt,
      providerOverride: 'CLAUDE',
      modelOverride: 'claude-opus-4-6',
      maxTokens: defaultMaxTokens ?? 4096,
    });

    orchTotalInputTokens += strategistResponse.usage?.inputTokens ?? 0;
    orchTotalOutputTokens += strategistResponse.usage?.outputTokens ?? 0;

    const plan = parseStrategistResponse(strategistResponse.content);

    if (plan.parseError) {
      appLog.error(
        `Strategist JSON parse failed: ${plan.parseError}. Raw content used as final analysis.`,
        { ticketId, iteration: i + 1, error: plan.parseError },
        ticketId, 'ticket',
      );
    }

    appLog.info(
      `Orchestrated iteration ${i + 1}: ${plan.tasks.length} tasks, done=${plan.done}`,
      { ticketId, iteration: i + 1, taskCount: plan.tasks.length, done: plan.done, findingsPreview: plan.findings.slice(0, 500) },
      ticketId, 'ticket',
    );

    // Record a Run Log entry through the templated writer — this updates both
    // `knowledgeDoc` and `knowledgeDocSectionMeta` atomically via
    // `withTicketLock` (see packages/shared-utils/src/knowledge-doc.ts).
    // This is NOT a raw knowledgeDoc write.
    try {
      const runLogEntry = `### Iteration ${i + 1}\n${plan.findings || '(no findings summary from strategist)'}\n`;
      await updateSection(
        db,
        ticketId,
        KnowledgeDocSectionKey.RUN_LOG,
        runLogEntry,
        KnowledgeDocUpdateMode.APPEND,
      );
    } catch (err) {
      logger.warn({ err, ticketId, iteration: i + 1 }, 'Failed to append Run Log entry — continuing');
    }

    if (plan.done) {
      agentExecutiveSummary = plan.finalAnalysis ?? plan.findings;
      await writeKnowledgeDocSnapshot(db, ticketId, i + 1);
      break;
    }

    orchNextPrompt = plan.nextPrompt ?? '';

    // Execute tasks in parallel batches. Sub-tasks write findings via kd_*
    // tools — no local knowledgeDoc accumulation here. Sub-task response text
    // is kept for AppLog / telemetry only; the doc is authoritative.
    const taskBatches = chunkArray(plan.tasks, maxParallelTasks);
    for (const batch of taskBatches) {
      const results = await Promise.allSettled(
        batch.map(task => executeOrchestratedSubTaskV2(deps, ticketId, clientId, category, clientContext, environmentContext, task, agenticTools, mcpIntegrations, repoIdByPrefix, { id: orchestrationId, iteration: i + 1, parentLogId: strategistLogId }, orchModelMap, toolResultMaxTokens)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const task = batch[j];
        if (result.status === 'fulfilled') {
          orchTotalInputTokens += result.value.inputTokens;
          orchTotalOutputTokens += result.value.outputTokens;
          orchToolCallLog.push(...result.value.toolCalls);
          appLog.info(
            `Sub-task complete: ${task.prompt.slice(0, 120)}`,
            { ticketId, iteration: i + 1, toolCallCount: result.value.toolCalls.length, contentPreview: result.value.content.slice(0, 500) },
            ticketId, 'ticket',
          );
        } else {
          // Retry once on failure
          try {
            const retryResult = await executeOrchestratedSubTaskV2(deps, ticketId, clientId, category, clientContext, environmentContext, task, agenticTools, mcpIntegrations, repoIdByPrefix, { id: orchestrationId, iteration: i + 1, parentLogId: strategistLogId }, orchModelMap, toolResultMaxTokens);
            orchTotalInputTokens += retryResult.inputTokens;
            orchTotalOutputTokens += retryResult.outputTokens;
            orchToolCallLog.push(...retryResult.toolCalls);
            appLog.info(
              `Sub-task complete (retry): ${task.prompt.slice(0, 120)}`,
              { ticketId, iteration: i + 1, toolCallCount: retryResult.toolCalls.length, contentPreview: retryResult.content.slice(0, 500) },
              ticketId, 'ticket',
            );
          } catch (retryErr) {
            appLog.warn(`Orchestrated task failed after retry: ${task.prompt}`, { ticketId, task: task.prompt, err: retryErr }, ticketId, 'ticket');
          }
        }
      }
    }

    await writeKnowledgeDocSnapshot(db, ticketId, i + 1);
  }

  // --- End of loop: fallback-fill + compose ------------------------------
  await fallbackFillRequiredSections(db, ticketId, 'orchestrated-v2 loop end');
  const kdAfter = await loadKnowledgeDoc(db, ticketId);
  const composedAnalysis = composeFinalAnalysis(
    kdAfter?.knowledgeDoc ?? null,
    kdAfter?.knowledgeDocSectionMeta ?? null,
    agentExecutiveSummary || 'Orchestrated analysis reached maximum iterations without a final conclusion. Review the knowledge document for partial findings.',
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
