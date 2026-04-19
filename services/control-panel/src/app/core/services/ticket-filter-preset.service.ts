import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface TicketFilterPreset {
  id: string;
  operatorId: string;
  name: string;
  statusFilter: string | null;
  categoryFilter: string | null;
  clientIdFilter: string | null;
  priorityFilter: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTicketFilterPreset {
  name: string;
  statusFilter?: string | null;
  categoryFilter?: string | null;
  clientIdFilter?: string | null;
  priorityFilter?: string | null;
  isDefault?: boolean;
}

@Injectable({ providedIn: 'root' })
export class TicketFilterPresetService {
  private api = inject(ApiService);

  getPresets(): Observable<TicketFilterPreset[]> {
    return this.api.get<TicketFilterPreset[]>('/ticket-filter-presets');
  }

  createPreset(data: CreateTicketFilterPreset): Observable<TicketFilterPreset> {
    return this.api.post<TicketFilterPreset>('/ticket-filter-presets', data);
  }

  updatePreset(id: string, data: Partial<CreateTicketFilterPreset>): Observable<TicketFilterPreset> {
    return this.api.patch<TicketFilterPreset>(`/ticket-filter-presets/${id}`, data);
  }

  deletePreset(id: string): Observable<void> {
    return this.api.delete(`/ticket-filter-presets/${id}`);
  }
}
