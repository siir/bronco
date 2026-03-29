import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

/** Canonical memory type option list — single source of truth for the UI. */
export const MEMORY_TYPE_OPTIONS = [
  { value: 'CONTEXT', label: 'Context', description: 'General client knowledge' },
  { value: 'PLAYBOOK', label: 'Playbook', description: 'Step-by-step procedures' },
  { value: 'TOOL_GUIDANCE', label: 'Tool Guidance', description: 'Which tools/resources to use' },
] as const;

/** Canonical category option list — single source of truth for the UI. */
export const CATEGORY_OPTIONS = [
  { value: '', label: '(All categories)' },
  { value: 'DATABASE_PERF', label: 'Database Performance' },
  { value: 'BUG_FIX', label: 'Bug Fix' },
  { value: 'FEATURE_REQUEST', label: 'Feature Request' },
  { value: 'SCHEMA_CHANGE', label: 'Schema Change' },
  { value: 'CODE_REVIEW', label: 'Code Review' },
  { value: 'ARCHITECTURE', label: 'Architecture' },
  { value: 'GENERAL', label: 'General' },
] as const;

export interface ClientMemory {
  id: string;
  clientId: string;
  title: string;
  memoryType: string;
  category: string | null;
  tags: string[];
  content: string;
  isActive: boolean;
  sortOrder: number;
  source: string;
  createdAt: string;
  updatedAt: string;
  client?: { id: string; name: string; shortCode: string };
}

@Injectable({ providedIn: 'root' })
export class ClientMemoryService {
  private api = inject(ApiService);

  getMemories(filters?: { clientId?: string; category?: string; memoryType?: string; isActive?: string }): Observable<ClientMemory[]> {
    return this.api.get<ClientMemory[]>('/client-memory', filters as Record<string, string>);
  }

  getMemory(id: string): Observable<ClientMemory> {
    return this.api.get<ClientMemory>(`/client-memory/${id}`);
  }

  createMemory(data: {
    clientId: string;
    title: string;
    memoryType: string;
    category?: string | null;
    tags?: string[];
    content: string;
    sortOrder?: number;
    source?: string;
  }): Observable<ClientMemory> {
    return this.api.post<ClientMemory>('/client-memory', data);
  }

  updateMemory(id: string, data: {
    title?: string;
    memoryType?: string;
    category?: string | null;
    tags?: string[];
    content?: string;
    isActive?: boolean;
    sortOrder?: number;
  }): Observable<ClientMemory> {
    return this.api.patch<ClientMemory>(`/client-memory/${id}`, data);
  }

  deleteMemory(id: string): Observable<void> {
    return this.api.delete(`/client-memory/${id}`);
  }
}
