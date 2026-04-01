/** Safety classification for AI-recommended actions. */
export const ActionSafetyLevel = {
  AUTO: 'auto',
  APPROVAL: 'approval',
} as const;
export type ActionSafetyLevel = (typeof ActionSafetyLevel)[keyof typeof ActionSafetyLevel];

/** Known action types that the AI recommendation engine can produce. */
export const RecommendationActionType = {
  ADD_COMMENT: 'add_comment',
  CHANGE_STATUS: 'change_status',
  CHANGE_PRIORITY: 'change_priority',
  CHANGE_CATEGORY: 'change_category',
  ASSIGN_OPERATOR: 'assign_operator',
  SEND_EMAIL: 'send_email',
  CREATE_ISSUE_JOB: 'create_issue_job',
  ESCALATE: 'escalate',
  CHECK_DATABASE_HEALTH: 'check_database_health',
} as const;
export type RecommendationActionType = (typeof RecommendationActionType)[keyof typeof RecommendationActionType];

/** Maps AI action names (from SUGGEST_NEXT_STEPS) to recommendation action types. */
export const AI_ACTION_TO_RECOMMENDATION: Record<string, RecommendationActionType> = {
  add_comment: RecommendationActionType.ADD_COMMENT,
  set_status: RecommendationActionType.CHANGE_STATUS,
  set_priority: RecommendationActionType.CHANGE_PRIORITY,
  set_category: RecommendationActionType.CHANGE_CATEGORY,
  assign_operator: RecommendationActionType.ASSIGN_OPERATOR,
  send_followup_email: RecommendationActionType.SEND_EMAIL,
  trigger_code_fix: RecommendationActionType.CREATE_ISSUE_JOB,
  escalate_deep_analysis: RecommendationActionType.ESCALATE,
  check_database_health: RecommendationActionType.CHECK_DATABASE_HEALTH,
};

/** Structure stored in AppSetting under key 'system-config-action-safety'. */
export interface ActionSafetyConfig {
  actions: Record<string, ActionSafetyLevel>;
}

/** Default action safety configuration. */
export const DEFAULT_ACTION_SAFETY_CONFIG: ActionSafetyConfig = {
  actions: {
    [RecommendationActionType.ADD_COMMENT]: ActionSafetyLevel.AUTO,
    [RecommendationActionType.CHANGE_STATUS]: ActionSafetyLevel.AUTO,
    [RecommendationActionType.CHANGE_PRIORITY]: ActionSafetyLevel.AUTO,
    [RecommendationActionType.CHANGE_CATEGORY]: ActionSafetyLevel.AUTO,
    [RecommendationActionType.ASSIGN_OPERATOR]: ActionSafetyLevel.AUTO,
    [RecommendationActionType.SEND_EMAIL]: ActionSafetyLevel.APPROVAL,
    [RecommendationActionType.CREATE_ISSUE_JOB]: ActionSafetyLevel.APPROVAL,
    [RecommendationActionType.ESCALATE]: ActionSafetyLevel.APPROVAL,
    [RecommendationActionType.CHECK_DATABASE_HEALTH]: ActionSafetyLevel.APPROVAL,
  },
};

/** Status of a pending action. */
export const PendingActionStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DISMISSED: 'dismissed',
} as const;
export type PendingActionStatus = (typeof PendingActionStatus)[keyof typeof PendingActionStatus];

/** A pending action waiting for operator approval. */
export interface PendingAction {
  id: string;
  ticketId: string;
  actionType: string;
  value: Record<string, unknown>;
  status: PendingActionStatus;
  source: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  createdAt: Date;
}
