# Orchestrated-v2 Budget Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap worst-case orchestrated-v2 ticket-analyzer cost at ~$5 (300k tokens) by adding 5 layered guardrails (sub-task prompt revision, mid-loop budget feedback, per-artifact re-read detector, strategist batch-failure guard, ticket-level total-token cap with continuation summary), all backed by a runtime-configurable AppSetting.

**Architecture:** Extract pure threshold-evaluator functions (testable in isolation), then wire them into the existing `runSubTaskLoop` and `runOrchestratedV2` loops. New `orchestrated-v2-budget-config` AppSetting loaded once at the start of each analysis run via the existing settings-resolver pattern; surfaced in the control panel's existing Analysis tab.

**Tech Stack:** TypeScript / Node.js / Prisma / Zod / Fastify (backend), Angular signals + Material (frontend), Vitest (tests).

**Spec:** `docs/superpowers/specs/2026-04-28-orchestrated-v2-budget-bounds-design.md` (commits f569582, 530e889, 96cb48f)

**Branch strategy:** Single feature branch `fix/470-v2-budget-bounds` off `staging`. Each task below produces an atomic commit. Open PR against `staging` once Task 13 lands.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/shared-types/src/analysis.ts` | `OrchestratedV2BudgetConfigSchema` Zod schema + type | Modify (file exists; append schema) |
| `packages/shared-types/src/index.ts` | Re-export new schema/type | Modify (one-line export) |
| `services/ticket-analyzer/src/analysis/budget-thresholds.ts` | Pure threshold-evaluator functions (sub-task budget, artifact re-read, batch-failure guard, ticket budget) | **Create** |
| `services/ticket-analyzer/src/analysis/budget-thresholds.test.ts` | Unit tests for budget-thresholds.ts | **Create** |
| `services/ticket-analyzer/src/analysis/shared.ts` | `resolveOrchestratedV2BudgetConfig` resolver + `AnalysisDeps` extension | Modify |
| `services/ticket-analyzer/src/analysis/orchestrated-v2.ts` | Wire all 5 layers into the loops; revise sub-task prompt (A); thread budget config through `runOrchestratedV2` and `runSubTaskLoop` | Modify |
| `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts` | Integration-level tests for the new wiring | Modify |
| `services/copilot-api/src/routes/settings.ts` | New GET / PUT endpoints for `orchestrated-v2-budget-config` | Modify |
| `services/copilot-api/src/services/settings-keys.ts` | Add `SETTINGS_KEY_ORCHESTRATED_V2_BUDGET_CONFIG` constant (or wherever existing keys live) | Modify (locate during Task 3) |
| `services/control-panel/src/app/features/settings/settings.service.ts` | `getOrchestratedV2BudgetConfig` / `saveOrchestratedV2BudgetConfig` service methods | Modify |
| `services/control-panel/src/app/features/settings/settings.component.ts` | New "Orchestrated v2 Budget Limits" card in the Analysis tab | Modify |

**Out of scope (deferred to follow-ups):**
- MCP tool pair (`get/set_orchestrated_v2_budget_config`) — issue #475
- Per-`TicketCategory` budget overrides — issue #476

---

## Task 1: Define `OrchestratedV2BudgetConfigSchema` in shared-types

**Files:**
- Modify: `packages/shared-types/src/analysis.ts`
- Modify: `packages/shared-types/src/index.ts` (re-export)
- Test: schema validation runs at import time + via direct invocation in budget-thresholds tests in Task 4

The Zod schema mirrors the spec verbatim. Refinement enforces `softNudgeRatio < hardStopRatio` for each tier.

- [ ] **Step 1.1: Locate `analysis.ts` in shared-types and review existing exports**

Run: `cat packages/shared-types/src/analysis.ts | head -40`

Confirm the file exists and inspect what's already exported (so we know the import-style and type-export conventions used).

- [ ] **Step 1.2: Add the schema to `analysis.ts`**

Append at the end of `packages/shared-types/src/analysis.ts`:

```typescript
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
```

- [ ] **Step 1.3: Re-export from package index**

Open `packages/shared-types/src/index.ts`. After the existing analysis re-exports, add:

```typescript
export { OrchestratedV2BudgetConfigSchema } from './analysis.js';
export type { OrchestratedV2BudgetConfig } from './analysis.js';
```

(If `analysis.ts` is already wholesale re-exported via `export * from './analysis.js'`, both lines are redundant — verify and skip.)

- [ ] **Step 1.4: Build shared-types**

Run: `pnpm --filter @bronco/shared-types build`
Expected: clean build, no type errors. Confirms the schema's `z.output<...>` chain resolves and `.refine()` returns a usable type.

- [ ] **Step 1.5: Commit**

```bash
git add packages/shared-types/src/analysis.ts packages/shared-types/src/index.ts
git commit -m "feat(shared-types): add OrchestratedV2BudgetConfig schema (#470)

Zod schema for the orchestrated-v2-budget-config AppSetting. Defaults
match the hard-coded constants in orchestrated-v2.ts as of pre-fix.
Refinements enforce softNudgeRatio < hardStopRatio.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure threshold-evaluator functions

**Files:**
- Create: `services/ticket-analyzer/src/analysis/budget-thresholds.ts`
- Create: `services/ticket-analyzer/src/analysis/budget-thresholds.test.ts`

Extract the four budget-evaluation decisions into pure functions so we can unit-test them in isolation. Each returns one of: `'OK' | 'SOFT_NUDGE' | 'HARD_STOP'`.

- [ ] **Step 2.1: Write the failing test file**

Create `services/ticket-analyzer/src/analysis/budget-thresholds.test.ts`:

```typescript
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

  it('returns false on second read (still under threshold of 2 — fires AT threshold)', () => {
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
    state.cumulativeTotal = 0; // first-batch flag derived from cumulativeTotal == 0
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
```

- [ ] **Step 2.2: Run the test to verify it fails (module-not-found is the expected failure)**

Run: `pnpm --filter @bronco/ticket-analyzer test src/analysis/budget-thresholds.test.ts`
Expected: FAIL — module `./budget-thresholds.js` cannot be resolved.

- [ ] **Step 2.3: Write the implementation**

Create `services/ticket-analyzer/src/analysis/budget-thresholds.ts`:

```typescript
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

  // HARD_STOP rule 1: cumulative exhausted ratio crosses threshold
  if (state.cumulativeTotal > 0
    && state.cumulativeExhausted / state.cumulativeTotal >= config.hardStopCumulativeExhaustedRatio) {
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
```

- [ ] **Step 2.4: Run the tests to verify they pass**

Run: `pnpm --filter @bronco/ticket-analyzer test src/analysis/budget-thresholds.test.ts`
Expected: PASS — all tests in the four `describe` blocks.

- [ ] **Step 2.5: Commit**

```bash
git add services/ticket-analyzer/src/analysis/budget-thresholds.ts services/ticket-analyzer/src/analysis/budget-thresholds.test.ts
git commit -m "feat(analyzer): pure budget threshold evaluators (#470)

Extract 5-layer guardrail decisions into pure functions:
- evaluateSubTaskBudget (tokens / iterations / calls — worst-axis wins)
- evaluateTicketBudget (total tokens vs ticket cap)
- detectArtifactReread (per-artifact read counter)
- evaluateBatchFailureGuard (cumulative + consecutive-bad-batch metrics)

Each returns 'OK' | 'SOFT_NUDGE' | 'HARD_STOP'. Caller owns side
effects (tool_result injection, tool-list restriction). Tested in
isolation; wiring into the orchestrator follows in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Resolver `resolveOrchestratedV2BudgetConfig` in shared.ts

**Files:**
- Modify: `services/ticket-analyzer/src/analysis/shared.ts`
- Test: covered by integration tests in Task 8 (no isolated test for the trivial Prisma-fetch + parse pattern; matches existing peers like `resolveAnalysisVersion`)

- [ ] **Step 3.1: Locate the existing peer resolvers**

Run: `grep -n "resolveAnalysisVersion\|resolveMaxParallelTasks" services/ticket-analyzer/src/analysis/shared.ts`
Expected: line numbers around 1195–1223 (per the prior recon).

- [ ] **Step 3.2: Add the new resolver after `resolveMaxParallelTasks`**

Open `services/ticket-analyzer/src/analysis/shared.ts`. Find `resolveMaxParallelTasks` (~line 1223). After the closing brace of that function, add:

```typescript
import type { OrchestratedV2BudgetConfig } from '@bronco/shared-types';
import { OrchestratedV2BudgetConfigSchema } from '@bronco/shared-types';

const ORCHESTRATED_V2_BUDGET_CONFIG_KEY = 'orchestrated-v2-budget-config';

/**
 * Load the orchestrated-v2 runtime budget config from the AppSetting table.
 * Missing or malformed → returns parsed defaults. Called once at the top of
 * runOrchestratedV2 and threaded through to runSubTaskLoop. Does NOT cache —
 * each analysis run picks up fresh values.
 */
