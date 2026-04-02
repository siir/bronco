export const TicketStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING: 'WAITING',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const Priority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const TicketSource = {
  MANUAL: 'MANUAL',
  EMAIL: 'EMAIL',
  AZURE_DEVOPS: 'AZURE_DEVOPS',
  AI_DETECTED: 'AI_DETECTED',
  SCHEDULED: 'SCHEDULED',
  SLACK: 'SLACK',
} as const;
export type TicketSource = (typeof TicketSource)[keyof typeof TicketSource];

export const TicketCategory = {
  DATABASE_PERF: 'DATABASE_PERF',
  BUG_FIX: 'BUG_FIX',
  FEATURE_REQUEST: 'FEATURE_REQUEST',
  SCHEMA_CHANGE: 'SCHEMA_CHANGE',
  CODE_REVIEW: 'CODE_REVIEW',
  ARCHITECTURE: 'ARCHITECTURE',
  GENERAL: 'GENERAL',
} as const;
export type TicketCategory = (typeof TicketCategory)[keyof typeof TicketCategory];

export const TicketEventType = {
  COMMENT: 'COMMENT',
  STATUS_CHANGE: 'STATUS_CHANGE',
  PRIORITY_CHANGE: 'PRIORITY_CHANGE',
  CATEGORY_CHANGE: 'CATEGORY_CHANGE',
  ASSIGNMENT: 'ASSIGNMENT',
  AI_ANALYSIS: 'AI_ANALYSIS',
  AI_RECOMMENDATION: 'AI_RECOMMENDATION',
  EMAIL_INBOUND: 'EMAIL_INBOUND',
  EMAIL_OUTBOUND: 'EMAIL_OUTBOUND',
  DEVOPS_INBOUND: 'DEVOPS_INBOUND',
  DEVOPS_OUTBOUND: 'DEVOPS_OUTBOUND',
  SLACK_INBOUND: 'SLACK_INBOUND',
  SLACK_OUTBOUND: 'SLACK_OUTBOUND',
  PLAN_PROPOSED: 'PLAN_PROPOSED',
  PLAN_APPROVED: 'PLAN_APPROVED',
  PLAN_REJECTED: 'PLAN_REJECTED',
  PLAN_EXECUTING: 'PLAN_EXECUTING',
  PLAN_COMPLETED: 'PLAN_COMPLETED',
  ARTIFACT_ADDED: 'ARTIFACT_ADDED',
  SYSTEM_NOTE: 'SYSTEM_NOTE',
  CODE_CHANGE: 'CODE_CHANGE',
} as const;
export type TicketEventType = (typeof TicketEventType)[keyof typeof TicketEventType];

export type OpenTicketStatus =
  | typeof TicketStatus.OPEN
  | typeof TicketStatus.IN_PROGRESS
  | typeof TicketStatus.WAITING;

export type ClosedTicketStatus =
  | typeof TicketStatus.RESOLVED
  | typeof TicketStatus.CLOSED;

/** Statuses that represent an active/open ticket. */
export const OPEN_STATUSES = Object.freeze([
  TicketStatus.OPEN,
  TicketStatus.IN_PROGRESS,
  TicketStatus.WAITING,
] as const);

/** Statuses that represent a terminal/closed ticket. */
export const CLOSED_STATUSES = Object.freeze([
  TicketStatus.RESOLVED,
  TicketStatus.CLOSED,
] as const);

const OPEN_STATUS_SET: ReadonlySet<string> = new Set<string>(OPEN_STATUSES);
const CLOSED_STATUS_SET: ReadonlySet<string> = new Set<string>(CLOSED_STATUSES);

export function isOpenStatus(status: string): status is OpenTicketStatus {
  return OPEN_STATUS_SET.has(status);
}

export function isClosedStatus(status: string): status is ClosedTicketStatus {
  return CLOSED_STATUS_SET.has(status);
}

export const FollowerType = {
  REQUESTER: 'REQUESTER',
  FOLLOWER: 'FOLLOWER',
} as const;
export type FollowerType = (typeof FollowerType)[keyof typeof FollowerType];

export const SufficiencyStatus = {
  SUFFICIENT: 'SUFFICIENT',
  NEEDS_USER_INPUT: 'NEEDS_USER_INPUT',
  INSUFFICIENT: 'INSUFFICIENT',
} as const;
export type SufficiencyStatus = (typeof SufficiencyStatus)[keyof typeof SufficiencyStatus];

export const SufficiencyConfidence = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
} as const;
export type SufficiencyConfidence = (typeof SufficiencyConfidence)[keyof typeof SufficiencyConfidence];

export const AnalysisStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;
export type AnalysisStatus = (typeof AnalysisStatus)[keyof typeof AnalysisStatus];

export interface TicketFollower {
  id: string;
  ticketId: string;
  contactId: string;
  followerType: FollowerType;
  createdAt: Date;
}

export interface Ticket {
  id: string;
  clientId: string;
  systemId: string | null;
  subject: string;
  description: string | null;
  summary: string | null;
  status: TicketStatus;
  priority: Priority;
  source: TicketSource;
  category: TicketCategory | null;
  environmentId: string | null;
  assignedOperatorId: string | null;
  analysisStatus: AnalysisStatus;
  analysisError: string | null;
  sufficiencyStatus: SufficiencyStatus | null;
  knowledgeDoc: string | null;
  lastAnalyzedAt: Date | null;
  metadata: Record<string, unknown> | null;
  externalRef: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  eventType: TicketEventType;
  content: string | null;
  metadata: Record<string, unknown> | null;
  actor: string;
  createdAt: Date;
}

/** BullMQ job payload for the 'ticket-created' queue. */
export interface TicketCreatedJob {
  ticketId: string;
  clientId: string;
  source: TicketSource;
  category: TicketCategory | null;
}

/** BullMQ job payload for the 'ticket-analysis' queue. */
export interface AnalysisJob {
  ticketId: string;
  /** @deprecated Ignored by the analyzer — clientId is loaded from the DB (source of truth). Kept for backward compatibility with existing enqueued jobs. */
  clientId?: string;
  /** When true, this is a re-analysis triggered by an inbound reply to an analyzed ticket. */
  reanalysis?: boolean;
  /** The ticket event ID of the COMMENT/EMAIL_INBOUND that triggered re-analysis. */
  triggerEventId?: string;
}
