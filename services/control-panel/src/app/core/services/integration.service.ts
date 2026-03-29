import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpDiscoveryMetadata {
  serverName?: string | null;
  serverVersion?: string | null;
  tools?: McpToolInfo[];
  systemsCount?: number | null;
  lastVerifiedAt?: string | null;
  verificationStatus?: 'success' | 'failed' | null;
  verificationError?: string | null;
}

export interface ClientIntegration {
  id: string;
  clientId: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  metadata?: McpDiscoveryMetadata;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string };
}

@Injectable({ providedIn: 'root' })
export class IntegrationService {
  private api = inject(ApiService);

  getIntegrations(clientId?: string): Observable<ClientIntegration[]> {
    return this.api.get<ClientIntegration[]>('/integrations', clientId ? { clientId } : {});
  }

  getIntegration(id: string): Observable<ClientIntegration> {
    return this.api.get<ClientIntegration>(`/integrations/${id}`);
  }

  createIntegration(data: { clientId: string; type: string; label?: string; config: Record<string, unknown>; notes?: string }): Observable<ClientIntegration> {
    return this.api.post<ClientIntegration>('/integrations', data);
  }

  updateIntegration(id: string, data: Partial<ClientIntegration>): Observable<ClientIntegration> {
    return this.api.patch<ClientIntegration>(`/integrations/${id}`, data);
  }

  deleteIntegration(id: string): Observable<void> {
    return this.api.delete(`/integrations/${id}`);
  }

  verify(id: string): Observable<{ message: string }> {
    return this.api.post<{ message: string }>(`/integrations/${id}/verify`, {});
  }
}
