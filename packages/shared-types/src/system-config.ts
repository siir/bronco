export interface SmtpSystemConfig {
  host: string;
  port: number;
  user: string;
  /** Encrypted at rest. API returns '••••••••' sentinel. */
  password: string;
  from: string;
  fromName?: string;
}

export interface DevOpsSystemConfig {
  orgUrl: string;
  project: string;
  /** Encrypted at rest. API returns '••••••••' sentinel. */
  pat: string;
  assignedUser: string;
  clientShortCode?: string;
  pollIntervalSeconds?: number;
}

export interface GithubSystemConfig {
  /** Encrypted at rest. API returns '••••••••' sentinel. */
  token: string;
  repo: string;
}
