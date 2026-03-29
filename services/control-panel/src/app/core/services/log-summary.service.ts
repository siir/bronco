import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export type LogSummaryType = 'TICKET' | 'ORPHAN' | 'SERVICE' | 'UNCATEGORIZED';
export type AttentionLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface LogSummary {
  id: string;
  ticketId: string | null;
  summaryType: LogSummaryType;
  attentionLevel: AttentionLevel;
  windowStart: string;
  windowEnd: string;
  summary: string;
  logCount: number;
  services: string[];
  createdAt: string;
}

export interface LogSummaryResponse {
  summaries: LogSummary[];
  total: number;
}

export interface LogSummaryFilters {
  ticketId?: string;
  type?: 'ticket' | 'orphan' | 'service' | 'uncategorized';
  attentionLevel?: AttentionLevel;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface GenerateResult {
  created: number;
  skipped: number;
}

export interface FullPassResult {
  ticketSummaries: number;
  orphanSummaries: number;
  serviceSummaries: number;
  uncategorizedSummaries: number;
}

@Injectable({ providedIn: 'root' })
export class LogSummaryService {
  private api = inject(ApiService);

  getSummaries(filters?: LogSummaryFilters): Observable<LogSummaryResponse> {
    const params: Record<string, string | number> = {};
    if (filters?.ticketId) params['ticketId'] = filters.ticketId;
    if (filters?.type) params['type'] = filters.type;
    if (filters?.attentionLevel) params['attentionLevel'] = filters.attentionLevel;
    if (filters?.since) params['since'] = filters.since;
    if (filters?.until) params['until'] = filters.until;
    if (filters?.limit) params['limit'] = filters.limit;
    if (filters?.offset) params['offset'] = filters.offset;
    return this.api.get<LogSummaryResponse>('/log-summaries', params);
  }

  generateForTicket(ticketId: string): Observable<GenerateResult> {
    return this.api.post<GenerateResult>('/log-summaries/generate-ticket', { ticketId });
  }

  generateAll(): Observable<FullPassResult> {
    return this.api.post<FullPassResult>('/log-summaries/generate', {});
  }
}
