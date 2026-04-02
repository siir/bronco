import type { PrismaClient } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import type { AIToolDefinition, AIMessage, AIContentBlock, AIToolUseBlock, AIToolResponse } from '@bronco/shared-types';
import type { SlackClient } from '@bronco/shared-utils';
import { callMcpToolViaSdk, createLogger } from '@bronco/shared-utils';
import { getPlatformTools } from './platform-tools.js';
import type { Config } from './config.js';

const logger = createLogger('hugo-conversation');

/** Max tool-use loop iterations per request to prevent runaway costs. */
const MAX_TOOL_ITERATIONS = 3;

/** Thread conversation context TTL — 30 minutes. */
const THREAD_CONTEXT_TTL_MS = 30 * 60 * 1000;

// --- Thread conversation context (in-memory) ---

interface ConversationEntry {
  messages: AIMessage[];
  clientId: string | null;
  updatedAt: number;
}

const conversationStore = new Map<string, ConversationEntry>();

function conversationKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function getConversation(channelId: string, threadTs: string): ConversationEntry | undefined {
  const entry = conversationStore.get(conversationKey(channelId, threadTs));
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > THREAD_CONTEXT_TTL_MS) {
    conversationStore.delete(conversationKey(channelId, threadTs));
    return undefined;
  }
  return entry;
}

function storeConversation(
  channelId: string,
  threadTs: string,
  messages: AIMessage[],
  clientId: string | null,
): void {
  conversationStore.set(conversationKey(channelId, threadTs), {
    messages,
    clientId,
    updatedAt: Date.now(),
  });
}

/** Evict expired conversation entries. Called periodically. */
export function evictStaleConversations(): number {
  const cutoff = Date.now() - THREAD_CONTEXT_TTL_MS;
  let evicted = 0;
  for (const [key, entry] of conversationStore) {
    if (entry.updatedAt < cutoff) {
      conversationStore.delete(key);
      evicted++;
    }
  }
  return evicted;
}

// --- Dependencies ---

export interface HugoConversationDeps {
  db: PrismaClient;
  ai: AIRouter;
  slack: SlackClient;
  config: Config;
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
  messages: AIMessage[],
  tools: AIToolDefinition[],
  systemPrompt: string,
  client: { id: string; name: string; shortCode: string } | null,
  operator: { id: string; name: string },
): Promise<{ text: string; messages: AIMessage[] }> {
  let response = initialResponse;
  const currentMessages = [...messages];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const toolUseBlocks = extractToolUseBlocks(response);
    if (toolUseBlocks.length === 0) break;

    // Execute each tool call via MCP Platform Server
    const toolResults: Array<{ toolUseId: string; result: string; isError: boolean }> = [];
    for (const toolUse of toolUseBlocks) {
      try {
        logger.info({ tool: toolUse.name, iteration: i + 1 }, 'Executing MCP Platform tool');
        const result = await callMcpToolViaSdk(
          deps.config.MCP_PLATFORM_URL,
          '/mcp',
          toolUse.name,
          toolUse.input,
        );
        toolResults.push({ toolUseId: toolUse.id, result, isError: false });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, tool: toolUse.name }, 'MCP Platform tool call failed');
        toolResults.push({ toolUseId: toolUse.id, result: errMsg, isError: true });
      }
    }

    // Append assistant response + tool results to messages
    currentMessages.push({
      role: 'assistant',
      content: response.contentBlocks as AIContentBlock[],
    });
    currentMessages.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolUseId,
        content: r.result,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });

    // Call AI again with tool results
    response = await deps.ai.generateWithTools({
      taskType: 'CUSTOM_AI_QUERY',
      context: {
        entityId: operator.id,
        entityType: 'operator',
        clientId: client?.id,
      },
      messages: currentMessages,
      tools,
      systemPrompt,
      providerOverride: 'CLAUDE',
      modelOverride: 'claude-sonnet-4-6',
      maxTokens: 4096,
    });

    // If response is text (not tool_use), we're done
    if (response.stopReason !== 'tool_use') {
      const text = extractTextContent(response) || response.content;
      currentMessages.push({ role: 'assistant', content: text });
      return { text, messages: currentMessages };
    }
  }

  // Exhausted iterations — return whatever text we have
  const text = extractTextContent(response) || response.content || 'I completed the requested operations.';
  currentMessages.push({ role: 'assistant', content: text });
  return { text, messages: currentMessages };
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
  const { db, ai, slack, config } = deps;

  // 1. Strip bot mention from text
  const cleanText = text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  if (!cleanText) {
    await slack.replyInThread(channelId, ts, 'Hi! What can I help you with?');
    return;
  }

  // 2. Resolve operator from Slack user
  const operator = await db.operator.findFirst({
    where: { slackUserId: userId, isActive: true },
    select: { id: true, name: true },
  });

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
  try {
    tools = await getPlatformTools(config.MCP_PLATFORM_URL);
  } catch (err) {
    logger.error({ err }, 'Failed to discover MCP Platform tools');
    await slack.replyInThread(
      channelId,
      ts,
      'I couldn\'t connect to the platform tools service. Please check that `mcp-platform` is running and try again.',
    );
    return;
  }

  // 6. Load thread context if this is a reply in an existing thread
  const effectiveThreadTs = threadTs ?? ts;
  const existing = getConversation(channelId, effectiveThreadTs);
  const threadHistory: AIMessage[] = existing?.messages ?? [];

  // 7. Build messages
  const messages: AIMessage[] = [
    ...threadHistory,
    { role: 'user' as const, content: cleanText },
  ];

  // 8. Call Sonnet with tools
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
  } catch (err) {
    logger.error({ err }, 'AI generateWithTools failed');
    await slack.replyInThread(
      channelId,
      ts,
      'I encountered an error processing your request. The AI service may be temporarily unavailable. Please try again shortly.',
    );
    return;
  }

  // 9. Execute tool calls if any
  let finalText: string;
  let finalMessages: AIMessage[];

  if (response.stopReason === 'tool_use') {
    const result = await executeToolLoop(
      deps,
      response,
      messages,
      tools,
      systemPrompt,
      client,
      operator,
    );
    finalText = result.text;
    finalMessages = result.messages;
  } else {
    finalText = extractTextContent(response) || response.content;
    finalMessages = [...messages, { role: 'assistant' as const, content: finalText }];
  }

  // 10. Reply in thread
  await slack.replyInThread(channelId, ts, finalText);

  // 11. Store thread context for follow-ups
  storeConversation(channelId, effectiveThreadTs, finalMessages, client?.id ?? null);
}
