import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export type RouteType = 'INGESTION' | 'ANALYSIS';

export interface TicketRoute {
  id: string;
  name: string;
  description: string | null;
  summary: string | null;
  routeType: RouteType;
  category: string | null;
  source: string | null;
  clientId: string | null;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string } | null;
  steps: TicketRouteStep[];
}

export interface TicketRouteStep {
  id: string;
  routeId: string;
  stepOrder: number;
  name: string;
  stepType: string;
  taskTypeOverride: string | null;
  promptKeyOverride: string | null;
  config: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RouteStepTypeInfo {
  type: string;
  name: string;
  description: string;
  phase: 'ingestion' | 'analysis' | 'dispatch';
  defaultTaskType: string | null;
  defaultPromptKey: string | null;
}

/** Wraps a successful API response that may include non-blocking validation warnings. */
export type WithWarnings<T> = T & { warnings: string[] };

export interface DispatchPreviewEntry {
  category: string;
  routeId: string | null;
  routeName: string | null;
  clientScoped: boolean;
}

export interface DispatchPreviewResponse {
  categories: DispatchPreviewEntry[];
}

@Injectable({ providedIn: 'root' })
export class TicketRouteService {
  private api = inject(ApiService);

  getStepTypes(): Observable<RouteStepTypeInfo[]> {
    return this.api.get<RouteStepTypeInfo[]>('/ticket-routes/step-types');
  }

  getRoutes(filters?: { category?: string; clientId?: string; isActive?: string; routeType?: string }): Observable<TicketRoute[]> {
    return this.api.get<TicketRoute[]>('/ticket-routes', filters as Record<string, string>);
  }

  getRoute(id: string): Observable<TicketRoute> {
    return this.api.get<TicketRoute>(`/ticket-routes/${id}`);
  }

  createRoute(data: {
    name: string;
    description?: string;
    routeType?: RouteType;
    category?: string;
    source?: string | null;
    clientId?: string;
    isDefault?: boolean;
    sortOrder?: number;
    steps?: Array<{
      name: string;
      stepType: string;
      stepOrder: number;
      taskTypeOverride?: string;
      promptKeyOverride?: string;
      config?: Record<string, unknown>;
    }>;
  }): Observable<WithWarnings<TicketRoute>> {
    return this.api.post<WithWarnings<TicketRoute>>('/ticket-routes', data);
  }

  updateRoute(id: string, data: {
    name?: string;
    description?: string;
    routeType?: RouteType;
    category?: string | null;
    source?: string | null;
    clientId?: string | null;
    isActive?: boolean;
    isDefault?: boolean;
    sortOrder?: number;
  }): Observable<TicketRoute> {
    return this.api.patch<TicketRoute>(`/ticket-routes/${id}`, data);
  }

  deleteRoute(id: string): Observable<void> {
    return this.api.delete(`/ticket-routes/${id}`);
  }

  regenerateSummary(id: string): Observable<{ summary: string }> {
    return this.api.post<{ summary: string }>(`/ticket-routes/${id}/regenerate-summary`, {});
  }

  addStep(routeId: string, data: {
    name: string;
    stepType: string;
    stepOrder: number;
    taskTypeOverride?: string;
    promptKeyOverride?: string;
    config?: Record<string, unknown>;
  }): Observable<WithWarnings<TicketRouteStep>> {
    return this.api.post<WithWarnings<TicketRouteStep>>(`/ticket-routes/${routeId}/steps`, data);
  }

  updateStep(routeId: string, stepId: string, data: {
    name?: string;
    stepType?: string;
    stepOrder?: number;
    taskTypeOverride?: string | null;
    promptKeyOverride?: string | null;
    config?: Record<string, unknown> | null;
    isActive?: boolean;
  }): Observable<WithWarnings<TicketRouteStep>> {
    return this.api.patch<WithWarnings<TicketRouteStep>>(`/ticket-routes/${routeId}/steps/${stepId}`, data);
  }

  deleteStep(routeId: string, stepId: string): Observable<void> {
    return this.api.delete(`/ticket-routes/${routeId}/steps/${stepId}`);
  }

  getDispatchPreview(routeId: string, clientId?: string): Observable<DispatchPreviewResponse> {
    const params: Record<string, string> = { routeId };
    if (clientId) params['clientId'] = clientId;
    return this.api.get<DispatchPreviewResponse>('/ticket-routes/dispatch-preview', params);
  }
}
