export const WorkflowState = {
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  QUESTIONING: 'questioning',
  PLANNING: 'planning',
  AWAITING_APPROVAL: 'awaiting_approval',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
} as const;
export type WorkflowState = (typeof WorkflowState)[keyof typeof WorkflowState];
