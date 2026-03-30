# Remote Session Prompt: Issue #3 — Agentic Analysis Sufficiency Evaluation + Contact User

## Objective

Enhance the `AGENTIC_ANALYSIS` step to evaluate information sufficiency and proactively contact the user (the client who submitted the ticket) when it can't gather enough information from system sources alone. The system should always produce its best-effort analysis, but gate the handoff to the Resolution Worker on having sufficient information.

Read CLAUDE.md before starting. Read every file referenced below before making changes. Branch from `staging`.

## Branch

`fix/3-sufficiency-contact-user`

## Issue

`gh issue view 3` for full context.

## Background

The current `AGENTIC_ANALYSIS` step iterates with MCP tool calls (database health, repo search, etc.) until Claude decides to stop. But it has no ability to:
1. Explicitly evaluate whether it has enough info to produce a complete analysis
2. Reach outside the system boundary to ask the user for clarification
3. Signal that the ticket isn't ready for resolution planning

The architecture flow diagram shows sufficiency evaluation and contact-user as decision points *within* the agentic analysis — not as pipeline-level branching. The agent should gather system info (detective), recognize when it's exhausted system sources, and contact the user with specific questions.

## Key Design Decisions

1. The agentic loop should be able to signal three outcomes: SUFFICIENT, NEEDS_USER_INPUT, INSUFFICIENT.
2. When NEEDS_USER_INPUT: the system sends its best-effort findings PLUS specific questions to the user, sets ticket status to WAITING, and blocks resolution handoff.
3. When a user replies (handled by UPDATE_ANALYSIS from #4), sufficiency is re-evaluated.
4. The system always sends its best analysis regardless of sufficiency — the gate only controls whether the ticket proceeds to resolution planning.
5. "Sufficient for resolution" is a higher bar than "sufficient to send findings."

## Steps

### Phase 1: Understand the current agentic analysis

Read these files thoroughly before writing any code:

1. `services/ticket-analyzer/src/analyzer.ts` — Search for `AGENTIC_ANALYSIS`. Understand:
   - How the multi-turn tool loop works (Claude calls MCP tools, results appended, loop continues)
   - How the loop terminates (Claude returns text instead of tool_use)
   - The max iterations guard
   - How conversation-aware re-analysis works
   - How the analysis result is stored as an AI_ANALYSIS event

2. `services/ticket-analyzer/src/analyzer.ts` — Search for `DRAFT_FINDINGS_EMAIL`. Understand how findings are sent to the user.

3. `packages/shared-types/src/ticket.ts` — The TicketStatus enum (OPEN, WAITING, IN_PROGRESS, RESOLVED, CLOSED).

4. `packages/shared-types/src/ticket-route.ts` — RouteStepType enum.

### Phase 2: Add sufficiency signaling to the agentic loop

The agentic analysis loop currently lets Claude call tools until it decides to stop and return text. Extend this so Claude can also signal sufficiency status.

**Approach: Structured output in the final response.**

When the agentic loop terminates (Claude returns text, not tool_use), instruct Claude to include a structured suffix in its response:

```
---SUFFICIENCY---
STATUS: SUFFICIENT | NEEDS_USER_INPUT | INSUFFICIENT
QUESTIONS: [only if NEEDS_USER_INPUT — specific questions for the user, one per line]
CONFIDENCE: HIGH | MEDIUM | LOW
REASON: [brief explanation of why this status was chosen]
```

Parse this suffix from the analysis response. Strip it from the displayed analysis (users should see clean findings, not internal metadata).

**Modify the system prompt** for AGENTIC_ANALYSIS to include:
- Instructions to evaluate sufficiency before concluding
- The structured suffix format
- Guidelines: SUFFICIENT means "I have enough context to propose a resolution plan." NEEDS_USER_INPUT means "I've exhausted system sources but have specific questions only the user can answer." INSUFFICIENT means "I can't determine what's needed — flag for operator review."

### Phase 3: Store sufficiency status

After parsing the sufficiency signal:

1. **Store in the AI_ANALYSIS event metadata:** Add `sufficiencyStatus`, `sufficiencyQuestions`, `sufficiencyConfidence`, `sufficiencyReason` fields.

2. **Store on the ticket:** Add a `sufficiencyStatus` field to the Ticket model (or use an existing field/metadata pattern). This is what the Resolution Worker (#5) will check before generating plans.
   - If adding a new field: update `packages/db/prisma/schema.prisma`, create a migration, update shared-types.
   - Alternative: use the ticket's `analysisStatus` field or a metadata JSON field if one exists. Check what fields the ticket model already has before adding new ones.

3. **Update ticket status:** When NEEDS_USER_INPUT, set `ticket.status = 'WAITING'` so the ticket appears as waiting for user response in the control panel.

### Phase 4: Implement Contact User capability

When the sufficiency evaluation returns NEEDS_USER_INPUT:

1. **Compose a combined email** that includes:
   - The best-effort analysis findings (what the system figured out)
   - A clearly separated "Questions" section with the specific questions Claude identified
   - A prompt for the user to reply with answers

2. **Reuse the existing email sending infrastructure.** The DRAFT_FINDINGS_EMAIL step already sends emails. The difference is:
   - The email body includes the questions section
   - The ticket status is set to WAITING (not just the default post-findings status)
   - The email subject or tone indicates the system needs more info

3. **Implementation options:**
   - **Option A:** Modify DRAFT_FINDINGS_EMAIL to check sufficiency status and include questions if NEEDS_USER_INPUT. This keeps the pipeline simple.
   - **Option B:** Add a new CONTACT_USER step type that handles the question email. This is cleaner but adds more step types.

   Prefer Option A for simplicity — the findings email already has the right infrastructure.

### Phase 5: Connect to UPDATE_ANALYSIS (from #4)

When the user replies and UPDATE_ANALYSIS runs:

1. The update analysis step should re-evaluate sufficiency. Add the same structured suffix parsing to UPDATE_ANALYSIS.

2. If now SUFFICIENT: update the ticket's sufficiency status, change ticket status from WAITING to OPEN (or IN_PROGRESS).

3. If still NEEDS_USER_INPUT: send another round of questions (with refined/updated questions based on the user's partial answers). Keep ticket in WAITING.

4. If diminishing returns (e.g., 3+ rounds of questions with no progress): set to INSUFFICIENT and flag for operator review via NOTIFY_OPERATOR step.

### Phase 6: Resolution handoff gate

Add a check that the Resolution Worker (#5, future) will use:

1. A ticket should only be eligible for resolution planning when `sufficiencyStatus === 'SUFFICIENT'`.

2. For now, this is just the data — the actual gate will be implemented in #5. But ensure the field exists and is populated so #5 can consume it.

3. An operator should be able to manually override sufficiency (e.g., force a ticket to SUFFICIENT via the API or control panel). Add an API endpoint or a field on the PATCH /api/tickets endpoint.

### Phase 7: Verify and typecheck

1. Run `pnpm build` — fix all build errors
2. If Prisma schema changed, ensure migration is clean
3. Test the flow mentally: AGENTIC_ANALYSIS runs → evaluates sufficiency → if NEEDS_USER_INPUT → email with questions → user replies → UPDATE_ANALYSIS → re-evaluate → eventually SUFFICIENT

## Important constraints

- Do NOT break the existing AGENTIC_ANALYSIS flow — it must still work for tickets that don't need user input
- Do NOT break UPDATE_ANALYSIS from #4 — extend it, don't replace it
- The sufficiency parsing must be robust — if Claude doesn't include the suffix (e.g., older prompts, model issues), default to SUFFICIENT to avoid blocking tickets
- The DRAFT_FINDINGS_EMAIL step must still work for tickets without sufficiency evaluation (backward compatible)
- Keep the max re-analysis cycle guard (10 cycles) — apply it across the sufficiency question loop too
- Follow all CLAUDE.md conventions: const enum pattern, ESM imports with `.js` extensions, Zod config, Pino logging
- Include Prisma migration if schema changes

## Commit format

    feat: add sufficiency evaluation and contact user to agentic analysis (fixes #3)

If multiple commits are needed:

    feat: add sufficiency signaling to agentic analysis loop (#3)
    feat: store sufficiency status on ticket and AI_ANALYSIS events (#3)
    feat: include questions in findings email when NEEDS_USER_INPUT (#3)
    feat: re-evaluate sufficiency in UPDATE_ANALYSIS step (#3)
