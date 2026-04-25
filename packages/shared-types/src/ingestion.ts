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

/** A single email attachment forwarded via the ingestion payload. */
export interface EmailAttachmentPayload {
  /** Original filename from the email. */
  filename: string;
  /** MIME type reported by the email (e.g. "application/pdf"). */
  contentType: string;
  /** File size in bytes. */
  size: number;
  /** Base64-encoded content. Only present when size <= 25 MB. */
  content: string;
}

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
  /** Pre-resolved Person ID for the sender (if matched by imap-worker). */
  personId?: string;
  /**
   * Attachments extracted from the email. Each attachment is base64-encoded and
   * capped at 25 MB. Oversized attachments are skipped (WARN-logged by imap-worker).
   * The ingestion engine persists these as Artifact rows after ticket creation.
   */
  attachments?: EmailAttachmentPayload[];
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
  /** DevOpsSyncState ID for linking the ticket back after ingestion. */
  syncStateId?: string;
  /** Azure DevOps work item URL. */
  devopsUrl?: string;
}

/** Manual ticket payload submitted via API. */
export interface ManualIngestionPayload {
  subject: string;
  description?: string;
  priority?: string;
  category?: string;
  /** Person ID for the ticket requester. */
  personId?: string;
  systemId?: string;
  environmentId?: string;
}

/** Portal ticket payload submitted by a client portal user. */
export interface PortalIngestionPayload {
  subject: string;
  description?: string;
  priority?: string;
  /** Portal user ID (Person.id) who created the ticket. */
  portalCreatorId: string;
  /** Person ID resolved from the portal user's email. */
  personId?: string;
}

/** Slack message payload submitted by client-slack-manager. */
export interface SlackIngestionPayload {
  slackUserId: string;
  slackUsername: string;
  slackChannelId: string;
  slackThreadTs?: string;
  text: string;
  personId?: string;
  integrationId: string;
}
