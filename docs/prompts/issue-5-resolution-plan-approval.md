# Remote Session Prompt: Issue #5 — Resolution Worker Plan Generation with Approval Loop

## Objective

Refactor the Resolution Worker (issue-resolver) to generate a resolution plan and wait for operator approval before executing code changes. When a ticket passes the sufficiency gate, the system auto-generates a lightweight plan, notifies the operator (email + control panel visibility), and waits for approval. On approval, it executes by pushing code to a feature branch.

Read CLAUDE.md before starting. Read every file referenced below before making changes. Branch from `staging`.

## Branch

`fix/5-resolution-plan-approval`

## Issue

`gh issue view 5` for full context.

## Background

The current issue-resolver is fire-and-forget: trigger a job → Claude generates code changes in one shot → pushes to a branch. No plan is generated, no operator is notified, no approval is required.

The DevOps Worker (`services/devops-worker/src/workflow.ts`) already implements an approval workflow: `ANALYZING → QUESTIONING → PLANNING → AWAITING_APPROVAL → EXECUTING → COMPLETED`. This is the proven pattern to follow.

Issue #3 (merged) added a `sufficiencyStatus` field to tickets. A ticket should only be eligible for resolution planning when `sufficiencyStatus === 'SUFFICIENT'`.

## Key Design Decisions

1. **Plan format:** Light by default — natural language summary of the approach. Operator can request a detailed breakdown.
2. **Plan output categories:** Each action in the plan is categorized as: (a) "I'll do this" — code changes within current capability, (b) "I can do this if you allow it" — capable but restricted by config/permissions, (c) "I can't do this" — genuinely outside system capability, with manual steps for the operator.
3. **Approval mechanism:** Email notification + control panel visibility. Operator approves/rejects via API endpoint.
4. **Rejection loop:** Regenerate plan incorporating feedback, show diff of what changed. Operator can request the full updated plan.
5. **Execution on approval:** Create branch, apply changes, commit, push — same mechanics as current issue-resolver but only after approval.

## Steps

### Phase 1: Understand the current issue-resolver

Read these files thoroughly before writing any code:

1. `services/issue-resolver/src/worker.ts` — Current BullMQ worker. Understand the status progression: PENDING → CLONING → ANALYZING → APPLYING → PUSHING → COMPLETED.
2. `services/issue-resolver/src/resolver.ts` — Claude integration for code analysis and generation. Single-shot prompt that returns file changes.
3. `services/issue-resolver/src/git.ts` — Git operations: clone, branch, commit, push. Branch safety enforcement.
4. `services/copilot-api/src/routes/issue-jobs.ts` — API endpoint that triggers resolution jobs. Validates ticket/repo ownership.
5. `packages/db/prisma/schema.prisma` — The `IssueJob` model with its current status enum.
6. `services/devops-worker/src/workflow.ts` — The approval pattern to follow.

### Phase 2: Extend the IssueJob model

1. **Add new status values** to the `IssueJobStatus` enum in both shared-types and Prisma:
   - `PLANNING` — generating the resolution plan
   - `AWAITING_APPROVAL` — plan generated, waiting for operator
   - Add these between `ANALYZING` and `APPLYING` in the progression

2. **Add new fields** to the `IssueJob` model:
   - `plan` (Json, nullable) — the generated plan
   - `planRevision` (Int, default 0) — incremented on each regeneration
   - `planFeedback` (String, nullable) — operator's rejection feedback
   - `approvedAt` (DateTime, nullable) — when the plan was approved
   - `approvedBy` (String, nullable) — who approved (operator identifier)

3. **Create a Prisma migration** for the schema changes.

4. **Update shared-types** to match: add `IssueJobStatus` values, add plan-related fields to any shared interfaces.

### Phase 3: Implement plan generation

In `services/issue-resolver/src/resolver.ts` (or a new `planner.ts`):

1. **Add a `generatePlan()` function** that:
   - Takes the same inputs as the current `resolveIssue()` (ticket context, repo context)
   - Asks Claude to generate a plan instead of code changes
   - The prompt should instruct Claude to:
     - Describe the approach in natural language (light plan)
     - Categorize each action as: "I'll do this", "I can do this if you allow it", "I can't do this"
     - For "I can't do this" items, provide manual steps for the operator
     - Include assumptions and open questions
   - Returns a structured plan object (not code changes)

2. **Plan structure:**
   ```typescript
   interface ResolutionPlan {
     summary: string;  // 2-3 sentence overview
     approach: string;  // detailed approach description
     actions: Array<{
       description: string;
       category: 'WILL_DO' | 'CAN_DO_IF_ALLOWED' | 'CANNOT_DO';
       files?: string[];  // affected files for WILL_DO items
       manualSteps?: string;  // for CANNOT_DO items
       requirement?: string;  // what config/permission would unlock CAN_DO_IF_ALLOWED
     }>;
     assumptions: string[];
     openQuestions: string[];
     estimatedFiles: number;
   }
   ```

