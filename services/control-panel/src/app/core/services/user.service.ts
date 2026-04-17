import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface ControlPanelUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'OPERATOR' | 'CLIENT';
  clientId: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  slackUserId?: string | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class UserService {
  private api = inject(ApiService);

  getUsers(): Observable<ControlPanelUser[]> {
    return this.api.get<ControlPanelUser[]>('/users');
  }

  createUser(data: { email: string; password: string; name: string; role?: string; slackUserId?: string }): Observable<ControlPanelUser> {
    return this.api.post<ControlPanelUser>('/users', data);
  }

  updateUser(id: string, data: Partial<{ name: string; email: string; role: string; isActive: boolean; slackUserId: string }>): Observable<ControlPanelUser> {
    return this.api.patch<ControlPanelUser>(`/users/${id}`, data);
  }

  deleteUser(id: string): Observable<void> {
    return this.api.delete(`/users/${id}`);
  }

  resetPassword(id: string, password: string): Observable<{ message: string }> {
    return this.api.post<{ message: string }>(`/users/${id}/reset-password`, { password });
  }
}
