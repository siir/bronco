import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

/** Step summary returned by the list endpoint (no output/error). */
export interface IngestionRunStepSummary {
  id: string;
  runId: string;
  stepOrder: number;
  stepType: string;
  stepName: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

/** Full step detail returned by the detail endpoint. */
export interface IngestionRunStep extends IngestionRunStepSummary {
  output: string | null;
  error: string | null;
}

/** Run shape returned by the list endpoint (steps have summary-only fields). */
export interface IngestionRun {
  id: string;
  jobId: string;
  source: string;
  clientId: string;
  routeId: string | null;
  routeName: string | null;
  status: string;
  ticketId: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  client: { shortCode: string; name: string };
  steps: IngestionRunStepSummary[];
}

/** Run shape returned by the detail endpoint (steps include output/error). */
export interface IngestionRunDetail extends Omit<IngestionRun, 'steps'> {
  steps: IngestionRunStep[];
}

@Injectable({ providedIn: 'root' })
export class IngestionService {
  private api = inject(ApiService);

  getRuns(params?: {
    clientId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Observable<{ runs: IngestionRun[]; total: number }> {
    const query: Record<string, string> = {};
    if (params?.clientId) query['clientId'] = params.clientId;
    if (params?.status) query['status'] = params.status;
    if (params?.limit) query['limit'] = String(params.limit);
    if (params?.offset) query['offset'] = String(params.offset);
    return this.api.get<{ runs: IngestionRun[]; total: number }>('/ingest/runs', query);
  }

  getRun(id: string): Observable<IngestionRunDetail> {
    return this.api.get<IngestionRunDetail>(`/ingest/runs/${id}`);
  }
}
