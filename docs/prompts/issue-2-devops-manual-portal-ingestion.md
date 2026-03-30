# Remote Session Prompt: Issue #2 — Migrate DevOps Worker, Manual API, and Portal to Ingestion Queue

## Objective

Migrate three ticket sources from direct DB ticket creation to pushing normalized payloads into the `ticket-ingest` BullMQ queue: DevOps Worker, Manual API (`POST /api/tickets`), and Portal (`POST /api/portal-tickets`). After this, all ticket sources flow through the unified ingestion engine.

Read CLAUDE.md before starting. Read every file referenced below before making changes. Branch from `staging`.

## Branch

`fix/2-devops-manual-portal-ingestion`

## Issue

`gh issue view 2` for full context.

## Background

Issue #1 (merged) migrated the IMAP Worker to the ingestion queue. The ingestion engine (`services/ticket-analyzer/src/ingestion-engine.ts`) now handles route-driven ticket processing for both probes and emails. The pattern is proven — this issue applies the same pattern to the remaining sources.

These migrations are simpler than IMAP because:
- DevOps Worker has no email threading (threading is DevOps-specific via work item IDs)
- Manual API already has all fields provided by the operator
- Portal is similar to Manual but with portal user context

Payload types already exist in `packages/shared-types/src/ingestion.ts`: `DevOpsIngestionPayload` and `ManualIngestionPayload`.

## Steps

### Phase 1: Understand the current flow

Read these files thoroughly before writing any code:

1. `services/devops-worker/src/processor.ts` — How it creates tickets directly via `db.ticket.create()`, how it emits `ticket-created` events, how `DevOpsSyncState` tracking works
2. `services/devops-worker/src/config.ts` — Config schema
3. `services/copilot-api/src/routes/tickets.ts` — `POST /api/tickets` endpoint, how it creates tickets and emits `ticket-created` events
4. `services/copilot-api/src/routes/portal-tickets.ts` — `POST /api/portal-tickets` endpoint, how portal users create tickets
5. `packages/shared-types/src/ingestion.ts` — Existing `DevOpsIngestionPayload`, `ManualIngestionPayload` types and `IngestionJob` interface
6. `services/ticket-analyzer/src/ingestion-engine.ts` — How the ingestion engine processes jobs, the CREATE_TICKET step, the route resolution logic. This was updated in #1 — read the current version.
7. `services/ticket-analyzer/src/index.ts` — How the ingestion worker is set up

### Phase 2: Review and update shared types

1. **`packages/shared-types/src/ingestion.ts`** — Review `DevOpsIngestionPayload` and `ManualIngestionPayload`. Ensure they include all fields the ingestion engine will need:

   For `DevOpsIngestionPayload`:
   - `workItemId`, `title`, `description`, `priority`, `state`
   - `externalRef` (the Azure DevOps URL or work item reference)
   - `assignedTo`, `tags`, `areaPath` (if used for routing)
   - Any other fields currently used in ticket creation in processor.ts

   For `ManualIngestionPayload`:
   - `subject`, `description`, `priority`, `category`
   - `requesterId` (contact ID for the requester)
   - `source` (should be MANUAL)
   - Any other fields from the POST /api/tickets body

   Add a `PortalIngestionPayload` if one doesn't exist:
   - Same as ManualIngestionPayload but with `portalUserId` or `portalCreatorId`

### Phase 3: Migrate DevOps Worker

Refactor `services/devops-worker/src/processor.ts`:

1. **Keep:** Azure DevOps polling, work item fetching, `DevOpsSyncState` tracking, comment sync, linked item context gathering. These are source-specific responsibilities.

2. **Remove:** Direct `db.ticket.create()` calls for new work items. The DevOps Worker should NOT create tickets anymore.

3. **Remove:** `ticket-created` event emission. The ingestion engine handles this after creating the ticket.

4. **Add:** After work item processing, push a normalized `DevOpsIngestionPayload` to the `ticket-ingest` queue.

5. **DevOps Worker needs the `ticket-ingest` queue connection.** Add it to the worker's config and initialization. Look at how `services/imap-worker/src/processor.ts` sets up `ingestQueue` after the #1 migration.

6. **Important:** The `DevOpsSyncState` tracking (which work items have been synced) must still work. The sync state should be updated AFTER enqueueing to the ingestion queue, not after ticket creation (since ticket creation is now async). Consider: should the sync state be marked as "synced" when the job is enqueued, or when the ticket is actually created? Enqueue-time is simpler and avoids re-processing on retries.

