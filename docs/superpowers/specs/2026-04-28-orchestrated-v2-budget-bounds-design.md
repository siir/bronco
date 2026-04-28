# Bound orchestrated-v2 analysis cost (#470 + budget config)

**Status:** Design — pending review
**Date:** 2026-04-28
**Tickets:** #470 (read-loop budget burn), implicit cost-bound for #471 / #472 follow-ups

## Problem

The orchestrated-v2 ticket analyzer can burn $15–40 of Opus tokens per ticket without producing usable findings. Live evidence from ticket #49 (`cf1b96e8`) on 2026-04-27:

- ~60% of dispatched sub-tasks hit `BUDGET_EXHAUSTED` without calling `finalize_subtask`. The reliable failure mode is sub-tasks that loop on `read_tool_result_artifact`, paging through cached artifacts in 4k-char chunks until they hit the 50k-token / 8-iteration / 20-call budget.
- The strategist's fallback when a sub-task burns out is the **first tool call's first 500 chars** (`fallbackFromToolResults` in `orchestrated-v2.ts:108-112`). For a paging loop, that's the head of the first artifact read — useless to the strategist.
- The strategist sees this empty-summary signal and dispatches MORE sub-tasks on the same investigation thread. The existing stall guard (lines 790-828) only fires on (1) zero dispatch + zero KD writes, (2) three identical dispatch hashes, or (3) zero KD writes after 3 iterations — none of which catch the read-loop death-spiral.
- **The per-sub-task token cap (50k) is effectively inert at the ticket level.** When a sub-task returns BUDGET_EXHAUSTED with a partial summary, the strategist's natural response is to dispatch a replacement sub-task. There is no ticket-level total budget.

For comparison, `flat-v1` analyzes the same class of ticket for ~$1–2.

## Goal

Bound the worst-case cost of a single orchestrated-v2 ticket analysis to a hard ceiling (default $5, configurable), without regressing the analysis quality of healthy tickets.

## Non-goals

- Reanalyzing v1 budget — v1 lacks this architecture.
- Detecting strategist-level `read_tool_result_artifact` loops directly. (E catches the cost; not addressing the loop pathology itself in this spec.)
- Per-ticket-category budget tuning. Single global config for now.
- Replay tooling / cost regression test harness — separate concern.

## Solution: layered guardrails (A + B + C + D + E)

Five independent layers compose into a defense-in-depth fix. Each addresses a distinct contribution to the cost burn, and the combination bounds total cost even when individual layers are bypassed.

### A. Sub-task system prompt revision

**File:** `services/ticket-analyzer/src/analysis/orchestrated-v2.ts:523-530` (`subTaskInstructions`)

The current prompt actively encourages running to budget exhaustion: *"Call `finalize_subtask` as the LAST action — do not call it before you have gathered all the data you need."* Replace with budget-aware guidance:

- Explicit budget mention with units.
- `read_tool_result_artifact` guidance: prefer `grep` mode for surgical search; if the truncated preview supports a finding, work from that.
- Permission to finalize on partial findings: "Partial findings with what you have are more useful than burning the budget chasing more."

### B. Mid-loop budget feedback (hybrid: soft nudge → hard-stop)

**Function:** `runSubTaskLoop` in `orchestrated-v2.ts:148+`

At the top of each iteration after computing `tokensSoFar` / `totalToolCalls`:

- **Soft-nudge** (default 60% of any budget — tokens, iterations, or calls — whichever fires first): inject a synthetic `tool_result` block into the next strategist turn warning of approaching ceiling. Fires once per threshold crossing (tracked with a flag).
- **Hard-stop** (default 85% of any budget): on the next `generateWithTools` call, set `tools` parameter to ONLY `[FINALIZE_SUBTASK_TOOL]`. The agent's only option is to wrap up.

Hard-stop is enforced by tool-list filtering, not message injection — more reliable than relying on agent compliance with a warning.

### C. Per-artifact re-read detector

In the sub-task loop, maintain a counter map keyed on `(toolName, artifactId)` for `read_tool_result_artifact` calls. When the same artifact is read >= the warn threshold (default 2):

- Append a guidance line to the next iteration's `tool_result`: *"⚠️ You've read artifact X N times. Use `grep` mode for specific patterns, or finalize with what you have."*

Targets the specific failure mode (sequential paging through one artifact). Does not block the call; gives the agent one course-correction signal.

### D. Strategist batch-failure guard

**Location:** strategist loop in `executeOrchestratedV2`, after each `dispatch_subtasks` resolves. Sibling to the existing `updateStallState` guard at `orchestrated-v2.ts:790-828` — does NOT replace or merge into it. The existing guard catches strategist-level repetition and zero-progress; D adds an orthogonal trigger keyed on cumulative sub-task budget exhaustion.

Compute per-batch metrics:
- `budgetExhaustedCount` / `totalCount`
- `kdWritesInBatch` (sum of `updatedKdSections.length` across results)

