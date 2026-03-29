import { AIProvider as AIProviderEnum } from '@bronco/shared-types';
import type { AIProviderClient, AIRequest, AIResponse } from './types.js';

export class OllamaClient implements AIProviderClient {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model = 'llama3.1:8b') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const start = Date.now();

    const body: Record<string, unknown> = {
      model: this.model,
      prompt: request.prompt,
      stream: false,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }
    if (request.temperature !== undefined) {
      body.options = { temperature: request.temperature };
    }

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(request.signal && { signal: request.signal }),
    });

    if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as {
      response: string;
      model: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      provider: AIProviderEnum.LOCAL,
      content: data.response,
      model: data.model,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      durationMs: Date.now() - start,
    };
  }
}