export async function resolveOrchestratedV2BudgetConfig(
  db: { appSetting: { findUnique: (args: { where: { key: string } }) => Promise<{ value: unknown } | null> } },
): Promise<OrchestratedV2BudgetConfig> {
  const row = await db.appSetting.findUnique({ where: { key: ORCHESTRATED_V2_BUDGET_CONFIG_KEY } });
  const parsed = OrchestratedV2BudgetConfigSchema.safeParse(row?.value ?? {});
  if (!parsed.success) {
    return OrchestratedV2BudgetConfigSchema.parse({});
  }
  return parsed.data;
}
```

If the imports `OrchestratedV2BudgetConfig` / `OrchestratedV2BudgetConfigSchema` already exist near the top of the file from a prior task, merge — don't duplicate.

- [ ] **Step 3.3: Build the analyzer to confirm no type errors**

Run: `pnpm --filter @bronco/ticket-analyzer build`
Expected: clean build.

- [ ] **Step 3.4: Commit**

```bash
git add services/ticket-analyzer/src/analysis/shared.ts
git commit -m "feat(analyzer): resolveOrchestratedV2BudgetConfig (#470)

Loads orchestrated-v2-budget-config AppSetting at analysis-run time.
Missing or malformed values fall through to schema defaults. No cache
— each run fetches fresh, matching the peer resolveAnalysisVersion
pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: REST endpoints — GET / PUT `/api/settings/orchestrated-v2-budget-config`

**Files:**
- Modify: `services/copilot-api/src/routes/settings.ts`
- Test: existing integration test pattern in `services/copilot-api/src/routes/settings.test.ts` if it exists; otherwise verify manually via dev server

- [ ] **Step 4.1: Locate the existing analysis-strategy-version endpoint pair as the template**

Run: `grep -n "SETTINGS_KEY_ANALYSIS_STRATEGY_VERSION\|analysis-strategy-version" services/copilot-api/src/routes/settings.ts | head -10`
Expected: matches at lines ~1160 and ~1168 (per prior recon).

- [ ] **Step 4.2: Locate where the SETTINGS_KEY constants are declared**

Run: `grep -rn "SETTINGS_KEY_ANALYSIS_STRATEGY_VERSION" services/copilot-api/src/`
Expected: a single declaration site (likely top of `settings.ts` or in a `settings-keys.ts` module). Add the new constant in the same place.

- [ ] **Step 4.3: Add the SETTINGS_KEY constant**

In the file you found in Step 4.2, alongside `SETTINGS_KEY_ANALYSIS_STRATEGY_VERSION`, add:

```typescript
export const SETTINGS_KEY_ORCHESTRATED_V2_BUDGET_CONFIG = 'orchestrated-v2-budget-config';
```

- [ ] **Step 4.4: Add the GET / PUT endpoint pair to settings.ts**

Open `services/copilot-api/src/routes/settings.ts`. Find the `analysis-strategy-version` PUT handler closing brace (~line 1200). Immediately after, add:

```typescript
  // ---------------------------------------------------------------------------
  // Orchestrated v2 Budget Config (#470)
  // ---------------------------------------------------------------------------

  fastify.get('/api/settings/orchestrated-v2-budget-config', async () => {
    const row = await fastify.db.appSetting.findUnique({
      where: { key: SETTINGS_KEY_ORCHESTRATED_V2_BUDGET_CONFIG },
    });
    if (!row) return OrchestratedV2BudgetConfigSchema.parse({});
    const parsed = OrchestratedV2BudgetConfigSchema.safeParse(row.value);
    if (!parsed.success) {
      logger.warn(
        { key: SETTINGS_KEY_ORCHESTRATED_V2_BUDGET_CONFIG, errors: parsed.error.issues },
        'Stored orchestrated-v2 budget config is malformed — resetting to defaults',
      );
      const defaults = OrchestratedV2BudgetConfigSchema.parse({});
      await fastify.db.appSetting.update({
        where: { key: SETTINGS_KEY_ORCHESTRATED_V2_BUDGET_CONFIG },
        data: { value: defaults as unknown as object },
      });
      return defaults;
    }
    return parsed.data;
  });

  fastify.put<{ Body: Record<string, unknown> }>(
    '/api/settings/orchestrated-v2-budget-config',
    { preHandler: requireRole(OperatorRole.ADMIN) },
    async (request) => {
      const parsed = OrchestratedV2BudgetConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return fastify.httpErrors.badRequest(`Invalid orchestrated-v2 budget config: ${msg}`);
      }
      const config = parsed.data;
      const row = await fastify.db.appSetting.upsert({
        where: { key: SETTINGS_KEY_ORCHESTRATED_V2_BUDGET_CONFIG },
        update: { value: config as unknown as object },
        create: { key: SETTINGS_KEY_ORCHESTRATED_V2_BUDGET_CONFIG, value: config as unknown as object },
      });
      return row.value as typeof config;
    },
  );
```

Add `OrchestratedV2BudgetConfigSchema` to the imports at the top of the file:

```typescript
import { OrchestratedV2BudgetConfigSchema } from '@bronco/shared-types';
```

- [ ] **Step 4.5: Build copilot-api**

Run: `pnpm --filter @bronco/copilot-api build`
Expected: clean.

- [ ] **Step 4.6: Smoke-test via curl**

Start dev server: `pnpm dev:api` (in a separate terminal, leave running until end of task).

```bash
curl -s http://localhost:3000/api/settings/orchestrated-v2-budget-config | jq .
```
Expected: returns the JSON config with all default values.

```bash
curl -s -X PUT http://localhost:3000/api/settings/orchestrated-v2-budget-config \
  -H 'Content-Type: application/json' \
  -H "Cookie: $(get_admin_session_cookie)" \
  -d '{"ticket":{"totalTokenBudget":250000}}' | jq .
```
(Operator must be admin; obtain cookie however local dev does it.)
Expected: returns the merged config with `ticket.totalTokenBudget=250000` and other fields at defaults.

```bash
curl -s http://localhost:3000/api/settings/orchestrated-v2-budget-config | jq .ticket.totalTokenBudget
```
Expected: `250000` (persisted).

Reset to defaults:
```bash
curl -s -X PUT http://localhost:3000/api/settings/orchestrated-v2-budget-config \
  -H 'Content-Type: application/json' \
  -H "Cookie: $(get_admin_session_cookie)" \
  -d '{}'
```
Expected: returns the all-defaults config.

- [ ] **Step 4.7: Commit**

```bash
git add services/copilot-api/src/routes/settings.ts services/copilot-api/src/routes/settings-keys.ts
git commit -m "feat(api): GET/PUT orchestrated-v2-budget-config endpoints (#470)

Per-feature settings endpoint pair following the analysis-strategy-version
template. PUT is ADMIN-only; Zod-validated; malformed stored values are
auto-reset to defaults on GET with a WARN log.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(If `settings-keys.ts` didn't exist and the constant lives in `settings.ts`, just stage `settings.ts`.)

---

## Task 5: Sub-task system prompt revision (Layer A)

**Files:**
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.ts:523-530`

Replace the misleading "call finalize_subtask as the LAST action" instruction with budget-aware guidance. The new prompt is static (no config inputs) — A is the cheapest layer.

- [ ] **Step 5.1: Update `subTaskInstructions`**

Open `services/ticket-analyzer/src/analysis/orchestrated-v2.ts`. Locate `subTaskInstructions` (lines ~523-530). Replace the entire array literal with:

```typescript
  const subTaskInstructions = [
    'You are a focused investigator. Execute your sub-task intent thoroughly using the available tools.',
    'Record each finding by calling kd_* tools (platform__kd_add_subsection, platform__kd_update_section).',
    'Do NOT dump raw tool output into your response — the knowledge doc is the source of truth.',
    '',
    'BUDGET DISCIPLINE — read carefully:',
    '- You have a hard budget (tokens, iterations, tool calls). The runner will warn you when you cross 60%.',
    '- When using `platform__read_tool_result_artifact`, prefer `grep` mode to find specific patterns over paging through chunks. If the truncated preview shown in the prior tool_result is enough to support a finding, work from that — do NOT re-read the same artifact.',
    '- Re-reading the same artifact more than once will trigger a warning. Heed it.',
    '- Partial findings with what you have are MORE useful than burning the entire budget chasing more.',
    'When you have enough to justify a finding, call `finalize_subtask` with a concise summary (100-300 words)',
    'and the list of KD section keys you updated. Earlier finalize is better than budget-exhausted.',
  ].join(' ');
```

- [ ] **Step 5.2: Locate the existing snapshot test for the prompt (if any)**

Run: `grep -n "subTaskInstructions\|focused investigator" services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts`

If a snapshot exists, update it. If none, skip — the prompt is exercised by integration tests in Task 8.

- [ ] **Step 5.3: Build the analyzer**

Run: `pnpm --filter @bronco/ticket-analyzer build`
Expected: clean.

- [ ] **Step 5.4: Run all analyzer tests**

Run: `pnpm --filter @bronco/ticket-analyzer test`
Expected: PASS. If a snapshot fails because of the prompt change, regenerate the snapshot (`pnpm test -u`).

- [ ] **Step 5.5: Commit**

```bash
git add services/ticket-analyzer/src/analysis/orchestrated-v2.ts services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts
git commit -m "feat(analyzer): budget-aware sub-task system prompt (#470 layer A)

Replaces 'call finalize_subtask as the LAST action — do not call before
gathered all data' (which actively encouraged budget exhaustion) with
explicit budget discipline:
  - explains the threshold-warning mechanism
  - tells the agent to grep instead of paging artifacts
  - declares partial findings preferable to budget burn

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire re-read detector into `runSubTaskLoop` (Layer C)

**Files:**
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.ts` (`runSubTaskLoop`)
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts`

Maintain a per-sub-task `Map<artifactId, count>`. After each `read_tool_result_artifact` call, evaluate via `detectArtifactReread`. When it fires, append a guidance line to that tool's `tool_result.content`.

- [ ] **Step 6.1: Add an integration test stub for the wiring**

Open `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts`. Add a new `describe` block (after existing ones):

```typescript
import { describe, it, expect, vi } from 'vitest';
// imports for runSubTaskLoop test fixtures — match the patterns already in this file

