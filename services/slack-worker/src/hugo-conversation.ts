import type { PrismaClient } from '@bronco/db';
import { Prisma } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import type { AIToolDefinition, AIMessage, AIContentBlock, AIToolUseBlock, AIToolResultBlock, AIToolResponse } from '@bronco/shared-types';
import type { SlackClient } from '@bronco/shared-utils';
import { callMcpToolViaSdk, createLogger } from '@bronco/shared-utils';
import type { Redis } from 'ioredis';
import { getPlatformTools } from './platform-tools.js';
import type { Config } from './config.js';

const logger = createLogger('hugo-conversation');

/** Max tool-use loop iterations per request to prevent runaway costs. */
const MAX_TOOL_ITERATIONS = 3;

/** Thread conversation context TTL — 30 minutes (in seconds for Redis EX). */
const THREAD_CONTEXT_TTL_SECONDS = 30 * 60;

const REDIS_KEY_PREFIX = 'hugo:thread:';

/** Max length for tool result preview stored in the conversation log. */
const TOOL_RESULT_PREVIEW_LENGTH = 500;

/** Max length for tool result content stored in messages (Redis + DB persistence). */
const TOOL_RESULT_MESSAGE_MAX_LENGTH = 2000;

// --- Redis-backed thread conversation context ---

interface TimestampedMessage {
  message: AIMessage;
  /** Unix epoch ms when this message was first added to the conversation. */
  addedAt: number;
}

interface ConversationEntry {
  messages: AIMessage[];
  /** Timestamps parallel to `messages`, indexed by position. */
  messageTimestamps?: number[];
  clientId: string | null;
  updatedAt: number;
}

function threadKey(channelId: string, threadTs: string): string {
  return `${REDIS_KEY_PREFIX}${channelId}:${threadTs}`;
}

async function getConversation(
  redis: Redis,
  channelId: string,
  threadTs: string,
): Promise<ConversationEntry | null> {
  const raw = await redis.get(threadKey(channelId, threadTs));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConversationEntry;
  } catch {
    logger.warn({ channelId, threadTs }, 'Failed to parse conversation entry from Redis');
    return null;
  }
}

async function storeConversation(
  redis: Redis,
  channelId: string,
  threadTs: string,
  timestampedMessages: TimestampedMessage[],
  clientId: string | null,
): Promise<void> {
  const entry: ConversationEntry = {
    messages: timestampedMessages.map(t => t.message),
    messageTimestamps: timestampedMessages.map(t => t.addedAt),
    clientId,
    updatedAt: Date.now(),
  };
  await redis.set(
    threadKey(channelId, threadTs),
    JSON.stringify(entry),
    'EX',
    THREAD_CONTEXT_TTL_SECONDS,
  );
}

// --- Cost / tool call tracking ---

interface ToolCallLogEntry {
  tool: string;
  params: Record<string, unknown>;
  resultPreview: string;
  durationMs: number;
  isError: boolean;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  toolCalls: ToolCallLogEntry[];
}

function accumulateUsage(acc: UsageAccumulator, response: AIToolResponse): void {
  acc.inputTokens += response.usage?.inputTokens ?? 0;
  acc.outputTokens += response.usage?.outputTokens ?? 0;
}

// --- Dependencies ---

export interface HugoConversationDeps {
  db: PrismaClient;
  ai: AIRouter;
  slack: SlackClient;
  config: Config;
  redis: Redis;
}

// --- System prompt ---

