import { describe, expect, it } from 'vitest';
import { OrchestratedV2BudgetConfigSchema } from '@bronco/shared-types';
import {
  evaluateSubTaskBudget,
  evaluateTicketBudget,
  detectArtifactReread,
  evaluateBatchFailureGuard,
  type BatchFailureGuardState,
  type SubTaskBudgetUsage,
} from './budget-thresholds.js';

const config = OrchestratedV2BudgetConfigSchema.parse({});

describe('evaluateSubTaskBudget', () => {
  const usage: SubTaskBudgetUsage = { tokensUsed: 0, iterationsUsed: 0, toolCallsUsed: 0 };

  it('returns OK below soft threshold on all axes', () => {
    expect(evaluateSubTaskBudget({ ...usage, tokensUsed: 25_000 }, config.subTask)).toBe('OK');
  });

  it('returns SOFT_NUDGE at 60% tokens', () => {
    expect(evaluateSubTaskBudget({ ...usage, tokensUsed: 30_000 }, config.subTask)).toBe('SOFT_NUDGE');
  });

  it('returns HARD_STOP at 85% tokens', () => {
    expect(evaluateSubTaskBudget({ ...usage, tokensUsed: 42_500 }, config.subTask)).toBe('HARD_STOP');
  });

  it('returns SOFT_NUDGE at 60% iterations even when tokens low', () => {
    expect(evaluateSubTaskBudget({ ...usage, iterationsUsed: 5 }, config.subTask)).toBe('SOFT_NUDGE');
  });

  it('returns HARD_STOP at 85% calls even when tokens and iterations low', () => {
    expect(evaluateSubTaskBudget({ ...usage, toolCallsUsed: 17 }, config.subTask)).toBe('HARD_STOP');
  });

  it('hardest of three axes wins (HARD beats SOFT)', () => {
    expect(evaluateSubTaskBudget({ tokensUsed: 30_000, iterationsUsed: 0, toolCallsUsed: 17 }, config.subTask)).toBe('HARD_STOP');
  });
});

describe('evaluateTicketBudget', () => {
  it('returns OK below 75%', () => {
    expect(evaluateTicketBudget(150_000, config.ticket)).toBe('OK');
  });

  it('returns OK just below 75% (boundary inclusivity check)', () => {
    expect(evaluateTicketBudget(224_999, config.ticket)).toBe('OK');
  });

  it('returns SOFT_NUDGE at 75%', () => {
    expect(evaluateTicketBudget(225_000, config.ticket)).toBe('SOFT_NUDGE');
  });

  it('returns HARD_STOP at 95%', () => {
    expect(evaluateTicketBudget(285_000, config.ticket)).toBe('HARD_STOP');
  });
});

describe('detectArtifactReread', () => {
  const fakeId = '11111111-1111-1111-1111-111111111111';

  it('returns false on first read of an artifact', () => {
    const counts = new Map<string, number>();
    expect(detectArtifactReread(counts, fakeId, 2)).toBe(false);
    expect(counts.get(fakeId)).toBe(1);
  });

  it('returns true on second read when threshold is 2 (fires AT threshold)', () => {
    const counts = new Map<string, number>([[fakeId, 1]]);
    expect(detectArtifactReread(counts, fakeId, 2)).toBe(true);
    expect(counts.get(fakeId)).toBe(2);
  });

  it('returns true on third read with threshold 3', () => {
    const counts = new Map<string, number>([[fakeId, 2]]);
    expect(detectArtifactReread(counts, fakeId, 3)).toBe(true);
  });

  it('separately tracks distinct artifactIds', () => {
    const otherId = '22222222-2222-2222-2222-222222222222';
    const counts = new Map<string, number>([[fakeId, 5]]);
    expect(detectArtifactReread(counts, otherId, 2)).toBe(false);
  });
});

describe('evaluateBatchFailureGuard', () => {
  const fresh = (): BatchFailureGuardState => ({
    cumulativeExhausted: 0,
    cumulativeTotal: 0,
    consecutiveBadBatches: 0,
  });

  const exhausted = { stopReason: 'BUDGET_EXHAUSTED' as const, updatedKdSections: [] };
  const finalized = { stopReason: 'FINALIZED' as const, updatedKdSections: ['evidence.foo'] };
  const exhaustedWithKd = { stopReason: 'BUDGET_EXHAUSTED' as const, updatedKdSections: ['evidence.foo'] };

  it('OK on first batch even if all exhausted (gives strategist a free first try)', () => {
    const state = fresh();
    expect(evaluateBatchFailureGuard(state, [exhausted, exhausted], config.strategistGuard, true)).toBe('OK');
  });

  it('SOFT_NUDGE on second batch when ≥50% exhausted with empty updatedKdSections', () => {
    const state = fresh();
    state.cumulativeTotal = 5;
    state.cumulativeExhausted = 2;
    expect(evaluateBatchFailureGuard(state, [exhausted, finalized, exhausted], config.strategistGuard, false)).toBe('SOFT_NUDGE');
  });

  it('OK when ≥50% exhausted but updatedKdSections non-empty (sub-tasks did some work)', () => {
    const state = fresh();
    state.cumulativeTotal = 5;
    state.cumulativeExhausted = 2;
    expect(evaluateBatchFailureGuard(state, [exhaustedWithKd, exhaustedWithKd, finalized], config.strategistGuard, false)).toBe('OK');
  });

  it('HARD_STOP when cumulative exhausted ratio crosses 50%', () => {
    const state = fresh();
    state.cumulativeTotal = 8;
    state.cumulativeExhausted = 4;
    expect(evaluateBatchFailureGuard(state, [exhausted, exhausted], config.strategistGuard, false)).toBe('HARD_STOP');
  });

  it('HARD_STOP after 2 consecutive bad batches (≥80% each)', () => {
    const state = fresh();
    state.consecutiveBadBatches = 1;
    state.cumulativeTotal = 5;
    state.cumulativeExhausted = 4;
    expect(evaluateBatchFailureGuard(state, [exhausted, exhausted, exhausted, exhausted, finalized], config.strategistGuard, false)).toBe('HARD_STOP');
  });
});
