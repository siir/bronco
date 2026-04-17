import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

// --- Provider (one per type: LOCAL, CLAUDE, OPENAI, etc.) ---

export interface AiProvider {
  id: string;
  provider: string;
  baseUrl: string | null;
  isActive: boolean;
  hasApiKey: boolean;
  modelCount: number;
  activeModelCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderData {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface UpdateProviderData {
  baseUrl?: string | null;
  apiKey?: string;
  isActive?: boolean;
}

// --- Provider Model (many per provider) ---

export interface AiProviderModel {
  id: string;
  providerId: string;
  provider: string; // denormalized from parent
  providerActive: boolean;
  name: string;
  model: string;
  capabilityLevel: string;
  isActive: boolean;
  hasApiKey: boolean;
  baseUrl: string | null;
  enabledApps: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateModelData {
  providerId: string;
  name: string;
  model: string;
  capabilityLevel?: string;
  enabledApps?: string[];
}

export interface UpdateModelData {
  name?: string;
  model?: string;
  capabilityLevel?: string;
  isActive?: boolean;
  enabledApps?: string[];
  providerId?: string;
}

// --- Shared types ---

export interface AppScopeItem {
  value: string;
  label: string;
}

export interface TestResult {
  success: boolean;
  error?: string;
  note?: string;
}

export interface ProviderType {
  value: string;
  label: string;
  /** True when the provider has a working client implementation in AIRouter. */
  routable: boolean;
}

@Injectable({ providedIn: 'root' })
export class AiProviderService {
  private api = inject(ApiService);

  // --- Provider endpoints ---

  listProviders(): Observable<AiProvider[]> {
    return this.api.get<AiProvider[]>('/ai-providers');
  }

  getProvider(id: string): Observable<AiProvider> {
    return this.api.get<AiProvider>(`/ai-providers/${id}`);
  }

  createProvider(data: CreateProviderData): Observable<AiProvider> {
    return this.api.post<AiProvider>('/ai-providers', data);
  }

  updateProvider(id: string, data: UpdateProviderData): Observable<AiProvider> {
    return this.api.patch<AiProvider>(`/ai-providers/${id}`, data);
  }

  deleteProvider(id: string): Observable<void> {
    return this.api.delete(`/ai-providers/${id}`);
  }

  testConnection(id: string): Observable<TestResult> {
    return this.api.post<TestResult>(`/ai-providers/${id}/test`, {});
  }

  // --- Model endpoints ---

  listModels(): Observable<AiProviderModel[]> {
    return this.api.get<AiProviderModel[]>('/ai-providers/models');
  }

  getModel(id: string): Observable<AiProviderModel> {
    return this.api.get<AiProviderModel>(`/ai-providers/models/${id}`);
  }

  createModel(data: CreateModelData): Observable<AiProviderModel> {
    return this.api.post<AiProviderModel>('/ai-providers/models', data);
  }

  updateModel(id: string, data: UpdateModelData): Observable<AiProviderModel> {
    return this.api.patch<AiProviderModel>(`/ai-providers/models/${id}`, data);
  }

  deleteModel(id: string): Observable<void> {
    return this.api.delete(`/ai-providers/models/${id}`);
  }

  // --- Shared endpoints ---

  getCapabilities(): Observable<Record<string, string>> {
    return this.api.get<Record<string, string>>('/ai-providers/capabilities');
  }

  getTypes(): Observable<ProviderType[]> {
    return this.api.get<ProviderType[]>('/ai-providers/types');
  }

  getAppScopes(): Observable<AppScopeItem[]> {
    return this.api.get<AppScopeItem[]>('/ai-providers/app-scopes');
  }
}
