import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface Client {
  id: string;
  name: string;
  shortCode: string;
  isActive: boolean;
  autoRouteTickets: boolean;
  allowSelfRegistration: boolean;
  aiMode: string;
  notes: string | null;
  companyProfile: string | null;
  systemsProfile: string | null;
  domainMappings: string[];
  billingMarkupPercent: number;
  slackChannelId: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { tickets: number; systems: number };
  contacts?: Contact[];
  systems?: System[];
}

export interface Contact {
  id: string;
  clientId: string;
  name: string;
  email: string;
  phone: string | null;
  role: string | null;
  slackUserId: string | null;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string };
}

export interface System {
  id: string;
  clientId: string;
  name: string;
  dbEngine: string;
  host: string;
  port: number;
  connectionString: string | null;
  instanceName: string | null;
  defaultDatabase: string | null;
  authMethod: string;
  username: string | null;
  useTls: boolean;
  trustServerCert: boolean;
  connectionTimeout: number;
  requestTimeout: number;
  maxPoolSize: number;
  isActive: boolean;
  environment: string;
  notes: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string };
  _count?: { tickets: number; findings: number };
}

@Injectable({ providedIn: 'root' })
export class ClientService {
  private api = inject(ApiService);

  getClients(): Observable<Client[]> {
    return this.api.get<Client[]>('/clients');
  }

  getClient(id: string): Observable<Client> {
    return this.api.get<Client>(`/clients/${id}`);
  }

  createClient(data: { name: string; shortCode: string; domainMappings?: string[]; notes?: string }): Observable<Client> {
    return this.api.post<Client>('/clients', data);
  }

  updateClient(id: string, data: Partial<Client>): Observable<Client> {
    return this.api.patch<Client>(`/clients/${id}`, data);
  }
}
