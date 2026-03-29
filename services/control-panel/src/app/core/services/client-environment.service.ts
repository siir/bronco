import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface ClientEnvironment {
  id: string;
  clientId: string;
  name: string;
  tag: string;
  description: string | null;
  operationalInstructions: string | null;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class ClientEnvironmentService {
  private api = inject(ApiService);

  getEnvironments(clientId: string): Observable<ClientEnvironment[]> {
    return this.api.get<ClientEnvironment[]>(`/clients/${clientId}/environments`);
  }

  createEnvironment(clientId: string, data: {
    name: string;
    tag: string;
    description?: string;
    operationalInstructions?: string;
    isDefault?: boolean;
    sortOrder?: number;
  }): Observable<ClientEnvironment> {
    return this.api.post<ClientEnvironment>(`/clients/${clientId}/environments`, data);
  }

  updateEnvironment(clientId: string, envId: string, data: {
    name?: string;
    tag?: string;
    description?: string;
    operationalInstructions?: string;
    isDefault?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  }): Observable<ClientEnvironment> {
    return this.api.patch<ClientEnvironment>(`/clients/${clientId}/environments/${envId}`, data);
  }

  deleteEnvironment(clientId: string, envId: string): Observable<void> {
    return this.api.delete(`/clients/${clientId}/environments/${envId}`);
  }
}
