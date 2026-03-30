import type { TicketCategory, TicketSource } from './ticket.js';

// --- Ingestion Job (BullMQ payload for the ticket-ingest queue) ---

/** BullMQ job payload for the 'ticket-ingest' queue. */
export interface IngestionJob {
  source: TicketSource;
  clientId: string;
  /** Source-specific raw data — shape depends on `source`. */
  payload: Record<string, unknown>;
}

// --- Typed payload shapes per source ---

/** Email payload submitted by imap-worker. */
export interface EmailIngestionPayload {
  from: string;
  fromName?: string;
  subject: string;
  body: string;
  /** HTML body of the email (if available). */
  bodyHtml?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Email date from the Date header. */
  date?: string;
  hasAttachments?: boolean;
  /** SHA-256 hash of the raw email source for dedup. */
  emailHash?: string;
  /** Pre-resolved contact ID for the sender (if matched by imap-worker). */
  contactId?: string;
}

/** Probe result payload submitted by probe-worker. */
export interface ProbeIngestionPayload {
  probeId: string;
  probeName: string;
  toolName: string;
  toolResult: string;
  category?: TicketCategory;
  integrationId?: string;
  /** Operator email for requester resolution. */
  operatorEmail?: string;
}

/** Azure DevOps work item payload submitted by devops-worker. */
export interface DevOpsIngestionPayload {
  workItemId: number;
  workItemType: string;
  title: string;
  description: string;
  /** Azure DevOps priority (1=Critical, 2=High, 3=Medium, 4=Low). */
  priority: number;
  state: string;
  tags?: string;
  areaPath?: string;
  iterationPath?: string;
  assignedTo?: string;
  externalRef: string;
  integrationId?: string;
}

/** Manual ticket payload submitted via API. */
export interface ManualIngestionPayload {
  subject: string;
  description?: string;
  priority?: string;
  category?: string;
  requesterId?: string;
  systemId?: string;
}