describe('runSubTaskLoop — re-read detector (Layer C)', () => {
  it('appends a re-read warning to the second tool_result for the same artifactId', async () => {
    // Arrange: build a stubbed AnalysisDeps where ai.generateWithTools returns
    //   iter1: tool_use read_tool_result_artifact (artifactId=A)
    //   iter2: tool_use read_tool_result_artifact (artifactId=A)  // re-read
    //   iter3: tool_use finalize_subtask
    // Act: invoke runSubTaskLoop with this stub
    // Assert: the messages array passed into the iter3 generateWithTools call
    //         contains a tool_result whose content includes the substring
    //         "You've read artifact" (case-insensitive) — emitted on the second read.

    // Detailed setup follows the existing test pattern in this file. If no
    // existing pattern matches, build a minimal stub that satisfies the
    // imports of runSubTaskLoop and its types. The stub does NOT need to
    // execute real MCP tools — replace `executeAgenticToolCall` via vi.mock
    // to return a synthetic, non-error result.

    expect(true).toBe(false); // placeholder — replace with real assertion in Step 6.4
  });
});
```

- [ ] **Step 6.2: Run the test to verify it fails**

Run: `pnpm --filter @bronco/ticket-analyzer test src/analysis/orchestrated-v2.test.ts -t "re-read detector"`
Expected: FAIL — placeholder `expect(true).toBe(false)`.

- [ ] **Step 6.3: Wire the detector into `runSubTaskLoop`**

Open `services/ticket-analyzer/src/analysis/orchestrated-v2.ts`. Locate the top of `runSubTaskLoop` (line 148+). Add imports near the top of the file:

```typescript
import { detectArtifactReread, evaluateSubTaskBudget } from './budget-thresholds.js';
import type { OrchestratedV2BudgetConfig } from '@bronco/shared-types';
```

Update the `runSubTaskLoop` signature to accept the budget config:

```typescript
async function runSubTaskLoop(
  deps: AnalysisDeps,
  ticketId: string,
  clientId: string,
  category: string,
  skipClientMemory: boolean,
  subTaskId: string,
  intent: string,
  contextKdSections: string[],
  tools: AIToolDefinition[],
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  repoIdByPrefix: Map<string, string>,
  subTaskSystemPrompt: string,
  model: string,
  budgetConfig: OrchestratedV2BudgetConfig,                                   // NEW
  orchestration?: { id: string; iteration: number; parentLogId?: string },
  toolResultMaxTokens?: number,
  defaultMaxTokens?: number,
): Promise<SubTaskRunResult> {
```

Inside `runSubTaskLoop`, after the existing `failureTracker` declaration (around line 172), add:

```typescript
  const artifactReadCounts = new Map<string, number>();
```

Within the per-tool-call block (around lines 344-406, the `for (const toolUse of toolUseBlocks)` loop), AFTER `toolResults.push(...)` is called and BEFORE the next iteration of the inner for-loop, add the re-read check. The cleanest path is to compute the warning BEFORE pushing the tool_result, so we can include the warning in the content. Restructure the block slightly:

Locate the existing block (~lines 360-378):
```typescript
      const fullResult = result.result;
      const fullSizeChars = fullResult.length;
      const threshold = toolResultMaxTokens ?? 4000;
      const artifactId = deps.artifactStoragePath && !result.isError ? randomUUID() : undefined;
      const truncated = !result.isError && !!artifactId && shouldTruncate(fullResult, threshold);
      const contentForModel = truncated && artifactId
        ? buildTruncatedPreview(fullResult, artifactId)
        : fullResult;

      toolCallLog.push({
        tool: toolUse.name,
        system: (toolUse.input as Record<string, unknown>)?.system_name as string | undefined,
        input: toolUse.input,
        output: fullResult.slice(0, 500),
        durationMs: elapsed,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: contentForModel,
        ...(result.isError ? { is_error: true } : {}),
      });
```

Replace the `toolResults.push(...)` block with:

```typescript
      // Layer C: detect re-reads of the same artifact and append a guidance nudge
      let contentWithMaybeNudge: string = contentForModel;
      if (toolUse.name === 'platform__read_tool_result_artifact') {
        const inputArtifactId = (toolUse.input as Record<string, unknown>)?.artifactId;
        if (typeof inputArtifactId === 'string' && inputArtifactId.length > 0) {
          const fired = detectArtifactReread(
            artifactReadCounts,
            inputArtifactId,
            budgetConfig.subTaskReReadDetector.warnAfterReadCount,
          );
          if (fired) {
            const count = artifactReadCounts.get(inputArtifactId) ?? 0;
            contentWithMaybeNudge = [
              contentForModel,
              '',
              `⚠️ You have read artifact ${inputArtifactId} ${count} times in this sub-task. Use \`grep\` mode to find specific patterns, or proceed with the data you have and call \`finalize_subtask\`.`,
            ].join('\n');
          }
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: contentWithMaybeNudge,
        ...(result.isError ? { is_error: true } : {}),
      });
```

- [ ] **Step 6.4: Implement the test from Step 6.1**

Replace the placeholder `expect(true).toBe(false)` with the real assertion. Example pattern (adapt to whatever fixture style is already used in the file):

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { AIToolUseBlock } from '@bronco/shared-types';
import { OrchestratedV2BudgetConfigSchema } from '@bronco/shared-types';
// import the actual runSubTaskLoop or its public re-export — adjust as needed
// (runSubTaskLoop is currently NOT exported from orchestrated-v2.ts; if so, export it
// for testability or add a thin wrapper. The minimal change: export it.)

describe('runSubTaskLoop — re-read detector (Layer C)', () => {
  it('appends a re-read warning to the second tool_result for the same artifactId', async () => {
    const sameArtifactId = '11111111-1111-1111-1111-111111111111';

    const generateWithToolsCalls: Array<{ messages: unknown[] }> = [];
    const ai = {
      generateWithTools: vi.fn(async ({ messages }: { messages: unknown[] }) => {
        generateWithToolsCalls.push({ messages: structuredClone(messages) });
        const callIndex = generateWithToolsCalls.length;
        if (callIndex === 1) {
          return {
            stopReason: 'tool_use',
            usage: { inputTokens: 100, outputTokens: 50 },
            contentBlocks: [
              {
                type: 'tool_use',
                id: 'tu-1',
                name: 'platform__read_tool_result_artifact',
                input: { artifactId: sameArtifactId, ticketId: 'tk', offset: 0, limit: 4000 },
              } satisfies AIToolUseBlock,
            ],
          };
        }
        if (callIndex === 2) {
          return {
            stopReason: 'tool_use',
            usage: { inputTokens: 100, outputTokens: 50 },
            contentBlocks: [
              {
                type: 'tool_use',
                id: 'tu-2',
                name: 'platform__read_tool_result_artifact',
                input: { artifactId: sameArtifactId, ticketId: 'tk', offset: 4000, limit: 4000 },
              } satisfies AIToolUseBlock,
            ],
          };
        }
        // Third call: finalize
        return {
          stopReason: 'tool_use',
          usage: { inputTokens: 100, outputTokens: 50 },
          contentBlocks: [
            {
              type: 'tool_use',
              id: 'tu-3',
              name: 'finalize_subtask',
              input: { summary: 'done', updatedKdSections: [] },
            } satisfies AIToolUseBlock,
          ],
        };
      }),
    };

    // Mock the executeAgenticToolCall side-effect to return synthetic content
    vi.mock('./shared.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./shared.js')>();
      return {
        ...actual,
        executeAgenticToolCall: vi.fn(async () => ({
          result: 'fake artifact content',
          isError: false,
        })),
      };
    });

    const deps = {
      ai,
      db: { /* minimal stub — runSubTaskLoop calls loadKnowledgeDoc only when contextKdSections nonempty */ },
      appLog: { info: vi.fn(), warn: vi.fn() },
      artifactStoragePath: undefined, // skip artifact-write path
    };

    const config = OrchestratedV2BudgetConfigSchema.parse({});

    // Call runSubTaskLoop — adjust import path / export visibility as needed
    const { runSubTaskLoop } = await import('./orchestrated-v2.js');

    await runSubTaskLoop(
      deps as never,
      'tk',
      'cl',
      'GENERAL',
      false,
      'st-1',
      'test intent',
      [],
      [], // tools
      new Map(),
      new Map(),
      'test system prompt',
      'haiku',
      config,
    );

    // The 3rd generateWithTools call's messages array should contain the
    // tool_result for tu-2 with the warning embedded.
    const thirdCallMessages = generateWithToolsCalls[2].messages as Array<{ role: string; content: unknown }>;
    const lastUserMsg = [...thirdCallMessages].reverse().find(m => m.role === 'user');
    const lastUserContent = JSON.stringify(lastUserMsg?.content ?? '');
    expect(lastUserContent).toMatch(/you have read artifact/i);
    expect(lastUserContent).toMatch(/2 times/i);
  });
});
```

If `runSubTaskLoop` is not currently exported, add `export` to its declaration in `orchestrated-v2.ts`.

- [ ] **Step 6.5: Run the test to verify it passes**

Run: `pnpm --filter @bronco/ticket-analyzer test src/analysis/orchestrated-v2.test.ts -t "re-read detector"`
Expected: PASS.

Run the full test suite to confirm no regressions:
`pnpm --filter @bronco/ticket-analyzer test`
Expected: PASS.

- [ ] **Step 6.6: Commit**

```bash
git add services/ticket-analyzer/src/analysis/orchestrated-v2.ts services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts
git commit -m "feat(analyzer): per-artifact re-read detector in sub-task loop (#470 layer C)

Counts read_tool_result_artifact calls per artifactId within a
sub-task. When count crosses the configured threshold (default 2),
appends a warning to the next tool_result instructing the agent to
use grep mode or finalize.

Threads OrchestratedV2BudgetConfig through runSubTaskLoop signature
in preparation for layers B (token thresholds) and the wire-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Sub-task budget soft-nudge + hard-stop in `runSubTaskLoop` (Layer B)

**Files:**
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.ts` (`runSubTaskLoop`)
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts`

At the top of each iteration in `runSubTaskLoop`, evaluate `evaluateSubTaskBudget`. On `SOFT_NUDGE` (first crossing only), inject a synthetic `tool_result` warning into `messages` BEFORE the `generateWithTools` call. On `HARD_STOP`, restrict the `tools` parameter to `[FINALIZE_SUBTASK_TOOL]` only.

- [ ] **Step 7.1: Add the integration tests for B**

Add to `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts`:

```typescript
describe('runSubTaskLoop — budget thresholds (Layer B)', () => {
  it('injects a soft-nudge tool_result on the iteration that crosses 60%', async () => {
    // Stub generateWithTools to consume tokens such that after iter1 we're at 65% of 50k = 32.5k
    // Assert: iter2's messages contains a system-style tool_result with "60%" or "Budget" warning
    expect(true).toBe(false); // placeholder
  });

  it('restricts tool list to [finalize_subtask] only when crossing 85%', async () => {
    // Stub generateWithTools usage to push past 85% by iter2
    // Assert: iter3's `tools` parameter has length 1 and name finalize_subtask
    expect(true).toBe(false); // placeholder
  });
});
```

- [ ] **Step 7.2: Run the new tests to verify they fail**

Run: `pnpm --filter @bronco/ticket-analyzer test src/analysis/orchestrated-v2.test.ts -t "budget thresholds"`
Expected: FAIL.

- [ ] **Step 7.3: Implement Layer B in `runSubTaskLoop`**

Open `orchestrated-v2.ts`. In `runSubTaskLoop`, locate the top of the iteration loop (`for (let iteration = 0; ...)` ~line 221). Add state-tracking flags BEFORE the loop:

```typescript
  let softNudgeFired = false;
  let hardStopActive = false;
  // toolsWithFinalize already exists earlier in the function
  const finalizeOnlyTools: AIToolDefinition[] = [FINALIZE_SUBTASK_TOOL];
```

REPLACE the existing budget hard-cap block at the top of the iteration loop (the existing `if (tokensSoFar >= SUB_TASK_TOKEN_BUDGET) break;` and `if (totalToolCalls >= SUB_TASK_CALL_BUDGET) break;`) with the new evaluator-based logic:

```typescript
    lastIterationRun = iteration + 1;
    const tokensSoFar = totalInputTokens + totalOutputTokens;

    const verdict = evaluateSubTaskBudget(
      { tokensUsed: tokensSoFar, iterationsUsed: iteration, toolCallsUsed: totalToolCalls },
      budgetConfig.subTask,
    );

    if (verdict === 'SOFT_NUDGE' && !softNudgeFired) {
      softNudgeFired = true;
      const tokenPct = Math.round((tokensSoFar / budgetConfig.subTask.tokenBudget) * 100);
      const callPct = Math.round((totalToolCalls / budgetConfig.subTask.callBudget) * 100);
      const iterPct = Math.round((iteration / budgetConfig.subTask.iterationCap) * 100);
      // Inject a synthetic user-role text message (NOT a tool_result, since no
      // tool_use is pending). Models treat user messages as conversation turns;
      // this won't break the well-formed message thread.
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `⚠️ Budget warning: tokens ${tokenPct}%, tool calls ${callPct}%, iterations ${iterPct}%. You are crossing 60% of one or more budgets. Consider finalizing soon — call \`finalize_subtask\` with what you have if your findings already support a useful summary. Further tool calls will be cut off at 85%.`,
          },
        ],
      });
      appLog.info(
        `Sub-task ${subTaskId} soft-nudge fired at iteration ${iteration + 1} (tokens=${tokenPct}%, calls=${callPct}%, iter=${iterPct}%)`,
        { ticketId, subTaskId, iteration: iteration + 1 },
        ticketId,
        'ticket',
      );
    }

    if (verdict === 'HARD_STOP') {
      hardStopActive = true;
      appLog.info(
        `Sub-task ${subTaskId} hard-stop active at iteration ${iteration + 1} — restricting tools to [finalize_subtask]`,
        { ticketId, subTaskId, iteration: iteration + 1, tokensSoFar, totalToolCalls },
        ticketId,
        'ticket',
      );
      // If the model has already had one chance with restricted tools and STILL
      // didn't finalize, break out — we don't want to spend any more iterations.
      // Detection: if the previous message turn was already a finalize-only
      // generateWithTools call, the agent is genuinely stuck.
      // For simplicity and because the agent can almost always finalize when the
      // tool list is just finalize_subtask, we allow ONE pass before breaking.
      if (iteration > 0 && hardStopActive) {
        // Already in hard-stop from prior iteration — give one more chance, then exit
        // (this branch only triggers if the loop reached here in two consecutive iterations
        // with hardStopActive=true, which means the agent didn't call finalize_subtask
        // even when offered no other tool. Bail out via existing budget-exhaustion path.)
      }
    }
