import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface Person {
  id: string;
  clientId: string;
  name: string;
  email: string;
  phone: string | null;
  role: string | null;
  slackUserId: string | null;
  isPrimary: boolean;
  hasPortalAccess: boolean;
  hasOpsAccess: boolean;
  userType: 'ADMIN' | 'OPERATOR' | 'USER' | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string };
}

@Injectable({ providedIn: 'root' })
export class PersonService {
  private api = inject(ApiService);

  getPeople(clientId: string): Observable<Person[]> {
    return this.api.get<Person[]>('/people', { clientId });
  }

  getPerson(id: string): Observable<Person> {
    return this.api.get<Person>(`/people/${id}`);
  }

  createPerson(data: Partial<Person> & { clientId: string; name: string; email: string; password?: string }): Observable<Person> {
    return this.api.post<Person>('/people', data);
  }

  updatePerson(id: string, data: Partial<Person> & { password?: string }): Observable<Person> {
    return this.api.patch<Person>(`/people/${id}`, data);
  }

  deletePerson(id: string): Observable<void> {
    return this.api.delete(`/people/${id}`);
  }

  resetPassword(id: string, password: string): Observable<{ message: string }> {
    return this.api.post<{ message: string }>(`/people/${id}/reset-password`, { password });
  }
}
