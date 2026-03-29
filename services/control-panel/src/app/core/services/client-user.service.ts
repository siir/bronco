import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface ClientUser {
  id: string;
  email: string;
  name: string;
  userType: 'ADMIN' | 'USER';
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class ClientUserService {
  private api = inject(ApiService);

  getUsers(clientId: string): Observable<ClientUser[]> {
    return this.api.get<ClientUser[]>('/client-users', { clientId });
  }

  createUser(data: { clientId: string; email: string; password: string; name: string; userType?: string }): Observable<ClientUser> {
    return this.api.post<ClientUser>('/client-users', data);
  }

  updateUser(id: string, data: Partial<{ name: string; email: string; userType: string; isActive: boolean }>): Observable<ClientUser> {
    return this.api.patch<ClientUser>(`/client-users/${id}`, data);
  }

  deleteUser(id: string): Observable<void> {
    return this.api.delete(`/client-users/${id}`);
  }

  resetPassword(id: string, password: string): Observable<{ message: string }> {
    return this.api.post<{ message: string }>(`/client-users/${id}/reset-password`, { password });
  }
}
