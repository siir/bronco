# Security Audit — Phase 1: Surface Enumeration

Date: 2026-04-23
Scope: copilot-api REST routes + mcp-platform tools
Related: siir/bronco#296

## Auth plumbing (reference)

Global hook (`services/copilot-api/src/plugins/auth.ts`) runs `onRequest` for every request, in this order:

- Public routes (skip auth): `/api/health`, `/api/auth/login`, `/api/auth/refresh`, `/api/portal/auth/login`, `/api/portal/auth/refresh`, `/api/portal/auth/register`.
- `x-api-key` header matching `API_KEY` env → service-to-service short-circuit **before any JWT verification**; `request.user === undefined` and `request.portalUser === undefined` (treated as fully trusted by `requireRole`, but not as an authenticated portal user).
- `/api/portal/**` requests that did NOT already match the API-key branch → verified against `portalJwtSecret` → `request.portalUser`.
- Everything else that did NOT already match a public, API-key, or portal branch → verified against `jwtSecret` → `request.user` (operator).

Route groups registered in `services/copilot-api/src/routes/index.ts`:

1. **Public** (`authRoutes`, `healthRoutes`) — plugin-level auth (login/refresh/register are public).
2. **Portal** (`portalAuthRoutes`, `portalTicketRoutes`, `portalUserRoutes`) — portal JWT required for portal-user access; API-key requests bypass JWT entirely and typically still 401 inside handlers that call `requirePortalUser`.
3. **Client-scoped ops** guard `requireRole(ADMIN, STANDARD)` — `clientRoutes`, `peopleRoutes`, `ticketRoutes`, `knowledgeDocRoutes`, `artifactRoutes`, `aiUsageRoutes`, `ticketFilterPresetRoutes`, `pendingActionRoutes`.
4. **Operator control panel** guard `requireRole(ADMIN, STANDARD)` — every other non-portal feature route.
5. **Admin-only** guard `requireRole(ADMIN)` — `toolRequestRoutes`.

`requireRole` (auth.ts) allows API-key (no user) through; rejects portal users with 403 on any operator route.

Tenant scoping helpers (`services/copilot-api/src/plugins/client-scope.ts`):
- `resolveClientScope(request)` returns one of `{type:'all'}` (platform ADMIN / API-key), `{type:'assigned', clientIds}` (platform STANDARD via OperatorClient), `{type:'single', clientId}` (client-scoped operator OR portal user).
- `scopeToWhere(scope)` converts to a `{clientId: string | {in:[...]}}` fragment or `{}` for `all`.

