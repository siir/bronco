import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface PromptSummary {
  key: string;
  name: string;
  description: string;
  taskType: string;
  role: 'SYSTEM' | 'USER';
  content: string;
  temperature: number | null;
  maxTokens: number | null;
  overrideCount: number;
}

export interface PromptOverride {
  id: string;
  promptKey: string;
  scope: 'APP_WIDE' | 'CLIENT';
  clientId: string | null;
  position: 'PREPEND' | 'APPEND';
  content: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string } | null;
}

export interface PromptDetail {
  base: PromptSummary;
  overrides: PromptOverride[];
  composed: string;
}

export interface PreviewResult {
  rendered: string;
  placeholders: { token: string; resolved: string | null; label: string | null; description: string | null }[];
}

export interface PromptKeyword {
  id: string;
  token: string;
  label: string;
  description: string;
  sampleValue: string | null;
  category: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class PromptService {
  private api = inject(ApiService);

  // ─── Base Prompts ─────────────────────────────────────────────────────

  getPrompts(filters?: { taskType?: string; role?: string; search?: string }): Observable<PromptSummary[]> {
    return this.api.get<PromptSummary[]>('/prompts', filters as Record<string, string>);
  }

  getPrompt(key: string, clientId?: string): Observable<PromptDetail> {
    return this.api.get<PromptDetail>(`/prompts/${key}`, clientId ? { clientId } : undefined);
  }

  previewPrompt(data: { promptKey: string; clientId?: string; values?: Record<string, string> }): Observable<PreviewResult> {
    return this.api.post<PreviewResult>('/prompts/preview', data);
  }

  // ─── Overrides ────────────────────────────────────────────────────────

  getOverrides(filters?: { promptKey?: string; clientId?: string; scope?: string }): Observable<PromptOverride[]> {
    return this.api.get<PromptOverride[]>('/prompt-overrides', filters as Record<string, string>);
  }

  createOverride(data: { promptKey: string; scope: string; clientId?: string; position?: string; content: string }): Observable<PromptOverride> {
    return this.api.post<PromptOverride>('/prompt-overrides', data);
  }

  updateOverride(id: string, data: { position?: string; content?: string; isActive?: boolean }): Observable<PromptOverride> {
    return this.api.patch<PromptOverride>(`/prompt-overrides/${id}`, data);
  }

  deleteOverride(id: string): Observable<void> {
    return this.api.delete(`/prompt-overrides/${id}`);
  }

  // ─── Keywords ─────────────────────────────────────────────────────────

  getKeywords(filters?: { category?: string; search?: string }): Observable<PromptKeyword[]> {
    return this.api.get<PromptKeyword[]>('/keywords', filters as Record<string, string>);
  }

  createKeyword(data: { token: string; label: string; description: string; sampleValue?: string; category: string }): Observable<PromptKeyword> {
    return this.api.post<PromptKeyword>('/keywords', data);
  }

  updateKeyword(id: string, data: Partial<{ token: string; label: string; description: string; sampleValue: string | null; category: string }>): Observable<PromptKeyword> {
    return this.api.patch<PromptKeyword>(`/keywords/${id}`, data);
  }

  deleteKeyword(id: string): Observable<void> {
    return this.api.delete(`/keywords/${id}`);
  }

  seedKeywords(): Observable<{ seeded: number; skipped: number; keywords: PromptKeyword[] }> {
    return this.api.post('/keywords/seed', {});
  }
}
