import type { Priority } from './ticket.js';

export const OperationalTaskStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING: 'WAITING',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;
export type OperationalTaskStatus = (typeof OperationalTaskStatus)[keyof typeof OperationalTaskStatus];

export const OperationalTaskSource = {
  MANUAL: 'MANUAL',
  AZURE_DEVOPS: 'AZURE_DEVOPS',
} as const;
export type OperationalTaskSource = (typeof OperationalTaskSource)[keyof typeof OperationalTaskSource];

export const OperationalTaskEventType = {
  COMMENT: 'COMMENT',
  STATUS_CHANGE: 'STATUS_CHANGE',
  PRIORITY_CHANGE: 'PRIORITY_CHANGE',
  AI_ANALYSIS: 'AI_ANALYSIS',
  DEVOPS_INBOUND: 'DEVOPS_INBOUND',
  DEVOPS_OUTBOUND: 'DEVOPS_OUTBOUND',
  PLAN_PROPOSED: 'PLAN_PROPOSED',
  PLAN_APPROVED: 'PLAN_APPROVED',
  PLAN_REJECTED: 'PLAN_REJECTED',
  PLAN_EXECUTING: 'PLAN_EXECUTING',
  PLAN_COMPLETED: 'PLAN_COMPLETED',
  SYSTEM_NOTE: 'SYSTEM_NOTE',
} as const;
export type OperationalTaskEventType = (typeof OperationalTaskEventType)[keyof typeof OperationalTaskEventType];

export interface OperationalTask {
  id: string;
  subject: string;
  description: string | null;
  status: OperationalTaskStatus;
  priority: Priority;
  source: OperationalTaskSource;
  externalRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperationalTaskEvent {
  id: string;
  taskId: string;
  eventType: OperationalTaskEventType;
  content: string | null;
  metadata: Record<string, unknown> | null;
  actor: string;
  createdAt: Date;
}
