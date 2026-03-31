export const NotificationChannelType = {
  EMAIL: 'EMAIL',
  PUSHOVER: 'PUSHOVER',
} as const;
export type NotificationChannelType =
  (typeof NotificationChannelType)[keyof typeof NotificationChannelType];

export interface NotificationChannelRecord {
  id: string;
  name: string;
  type: NotificationChannelType;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Type-specific config (secrets redacted in API responses). */
  config: Record<string, unknown>;
}

export const NotificationEvent = {
  TICKET_CREATED: 'TICKET_CREATED',
  ANALYSIS_COMPLETE: 'ANALYSIS_COMPLETE',
  SUFFICIENCY_CHANGED: 'SUFFICIENCY_CHANGED',
  USER_REPLIED: 'USER_REPLIED',
  PLAN_READY: 'PLAN_READY',
  PLAN_APPROVED: 'PLAN_APPROVED',
  PLAN_REJECTED: 'PLAN_REJECTED',
  RESOLUTION_COMPLETE: 'RESOLUTION_COMPLETE',
  SERVICE_HEALTH_ALERT: 'SERVICE_HEALTH_ALERT',
  PROBE_ALERT: 'PROBE_ALERT',
} as const;
export type NotificationEvent = (typeof NotificationEvent)[keyof typeof NotificationEvent];

/** Human-readable descriptions for each notification event. */
export const NotificationEventDescriptions: Record<NotificationEvent, string> = {
  TICKET_CREATED: 'New ticket received from any source',
  ANALYSIS_COMPLETE: 'Ticket analysis finished (findings ready)',
  SUFFICIENCY_CHANGED: 'Sufficiency status changed',
  USER_REPLIED: 'Client replied to a ticket',
  PLAN_READY: 'Resolution plan generated, awaiting approval',
  PLAN_APPROVED: 'Plan approved by operator',
  PLAN_REJECTED: 'Plan rejected by operator',
  RESOLUTION_COMPLETE: 'Code changes pushed to branch',
  SERVICE_HEALTH_ALERT: 'Service went unhealthy',
  PROBE_ALERT: 'Scheduled probe detected an anomaly',
};

export interface NotificationPreferenceRecord {
  id: string;
  event: NotificationEvent;
  emailEnabled: boolean;
  slackEnabled: boolean;
  slackTarget: string | null;
  emailTarget: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
