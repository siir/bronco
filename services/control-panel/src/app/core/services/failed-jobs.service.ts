import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface FailedJob {
  id: string;
  queue: string;
  name: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
  maxAttempts: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  stacktrace: string[];
}

export interface FailedJobsResponse {
  jobs: FailedJob[];
  total: number;
}

@Injectable({ providedIn: 'root' })
export class FailedJobsService {
  private api = inject(ApiService);

  list(params?: { queue?: string; limit?: number; offset?: number }): Observable<FailedJobsResponse> {
    return this.api.get<FailedJobsResponse>('/failed-jobs', params as Record<string, string | number>);
  }

  retry(queue: string, jobId: string): Observable<{ retried: boolean }> {
    return this.api.post<{ retried: boolean }>(`/failed-jobs/${queue}/${jobId}/retry`, {});
  }

  retryAll(queue: string): Observable<{ retriedCount: number; failedCount: number }> {
    return this.api.post<{ retriedCount: number; failedCount: number }>(`/failed-jobs/${queue}/retry-all`, {});
  }

  discard(queue: string, jobId: string): Observable<{ removed: boolean }> {
    return this.api.delete<{ removed: boolean }>(`/failed-jobs/${queue}/${jobId}`);
  }

  discardAll(queue: string): Observable<{ removedCount: number }> {
    return this.api.delete<{ removedCount: number }>(`/failed-jobs/${queue}`);
  }
}