function buildHugoSystemPrompt(
  client: { id: string; name: string; shortCode: string } | null,
  operator: { id: string; name: string },
): string {
  const clientContext = client
    ? `You are operating in the context of client "${client.name}" (${client.shortCode}). When calling tools that accept clientId, use "${client.id}" unless the operator specifies a different client.`
    : `No client is mapped to this channel. If the operator's request requires a client context, ask them which client they mean. You can use list_clients to show available clients.`;

  return `You are Hugo, the Bronco operations assistant. You help operators manage their database infrastructure platform via Slack.

${clientContext}

The operator's name is ${operator.name}.

Guidelines:
- Be concise — this is Slack, not an email. Short responses.
- Use the available tools to answer questions and take actions.
- When listing items, show the most relevant fields in a formatted list (not raw JSON).
- For state-modifying actions (create, update, delete), confirm what you're about to do before executing if the intent is ambiguous.
- If you're not sure what the operator wants, ask a clarifying question.
- When something fails, explain what was attempted, what went wrong (include the error message), and suggest what to do next. Never say "something went wrong" without context.
- Format Slack messages with *bold*, \`code\`, and bullet points for readability.
- If the operator asks about costs, use get_ai_usage or get_ticket_cost.
- If the operator asks to run a probe, use run_probe (you may need to list_probes first to find the ID).`;
}

// --- Tool execution loop ---

function extractToolUseBlocks(response: AIToolResponse): AIToolUseBlock[] {
  return response.contentBlocks.filter(
    (b): b is AIToolUseBlock => b.type === 'tool_use',
  );
}

function extractTextContent(response: AIToolResponse): string {
  return response.contentBlocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

async function executeToolLoop(
  deps: HugoConversationDeps,
  initialResponse: AIToolResponse,
  timestampedMessages: TimestampedMessage[],
  tools: AIToolDefinition[],
  systemPrompt: string,
  client: { id: string; name: string; shortCode: string } | null,
  operator: { id: string; name: string },
  usage: UsageAccumulator,
  repoIdByPrefix: Map<string, string> = new Map(),
  repoToolPrefixes: Set<string> = new Set(),
): Promise<{ text: string; timestampedMessages: TimestampedMessage[] }> {
  let response = initialResponse;
  const current: TimestampedMessage[] = [...timestampedMessages];

  // Helper: extract plain AIMessage array for model calls
  const toMessages = (ts: TimestampedMessage[]): AIMessage[] => ts.map(t => t.message);

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const toolUseBlocks = extractToolUseBlocks(response);
    if (toolUseBlocks.length === 0) break;

    // Execute each tool call via MCP Platform Server
    const toolResults: Array<{ toolUseId: string; result: string; isError: boolean }> = [];
    for (const toolUse of toolUseBlocks) {
      const startMs = Date.now();
      let result: string;
      let isError = false;
      try {
        // Route repo tools to mcp-repo, everything else to mcp-platform
        const sepIdx = toolUse.name.indexOf('__');
        const toolPrefix = sepIdx !== -1 ? toolUse.name.slice(0, sepIdx) : '';
        const isRepoTool = repoToolPrefixes.has(toolPrefix);

        if (isRepoTool) {
          const actualToolName = toolUse.name.slice(sepIdx + 2);
          let toolInput = toolUse.input;
          // For repo_exec, inject the baked-in repoId and clientId
          if (actualToolName === 'repo_exec') {
            const repoId = repoIdByPrefix.get(toolPrefix);
            if (repoId) {
              toolInput = { ...toolInput, repoId, ...(client ? { clientId: client.id } : {}) };
            }
          } else if (actualToolName === 'list_repos' && client) {
            toolInput = { ...toolInput, clientId: client.id };
          }
          logger.info({ tool: toolUse.name, actualTool: actualToolName, iteration: i + 1 }, 'Executing mcp-repo tool');
          result = await callMcpToolViaSdk(
            deps.config.MCP_REPO_URL,
            '/mcp',
            actualToolName,
            toolInput,
            deps.config.MCP_AUTH_TOKEN || deps.config.API_KEY,
            deps.config.MCP_AUTH_TOKEN ? undefined : 'x-api-key',
            'slack-worker',
          );
        } else {
          logger.info({ tool: toolUse.name, iteration: i + 1 }, 'Executing MCP Platform tool');
          result = await callMcpToolViaSdk(
            deps.config.MCP_PLATFORM_URL,
            '/mcp',
            toolUse.name,
            toolUse.input,
            deps.config.MCP_AUTH_TOKEN || deps.config.API_KEY,
            deps.config.MCP_AUTH_TOKEN ? undefined : 'x-api-key',
            'slack-worker',
          );
        }
      } catch (err) {
        result = err instanceof Error ? err.message : String(err);
        isError = true;
        logger.warn({ err, tool: toolUse.name }, 'MCP Platform tool call failed');
      }
      const durationMs = Date.now() - startMs;

      toolResults.push({ toolUseId: toolUse.id, result, isError });

      // Track tool call for logging
      usage.toolCalls.push({
        tool: toolUse.name,
        params: toolUse.input,
        resultPreview: result.length > TOOL_RESULT_PREVIEW_LENGTH
          ? result.slice(0, TOOL_RESULT_PREVIEW_LENGTH) + '…'
          : result,
        durationMs,
        isError,
      });
    }

    const now = Date.now();
    // Append assistant response + tool results to messages (with timestamps)
    current.push({ message: { role: 'assistant', content: response.contentBlocks as AIContentBlock[] }, addedAt: now });
    current.push({
      message: {
        role: 'user',
        content: toolResults.map(r => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolUseId,
          content: r.result,
          ...(r.isError ? { is_error: true } : {}),
        })),
      },
      addedAt: now,
    });

    // Call AI again with tool results (use full, untruncated messages)
    response = await deps.ai.generateWithTools({
      taskType: 'CUSTOM_AI_QUERY',
      context: {
        entityId: operator.id,
        entityType: 'operator',
        clientId: client?.id,
      },
      messages: toMessages(current),
      tools,
      systemPrompt,
      providerOverride: 'CLAUDE',
      modelOverride: 'claude-sonnet-4-6',
      maxTokens: 4096,
    });
    accumulateUsage(usage, response);

    // If response is text (not tool_use), we're done
    if (response.stopReason !== 'tool_use') {
      const text = extractTextContent(response) || response.content;
      current.push({ message: { role: 'assistant', content: text }, addedAt: Date.now() });
      return { text, timestampedMessages: current };
    }
  }

  // Exhausted iterations — return whatever text we have
  const text = extractTextContent(response) || response.content || 'I completed the requested operations.';
  current.push({ message: { role: 'assistant', content: text }, addedAt: Date.now() });
  return { text, timestampedMessages: current };
}

