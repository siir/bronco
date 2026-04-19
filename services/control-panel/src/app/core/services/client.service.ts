import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';
import type { Person } from './person.service.js';

export interface Client {
  id: string;
  name: string;
  shortCode: string;
  isActive: boolean;
  autoRouteTickets: boolean;
  allowSelfRegistration: boolean;
  notificationMode: 'client' | 'operator';
  aiMode: string;
  notes: string | null;
  companyProfile: string | null;
  systemsProfile: string | null;
  domainMappings: string[];
  billingMarkupPercent: number;
  slackChannelId: string | null;
  createdAt: string;
  updatedAt: string;
  invoicedTotalUsd?: number;
  _count?: {
    tickets: number;
    systems: number;
    codeRepos: number;
    integrations: number;
    clientMemories: number;
    environments: number;
    clientUsers: number;
    invoices: number;
  };
  people?: Person[];
  systems?: System[];
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

  searchClients(q: string, limit = 20): Observable<ClientSearchResult[]> {
    return this.api.get<ClientSearchResult[]>('/search/clients', { q, limit });
  }
}

export interface ClientSearchResult {
  id: string;
  name: string;
  shortCode: string;
  isActive: boolean;
}
