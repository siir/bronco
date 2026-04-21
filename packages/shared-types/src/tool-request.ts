// --- Tool Request Status (lifecycle of an agent-flagged tool gap) ---

export const ToolRequestStatus = {
  /** Agent flagged the gap; awaiting operator triage. */
  PROPOSED: 'PROPOSED',
  /** Operator accepted the request; ready for implementation. */
  APPROVED: 'APPROVED',
  /** Operator declined the request. */
  REJECTED: 'REJECTED',
  /** Tool has been implemented and shipped. */
  IMPLEMENTED: 'IMPLEMENTED',
  /** Consolidated into another ToolRequest via duplicateOfId. */
  DUPLICATE: 'DUPLICATE',
} as const;
export type ToolRequestStatus = (typeof ToolRequestStatus)[keyof typeof ToolRequestStatus];

// --- Tool Request Rationale Source (how this rationale entry was recorded) ---

export const ToolRequestRationaleSource = {
  /** Agent called `request_tool` MCP during analysis. */
  INLINE_AGENT_REQUEST: 'INLINE_AGENT_REQUEST',
  /** Post-hoc detection step mined the transcript after analysis finished. */
  POST_HOC_DETECTION: 'POST_HOC_DETECTION',
  /** Operator added the rationale manually via the admin UI/API. */
  MANUAL: 'MANUAL',
} as const;
export type ToolRequestRationaleSource =
  (typeof ToolRequestRationaleSource)[keyof typeof ToolRequestRationaleSource];

// --- Tool Request (dedup'd per-client missing-tool entry) ---

export interface ToolRequest {
  id: string;
  clientId: string;
  firstTicketId: string | null;
  requestedName: string;
  displayTitle: string;
  description: string;
  suggestedInputs: Record<string, unknown> | null;
  exampleUsage: string | null;
  status: ToolRequestStatus;
  requestCount: number;
  approvedAt: Date | null;
  approvedBy: string | null;
  rejectedReason: string | null;
  duplicateOfId: string | null;
  implementedInCommit: string | null;
  implementedInIssue: string | null;
  githubIssueUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// --- Tool Request Rationale (one entry per agent/operator call) ---

export interface ToolRequestRationale {
  id: string;
  toolRequestId: string;
  ticketId: string | null;
  rationale: string;
  source: ToolRequestRationaleSource;
  createdAt: Date;
}