Maintain cumulative tracking across batches:
- `cumulativeExhausted` / `cumulativeTotal`
- `consecutiveBadBatches` (count of consecutive batches with ≥80% BUDGET_EXHAUSTED)

Trip conditions:
- **Soft-nudge** (default): current batch ≥50% BUDGET_EXHAUSTED with empty `updatedKdSections`, AND batch is not the first → inject a tool_result on the next strategist turn.
- **Hard-stop** (default): cumulative ≥50% BUDGET_EXHAUSTED OR `consecutiveBadBatches >= 2` → restrict strategist tool list to `[COMPLETE_ANALYSIS_TOOL, kd_read_toc, kd_read_section]`. No more dispatches possible.

Closes the failure mode where the strategist treats partial summaries as "interim progress, dispatch more."

### E. Ticket-level total token budget

**Location:** `executeOrchestratedV2` entry point (orchestrated-v2.ts).

Track `totalTokensConsumed` = strategist usage (input + output) + sum of every sub-task's `inputTokens + outputTokens` returned in `SubTaskRunResult`.

After each strategist iteration, before the next strategist `generateWithTools` call:

- **Soft-nudge** at 75% of `TICKET_TOTAL_TOKEN_BUDGET`: inject `tool_result` warning on next strategist turn.
- **Hard-stop** at 95%: strategist tool list reduced to `[COMPLETE_ANALYSIS_TOOL, kd_read_toc, kd_read_section]`.

Default value: `300_000` tokens (≈$5 hard ceiling at Opus rate). The user explicitly chose 300k; v1 handles the same workload for ~$1–2, so 300k leaves ~3× headroom for v2's strategist overhead.

Side benefit: bounds runaway *strategist* cost from any source (including its own `read_tool_result_artifact` access, which is currently unguarded).

## Configuration via DB AppSetting

All numeric thresholds load from a single `AppSetting` at analysis-run time and surface in the control panel for tuning without redeploy.

### AppSetting key

`orchestrated-v2-budget-config` (JSON value).

### Schema (Zod, in `packages/shared-types/src/analysis.ts`)

```ts
export const OrchestratedV2BudgetConfigSchema = z.object({
  subTask: z.object({
    iterationCap: z.number().int().min(1).max(50).default(8),
    tokenBudget: z.number().int().min(5_000).max(500_000).default(50_000),
    callBudget: z.number().int().min(1).max(100).default(20),
    softNudgeRatio: z.number().min(0.1).max(0.99).default(0.6),
    hardStopRatio: z.number().min(0.1).max(0.99).default(0.85),
  }),
  ticket: z.object({
    totalTokenBudget: z.number().int().min(50_000).max(5_000_000).default(300_000),
    softNudgeRatio: z.number().min(0.1).max(0.99).default(0.75),
    hardStopRatio: z.number().min(0.1).max(0.99).default(0.95),
  }),
  strategistGuard: z.object({
    softNudgeBatchExhaustedRatio: z.number().min(0.1).max(0.99).default(0.5),
    hardStopCumulativeExhaustedRatio: z.number().min(0.1).max(0.99).default(0.5),
    hardStopConsecutiveBatchesRatio: z.number().min(0.1).max(0.99).default(0.8),
  }),
  subTaskReReadDetector: z.object({
    warnAfterReadCount: z.number().int().min(2).max(20).default(2),
  }),
});

export type OrchestratedV2BudgetConfig = z.output<typeof OrchestratedV2BudgetConfigSchema>;
```

Refinement: `softNudgeRatio < hardStopRatio` enforced by `.refine(...)`.

### Resolver

New helper in `services/ticket-analyzer/src/analysis/shared.ts` following the existing `resolveAnalysisVersion` / `resolveMaxParallelTasks` pattern (no cache, fresh fetch per analysis run):

```ts
export async function resolveOrchestratedV2BudgetConfig(db: DbClient): Promise<OrchestratedV2BudgetConfig> {
  const row = await db.appSetting.findUnique({ where: { key: 'orchestrated-v2-budget-config' } });
  const parsed = OrchestratedV2BudgetConfigSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : OrchestratedV2BudgetConfigSchema.parse({});
}
```

Loaded once at the top of `executeOrchestratedV2`; passed down to `runSubTaskLoop` and the strategist guard. Does not change mid-run.

### REST API

New per-feature endpoint pair in `services/copilot-api/src/routes/settings.ts`, matching the existing `analysis-strategy-version` pattern (lines 1168–1199):

- `GET /api/settings/orchestrated-v2-budget-config` — returns current value or defaults
- `PUT /api/settings/orchestrated-v2-budget-config` — ADMIN-only; Zod-validated body; upserts AppSetting

### Control panel UI

New card in the existing **Analysis tab** of `services/control-panel/src/app/features/settings/settings.component.ts` (the same tab that holds the v1/v2 strategy selector at lines 408–422).

