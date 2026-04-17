import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface ExternalService {
  id: string;
  name: string;
  endpoint: string;
  checkType: string;
  isMonitored: boolean;
  timeoutMs: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExternalService {
  name: string;
  endpoint: string;
  checkType?: string;
  isMonitored?: boolean;
  timeoutMs?: number;
  notes?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ExternalServiceService {
  private api = inject(ApiService);

  getAll(): Observable<ExternalService[]> {
    return this.api.get<ExternalService[]>('/external-services');
  }

  create(data: CreateExternalService): Observable<ExternalService> {
    return this.api.post<ExternalService>('/external-services', data);
  }

  update(id: string, data: Partial<CreateExternalService>): Observable<ExternalService> {
    return this.api.patch<ExternalService>(`/external-services/${id}`, data);
  }

  delete(id: string): Observable<void> {
    return this.api.delete(`/external-services/${id}`);
  }
}
