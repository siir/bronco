import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface TaskTypeDefault {
  taskType: string;
  provider: string;
  model: string;
}

export interface AiModelConfig {
  id: string;
  taskType: string;
  scope: 'APP_WIDE' | 'CLIENT';
  clientId: string | null;
  provider: string;
  model: string;
  maxTokens: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string } | null;
}

export interface ResolvedModelConfig {
  provider: string;
  model: string;
  source: 'CLIENT' | 'APP_WIDE' | 'DEFAULT';
}

@Injectable({ providedIn: 'root' })
export class AiConfigService {
  private api = inject(ApiService);

  /** Get hardcoded defaults for all task types. */
  getDefaults(): Observable<TaskTypeDefault[]> {
    return this.api.get<TaskTypeDefault[]>('/ai-config/defaults');
  }

  /** List all DB-stored model configs, optionally filtered. */
  getConfigs(filters?: { taskType?: string; clientId?: string; scope?: string }): Observable<AiModelConfig[]> {
    return this.api.get<AiModelConfig[]>('/ai-config', filters as Record<string, string>);
  }

  /** Resolve the effective provider + model for a task type, optionally for a client. */
  resolve(taskType: string, clientId?: string): Observable<ResolvedModelConfig> {
    const params: Record<string, string> = { taskType };
    if (clientId) params['clientId'] = clientId;
    return this.api.get<ResolvedModelConfig>('/ai-config/resolved', params);
  }

  /** Create a new model config override. */
  create(data: { taskType: string; scope: string; clientId?: string; provider: string; model: string; maxTokens?: number | null }): Observable<AiModelConfig> {
    return this.api.post<AiModelConfig>('/ai-config', data);
  }

  /** Update an existing model config. */
  update(id: string, data: { provider?: string; model?: string; maxTokens?: number | null; isActive?: boolean }): Observable<AiModelConfig> {
    return this.api.patch<AiModelConfig>(`/ai-config/${id}`, data);
  }

  /** Delete a model config. */
  delete(id: string): Observable<void> {
    return this.api.delete(`/ai-config/${id}`);
  }
}
