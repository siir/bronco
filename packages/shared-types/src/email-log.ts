export const EmailClassification = {
  TICKET_WORTHY: 'TICKET_WORTHY',
  THREAD_REPLY: 'THREAD_REPLY',
  AUTO_REPLY: 'AUTO_REPLY',
  NOISE: 'NOISE',
} as const;
export type EmailClassification = (typeof EmailClassification)[keyof typeof EmailClassification];

export const EmailProcessingStatus = {
  PROCESSED: 'processed',
  FAILED: 'failed',
  RETRIED: 'retried',
  DISCARDED: 'discarded',
} as const;
export type EmailProcessingStatus = (typeof EmailProcessingStatus)[keyof typeof EmailProcessingStatus];

export interface EmailProcessingLog {
  id: string;
  messageId: string;
  from: string;
  fromName: string | null;
  subject: string;
  receivedAt: string;
  classification: EmailClassification;
  status: EmailProcessingStatus;
  clientId: string | null;
  ticketId: string | null;
  errorMessage: string | null;
  processingMs: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  client?: { id: string; name: string } | null;
  ticket?: { id: string; subject: string } | null;
}

export interface EmailLogStats {
  totalToday: number;
  ticketsCreated: number;
  noiseFiltered: number;
  failures: number;
}
