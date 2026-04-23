/** Branch names that the issue resolver must never target directly. */
export const PROTECTED_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'release']);

export const IssueJobStatus = {
  PENDING: 'PENDING',
  CLONING: 'CLONING',
  ANALYZING: 'ANALYZING',
  PLANNING: 'PLANNING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPLYING: 'APPLYING',
  PUSHING: 'PUSHING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type IssueJobStatus = (typeof IssueJobStatus)[keyof typeof IssueJobStatus];

export const PlanActionCategory = {
  WILL_DO: 'WILL_DO',
  CAN_DO_IF_ALLOWED: 'CAN_DO_IF_ALLOWED',
  CANNOT_DO: 'CANNOT_DO',
} as const;
export type PlanActionCategory = (typeof PlanActionCategory)[keyof typeof PlanActionCategory];

export interface ResolutionPlanAction {
  description: string;
  category: PlanActionCategory;
  files?: string[];
  manualSteps?: string;
  requirement?: string;
}

export interface ResolutionPlan {
  summary: string;
  approach: string;
  actions: ResolutionPlanAction[];
  assumptions: string[];
  openQuestions: string[];
  estimatedFiles: number;
}

export interface CodeRepo {
  id: string;
  clientId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  branchPrefix: string;
  description: string | null;
  fileExtensions: string[];
  environmentId: string | null;
  /**
   * Optional FK to a GITHUB-type ClientIntegration. When set, mcp-repo uses that
   * integration's credentials to clone over HTTPS. When null, mcp-repo falls
   * back to the platform-scoped GITHUB integration, and finally to the legacy
   * SSH key path.
   */
  githubIntegrationId: string | null;
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
  plan: ResolutionPlan | null;
  planRevision: number;
  planFeedback: string | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  approvedByOperatorId: string | null;
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
