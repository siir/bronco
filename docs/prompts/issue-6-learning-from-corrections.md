# Remote Session Prompt: Issue #6 — Learning from Corrections via Client Memory

## Objective

Implement a learning system where the Resolution Worker captures operator corrections and rejections from the plan approval loop and stores them as client memory entries. These memories are automatically injected into future plan generation, improving plan quality over time.

Read CLAUDE.md before starting. Read every file referenced below before making changes. Branch from `staging`.

## Branch

`fix/6-learning-from-corrections`

## Issue

`gh issue view 6` for full context.

## Background

The `ClientMemory` system already exists with `AI_LEARNED` source type and automatic injection into AI contexts via `ClientMemoryResolver`. The infrastructure is in place — this issue connects the resolution approval loop (#5, merged) to the memory system so that corrections compound.

When an operator rejects a plan with feedback ("don't modify stored procedures directly, always go through the application layer"), that correction should become a memory entry scoped to the client. Next time the Plan Worker generates a plan for that client, the memory is auto-injected and it knows not to go down that road.

## Key Design Decisions

1. **Learn from rejections** (explicit corrections) — highest value signal.
2. **Learn from approvals** (implicit validation) — lower weight, builds preference profile.
3. **Learn from iterated plans** (what changed between revisions) — captures direction of corrections.
4. **Memory format:** Use existing `ClientMemory` model with `source: AI_LEARNED`.
5. **Avoid duplicates:** Check for similar existing memories before creating new ones.
6. **Operator visibility:** Learned memories appear in the control panel's Memory tab, editable/deletable.

## Steps

### Phase 1: Understand the existing memory system

Read these files thoroughly before writing any code:

1. `packages/shared-types/src/client-memory.ts` — `MemoryType`, `MemorySource` enums, `ClientMemory` interface
2. `packages/ai-provider/src/client-memory-resolver.ts` — Resolver with caching, category/tag filtering, markdown composition. Understand how memories are fetched and injected into AI contexts.
3. `services/copilot-api/src/routes/client-memory.ts` — CRUD API endpoints with cache invalidation.
4. `packages/ai-provider/src/router.ts` — How `AIRouter.generate()` auto-injects client memory when `clientId` is present.
5. `services/issue-resolver/src/worker.ts` — The approval loop from #5. Understand where approvals and rejections happen.
6. `services/issue-resolver/src/planner.ts` — Plan generation and regeneration. Understand what context is available.

### Phase 2: Create the learning extraction function

Create a new file `services/issue-resolver/src/learner.ts` (or add to an existing file):

1. **`extractLearningFromRejection()`** — Called when an operator rejects a plan:
   - Inputs: the rejected plan, the operator's feedback, the ticket category, the client ID
   - Uses AIRouter to ask Claude: "Given this plan was rejected with this feedback, what is the reusable lesson? Express it as a concise rule that should apply to future plans for this client."
   - Use task type `CUSTOM_AI_QUERY` (this is a one-off analytical call, not a standard task)
   - Returns: structured learning with `title`, `content`, `memoryType` (CONTEXT or PLAYBOOK), and optional `category` scope

2. **`extractLearningFromApproval()`** — Called when an operator approves a plan:
   - Lighter weight — only extract if the approach was non-obvious
   - Ask Claude: "Was there anything notable or non-obvious about this approved plan's approach that should be remembered for future similar issues?"
   - If Claude says "nothing notable," skip creating a memory
   - Returns: structured learning or null

3. **`extractLearningFromIteration()`** — Called when a plan is regenerated after rejection:
   - Compare the previous plan and the new plan
   - Ask Claude: "What direction did the correction take? Express this as a preference or constraint for future plans."
   - Returns: structured learning

### Phase 3: Integrate with the approval loop

In `services/issue-resolver/src/worker.ts`:

1. **On approval:** After setting `approvedAt`/`approvedBy` and before resuming execution:
   - Call `extractLearningFromApproval()` in the background (non-blocking)
   - If a learning is extracted, create a `ClientMemory` entry

2. **On rejection (during regeneration):** After `regeneratePlan()` succeeds:
   - Call `extractLearningFromRejection()` with the previous plan and feedback
   - Also call `extractLearningFromIteration()` comparing previous and new plan
   - Create `ClientMemory` entries for each non-null learning

3. **All memory creation should be non-blocking** — wrap in try/catch, log errors but don't fail the job. Learning is observability, not correctness.

### Phase 4: Create client memory entries

When creating learned memories:

1. **Check for duplicates first:** Before creating, search existing `AI_LEARNED` memories for the client that cover the same topic. Use a simple content similarity check (e.g., ask Claude "Is this new learning already covered by any of these existing memories?") or a keyword overlap check.

2. **If duplicate found:** Update the existing memory (append new context, update timestamp) rather than creating a new one.

3. **Memory fields:**
   - `clientId` — from the ticket
   - `type` — `CONTEXT` for general preferences, `PLAYBOOK` for specific procedures
   - `source` — `AI_LEARNED`
   - `category` — scope to the ticket's category if the learning is category-specific, null if general
   - `title` — concise title for the learning (e.g., "Prefer application-layer changes over direct SP modification")
   - `content` — the full learning content in markdown
   - `isActive` — true
   - `tags` — include `resolution-learning`, `plan-rejection` or `plan-approval` for filtering

4. **Invalidate the ClientMemoryResolver cache** after creating/updating memories so they're immediately available for the next plan generation.

### Phase 5: Ensure memories are injected into plan generation

Verify that when `generatePlan()` and `regeneratePlan()` call `AIRouter.generate()`:

1. The `clientId` is passed in `context` — this triggers auto-injection of client memories.
2. The learned memories (with `source: AI_LEARNED`) are included in the injection.
3. The plan generation prompt benefits from the injected context without any additional wiring.

If the planner currently bypasses the AIRouter or doesn't pass `clientId`, fix that.

### Phase 6: Add a reference to the source ticket

Each learned memory should include a reference to the ticket that generated it:

1. Add a `metadata` field or use `tags` to include the source ticket ID.
2. This provides traceability — operators can see which ticket/plan generated a learning.
3. The memory content can also include a brief note like "Learned from resolution of ticket #XYZ."

### Phase 7: Verify and typecheck

1. Run `pnpm build` — fix all build errors
2. Verify the flow: reject plan → extract learning → create memory → next plan generation includes the learned memory
3. Ensure ClientMemoryResolver cache is invalidated after memory creation

## Important constraints

- Do NOT modify the ClientMemory model or schema — it already has all needed fields
- Do NOT modify the ClientMemoryResolver — it already handles AI_LEARNED memories
- Learning extraction must be non-blocking — never fail a job because learning extraction failed
- Use `CUSTOM_AI_QUERY` task type for learning extraction calls (per task type discipline in CLAUDE.md)
- Avoid creating duplicate memories — check before creating
- Follow all CLAUDE.md conventions: const enum pattern, ESM imports with `.js` extensions, Zod config, Pino logging
- The `GENERATE_DEVOPS_PLAN` task type is for DevOps workflow plans (Ollama). The `GENERATE_RESOLUTION_PLAN` task type is for code resolution plans (Claude). Do not reuse or confuse them.

## Commit format

    feat: add learning from corrections via client memory (fixes #6)

If multiple commits are needed:

    feat: add learning extraction functions for plan approval loop (#6)
    feat: integrate learning extraction with resolution worker (#6)
    feat: add duplicate detection for learned memories (#6)
