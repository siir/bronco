import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface SlackConversationSummary {
  id: string;
  channelId: string;
  threadTs: string;
  messageCount: number;
  totalCost: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  createdAt: string;
  updatedAt: string;
  operator: { id: string; person: { name: string } } | null;
  client: { id: string; name: string; shortCode: string } | null;
}

export interface SlackConversationDetail extends SlackConversationSummary {
  operatorId: string;
  clientId: string | null;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
  }>;
  toolCalls: Array<{
    tool: string;
    params: Record<string, unknown>;
    resultPreview: string;
    durationMs: number;
    isError: boolean;
  }> | null;
}

export interface SlackConversationListResponse {
  items: SlackConversationSummary[];
  total: number;
}

export interface SlackConversationFilters {
  operatorId?: string;
  clientId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

@Injectable({ providedIn: 'root' })
export class SlackConversationService {
  private api = inject(ApiService);

  getConversations(filters?: SlackConversationFilters): Observable<SlackConversationListResponse> {
    return this.api.get<SlackConversationListResponse>(
      '/slack-conversations',
      filters as Record<string, string | number>,
    );
  }

  getConversation(id: string): Observable<SlackConversationDetail> {
    return this.api.get<SlackConversationDetail>(`/slack-conversations/${id}`);
  }
}
