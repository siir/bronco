import type { OrchestratedV2BudgetConfig } from '@bronco/shared-types';

export type ThresholdVerdict = 'OK' | 'SOFT_NUDGE' | 'HARD_STOP';

export interface SubTaskBudgetUsage {
  tokensUsed: number;
  iterationsUsed: number;
  toolCallsUsed: number;
}

/**
 * Evaluate sub-task budget consumption across three axes (tokens, iterations,
 * tool calls). Returns the WORST (most-restrictive) verdict — if tokens are at
 * 60% but tool calls are at 85%, returns HARD_STOP.
 */
export function evaluateSubTaskBudget(
  usage: SubTaskBudgetUsage,
  config: OrchestratedV2BudgetConfig['subTask'],
): ThresholdVerdict {
  const tokenRatio = usage.tokensUsed / config.tokenBudget;
  const iterRatio = usage.iterationsUsed / config.iterationCap;
  const callRatio = usage.toolCallsUsed / config.callBudget;
  const worst = Math.max(tokenRatio, iterRatio, callRatio);

  if (worst >= config.hardStopRatio) return 'HARD_STOP';
  if (worst >= config.softNudgeRatio) return 'SOFT_NUDGE';
  return 'OK';
}

/**
 * Evaluate ticket-level total token consumption against the configured budget.
 */
export function evaluateTicketBudget(
  totalTokensConsumed: number,
  config: OrchestratedV2BudgetConfig['ticket'],
): ThresholdVerdict {
  const ratio = totalTokensConsumed / config.totalTokenBudget;
  if (ratio >= config.hardStopRatio) return 'HARD_STOP';
  if (ratio >= config.softNudgeRatio) return 'SOFT_NUDGE';
  return 'OK';
}

/**
 * Track repeated reads of the same artifact within a sub-task. Mutates `counts`
 * in place — caller owns the map for the duration of one sub-task. Fires (returns
 * true) the FIRST time the count reaches the warn threshold, so the caller can
 * append a single nudge to the next tool_result.
 *
 * After firing once for a given artifact, will continue to fire on every
 * subsequent read of the same artifact in this sub-task — caller decides
 * whether to repeat the nudge or suppress.
 */
export function detectArtifactReread(
  counts: Map<string, number>,
  artifactId: string,
  warnAfterReadCount: number,
): boolean {
  const next = (counts.get(artifactId) ?? 0) + 1;
  counts.set(artifactId, next);
  return next >= warnAfterReadCount;
}

export interface BatchFailureGuardState {
  cumulativeExhausted: number;
  cumulativeTotal: number;
  consecutiveBadBatches: number;
}

export interface BatchResultSummary {
  stopReason: string;
  updatedKdSections: string[];
}

/**
 * Evaluate a freshly-completed dispatch_subtasks batch against the cumulative
 * guard state and the per-batch failure ratio. Mutates `state` in place to
 * accumulate metrics for the next call.
 *
 * `isFirstBatch` is true on the first dispatch in the run (cumulativeTotal == 0
 * before this batch) — gives the strategist a free first try without firing
 * the guard, since first-batch failures may reflect bad initial sub-task design
 * rather than a death spiral.
 */
export function evaluateBatchFailureGuard(
  state: BatchFailureGuardState,
  batchResults: BatchResultSummary[],
  config: OrchestratedV2BudgetConfig['strategistGuard'],
  isFirstBatch: boolean,
): ThresholdVerdict {
  const batchSize = batchResults.length;
  if (batchSize === 0) return 'OK';

  const batchExhausted = batchResults.filter(r => r.stopReason === 'BUDGET_EXHAUSTED').length;
  const batchExhaustedWithoutKd = batchResults.filter(
    r => r.stopReason === 'BUDGET_EXHAUSTED' && r.updatedKdSections.length === 0,
  ).length;
  const batchExhaustedRatio = batchExhausted / batchSize;
  const batchExhaustedWithoutKdRatio = batchExhaustedWithoutKd / batchSize;

  // Update cumulative metrics
  state.cumulativeExhausted += batchExhausted;
  state.cumulativeTotal += batchSize;

  // Track consecutive-bad-batches for HARD_STOP rule 2
  if (batchExhaustedRatio >= config.hardStopConsecutiveBatchesRatio) {
    state.consecutiveBadBatches += 1;
  } else {
    state.consecutiveBadBatches = 0;
  }

  // Free first batch
  if (isFirstBatch) return 'OK';

  // HARD_STOP rule 1: cumulative exhausted ratio crosses threshold.
  // Strictly `>` (not `>=`): when softNudgeBatchExhaustedRatio and
  // hardStopCumulativeExhaustedRatio are equal (e.g. both 0.5 by default),
  // the boundary value belongs to SOFT_NUDGE so the nudge always fires at
  // least once before the hard stop. Reverting this to `>=` will silently
  // break the SOFT_NUDGE-at-50% test in budget-thresholds.test.ts.
  if (state.cumulativeTotal > 0
    && state.cumulativeExhausted / state.cumulativeTotal > config.hardStopCumulativeExhaustedRatio) {
    return 'HARD_STOP';
  }

  // HARD_STOP rule 2: N consecutive bad batches (≥80% exhausted each)
  // N is implicit — fires once consecutiveBadBatches >= 2
  if (state.consecutiveBadBatches >= 2) {
    return 'HARD_STOP';
  }

  // SOFT_NUDGE: this batch was bad (≥50% exhausted with empty updatedKdSections)
  if (batchExhaustedWithoutKdRatio >= config.softNudgeBatchExhaustedRatio) {
    return 'SOFT_NUDGE';
  }

  return 'OK';
}