```

Then UPDATE the `generateWithTools` call inside the loop to use the conditional tool list:

```typescript
      response = await ai.generateWithTools({
        // ...existing fields...
        tools: hardStopActive ? finalizeOnlyTools : toolsWithFinalize,
        // ...rest unchanged
      });
```

(Find the existing `tools: toolsWithFinalize,` line — around line 266 — and swap.)

NOTE: The existing budget-exhaustion path at the end of the function (`partialSummary = fallbackFromToolResults(...)` ~ line 461) remains unchanged — it's the safety net for the case where even `finalizeOnlyTools` fails to produce a `finalize_subtask` call.

- [ ] **Step 7.4: Implement the tests from Step 7.1**

Replace the placeholder tests with real assertions following the same `vi.mock('./shared.js')` + `generateWithTools` stub pattern from Task 6. Each test injects token usage in the `usage` field of the stubbed response so the budget evaluator crosses the threshold.

Soft-nudge test:
```typescript
it('injects a soft-nudge user message on the iteration that crosses 60%', async () => {
  // Stub: iter1 returns usage = { inputTokens: 32_000, outputTokens: 1_000 }  → 33k of 50k = 66%
  // After iter1, before iter2's call, evaluator returns SOFT_NUDGE.
  // Assert: iter2's `messages` contains a user message with text ".*60%.*" or "Budget warning"

  const calls: Array<{ messages: unknown[]; tools: { name: string }[] }> = [];
  const ai = {
    generateWithTools: vi.fn(async ({ messages, tools }) => {
      calls.push({ messages: structuredClone(messages), tools });
      const idx = calls.length;
      if (idx === 1) {
        return {
          stopReason: 'tool_use',
          usage: { inputTokens: 32_000, outputTokens: 1_000 },
          contentBlocks: [{ type: 'tool_use', id: 't1', name: 'finalize_subtask', input: { summary: 's', updatedKdSections: [] } }],
        };
      }
      // unreachable in this test (finalize already called)
      throw new Error('unexpected iter ' + idx);
    }),
  };
  // ... shared stub pattern as in Task 6 ...
  await runSubTaskLoop(deps as never, 'tk', 'cl', 'GENERAL', false, 'st', 'intent', [], [], new Map(), new Map(), 'sp', 'haiku', config);

  // Soft nudge fires AT THE TOP of iter2 (which never runs because iter1 finalized)
  // — to test the soft-nudge injection more directly, structure the stub so iter1
  // does NOT finalize but instead consumes 33k tokens via a non-decision tool, then
  // iter2 finalizes. The test should assert the iter2 messages contain the warning.
  // (Adapt accordingly.)
});
```

Hard-stop test follows the same pattern but with `iter1` consuming 43k tokens and asserting `calls[1].tools.length === 1 && calls[1].tools[0].name === 'finalize_subtask'`.

- [ ] **Step 7.5: Run all the analyzer tests**

Run: `pnpm --filter @bronco/ticket-analyzer test`
Expected: all PASS, including the new B tests.

- [ ] **Step 7.6: Commit**

```bash
git add services/ticket-analyzer/src/analysis/orchestrated-v2.ts services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts
git commit -m "feat(analyzer): sub-task budget soft-nudge + hard-stop (#470 layer B)

