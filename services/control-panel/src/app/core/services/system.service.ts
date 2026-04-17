import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';
import { System } from './client.service.js';

@Injectable({ providedIn: 'root' })
export class SystemService {
  private api = inject(ApiService);

  getSystems(clientId?: string): Observable<System[]> {
    return this.api.get<System[]>('/systems', clientId ? { clientId } : {});
  }

  getSystem(id: string): Observable<System> {
    return this.api.get<System>(`/systems/${id}`);
  }

  createSystem(data: Partial<System> & { clientId: string; name: string; host: string }): Observable<System> {
    return this.api.post<System>('/systems', data);
  }

  updateSystem(id: string, data: Partial<System>): Observable<System> {
    return this.api.patch<System>(`/systems/${id}`, data);
  }

  deleteSystem(id: string): Observable<void> {
    return this.api.delete(`/systems/${id}`);
  }
}
