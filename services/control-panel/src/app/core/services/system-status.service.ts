import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface ComponentStatus {
  name: string;
  type: 'infrastructure' | 'service' | 'external';
  status: 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN';
  endpoint?: string;
  latencyMs?: number;
  uptime?: string;
  details?: Record<string, unknown>;
  configIssues?: string[];
  controllable: boolean;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export interface McpServerStatus {
  clientName: string;
  clientShortCode: string;
  label: string;
  status: 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN';
  endpoint: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
  integrationId?: string;
  serverName?: string | null;
  serverVersion?: string | null;
  tools?: Array<{ name: string; description: string }>;
  systemsCount?: number | null;
  lastVerifiedAt?: string;
  verificationStatus?: string;
  verificationError?: string;
}

export interface SystemStatusResponse {
  status: 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN';
  timestamp: string;
  components: ComponentStatus[];
  mcpServers?: McpServerStatus[];
  llmProviders?: ComponentStatus[];
  queueStats: Record<string, QueueStats>;
  configIssues?: string[];
}

export interface ControlResponse {
  success: boolean;
  service: string;
  action: string;
  message: string;
  output?: string;
}

@Injectable({ providedIn: 'root' })
export class SystemStatusService {
  private api = inject(ApiService);

  getStatus(): Observable<SystemStatusResponse> {
    return this.api.get<SystemStatusResponse>('/system-status');
  }

  controlService(service: string, action: 'start' | 'stop' | 'restart'): Observable<ControlResponse> {
    return this.api.post<ControlResponse>('/system-status/control', { service, action });
  }
}
