# Remote Session Prompt: Issue #4 — Update Analysis Step for Incremental Reply Handling

## Objective

Add an `UPDATE_ANALYSIS` route step type that handles replies to existing tickets with incremental analysis rather than re-running the full analysis pipeline. When new information arrives (user reply), the update step builds on prior results instead of starting from scratch.

Read CLAUDE.md before starting. Read every file referenced below before making changes. Branch from `staging`.

## Branch

`fix/4-update-analysis-step`

## Issue

`gh issue view 4` for full context.

## Background

Currently, when a user replies to a ticket that has completed analysis, the system triggers a full re-analysis: it re-runs EXTRACT_FACTS, GATHER_DB_CONTEXT, DEEP_ANALYSIS, etc. with prior context appended to the prompt. This is wasteful — the full analysis should only run once. Every subsequent pass should be an incremental update that asks: "Given what we already concluded, does this new info change anything, fill gaps, or answer open questions?"

The RESOLVE_THREAD step (added in #1) already handles routing replies to existing tickets. When a reply is detected, it appends an EMAIL_INBOUND event and enqueues a re-analysis job. This issue changes what happens when that re-analysis job runs.

## Key Design Decisions

1. The full analysis only ever runs once per ticket.
2. Every subsequent pass after a reply is an Update Analysis — incremental, not full.
3. Update Analysis receives the new reply content and has access to all prior analysis results (stored as ticket events).
4. It asks Claude a focused question: "Here's our prior analysis and findings. The user replied with [X]. Does this change our conclusions, fill gaps, or answer open questions?"
5. The output is a delta — only what changed. If the new info contradicts prior findings, the step explicitly calls that out.
6. After update analysis, the system sends updated findings via DRAFT_FINDINGS_EMAIL (reusing the existing step).

## Steps

### Phase 1: Understand the current re-analysis flow

Read these files thoroughly before writing any code:

1. `services/ticket-analyzer/src/analyzer.ts` — Search for `reanalysis`. Understand:
   - How re-analysis is currently triggered (the `reanalysis: true` flag on analysis jobs)
   - How conversation history is loaded from ticket events
   - Which steps are skipped during re-analysis (triage steps)
   - How the agentic analysis loop works in "conversation-aware" mode
   - The `reanalysisCount` tracking and max cycle guard

2. `services/ticket-analyzer/src/ingestion-engine.ts` — Search for `maybeEnqueueReanalysis`. Understand how the RESOLVE_THREAD step triggers re-analysis after appending a reply event.

3. `packages/shared-types/src/ticket-route.ts` — The `RouteStepType` enum where you'll add `UPDATE_ANALYSIS`.

4. `services/copilot-api/src/routes/ticket-routes.ts` — The step type registry where new step types are registered.

### Phase 2: Add UPDATE_ANALYSIS step type

1. **`packages/shared-types/src/ticket-route.ts`** — Add `UPDATE_ANALYSIS` to the `RouteStepType` enum (const object + type pattern).

2. **`packages/db/prisma/schema.prisma`** — Add `UPDATE_ANALYSIS` to the Prisma `RouteStepType` enum. Create a migration: `npx prisma migrate dev --name add_update_analysis_step_type`.

3. **`services/copilot-api/src/routes/ticket-routes.ts`** — Register `UPDATE_ANALYSIS` in the step type registry with metadata (description, applicable route types, default task type).

### Phase 3: Implement the UPDATE_ANALYSIS step handler

In `services/ticket-analyzer/src/analyzer.ts`, add a new case in the route step switch:

```
case RouteStepType.UPDATE_ANALYSIS: {
  // 1. Load conversation history (prior analysis events, findings emails, user replies)
  // 2. Identify the most recent user reply (the trigger for this update)
  // 3. Compose a focused prompt:
  //    - System: "You are reviewing a prior analysis in light of new information from the user."
  //    - Include: prior analysis summary, prior findings, the new reply
  //    - Ask: "Does this new information change your prior analysis? Fill any gaps?
  //            Answer any open questions? Provide only what has changed or been resolved."
  // 4. Call Claude via AIRouter with task type DEEP_ANALYSIS (or a new UPDATE_ANALYSIS task type)
  // 5. Store the result as a new AI_ANALYSIS ticket event with metadata indicating it's an update
  // 6. Update the ticket summary if conclusions changed
}
```

Key implementation details:

- **Loading conversation history:** Use the existing `loadConversationHistory()` and `formatConversationHistory()` functions already in analyzer.ts (they load AI_ANALYSIS, COMMENT, EMAIL_OUTBOUND, AI_RECOMMENDATION, EMAIL_INBOUND events).

- **Identifying the trigger reply:** The re-analysis job should include `triggerEventId` — the ID of the EMAIL_INBOUND event that triggered this update. Load that specific event to get the user's reply content.

- **Prompt composition:** Keep it focused. The prior analysis is already in the conversation history. The prompt should be:
  ```
  ## Prior Analysis Context
  [formatted conversation history]

  ## New Information from User
  [reply content]

  ## Your Task
  Review the prior analysis in light of this new information. Report only:
  1. What conclusions have changed (and why)
  2. What gaps have been filled
  3. What open questions have been answered
  4. Any NEW questions or concerns raised by the reply

  If nothing has materially changed, say so briefly.
  ```

- **MCP tools:** The update analysis should NOT re-gather DB context or repo context unless the user's reply specifically mentions something that requires it. Keep it focused on the delta. If MCP tool calls are needed, the agentic loop pattern can be used, but limit iterations (e.g., max 3 vs the default 10).

- **Event metadata:** When storing the AI_ANALYSIS event, include metadata like `{ type: 'update_analysis', triggerEventId, reanalysisCount }` to distinguish from the initial full analysis.

### Phase 4: Modify re-analysis routing

The current re-analysis flow in the analyzer uses the same analysis route but skips triage steps. Change this:

1. When a re-analysis job arrives (job data has `reanalysis: true`):
   - Instead of running the full ANALYSIS route with triage steps skipped
   - Run ONLY the `UPDATE_ANALYSIS` step followed by `DRAFT_FINDINGS_EMAIL`
   - This can be done by creating a dedicated "update" route or by having the analyzer check for re-analysis and shortcut to just these two steps

2. Keep the `reanalysisCount` guard — max 10 update cycles per ticket. On the limit, warn the operator instead of the user.

3. Keep the loop prevention logic (don't trigger update analysis from the system's own outbound emails).

### Phase 5: Wire up default ANALYSIS routes with UPDATE_ANALYSIS

Update or create default ANALYSIS routes that include UPDATE_ANALYSIS for re-analysis scenarios. The route resolver should be able to distinguish between first-time analysis and re-analysis.

Options:
- **Option A:** Add UPDATE_ANALYSIS to existing ANALYSIS routes. The step handler checks if this is a re-analysis (via job metadata) and skips if it's the first analysis.
- **Option B:** Create a separate "Update Analysis" route that the system uses for re-analysis instead of the main ANALYSIS route.
- **Option C:** Have the route dispatcher select a different route when the job has `reanalysis: true`.

Option C is cleanest — the route dispatcher already resolves routes by source + client. Adding a `reanalysis` flag to the resolution logic keeps the step handlers simple.

### Phase 6: Update the seed

Add UPDATE_ANALYSIS to default ANALYSIS routes in the seed script (`packages/db/prisma/seed.ts`). Or create a dedicated re-analysis route. Follow the idempotent pattern from #1 (delete/recreate steps on re-seed).

### Phase 7: Verify and typecheck

1. Run `pnpm build` — fix all build errors
2. Ensure Prisma migration is clean
3. Verify the re-analysis flow: RESOLVE_THREAD detects reply → enqueues re-analysis → UPDATE_ANALYSIS runs → DRAFT_FINDINGS_EMAIL sends updated findings

## Important constraints

- Do NOT remove or break the full analysis pipeline — it must still work for first-time analysis
- Do NOT change the RESOLVE_THREAD step or the ingestion engine
- The existing `reanalysisCount` guard and loop prevention must remain functional
- The UPDATE_ANALYSIS step should produce a clearly labeled delta, not a full re-analysis
- Follow all CLAUDE.md conventions: const enum pattern, ESM imports with `.js` extensions, Zod config, Pino logging
- Include the Prisma migration in the commit

## Commit format

    feat: add UPDATE_ANALYSIS step for incremental reply handling (fixes #4)

If multiple commits are needed:

    feat: add UPDATE_ANALYSIS step type and migration (#4)
    feat: implement UPDATE_ANALYSIS step handler (#4)
    refactor: route re-analysis through UPDATE_ANALYSIS instead of full pipeline (#4)
