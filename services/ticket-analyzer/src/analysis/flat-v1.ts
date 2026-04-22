import { randomUUID } from 'node:crypto';
import { createLogger } from '@bronco/shared-utils';
import { TaskType } from '@bronco/shared-types';
import type {
  AIMessage,
  AITextBlock,
  AIToolDefinition,
  AIToolResponse,
  AIToolResultBlock,
  AIToolUseBlock,
} from '@bronco/shared-types';
import {
  executeAgenticToolCall,
  parseSufficiencyEvaluation,
  saveMcpToolArtifact,
  SUFFICIENCY_EVAL_INSTRUCTIONS,
  type AnalysisDeps,
  type AnalysisPipelineContext,
  type AnalysisResult,
  type McpIntegrationInfo,
  type ReanalysisContext,
  type StrategyStep,
} from './shared.js';

const logger = createLogger('ticket-analyzer');

/**
 * Tool context pre-built by the dispatcher and shared across strategies.
 */
export interface AgenticToolContext {
  tools: AIToolDefinition[];
  mcpIntegrations: Map<string, McpIntegrationInfo>;
  repoIdByPrefix: Map<string, string>;
}

/**
 * Flat (full-context) agentic analysis. The strategist runs one loop with
 * access to all available MCP tools, calling them until it reaches a final
 * answer or hits `maxIterations`.
 */