3. **Add a `regeneratePlan()` function** that:
   - Takes the original plan + operator feedback
   - Asks Claude to revise the plan incorporating the feedback
   - Returns both the updated plan and a diff summary of what changed

### Phase 4: Modify the worker flow

Refactor `services/issue-resolver/src/worker.ts`:

1. **New status progression:**
   ```
   PENDING → CLONING → ANALYZING → PLANNING → AWAITING_APPROVAL → APPLYING → PUSHING → COMPLETED
   ```

2. **PLANNING phase:** After ANALYZING (gathering repo context), call `generatePlan()` instead of directly generating code changes. Store the plan in `IssueJob.plan`. Set status to `AWAITING_APPROVAL`.

3. **AWAITING_APPROVAL phase:** The worker stops here. It does NOT poll for approval — that's handled by the API endpoint triggering a new job or resuming the existing one.

4. **On approval:** The worker resumes from AWAITING_APPROVAL, reads the approved plan, calls the existing `resolveIssue()` to generate code changes (now guided by the plan), then continues to APPLYING → PUSHING → COMPLETED.

5. **On rejection:** The worker receives feedback, calls `regeneratePlan()`, updates the plan and planRevision, sends notification, returns to AWAITING_APPROVAL.

### Phase 5: Add approval API endpoints

In `services/copilot-api/src/routes/issue-jobs.ts`:

1. **`POST /api/issue-jobs/:id/approve`** — Approve a plan:
   - Validate job exists and is in AWAITING_APPROVAL status
   - Set `approvedAt`, `approvedBy`
   - Resume the worker (re-enqueue the job with updated status, or use a separate approval queue)

2. **`POST /api/issue-jobs/:id/reject`** — Reject with feedback:
   - Validate job exists and is in AWAITING_APPROVAL status
   - Store feedback in `planFeedback`
   - Trigger plan regeneration (re-enqueue with PLANNING status)

3. **`POST /api/issue-jobs/:id/detail`** — Request detailed plan:
   - Validate job exists and has a plan
   - Trigger detailed plan generation (expand the light plan to heavy)
   - Return the detailed plan

4. **`GET /api/issue-jobs/:id/plan`** — Get the current plan:
   - Return the plan JSON, revision number, status, and any feedback

### Phase 6: Operator notification

When a plan is generated (or regenerated):

1. **Email notification** to the operator using the existing Mailer infrastructure. The email should include:
   - Plan summary
   - Action categories breakdown
   - A note: "Reply for more details or with feedback. Approve/reject in the control panel."
   - Link to the control panel (if base URL is configured)

2. **Use the existing NOTIFY_OPERATOR step pattern** from the analyzer, or send directly from the worker.

3. **Control panel visibility:** The plan is stored in `IssueJob.plan` and visible via `GET /api/issue-jobs/:id/plan`. The control panel can show it on the ticket detail or a dedicated resolution view. (UI changes are out of scope for this issue — just ensure the API returns the data.)

### Phase 7: Sufficiency gate

Before allowing plan generation:

1. When `POST /api/issue-jobs` is called, check `ticket.sufficiencyStatus`:
   - If `SUFFICIENT`: proceed with job creation
   - If `NEEDS_USER_INPUT` or `INSUFFICIENT`: return 400 with message explaining the ticket needs more analysis first
   - If null (legacy tickets without sufficiency evaluation): allow — don't block old tickets

2. Add an override parameter `?force=true` that bypasses the sufficiency check (operator manual override).

### Phase 8: Verify and typecheck

1. Run `pnpm build` — fix all build errors
2. Ensure Prisma migration is clean
3. Verify the flow: trigger job → clone → analyze → generate plan → notify → wait → approve → execute → push

## Important constraints

- Do NOT break existing issue resolution for jobs already in progress
- The git safety layer (branch protection, path traversal checks) must remain intact
- Plan generation should use the AIRouter with task type RESOLVE_ISSUE (or a new GENERATE_PLAN task type) for proper model routing
- The worker must handle restarts gracefully — if the worker restarts while in AWAITING_APPROVAL, the job should resume correctly when approval comes
- Email notification should be non-blocking — if email fails, the plan is still stored and visible in the API
- Follow all CLAUDE.md conventions: const enum pattern, ESM imports with `.js` extensions, Zod config, Pino logging
- Include Prisma migration

## Commit format

    feat: add plan generation with operator approval loop to resolution worker (fixes #5)

If multiple commits are needed:

    feat: extend IssueJob model with plan and approval fields (#5)
    feat: implement plan generation in resolution worker (#5)
    feat: add approval/rejection API endpoints (#5)
    feat: add operator notification on plan generation (#5)
    feat: add sufficiency gate to issue job creation (#5)
