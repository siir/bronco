import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface ProbeRunStep {
  id: string;
  runId: string;
  stepOrder: number;
  stepName: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  detail: string | null;
  error: string | null;
}

export interface ProbeRun {
  id: string;
  probeId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  result: string | null;
  error: string | null;
  triggeredBy: string;
  _count?: { steps: number };
  steps?: ProbeRunStep[];
}

export interface ScheduledProbe {
  id: string;
  clientId: string;
  integrationId: string | null;
  name: string;
  description: string | null;
  toolName: string;
  toolParams: Record<string, unknown>;
  cronExpression: string;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  scheduleDaysOfWeek: string | null;
  scheduleTimezone: string | null;
  category: string | null;
  action: string;
  actionConfig: Record<string, unknown> | null;
  isActive: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunResult: string | null;
  retentionDays: number;
  retentionMaxRuns: number;
  createdAt: string;
  updatedAt: string;
  client?: { id: string; name: string; shortCode: string };
  integration?: { id: string; label: string; type: string; config?: Record<string, unknown>; metadata?: Record<string, unknown> } | null;
}

export interface UpdateProbeRequest {
  name?: string;
  description?: string | null;
  cronExpression?: string;
  category?: string | null;
  action?: string;
  actionConfig?: Record<string, unknown> | null;
  isActive?: boolean;
  scheduleHour?: number | null;
  scheduleMinute?: number | null;
  scheduleDaysOfWeek?: string | null;
  scheduleTimezone?: string | null;
  retentionDays?: number;
  retentionMaxRuns?: number;
}

export interface CreateProbeRequest {
  clientId: string;
  integrationId?: string;
  name: string;
  description?: string;
  toolName: string;
  toolParams?: Record<string, unknown>;
  cronExpression?: string;
  category?: string | null;
  action?: string;
  actionConfig?: Record<string, unknown> | null;
  isActive?: boolean;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleDaysOfWeek?: string | null;
  scheduleTimezone?: string | null;
  retentionDays?: number;
  retentionMaxRuns?: number;
}

@Injectable({ providedIn: 'root' })
export class ScheduledProbeService {
  private api = inject(ApiService);

  getProbes(filters?: Record<string, string>): Observable<ScheduledProbe[]> {
    return this.api.get<ScheduledProbe[]>('/scheduled-probes', filters);
  }

  getProbe(id: string): Observable<ScheduledProbe> {
    return this.api.get<ScheduledProbe>(`/scheduled-probes/${id}`);
  }

  createProbe(data: CreateProbeRequest): Observable<ScheduledProbe> {
    return this.api.post<ScheduledProbe>('/scheduled-probes', data);
  }

  updateProbe(id: string, data: UpdateProbeRequest): Observable<ScheduledProbe> {
    return this.api.patch<ScheduledProbe>(`/scheduled-probes/${id}`, data);
  }

  deleteProbe(id: string): Observable<void> {
    return this.api.delete(`/scheduled-probes/${id}`);
  }

  runProbe(id: string): Observable<{ message: string; probeId: string }> {
    return this.api.post<{ message: string; probeId: string }>(`/scheduled-probes/${id}/run`, {});
  }

  getRuns(probeId: string, params?: { limit?: number; offset?: number; status?: string }): Observable<{ runs: ProbeRun[]; total: number }> {
    const query: Record<string, string> = {};
    if (params?.limit) query['limit'] = String(params.limit);
    if (params?.offset) query['offset'] = String(params.offset);
    if (params?.status) query['status'] = params.status;
    return this.api.get<{ runs: ProbeRun[]; total: number }>(`/scheduled-probes/${probeId}/runs`, query);
  }

  getRun(probeId: string, runId: string): Observable<ProbeRun> {
    return this.api.get<ProbeRun>(`/scheduled-probes/${probeId}/runs/${runId}`);
  }

  getCurrentRun(probeId: string): Observable<ProbeRun | null> {
    return this.api.get<ProbeRun | null>(`/scheduled-probes/${probeId}/runs/current`);
  }

  purgeRuns(probeId: string): Observable<{ deleted: number }> {
    return this.api.delete<{ deleted: number }>(`/scheduled-probes/${probeId}/runs`);
  }

  getBuiltinTools(): Observable<Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>> {
    return this.api.get('/scheduled-probes/builtin-tools');
  }
}
