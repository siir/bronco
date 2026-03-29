import OpenAI from 'openai';
import { AIProvider as AIProviderEnum } from '@bronco/shared-types';
import type { AIProvider } from '@bronco/shared-types';
import type { AIProviderClient, AIRequest, AIResponse } from './types.js';

/**
 * OpenAI-compatible client used for both OpenAI and Grok (xAI).
 * Grok exposes an OpenAI-compatible API at https://api.x.ai/v1.
 */
export class OpenAIClient implements AIProviderClient {
  private client: OpenAI;
  private model: string;
  private providerLabel: AIProvider;

  constructor(apiKey: string, model: string, baseURL?: string | null, providerLabel: AIProvider = AIProviderEnum.OPENAI) {
    this.client = new OpenAI({
      apiKey,
      ...(baseURL && { baseURL }),
    });
    this.model = model;
    this.providerLabel = providerLabel;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const start = Date.now();

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    const completion = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    if (!completion.choices || completion.choices.length === 0) {
      throw new Error(
        `[${this.providerLabel}] Chat completion returned no choices for model "${completion.model}".`,
      );
    }

    const choice = completion.choices[0];

    if (!choice.message || typeof choice.message.content !== 'string') {
      throw new Error(
        `[${this.providerLabel}] Chat completion returned a non-text or missing message content for model "${completion.model}".`,
      );
    }

    const content = choice.message.content;

    return {
      provider: this.providerLabel,
      content,
      model: completion.model,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
      durationMs: Date.now() - start,
    };
  }
}