7. **Important:** The conversational AI workflow (`services/devops-worker/src/workflow.ts`) that handles assigned work items may need adjustment. If it currently depends on having a `ticketId` immediately after creation, it will need to handle the async nature of the ingestion queue. Read the workflow code to understand this dependency.

### Phase 4: Migrate Manual API

Refactor `services/copilot-api/src/routes/tickets.ts`:

1. **The `POST /api/tickets` endpoint** should push a `ManualIngestionPayload` to the `ticket-ingest` queue instead of calling `db.ticket.create()`.

2. **Response change:** Return 202 Accepted (async) instead of 201 Created (sync), since the ticket won't exist immediately.

3. **Consider sync mode:** Some callers may need the ticket ID immediately (e.g., the control panel creating a ticket and wanting to navigate to it). Add an optional `?sync=true` query parameter that bypasses the queue and creates the ticket directly (preserving the current behavior for interactive use). Document this clearly.

4. **The `ticket-ingest` queue** is already available in copilot-api — check `services/copilot-api/src/routes/ingest.ts` for how it's set up. Reuse the same queue instance.

5. **Keep:** All other ticket endpoints (GET, PATCH, DELETE) unchanged.

### Phase 5: Migrate Portal

Refactor `services/copilot-api/src/routes/portal-tickets.ts`:

1. **The `POST /api/portal/tickets` endpoint** should push to the `ticket-ingest` queue with a payload that includes the portal user's `clientId` and `contactId`.

2. **Response change:** Return 202 Accepted. Portal users see "Ticket submitted" rather than immediate ticket details.

3. **Portal auth context:** The portal user's `clientId` comes from the JWT. This must be included in the `IngestionJob.clientId` field so the ingestion engine creates the ticket under the correct client.

4. **Keep:** All other portal endpoints (GET, comment, attachments) unchanged — they read existing tickets.

### Phase 6: Ensure ingestion routes exist

The ingestion engine resolves routes by source + client. Ensure default INGESTION routes exist for the new sources. These can be simpler than the EMAIL route since they don't need RESOLVE_THREAD or SUMMARIZE_EMAIL:

**DevOps route:**
1. `CATEGORIZE` — classify from work item content
2. `TRIAGE_PRIORITY` — set priority (or map from DevOps priority)
3. `GENERATE_TITLE` — create ticket title (or use work item title directly)
4. `CREATE_TICKET` — create in DB

**Manual route:**
1. `CREATE_TICKET` — create in DB (operator already provided all fields)

**Portal route:**
1. `CATEGORIZE` — classify from portal submission
2. `TRIAGE_PRIORITY` — set priority
3. `CREATE_TICKET` — create in DB

Seed these via the existing seed script (`packages/db/prisma/seed.ts`) following the pattern from #1's email route seed. Use well-known UUIDs for idempotent re-seeding.

### Phase 7: Verify and typecheck

1. Run `pnpm build` — fix all build errors (this also runs prisma generate and tsc)
2. Ensure no circular dependencies were introduced
3. Verify the DevOps Worker's `ticket-created` queue dependency is removed (it should no longer need `ticketCreatedQueue`)
4. Verify copilot-api's ingest queue is shared across the tickets, portal-tickets, and ingest routes

## Important constraints

- Do NOT break the IMAP Worker — it was migrated in #1 and should remain working
- Do NOT change the ingestion engine's analysis pipeline or the RESOLVE_THREAD step
- The `ticket-created` event (emitted by the ingestion engine after CREATE_TICKET) must still work so that analysis routes are dispatched
- The DevOps Worker's conversational workflow (`workflow.ts`) must still function — if it needs a ticketId, find a way to handle the async creation
- Portal auth (canAccessTicket, portalUser.clientId scoping) must remain intact for read endpoints
- Follow all CLAUDE.md conventions: const enum pattern, ESM imports with `.js` extensions, Zod config, Pino logging

## Commit format

    fix: migrate DevOps Worker, Manual API, and Portal to ingestion queue (fixes #2)

If multiple commits are needed, use descriptive messages referencing the issue:

    refactor: migrate DevOps Worker to ingestion queue (#2)
    refactor: migrate Manual API to ingestion queue with sync fallback (#2)
    refactor: migrate Portal ticket creation to ingestion queue (#2)
    feat: seed default ingestion routes for DevOps, Manual, and Portal (#2)
