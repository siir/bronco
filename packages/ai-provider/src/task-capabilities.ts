import { TaskType, CapabilityLevel } from '@bronco/shared-types';

/**
 * Maps each TaskType to its minimum required CapabilityLevel.
 * Used by the auto-routing system to select the best provider for a task.
 */
export const TASK_CAPABILITY_REQUIREMENTS: Record<string, string> = {
  // SIMPLE — smallest models (classification, tagging)
  [TaskType.TRIAGE]: CapabilityLevel.SIMPLE,
  [TaskType.CATEGORIZE]: CapabilityLevel.SIMPLE,

  // BASIC — small models (extraction, intent, log summarization)
  [TaskType.EXTRACT_FACTS]: CapabilityLevel.BASIC,
  [TaskType.CLASSIFY_INTENT]: CapabilityLevel.BASIC,
  [TaskType.SUMMARIZE_TICKET]: CapabilityLevel.BASIC,
  [TaskType.SUMMARIZE_LOGS]: CapabilityLevel.BASIC,
  [TaskType.GENERATE_TITLE]: CapabilityLevel.SIMPLE,
  [TaskType.CLASSIFY_EMAIL]: CapabilityLevel.SIMPLE,
  [TaskType.DETECT_TOOL_GAPS]: CapabilityLevel.BASIC,

  // STANDARD — mid-tier (drafting, analysis, summarization)
  [TaskType.SUMMARIZE]: CapabilityLevel.STANDARD,
  [TaskType.DRAFT_EMAIL]: CapabilityLevel.STANDARD,
  [TaskType.SUGGEST_NEXT_STEPS]: CapabilityLevel.STANDARD,
  [TaskType.ANALYZE_WORK_ITEM]: CapabilityLevel.STANDARD,
  [TaskType.DRAFT_COMMENT]: CapabilityLevel.STANDARD,
  [TaskType.GENERATE_RELEASE_NOTE]: CapabilityLevel.STANDARD,
  [TaskType.ANALYZE_TOOL_REQUESTS]: CapabilityLevel.STANDARD,

  // ADVANCED — large models (planning, SQL generation, code review)
  [TaskType.GENERATE_DEVOPS_PLAN]: CapabilityLevel.ADVANCED,
  [TaskType.ANALYZE_QUERY]: CapabilityLevel.ADVANCED,
  [TaskType.GENERATE_SQL]: CapabilityLevel.ADVANCED,
  [TaskType.REVIEW_CODE]: CapabilityLevel.ADVANCED,
  [TaskType.CHANGE_CODEBASE_SMALL]: CapabilityLevel.ADVANCED,

  // DEEP_ADVANCED — frontier models (architecture, deep analysis, large codebase changes)
  [TaskType.DEEP_ANALYSIS]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.BUG_ANALYSIS]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.ARCHITECTURE_REVIEW]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.SCHEMA_REVIEW]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.FEATURE_ANALYSIS]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.GENERATE_RESOLUTION_PLAN]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.RESOLVE_ISSUE]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.CHANGE_CODEBASE_LARGE]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.ANALYZE_TICKET_CLOSURE]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.ANALYZE_APP_HEALTH]: CapabilityLevel.DEEP_ADVANCED,
  [TaskType.EXTRACT_CLIENT_LEARNINGS]: CapabilityLevel.DEEP_ADVANCED,

  // Custom AI query (route step — default ADVANCED, overridable via taskTypeOverride)
  [TaskType.CUSTOM_AI_QUERY]: CapabilityLevel.ADVANCED,

  // Ticket routing tasks
  [TaskType.SUMMARIZE_ROUTE]: CapabilityLevel.STANDARD,
  [TaskType.SELECT_ROUTE]: CapabilityLevel.STANDARD,

};

/**
 * Ordered capability levels from lowest to highest.
 * Used for "at least this level" matching.
 */
export const CAPABILITY_LEVEL_ORDER: string[] = [
  CapabilityLevel.SIMPLE,
  CapabilityLevel.BASIC,
  CapabilityLevel.STANDARD,
  CapabilityLevel.ADVANCED,
  CapabilityLevel.DEEP_ADVANCED,
];

/**
 * Returns true if `providerLevel` is >= `requiredLevel`.
 */
export function meetsCapability(providerLevel: string, requiredLevel: string): boolean {
  const providerIdx = CAPABILITY_LEVEL_ORDER.indexOf(providerLevel);
  const requiredIdx = CAPABILITY_LEVEL_ORDER.indexOf(requiredLevel);
  if (providerIdx === -1 || requiredIdx === -1) return false;
  return providerIdx >= requiredIdx;
}