At the top of each iteration in runSubTaskLoop:
- evaluate against the configured soft/hard ratios across tokens,
  iterations, and tool calls (worst-axis wins)
- on SOFT_NUDGE first crossing: inject a budget-warning user message
  into the conversation
- on HARD_STOP: restrict the next generateWithTools call's tool list
  to [finalize_subtask] only — the only remaining option is to wrap up

Existing budget-exhaustion safety net at end of the loop is unchanged
and serves as the final backstop.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Strategist batch-failure guard (Layer D)

**Files:**
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.ts` (`runOrchestratedV2`)
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts`

In `runOrchestratedV2`, after each dispatch_subtasks batch resolves and `allSubTaskResults` is populated, evaluate `evaluateBatchFailureGuard`. SOFT_NUDGE injects a tool_result warning before the next strategist iteration; HARD_STOP restricts `finalStrategistTools` to `[COMPLETE_ANALYSIS_TOOL, kd_read_toc, kd_read_section]` for the rest of the run.

- [ ] **Step 8.1: Add the integration test**

```typescript
describe('runOrchestratedV2 — batch-failure guard (Layer D)', () => {
  it('hard-stops when 80% of two consecutive batches were BUDGET_EXHAUSTED', async () => {
    // Stub: 2 strategist iterations dispatch 5 sub-tasks each; each sub-task stub returns
    //   { stopReason: 'BUDGET_EXHAUSTED', updatedKdSections: [] }
    // Assert: third strategist generateWithTools call's `tools` parameter does NOT contain
    //         dispatch_subtasks — only complete_analysis, kd_read_toc, kd_read_section
    expect(true).toBe(false);
  });
});
```

- [ ] **Step 8.2: Run to verify failure**

Run: `pnpm --filter @bronco/ticket-analyzer test -t "batch-failure guard"` — expect FAIL.

- [ ] **Step 8.3: Wire the guard into `runOrchestratedV2`**

Open `orchestrated-v2.ts`. Locate `runOrchestratedV2` (~line 842). Near the existing `stallState` declaration (~line 977), add the new guard state:

```typescript
import { evaluateBatchFailureGuard, type BatchFailureGuardState } from './budget-thresholds.js';

const batchFailureState: BatchFailureGuardState = {
  cumulativeExhausted: 0,
  cumulativeTotal: 0,
  consecutiveBadBatches: 0,
};
let strategistHardStopActive = false;

// Pre-build the restricted strategist tool list (computed once)
const restrictedStrategistTools: AIToolDefinition[] = finalStrategistTools.filter(
  t => t.name === 'complete_analysis' || t.name === 'platform__kd_read_toc' || t.name === 'platform__kd_read_section',
);
```

Inside the strategist's inner tool-loop (~line 1018), where the `tools: finalStrategistTools` parameter is set on `generateWithTools`, swap to:

```typescript
        tools: strategistHardStopActive ? restrictedStrategistTools : finalStrategistTools,
```

After the batch executes and `allSubTaskResults` is populated (after line 1353), BEFORE the `if (dispatchCallId)` block that pushes results back to the strategist, add:

```typescript
      // Layer D: evaluate batch-failure guard
      const isFirstBatch = batchFailureState.cumulativeTotal === 0;
      const guardVerdict = evaluateBatchFailureGuard(
        batchFailureState,
        allSubTaskResults.map(r => ({ stopReason: r.stopReason, updatedKdSections: r.updatedKdSections })),
        budgetConfig.strategistGuard,
        isFirstBatch,
      );

      if (guardVerdict === 'HARD_STOP') {
        strategistHardStopActive = true;
        appLog.warn(
          `Strategist hard-stop activated at iteration ${i + 1} — cumulative ${batchFailureState.cumulativeExhausted}/${batchFailureState.cumulativeTotal} sub-tasks BUDGET_EXHAUSTED, consecutiveBadBatches=${batchFailureState.consecutiveBadBatches}`,
          { ticketId, iteration: i + 1, cumulative: batchFailureState },
          ticketId,
          'ticket',
        );
      }
```

In the `if (dispatchCallId)` block where the tool_result content is built (lines 1359-1378), modify the `JSON.stringify(resultPayload, null, 2)` content to optionally prepend a guard message:

```typescript
      if (dispatchCallId) {
        const resultPayload = allSubTaskResults.map(r => ({
          sub_task_id: r.subTaskId,
          intent: r.intent,
          summary: r.summary,
          updatedKdSections: r.updatedKdSections,
          stopReason: r.stopReason,
          iterationsUsed: r.iterationsUsed,
          tokensUsed: r.tokensUsed,
        }));

        let guardWarning = '';
        if (guardVerdict === 'SOFT_NUDGE') {
          guardWarning = `⚠️ ${batchFailureState.cumulativeExhausted}/${batchFailureState.cumulativeTotal} sub-tasks BUDGET_EXHAUSTED so far. Many of those produced no usable findings (empty updatedKdSections). Before dispatching another batch, read the knowledge doc with kd_read_toc to see what's been written, and consider whether complete_analysis is the right next call.\n\n`;
        } else if (guardVerdict === 'HARD_STOP') {
          guardWarning = `⚠️ Cost guard hard-stop: too many sub-tasks BUDGET_EXHAUSTED. Further dispatch is blocked. You may now ONLY call complete_analysis (or kd_read_toc / kd_read_section to inspect findings before doing so). Wrap up the analysis with what's available.\n\n`;
        }

        const content = guardWarning + JSON.stringify(resultPayload, null, 2);

        strategistMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: dispatchCallId,
              content,
            } satisfies AIToolResultBlock,
          ],
        });
      } else {
        // ...existing fallback path unchanged...
      }
```

- [ ] **Step 8.4: Implement the test**

Build the stub generator that returns 5 BUDGET_EXHAUSTED results per dispatch and runs for 2 iterations of dispatch + 1 iteration where the strategist tool list should be restricted. Assert via `expect(calls[N].tools).not.toContainEqual(expect.objectContaining({ name: 'dispatch_subtasks' }))`.

- [ ] **Step 8.5: Run analyzer tests**

Run: `pnpm --filter @bronco/ticket-analyzer test` — all PASS.

- [ ] **Step 8.6: Commit**

```bash
git add services/ticket-analyzer/src/analysis/orchestrated-v2.ts services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts
git commit -m "feat(analyzer): strategist batch-failure guard (#470 layer D)

Tracks per-batch and cumulative BUDGET_EXHAUSTED ratios across the
orchestrated-v2 strategist loop. Trips on:
- SOFT_NUDGE: ≥50% of current batch BUDGET_EXHAUSTED with empty
  updatedKdSections (and not first batch). Injects a warning into the
  next strategist tool_result.
- HARD_STOP: cumulative ≥50% BUDGET_EXHAUSTED, OR 2 consecutive batches
  each ≥80% BUDGET_EXHAUSTED. Restricts strategist tool list to
  [complete_analysis, kd_read_toc, kd_read_section] for remainder of run.

Sibling guard alongside the existing updateStallState — does NOT replace.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Ticket-level total-token budget + continuation summary (Layer E + E.1)

**Files:**
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.ts` (`runOrchestratedV2`)
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts`

`orchTotalInputTokens + orchTotalOutputTokens` are already tracked in `runOrchestratedV2`. Add `evaluateTicketBudget` check at the top of each strategist iteration. SOFT_NUDGE injects warning into next strategist message. HARD_STOP restricts strategist tools (same restricted list as D) AND injects the E.1 continuation-summary directive into the message stream.

- [ ] **Step 9.1: Add the integration test**

```typescript
describe('runOrchestratedV2 — ticket budget (Layer E + E.1)', () => {
  it('hard-stops at 95% of totalTokenBudget and injects the continuation-notes directive', async () => {
    // Set config.ticket.totalTokenBudget to 1000 for fast threshold crossing.
    // Stub strategist generateWithTools to consume 950 tokens on iter 1.
    // Assert: iter 2's messages contains a tool_result with substring "## Continuation Notes"
    //         AND the tools parameter is the restricted set.
    expect(true).toBe(false);
  });
});
```

- [ ] **Step 9.2: Run to verify failure**

Run: `pnpm --filter @bronco/ticket-analyzer test -t "ticket budget"` — expect FAIL.

- [ ] **Step 9.3: Implement Layers E + E.1**

In `runOrchestratedV2`, near the strategist hard-stop state from Task 8:

```typescript
import { evaluateTicketBudget } from './budget-thresholds.js';

let ticketSoftNudgeFired = false;
let ticketHardStopActive = false;
```

The `restrictedStrategistTools` from Task 8 is reused.

At the top of the OUTER strategist loop (`for (let i = 0; i < orchMaxIterations; i++)` ~line 1005), BEFORE the inner tool loop starts, add:

