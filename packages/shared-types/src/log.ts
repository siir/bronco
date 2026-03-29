export const LogLevel = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const EntityType = {
  TICKET: 'ticket',
  OPERATIONAL_TASK: 'operational_task',
  PROBE: 'probe',
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];

export interface AppLog {
  id: string;
  level: LogLevel;
  service: string;
  message: string;
  context: Record<string, unknown> | null;
  entityId: string | null;
  entityType: EntityType | null;
  error: string | null;
  createdAt: Date;
}

export const LogSummaryType = {
  TICKET: 'TICKET',
  ORPHAN: 'ORPHAN',
  SERVICE: 'SERVICE',
  UNCATEGORIZED: 'UNCATEGORIZED',
} as const;
export type LogSummaryType = (typeof LogSummaryType)[keyof typeof LogSummaryType];

export const AttentionLevel = {
  NONE: 'NONE',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
} as const;
export type AttentionLevel = (typeof AttentionLevel)[keyof typeof AttentionLevel];

export interface LogSummary {
  id: string;
  ticketId: string | null;
  summaryType: LogSummaryType;
  attentionLevel: AttentionLevel;
  windowStart: Date;
  windowEnd: Date;
  summary: string;
  logCount: number;
  services: string[];
  createdAt: Date;
}
