import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

/** Comma-separated active status values for API queries. Single source of truth for the UI. */
export const ACTIVE_STATUS_FILTER = 'OPEN,IN_PROGRESS,WAITING';

export interface TicketFollower {
  id: string;
  ticketId: string;
  contactId: string;
  followerType: 'REQUESTER' | 'FOLLOWER';
  createdAt: string;
  contact?: { name: string; email: string };
}

export interface Ticket {
  id: string;
  clientId: string;
  systemId: string | null;
  subject: string;
  description: string | null;
  summary: string | null;
  status: string;
  priority: string;
  source: string;
  category: string | null;
  ticketNumber: number | null;
  analysisStatus: string;
  analysisError: string | null;
  lastAnalyzedAt: string | null;
  externalRef: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string };
  system?: { name: string } | null;
  followers?: TicketFollower[];
  _count?: { events: number; artifacts: number };
}

export interface TicketStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  eventType: string;
  content: string | null;
  metadata: unknown;
  actor: string;
  createdAt: string;
}

export interface TicketAppLog {
  id: string;
  level: string;
  service: string;
  message: string;
  context: Record<string, unknown> | null;
  entityId: string | null;
  entityType: string | null;
  error: string | null;
  createdAt: string;
}

export interface TicketLogsResponse {
  logs: TicketAppLog[];
  total: number;
}

export interface TicketAiUsageLog {
  id: string;
  provider: string;
  model: string;
  taskType: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  costUsd: number | null;
  entityId: string | null;
  entityType: string | null;
  promptKey: string | null;
  createdAt: string;
}

export interface TicketAiUsageResponse {
  logs: TicketAiUsageLog[];
  total: number;
}

@Injectable({ providedIn: 'root' })
export class TicketService {
  private api = inject(ApiService);

  getTickets(filters?: { clientId?: string; status?: string; category?: string; limit?: number; offset?: number }): Observable<Ticket[]> {
    return this.api.get<Ticket[]>('/tickets', filters as Record<string, string | number>);
  }

  getStats(clientId?: string): Observable<TicketStats> {
    return this.api.get<TicketStats>('/tickets/stats', clientId ? { clientId } : undefined);
  }

  getTicket(id: string): Observable<Ticket & { events: TicketEvent[] }> {
    return this.api.get(`/tickets/${id}`);
  }

  createTicket(data: Partial<Ticket> & { clientId: string; subject: string }): Observable<Ticket> {
    return this.api.post<Ticket>('/tickets', data);
  }

  updateTicket(id: string, data: Partial<Ticket>): Observable<Ticket> {
    return this.api.patch<Ticket>(`/tickets/${id}`, data);
  }

  addEvent(ticketId: string, data: { eventType: string; content?: string; actor?: string }): Observable<TicketEvent> {
    return this.api.post<TicketEvent>(`/tickets/${ticketId}/events`, data);
  }

  getTicketLogs(ticketId: string, filters?: { level?: string; service?: string; search?: string; limit?: number; offset?: number }): Observable<TicketLogsResponse> {
    return this.api.get<TicketLogsResponse>(`/tickets/${ticketId}/logs`, filters as Record<string, string | number>);
  }

  getTicketAiUsage(ticketId: string, filters?: { limit?: number; offset?: number }): Observable<TicketAiUsageResponse> {
    return this.api.get<TicketAiUsageResponse>(`/tickets/${ticketId}/ai-usage`, filters as Record<string, string | number>);
  }

  reanalyze(ticketId: string): Observable<{ queued: boolean; ticketId: string; jobId: string }> {
    return this.api.post<{ queued: boolean; ticketId: string; jobId: string }>(`/tickets/${ticketId}/reanalyze`, {});
  }

  askAi(ticketId: string, params?: { question?: string; provider?: string; model?: string; taskType?: string }): Observable<AiHelpResponse> {
    return this.api.post<AiHelpResponse>(`/tickets/${ticketId}/ai-help`, params ?? {});
  }
}

export interface AiHelpResponse {
  content: string;
  provider: string;
  model: string;
}
