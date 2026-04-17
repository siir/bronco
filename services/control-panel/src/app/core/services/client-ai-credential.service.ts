import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface ClientAiCredential {
  id: string;
  clientId: string;
  provider: string;
  label: string;
  isActive: boolean;
  last4: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  ok: boolean;
  provider: string;
  error?: string;
  note?: string;
}

@Injectable({ providedIn: 'root' })
export class ClientAiCredentialService {
  private api = inject(ApiService);

  getCredentials(clientId: string): Observable<ClientAiCredential[]> {
    return this.api.get<ClientAiCredential[]>(`/clients/${clientId}/ai-credentials`);
  }

  createCredential(clientId: string, data: { provider: string; apiKey: string; label: string }): Observable<ClientAiCredential> {
    return this.api.post<ClientAiCredential>(`/clients/${clientId}/ai-credentials`, data);
  }

  updateCredential(clientId: string, credId: string, data: { label?: string; isActive?: boolean; apiKey?: string }): Observable<ClientAiCredential> {
    return this.api.patch<ClientAiCredential>(`/clients/${clientId}/ai-credentials/${credId}`, data);
  }

  deleteCredential(clientId: string, credId: string): Observable<void> {
    return this.api.delete(`/clients/${clientId}/ai-credentials/${credId}`);
  }

  testCredential(clientId: string, credId: string): Observable<TestResult> {
    return this.api.post<TestResult>(`/clients/${clientId}/ai-credentials/${credId}/test`, {});
  }
}
