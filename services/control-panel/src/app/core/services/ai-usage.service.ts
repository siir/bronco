import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface AiUsageSummary {
  provider: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  callCount: number;
}

export interface AiModelCost {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  inputCostPer1m: number;
  outputCostPer1m: number;
  isCustomCost: boolean;
  isActive: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface AiUsageCall {
  id: string;
  taskType: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  promptKey: string | null;
  createdAt: string;
}

export interface AiUsageBreakdown extends AiUsageSummary {
  calls: AiUsageCall[];
}

export interface TicketCostResponse {
  entityId: string;
  entityType: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  callCount: number;
  breakdown: AiUsageBreakdown[];
}

export interface CostRefreshResponse {
  updated: number;
  skipped?: number;
  costs: AiModelCost[];
}

export interface CostSeedResponse {
  seeded: number;
  costs: AiModelCost[];
}

export interface CatalogModel {
  model: string;
  displayName: string | null;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  modality: string | null;
}

export interface CatalogProvider {
  provider: string;
  models: CatalogModel[];
}

export interface CatalogResponse {
  providers: CatalogProvider[];
}

export interface AiUsageLogEntry {
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
  clientId: string | null;
  promptKey: string | null;
  createdAt: string;
  ticketSubject: string | null;
}

export interface AiUsageLogDetail extends AiUsageLogEntry {
  promptText: string | null;
  responseText: string | null;
}

export interface AiUsageLogResponse {
  logs: AiUsageLogEntry[];
  total: number;
}

export interface LogCostRefreshResponse {
  total: number;
  updated: number;
}

export interface SummaryParams {
  since?: string;
  until?: string;
  entityId?: string;
  entityType?: string;
  clientId?: string;
  provider?: string;
  model?: string;
}

export interface LogParams {
  limit?: number;
  offset?: number;
  entityId?: string;
  entityType?: string;
  provider?: string;
  model?: string;
  taskType?: string;
  promptKey?: string;
  since?: string;
  until?: string;
  context?: string;
  minTokens?: number;
  maxTokens?: number;
}

export interface AiUsageWindowKpi {
  label: '24h' | '72h' | '7d' | '30d';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  baseCostUsd: number;
  billedCostUsd: number;
  requestCount: number;
}

export interface AiUsageClientSummary {
  clientId: string;
  billingMarkupPercent: number;
  windows: AiUsageWindowKpi[];
}

export interface DeleteLogsBody {
  ids?: string[];
  filter?: Record<string, string | number>;
}

export interface DeleteLogsResponse {
  deleted: number;
}

@Injectable({ providedIn: 'root' })
export class AiUsageService {
  private api = inject(ApiService);

  getSummary(params?: SummaryParams): Observable<AiUsageSummary[]> {
    return this.api.get<AiUsageSummary[]>('/ai-usage/summary', params as Record<string, string>);
  }

  getTicketCost(ticketId: string): Observable<TicketCostResponse> {
    return this.api.get<TicketCostResponse>(`/ai-usage/ticket/${ticketId}`);
  }

  getLogs(params?: LogParams): Observable<AiUsageLogResponse> {
    return this.api.get<AiUsageLogResponse>('/ai-usage/logs', params as Record<string, string | number>);
  }

  getLog(id: string): Observable<AiUsageLogDetail> {
    return this.api.get<AiUsageLogDetail>(`/ai-usage/logs/${id}`);
  }

  refreshLogCosts(force?: boolean): Observable<LogCostRefreshResponse> {
    return this.api.post<LogCostRefreshResponse>('/ai-usage/logs/refresh-costs', { force });
  }

  getCosts(): Observable<AiModelCost[]> {
    return this.api.get<AiModelCost[]>('/ai-usage/costs');
  }

  upsertCost(data: { provider: string; model: string; displayName?: string; inputCostPer1m: number; outputCostPer1m: number; isCustomCost?: boolean }): Observable<AiModelCost> {
    return this.api.post<AiModelCost>('/ai-usage/costs', data);
  }

  deleteCost(id: string): Observable<void> {
    return this.api.delete(`/ai-usage/costs/${id}`);
  }

  clearCustomCost(id: string): Observable<AiModelCost> {
    return this.api.post<AiModelCost>(`/ai-usage/costs/${id}/clear-custom`, {});
  }

  refreshCosts(): Observable<CostRefreshResponse> {
    return this.api.post<CostRefreshResponse>('/ai-usage/costs/refresh', {});
  }

  seedCosts(): Observable<CostSeedResponse> {
    return this.api.post<CostSeedResponse>('/ai-usage/costs/seed', {});
  }

  getCatalog(): Observable<CatalogResponse> {
    return this.api.get<CatalogResponse>('/ai-usage/costs/catalog');
  }

  deleteLogs(body: DeleteLogsBody): Observable<DeleteLogsResponse> {
    return this.api.deleteWithBody<DeleteLogsResponse>('/ai-usage/logs', body);
  }

  getPromptKeys(): Observable<string[]> {
    return this.api.get<string[]>('/ai-usage/logs/prompt-keys');
  }

  getClientSummary(clientId: string): Observable<AiUsageClientSummary> {
    return this.api.get<AiUsageClientSummary>(`/clients/${clientId}/ai-usage/summary`);
  }

  getClientLogs(clientId: string, params?: LogParams): Observable<AiUsageLogResponse> {
    return this.api.get<AiUsageLogResponse>(`/clients/${clientId}/ai-usage`, params as Record<string, string | number>);
  }
}
