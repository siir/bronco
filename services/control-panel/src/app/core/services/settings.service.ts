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
  recipientOperatorId: string;
  throttleMinutes: number;
  alerts: {
    failedJobs: boolean;
    probeMisses: boolean;
    aiProviderDown: boolean;
    devopsSyncStale: boolean;
    summarizationStale: boolean;
  };
}

export const DEFAULT_OPERATIONAL_ALERT_CONFIG: OperationalAlertConfig = {
  enabled: false,
  recipientOperatorId: '',
  throttleMinutes: 60,
  alerts: {
    failedJobs: true,
    probeMisses: true,
    aiProviderDown: true,
    devopsSyncStale: true,
    summarizationStale: true,
  },
};

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

export interface SlackSystemConfig {
  botToken: string;
  appToken: string;
  defaultChannelId: string;
  enabled: boolean;
}

export interface PromptRetentionConfig {
  fullRetentionDays: number;
  summaryRetentionDays: number;
}

export interface ActionSafetyConfig {
  actions: Record<string, 'auto' | 'approval'>;
}

export interface AnalysisStrategyConfig {
  strategy: 'full_context' | 'orchestrated';
  maxParallelTasks: number;
}

export interface SelfAnalysisConfig {
  postAnalysisTrigger: boolean;
  ticketCloseTrigger: boolean;
  scheduledEnabled: boolean;
  scheduledCron: string;
  repoUrl: string;
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

  // --- System Config: Slack ---
  getSlackConfig(): Observable<SlackSystemConfig | null> {
    return this.api.get<SlackSystemConfig | null>('/settings/slack');
  }
  saveSlackConfig(config: SlackSystemConfig): Observable<SlackSystemConfig> {
    return this.api.put<SlackSystemConfig>('/settings/slack', config);
  }
  testSlackConnection(): Observable<TestResult> {
    return this.api.post<TestResult>('/settings/slack/test', {});
  }

  // --- Prompt Retention ---
  getPromptRetention(): Observable<PromptRetentionConfig> {
    return this.api.get<PromptRetentionConfig>('/settings/prompt-retention');
  }
  savePromptRetention(config: PromptRetentionConfig): Observable<PromptRetentionConfig> {
    return this.api.put<PromptRetentionConfig>('/settings/prompt-retention', config);
  }

  // --- Action Safety ---
  getActionSafety(): Observable<ActionSafetyConfig> {
    return this.api.get<ActionSafetyConfig>('/settings/action-safety');
  }
  saveActionSafety(config: ActionSafetyConfig): Observable<ActionSafetyConfig> {
    return this.api.put<ActionSafetyConfig>('/settings/action-safety', config);
  }

  // --- Analysis Strategy ---
  getAnalysisStrategy(): Observable<AnalysisStrategyConfig> {
    return this.api.get<AnalysisStrategyConfig>('/settings/analysis-strategy');
  }
  saveAnalysisStrategy(config: AnalysisStrategyConfig): Observable<AnalysisStrategyConfig> {
    return this.api.put<AnalysisStrategyConfig>('/settings/analysis-strategy', config);
  }

  // --- Self Analysis ---
  getSelfAnalysis(): Observable<SelfAnalysisConfig> {
    return this.api.get<SelfAnalysisConfig>('/settings/self-analysis');
  }
  saveSelfAnalysis(config: Partial<SelfAnalysisConfig>): Observable<SelfAnalysisConfig> {
    return this.api.patch<SelfAnalysisConfig>('/settings/self-analysis', config);
  }
}
