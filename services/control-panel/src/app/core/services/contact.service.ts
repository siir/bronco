import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { Contact } from './client.service';

@Injectable({ providedIn: 'root' })
export class ContactService {
  private api = inject(ApiService);

  getContacts(clientId?: string): Observable<Contact[]> {
    return this.api.get<Contact[]>('/contacts', clientId ? { clientId } : {});
  }

  getContact(id: string): Observable<Contact> {
    return this.api.get<Contact>(`/contacts/${id}`);
  }

  createContact(data: Partial<Contact> & { clientId: string; name: string; email: string }): Observable<Contact> {
    return this.api.post<Contact>('/contacts', data);
  }

  updateContact(id: string, data: Partial<Contact>): Observable<Contact> {
    return this.api.patch<Contact>(`/contacts/${id}`, data);
  }

  deleteContact(id: string): Observable<void> {
    return this.api.delete(`/contacts/${id}`);
  }
}
