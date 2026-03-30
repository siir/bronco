# Remote Session Prompt: Issue #1 — Migrate IMAP Worker to Ingestion Queue

## Objective

Refactor the IMAP Worker so it becomes a thin collector + noise filter that pushes normalized email payloads to the `ticket-ingest` BullMQ queue. Move email threading, ticket creation, and re-analysis triggering out of the IMAP Worker and into the ingestion engine.

Read CLAUDE.md before starting. Read every file referenced below before making changes. Branch from `staging`.

## Branch

`fix/1-imap-ingestion-migration`

## Issue

`gh issue view 1` for full context.

## Background

Currently the IMAP Worker (`services/imap-worker/src/processor.ts`) does too much:
- Polls IMAP mailbox
- Parses raw emails
- Filters noise (pattern + AI classification)
- Resolves email threads (Message-ID, In-Reply-To, References, subject matching)
- Creates tickets directly in the DB via `db.ticket.create()`
- Triggers re-analysis when replies come in on existing tickets

The ingestion engine (`services/ticket-analyzer/src/ingestion-engine.ts`) already handles route-driven ticket processing for probes via the `ticket-ingest` BullMQ queue. `EmailIngestionPayload` is already defined in `packages/shared-types/src/ingestion.ts` but unused.

The goal is to split responsibilities:
- **IMAP Worker keeps:** IMAP polling, email parsing, noise filtering, pushing to queue
- **Ingestion Engine gains:** email threading (new `RESOLVE_THREAD` step), ticket creation, reply handling

## Steps

### Phase 1: Understand the current flow

Read these files thoroughly before writing any code:

1. `services/imap-worker/src/processor.ts` — the main processor. Understand:
   - How noise filtering works (pattern + AI classification)
   - How threading works (Message-ID matching, subject fallback, time window)
   - How tickets are created (direct `db.ticket.create()`)
   - How re-analysis is triggered on replies (lines ~498-606)
   - How `ticket-created` events are emitted

2. `services/imap-worker/src/poller.ts` — IMAP polling loop
3. `services/imap-worker/src/config.ts` — config schema
4. `packages/shared-types/src/ingestion.ts` — existing `EmailIngestionPayload` type and `IngestionJob` interface
5. `services/ticket-analyzer/src/ingestion-engine.ts` — how the ingestion engine processes jobs, how route steps work, how `CREATE_TICKET` works
6. `services/ticket-analyzer/src/index.ts` — how the ingestion worker is set up
7. `packages/shared-types/src/ticket-route.ts` — `RouteStepType` enum and route types
8. `services/ticket-analyzer/src/route-dispatcher.ts` — how routes are matched to jobs

### Phase 2: Update shared types

1. **`packages/shared-types/src/ingestion.ts`** — Review `EmailIngestionPayload`. Ensure it includes all fields the ingestion engine will need for threading and ticket creation:
   - `from`, `to`, `subject`, `body` (text and/or HTML)
   - `messageId`, `inReplyTo`, `references` (array of Message-IDs)
   - `date` (email date)
   - `contactId` (if sender was resolved to a contact by IMAP Worker)
   - `clientId` (resolved by IMAP Worker from sender domain)
   - `attachments` (metadata, not full content — attachments should be stored by IMAP Worker before queueing)
   - Any other fields currently used by the threading or ticket creation logic in processor.ts

2. **`packages/shared-types/src/ticket-route.ts`** — Add `RESOLVE_THREAD` to the `RouteStepType` enum (const object + type pattern per CLAUDE.md conventions).

### Phase 3: Slim down the IMAP Worker

Refactor `services/imap-worker/src/processor.ts`:

1. **Keep:** IMAP polling, email parsing, noise filtering (both pattern-based and AI classification). These are source-specific responsibilities.

2. **Keep:** Contact/client resolution from sender email address. The IMAP Worker should still resolve the sender to a contact and determine the client. This info goes into the payload.

3. **Remove:** All direct `db.ticket.create()` calls. The IMAP Worker should NOT create tickets anymore.

4. **Remove:** Email threading logic (Message-ID matching, subject fallback, `findExistingTicketByThread`). This moves to the ingestion engine.

