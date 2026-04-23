export const IntegrationType = {
  IMAP: 'IMAP',
  AZURE_DEVOPS: 'AZURE_DEVOPS',
  MCP_DATABASE: 'MCP_DATABASE',
  SLACK: 'SLACK',
  GITHUB: 'GITHUB',
} as const;
export type IntegrationType = (typeof IntegrationType)[keyof typeof IntegrationType];

export interface ImapIntegrationConfig {
  host: string;
  port: number;
  user: string;
  encryptedPassword: string;
  pollIntervalSeconds: number;
}

export interface AzureDevOpsIntegrationConfig {
  orgUrl: string;
  project: string;
  encryptedPat: string;
  assignedUser: string;
  pollIntervalSeconds: number;
}

export interface McpDatabaseIntegrationConfig {
  url: string;
  disabledTools?: string[];
}

export interface SlackIntegrationConfig {
  encryptedBotToken: string;
  encryptedAppToken: string;
  defaultChannelId: string;
  enabled: boolean;
}

/**
 * GitHub credentials — discriminated union supporting both PAT and GitHub App
 * installation tokens. Host defaults to `github.com` when omitted, which unlocks
 * GitHub Enterprise Server targets.
 *
 * Tokens and private keys are stored encrypted (AES-256-GCM via shared-utils).
 * The `encryptedToken` / `encryptedPrivateKey` fields hold ciphertext at rest;
 * callers must decrypt before use.
 *
 * NOTE: `github_app` support is stubbed for v1 — the Zod schema accepts it and
 * the data round-trips, but token-minting (JWT → installation token exchange)
 * is a follow-up (#369). mcp-repo falls through to the next resolution level
 * (platform default / SSH) when it encounters `kind: 'github_app'`.
 * tool-request-github throws a clear error rather than silently falling back,
 * because an operator who configured a github_app integration almost certainly
 * intended it to be used.
 */
export interface GithubPatCredentials {
  kind: 'pat';
  /** Encrypted PAT — ciphertext. Decrypt with shared-utils.decrypt before use. */
  encryptedToken: string;
  /** Defaults to `github.com`. Set for GitHub Enterprise Server. */
  host?: string;
}

export interface GithubAppCredentials {
  kind: 'github_app';
  appId: string;
  installationId: string;
  /** Encrypted private key (PEM) — ciphertext. */
  encryptedPrivateKey: string;
  host?: string;
}

export type GithubCredentials = GithubPatCredentials | GithubAppCredentials;

export type GithubIntegrationConfig = GithubCredentials;

export type IntegrationConfig =
  | ImapIntegrationConfig
  | AzureDevOpsIntegrationConfig
  | McpDatabaseIntegrationConfig
  | SlackIntegrationConfig
  | GithubIntegrationConfig;

/**
 * ClientIntegration — integration config. clientId is nullable for
 * platform-scoped integrations (e.g. the single platform-wide GITHUB
 * integration used by tool-request issue creation and issue-resolver pushes).
 */
export interface ClientIntegration {
  id: string;
  clientId: string | null;
  type: IntegrationType;
  label: string;
  config: IntegrationConfig;
  environmentId: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