- Card title: **"Orchestrated v2 Budget Limits"**
- Sections: Sub-task budgets, Ticket budget, Strategist guard, Re-read detector
- Each numeric field bound to a `signal<number>` with min/max validation matching Zod schema
- Save button → `settingsSvc.saveOrchestratedV2BudgetConfig(value)` (new service method, mirrors `saveAnalysisStrategyVersion` at `settings.service.ts:302-307`)
- Footer help text: "Lower values reduce worst-case cost; too low may cut healthy analyses short. See docs."

## MCP Platform Server sync

CLAUDE.md mandates that every API operation should be accessible via both REST and MCP. The new endpoint pair therefore needs a corresponding MCP tool in `mcp-servers/platform/src/tools/`:

- `get_orchestrated_v2_budget_config` (read-only, allowed for analyzer / admin callers)
- `set_orchestrated_v2_budget_config` (admin-only — gated by caller registry)

## Testing strategy

### Unit tests
File: `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts` (extend existing — file confirmed present)

- A: snapshot the new system prompt string (regression guard)
- B (soft-nudge): stub `runSubTaskLoop` deps; simulate sub-task at 60% token usage; assert tool_result warning injected
- B (hard-stop): simulate sub-task at 85% token usage; assert tools parameter on next call is `[FINALIZE_SUBTASK_TOOL]` only
- C: simulate 2 reads of the same artifactId; assert nudge appended to subsequent tool_result
- D (soft-nudge): mock dispatch_subtasks result with 50% BUDGET_EXHAUSTED + empty updatedKdSections; assert tool_result injected on next strategist turn
- D (hard-stop): mock cumulative metrics crossing 50% threshold; assert strategist tool list reduced to finalization tools
- E: mock budget config with `totalTokenBudget: 100_000`; track usage from a stub strategist + sub-tasks crossing 75% / 95%; assert the corresponding nudge / hard-stop behaviors
- Config resolver: missing AppSetting → all defaults; malformed JSON → all defaults; partial JSON → defaults merge with provided values

### Integration smoke
Manual replay of one historical ticket via dev with low cap (e.g. `totalTokenBudget: 50_000`) to verify the run terminates cleanly via E without crashing.

### Unchanged
v1 paths (flat-v1, orchestrated-v1) — no test changes.

## Edge cases

- **Existing in-flight tickets at deploy time:** budget loaded at analysis start; in-flight runs continue with whatever defaults they captured. No mid-run config reload.
- **AppSetting missing or malformed:** Zod safeParse fall-through to defaults. Logged at WARN level once per analyzer process startup if malformed.
- **User sets unreasonable value:** Zod min/max guards prevent obviously-broken values (e.g. `tokenBudget: 0`). Soft refinement `softNudgeRatio < hardStopRatio` enforced.
- **Strategist already at hard-stop and `complete_analysis` itself fails:** existing `composeFinalAnalysis` + `fallbackFillRequiredSections` flow handles. No new behavior needed.
- **Sub-task hard-stopped via B but happens to call finalize_subtask in the same turn:** tool list filter ensures the only available tool IS finalize_subtask, so this is the expected outcome.
- **Race between B's hard-stop and D's hard-stop:** they operate at different layers (sub-task vs. strategist). Both can be active simultaneously; no interaction.

## Files modified

### Backend
- `services/ticket-analyzer/src/analysis/orchestrated-v2.ts` — main logic for A, B, C, D, E + config plumbing
- `services/ticket-analyzer/src/analysis/shared.ts` — `resolveOrchestratedV2BudgetConfig` helper, `AnalysisDeps` extension
- `services/copilot-api/src/routes/settings.ts` — new GET/PUT endpoint pair
- `packages/shared-types/src/analysis.ts` — `OrchestratedV2BudgetConfigSchema` + type
- `mcp-servers/platform/src/tools/` — new MCP tool pair (REST/MCP parity)

### Frontend
- `services/control-panel/src/app/features/settings/settings.component.ts` — new card in Analysis tab
- `services/control-panel/src/app/features/settings/settings.service.ts` — new service method pair

### Tests
- `services/ticket-analyzer/src/analysis/orchestrated-v2.test.ts` — unit tests for A–E

## Out of scope (future work / separate issues)

- Strategist `read_tool_result_artifact` loop detection (#470 successor — addressing the loop itself, not just its cost)
- Per-ticket-category budget tuning (e.g. DATABASE_PERF gets larger budget than BUG_FIX)
- Replay harness / cost regression test in CI
- Issue #471 (sub-task tool allowlist inconsistency) — independent root cause; separate fix
- Issue #472 (worktree concurrency) — independent root cause; separate fix

## Acceptance criteria

1. With default config, replaying ticket #49 (`cf1b96e8`) terminates within 300k tokens (~$5) and produces a non-empty executive summary, even if degraded vs a perfect run.
2. Healthy tickets that previously analyzed in <100k tokens continue to complete without hitting any soft-nudge.
3. Operator can change `totalTokenBudget` via the control panel and the next analysis picks up the new value.
4. All five layers (A–E) have unit-test coverage for their trigger conditions.
5. v1 paths and other v2 features (sub-task tool allowlist, KD writes, fallback compose) unchanged — verified by existing tests passing.
