export const SystemAnalysisStatus = {
  PENDING: 'PENDING',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  REJECTED: 'REJECTED',
} as const;
export type SystemAnalysisStatus =
  (typeof SystemAnalysisStatus)[keyof typeof SystemAnalysisStatus];

export const SystemAnalysisTriggerType = {
  TICKET_CLOSE: 'TICKET_CLOSE',
  POST_ANALYSIS: 'POST_ANALYSIS',
  SCHEDULED: 'SCHEDULED',
} as const;
export type SystemAnalysisTriggerType =
  (typeof SystemAnalysisTriggerType)[keyof typeof SystemAnalysisTriggerType];

export interface SystemAnalysis {
  id: string;
  ticketId: string;
  clientId: string;
  status: SystemAnalysisStatus;
  analysis: string;
  suggestions: string;
  rejectionReason: string | null;
  aiModel: string | null;
  aiProvider: string | null;
  createdAt: Date;
  updatedAt: Date;
}
