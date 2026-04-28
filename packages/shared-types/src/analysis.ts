import { z } from 'zod';

/**
 * Runtime-configurable budget limits for orchestrated-v2 analysis.
 * Stored as the value of the `orchestrated-v2-budget-config` AppSetting.
 * See docs/superpowers/specs/2026-04-28-orchestrated-v2-budget-bounds-design.md
 *
 * Defaults match the hard-coded constants in orchestrated-v2.ts as of pre-#470 fix.
 */
export const OrchestratedV2BudgetConfigSchema = z
  .object({
    subTask: z.object({
      iterationCap: z.number().int().min(1).max(50).default(8),
      tokenBudget: z.number().int().min(5_000).max(500_000).default(50_000),
      callBudget: z.number().int().min(1).max(100).default(20),
      softNudgeRatio: z.number().min(0.1).max(0.99).default(0.6),
      hardStopRatio: z.number().min(0.1).max(0.99).default(0.85),
    }).default({}),
    ticket: z.object({
      totalTokenBudget: z.number().int().min(50_000).max(5_000_000).default(300_000),
      softNudgeRatio: z.number().min(0.1).max(0.99).default(0.75),
      hardStopRatio: z.number().min(0.1).max(0.99).default(0.95),
    }).default({}),
    strategistGuard: z.object({
      softNudgeBatchExhaustedRatio: z.number().min(0.1).max(0.99).default(0.5),
      hardStopCumulativeExhaustedRatio: z.number().min(0.1).max(0.99).default(0.5),
      hardStopConsecutiveBatchesRatio: z.number().min(0.1).max(0.99).default(0.8),
    }).default({}),
    subTaskReReadDetector: z.object({
      warnAfterReadCount: z.number().int().min(2).max(20).default(2),
    }).default({}),
  })
  .default({})
  .refine(
    (cfg) => cfg.subTask.softNudgeRatio < cfg.subTask.hardStopRatio,
    { message: 'subTask.softNudgeRatio must be less than subTask.hardStopRatio' },
  )
  .refine(
    (cfg) => cfg.ticket.softNudgeRatio < cfg.ticket.hardStopRatio,
    { message: 'ticket.softNudgeRatio must be less than ticket.hardStopRatio' },
  );

export type OrchestratedV2BudgetConfig = z.output<typeof OrchestratedV2BudgetConfigSchema>;
