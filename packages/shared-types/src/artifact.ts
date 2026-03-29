export const Severity = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const FindingStatus = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  WONT_FIX: 'WONT_FIX',
} as const;
export type FindingStatus = (typeof FindingStatus)[keyof typeof FindingStatus];

export interface Artifact {
  id: string;
  ticketId: string | null;
  findingId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  description: string | null;
  createdAt: Date;
}

export interface Finding {
  id: string;
  systemId: string;
  title: string;
  severity: Severity;
  category: string;
  description: string;
  recommendation: string | null;
  sqlEvidence: string | null;
  status: FindingStatus;
  detectedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Playbook {
  id: string;
  findingId: string | null;
  title: string;
  category: string;
  content: string;
  isTemplate: boolean;
  createdAt: Date;
  updatedAt: Date;
}
