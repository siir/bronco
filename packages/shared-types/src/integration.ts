export const IntegrationType = {
  IMAP: 'IMAP',
  AZURE_DEVOPS: 'AZURE_DEVOPS',
  MCP_DATABASE: 'MCP_DATABASE',
  SLACK: 'SLACK',
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

export type IntegrationConfig =
  | ImapIntegrationConfig
  | AzureDevOpsIntegrationConfig
  | McpDatabaseIntegrationConfig
  | SlackIntegrationConfig;

export interface ClientIntegration {
  id: string;
  clientId: string;
  type: IntegrationType;
  label: string;
  config: IntegrationConfig;
  environmentId: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
