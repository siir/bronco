import type { AIProvider } from './ai.js';

export const AiMode = {
  PLATFORM: 'platform',
  BYOK: 'byok',
} as const;
export type AiMode = (typeof AiMode)[keyof typeof AiMode];

export const BillingMode = {
  PLATFORM: 'platform',
  BYOK: 'byok',
} as const;
export type BillingMode = (typeof BillingMode)[keyof typeof BillingMode];

export const BillingPeriod = {
  DISABLED: 'disabled',
  WEEKLY: 'weekly',
  BIWEEKLY: 'biweekly',
  MONTHLY: 'monthly',
} as const;
export type BillingPeriod = (typeof BillingPeriod)[keyof typeof BillingPeriod];

export const NotificationMode = {
  CLIENT: 'client',
  OPERATOR: 'operator',
} as const;
export type NotificationMode = (typeof NotificationMode)[keyof typeof NotificationMode];

export interface Client {
  id: string;
  name: string;
  shortCode: string;
  isActive: boolean;
  autoRouteTickets: boolean;
  allowSelfRegistration: boolean;
  notificationMode: NotificationMode;
  aiMode: AiMode;
  notes: string | null;
  companyProfile: string | null;
  systemsProfile: string | null;
  domainMappings: string[];
  searchIgnoreTerms: string[];
  billingMarkupPercent: number;
  billingPeriod: BillingPeriod;
  billingAnchorDay: number;
  slackChannelId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Invoice {
  id: string;
  clientId: string;
  invoiceNumber: number;
  periodStart: Date;
  periodEnd: Date;
  totalBaseCostUsd: number;
  totalBilledCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  markupPercent: number;
  pdfPath: string | null;
  status: 'draft' | 'final';
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientAiCredential {
  id: string;
  clientId: string;
  provider: AIProvider;
  label: string;
  isActive: boolean;
  last4: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Repository {
  id: string;
  clientId: string;
  name: string;
  url: string;
  branch: string;
  localPath: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
