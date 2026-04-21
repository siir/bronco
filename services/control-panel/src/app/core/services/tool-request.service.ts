import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

// Keep in sync with packages/shared-types/src/tool-request.ts.
// Control panel does not depend on @bronco/shared-types directly; these
// literal unions mirror the enum values used by the REST API.
export const ToolRequestStatus = {
  PROPOSED: 'PROPOSED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  IMPLEMENTED: 'IMPLEMENTED',
  DUPLICATE: 'DUPLICATE',
} as const;
export type ToolRequestStatus = (typeof ToolRequestStatus)[keyof typeof ToolRequestStatus];

export const ToolRequestRationaleSource = {
  INLINE_AGENT_REQUEST: 'INLINE_AGENT_REQUEST',
  POST_HOC_DETECTION: 'POST_HOC_DETECTION',
  MANUAL: 'MANUAL',
} as const;
export type ToolRequestRationaleSource =
  (typeof ToolRequestRationaleSource)[keyof typeof ToolRequestRationaleSource];

export interface ToolRequestClientSummary {
  id: string;
  name: string;
  shortCode: string | null;
}

export interface ToolRequestTicketSummary {
  id: string;
  ticketNumber: number;
  subject: string;
  status: string;
}

export interface ToolRequestListItem {
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
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedReason: string | null;
  duplicateOfId: string | null;
  implementedInCommit: string | null;
  implementedInIssue: string | null;
  githubIssueUrl: string | null;
  suggestedDuplicateOfId: string | null;
  suggestedDuplicateReason: string | null;
  suggestedImprovesExisting: string | null;
  suggestedImprovesReason: string | null;
  dedupeAnalysisAt: string | null;
  createdAt: string;
  updatedAt: string;
  client: ToolRequestClientSummary;
  _count: { rationales: number };
}

export interface ToolRequestRationaleItem {
  id: string;
  toolRequestId: string;
  ticketId: string | null;
  rationale: string;
  source: ToolRequestRationaleSource;
  createdAt: string;
  ticket: ToolRequestTicketSummary | null;
}

export interface ToolRequestDetail extends ToolRequestListItem {
  rationales: ToolRequestRationaleItem[];
  duplicates: Array<{
    id: string;
    requestedName: string;
    displayTitle: string;
    status: ToolRequestStatus;
    requestCount: number;
  }>;
  duplicateOf: {
    id: string;
    requestedName: string;
    displayTitle: string;
    status: ToolRequestStatus;
  } | null;
  suggestedDuplicateOf: {
    id: string;
    requestedName: string;
    displayTitle: string;
    status: ToolRequestStatus;
  } | null;
  firstTicket: ToolRequestTicketSummary | null;
  linkedTickets: ToolRequestTicketSummary[];
}

export interface DedupeResult {
  duplicateGroupsCount: number;
  improvesExistingCount: number;
  requestsAnalyzed: number;
  warnings: string[];
  raw?: unknown;
}

export type SuggestionKind = 'duplicate' | 'improves_existing';

export interface CreateGithubIssueOptions {
  repoOwner?: string;
  repoName?: string;
  labels?: string[];
}

export interface CreateGithubIssueResponse {
  issueUrl: string;
  issueNumber: number;
}

export interface ToolRequestListResponse {
  items: ToolRequestListItem[];
  total: number;
}

export interface ToolRequestListFilters {
  status?: ToolRequestStatus | ToolRequestStatus[];
  clientId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface UpdateToolRequestBody {
  status?: ToolRequestStatus;
  rejectedReason?: string;
  duplicateOfId?: string | null;
  implementedInCommit?: string;
  implementedInIssue?: string;
  githubIssueUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class ToolRequestService {
  private api = inject(ApiService);

  list(filters?: ToolRequestListFilters): Observable<ToolRequestListResponse> {
    const params: Record<string, string | number> = {};
    if (filters?.clientId) params['clientId'] = filters.clientId;
    if (filters?.search) params['search'] = filters.search;
    if (filters?.limit != null) params['limit'] = filters.limit;
    if (filters?.offset != null) params['offset'] = filters.offset;
    if (filters?.status) {
      const arr = Array.isArray(filters.status) ? filters.status : [filters.status];
      // ApiService joins via URLSearchParams; send comma-separated then split on server? Server schema accepts array or single.
      // Use single status when only one; use first value otherwise (multi-status kept to a single call each in UI).
      if (arr.length === 1) params['status'] = arr[0];
    }
    return this.api.get<ToolRequestListResponse>('/tool-requests', params);
  }

  get(id: string): Observable<ToolRequestDetail> {
    return this.api.get<ToolRequestDetail>(`/tool-requests/${id}`);
  }

  update(id: string, body: UpdateToolRequestBody): Observable<ToolRequestListItem> {
    return this.api.patch<ToolRequestListItem>(`/tool-requests/${id}`, body);
  }

  delete(id: string): Observable<void> {
    return this.api.delete<void>(`/tool-requests/${id}`);
  }

  runDedupeAnalysis(clientId: string): Observable<DedupeResult> {
    return this.api.post<DedupeResult>('/tool-requests/dedupe-analyses', { clientId });
  }

  acceptSuggestion(id: string, kind: SuggestionKind): Observable<ToolRequestDetail> {
    return this.api.post<ToolRequestDetail>(`/tool-requests/${id}/accept-suggestion`, { kind });
  }

  dismissSuggestion(id: string, kind: SuggestionKind): Observable<ToolRequestDetail> {
    return this.api.post<ToolRequestDetail>(`/tool-requests/${id}/dismiss-suggestion`, { kind });
  }

  createGithubIssue(
    id: string,
    opts?: CreateGithubIssueOptions,
  ): Observable<CreateGithubIssueResponse> {
    return this.api.post<CreateGithubIssueResponse>(
      `/tool-requests/${id}/create-github-issue`,
      opts ?? {},
    );
  }
}
