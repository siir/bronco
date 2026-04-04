import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface SystemAnalysis {
  id: string;
  ticketId: string;
  clientId: string;
  status: 'PENDING' | 'ACKNOWLEDGED' | 'REJECTED';
  analysis: string;
  suggestions: string;
  rejectionReason: string | null;
  aiModel: string | null;
  aiProvider: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SystemAnalysisStats {
  byStatus: Record<string, number>;
  total: number;
}

export interface SystemAnalysisContext {
  pending: Array<{ id: string; suggestions: string; createdAt: string }>;
  rejected: Array<{ id: string; suggestions: string; rejectionReason: string | null; createdAt: string }>;
}

@Injectable({ providedIn: 'root' })
export class SystemAnalysisService {
  private api = inject(ApiService);

  getAnalyses(filters?: { status?: string; clientId?: string; limit?: number; offset?: number }): Observable<{ analyses: SystemAnalysis[]; total: number }> {
    return this.api.get<{ analyses: SystemAnalysis[]; total: number }>('/system-analyses', filters as Record<string, string | number>);
  }

  getStats(): Observable<SystemAnalysisStats> {
    return this.api.get<SystemAnalysisStats>('/system-analyses/stats');
  }

  getContext(clientId: string): Observable<SystemAnalysisContext> {
    return this.api.get<SystemAnalysisContext>('/system-analyses/context', { clientId });
  }

  getAnalysis(id: string): Observable<SystemAnalysis> {
    return this.api.get<SystemAnalysis>(`/system-analyses/${id}`);
  }

  acknowledge(id: string): Observable<SystemAnalysis> {
    return this.api.patch<SystemAnalysis>(`/system-analyses/${id}/acknowledge`, {});
  }

  reject(id: string, reason: string): Observable<SystemAnalysis> {
    return this.api.patch<SystemAnalysis>(`/system-analyses/${id}/reject`, { reason });
  }

  regenerate(id: string): Observable<{ message: string }> {
    return this.api.post<{ message: string }>(`/system-analyses/${id}/regenerate`, {});
  }

  reopen(id: string): Observable<SystemAnalysis> {
    return this.api.patch<SystemAnalysis>(`/system-analyses/${id}/reopen`, {});
  }

  delete(id: string): Observable<void> {
    return this.api.delete<void>(`/system-analyses/${id}`);
  }
}
