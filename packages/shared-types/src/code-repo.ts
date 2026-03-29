/** Branch names that the issue resolver must never target directly. */
export const PROTECTED_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'release']);

export const IssueJobStatus = {
  PENDING: 'PENDING',
  CLONING: 'CLONING',
  ANALYZING: 'ANALYZING',
  APPLYING: 'APPLYING',
  PUSHING: 'PUSHING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type IssueJobStatus = (typeof IssueJobStatus)[keyof typeof IssueJobStatus];

export interface CodeRepo {
  id: string;
  clientId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  branchPrefix: string;
  environmentId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueJob {
  id: string;
  ticketId: string;
  repoId: string;
  branchName: string;
  status: IssueJobStatus;
  commitSha: string | null;
  filesChanged: number | null;
  error: string | null;
  aiModel: string | null;
  aiUsage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
