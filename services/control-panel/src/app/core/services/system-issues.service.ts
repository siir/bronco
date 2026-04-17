import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface FailedIssueJob {
  id: string;
  ticketId: string;
  ticketSubject: string;
  clientName: string;
  repoName: string;
  branchName: string;
  error: string | null;
  failedAt: string;
}

export interface OpenFinding {
  id: string;
  systemId: string;
  systemName: string;
  clientName: string;
  title: string;
  severity: string;
  category: string;
  description: string;
  status: string;
  detectedAt: string;
}

export interface RecentError {
  id: string;
  service: string;
  message: string;
  error: string | null;
  entityId: string | null;
  entityType: string | null;
  createdAt: string;
}

export interface FailedQueueInfo {
  queue: string;
  failed: number;
}

export interface SystemIssuesResponse {
  timestamp: string;
  totalIssues: number;
  failedIssueJobs: FailedIssueJob[];
  openFindings: OpenFinding[];
  recentErrors: RecentError[];
  failedQueues: FailedQueueInfo[];
}

@Injectable({ providedIn: 'root' })
export class SystemIssuesService {
  private api = inject(ApiService);

  getIssues(errorWindowDays = 7): Observable<SystemIssuesResponse> {
    return this.api.get<SystemIssuesResponse>('/system-issues', { errorWindowDays });
  }
}
