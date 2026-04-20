import { randomUUID } from 'node:crypto';
import { createLogger } from '@bronco/shared-utils';
import { TaskType } from '@bronco/shared-types';
import type {
  AITextBlock,
  AIToolDefinition,
  AIToolResultBlock,
  AIToolUseBlock,
} from '@bronco/shared-types';
import {
  chunkArray,
  executeAgenticToolCall,
  IRRELEVANT_SIGNALS,
  ORCHESTRATED_SYSTEM_PROMPT,
  parseStrategistResponse,
  parseSufficiencyEvaluation,
  resolveMaxParallelTasks,
  resolveOrchestratedModelMap,
  resolveTaskTools,
  saveMcpToolArtifact,
  type AnalysisDeps,
  type AnalysisPipelineContext,
  type AnalysisResult,
  type McpIntegrationInfo,
  type StrategyStep,
  type SubTaskResult,
} from './shared.js';
import type { AgenticToolContext } from './flat.js';

const logger = createLogger('ticket-analyzer');

async function executeOrchestratedSubTask(
  deps: AnalysisDeps,
  ticketId: string,
  clientId: string,
  category: string,
  clientContext: string,
  environmentContext: string,
  task: { prompt: string; tools: string[]; model: string },
  agenticTools: AIToolDefinition[],
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  repoIdByPrefix: Map<string, string>,
  orchestration?: { id: string; iteration: number; parentLogId?: string },
  modelMap?: Record<string, string>,
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
  const subTaskSystemPrompt = combinedContext
    ? `Execute the requested investigation step. Call the relevant tools, analyze the results, and return a structured summary of your findings.\n\n${combinedContext}`
    : 'Execute the requested investigation step. Call the relevant tools, analyze the results, and return a structured summary of your findings.';

  // Resolve tools using ranked matching (exact → base name → substring → fuzzy)
  const resolution = task.tools.length > 0
    ? resolveTaskTools(task.tools, agenticTools)
    : { resolved: [] as AIToolDefinition[], fuzzy: new Map<string, Array<{ tool: AIToolDefinition; score: number }>>(), unmatched: [] as string[] };

  // Build initial tool set: resolved + top fuzzy candidate per entry
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

  // If tools were requested but none matched at all, return early with guidance
  if (task.tools.length > 0 && initialTools.length === 0) {
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
        context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory, ...orchCtx },
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
          passToolCalls.push({
            tool: toolUse.name,
            system: (toolUse.input as Record<string, unknown>)?.system_name as string | undefined,
            input: toolUse.input,
            output: result.result.slice(0, 500),
            durationMs: elapsed,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.result,
            ...(result.isError ? { is_error: true } : {}),
          });
          const artifactId = deps.artifactStoragePath && !result.isError ? randomUUID() : undefined;
          if (deps.artifactStoragePath && !result.isError) {
            void saveMcpToolArtifact(deps.db, ticketId, toolUse.name, result.result, deps.artifactStoragePath, artifactId).catch(error => {
              logger.warn({
                err: error,
                ticketId,
                toolName: toolUse.name,
              }, 'Failed to persist MCP tool artifact');
            });
          }
          if (result.isError) hasToolError = true;
          // Write AppLog for sub-task tool calls with lineage back to this sub-task's AI call
          appLog.info(
            `Sub-task tool call: ${toolUse.name} (${elapsed}ms)`,
            {
              ticketId,
              tool: toolUse.name,
              durationMs: elapsed,
              params: toolUse.input ? JSON.stringify(toolUse.input).slice(0, 1000) : null,
              resultPreview: result.result?.slice(0, 2000) ?? null,
              isError: result.isError ?? false,
              parentLogId: subTaskLogId,
              parentLogType: 'ai',
              ...(artifactId ? { artifactId } : {}),
            },
            ticketId,
            'ticket',
          );
        }

        const summaryLogId = randomUUID();
        const summaryOrchCtx = orchestration
          ? { orchestrationId: orchestration.id, orchestrationIteration: orchestration.iteration, isSubTask: true, logId: summaryLogId, parentLogId: subTaskLogId, parentLogType: 'ai' }
          : { logId: summaryLogId, parentLogId: subTaskLogId, parentLogType: 'ai' };
        const summaryResponse = await ai.generateWithTools({
          taskType: TaskType.DEEP_ANALYSIS,
          context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory, ...summaryOrchCtx },
          messages: [
            { role: 'user', content: task.prompt },
            { role: 'assistant', content: response.contentBlocks },
            { role: 'user', content: toolResults as AIToolResultBlock[] },
          ],
          tools: [],
          systemPrompt: 'Summarize the tool results into a structured finding. Do not call additional tools.',
          providerOverride: 'CLAUDE',
          modelOverride: model,
          maxTokens: defaultMaxTokens ?? 4096,
        });

        passInput += summaryResponse.usage?.inputTokens ?? 0;
        passOutput += summaryResponse.usage?.outputTokens ?? 0;

        const summaryText = summaryResponse.contentBlocks
          .filter((b): b is AITextBlock => b.type === 'text')
          .map(b => b.text)
          .join('\n');

        const lowered = summaryText.slice(0, 500).toLowerCase();
        const hasIrrelevantSignal = IRRELEVANT_SIGNALS.some(s => lowered.includes(s));

        return {
          result: { content: summaryText, inputTokens: passInput, outputTokens: passOutput, toolCalls: passToolCalls },
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
      context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory, ...orchCtx },
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
    // Try swapping in next candidate for each fuzzy-matched tool; return first non-irrelevant result
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
      // All retries seemed irrelevant — use last retry result with warning
      return {
        content: `Warning: Tool match was uncertain (fuzzy match score: ${lastRetryScore.toFixed(2)}) — results may not be fully relevant.\n\n${lastRetryResult.content}`,
        inputTokens,
        outputTokens,
        toolCalls,
      };
    }

    // No alternate candidates available — return first pass with warning
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
 * Orchestrated agentic analysis. A strategist plans iterative tasks and
 * dispatches them as parallel sub-tasks; findings are aggregated into a
 * knowledge document persisted on the ticket.
 */