// --- Conversation log persistence ---

/**
 * Truncate tool_result content for persistence.
 * Full content is kept for model calls but truncated when stored in Redis / DB
 * to prevent unbounded growth over multiple turns.
 */
function truncateToolResults(content: AIMessage['content']): AIMessage['content'] {
  if (typeof content === 'string') return content;
  // Only AIToolResultBlock[] arrays can contain tool_result blocks.
  // AIContentBlock[] contains text/tool_use only.
  const blocks = content as (AIContentBlock | AIToolResultBlock)[];
  return blocks.map(block => {
    if (block.type === 'tool_result') {
      const b = block as AIToolResultBlock;
      if (b.content.length > TOOL_RESULT_MESSAGE_MAX_LENGTH) {
        return { ...b, content: b.content.slice(0, TOOL_RESULT_MESSAGE_MAX_LENGTH) + '…' };
      }
    }
    return block;
  }) as AIMessage['content'];
}

function serializeMessages(timestampedMessages: TimestampedMessage[]): unknown[] {
  return timestampedMessages.map(({ message: m, addedAt }) => ({
    role: m.role,
    content: (() => {
      const truncated = truncateToolResults(m.content);
      return typeof truncated === 'string' ? truncated : JSON.stringify(truncated);
    })(),
    timestamp: new Date(addedAt).toISOString(),
  }));
}

