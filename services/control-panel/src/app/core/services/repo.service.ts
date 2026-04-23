import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface CodeRepo {
  id: string;
  clientId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  branchPrefix: string;
  description?: string;
  /** FK to a GITHUB-type ClientIntegration. null = use platform default / legacy SSH. */
  githubIntegrationId?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  client?: { name: string; shortCode: string };
  _count?: { issueJobs: number };
}

@Injectable({ providedIn: 'root' })
export class RepoService {
  private api = inject(ApiService);

  getRepos(clientId?: string): Observable<CodeRepo[]> {
    return this.api.get<CodeRepo[]>('/repos', clientId ? { clientId } : {});
  }

  getRepo(id: string): Observable<CodeRepo> {
    return this.api.get<CodeRepo>(`/repos/${id}`);
  }

  createRepo(data: Partial<CodeRepo> & { clientId: string; name: string; repoUrl: string }): Observable<CodeRepo> {
    return this.api.post<CodeRepo>('/repos', data);
  }

  updateRepo(id: string, data: Partial<CodeRepo>): Observable<CodeRepo> {
    return this.api.patch<CodeRepo>(`/repos/${id}`, data);
  }

  deleteRepo(id: string): Observable<void> {
    return this.api.delete(`/repos/${id}`);
  }
}
