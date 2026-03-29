import Anthropic from '@anthropic-ai/sdk';
import { AIProvider as AIProviderEnum } from '@bronco/shared-types';
import type { AITextBlock, AIToolUseBlock } from '@bronco/shared-types';
import type { AIProviderClient, AIRequest, AIResponse, AIToolRequest, AIToolResponse } from './types.js';

export class ClaudeClient implements AIProviderClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = 'claude-sonnet-4-6') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const start = Date.now();

    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: request.maxTokens ?? 4096,
        system: request.systemPrompt ?? '',
        messages: [{ role: 'user', content: request.prompt }],
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const textContent = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      provider: AIProviderEnum.CLAUDE,
      content: textContent,
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      durationMs: Date.now() - start,
    };
  }

  async generateWithTools(request: AIToolRequest): Promise<AIToolResponse> {
    const start = Date.now();

    const tools: Anthropic.Messages.Tool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
    }));

    // Map AIMessage[] to Anthropic message params
    const messages: Anthropic.Messages.MessageParam[] = request.messages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }
      // Array content — map our types to Anthropic types
      const blocks = (m.content as unknown as Array<Record<string, unknown>>).map((block) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text as string };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id as string,
            name: block.name as string,
            input: block.input as Record<string, unknown>,
          };
        }
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id as string,
            content: block.content as string,
            ...(block.is_error ? { is_error: true as const } : {}),
          };
        }
        return { type: 'text' as const, text: JSON.stringify(block) };
      });
      return { role: m.role as 'user' | 'assistant', content: blocks };
    });

    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: request.maxTokens ?? 4096,
        system: request.systemPrompt ?? '',
        messages,
        tools,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const contentBlocks: Array<AITextBlock | AIToolUseBlock> = message.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      }
      // tool_use block
      return {
        type: 'tool_use' as const,
        id: (block as Anthropic.Messages.ToolUseBlock).id,
        name: (block as Anthropic.Messages.ToolUseBlock).name,
        input: (block as Anthropic.Messages.ToolUseBlock).input as Record<string, unknown>,
      };
    });

    const textContent = contentBlocks
      .filter((b): b is AITextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      provider: AIProviderEnum.CLAUDE,
      content: textContent,
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      durationMs: Date.now() - start,
      stopReason: message.stop_reason === 'tool_use' ? 'tool_use' : message.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn',
      contentBlocks,
    };
  }
}