async function persistConversationLog(
  db: PrismaClient,
  operatorId: string,
  channelId: string,
  threadTs: string,
  clientId: string | null,
  timestampedMessages: TimestampedMessage[],
  usage: UsageAccumulator,
): Promise<void> {
  try {
    const serialized = serializeMessages(timestampedMessages);
    const userMessageCount = timestampedMessages.filter(
      ({ message: m }) => m.role === 'user' && typeof m.content === 'string',
    ).length;

    const messagesJson = serialized as unknown as Prisma.InputJsonValue;
    // Always write toolCalls — use [] when there are none to avoid stale data from previous turns.
    const toolCallsJson = usage.toolCalls as unknown as Prisma.InputJsonValue;

    await db.slackConversationLog.upsert({
      where: { channelId_threadTs: { channelId, threadTs } },
      update: {
        messages: messagesJson,
        toolCalls: toolCallsJson,
        // Increment token totals so multi-turn conversations accumulate correctly
        // rather than overwriting with only the current request's values.
        ...(usage.inputTokens > 0 && {
          totalInputTokens: { increment: usage.inputTokens },
        }),
        ...(usage.outputTokens > 0 && {
          totalOutputTokens: { increment: usage.outputTokens },
        }),
        messageCount: userMessageCount,
      },
      create: {
        operatorId,
        channelId,
        threadTs,
        clientId,
        messages: messagesJson,
        toolCalls: toolCallsJson,
        totalInputTokens: usage.inputTokens > 0 ? usage.inputTokens : undefined,
        totalOutputTokens: usage.outputTokens > 0 ? usage.outputTokens : undefined,
        messageCount: userMessageCount,
      },
    });
  } catch (err) {
    // Non-blocking — if the DB write fails, the Slack response was already sent
    logger.warn({ err, channelId, threadTs }, 'Failed to persist conversation log');
  }
}

// --- Main conversation handler ---

