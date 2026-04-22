import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service.js';
import { AuthService } from './auth.service.js';
import { ToastService } from './toast.service.js';

/** Comma-separated active status values for API queries. Single source of truth for the UI. */
export const ACTIVE_STATUS_FILTER = 'OPEN,IN_PROGRESS,WAITING';

export interface TicketFollower {
  id: string;
  ticketId: string;
  personId: string;
  followerType: 'REQUESTER' | 'FOLLOWER';
  createdAt: string;
  person?: { name: string; email: string };
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
  knowledgeDoc?: string | null;
  knowledgeDocSectionMeta?: Record<string, unknown> | null;
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

export interface PendingAction {
  id: string;
  ticketId: string;
  actionType: string;
  value: Record<string, unknown>;
  status: 'pending' | 'approved' | 'dismissed';
  source: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export interface KnowledgeDocTocEntry {
  sectionKey: string;
  title: string;
  length: number;
  lastUpdatedAt: string | null;
  updatedByRunId?: string;
  subsections?: KnowledgeDocTocEntry[];
}

export interface KnowledgeDocSectionPayload {
  sectionKey: string;
  title: string;
  content: string;
  length: number;
  lastUpdatedAt: string | null;
  updatedByRunId?: string;
}

export interface UnifiedLogArchive {
  fullPrompt: string;
  fullResponse: string;
  systemPrompt: string | null;
  conversationMessages: unknown;
  totalContextTokens: number | null;
  messageCount: number | null;
}

export interface UnifiedLogEntry {
  id: string;
  type: 'log' | 'ai' | 'tool' | 'step' | 'error';
  timestamp: string;
  // log fields
  level?: string;
  service?: string;
  message?: string;
  context?: Record<string, unknown> | null;
  error?: string | null;
  // ai fields
  taskType?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  durationMs?: number | null;
  promptKey?: string | null;
  promptText?: string | null;
  systemPrompt?: string | null;
  responseText?: string | null;
  conversationMetadata?: Record<string, unknown> | null;
  // lineage fields
  parentLogId?: string | null;
  parentLogType?: 'ai' | 'app' | null;
  archive?: UnifiedLogArchive | null;
  taskRun?: number | null;
}

export interface UnifiedLogsResponse {
  entries: UnifiedLogEntry[];
  total: number;
}

export interface TicketCostSummary {
  entityId: string;
  totalCostUsd: number;
  callCount: number;
  toolCallCount: number;
  totalDurationMs: number;
  breakdown: Array<{
    provider: string;
    model: string;
    callCount: number;
    totalCostUsd: number;
    totalDurationMs: number;
  }>;
}

export interface TicketArtifact {
  id: string;
  ticketId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  description: string | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class TicketService {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);

  private static readonly ACTIVE_STATUSES = ACTIVE_STATUS_FILTER.split(',');

  /** Active ticket count (OPEN + IN_PROGRESS + WAITING), updated on every getStats() call. */
  readonly activeCount = signal(0);

  getTickets(filters?: { clientId?: string; status?: string; category?: string; priority?: string; source?: string; analysisStatus?: string; createdFrom?: string; createdTo?: string; limit?: number; offset?: number }): Observable<Ticket[]> {
    return this.api.get<Ticket[]>('/tickets', filters as Record<string, string | number>);
  }

  getStats(clientId?: string): Observable<TicketStats> {
    return this.api.get<TicketStats>('/tickets/stats', clientId ? { clientId } : undefined).pipe(
      tap((stats) => {
        // Only update the sidebar badge from GLOBAL stats calls. Client-scoped
        // calls are used for per-client dashboards and must not overwrite the
        // sidebar's global count.
        if (!clientId) {
          const count = TicketService.ACTIVE_STATUSES.reduce((sum, s) => sum + (stats.byStatus[s] ?? 0), 0);
          this.activeCount.set(count);
        }
      }),
    );
  }

  getTicket(id: string): Observable<Ticket & { events: TicketEvent[] }> {
    return this.api.get(`/tickets/${id}`);
  }

  createTicket(data: Partial<Ticket> & { clientId: string; subject: string; requesterId?: string }): Observable<Ticket> {
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

  getUnifiedLogs(ticketId: string, filters?: { limit?: number; offset?: number; type?: string; level?: string; search?: string; createdAfter?: string }): Observable<UnifiedLogsResponse> {
    return this.api.get<UnifiedLogsResponse>(`/tickets/${ticketId}/unified-logs`, filters as Record<string, string | number>);
  }

  getCostSummary(ticketId: string): Observable<TicketCostSummary> {
    return this.api.get<TicketCostSummary>(`/tickets/${ticketId}/cost-summary`);
  }

  reanalyze(ticketId: string): Observable<{ queued: boolean; ticketId: string; jobId: string }> {
    return this.api.post<{ queued: boolean; ticketId: string; jobId: string }>(`/tickets/${ticketId}/reanalyze`, {});
  }

  askAi(ticketId: string, params?: { question?: string; provider?: string; model?: string; taskType?: string }): Observable<AiHelpResponse> {
    return this.api.post<AiHelpResponse>(`/tickets/${ticketId}/ai-help`, params ?? {});
  }

  getPendingActions(ticketId: string): Observable<PendingAction[]> {
    return this.api.get<PendingAction[]>(`/tickets/${ticketId}/pending-actions`);
  }

  approvePendingAction(ticketId: string, actionId: string): Observable<PendingAction> {
    return this.api.post<PendingAction>(`/tickets/${ticketId}/pending-actions/${actionId}/approve`, {});
  }

  dismissPendingAction(ticketId: string, actionId: string): Observable<PendingAction> {
    return this.api.post<PendingAction>(`/tickets/${ticketId}/pending-actions/${actionId}/dismiss`, {});
  }

  updateKnowledgeDoc(ticketId: string, knowledgeDoc: string | null): Observable<Ticket> {
    return this.api.patch<Ticket>(`/tickets/${ticketId}`, { knowledgeDoc });
  }

  getKnowledgeDocToc(ticketId: string): Observable<KnowledgeDocTocEntry[]> {
    return this.api.get<KnowledgeDocTocEntry[]>(`/tickets/${ticketId}/knowledge-doc/toc`);
  }

  getKnowledgeDocSection(ticketId: string, sectionKey: string): Observable<KnowledgeDocSectionPayload> {
    return this.api.get<KnowledgeDocSectionPayload>(`/tickets/${ticketId}/knowledge-doc/section/${encodeURIComponent(sectionKey)}`);
  }

  getArtifacts(ticketId: string): Observable<TicketArtifact[]> {
    return this.api.get<TicketArtifact[]>(`/tickets/${ticketId}/artifacts`);
  }

  searchTickets(q: string, limit = 20): Observable<TicketSearchResult[]> {
    return this.api.get<TicketSearchResult[]>('/search/tickets', { q, limit });
  }

  async downloadArtifact(artifactId: string): Promise<void> {
    const res = await fetch(`/api/artifacts/${artifactId}/download`, {
      headers: { Authorization: `Bearer ${this.auth.accessToken ?? ''}` },
      credentials: 'include',
    });
    if (!res.ok) {
      let msg = `Download failed (HTTP ${res.status})`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) msg = body.error;
      } catch { /* ignore */ }
      this.toast.error(msg);
      return;
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match ? match[1] : `artifact-${artifactId}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

export interface TicketSearchResult {
  id: string;
  ticketNumber: number | null;
  subject: string;
  status: string;
  priority: string;
  clientId: string;
  clientName: string;
  clientShortCode: string;
}

export interface AiHelpResponse {
  content: string;
  provider: string;
  model: string;
}
