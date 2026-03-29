import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface AppLog {
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

export interface LogResponse {
  logs: AppLog[];
  total: number;
}

export interface LogFilters {
  service?: string;
  level?: string;
  entityId?: string;
  entityType?: string;
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

@Injectable({ providedIn: 'root' })
export class LogService {
  private api = inject(ApiService);

  getLogs(filters?: LogFilters): Observable<LogResponse> {
    return this.api.get<LogResponse>('/logs', filters as Record<string, string | number>);
  }

  getServices(): Observable<string[]> {
    return this.api.get<string[]>('/logs/services');
  }
}