export async function handleHugoConversation(
  deps: HugoConversationDeps,
  channelId: string,
  userId: string,
  text: string,
  ts: string,
  threadTs?: string,
): Promise<void> {
  const { db, ai, slack, config, redis } = deps;

  // 1. Strip leading bot mention from text (anchored prefix only — do not remove
  //    subsequent @mentions that are part of the operator's message content).
  const cleanText = text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  if (!cleanText) {
    await slack.replyInThread(channelId, ts, 'Hi! What can I help you with?');
    return;
  }

  // 2. Resolve operator from Slack user
  const operatorRow = await db.operator.findFirst({
    where: { slackUserId: userId, person: { isActive: true } },
    select: { id: true, person: { select: { name: true } } },
  });
  const operator = operatorRow ? { id: operatorRow.id, name: operatorRow.person.name } : null;

  if (!operator) {
    await slack.replyInThread(
      channelId,
      ts,
      `I don't recognize you as an operator. Ask an admin to add your Slack User ID (\`${userId}\`) to your operator profile in the control panel.`,
    );
    return;
  }

  // 3. Resolve client from channel
  const client = await db.client.findFirst({
    where: { slackChannelId: channelId, isActive: true },
    select: { id: true, name: true, shortCode: true },
  });

  // 4. Build system prompt with context
  const systemPrompt = buildHugoSystemPrompt(client, operator);

  // 5. Get MCP Platform tools
  let tools: AIToolDefinition[];
  const repoIdByPrefix = new Map<string, string>();
  const repoToolPrefixes = new Set<string>();
  try {
    tools = await getPlatformTools(config.MCP_PLATFORM_URL, { apiKey: config.API_KEY, authToken: config.MCP_AUTH_TOKEN });
  } catch (err) {
    logger.error({ err }, 'Failed to discover MCP Platform tools');
    await slack.replyInThread(
      channelId,
      ts,
      'I couldn\'t connect to the platform tools service. Please check that `mcp-platform` is running and try again.',
    );
    return;
  }

  // 5b. Discover mcp-repo tools for the client's code repositories
  if (client) {
    try {
      const clientRepos = await db.codeRepo.findMany({ where: { clientId: client.id, isActive: true } });
      if (clientRepos.length > 0) {
        // Register shared list_repos and repo_cleanup tools
        tools.push({
          name: 'repo__list_repos',
          description: 'List available code repositories registered for this client.',
          input_schema: {
            type: 'object',
            properties: {
              clientId: { type: 'string', description: 'Client ID to filter by' },
            },
            required: ['clientId'],
          },
        });
        repoToolPrefixes.add('repo');

        tools.push({
          name: 'repo__repo_cleanup',
          description: 'Release a session\'s repository worktrees to free disk space.',
          input_schema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID to clean up' },
            },
            required: ['sessionId'],
          },
        });

        // Register per-repo repo_exec tools with repoId baked in
        for (const repo of clientRepos) {
          const prefix = `repo-${repo.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}-${repo.id.slice(0, 8)}`;
          repoIdByPrefix.set(prefix, repo.id);
          repoToolPrefixes.add(prefix);

          tools.push({
            name: `${prefix}__repo_exec`,
            description: `[${repo.name}] ${repo.description || 'Code repository'}. Execute a read-only shell command in a sandboxed worktree. Allowed: grep, find, cat, head, tail, ls, tree, diff, stat. Pipes to grep/sed/awk/sort allowed.`,
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The shell command to execute' },
                sessionId: { type: 'string', description: 'Session ID for worktree reuse (auto-generated if omitted)' },
              },
              required: ['command'],
            },
          });
        }
        logger.info({ clientId: client.id, repoCount: clientRepos.length }, 'Registered mcp-repo tools for client');
      }
    } catch (err) {
      logger.warn({ err, clientId: client.id }, 'Failed to discover mcp-repo tools, continuing without repo access');
    }
  }

  // 6. Load thread context if this is a reply in an existing thread
  const effectiveThreadTs = threadTs ?? ts;
  const existing = await getConversation(redis, channelId, effectiveThreadTs);

  // Reconstruct TimestampedMessage history, falling back to Date.now() for entries
  // that pre-date the messageTimestamps field.
  const threadHistory: TimestampedMessage[] = (existing?.messages ?? []).map((m, idx) => ({
    message: m,
    addedAt: existing?.messageTimestamps?.[idx] ?? Date.now(),
  }));

  // 7. Build timestamped message list
  const now = Date.now();
  const timestampedMessages: TimestampedMessage[] = [
    ...threadHistory,
    { message: { role: 'user' as const, content: cleanText }, addedAt: now },
  ];

  // Plain AIMessage[] for the first model call
  const messages: AIMessage[] = timestampedMessages.map(t => t.message);

  // 8. Initialize usage accumulator
  const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0, toolCalls: [] };

  // 9. Call Sonnet with tools
  let response: AIToolResponse;
  try {
    response = await ai.generateWithTools({
      taskType: 'CUSTOM_AI_QUERY',
      context: {
        entityId: operator.id,
        entityType: 'operator',
        clientId: client?.id,
      },
      messages,
      tools,
      systemPrompt,
      providerOverride: 'CLAUDE',
      modelOverride: 'claude-sonnet-4-6',
      maxTokens: 4096,
    });
    accumulateUsage(usage, response);
  } catch (err) {
    logger.error({ err }, 'AI generateWithTools failed');
    await slack.replyInThread(
      channelId,
      ts,
      'I encountered an error processing your request. The AI service may be temporarily unavailable. Please try again shortly.',
    );
    return;
  }

  // 10. Execute tool calls if any
  let finalText: string;
  let finalTimestampedMessages: TimestampedMessage[];

  if (response.stopReason === 'tool_use') {
    const result = await executeToolLoop(
      deps,
      response,
      timestampedMessages,
      tools,
      systemPrompt,
      client,
      operator,
      usage,
      repoIdByPrefix,
      repoToolPrefixes,
    );
    finalText = result.text;
    finalTimestampedMessages = result.timestampedMessages;
  } else {
    finalText = extractTextContent(response) || response.content;
    finalTimestampedMessages = [
      ...timestampedMessages,
      { message: { role: 'assistant' as const, content: finalText }, addedAt: Date.now() },
    ];
  }

  // 11. Reply in thread
  await slack.replyInThread(channelId, ts, finalText);

  // 12. Store thread context for follow-ups
  await storeConversation(redis, channelId, effectiveThreadTs, finalTimestampedMessages, client?.id ?? null);

  // 13. Persist conversation log (non-blocking)
  void persistConversationLog(
    db,
    operator.id,
    channelId,
    effectiveThreadTs,
    client?.id ?? null,
    finalTimestampedMessages,
    usage,
  );
}
