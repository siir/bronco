# Security Audit — Phase 3: Red-Team Test Plan

Date: 2026-04-24
Scope: Manual verification of the fixes shipped in Phase 2 (#407) across all auth tiers
Related: siir/bronco#296 (parent), siir/bronco#407 (Phase 2 tracker)

## Summary

Phase 3 is the **operator-driven verification** phase — walking the threat model from the #296 audit with real tokens at each auth tier and confirming the fixes from Phase 2 actually block the attacks they were designed to block. This cannot be automated safely in CI (requires real credentials + DB state), so this doc is the structured checklist the operator runs against staging or a dedicated test environment.

Phase 1 (surface enumeration) landed as PR #406. Phase 2 (per-class sweep) is the #407 arc — 10 of 11 items closed at time of writing. Phase 3 completion signoff happens when every row in the test-plan table below is verified with `observed == expected`. A Phase 4 response-field audit is planned as a follow-up artifact once Phase 3 is green.

## Prerequisites

Set up these actors once and reuse the tokens across all scenarios below. Names are suggestive — use whatever fits your staging environment.

| Actor | How to create / obtain |
|---|---|
| **Platform ADMIN operator** — "AdminBob" | Existing operator with `role: ADMIN` and `clientId: null`. Login via `POST /api/auth/login` to get JWT. |
| **Platform STANDARD operator** — "StandardSam" | Operator with `role: STANDARD`, `clientId: null`, assigned via `OperatorClient` to Client A. |
| **Client-pinned operator** — "ClientCarla" | Operator with `role: STANDARD`, `clientId: A` (pinned). |
| **Portal USER at Client A** — "UserUma" | Person with `ClientUser { clientId: A, userType: USER, hasPortalAccess: true }`. Portal JWT via `POST /api/portal/auth/login`. |
| **Portal ADMIN at Client A** — "PortalPat" | Person with `ClientUser { clientId: A, userType: ADMIN, hasPortalAccess: true }`. Portal JWT via portal login. |
| **Second client** — "Client B" | A distinct `Client` row with its own tickets, systems, people, etc. Needed for every cross-tenant attempt below. |
| **Operator pinned to Client B** — "ClientCraig" | `role: STANDARD`, `clientId: B`. Used for the assignedOperatorId cross-client test. |
| *(optional)* **Service API key** | `API_KEY` env var value — bypasses `requireRole`; used by workers. Tests flagged **(API-key)**. |

**Tip:** save each token into a shell variable (`ADMIN_TOKEN`, `STANDARD_TOKEN`, `CLIENT_TOKEN`, `PORTAL_USER_TOKEN`, `PORTAL_ADMIN_TOKEN`) and a client ID variable (`CLIENT_B=...`) so the curl commands below are copy-paste.

## Test scenarios

Responses described as:
- **200** = success with expected payload
- **400** = bad request (semantically invalid, caller's role is allowed but input was rejected)
- **403** = forbidden (caller's role/scope doesn't permit this action)
- **404** = not found (enumeration-resistant — also used for "out of scope, pretend it doesn't exist")
- **401** = unauthenticated (no/invalid token)

### A. Client-pinned operator (ClientCarla @ Client A) attempting cross-tenant

| # | Attempt | Expected | PR that added the guard |
|---|---|---|---|
| A1 | `GET /api/tickets` — list | 200 with ONLY Client A tickets; no Client B tickets | #408 (implicit — route uses resolveClientScope for LIST already) |
| A2 | `GET /api/tickets/:id` for a Client B ticket ID | 404 | #408 |
| A3 | `POST /api/tickets` with body `clientId: CLIENT_B` | 403 | #413 (High 5) |
| A4 | `PATCH /api/tickets/:id` on a Client B ticket | 404 | #408 |
| A5 | `POST /api/tickets/:id/reanalyze` on a Client B ticket | 404 | #408 |
| A6 | `GET /api/tickets/:id/logs` on a Client B ticket | 404 | #408 |
| A7 | `PATCH /api/tickets/:id` assigning `assignedOperatorId: ClientCraig` (pinned to B) on a Client A ticket | 400 | #413 (Medium 7) |
| A8 | `GET /api/systems` — list | 200 with ONLY Client A systems | #410 |
| A9 | `GET /api/systems/:id` for a Client B system | 404 | #410 |
| A10 | `POST /api/systems` with body `clientId: CLIENT_B` | 403 | #410 |
| A11 | `PATCH /api/integrations/:id` for a Client B integration | 404 | #410 |
| A12 | `DELETE /api/integrations/:id` for a platform-scoped integration (`clientId: null`) | 403 | #410 (Copilot review fix on #410) |
| A13 | `GET /api/repos` / `GET /api/client-memory` / `GET /api/ai-credentials` / `GET /api/environments` — LIST | 200 Client A only | #410 |
| A14 | `GET /api/scheduled-probes` / `GET /api/issue-jobs` / `GET /api/invoices` / `GET /api/system-analyses` / `GET /api/ticket-routes` / `GET /api/operational-tasks` / `GET /api/email-logs` / `GET /api/slack-conversations` — LIST | 200 Client A only | **pending — #407 Critical 2 remaining** |
| A15 | `POST /api/artifacts/upload?ticketId=<Client B ticket>` | 404 | #411 |
| A16 | `GET /api/artifacts/:id/download` for a Client B artifact | 404 | #411 |
| A17 | `POST /api/people` with email of a Person who ONLY exists at Client B | Behavior: creates new `ClientUser` at Client A AND does NOT mutate existing Person fields globally | #414 |
| A18 | `POST /api/system-status/control` — restart any service | 403 | #409 (High 4) |
| A19 | `PUT /api/settings/smtp` | 403 | #409 |
| A20 | `PUT /api/settings/github` | 403 | #409 |
| A21 | `POST /api/ai-config` with `scope: 'APP_WIDE'` | 403 | #409 |
| A22 | `POST /api/ai-config` with `scope: 'CLIENT', clientId: A` | 200 (client-scoped writes allowed for STANDARD) | #409 |

### B. Platform STANDARD operator (StandardSam, assigned to Client A via OperatorClient)

| # | Attempt | Expected | PR |
|---|---|---|---|
| B1 | Same as A1–A17 (assigned-scope semantics) | Same as A (sees Client A; cross-tenant blocked) | #408/#410/#411/#413/#414 |
| B2 | `POST /api/operators` — create another operator | 403 (ADMIN-only inner guard) | Pre-audit (already enforced) |
| B3 | `DELETE /api/operators/:id` | 403 | Pre-audit |
| B4 | `POST /api/system-status/control` | 403 | #409 |
| B5 | `PUT /api/settings/*` global settings | 403 | #409 |
| B6 | `POST /api/ai-config` `scope: 'APP_WIDE'` | 403 | #409 |

### C. Portal USER at Client A (UserUma)

| # | Attempt | Expected | PR |
|---|---|---|---|
| C1 | `GET /api/portal/tickets` — list | 200 with ONLY tickets UserUma is requester of, follower of, or has commented on (Client A only) | #412 (Medium 9) |
| C2 | `GET /api/portal/tickets/:id` for a ticket UserUma is NOT associated with (same client) | 403 or 404 | #412 |
| C3 | `GET /api/portal/tickets/:id` for a ticket at Client B | 404 | Pre-audit + portal-jwt scope |
| C4 | `POST /api/portal/tickets/:id/comments` on a ticket they're not associated with | 403 or 404 | #412 |
| C5 | `GET /api/tickets` (non-portal endpoint) | 401 or 403 (portal JWT doesn't satisfy operator requireRole) | Pre-audit (requireRole rejects portal users) |
| C6 | `GET /api/operators` | 401 or 403 | Pre-audit |
| C7 | `PATCH /api/portal/auth/profile` with body `name: 'changed'` | Verify behavior: reachable self-edit must not mutate `Person.name` (field ignored/rejected or persisted profile remains unchanged) | #295 (pre-audit, Wave 2A) |
| C8 | Hit the admin `/api/tool-requests` page endpoints | 403 (admin-only outer guard + portal-JWT rejected) | Pre-audit |
| C9 | `POST /api/portal/auth/register` with email of an existing Person | 400 / 409 (register reject; must use login instead) | Pre-audit (#286 round 4) |

### D. Portal ADMIN at Client A (PortalPat)

| # | Attempt | Expected | PR |
|---|---|---|---|
| D1 | `PATCH /api/portal/users/:id` at Client B | 403 or 404 | Pre-audit |
| D2 | `PATCH /api/portal/users/:id` at Client A — change `ClientUser.userType: 'ADMIN'` on a peer | Expected per business logic (allowed since they're Client A admin) | Pre-audit |
| D3 | `PATCH /api/portal/users/:id` attempting `body.name` / `body.email` / `body.isActive` | Fields silently ignored OR explicit 400 — verify PR #295 restricts to ClientUser-scoped fields only | #295 |
| D4 | `POST /api/portal/auth/reset-password` on an Operator-extension Person | 403 or 404 (operators can't be password-reset through the portal admin path) | Pre-audit (#286 round 3) |
| D5 | Any operator-admin endpoint (`/api/users`, `/api/operators`) | 401 or 403 | Pre-audit |

### E. Platform ADMIN operator (AdminBob) — non-regression checks

These should ALL succeed; tests here make sure Phase 2 fixes didn't accidentally lock out ADMIN.

| # | Attempt | Expected |
|---|---|---|
| E1 | `GET /api/tickets?clientId=<ANY>` | 200 — list any client's tickets |
| E2 | `POST /api/tickets` body `clientId: <ANY>` | 201 — allowed |
| E3 | `PATCH /api/tickets/:id` with `assignedOperatorId: <any operator>` | 200 if the operator is active (Medium 7 still enforces operator↔client membership — ADMIN bypasses the scope check but assignedOperator membership is operator-to-ticket, not caller-to-ticket) |
| E4 | `POST /api/system-status/control` to restart a service | 200 |
| E5 | `PUT /api/settings/smtp` | 200 |
| E6 | `POST /api/ai-config` `scope: 'APP_WIDE'` | 201 |
| E7 | `GET /api/operators`, `DELETE /api/operators/:id` | 200 |
| E8 | Platform-scoped GITHUB integration CRUD | 200 (ADMIN-only for create per #410) |

### F. Unauthenticated caller

| # | Attempt | Expected |
|---|---|---|
| F1 | `GET /api/tickets` with no Authorization header | 401 |
| F2 | `GET /api/portal/tickets` with no Authorization header | 401 |
| F3 | `POST /api/auth/login` | 200 (or 401 with bad creds) — public route |
| F4 | `POST /api/portal/auth/register` | 409 if Person exists; 400 for validation/domain/client lookup failures; 200 on successful registration/login |
| F5 | `GET /api/health` | 200 — public |

### G. Service API-key caller (API_KEY env — bypasses requireRole)

| # | Attempt | Expected |
|---|---|---|
| G1 | `POST /api/tickets` with `x-api-key: $API_KEY` body `clientId: ANY` | 201 (API-key treated as `scope.type === 'all'`) |
| G2 | `PATCH /api/tickets/:id` with `x-api-key` on any ticket | 200 |
| G3 | `POST /api/ai-config` `scope: 'APP_WIDE'` with `x-api-key` | 201 (per the #409 runtime check: `request.user && request.user.role !== ADMIN` — API-key has no `request.user`, so the check short-circuits and allows) |

Note: G3 is the specific Copilot-caught bug from #409 review (commit `549ed1b`) — verify API-key callers get through.

## Response-field sanity checks

For each endpoint in Group H below, capture the full response body (curl with `-v`, or save to file) and grep for sensitive field names. None should appear.

Forbidden strings in **any** response body:
- `"passwordHash"`
- `"emailLower"`
- Any credential column (tokens, secrets, private keys)

### H. Response-field grep targets

| # | Endpoint | Caller |
|---|---|---|
| H1 | `GET /api/people/:id` | AdminBob |
| H2 | `GET /api/people?clientId=A` (list) | AdminBob |
| H3 | `GET /api/people/search?q=...` | AdminBob |
| H4 | `GET /api/operators` | AdminBob |
| H5 | `GET /api/operators/:id` | AdminBob |
| H6 | `GET /api/clients/:id` (includes `clientUsers.person`) | AdminBob |
| H7 | `GET /api/tickets/:id` (includes `followers.person`) | AdminBob |
| H8 | `POST /api/auth/login` — operator login response | AdminBob |
| H9 | `POST /api/auth/refresh` | AdminBob |
| H10 | `POST /api/portal/auth/login` — portal login response | UserUma |
| H11 | `POST /api/portal/auth/refresh` | UserUma |
| H12 | `GET /api/portal/auth/me` | UserUma |
| H13 | Any MCP platform tool that returns a Person or ClientUser (platform MCP bearer, via `x-api-key`) | API-key + `X-Caller-Name: copilot-api` once MCP scoping lands |

For each of the above, run:

```
curl -s -H "Authorization: Bearer $TOKEN" 'https://itrack.siirial.com/api/...' | jq . | grep -iE 'passwordHash|emailLower'
```

Expected: **zero matches**. Any match is a leak that needs a fix PR.

## How to run the tests

1. Create the test actors in the DB (platform ADMIN, 2 STANDARD operators, 1 client-pinned operator, 1 portal USER, 1 portal ADMIN, Client B).
2. Login as each and capture the tokens.
3. Walk each row in sections A–H. For curl-driven tests, record the HTTP status + response body hash.
4. Compare against expected column.
5. For each deviation: open a follow-up issue referencing `#296` and `#407` (as appropriate) with the actor, attempt, expected, observed.

## Completion

Phase 3 is signed off when every row has `observed == expected`. A checkbox version of this table can live in a comment on #296 or a status-tracking issue as the operator works through it.

Any deviation → new fix PR → re-run the affected row until green.

## Remaining known gaps at signoff time

- **#407 Critical 2 remaining** (section A14): scheduled-probes, issue-jobs, invoices, system-analyses, ticket-routes, operational-tasks, email-logs, slack-conversations — rows expecting "200 Client A only" will fail until that PR ships.
- **#407 Critical 3**: MCP platform per-caller scoping — not testable from the REST surface; separate verification plan once that lands.

## Closing #296 audit

Once Phase 3 is green and #407 items 1–11 are closed, #296 can be closed with a final summary comment linking to the Phase 1 and Phase 3 docs, the #407 tracker, and the separate Phase 4 response-field audit artifact if/when that follow-up is completed.
