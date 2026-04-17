import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface EmailProcessingLog {
  id: string;
  messageId: string;
  from: string;
  fromName: string | null;
  subject: string;
  receivedAt: string;
  classification: string;
  status: string;
  clientId: string | null;
  ticketId: string | null;
  errorMessage: string | null;
  processingMs: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  client?: { id: string; name: string } | null;
  ticket?: { id: string; subject: string } | null;
}

export interface EmailLogResponse {
  logs: EmailProcessingLog[];
  total: number;
}

export interface EmailLogStats {
  totalToday: number;
  ticketsCreated: number;
  noiseFiltered: number;
  failures: number;
}

export interface EmailLogFilters {
  classification?: string;
  status?: string;
  clientId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

@Injectable({ providedIn: 'root' })
export class EmailLogService {
  private api = inject(ApiService);

  getLogs(filters?: EmailLogFilters): Observable<EmailLogResponse> {
    return this.api.get<EmailLogResponse>('/email-logs', filters as Record<string, string | number>);
  }

  getStats(): Observable<EmailLogStats> {
    return this.api.get<EmailLogStats>('/email-logs/stats');
  }

  retry(id: string): Observable<{ success: boolean; message: string }> {
    return this.api.post<{ success: boolean; message: string }>(`/email-logs/${id}/retry`, {});
  }

  reclassify(id: string, classification: string): Observable<EmailProcessingLog> {
    return this.api.patch<EmailProcessingLog>(`/email-logs/${id}`, { classification });
  }
}
