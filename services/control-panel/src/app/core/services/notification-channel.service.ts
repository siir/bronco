import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface NotificationChannel {
  id: string;
  name: string;
  type: 'EMAIL' | 'PUSHOVER';
  config: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  success: boolean;
  message?: string;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationChannelService {
  private api = inject(ApiService);

  list(): Observable<NotificationChannel[]> {
    return this.api.get<NotificationChannel[]>('/notification-channels');
  }

  create(data: { name: string; type: string; config: Record<string, unknown> }): Observable<NotificationChannel> {
    return this.api.post<NotificationChannel>('/notification-channels', data);
  }

  update(id: string, data: Partial<{ name: string; config: Record<string, unknown>; isActive: boolean }>): Observable<NotificationChannel> {
    return this.api.patch<NotificationChannel>(`/notification-channels/${id}`, data);
  }

  delete(id: string): Observable<void> {
    return this.api.delete(`/notification-channels/${id}`);
  }

  test(id: string): Observable<TestResult> {
    return this.api.post<TestResult>(`/notification-channels/${id}/test`, {});
  }
}
