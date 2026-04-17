import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export type ReleaseNoteType = 'FEATURE' | 'FIX' | 'MAINTENANCE' | 'OTHER';

export interface ReleaseNote {
  id: string;
  commitSha: string;
  commitDate: string;
  rawMessage: string;
  summary: string | null;
  services: string[];
  changeType: ReleaseNoteType;
  releaseTag: string | null;
  isVisible: boolean;
  createdAt: string;
}

export interface ReleaseNotesResponse {
  items: ReleaseNote[];
  total: number;
}

export interface IngestResult {
  ingested: number;
  skipped: number;
}

export interface ReleaseNotesFilters {
  service?: string;
  search?: string;
  from?: string;
  to?: string;
  changeType?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

@Injectable({ providedIn: 'root' })
export class ReleaseNotesService {
  private api = inject(ApiService);

  list(filters?: ReleaseNotesFilters): Observable<ReleaseNotesResponse> {
    return this.api.get<ReleaseNotesResponse>('/release-notes', filters as Record<string, string | number>);
  }

  getServices(): Observable<string[]> {
    return this.api.get<string[]>('/release-notes/services');
  }

  getTags(): Observable<string[]> {
    return this.api.get<string[]>('/release-notes/tags');
  }

  ingest(commits: unknown[]): Observable<IngestResult> {
    return this.api.post<IngestResult>('/release-notes/ingest', { commits });
  }

  backfill(fromSha: string, toSha?: string): Observable<IngestResult> {
    return this.api.post<IngestResult>('/release-notes/ingest', { fromSha, toSha });
  }

  update(id: string, isVisible: boolean): Observable<ReleaseNote> {
    return this.api.patch<ReleaseNote>(`/release-notes/${id}`, { isVisible });
  }
}