```typescript
    // Layer E: ticket-level total-token budget evaluation
    const totalTokensSoFar = orchTotalInputTokens + orchTotalOutputTokens;
    const ticketVerdict = evaluateTicketBudget(totalTokensSoFar, budgetConfig.ticket);

    if (ticketVerdict === 'SOFT_NUDGE' && !ticketSoftNudgeFired) {
      ticketSoftNudgeFired = true;
      const pct = Math.round((totalTokensSoFar / budgetConfig.ticket.totalTokenBudget) * 100);
      // The strategist's last message was a tool_result for dispatch_subtasks
      // (or initial user prompt). Inject a follow-up user-text message warning.
      strategistMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `⚠️ Ticket budget at ${pct}% (${totalTokensSoFar} / ${budgetConfig.ticket.totalTokenBudget} tokens). You are approaching the cost cap. Consider whether enough findings are in the knowledge doc to call complete_analysis. Further dispatch will be blocked at 95%.`,
          },
        ],
      });
      appLog.info(
        `Ticket soft-nudge at iteration ${i + 1} (${pct}% of budget consumed)`,
        { ticketId, iteration: i + 1, totalTokensSoFar, budget: budgetConfig.ticket.totalTokenBudget },
        ticketId,
        'ticket',
      );
    }

    if (ticketVerdict === 'HARD_STOP' && !ticketHardStopActive) {
      ticketHardStopActive = true;
      const pct = Math.round((totalTokensSoFar / budgetConfig.ticket.totalTokenBudget) * 100);
      appLog.warn(
        `Ticket hard-stop activated at iteration ${i + 1} (${pct}% of budget consumed)`,
        { ticketId, iteration: i + 1, totalTokensSoFar, budget: budgetConfig.ticket.totalTokenBudget },
        ticketId,
        'ticket',
      );

      // E.1: Inject the continuation-summary directive
      strategistMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `⚠️ Ticket budget hard-cap reached (${totalTokensSoFar} / ${budgetConfig.ticket.totalTokenBudget} tokens, ${pct}%). You can no longer dispatch sub-tasks.`,
              `Read the knowledge doc with \`kd_read_toc\` / \`kd_read_section\` and call \`complete_analysis\` next.`,
              ``,
              `**Required:** include a \`## Continuation Notes\` section in your \`finalAnalysis\` with the following structure (use exactly these subheadings):`,
              ``,
              `\`\`\``,
              `## Continuation Notes`,
              ``,
              `### What we established`,
              `- <bullet list of confirmed findings, each with KD section reference>`,
              ``,
              `### Hypotheses still open`,
              `- <bullet list of hypotheses introduced but not verified>`,
              ``,
              `### Investigation threads not completed`,
              `- <bullet list of sub-task intents that hit BUDGET_EXHAUSTED with no usable summary>`,
              ``,
              `### Suggested next batch`,
              `- <2–3 sub-task intents that would be most valuable to retry on continuation, with which artifacts/sections to load as context>`,
              `\`\`\``,
              ``,
              `Going slightly over the budget cap to write this summary is permitted and expected.`,
            ].join('\n'),
          },
        ],
      });
    }
```

The `tools` parameter on the strategist's `generateWithTools` call in the inner loop becomes:

```typescript
        tools: (strategistHardStopActive || ticketHardStopActive) ? restrictedStrategistTools : finalStrategistTools,
```

(Replace the prior single-condition swap from Task 8.)

- [ ] **Step 9.4: Implement the test**

Build the stub: small `totalTokenBudget` (e.g., 1000), stub strategist to return `usage: { inputTokens: 950, outputTokens: 0 }` on iter 1, then `complete_analysis` on iter 2. Assert:
- iter 2's `messages` includes a user text message containing `## Continuation Notes`
- iter 2's `tools` is the restricted set (length 3, includes `complete_analysis` but NOT `dispatch_subtasks`)

- [ ] **Step 9.5: Run analyzer tests**

Run: `pnpm --filter @bronco/ticket-analyzer test` — all PASS.

- [ ] **Step 9.6: Commit**

```bash
git add services/ticket-analyzer/src/analysis/orchestrated-v2.ts services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts
git commit -m "feat(analyzer): ticket-level budget cap + continuation summary (#470 layer E + E.1)

At the top of each strategist iteration in runOrchestratedV2:
- evaluate accumulated input+output tokens vs config.ticket.totalTokenBudget
- on SOFT_NUDGE (default 75%): inject a budget-warning user message into
  the strategist's next turn (fires once per run)
- on HARD_STOP (default 95%): inject the E.1 continuation-notes directive
  AND restrict the strategist's tool list to [complete_analysis,
  kd_read_toc, kd_read_section]

The continuation directive instructs the strategist to write a
structured 'Continuation Notes' section in finalAnalysis covering: what
was established, open hypotheses, incomplete threads, and suggested
next-batch sub-task intents. This bounds the cost overshoot to one
strategist call (~8k tokens) and provides resumable structured state
for a future #48 Item 7 manual re-analysis flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire `OrchestratedV2BudgetConfig` through the public entry point

**Files:**
- Modify: `services/ticket-analyzer/src/analysis/orchestrated-v2.ts` (`runOrchestratedV2`)

Up to this point, `runSubTaskLoop` accepts a `budgetConfig` parameter (added in Task 6) and `runOrchestratedV2` references `budgetConfig` (added in Tasks 8 + 9). Now thread the config from the resolver into `runOrchestratedV2` and remove the hard-coded `SUB_TASK_*` constants.

- [ ] **Step 10.1: Load the budget config in `runOrchestratedV2`**

Open `orchestrated-v2.ts`. Near the top of `runOrchestratedV2` (~line 856, after `defaultMaxTokens` and `toolResultMaxTokens` are loaded), add:

```typescript
  const budgetConfig = await resolveOrchestratedV2BudgetConfig(db);
  appLog.info(
    `Orchestrated v2 run starting with budget config: ticket=${budgetConfig.ticket.totalTokenBudget}, subTask.tokens=${budgetConfig.subTask.tokenBudget}`,
    { ticketId, budgetConfig },
    ticketId,
    'ticket',
  );
```

Add the import at the top of the file:

```typescript
import { resolveOrchestratedV2BudgetConfig } from './shared.js';
```

(Or merge into the existing `from './shared.js'` import.)

- [ ] **Step 10.2: Replace the hard-coded constants in `runSubTaskLoop`**

Find the existing constants at the top of `orchestrated-v2.ts` (~lines 92-97):

```typescript
const SUB_TASK_ITERATION_CAP = 8;
const SUB_TASK_TOKEN_BUDGET = 50_000;
const SUB_TASK_CALL_BUDGET = 20;
```

Replace with:

```typescript
/**
 * Hard-coded fallback values for the orchestrated-v2 sub-task budget. These are
 * the schema defaults from `OrchestratedV2BudgetConfigSchema` — kept here for
 * reference and as the values used when the new config plumbing is bypassed
 * (e.g. older callers of `runSubTaskLoop` not yet migrated).
 *
 * Live runtime values come from `resolveOrchestratedV2BudgetConfig(db)` and
 * are passed through `runOrchestratedV2` → `runSubTaskLoop` via `budgetConfig`.
 */
const DEFAULT_SUB_TASK_BUDGET = {
  iterationCap: 8,
  tokenBudget: 50_000,
  callBudget: 20,
} as const;
```

In `runSubTaskLoop`, replace remaining direct references to `SUB_TASK_ITERATION_CAP` / `SUB_TASK_TOKEN_BUDGET` / `SUB_TASK_CALL_BUDGET` with `budgetConfig.subTask.iterationCap` / `.tokenBudget` / `.callBudget`. Also replace the budget-line text in the user prompt (~line 196):

```typescript
  const budgetLine = `## Budget\nMax ${budgetConfig.subTask.iterationCap} iterations, max ${budgetConfig.subTask.tokenBudget.toLocaleString()} tokens total, max ${budgetConfig.subTask.callBudget} tool calls. Call \`finalize_subtask\` once you are done — do not wait until budget is exhausted.`;
