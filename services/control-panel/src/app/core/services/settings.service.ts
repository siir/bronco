import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface TicketStatusConfig {
  value: string;
  displayName: string;
  description: string | null;
  color: string;
  sortOrder: number;
  statusClass: 'open' | 'closed';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TicketCategoryConfig {
  value: string;
  displayName: string;
  description: string | null;
  color: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateStatusConfig {
  displayName?: string;
  description?: string | null;
  color?: string;
  sortOrder?: number;
  statusClass?: 'open' | 'closed';
  isActive?: boolean;
}

export interface CreateStatusConfig {
  value: string;
  displayName: string;
  color: string;
  statusClass: 'open' | 'closed';
  sortOrder?: number;
  description?: string | null;
}

export interface CreateCategoryConfig {
  value: string;
  displayName: string;
  color: string;
  sortOrder?: number;
  description?: string | null;
}

export interface UpdateCategoryConfig {
  displayName?: string;
  description?: string | null;
  color?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface OperationalAlertConfig {
  enabled: boolean;
  recipientEmail: string;
  throttleMinutes: number;
  alerts: {
    failedJobs: boolean;
    probeMisses: boolean;
    aiProviderDown: boolean;
    devopsSyncStale: boolean;
    summarizationStale: boolean;
  };
}

export interface TestAlertResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface SmtpSystemConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  fromName?: string;
}

export interface DevOpsSystemConfig {
  orgUrl: string;
  project: string;
  pat: string;
  assignedUser: string;
  clientShortCode?: string;
  pollIntervalSeconds?: number;
}

export interface GithubSystemConfig {
  token: string;
  repo: string;
}

export interface ImapSystemConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  pollIntervalSeconds?: number;
}

export interface TestResult {
  success: boolean;
  message?: string;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private api = inject(ApiService);

  getStatuses(): Observable<TicketStatusConfig[]> {
    return this.api.get<TicketStatusConfig[]>('/settings/statuses');
  }

  createStatus(data: CreateStatusConfig): Observable<TicketStatusConfig> {
    return this.api.post<TicketStatusConfig>('/settings/statuses', data);
  }

  updateStatus(value: string, data: UpdateStatusConfig): Observable<TicketStatusConfig> {
    return this.api.patch<TicketStatusConfig>(`/settings/statuses/${value}`, data);
  }

  getCategories(): Observable<TicketCategoryConfig[]> {
    return this.api.get<TicketCategoryConfig[]>('/settings/categories');
  }

  createCategory(data: CreateCategoryConfig): Observable<TicketCategoryConfig> {
    return this.api.post<TicketCategoryConfig>('/settings/categories', data);
  }

  updateCategory(value: string, data: UpdateCategoryConfig): Observable<TicketCategoryConfig> {
    return this.api.patch<TicketCategoryConfig>(`/settings/categories/${value}`, data);
  }

  getOperationalAlerts(): Observable<OperationalAlertConfig> {
    return this.api.get<OperationalAlertConfig>('/settings/operational-alerts');
  }

  updateOperationalAlerts(config: OperationalAlertConfig): Observable<OperationalAlertConfig> {
    return this.api.put<OperationalAlertConfig>('/settings/operational-alerts', config);
  }

  testOperationalAlert(): Observable<TestAlertResult> {
    return this.api.post<TestAlertResult>('/settings/operational-alerts/test', {});
  }

  getSuperAdminUserId(): Observable<{ userId: string | null }> {
    return this.api.get<{ userId: string | null }>('/settings/super-admin');
  }

  setSuperAdminUserId(userId: string | null): Observable<{ userId: string | null }> {
    return this.api.put<{ userId: string | null }>('/settings/super-admin', { userId });
  }


  // --- System Config: SMTP ---
  getSmtpConfig(): Observable<SmtpSystemConfig | null> {
    return this.api.get<SmtpSystemConfig | null>('/settings/smtp');
  }
  updateSmtpConfig(config: SmtpSystemConfig): Observable<SmtpSystemConfig> {
    return this.api.put<SmtpSystemConfig>('/settings/smtp', config);
  }
  testSmtpConfig(): Observable<TestResult> {
    return this.api.post<TestResult>('/settings/smtp/test', {});
  }

  // --- System Config: Azure DevOps ---
  getDevOpsConfig(): Observable<DevOpsSystemConfig | null> {
    return this.api.get<DevOpsSystemConfig | null>('/settings/devops');
  }
  updateDevOpsConfig(config: DevOpsSystemConfig): Observable<DevOpsSystemConfig> {
    return this.api.put<DevOpsSystemConfig>('/settings/devops', config);
  }
  testDevOpsConfig(): Observable<TestResult> {
    return this.api.post<TestResult>('/settings/devops/test', {});
  }

  // --- System Config: GitHub ---
  getGithubConfig(): Observable<GithubSystemConfig | null> {
    return this.api.get<GithubSystemConfig | null>('/settings/github');
  }
  updateGithubConfig(config: GithubSystemConfig): Observable<GithubSystemConfig> {
    return this.api.put<GithubSystemConfig>('/settings/github', config);
  }
  testGithubConfig(): Observable<TestResult> {
    return this.api.post<TestResult>('/settings/github/test', {});
  }

  // --- System Config: IMAP ---
  getImapConfig(): Observable<ImapSystemConfig | null> {
    return this.api.get<ImapSystemConfig | null>('/settings/imap');
  }
  saveImapConfig(config: ImapSystemConfig): Observable<ImapSystemConfig> {
    return this.api.put<ImapSystemConfig>('/settings/imap', config);
  }
  testImapConnection(): Observable<TestResult> {
    return this.api.post<TestResult>('/settings/imap/test', {});
  }
}