5. **Remove:** Re-analysis triggering logic. This moves to the ingestion engine.

6. **Remove:** `ticket-created` event emission. The ingestion engine handles this after creating the ticket.

7. **Add:** After noise filtering passes, push a normalized `EmailIngestionPayload` to the `ticket-ingest` queue. Use the existing queue utilities from `packages/shared-utils/src/queue.ts`.

8. **IMAP Worker still needs the `ticket-ingest` queue connection.** Add it to the worker's config and initialization (similar to how probe-worker sets up `ingestQueue`). Look at `services/ticket-analyzer/src/index.ts` and `services/copilot-api/src/routes/ingest.ts` for examples of enqueueing to `ticket-ingest`.

### Phase 4: Add RESOLVE_THREAD step to ingestion engine

In `services/ticket-analyzer/src/ingestion-engine.ts`:

1. **Add a `RESOLVE_THREAD` step handler.** This step runs early in the EMAIL ingestion route (before CATEGORIZE, GENERATE_TITLE, CREATE_TICKET). It determines whether an incoming email is:
   - **New ticket** — no matching thread found → continue to CREATE_TICKET
   - **Reply to existing ticket** — matched by Message-ID chain or subject → append as ticket event, skip CREATE_TICKET, and trigger update analysis instead

2. **Port the threading logic** from IMAP Worker's processor.ts into this step:
   - Check `inReplyTo` and `references` headers against stored Message-IDs in ticket events
   - Fall back to subject-line matching within a configurable time window (currently 7 days)
   - Store the Message-ID of the incoming email as a ticket event for future threading

3. **For replies (updates):**
   - Append an `EMAIL_INBOUND` event to the existing ticket
   - Do NOT create a new ticket (skip `CREATE_TICKET` step)
   - Enqueue a `ticket-analysis` job with `reanalysis: true` flag (same as current re-analysis trigger)
   - The threading resolution result should be stored in the step context so downstream steps know whether this is new vs. update

4. **For new emails:**
   - Let the pipeline continue normally through CATEGORIZE, GENERATE_TITLE, CREATE_TICKET

### Phase 5: Wire up default EMAIL ingestion route

The ingestion engine resolves routes by source + client. Ensure a default INGESTION route exists for EMAIL source. The route should have these steps in order:

1. `RESOLVE_THREAD` — new vs. update determination
2. `SUMMARIZE_EMAIL` — condense email content (skip for replies/updates)
3. `CATEGORIZE` — classify ticket category (skip for replies/updates)
4. `TRIAGE_PRIORITY` — set priority (skip for replies/updates)
5. `GENERATE_TITLE` — create ticket title (skip for replies/updates)
6. `CREATE_TICKET` — create in DB (skip for replies/updates)

This can be seeded via a Prisma migration or seed script, OR registered programmatically if the ingestion engine has a default route mechanism. Check how probe ingestion routes are configured.

### Phase 6: Verify and typecheck

1. Run `pnpm typecheck` — fix all type errors
2. Run `pnpm build` — fix all build errors
3. Ensure no circular dependencies were introduced
4. Check that the IMAP Worker's `package.json` no longer imports Prisma/DB packages if all DB operations were removed (it may still need them for contact/client resolution — that's fine)

## Important constraints

- Do NOT break the DevOps Worker, probe worker, manual API, or portal — they still create tickets directly for now (their migration is issue #2)
- Do NOT change the ticket-analyzer's analysis pipeline — only the ingestion engine
- The `ticket-created` event (emitted after CREATE_TICKET in the ingestion engine) must still work so that analysis routes are dispatched
- Preserve all existing email processing logs and metrics
- Follow all CLAUDE.md conventions: const enum pattern, ESM imports with `.js` extensions, Zod config, Pino logging

## Commit format

```
fix: migrate IMAP Worker to unified ingestion queue (fixes #1)
```

If multiple commits are needed, use descriptive messages referencing the issue:

```
refactor: slim IMAP Worker to collector + noise filter (#1)
feat: add RESOLVE_THREAD step to ingestion engine (#1)
```