export async function runOrchestratedAnalysis(
  deps: AnalysisDeps,
  ctx: AnalysisPipelineContext,
  step: StrategyStep,
  tools: AgenticToolContext,
  opts: { maxIterations: number; existingKnowledgeDoc: string },
): Promise<AnalysisResult> {
  const { db, ai, appLog } = deps;
  const { ticketId, clientId, category, priority, emailSubject, emailBody, clientContext, environmentContext, codeContext, dbContext, facts, summary } = ctx;
  const { maxIterations: orchMaxIterations, existingKnowledgeDoc } = opts;
  const { tools: agenticTools, mcpIntegrations, repoIdByPrefix } = tools;

  const defaultMaxTokens = await deps.loadDefaultMaxTokens?.() ?? undefined;

  const maxParallelTasks = await resolveMaxParallelTasks(db);
  const orchModelMap = await resolveOrchestratedModelMap(db);
  const existingDoc = existingKnowledgeDoc ?? '';
  const runTimestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const runNumber = (existingDoc.match(/## Analysis Run \d+/g) ?? []).length + 1;

  const currentRunHeader = `## Analysis Run ${runNumber} — ${runTimestamp}\n`;
  let knowledgeDoc = existingDoc
    ? `${existingDoc}\n\n---\n\n${currentRunHeader}`
    : currentRunHeader;
  let orchNextPrompt = '';
  let orchIterationsRun = 0;
  let orchFinalAnalysis = '';
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

  // Build truncated prior-run context for the strategist prompt (max 2000 chars)
  let priorRunsContext = '';
  if (existingDoc) {
    priorRunsContext = existingDoc.length > 2000
      ? `[Prior analysis truncated — full history available in the Knowledge tab]\n\n…${existingDoc.slice(-2000)}`
      : existingDoc;
  }

  for (let i = 0; i < orchMaxIterations; i++) {
    orchIterationsRun = i + 1;
    const orchestrationId = randomUUID();
    appLog.info(`Orchestrated analysis iteration ${i + 1}/${orchMaxIterations}`, { ticketId, iteration: i + 1, orchestrationId }, ticketId, 'ticket');

    // Extract only the current run content (after the run header) for the strategist
    const currentRunStart = knowledgeDoc.lastIndexOf(currentRunHeader);
    const currentRunContent = currentRunStart >= 0
      ? knowledgeDoc.slice(currentRunStart)
      : knowledgeDoc;

    let strategistPrompt: string;
    if (i === 0) {
      const priorNote = priorRunsContext
        ? `\n\n## Prior Analysis Runs (for context)\n${priorRunsContext}\n\n---\n\n`
        : '';
      strategistPrompt = `Investigate this ticket. Here is the full context:\n\n${contextParts.join('\n')}${priorNote}`;
    } else {
      strategistPrompt = `Continue the investigation. Here is the knowledge document so far:\n\n${currentRunContent}\n\n## Next Investigation Step\n${orchNextPrompt}`;
    }

    const strategistLogId = randomUUID();
    const strategistResponse = await ai.generate({
      taskType: (step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS) as TaskType,
      context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory: !!clientContext, orchestrationId, orchestrationIteration: i + 1, logId: strategistLogId },
      prompt: strategistPrompt,
      systemPrompt: ORCHESTRATED_SYSTEM_PROMPT,
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

    knowledgeDoc += `\n\n### Iteration ${i + 1}\n${plan.findings}`;

    await db.ticket.update({ where: { id: ticketId }, data: { knowledgeDoc } });

    appLog.info(
      `Orchestrated iteration ${i + 1}: ${plan.tasks.length} tasks, done=${plan.done}`,
      { ticketId, iteration: i + 1, taskCount: plan.tasks.length, done: plan.done },
      ticketId, 'ticket',
    );

    if (plan.done) {
      orchFinalAnalysis = plan.finalAnalysis ?? plan.findings;
      break;
    }

    orchNextPrompt = plan.nextPrompt ?? '';

    // Execute tasks in parallel batches
    const taskBatches = chunkArray(plan.tasks, maxParallelTasks);
    for (const batch of taskBatches) {
      const results = await Promise.allSettled(
        batch.map(task => executeOrchestratedSubTask(deps, ticketId, clientId, category, clientContext, environmentContext, task, agenticTools, mcpIntegrations, repoIdByPrefix, { id: orchestrationId, iteration: i + 1, parentLogId: strategistLogId }, orchModelMap)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const task = batch[j];
        if (result.status === 'fulfilled') {
          knowledgeDoc += `\n\n#### ${task.prompt}\n${result.value.content}`;
          orchTotalInputTokens += result.value.inputTokens;
          orchTotalOutputTokens += result.value.outputTokens;
          orchToolCallLog.push(...result.value.toolCalls);
        } else {
          // Retry once on failure
          try {
            const retryResult = await executeOrchestratedSubTask(deps, ticketId, clientId, category, clientContext, environmentContext, task, agenticTools, mcpIntegrations, repoIdByPrefix, { id: orchestrationId, iteration: i + 1, parentLogId: strategistLogId }, orchModelMap);
            knowledgeDoc += `\n\n#### ${task.prompt} (retry)\n${retryResult.content}`;
            orchTotalInputTokens += retryResult.inputTokens;
            orchTotalOutputTokens += retryResult.outputTokens;
            orchToolCallLog.push(...retryResult.toolCalls);
          } catch (retryErr) {
            knowledgeDoc += `\n\n#### ${task.prompt}\n*Failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}*`;
            appLog.warn(`Orchestrated task failed after retry: ${task.prompt}`, { ticketId, task: task.prompt, err: retryErr }, ticketId, 'ticket');
          }
        }
      }

      await db.ticket.update({ where: { id: ticketId }, data: { knowledgeDoc } });
    }
  }

  if (!orchFinalAnalysis) {
    orchFinalAnalysis = 'Orchestrated analysis reached maximum iterations without a final conclusion. Review the knowledge document for partial findings.';
  }

  // Parse sufficiency evaluation from the final analysis
  const { analysis: cleanOrchAnalysis, evaluation: orchSufficiency } = parseSufficiencyEvaluation(orchFinalAnalysis);

  return {
    analysis: cleanOrchAnalysis,
    toolCallLog: orchToolCallLog,
    totalInputTokens: orchTotalInputTokens,
    totalOutputTokens: orchTotalOutputTokens,
    iterationsRun: orchIterationsRun,
    sufficiencyEval: orchSufficiency,
  };
}
