# Remote Session Prompt: Issue #7 — Multi-Operator Support: Foundational Data Model and Routing

## Objective

Design and implement foundational multi-operator support so the system can scale from a single operator to a small team without architectural rework. This is not a full RBAC system — it's about ensuring the data model, notification routing, and approval workflows can accommodate multiple operators.

Read CLAUDE.md before starting. Read every file referenced below before making changes. Branch from `staging`.

## Branch

`fix/7-multi-operator-support`

## Issue

`gh issue view 7` for full context.

## Background

The system is currently single-operator. The operator (Chad) has full visibility across all clients via the control panel. However, the system needs to support hiring additional support staff without architectural rework. The areas that need "which operator?" decisions are:

- **Notifications:** Who gets notified about new tickets, plans ready for review, Contact User responses?
- **Plan approval:** Who is authorized to approve/reject resolution plans?
- **Assignment:** Can tickets or plans be assigned to a specific operator?
- **Visibility:** Shared inbox model — all operators see everything (small team).

The current auth model has: (1) API-key auth (service-to-service), (2) JWT auth for control panel operators, (3) Portal JWT for client users (scoped to clientId). This issue extends layer 2.

## Key Design Decisions

1. **Simple model:** All operators see all data (shared inbox). No per-operator data isolation.
2. **Optional assignment:** Tickets and plans can optionally be assigned to a specific operator, but unassigned items are visible to all.
3. **Notification routing:** Default: all operators receive all notifications. Future: route based on assignment.
4. **Approval audit:** Track who approved what, when.
5. **No hierarchy/roles yet:** Any operator can approve/reject. Future: reviewer vs approver roles.

## Steps

### Phase 1: Understand the current auth model

Read these files thoroughly before writing any code:

1. `packages/db/prisma/schema.prisma` — Look for any existing User or Operator model. Check how the current auth works (API key, JWT).
2. `services/copilot-api/src/routes/auth.ts` or similar — How operators authenticate to the control panel.
3. `services/copilot-api/src/routes/tickets.ts` — How tickets are created/updated, any existing assignment fields.
4. `services/copilot-api/src/routes/issue-jobs.ts` — The `approvedBy` field from #5 — currently just a string.
5. `services/control-panel/src/app/core/services/auth.service.ts` — How the control panel handles auth.

### Phase 2: Add the Operator model

1. **Create an `Operator` model** in `packages/db/prisma/schema.prisma`:
   ```
   model Operator {
     id        String   @id @default(uuid()) @db.Uuid
     email     String   @unique
     name      String
     isActive  Boolean  @default(true)
     createdAt DateTime @default(now()) @map("created_at")
     updatedAt DateTime @updatedAt @map("updated_at")

     // Notification preferences
     notifyEmail    Boolean @default(true) @map("notify_email")
     notifySlack    Boolean @default(false) @map("notify_slack")

     // Relations
     assignedTickets   Ticket[]   @relation("AssignedOperator")
     approvedJobs      IssueJob[] @relation("ApprovedByOperator")

     @@map("operators")
   }
   ```

2. **Add assignment fields** to existing models:
   - `Ticket`: add optional `assignedOperatorId` (Uuid, nullable) with relation to Operator
   - `IssueJob`: change `approvedBy` from String to a relation to Operator (or keep both — `approvedBy` as display string, `approvedByOperatorId` as FK)

3. **Create a Prisma migration.**

4. **Update shared-types** with Operator interface.

### Phase 3: Operator CRUD API

In `services/copilot-api/src/routes/`:

1. **Create `operators.ts`** with:
   - `GET /api/operators` — list all operators (active by default, `?includeInactive=true`)
   - `POST /api/operators` — create operator (email, name)
   - `PATCH /api/operators/:id` — update operator (name, isActive, notification prefs)
   - `DELETE /api/operators/:id` — soft delete (set isActive=false)

2. **Register the routes** in the Fastify app.

### Phase 4: Ticket assignment

1. **`PATCH /api/tickets/:id`** — add `assignedOperatorId` to the updateable fields. Allow null to unassign.

2. **Ticket list API** — add `?assignedOperatorId=` filter parameter to `GET /api/tickets`.

3. **Ticket events** — when a ticket is assigned/unassigned, create a `STATUS_CHANGE` or `ASSIGNMENT` event for audit trail.

### Phase 5: Notification routing

1. **Create a notification helper** (`services/copilot-api/src/services/operator-notifications.ts` or in shared-utils):
   - `notifyOperators(options)` — sends notifications to appropriate operators
   - Options: `type` (new-ticket, plan-ready, user-reply, etc.), `ticketId`, `excludeOperatorId` (don't notify the person who triggered it)
   - Default behavior: notify all active operators with `notifyEmail=true`
   - Future: if ticket is assigned, only notify the assigned operator

2. **Wire into existing notification points:**
   - Plan generation notification (issue-resolver worker) — use `notifyOperators` instead of hardcoded email
   - NOTIFY_OPERATOR step in analyzer — use `notifyOperators`
   - Any other places that send operator emails

3. **Email sending:** Reuse the existing Mailer. For each operator to notify, send an individual email (or BCC if privacy isn't a concern between operators).

### Phase 6: Approval tracking

1. **Update the approve endpoint** (`POST /api/issue-jobs/:id/approve`):
   - Accept `operatorId` instead of/in addition to `approvedBy` string
   - Store both `approvedByOperatorId` (FK) and `approvedBy` (display name) for backward compat
   - Validate that the operatorId exists and is active

2. **Audit in ticket events:** When a plan is approved/rejected, include the operator ID in the event metadata.

### Phase 7: Seed a default operator

In the seed script (`packages/db/prisma/seed.ts`):
- Create a default operator with the configured admin email
- This ensures the system works out of the box for the single-operator case

### Phase 8: Verify and typecheck

1. Run `pnpm build` — fix all build errors
2. Ensure Prisma migration is clean
3. Verify: create operator → assign ticket → approve plan → audit trail shows operator

## Important constraints

- Do NOT add per-operator data isolation — all operators see all data (shared inbox model)
- Do NOT add roles or permissions — any active operator can do anything (for now)
- Do NOT break the existing single-operator flow — if no operators exist in the DB, the system should fall back to current behavior (hardcoded email, string-based approvedBy)
- The Operator model should be optional — existing deployments without operators should still work
- Follow all CLAUDE.md conventions: const enum pattern, ESM imports with `.js` extensions, Zod config, Pino logging
- Include Prisma migration

## Commit format

    feat: add multi-operator support with foundational data model and routing (fixes #7)

If multiple commits are needed:

    feat: add Operator model and ticket assignment (#7)
    feat: add operator CRUD API endpoints (#7)
    feat: add operator notification routing (#7)
    feat: wire operator identity into plan approval (#7)
