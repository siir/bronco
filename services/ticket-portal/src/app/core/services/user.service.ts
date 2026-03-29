import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

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
export class UserService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiUrl;

  getUsers(): Observable<ClientUser[]> {
    return this.http.get<ClientUser[]>(`${this.baseUrl}/portal/users`);
  }

  createUser(data: { email: string; password: string; name: string; userType?: 'ADMIN' | 'USER' }): Observable<ClientUser> {
    return this.http.post<ClientUser>(`${this.baseUrl}/portal/users`, data);
  }

  updateUser(id: string, data: Partial<{ name: string; email: string; userType: 'ADMIN' | 'USER'; isActive: boolean }>): Observable<ClientUser> {
    return this.http.patch<ClientUser>(`${this.baseUrl}/portal/users/${id}`, data);
  }

  deleteUser(id: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.baseUrl}/portal/users/${id}`);
  }
}
