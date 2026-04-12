import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface TicketFollower {
  id: string;
  ticketId: string;
  personId: string;
  followerType: 'REQUESTER' | 'FOLLOWER';
  createdAt: string;
  person?: { name: string; email: string };
}

export interface Ticket {
  id: string;
  clientId: string;
  subject: string;
  description: string | null;
  summary: string | null;
  status: string;
  priority: string;
  source: string;
  category: string | null;
  ticketNumber: number | null;
  createdAt: string;
  updatedAt: string;
  system?: { name: string } | null;
  followers?: TicketFollower[];
  events?: TicketEvent[];
  artifacts?: Artifact[];
  _count?: { events: number; artifacts: number };
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  eventType: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  actor: string;
  createdAt: string;
}

export interface Artifact {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  createdAt: string;
}

export interface TicketStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byCategory: Record<string, number>;
}

interface TicketListResponse {
  tickets: Ticket[];
  total: number;
  limit: number;
  offset: number;
}

@Injectable({ providedIn: 'root' })
export class TicketService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiUrl;

  getTickets(params?: { status?: string; category?: string; limit?: number; offset?: number }): Observable<TicketListResponse> {
    let httpParams = new HttpParams();
    if (params?.status) httpParams = httpParams.set('status', params.status);
    if (params?.category) httpParams = httpParams.set('category', params.category);
    if (params?.limit) httpParams = httpParams.set('limit', params.limit);
    if (params?.offset) httpParams = httpParams.set('offset', params.offset);
    return this.http.get<TicketListResponse>(`${this.baseUrl}/portal/tickets`, { params: httpParams });
  }

  getTicket(id: string): Observable<Ticket> {
    return this.http.get<Ticket>(`${this.baseUrl}/portal/tickets/${id}`);
  }

  getStats(): Observable<TicketStats> {
    return this.http.get<TicketStats>(`${this.baseUrl}/portal/tickets/stats`);
  }

  createTicket(data: { subject: string; description?: string; priority?: string }): Observable<Ticket> {
    return this.http.post<Ticket>(`${this.baseUrl}/portal/tickets`, data);
  }

  addComment(ticketId: string, content: string): Observable<TicketEvent> {
    return this.http.post<TicketEvent>(`${this.baseUrl}/portal/tickets/${ticketId}/comments`, { content });
  }

  uploadAttachment(ticketId: string, file: File, description?: string): Observable<Artifact> {
    const formData = new FormData();
    formData.append('file', file);
    let params = new HttpParams();
    if (description) params = params.set('description', description);
    return this.http.post<Artifact>(`${this.baseUrl}/portal/tickets/${ticketId}/attachments`, formData, { params });
  }

  getAttachmentDownloadUrl(ticketId: string, artifactId: string): string {
    return `${this.baseUrl}/portal/tickets/${ticketId}/attachments/${artifactId}/download`;
  }
}