MCP platform server (`mcp-servers/platform/src/index.ts`) has a SINGLE auth layer: valid `x-api-key` matching `API_KEY`. (The legacy `Authorization: Bearer <MCP_AUTH_TOKEN>` path was removed in #90 Layer 1.) **There is NO per-caller tenant scoping or role check on ANY MCP tool — the surface is entirely trusted to its callers (copilot-api, ticket-analyzer, issue-resolver, scheduler-worker, etc.).** Every MCP tool below executes with full DB access.

## Summary

- **~180 REST endpoints** enumerated across 44 route files
- **43 MCP platform tools** enumerated across 18 tool files
- **Many endpoints have no explicit tenant scoping** (systems, repos, integrations, client-memory, client-environments, issue-jobs, scheduled-probes, slack-conversations, ai-config, ai-providers, invoices, release-notes, email-logs, etc.) — these rely on the operator control panel guard and implicit trust that a STANDARD operator is platform-wide. Client-scoped operators (`Operator.clientId !== null`) can reach these routes; whether any enforce a `resolveClientScope` check is called out per-row below.
- **Portal surfaces** (`/api/portal/**`) are strictly scoped to `portalUser.clientId` and `userType`; `portalUserRoutes` enforces `requirePortalAdmin` internally.
- **Operator management** (`/api/operators`, `/api/users`) have internal `preHandler` gates above the outer `ADMIN, STANDARD` group — both enforce ADMIN-only.
- **Auth plugin allows API-key requests to bypass `requireRole`** — MCP platform server and workers lean on this; any route with a role guard is effectively unscoped for API-key callers.

### Vulnerability class labels used below

- **Class 1** — caller-controlled tenant or parent identifier is accepted without verifying the caller is authorized for that tenant/object.
- **Class 2** — cross-tenant mutation caused by matching or updating a shared record without re-checking mutation scope.
- **Class 3** — response includes a broader object graph than intended; verify the selected fields do not leak sensitive data (e.g. `passwordHash`, `emailLower`).
- **Class 4** — non-deterministic `findFirst` selection (e.g. `clientUser.findFirst({ where: { personId } })` without `orderBy`) resolves a different tenant context per request.
- **Class 5** — relationship or assignment validation is incomplete; the referenced record exists, but authorization or tenant compatibility is not enforced.
- **Class 6** — privileged or sensitive field mutation is possible through an insufficiently scoped update path.
- **Class 10** — missing object-level tenant scope enforcement on read/write operations, enabling cross-tenant access to existing records (IDOR-style access control failure).

### Top flags for Phase 2 attention

1. **POST /api/tickets** (sync mode) — accepts `requesterId` from body and attaches as follower. Tenant validation added (class 5-matches), but this path also doesn't verify the caller is authorized for `clientId` in body; a client-scoped STANDARD operator at Client A can currently create a ticket with `clientId` = Client B. Class 1 + class 10.
2. **POST /api/tickets/:id/events**, **POST /api/tickets/:id/ai-help**, **POST /api/tickets/:id/reanalyze**, **GET /api/tickets/:id/logs**, **GET /api/tickets/:id/ai-usage**, **GET /api/tickets/:id/unified-logs**, **GET /api/tickets/:id/cost-summary**, **PATCH /api/tickets/:id** — none call `resolveClientScope`. `GET /api/tickets/:id` also returns the entire ticket without scope filtering. Only the two chat-tab endpoints scope to client. Class 10.
3. **PATCH /api/tickets/:id.assignedOperatorId** — validates operator exists and is active, but does NOT validate that operator is authorized for the ticket's client. Class 5.
4. **POST /api/people** — `assertClientInScope` validates caller can reach `clientId`, but on existing-Person match it upserts `name`/`isActive`/`passwordHash` across all tenants without an `assertPersonMutationScope`-equivalent gate. Class 2 + class 6.
5. **Artifact download endpoints** (`GET /api/artifacts/:id`, `GET /api/artifacts/:id/download`, `GET /api/tickets/:ticketId/artifacts`) — no scope check; any authenticated operator (including client-scoped) can download artifacts from any ticket. Class 10.
6. **GET /api/tickets/:id** returns `followers.include.person` via Prisma `include` — explicit `select` is applied to `person`, but the response surface is broad; confirm no Person fields leak beyond `id/name/email/phone/isActive`. Class 3.
7. **GET /api/clients/:id** returns `clientUsers.person` with explicit `select` (passwordHash excluded) but has no scope check — any authenticated operator can read any client's contacts. Class 10.
8. **All `/api/integrations`, `/api/repos`, `/api/systems`, `/api/scheduled-probes`, `/api/client-memory`, `/api/ai-config`, `/api/issue-jobs`, `/api/invoices`** — accept `clientId` in body / query without verifying the caller is authorized for that client. These are gated at `requireRole(ADMIN, STANDARD)` only; a client-scoped STANDARD operator can reach them. Class 1 + class 10.
9. **POST /api/issue-jobs** — validates the repo and ticket are for the same client, but doesn't validate the caller is authorized for that client. Class 1 + class 10.
10. **POST /api/artifacts/upload** — takes `ticketId` + `findingId` from querystring with zero validation. Caller can attach arbitrary files to any ticket. Class 1 + class 10.
11. **DELETE /api/clients/:id/environments/:envId** — no check that caller is authorized for the client; relies on control-panel guard. Class 10.
12. **POST /api/tickets/:id/chat-message** classification happens with `ticket.clientId` in AI context — verify scope check here is sufficient (looks correct; uses 404 not 403 for enumeration protection, which is consistent). OK.
13. **MCP platform — `create_ticket`, `update_ticket`, `create_operator`, `update_operator`, `delete_operator`, `update_person`, `create_person`, `delete_person`, `update_client`, `create_client_memory`, `approve_plan`, `reject_plan`, `update_tool_request`, `delete_tool_request`** — all fully trusted, zero scoping. If an MCP caller (ticket-analyzer, issue-resolver) is ever compromised or passes through user-controlled input, these are full takeover. Class 1 + class 10 (at the trust boundary).
14. **MCP platform `get_person` / `list_people` / `search_people`** — may return `passwordHash`/`emailLower`. Need to verify the `select` shape in `people.ts` tools. Class 3.
15. **POST /api/release-notes/ingest** — no auth reference in the file. Under operator control panel group, so ADMIN/STANDARD can call it. But accepts arbitrary GitHub commit data and can drive AI generation; rate-limit and abuse considerations. Class 10.
16. **POST /api/ai-help on tickets, POST /api/tool-requests/dedupe, POST /api/release-notes/ingest** — side-effectful AI calls without tenant scope verification on the ticket target.
17. **DELETE /api/clients/:id/ai-credentials/:credId, PATCH** — no scope check (client-ai-credentials.ts).
18. **POST /api/operators** (create), **PATCH /api/operators/:id** (role/clientId change) — requires ADMIN, but body `clientId` is trusted without checking that the target client exists; and `PATCH` can demote/reassign without re-validating role transitions. Class 9.
19. **Re-verify all `findFirst` on clientUser with personId but no orderBy** — several sites found (e.g., `/api/people/:id` DELETE resolves primary via ordered find; but `/api/tickets/:id/chat-message` looks up by ticket not clientUser — OK). Class 4 remains to sweep.
20. **MCP `run_tool_request_dedupe`** proxies via HTTP to copilot-api — confirm the admin-only guard on the REST side catches it if auth is forwarded. Likely called with API-key, so guard bypassed.

---

## REST routes

### Authentication & self-service (public / self-auth)

| Path | Method | Auth tier | Inputs (high level) | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|---------------------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/health` | GET | public | — | No | No | No | No | N/A | none | Version/timestamp only |
| `/api/auth/login` | POST | public | body: email, password | R/W (passwordHash compare, lastLoginAt write) | R/W (lastLoginAt) | No | No | N/A | none | Uses `CONTROL_PANEL_ROLES` filter — rejects non-operator Persons with 401 |
| `/api/auth/refresh` | POST | public | body: refreshToken | R | R | No | No | N/A | none | Verifies JTI via `personRefreshToken`; class 8 revocation scope |
| `/api/auth/logout` | POST | operator-JWT | — | No | No | No | No | self | none | Revokes all refresh tokens for this Person+accessType OPERATOR |
| `/api/auth/me` | GET | operator-JWT | — | R | R | No | No | N/A | none | Returns Person+Operator shape, `passwordHash` stripped by explicit select |
| `/api/auth/profile` | PATCH | operator-JWT | body: name, email | W (self) | No | No | No | self | none | Self-service; updates own Person row |
| `/api/auth/me/theme` | PATCH | operator-JWT | body: themePreference | No | W (themePreference) | No | No | self | none | |
| `/api/auth/change-password` | POST | operator-JWT | body: currentPassword, newPassword | R/W | No | No | No | self | none | |
| `/api/portal/auth/login` | POST | public | body: email, password, clientId? | R (passwordHash compare) | No | R | Indirect | N/A | none | `resolveForLogin` orders `clientUsers` by `isPrimary, createdAt` — class 4 fix in place |
| `/api/portal/auth/refresh` | POST | public | body: refreshToken | R | No | R | Indirect | pinned to `clientUserId` in token | none | Class 8 safeguard in place |
| `/api/portal/auth/register` | POST | public | body: email, password, name | R/W (new Person) | No | W (new ClientUser) | No | by email domain → Client.allowSelfRegistration | none | Class 7: rejects existing Person with 409 (fix in place) |
| `/api/portal/auth/me` | GET | portal-user | — | R | No | R | No | self clientUserId | none | Explicit Person select |
| `/api/portal/auth/profile` | PATCH | portal-user | body: name, email | W (self) | No | No | No | self | none | Per issue class 2 comment: portal user edits their own global Person identity — acceptable (self-service) |
| `/api/portal/auth/change-password` | POST | portal-user | body: currentPassword, newPassword | R/W | No | No | No | self | none | |

### People (unified contact + portal user)

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/search/people` | GET | operator | query: q, limit | R (projected) | No | R | Yes (ClientUser) | `resolveClientScope` → clientId filter | outer ADMIN,STANDARD | |
| `/api/people` | GET | operator | query: clientId? | R (safe select) | No | R | Yes | `resolveClientScope` + intersection check | outer ADMIN,STANDARD | Returns 403 on out-of-scope clientId filter |
| `/api/people/:id` | GET | operator | params: id | R (safe select) | No | R | Yes | `assertClientInScope` on cu.clientId | outer ADMIN,STANDARD | Orders clientUsers by `isPrimary, createdAt` |
| `/api/people` | POST | operator | body: clientId, name, email, phone?, password?, hasPortalAccess?, isPrimary?, userType?, isActive? | R/W (Person upsert) | No | R/W | Yes | `assertClientInScope(clientId)` | outer ADMIN,STANDARD | Flag: on existing Person, updates `name`/`isActive`/`passwordHash` globally without `assertPersonMutationScope` |
| `/api/people/:id` | PATCH | operator | params: id; body: clientId?, name?, email?, phone?, password?, isPrimary?, userType?, isActive? | W | No | R/W | Yes | `assertClientInScope` + `assertPersonMutationScope` | outer ADMIN,STANDARD | Strong gate — platform ADMIN only, OR caller's scope covers every ClientUser of target AND target has no Operator |
| `/api/people/:id` | DELETE | operator | params: id; query: clientId? | R/W (null passwordHash on last revocation) | R (check) | R/W | Yes | `assertClientInScope` on selected cu | outer ADMIN,STANDARD | Class 6 fix in place |
| `/api/people/:id/reset-password` | POST | operator | params: id; body: password | R/W | No | R | Yes | `assertClientInScope` + `assertPersonMutationScope` | outer ADMIN,STANDARD | |

### Portal users (client-admin self-service within own client)

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/portal/users` | GET | portal-admin | — | R (id,name,email,isActive) | No | R | Yes | `where: { clientId: portalUser.clientId }` | `requirePortalAdmin` | |
| `/api/portal/users` | POST | portal-admin | body: email, password, name, userType? | R/W | R (check for conflict) | R/W | Yes | implicit via `portalUser.clientId` | `requirePortalAdmin` | Rejects existing Person at other tenant/operator as 409 (class 2+7 fix in place) |
| `/api/portal/users/:id` | PATCH | portal-admin | params: id (personId); body: userType?, isPrimary? | No (BODY restricted to ClientUser fields only — class 2 fix) | No | R/W | Yes | `findFirst({personId, clientId: portalUser.clientId})` | `requirePortalAdmin` | |
| `/api/portal/users/:id` | DELETE | portal-admin | params: id | R/W (null passwordHash on last revoke) | R (check) | R/W | Yes | implicit | `requirePortalAdmin` | Class 6 fix in place |

### Operator admin (`/api/users`, `/api/operators`)

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/search/users` | GET | ADMIN-only | query: q, limit | R (where operator not null) | R | No | No | N/A (platform) | internal `preHandler` ADMIN | |
| `/api/users` | GET | ADMIN-only | — | R (safe select) | R | No | No | N/A | ADMIN | |
| `/api/users` | POST | ADMIN-only | body: email, password, name, role?, slackUserId? | R/W | W | No | No | N/A | ADMIN | Existing-Person reactivates with `isActive: true` |
| `/api/users/:id` | PATCH | ADMIN-only | params: id; body: name?, email?, role?, isActive?, slackUserId? | W | W | No | No | N/A | ADMIN | Class 9 fix: target Person must have Operator extension |
| `/api/users/:id` | DELETE | ADMIN-only | params: id | W (isActive=false) | R (guard) | No | No | N/A | ADMIN | Same guard applied |
| `/api/users/:id/reset-password` | POST | ADMIN-only | params: id; body: password | W | R (guard) | No | No | N/A | ADMIN | Same guard |
| `/api/operators` | GET | ADMIN-only | query: includeInactive? | R | R | No | No | N/A | internal `preHandler` ADMIN | |
| `/api/operators/:id` | GET | ADMIN-only | params: id | R | R | No | No | N/A | ADMIN | |
| `/api/operators` | POST | ADMIN-only | body: email, name, notifyEmail?, notifySlack?, slackUserId? | R/W | W | No | No | N/A | ADMIN | |
| `/api/operators/:id` | PATCH | ADMIN-only | params: id; body: name?, email?, isActive?, role?, clientId?, notifyEmail?, notifySlack?, slackUserId? | W | W | No | Yes (Operator.clientId) | trusts body clientId | ADMIN | Flag: body `clientId` accepted without verifying client exists; role/clientId change grants or removes privilege. Class 9 borderline — target integrity guards weak |
| `/api/operators/:id` | DELETE | ADMIN-only | params: id | W (isActive=false) | R | No | No | N/A | ADMIN | |

### Tickets

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/tickets` | GET | operator | query: clientId, status, category, priority, source, analysisStatus, createdFrom/To, environmentId, assignedOperatorId, limit, offset | No | No | No | Yes (Ticket) | `resolveClientScope` + filter | outer ADMIN,STANDARD | Good |
| `/api/search/tickets` | GET | operator | query: q, limit | No | No | No | Yes | `resolveClientScope` + `scopeToWhere` | outer ADMIN,STANDARD | |
| `/api/tickets/stats` | GET | operator | query: clientId? | No | No | No | Yes | **NONE** — accepts `clientId` filter but doesn't intersect with scope | outer ADMIN,STANDARD | Flag: scope not enforced |
| `/api/tickets/:id` | GET | operator | params: id | R (followers.person via select) | R (via client include) | R (via followers) | Yes | **NONE** on the ticket itself | outer ADMIN,STANDARD | Flag: returns ticket by ID without scope check |
| `/api/tickets` | POST | operator | query: sync?; body: clientId, subject, description?, systemId?, environmentId?, requesterId?, priority?, source?, category? | R (check requesterId) | R (requesterId check branch) | R (requesterId check branch) | Yes | Validates requesterId ∈ client (class 5 partial fix); body `clientId` NOT cross-checked against caller scope | outer ADMIN,STANDARD | Class 1/5/10 — see flags list |
| `/api/tickets/:id/events` | POST | operator | params: id; body: eventType, content?, metadata?, actor? | No | No | No | Yes (TicketEvent) | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/tickets/:id` | PATCH | operator | params: id; body: status?, priority?, systemId?, environmentId?, category?, sufficiencyStatus?, assignedOperatorId?, knowledgeDoc? | No | R (assignedOperatorId check — existence+active only) | No | Yes | **NONE** on ticket; env/operator cross-client validated | outer ADMIN,STANDARD | Flag: operator client-membership not verified; caller scope vs. ticket not verified |
| `/api/tickets/:id/reanalyze` | POST | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/tickets/:id/chat-message` | POST | operator | params: id; body: text, modeOverride? | No | No | No | Yes | `resolveClientScope` — 404 on out-of-scope | outer ADMIN,STANDARD | OK |
| `/api/tickets/:id/chat-message/:eventId/pick-mode` | POST | operator | params: id, eventId; body: mode | No | No | No | Yes | `resolveClientScope` — 404 | outer ADMIN,STANDARD | OK |
| `/api/tickets/:id/logs` | GET | operator | params: id; query: level, service, search, limit, offset | No | No | No | Yes (AppLog by entityId) | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/tickets/:id/ai-usage` | GET | operator | params: id; query: limit, offset | No | No | No | Yes (AiUsageLog by entityId) | **NONE** | outer ADMIN,STANDARD | Flag — may leak prompts across tenants |
| `/api/tickets/:id/unified-logs` | GET | operator | params: id; query: type, level, search, includeArchive, createdAfter, limit, offset | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag (same) |
| `/api/tickets/:id/cost-summary` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/tickets/:id/ai-help` | POST | operator | params: id; body: question?, provider?, model?, taskType? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD (+ rateLimit 20/min) | Flag |

### Portal tickets

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/portal/tickets` | GET | portal-user | query: status, category, limit, offset | No | No | No | Yes | `where: { clientId: portalUser.clientId }` + USER narrows to owner | `requirePortalUser` | |
| `/api/portal/tickets/stats` | GET | portal-user | — | No | No | No | Yes | same | `requirePortalUser` | |
| `/api/portal/tickets/:id` | GET | portal-user | params: id | R (followers) | No | No | Yes | `canAccessTicket` — ADMIN gets all client; USER gets owner-only | `requirePortalUser` | |
| `/api/portal/tickets` | POST | portal-user | body: subject, description?, priority? | No | No | No | Yes | `portalUser.clientId` pinned | `requirePortalUser` | |
| `/api/portal/tickets/:id/comments` | POST | portal-user | params: id; body: content | No | No | No | Yes | `canAccessTicket` | `requirePortalUser` | |
| `/api/portal/tickets/:id/attachments` | POST | portal-user | params: id; multipart file | No | No | No | Yes | `canAccessTicket` | `requirePortalUser` | sanitizes filename to prevent traversal |
| `/api/portal/tickets/:id/attachments/:aid/download` | GET | portal-user | params: id, aid | No | No | No | Yes | `canAccessTicket` + `artifact.ticketId === id` | `requirePortalUser` | |

### Clients

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/search/clients` | GET | operator | query: q, limit | No | No | No | Yes | `resolveClientScope` | outer ADMIN,STANDARD | |
| `/api/clients` | GET | operator | — | No | No | No | Yes | `resolveClientScope` + `scopeToWhere` | outer ADMIN,STANDARD | |
| `/api/clients/:id` | GET | operator | params: id | R (clientUsers.person via explicit select) | No | R | Yes | **NONE** on id lookup | outer ADMIN,STANDARD | Flag — caller can read any client. Person select safe (id/name/email/phone/isActive). Class 3 OK |
| `/api/clients` | POST | operator | body: name, shortCode, notes?, domainMappings? | No | No | No | Yes (creates Client) | **NONE** | outer ADMIN,STANDARD | Client-scoped STANDARD operator can create a new Client |
| `/api/clients/:id` | PATCH | operator | params: id; body: various incl. domainMappings, billing, notificationMode | No | No | No | Yes | **NONE** except `notificationMode` requires `request.user` (no portal) | outer ADMIN,STANDARD | Flag |

### Systems

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/systems` | GET | operator | query: clientId? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/systems/:id` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/systems` | POST | operator | body: clientId, name, dbEngine?, host, port?, ... | No | No | No | Yes | env-id cross-client checked; body `clientId` NOT checked against caller scope | outer ADMIN,STANDARD | Flag |
| `/api/systems/:id` | PATCH | operator | params: id; body: fields | No | No | No | Yes | env-id cross-client only | outer ADMIN,STANDARD | Flag |
| `/api/systems/:id` | DELETE | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Refuses when tickets reference it; Flag otherwise |

### Scheduled probes

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/search/scheduled-probes` | GET | operator | query: q, limit | No | No | No | Yes | `resolveClientScope` | outer ADMIN,STANDARD | |
| `/api/scheduled-probes` | GET | operator | query: clientId? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/scheduled-probes/builtin-tools` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/scheduled-probes/:id` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/scheduled-probes` | POST | operator | body: clientId, integrationId?, name, toolName, toolParams, cron/timezone, action, category?, ... | No | No | No | Yes | integration-client cross-check; body `clientId` NOT vs caller scope | outer ADMIN,STANDARD | Flag |
| `/api/scheduled-probes/:id` | PATCH | operator | params: id; body: partial | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/scheduled-probes/:id` | DELETE | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/scheduled-probes/:id/run` | POST | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag (triggers external tool on client's systems) |
| `/api/scheduled-probes/:id/runs` | GET | operator | params: id; query: limit, offset, status | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/scheduled-probes/:id/runs/current` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/scheduled-probes/:id/runs/:runId` | GET | operator | params: id, runId | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/scheduled-probes/:id/runs` | DELETE | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |

### Slack conversations

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/slack-conversations` | GET | operator | query: operatorId?, clientId?, startDate?, endDate?, limit, offset | No | R (via include) | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag — can filter other operator's conversations |
| `/api/slack-conversations/:id` | GET | operator | params: id | No | R | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |

### Ticket filter presets

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/ticket-filter-presets` | GET | operator | — | No | Yes (self) | No | No | `where: { operatorId }` | outer ADMIN,STANDARD | Good — scoped to caller |
| `/api/ticket-filter-presets` | POST | operator | body: name, statusFilter?, categoryFilter?, clientIdFilter?, priorityFilter?, isDefault? | No | W (self) | No | No | `operatorId` from auth | outer ADMIN,STANDARD | |
| `/api/ticket-filter-presets/:id` | PATCH | operator | params: id; body: partial | No | W (self) | No | No | ownership check | outer ADMIN,STANDARD | |
| `/api/ticket-filter-presets/:id` | DELETE | operator | params: id | No | W (self) | No | No | ownership check | outer ADMIN,STANDARD | |

### Client memory

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/client-memory` | GET | operator | query: clientId, category, memoryType, isActive | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/client-memory/:id` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/client-memory` | POST | operator | body: clientId, title, memoryType, category?, tags?, content, sortOrder?, source? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/client-memory/:id` | PATCH | operator | params: id; body: partial | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/client-memory/:id` | DELETE | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |

### Issue jobs

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/issue-jobs` | GET | operator | query: ticketId?, repoId?, status?, limit, offset | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/issue-jobs/:id` | GET | operator | params: id | No | No | No | Yes (ticket clientId via include) | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/issue-jobs/:id/plan` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/issue-jobs` | POST | operator | body: ticketId, repoId; query: force? | No | No | No | Yes | ticket vs repo client cross-check; no caller scope check | outer ADMIN,STANDARD | Flag — can trigger resolver on any ticket |
| `/api/issue-jobs/:id/approve` | POST | operator | params: id; body: approvedBy?, operatorId? | No | R (operatorId check) | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/issue-jobs/:id/reject` | POST | operator | params: id; body: feedback | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |

### Code repos

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/repos` | GET | operator | query: clientId? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/repos/:id` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/repos` | POST | operator | body: clientId, name, repoUrl, description?, defaultBranch?, branchPrefix?, environmentId?, githubIntegrationId? | No | No | No | Yes | env/github integration cross-check; no caller scope | outer ADMIN,STANDARD | Flag |
| `/api/repos/:id` | PATCH | operator | params: id; body: partial | No | No | No | Yes | env/github integration cross-check | outer ADMIN,STANDARD | Flag |
| `/api/repos/:id` | DELETE | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Refuses with jobs present |

### Integrations

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/integrations` | GET | operator | query: clientId?, type?, scope? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag — can list every client's integrations |
| `/api/integrations/:id` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag — returns encrypted `config` in response |
| `/api/integrations` | POST | operator | body: clientId?, type, label?, config, environmentId?, isActive?, notes? | No | No | No | Yes | env cross-check; platform-scope only allowed for GITHUB | outer ADMIN,STANDARD | Flag |
| `/api/integrations/:id` | PATCH | operator | params: id; body: label?, config?, environmentId?, isActive?, notes? | No | No | No | Yes | env cross-check | outer ADMIN,STANDARD | Flag |
| `/api/integrations/:id/verify` | POST | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/integrations/:id` | DELETE | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |

### AI config

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/ai-config/defaults` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-config/app/:appScope` | GET | operator | params: appScope | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-config/resolved` | GET | operator | query: taskType, clientId? | No | No | No | Yes (via clientId) | **NONE** | outer ADMIN,STANDARD | Flag — can preview other clients' resolved model |
| `/api/ai-config` | GET | operator | query: taskType?, clientId?, scope? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/ai-config/:id` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/ai-config` | POST | operator | body: taskType, scope, clientId?, provider, model, maxTokens? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag — non-platform operator could set APP_WIDE config |
| `/api/ai-config/:id` | PATCH | operator | params: id; body: provider?, model?, maxTokens?, isActive? | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/ai-config/:id` | DELETE | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |

### AI providers (`/api/ai-providers/*`)

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/ai-providers/app-scopes` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | Encrypted key redacted |
| `/api/ai-providers/capabilities` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/types` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/:id` | GET | operator | params: id | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers` | POST | operator | body: provider setup incl. apiKey | No | No | No | No | N/A | outer ADMIN,STANDARD | apiKey encrypted |
| `/api/ai-providers/:id` | PATCH | operator | params: id; body: partial | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/:id` | DELETE | operator | params: id | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/:id/test` | POST | operator | params: id | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/models` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/models/:id` | GET | operator | params: id | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/models` | POST | operator | body: model setup | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/models/:id` | PATCH | operator | params: id; body | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-providers/models/:id` | DELETE | operator | params: id | No | No | No | No | N/A | outer ADMIN,STANDARD | |

### AI usage

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/ai-usage/logs` (various) | GET | operator (client-scoped group) | query: clientId, taskType, provider, model, entityType, entityId, limit, offset | No | No | No | Yes (AiUsageLog) | **NONE** (under client-scoped group but handler doesn't check) | outer ADMIN,STANDARD | Flag — 8 GET endpoints, 2 DELETE, 2 POST in this file |
| `/api/ai-usage/logs/prompt-keys` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/ai-usage/logs/:id` | DELETE (plural) | operator | various | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/ai-usage/costs/*` | GET/POST/DELETE | operator | body: pricing overrides | No | No | No | No | N/A | outer ADMIN,STANDARD | Admin-ish; Flag |

### Artifacts

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/tickets/:ticketId/artifacts` | GET | operator (client-scoped group) | params: ticketId | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/artifacts/:id` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/artifacts/:id/download` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/artifacts/upload` | POST | operator | multipart file; query: ticketId?, findingId?, description? | No | No | No | Yes | **NONE** — ticketId/findingId trusted from query | outer ADMIN,STANDARD | Flag |

### Release notes

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/release-notes/ingest` | POST | operator | body: commits[] or fromSha/toSha + tag? | No | No | No | No (platform) | N/A | outer ADMIN,STANDARD | Flag — drives AI summarization on arbitrary input |
| `/api/release-notes` | GET | operator | query: service, search, from, to, changeType, tag, limit, offset | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/release-notes/services` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/release-notes/tags` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/release-notes/:id` | PATCH | operator | params: id; body: isVisible | No | No | No | No | N/A | outer ADMIN,STANDARD | |

### Ingest

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/ingest/probe` | POST | operator | body: probeId, clientId, probeName, toolName, toolResult, category?, integrationId?, operatorEmail? | No | No | No | Yes | client existence check; **no caller scope** | outer ADMIN,STANDARD | Flag |
| `/api/ingest/runs` | GET | operator | query: clientId, status, limit, offset | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/ingest/runs/:id` | GET | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |

### Failed jobs

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/failed-jobs` | GET | operator | query: queue, limit, offset | No | No | No | No (BullMQ) | N/A | outer ADMIN,STANDARD | |
| `/api/failed-jobs/:queue/:jobId/retry` | POST | operator | params | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/failed-jobs/:queue/retry-all` | POST | operator | params | No | No | No | No | N/A | outer ADMIN,STANDARD | Flag — STANDARD operator can retry jobs across all tenants |
| `/api/failed-jobs/:queue/:jobId` | DELETE | operator | params | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/failed-jobs/:queue` | DELETE | operator | params | No | No | No | No | N/A | outer ADMIN,STANDARD | Flag |

### Email logs

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/email-logs` | GET | operator | query: classification, status, clientId, from, to, limit, offset | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag — exposes sender emails (PII) |
| `/api/email-logs/stats` | GET | operator | — | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | |
| `/api/email-logs/:id/retry` | POST | operator | params: id | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |
| `/api/email-logs/:id` | PATCH | operator | params: id; body: classification | No | No | No | Yes | **NONE** | outer ADMIN,STANDARD | Flag |

### System status

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/system-status` | GET | operator | — | No | No | No | No (platform) | N/A | outer ADMIN,STANDARD | |
| `/api/system-status/control` | POST | operator | body: service, action | No | No | No | No | N/A | outer ADMIN,STANDARD | Flag — STANDARD operator can stop/restart Docker services; should be ADMIN-only |

### Settings

All GET/PUT on `/api/settings/*` are under the operator control-panel group (ADMIN,STANDARD). The tool-request rate limit and analysis-strategy-version endpoints have an additional `requireRole(ADMIN)` preHandler.

| Path | Method | Auth tier | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Role guard | Notes |
|------|--------|-----------|--------|---------|-----------|-------------|----------------------|----------------|------------|-------|
| `/api/settings/statuses` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | Auto-seeds defaults |
| `/api/settings/statuses/:value` | PATCH | operator | params; body partial | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/statuses` | POST | operator | body | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/categories` | GET/POST | operator | — / body | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/categories/:value` | PATCH | operator | params, body | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/operational-alerts` | GET/PUT | operator | body: config | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/operational-alerts/test` | POST | operator | — | No | R | No | No | N/A | outer ADMIN,STANDARD | Sends test email via SMTP |
| `/api/settings/smtp` | GET/PUT | operator | body (password redact+encrypt) | No | No | No | No | N/A | outer ADMIN,STANDARD | Flag — STANDARD operator can read/write global SMTP |
| `/api/settings/smtp/test` | POST | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/devops` | GET/PUT | operator | body (pat redact+encrypt) | No | No | No | No | N/A | outer ADMIN,STANDARD | Flag |
| `/api/settings/devops/test` | POST | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/github` | GET/PUT | operator | body (token redact+encrypt) | No | No | No | No | N/A | outer ADMIN,STANDARD | Flag |
| `/api/settings/github/test` | POST | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/imap` | GET/PUT | operator | body (password redact+encrypt) | No | No | No | No | N/A | outer ADMIN,STANDARD | Flag |
| `/api/settings/imap/test` | POST | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/slack` | GET/PUT | operator | body (tokens redact+encrypt) | No | No | No | No | N/A | outer ADMIN,STANDARD | Flag |
| `/api/settings/slack/test` | POST | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/prompt-retention` | GET/PUT | operator | body | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/tool-request-rate-limit` | GET/PUT | ADMIN-only | body | No | No | No | No | N/A | inner ADMIN | |
| `/api/settings/action-safety` | GET/PUT | operator | body | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/analysis-strategy` | GET/PUT | operator | body | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/analysis-strategy/:ticketId` | GET | operator | params: ticketId | No | No | No | Yes (ticket lookup) | **NONE** — ticket lookup unscoped | outer ADMIN,STANDARD | Flag |
| `/api/settings/analysis-strategy-version` | GET | operator | — | No | No | No | No | N/A | outer ADMIN,STANDARD | |
| `/api/settings/analysis-strategy-version` | PUT | ADMIN-only | body | No | No | No | No | N/A | inner ADMIN | |
| `/api/settings/self-analysis` | GET/PATCH | operator | body | No | No | No | No | N/A | outer ADMIN,STANDARD | |

### Remaining per-file coverage (grouped)

Full enumeration of remaining routes in other files — these are all under `outer ADMIN,STANDARD` guard and have no per-request `resolveClientScope` checks unless noted:

| File | Paths (method) | Client-scoped entity? | Scope check? | Notes |
|------|---------------|----------------------|--------------|-------|
| `ai-providers.ts` | (enumerated above) | No | N/A | |
| `ai-usage.ts` | `/api/ai-usage/logs` GET, `/api/ai-usage/logs/prompt-keys` GET, `/api/ai-usage/logs/:id` DELETE (2 variants), `/api/ai-usage/costs` GET/POST/DELETE, `/api/ai-usage/costs/refresh` POST, `/api/ai-usage/costs/seed` POST, `/api/ai-usage/costs/catalog` GET | Some (via entity) | **NONE** | Flag |
| `client-ai-credentials.ts` | `/api/clients/:id/ai-credentials` GET/POST, `/api/clients/:id/ai-credentials/:credId` PATCH/DELETE, `/api/clients/:id/ai-credentials/:credId/test` POST | Yes | **NONE** | Flag — write encrypted keys |
| `client-environments.ts` | `/api/clients/:id/environments` GET/POST, `/api/clients/:id/environments/:envId` PATCH/DELETE | Yes | **NONE** | Flag |
| `external-services.ts` | `/api/external-services` GET, `/api/external-services/:id` GET, POST, PATCH, DELETE | No (platform) | N/A | |
| `invoices.ts` | `/api/clients/:id/invoices` GET/POST, `/api/clients/:id/invoices/:invoiceId` GET/PATCH/DELETE | Yes | **NONE** | Flag — PII/financial |
| `keywords.ts` | `/api/keywords` GET, `/api/keywords/:id` GET, POST, PATCH, DELETE, `/api/keywords/seed` POST | No (platform) | N/A | |
| `knowledge-doc.ts` | `/api/tickets/:id/knowledge-doc/toc` GET, `/api/tickets/:id/knowledge-doc/section/:sectionKey` GET/PATCH, `/api/tickets/:id/knowledge-doc/subsection` POST | Yes | `ticketInScope` (resolveClientScope) | OK — 404 on out-of-scope |
| `log-summaries.ts` | `/api/log-summaries` GET, `/api/log-summaries/:key` POST (generate), `/api/log-summaries/generate` POST | No | N/A | |
| `logs.ts` | `/api/logs` GET, `/api/logs/services` GET | Some (entityId filter passthrough) | **NONE** | Flag — could read any entity's logs by id |
| `notification-channels.ts` | `/api/notification-channels` GET, `/api/notification-channels/:id` GET/POST/PATCH/DELETE, `/api/notification-channels/:id/test` POST | No | N/A | |
| `notification-preferences.ts` | `/api/notification-preferences` GET/PUT, `/api/notification-preferences/:event` PUT | No | self (via request.user) | OK |
| `operational-tasks.ts` | `/api/operational-tasks` GET, `/api/operational-tasks/:id` GET, POST (2 variants), PATCH | Some (ticket-scoped) | **NONE** | Flag |
| `pending-actions.ts` | Under client-scoped group — 4 endpoints (list/get by ticket, various actions) | Yes | **NONE** | Flag — verify per-handler |
| `prompts.ts` | `/api/prompts` GET, `/api/prompts/:id` GET, POST, PATCH, DELETE, `/api/prompts/seed` POST (estimated) | No (platform-global) | N/A | |
| `system-analyses.ts` | list/stats/get/patch/trigger/delete (9 endpoints) | Yes | **NONE** | Flag |
| `system-issues.ts` | `/api/system-issues` GET | Yes | **NONE** | Flag |
| `ticket-routes.ts` | step-types (GET), list/search/get/create/update/delete + step-level CRUD (11 endpoints) | Yes (per-client routes supported) | **NONE** | Flag — client-scoped STANDARD op can alter other client's pipelines |
| `tool-requests.ts` | `/api/tool-requests` GET, `/api/tool-requests/:id` GET/PATCH/DELETE, `/api/tool-requests/dedupe` POST, `/api/tool-requests/:id/github-issue` POST (5 mains) | Yes | **NONE** | Router is ADMIN-only (inner scoped group) |

---

## MCP platform tools

**All MCP platform tools operate under shared service trust. Auth is a SINGLE shared API-key (`API_KEY`) or bearer token (`MCP_AUTH_TOKEN`). No per-caller tenant or role scope exists. Every tool has full DB access.**

| Tool name | Inputs | Person? | Operator? | ClientUser? | Client-scoped entity? | Tenant scoping | Notes |
|-----------|--------|---------|-----------|-------------|----------------------|----------------|-------|
| `search_tickets` | q, limit | No | No | No | Yes | none | Trusted surface |
| `list_tickets` | clientId?, status?, priority?, category?, assignedOperatorId?, limit?, offset? | No | No | No | Yes | none | |
| `get_ticket` | ticketId | R (followers.person explicit select) | R (via include) | R (via followers) | Yes | none | Verify Person select excludes passwordHash |
| `create_ticket` | clientId, subject, description?, priority?, category?, source? | No | No | No | Yes | none | Flag |
| `update_ticket` | ticketId; body | No | No | No | Yes | none | Flag |
| `get_ticket_logs` | ticketId, ... | No | No | No | Yes | none | |
| `get_ticket_cost` | ticketId | No | No | No | Yes | none | |
| `list_pending_actions` | filters | No | No | No | Yes | none | |
| `approve_pending_action` | actionId | No | No | No | Yes | none | Flag |
| `dismiss_pending_action` | actionId | No | No | No | Yes | none | |
| `search_people` | q, limit | R (projection) | No | R | Yes | none | Verify Person projection (class 3) |
| `list_people` | clientId? | R | No | R | Yes | none | Verify projection |
| `get_person` | personId | R | No | R | Yes | none | Verify projection — MUST exclude passwordHash/emailLower |
| `create_person` | body (transactional with optional ClientUser) | R/W | No | R/W | Yes | none | Flag — class 2 applies if reused from compromised caller |
| `update_person` | personId; body | W | No | W | Yes | none | Flag — class 2 |
| `delete_person` | personId; clientId? | W | R (check) | W | Yes | none | Soft-delete; Flag |
| `search_clients` | q, limit | No | No | No | Yes | none | |
| `list_clients` | — | No | No | No | Yes | none | |
| `get_client` | clientId | R (clientUsers.person) | No | R | Yes | none | Verify projection |
| `update_client` | clientId; body | No | No | No | Yes | none | Flag |
| `list_systems` | clientId? | No | No | No | Yes | none | Verify no password in projection |
| `get_system` | systemId | No | No | No | Yes | none | Declared as "no password exposed" |
| `search_scheduled_probes` | q, limit | No | No | No | Yes | none | |
| `list_probes` | clientId? | No | No | No | Yes | none | |
| `run_probe` | probeId | No | No | No | Yes | none | Flag — enqueues immediate probe execution |
| `get_probe_runs` | probeId, ... | No | No | No | Yes | none | |
| `list_issue_jobs` | filters | No | No | No | Yes | none | |
| `get_issue_job` | jobId | No | No | No | Yes | none | |
| `create_issue_job` | ticketId, repoId | No | No | No | Yes | none | Flag — triggers resolver |
| `approve_plan` | jobId | No | R (operatorId?) | No | Yes | none | Flag |
| `reject_plan` | jobId, feedback | No | No | No | Yes | none | |
| `get_ai_usage` | filters | No | No | No | Yes | none | |
| `get_ai_cost_summary` | date range | No | No | No | Yes | none | |
| `list_operators` | — | R (via include) | R | No | No | none | Flag — verify passwordHash not leaked |
| `search_operators` | q, limit | R | R | No | No | none | Verify |
| `get_operator` | operatorId | R | R | No | No | none | Verify |
| `create_operator` | email, name | R/W | W | No | No | none | Flag — creates platform operator |
| `update_operator` | operatorId; body (role, clientId, notify, slack) | W | W | No | Yes | none | Flag — grants privilege |
| `delete_operator` | operatorId | W (Person deactivate if no CUs) | W | No | No | none | Flag |
| `list_integrations` | filters | No | No | No | Yes | none | Secrets not exposed per description |
| `list_client_memory` | clientId | No | No | No | Yes | none | |
| `create_client_memory` | body | No | No | No | Yes | none | Flag — influences AI analysis context |
| `get_system_settings` | — | No | No | No | No | none | No secrets |
| `get_analysis_strategy` | — | No | No | No | No | none | |
| `get_service_health` | — | No | No | No | No | none | Proxies to copilot-api system-status |
| `list_slack_conversations` | filters | No | R | No | Yes | none | |
| `get_slack_conversation` | conversationId | No | R | No | Yes | none | |
| `search_users` | q, limit | R (Person.operator only) | R | No | No | none | Operator search — verify projection |
| `read_tool_result_artifact` | artifactId, offset?, limit?, grep? | No | No | No | No (stored-tool-result) | none | |
| `request_tool` | name, rationale, kind?, ticketId? | No | No | No | Indirect (client inferred from ticket) | none | Rate-limit via AppSetting |
| `list_tool_requests` | filters | No | No | No | Yes | none | |
| `get_tool_request` | id | No | No | No | Yes | none | |
| `update_tool_request` | id, body | No | No | No | Yes | none | Flag |
| `delete_tool_request` | id | No | No | No | Yes | none | Flag |
| `run_tool_request_dedupe` | clientId | No | No | No | Yes | none | Proxies to copilot-api with API-key — inner admin guard bypassed. Flag |
| `create_tool_request_github_issue` | id, repo? | No | No | No | Yes | none | Writes to GitHub using stored PAT |
| `kd_read_toc` | ticketId | No | No | No | Yes | none | |
| `kd_read_section` | ticketId, sectionKey | No | No | No | Yes | none | |
| `kd_update_section` | ticketId, sectionKey, content, mode | No | No | No | Yes | none | Advisory-locked |
| `kd_add_subsection` | ticketId, parentSectionKey, title, content | No | No | No | Yes | none | Advisory-locked |

---

## Flagged for Phase 2 attention (top 20)

1. **POST /api/tickets (body.clientId)** — not cross-checked against caller's `resolveClientScope`. Client-A STANDARD can post ticket for Client-B. Class 1/10.
2. **GET/PATCH/POST /api/tickets/:id/\*** (events, logs, ai-usage, unified-logs, cost-summary, ai-help, reanalyze, main PATCH) — no scope check; client-scoped operator can read/write any ticket by ID. Class 10.
3. **PATCH /api/tickets/:id.assignedOperatorId** — operator existence+active validated, but NOT that operator is authorized for ticket's client. Class 5.
4. **POST /api/people** (existing-Person branch) — updates `name`, `isActive`, `passwordHash` globally without `assertPersonMutationScope`. Class 2+6.
5. **Artifact endpoints** (`/api/artifacts/:id`, `/download`, `/api/tickets/:ticketId/artifacts`, `/api/artifacts/upload`) — no scope check; upload trusts body `ticketId`/`findingId`. Class 1+10.
6. **POST /api/artifacts/upload** — query-string driven ticket attachment with no validation; any operator attaches files to any ticket. Class 1.
7. **GET /api/clients/:id** — returns clientUsers detail without caller-scope check. Class 10.
8. **Entire `systems`, `repos`, `integrations`, `scheduled-probes`, `client-memory`, `client-ai-credentials`, `client-environments`, `issue-jobs`, `invoices`, `system-analyses`, `ticket-routes`, `pending-actions`, `operational-tasks`** route groups — no `resolveClientScope` enforcement in handlers despite holding `clientId` as a write target. A client-scoped STANDARD operator reaches them through the outer `requireRole(ADMIN, STANDARD)` guard. Class 1+10 at bulk.
9. **POST /api/system-status/control** — allows `stop`/`restart` on Docker services for any STANDARD operator. Should be ADMIN-only. Class 9.
10. **SMTP/DevOps/GitHub/IMAP/Slack global settings** (`/api/settings/{smtp,devops,github,imap,slack}`) — STANDARD operator can read/write platform-global encrypted credentials. Should be ADMIN-only. Class 9.
11. **AI config + AI providers** — STANDARD operator can edit APP_WIDE AI model overrides. Should be ADMIN-only on APP_WIDE scope. Class 9.
12. **Email logs** (`/api/email-logs*`) — exposes inbound sender email (PII) across clients with no scope. Class 10.
13. **Slack conversation logs** — no scope check; STANDARD op can read any operator's Slack conversation history. Class 10.
14. **Settings `/api/settings/analysis-strategy/:ticketId`** — unscoped ticket lookup; leaks ticket existence via 404 vs 200. Class 10.
15. **MCP platform: `create_operator`, `update_operator`, `delete_operator`** — fully trusted path to mutate operator roles. If any MCP caller is compromised or takes user input, full platform takeover. Class 9.
16. **MCP platform: `create_person`, `update_person`, `delete_person`** — same trust concern for global Person identity. Class 2.
17. **MCP platform: `get_person`, `list_people`, `search_people`, `list_operators`, `search_operators`, `get_operator`, `search_users`, `get_client`** — verify none return `passwordHash`/`emailLower` on the Person projection. Class 3.
18. **MCP platform: `run_tool_request_dedupe`** — HTTP-proxies to copilot-api with service API-key, bypassing the REST ADMIN-only guard. Verify this is intentional and the MCP caller has its own authZ. Class 10.
19. **Portal ticket `canAccessTicket`** USER-tier — matches by `actor === portalUser.email` and `followers.person.email === portalUser.email`. Class 4/10: if a Person's email changes mid-flight or a non-unique email match exists, USER visibility can silently shift. Also actor-string equality is brittle. Worth a Phase 2 review.
20. **Class 4 sweep** — several `clientUser.findFirst({ where: { personId } })` (people.ts DELETE, reset-password) use `orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }]`. A couple others (people.ts PATCH with body.clientId = undefined) depend on correct ordering — verify fix is in every `findFirst(clientUser where: {personId, ...})` call site.

## Gaps in auth plumbing

- **MCP platform has no notion of "caller identity" or tenant scope.** It's entirely trusted. Every audit check in Phase 2 should re-verify whether trust is justified given each MCP caller (ticket-analyzer AI agent loop runs with user ticket content in context — see `mcp-servers/platform/src/tools/request-tool.ts` chain).
- **`requireRole` bypasses role check for API-key callers.** Any REST endpoint gated only by `requireRole(ADMIN, STANDARD)` is effectively unscoped for service-to-service traffic. The MCP platform server generally does not call copilot-api REST endpoints, but `run_tool_request_dedupe` is an exception: it proxies back to copilot-api using the service API key. Inventory other cross-service REST calls.
- **`Operator.clientId !== null`** model means a client-scoped operator authenticates with the same operator JWT as a platform operator. The outer `requireRole(ADMIN, STANDARD)` guard allows both. Per-route use of `resolveClientScope` is the ONLY defense against a client-scoped operator reaching another tenant's routes. Many routes don't call it.
- **`/api/operators` PATCH** accepts `clientId` in body — a client-scoped operator cannot actually reach this route (inner ADMIN guard), but confirm the guard ordering ensures the inner `preHandler` runs before any handler logic. (It does — Fastify `addHook('preHandler')` runs before route handler.)
- **`/api/clients/:id` PATCH** sets `notificationMode` with `!request.user` check — this accepts API-key callers (no user). Verify that's intentional vs. should require an explicit operator.
- Several endpoints accept body `clientId` without any existence check (e.g., `/api/ai-config` POST on CLIENT scope — relies on Prisma FK for validation).
- **Settings `/api/settings/self-analysis`** PATCH doesn't have an ADMIN-only inner guard like the rate-limit / strategy-version endpoints do — confirm intended access level.
- Route files that don't appear in `routes/index.ts` registrations: verified all 44 files are registered. No orphans.