export async function runFlatV1(
  deps: AnalysisDeps,
  ctx: AnalysisPipelineContext,
  step: StrategyStep,
  tools: AgenticToolContext,
  opts: { maxIterations: number; reanalysisCtx?: ReanalysisContext },
): Promise<AnalysisResult> {
  const { db, ai, appLog, artifactStoragePath } = deps;
  const { ticketId, clientId, category, priority, emailSubject, emailBody, clientContext, environmentContext, codeContext, dbContext, facts, summary } = ctx;
  const { maxIterations, reanalysisCtx } = opts;
  const { tools: agenticTools, mcpIntegrations, repoIdByPrefix } = tools;

  const stepConfig = step.config as { systemPromptOverride?: string } | null;

  const defaultMaxTokens = await deps.loadDefaultMaxTokens?.() ?? undefined;

  // Build system prompt with all available context
  const systemParts: string[] = [];

  if (reanalysisCtx) {
    // Re-analysis: conversation-aware system prompt
    systemParts.push(
      'You are an expert support engineer continuing an investigation on a ticket.',
      'The user has replied to your previous analysis with new instructions or questions.',
      'Follow their instructions. They may: ask you to investigate further, approve a fix (use the repo tools to make changes if applicable),',
      'ask clarifying questions, or request the analysis be emailed to someone else.',
      'Use the available tools as needed to fulfill the user\'s request.',
      '',
      `## Ticket`,
      `Subject: ${emailSubject}`,
      `Category: ${category}`,
      `Priority: ${priority}`,
      '',
      '## Conversation History',
      '',
      reanalysisCtx.conversationHistory,
    );
  } else {
    // Initial analysis: standard system prompt
    systemParts.push(
      'You are an expert support engineer investigating a ticket.',
      'Use the available tools to gather information needed for a thorough analysis.',
      'Query databases for health data, blocking, wait stats, and schema info.',
      'Search and read code repositories for relevant source code.',
      'When you have gathered enough information, provide your final analysis with:',
      '1. **Root Cause**: What is likely causing this issue',
      '2. **Evidence**: What tool results support your diagnosis',
      '3. **Affected Components**: Which files/services/tables are involved',
      '4. **Recommended Fix**: Step-by-step fix with code snippets where applicable',
      '5. **Risk Assessment**: What could go wrong, what to test',
      '',
      `## Ticket`,
      `Subject: ${emailSubject}`,
      `Category: ${category}`,
      `Priority: ${priority}`,
      '', emailBody,
    );
  }

  if (summary) systemParts.push('', `## Summary`, summary);
  if (clientContext) systemParts.push('', clientContext);
  if (environmentContext) systemParts.push('', environmentContext);
  if (facts.keywords?.length) systemParts.push('', `## Key Terms`, facts.keywords.join(', '));
  if (codeContext.length > 0) systemParts.push('', '## Previously Gathered Code Context', ...codeContext);
  if (dbContext) systemParts.push('', '## Previously Gathered DB Context', dbContext);
  if (stepConfig?.systemPromptOverride) systemParts.push('', stepConfig.systemPromptOverride);
  systemParts.push(SUFFICIENCY_EVAL_INSTRUCTIONS);

  const agenticSystemPrompt = systemParts.join('\n');

  // Agentic loop — use the reply text as the user message during re-analysis
  const initialUserMessage = reanalysisCtx
    ? reanalysisCtx.triggerReplyText || 'The user replied to the previous analysis. Please review the conversation history and continue the investigation.'
    : 'Investigate this ticket using the available tools. Query databases, search code, and read files as needed to understand the issue. When you have enough information, provide your final analysis.';
  const messages: AIMessage[] = [
    { role: 'user', content: initialUserMessage },
  ];
  const toolCallLog: Array<{ tool: string; system?: string; input: Record<string, unknown>; output: string; durationMs: number }> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  let finalAnalysis = '';
  let iterationsRun = 0;
  let previousAiCallId: string | undefined;
  for (let i = 0; i < maxIterations; i++) {
    iterationsRun = i + 1;
    const aiCallId = randomUUID();
    appLog.info(`Agentic analysis iteration ${i + 1}/${maxIterations}`, { ticketId, iteration: i + 1 }, ticketId, 'ticket');

    let response: AIToolResponse;
    try {
      response = await ai.generateWithTools({
        taskType: (step.taskTypeOverride ?? TaskType.DEEP_ANALYSIS) as TaskType,
        systemPrompt: agenticSystemPrompt,
        tools: agenticTools,
        messages,
        context: { ticketId, clientId, entityId: ticketId, entityType: 'ticket', ticketCategory: category, skipClientMemory: !!(clientContext || environmentContext), logId: aiCallId, strategy: 'flat' as const, strategyVersion: 'v1' as const, ...(previousAiCallId ? { parentLogId: previousAiCallId, parentLogType: 'ai' as const } : {}) },
        maxTokens: defaultMaxTokens ?? 4096,
      });
    } catch (error) {
      if (error instanceof Error && /tool/i.test(error.message) && /support/i.test(error.message)) {
        appLog.error(
          'Agentic analysis skipped: AI provider does not support tool use',
          { ticketId, iteration: i + 1, error: error.message },
          ticketId,
          'ticket',
        );
        finalAnalysis = '';
        break;
      }
      throw error;
    }

    totalInputTokens += response.usage?.inputTokens ?? 0;
    totalOutputTokens += response.usage?.outputTokens ?? 0;

    // Append assistant response to conversation
    messages.push({ role: 'assistant', content: response.contentBlocks });

    if (response.stopReason !== 'tool_use') {
      // Claude finished — extract final text
      finalAnalysis = response.contentBlocks
        .filter((b): b is AITextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      break;
    }

    // Execute tool calls
    const toolUseBlocks = response.contentBlocks.filter(
      (b): b is AIToolUseBlock => b.type === 'tool_use',
    );

    // Log Claude's reasoning from the response (text blocks alongside tool_use)
    const reasoningText = response.contentBlocks
      .filter((b): b is AITextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (reasoningText) {
      appLog.info(
        `Agentic reasoning (iteration ${i + 1}): ${reasoningText.slice(0, 200)}`,
        {
          ticketId,
          iteration: i + 1,
          reasoning: reasoningText.slice(0, 2000),
          toolsRequested: toolUseBlocks.map(t => t.name),
        },
        ticketId,
        'ticket',
      );
    }

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];

    for (const toolUse of toolUseBlocks) {
      const start = Date.now();
      const result = await executeAgenticToolCall(toolUse, mcpIntegrations, repoIdByPrefix, clientId);
      const elapsed = Date.now() - start;
      toolCallLog.push({
        tool: toolUse.name,
        system: (toolUse.input as Record<string, unknown>)?.system_name as string | undefined,
        input: toolUse.input,
        output: result.result.slice(0, 500), // truncate for metadata
        durationMs: elapsed,
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.result,
        ...(result.isError ? { is_error: true } : {}),
      });
      const agenticArtifactId = artifactStoragePath && !result.isError ? randomUUID() : undefined;
      if (artifactStoragePath && !result.isError) {
        void saveMcpToolArtifact(db, ticketId, toolUse.name, result.result, artifactStoragePath, agenticArtifactId).catch(error => {
          logger.warn({
            err: error,
            ticketId,
            toolName: toolUse.name,
          }, 'Failed to persist MCP tool artifact');
        });
      }
      appLog.info(
        `Agentic tool call: ${toolUse.name} (${elapsed}ms)`,
        {
          ticketId,
          tool: toolUse.name,
          durationMs: elapsed,
          iteration: i + 1,
          params: toolUse.input ? JSON.stringify(toolUse.input).slice(0, 1000) : null,
          resultPreview: result.result?.slice(0, 2000) ?? null,
          isError: result.isError ?? false,
          parentLogId: aiCallId,
          parentLogType: 'ai',
          ...(agenticArtifactId ? { artifactId: agenticArtifactId } : {}),
        },
        ticketId,
        'ticket',
      );
    }

    // Append tool results as user message
    messages.push({ role: 'user', content: toolResults as AIToolResultBlock[] });
    previousAiCallId = aiCallId;
  }

  if (!finalAnalysis) {
    finalAnalysis = 'Agentic analysis reached maximum iterations without a final conclusion. Review the tool call log for partial findings.';
  }

  // Parse sufficiency evaluation from the analysis response
  const { analysis: cleanAnalysis, evaluation: sufficiency } = parseSufficiencyEvaluation(finalAnalysis);

  return {
    analysis: cleanAnalysis,
    toolCallLog,
    totalInputTokens,
    totalOutputTokens,
    iterationsRun,
    sufficiencyEval: sufficiency,
  };
}