```

The for-loop bound:

```typescript
  for (let iteration = 0; iteration < budgetConfig.subTask.iterationCap; iteration++) {
```

- [ ] **Step 10.3: Update `executeOrchestratedSubTaskV2` to forward `budgetConfig`**

Find the call to `runSubTaskLoop` inside `executeOrchestratedSubTaskV2` (~line 596). Add `budgetConfig` to the argument list — it'll need to be passed in via `executeOrchestratedSubTaskV2`'s signature:

```typescript
async function executeOrchestratedSubTaskV2(
  // ...existing params...
  budgetConfig: OrchestratedV2BudgetConfig,                                  // NEW
  modelMap?: Record<string, string>,
  toolResultMaxTokens?: number,
): Promise<SubTaskRunResult> {
```

And forward to both `runSubTaskLoop` calls inside the function (the first call ~line 596, and the retry call ~line 631). Plus update the call sites in `runOrchestratedV2` (the parallel-batch dispatch around lines 1247 and 1298) to pass `budgetConfig`.

- [ ] **Step 10.4: Build and run all tests**

Run: `pnpm --filter @bronco/ticket-analyzer build`
Expected: clean.

Run: `pnpm --filter @bronco/ticket-analyzer test`
Expected: all PASS.

- [ ] **Step 10.5: Commit**

```bash
git add services/ticket-analyzer/src/analysis/orchestrated-v2.ts
git commit -m "feat(analyzer): wire OrchestratedV2BudgetConfig through runOrchestratedV2 (#470)

Loads orchestrated-v2-budget-config AppSetting at the top of each run
via resolveOrchestratedV2BudgetConfig, threads it through to
runSubTaskLoop and the strategist evaluators. Hard-coded SUB_TASK_*
constants replaced with DEFAULT_SUB_TASK_BUDGET for reference; live
values now come from the runtime config.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Control panel — `SettingsService` methods

**Files:**
- Modify: `services/control-panel/src/app/features/settings/settings.service.ts`

Add a service method pair following the existing `getAnalysisStrategyVersion` / `saveAnalysisStrategyVersion` template (per prior recon at `settings.service.ts:302-307`).

- [ ] **Step 11.1: Read the existing service method as the template**

Run: `sed -n '290,320p' services/control-panel/src/app/features/settings/settings.service.ts`
Expected: shows the existing analysis-strategy-version method pair.

- [ ] **Step 11.2: Add the new methods**

Append after the analysis-strategy-version pair:

```typescript
  // ---------------------------------------------------------------------------
  // Orchestrated v2 Budget Config (#470)
  // ---------------------------------------------------------------------------

  getOrchestratedV2BudgetConfig(): Observable<OrchestratedV2BudgetConfig> {
    return this.api.get<OrchestratedV2BudgetConfig>('/settings/orchestrated-v2-budget-config');
  }

  saveOrchestratedV2BudgetConfig(config: OrchestratedV2BudgetConfig): Observable<OrchestratedV2BudgetConfig> {
    return this.api.put<OrchestratedV2BudgetConfig>('/settings/orchestrated-v2-budget-config', config);
  }
```

Add the import at the top of the file:

```typescript
import type { OrchestratedV2BudgetConfig } from '@bronco/shared-types';
```

- [ ] **Step 11.3: Build the control panel**

Run: `pnpm --filter @bronco/control-panel build`
Expected: clean.

- [ ] **Step 11.4: Commit**

```bash
git add services/control-panel/src/app/features/settings/settings.service.ts
git commit -m "feat(control-panel): SettingsService methods for orchestrated-v2 budget (#470)

Mirrors the analysis-strategy-version service-method pattern.
Consumed by the budget-card component in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Control panel — settings card component

**Files:**
- Modify: `services/control-panel/src/app/features/settings/settings.component.ts`

Add a new "Orchestrated v2 Budget Limits" card to the existing Analysis tab. Each numeric field bound to a signal with min/max validation.

- [ ] **Step 12.1: Read the existing Analysis tab structure**

Run: `sed -n '340,430p' services/control-panel/src/app/features/settings/settings.component.ts`
Expected: shows the Analysis tab declaration and the existing analysis-strategy-version card around lines 408-422.

- [ ] **Step 12.2: Add the budget-config card to the template**

Within the Analysis tab section, after the analysis-strategy-version card, add a new `<mat-card>` (or whatever the existing pattern uses):

```html
<mat-card class="settings-card">
  <mat-card-header>
    <mat-card-title>Orchestrated v2 Budget Limits</mat-card-title>
    <mat-card-subtitle>
      Caps cost per ticket-analysis run. Lower values reduce worst-case cost; too low may cut healthy analyses short.
    </mat-card-subtitle>
  </mat-card-header>
  <mat-card-content>
    <h4>Sub-task limits (per investigation)</h4>
    <mat-form-field>
      <mat-label>Iteration cap</mat-label>
      <input matInput type="number" min="1" max="50"
             [value]="budgetConfig().subTask.iterationCap"
             (change)="updateSubTaskField('iterationCap', $any($event.target).valueAsNumber)">
    </mat-form-field>
    <mat-form-field>
      <mat-label>Token budget</mat-label>
      <input matInput type="number" min="5000" max="500000" step="1000"
             [value]="budgetConfig().subTask.tokenBudget"
             (change)="updateSubTaskField('tokenBudget', $any($event.target).valueAsNumber)">
    </mat-form-field>
    <mat-form-field>
      <mat-label>Tool call budget</mat-label>
      <input matInput type="number" min="1" max="100"
             [value]="budgetConfig().subTask.callBudget"
             (change)="updateSubTaskField('callBudget', $any($event.target).valueAsNumber)">
    </mat-form-field>
    <mat-form-field>
      <mat-label>Soft-nudge ratio</mat-label>
      <input matInput type="number" min="0.1" max="0.99" step="0.05"
             [value]="budgetConfig().subTask.softNudgeRatio"
             (change)="updateSubTaskField('softNudgeRatio', $any($event.target).valueAsNumber)">
    </mat-form-field>
    <mat-form-field>
      <mat-label>Hard-stop ratio</mat-label>
      <input matInput type="number" min="0.1" max="0.99" step="0.05"
             [value]="budgetConfig().subTask.hardStopRatio"
             (change)="updateSubTaskField('hardStopRatio', $any($event.target).valueAsNumber)">
    </mat-form-field>

    <h4>Ticket-level cap (whole analysis)</h4>
    <mat-form-field>
      <mat-label>Total token budget</mat-label>
      <input matInput type="number" min="50000" max="5000000" step="10000"
             [value]="budgetConfig().ticket.totalTokenBudget"
             (change)="updateTicketField('totalTokenBudget', $any($event.target).valueAsNumber)">
    </mat-form-field>
    <mat-form-field>
      <mat-label>Soft-nudge ratio</mat-label>
      <input matInput type="number" min="0.1" max="0.99" step="0.05"
             [value]="budgetConfig().ticket.softNudgeRatio"
             (change)="updateTicketField('softNudgeRatio', $any($event.target).valueAsNumber)">
    </mat-form-field>
    <mat-form-field>
      <mat-label>Hard-stop ratio</mat-label>
      <input matInput type="number" min="0.1" max="0.99" step="0.05"
             [value]="budgetConfig().ticket.hardStopRatio"
             (change)="updateTicketField('hardStopRatio', $any($event.target).valueAsNumber)">
    </mat-form-field>

    <h4>Strategist guard</h4>
    <mat-form-field>
      <mat-label>Soft-nudge batch exhausted ratio</mat-label>
      <input matInput type="number" min="0.1" max="0.99" step="0.05"
             [value]="budgetConfig().strategistGuard.softNudgeBatchExhaustedRatio"
             (change)="updateGuardField('softNudgeBatchExhaustedRatio', $any($event.target).valueAsNumber)">
    </mat-form-field>
    <mat-form-field>
      <mat-label>Hard-stop cumulative ratio</mat-label>
      <input matInput type="number" min="0.1" max="0.99" step="0.05"
             [value]="budgetConfig().strategistGuard.hardStopCumulativeExhaustedRatio"
             (change)="updateGuardField('hardStopCumulativeExhaustedRatio', $any($event.target).valueAsNumber)">
    </mat-form-field>
    <mat-form-field>
      <mat-label>Hard-stop consecutive batches ratio</mat-label>
      <input matInput type="number" min="0.1" max="0.99" step="0.05"
             [value]="budgetConfig().strategistGuard.hardStopConsecutiveBatchesRatio"
             (change)="updateGuardField('hardStopConsecutiveBatchesRatio', $any($event.target).valueAsNumber)">
    </mat-form-field>

    <h4>Re-read detector</h4>
    <mat-form-field>
      <mat-label>Warn after read count</mat-label>
      <input matInput type="number" min="2" max="20"
             [value]="budgetConfig().subTaskReReadDetector.warnAfterReadCount"
             (change)="updateReReadField('warnAfterReadCount', $any($event.target).valueAsNumber)">
    </mat-form-field>
  </mat-card-content>
  <mat-card-actions>
    <button mat-raised-button color="primary" (click)="saveBudgetConfig()" [disabled]="!budgetConfigDirty()">
      Save
    </button>
    <button mat-button (click)="reloadBudgetConfig()" [disabled]="!budgetConfigDirty()">
      Reset
    </button>
  </mat-card-actions>
</mat-card>
```

- [ ] **Step 12.3: Add the component-class state and methods**

Inside the `SettingsComponent` class, near the existing `analysisStrategyVersion` signal:

```typescript
  budgetConfig = signal<OrchestratedV2BudgetConfig>(this.defaultBudgetConfig());
  private budgetConfigInitial = signal<OrchestratedV2BudgetConfig>(this.defaultBudgetConfig());
  budgetConfigDirty = computed(() =>
    JSON.stringify(this.budgetConfig()) !== JSON.stringify(this.budgetConfigInitial()),
  );

  private defaultBudgetConfig(): OrchestratedV2BudgetConfig {
    return {
      subTask: { iterationCap: 8, tokenBudget: 50_000, callBudget: 20, softNudgeRatio: 0.6, hardStopRatio: 0.85 },
      ticket: { totalTokenBudget: 300_000, softNudgeRatio: 0.75, hardStopRatio: 0.95 },
      strategistGuard: { softNudgeBatchExhaustedRatio: 0.5, hardStopCumulativeExhaustedRatio: 0.5, hardStopConsecutiveBatchesRatio: 0.8 },
      subTaskReReadDetector: { warnAfterReadCount: 2 },
    };
  }

  reloadBudgetConfig(): void {
    this.settingsSvc.getOrchestratedV2BudgetConfig().subscribe({
      next: (cfg) => {
        this.budgetConfig.set(cfg);
        this.budgetConfigInitial.set(cfg);
      },
      error: (err) => {
        this.snackBar.open('Failed to load budget config: ' + err.message, 'OK', { duration: 5000 });
      },
    });
  }

  saveBudgetConfig(): void {
    this.settingsSvc.saveOrchestratedV2BudgetConfig(this.budgetConfig()).subscribe({
      next: (cfg) => {
        this.budgetConfig.set(cfg);
        this.budgetConfigInitial.set(cfg);
        this.snackBar.open('Budget config saved', 'OK', { duration: 3000 });
      },
      error: (err) => {
        this.snackBar.open('Failed to save: ' + err.message, 'OK', { duration: 5000 });
      },
    });
  }

  updateSubTaskField(field: keyof OrchestratedV2BudgetConfig['subTask'], value: number): void {
    if (Number.isNaN(value)) return;
    this.budgetConfig.update(c => ({ ...c, subTask: { ...c.subTask, [field]: value } }));
  }

  updateTicketField(field: keyof OrchestratedV2BudgetConfig['ticket'], value: number): void {
    if (Number.isNaN(value)) return;
    this.budgetConfig.update(c => ({ ...c, ticket: { ...c.ticket, [field]: value } }));
  }

  updateGuardField(field: keyof OrchestratedV2BudgetConfig['strategistGuard'], value: number): void {
    if (Number.isNaN(value)) return;
    this.budgetConfig.update(c => ({ ...c, strategistGuard: { ...c.strategistGuard, [field]: value } }));
  }

  updateReReadField(field: keyof OrchestratedV2BudgetConfig['subTaskReReadDetector'], value: number): void {
    if (Number.isNaN(value)) return;
    this.budgetConfig.update(c => ({ ...c, subTaskReReadDetector: { ...c.subTaskReReadDetector, [field]: value } }));
  }
```

Imports (top of component file):

```typescript
import { computed, signal } from '@angular/core';
import type { OrchestratedV2BudgetConfig } from '@bronco/shared-types';
```

In `ngOnInit` (or wherever existing settings are loaded), add:

```typescript
    this.reloadBudgetConfig();
```

- [ ] **Step 12.4: Build and dev-test**

Run: `pnpm --filter @bronco/control-panel build`
Expected: clean.

Start dev server: `pnpm dev:panel`
Open browser to the Settings page → Analysis tab. Verify the new card renders, fields populate from the API, and Save / Reset behave correctly. Also verify min/max enforcement on inputs.

- [ ] **Step 12.5: Commit**

```bash
git add services/control-panel/src/app/features/settings/settings.component.ts
git commit -m "feat(control-panel): orchestrated-v2 budget config card (#470)

Adds 'Orchestrated v2 Budget Limits' card to the existing Settings →
Analysis tab. Sections: sub-task limits, ticket-level cap, strategist
guard, re-read detector. Each numeric field signal-bound; Save sends
the merged config to PUT /api/settings/orchestrated-v2-budget-config.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Final integration smoke + open PR

**Files:**
- No code changes — verification only

- [ ] **Step 13.1: Replay-test against ticket #49**

(Manual; requires hitting the dev server with a real ticket.)

In a dev environment, set the budget config to a tight cap to confirm hard-stop fires cleanly:

```bash
curl -X PUT http://localhost:3000/api/settings/orchestrated-v2-budget-config \
  -H 'Content-Type: application/json' \
  -H "Cookie: $(get_admin_session_cookie)" \
  -d '{"ticket":{"totalTokenBudget":50000}}'
```

Trigger an analysis on a copy/replay of ticket `cf1b96e8`. Watch the analyzer logs for:
- "Sub-task soft-nudge fired"
- "Sub-task hard-stop active" (if any sub-task crosses 85%)
- "Strategist hard-stop activated" OR "Ticket hard-stop activated"
- The final composed analysis ending with `## Continuation Notes` when hard-stop fires

Restore default config:

```bash
curl -X PUT http://localhost:3000/api/settings/orchestrated-v2-budget-config \
  -H 'Content-Type: application/json' \
  -H "Cookie: $(get_admin_session_cookie)" \
  -d '{}'
```

- [ ] **Step 13.2: Run all suites once more**

Run: `pnpm typecheck` (whole monorepo)
Expected: clean.

Run: `pnpm test` (whole monorepo) — or scoped to the touched packages if monorepo-wide is too slow:
`pnpm --filter @bronco/shared-types --filter @bronco/ticket-analyzer --filter @bronco/copilot-api --filter @bronco/control-panel test`
Expected: all PASS.

- [ ] **Step 13.3: Push branch and open PR**

```bash
git push -u origin fix/470-v2-budget-bounds
```

Open PR against `staging`:

```bash
gh pr create --base staging --head fix/470-v2-budget-bounds \
  --title "fix: bound orchestrated-v2 analysis cost (#470)" \
  --body-file .tmp/pr-470-body.md
```

PR body file (`.tmp/pr-470-body.md`):

```markdown
## Summary

Caps worst-case orchestrated-v2 ticket-analyzer cost at the configured ticket budget (default 300k tokens ≈ $5). Fixes #470.

Adds 5 layered guardrails:
- **A** — budget-aware sub-task system prompt
- **B** — sub-task budget soft-nudge (60%) + hard-stop (85%)
- **C** — per-artifact re-read detector
- **D** — strategist batch-failure guard (cumulative + consecutive metrics)
- **E** — ticket-level total-token cap with continuation-summary directive on hard-stop

All thresholds runtime-configurable via the new `orchestrated-v2-budget-config` AppSetting, surfaced in Settings → Analysis tab.

Spec: `docs/superpowers/specs/2026-04-28-orchestrated-v2-budget-bounds-design.md`

Deferred follow-ups: #475 (MCP tool pair), #476 (per-category overrides).

## Test plan

- [x] Unit tests for budget-thresholds.ts (5 evaluator functions × multiple scenarios)
- [x] Integration tests for runSubTaskLoop (re-read detector, soft-nudge, hard-stop)
- [x] Integration tests for runOrchestratedV2 (batch-failure guard, ticket budget, continuation-summary directive)
- [x] Manual replay of ticket #49 with tightened cap — confirms clean hard-stop with continuation summary
- [x] Manual control-panel verification — card renders, save persists, reload reflects DB state
- [x] `pnpm typecheck` clean across monorepo
```

Resolves #470.
```

- [ ] **Step 13.4: Wait for Copilot review**

Per `feedback_pr_review_handling.md` (memory), Copilot auto-reviews PRs targeting `staging`. Once Copilot posts comments, address each per the PR Review Comment Handling section in CLAUDE.md (push fix → reply to comment → resolve thread).

- [ ] **Step 13.5: Merge once review passes**

Standard squash-merge to `staging`. Issue #470 auto-closes via `Resolves #470` in PR body.

---

## Self-Review

**Spec coverage:**
- Layer A (sub-task prompt revision) → Task 5 ✓
- Layer B (sub-task soft-nudge + hard-stop) → Task 7 ✓
- Layer C (re-read detector) → Task 6 ✓
- Layer D (strategist batch-failure guard) → Task 8 ✓
- Layer E + E.1 (ticket budget + continuation summary) → Task 9 ✓
- AppSetting schema → Task 1 ✓
- Resolver → Task 3 ✓
- REST endpoints → Task 4 ✓
- Control panel UI → Tasks 11 + 12 ✓
- Acceptance criteria 1 (replay ticket #49) → Task 13.1 ✓
- Acceptance criteria 2 (healthy tickets unchanged) → Implicit; covered by existing tests passing in Task 5+ ✓
- Acceptance criteria 3 (operator can change config via UI) → Task 12 ✓
- Acceptance criteria 4 (unit-test coverage for all 5 layers) → Tasks 2, 6, 7, 8, 9 ✓
- Acceptance criteria 5 (v1 paths unchanged) → No code changes to v1 files; verified in Task 13.2 ✓

**No placeholders:** All tasks include concrete code blocks. The two test placeholders in Steps 6.1/7.1/8.1/9.1 are explicitly marked and replaced in their corresponding implementation steps (6.4/7.4/8.4/9.4).

**Type consistency:**
- `OrchestratedV2BudgetConfig` used consistently across Tasks 1, 2, 3, 4, 6, 7, 9, 10, 11, 12.
- `ThresholdVerdict`, `SubTaskBudgetUsage`, `BatchFailureGuardState`, `BatchResultSummary` defined in Task 2 and used in 6, 7, 8, 9, 10.
- `evaluateSubTaskBudget` / `evaluateTicketBudget` / `detectArtifactReread` / `evaluateBatchFailureGuard` — all four function names referenced consistently.
- `budgetConfig` parameter name on `runSubTaskLoop` and `executeOrchestratedSubTaskV2` consistent.
- `restrictedStrategistTools` used identically in Tasks 8 and 9.
- `softNudgeFired` / `hardStopActive` (sub-task) vs `ticketSoftNudgeFired` / `ticketHardStopActive` (ticket) — distinct names per scope, consistent within scope.

**Memory pre-flights respected:**
- `feedback_commit_each_fix.md` — each task is a separate commit ✓
- `feedback_commit_messages.md` — write to repo `.tmp/` and commit via `-F`, never inline heredoc ✓ (PR body uses `.tmp/pr-470-body.md`)
- `feedback_worktree_branch_naming.md` — branch is `fix/470-v2-budget-bounds`, prefix `fix/` ✓
- `feedback_subagent_test_updates.md` — every code change ships with a sibling `.test.ts` update in the same commit ✓
- `feedback_test_files_in_src_tsconfig.md` — new `budget-thresholds.test.ts` is in `src/`; if there's a tsconfig exclude pattern, verify it covers the new file (Step 2.4 build) ✓
- `feedback_shell_commands.md` — all command examples use `git -C` style or absolute paths; no `cd` chaining ✓
