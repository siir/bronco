# CLAUDE.md - Project Instructions for Claude Code

## Project: Bronco

AI-augmented database and software architecture operations platform. Single-operator tool for managing client database systems (primarily Azure SQL Managed Instances), triaging tickets across database performance, bug fixes, feature requests, code reviews, and architecture tasks.

## Architecture Quick Reference

- **Monorepo**: pnpm workspaces. Shared packages in `packages/`, services in `services/`, MCP servers in `mcp-servers/`.
- **Control plane DB**: PostgreSQL (Prisma ORM). Schema at `packages/db/prisma/schema.prisma`.
- **Client databases**: Azure SQL Managed Instances (primary, SQL cred auth), on-prem SQL Server (future clients). Connected via MCP database server (Node.js/Express) running on Hugo in Docker Compose. The MCP server reads system configs directly from the control plane Postgres `System` table and decrypts passwords using `ENCRYPTION_KEY`.
- **AI routing**: Local Ollama for triage/categorize/summarize/extract; Claude API for deep analysis, code review, architecture review, bug analysis, schema review, feature analysis.
- **Hugo** (control plane VM): Ubuntu 24.04 LTS on ESXi NUC. Runs copilot-api (Fastify), imap-worker, ticket-analyzer, devops-worker, issue-resolver, status-monitor, mcp-database, Postgres, Redis, Caddy via Docker Compose.
- **Mac mini (siiriaplex)**: Runs Ollama for local LLM inference.
- **CI/CD**: GitHub Actions — CI runs on push to `staging` (typecheck + build), not on every PR update. Feature branches PR into `staging`; staging PRs into `master`. Pushes to `master` that change app-relevant paths (packages/, services/, mcp-servers/, docker-compose.yml, lockfile) auto-tag a semver release (`tag-release.yml`), which triggers deploy-hugo (GHCR + SSH via Tailscale). Docs-only or workflow-only changes do not trigger a release or deploy. To bump major/minor, push a tag manually before merging staging → master.

## Key Conventions

- TypeScript throughout. All enums use the `const object + type` pattern (not TS enums).
  ```typescript
  export const Foo = { A: 'A', B: 'B' } as const;
  export type Foo = (typeof Foo)[keyof typeof Foo];
  ```
- Prisma enum values must match shared-types enum values exactly.
- All services use Zod for config validation via `loadConfig()` from shared-utils. Use `z.output<typeof schema>` (not `z.infer`) when schema has `.default()` values.
- Pino logging via `createLogger(name)` from shared-utils. Writes to stderr.
- The `encrypt`/`decrypt` AES-256-GCM utilities in shared-utils are used for storing IMAP passwords, AI provider API keys, MCP server API keys, and SQL Server credentials (system passwords) in the control plane DB. The MCP database server decrypts system passwords at runtime using `ENCRYPTION_KEY`.
- ESM throughout. Use `.js` extensions in relative imports (TypeScript resolves these).

## MCP Server Extensibility

The MCP database server reads system connection configs from the control plane Postgres `System` table (via Prisma). The pool manager at `mcp-servers/database/src/connections/pool-manager.ts` uses a factory pattern for creating database connections. New systems added via the control panel are picked up automatically (on pool miss). To add support for a new database engine type:

1. Add the engine to `DbEngine` in `packages/shared-types/src/system.ts` (const + type pattern)
2. Add a new `buildXxxConfig()` method in `pool-manager.ts`
3. Add the case to the switch in `buildMssqlConfig()`
4. If the new engine uses a different driver (not mssql/tedious), see the extensibility guide in the `buildMssqlConfig()` JSDoc comment — it covers abstracting the pool type, updating tools, etc.
5. If the new engine needs additional fields, add them to `SystemConnectionConfig` in shared-types, `SystemConfigEntry` in `mcp-servers/database/src/config.ts`, and the `System` model in `packages/db/prisma/schema.prisma`
6. Add a system entry via the control panel or API, call `list_systems` to verify, then `inspect_schema` to verify connectivity

## Ticket Sources

| Source | Description |
|--------|-------------|
| `MANUAL` | Created via API/UI |
| `EMAIL` | From imap-worker (IMAP email polling) |
| `AZURE_DEVOPS` | From devops-worker (Azure DevOps work items) |
| `AI_DETECTED` | From automated analysis |
| `SCHEDULED` | From cron jobs |

## Azure DevOps Integration

The `devops-worker` service polls Azure DevOps for work items and syncs them as tickets. It uses a conversational AI workflow for actionable items (those assigned to the configured user).

**Flow:**
1. Polls all work items in the configured project (incremental after first sync)
2. Creates a ticket for each work item, syncing title, description, priority, and linked items
3. For items assigned to `AZDO_ASSIGNED_USER`, triggers the conversational workflow:
   - AI analyzes the issue and posts questions as DevOps comments
   - User responds via DevOps comments → AI processes answers
   - When enough context is gathered, AI proposes an execution plan
   - User approves → AI executes the plan and posts results

**Workflow states** (tracked in `DevOpsSyncState.workflowState`):
`idle` → `analyzing` → `questioning` → `planning` → `awaiting_approval` → `executing` → `completed`

**Configuration (.env):**
```bash
AZDO_ORG_URL=https://dev.azure.com/{organization}
AZDO_PROJECT={project}
AZDO_PAT={personal-access-token}
AZDO_ASSIGNED_USER={email-or-display-name}
AZDO_CLIENT_SHORT_CODE={optional-client-short-code}
AZDO_POLL_INTERVAL_SECONDS=120
```

**Key files:**
| File | Purpose |
|------|---------|
| `services/devops-worker/src/client.ts` | Azure DevOps REST API client (PAT auth, WIQL queries, comments) |
| `services/devops-worker/src/processor.ts` | Work item → ticket sync, comment sync, linked item context |
| `services/devops-worker/src/workflow.ts` | Conversational AI workflow engine (state machine) |
| `services/devops-worker/src/poller.ts` | Incremental work item polling |
| `services/devops-worker/src/config.ts` | Zod config schema |

## Ticket Categories

Tickets span multiple domains, not just DBA work:

| Category | Description |
|----------|-------------|
| `DATABASE_PERF` | Query performance, blocking, index tuning, health issues |
| `BUG_FIX` | Bugs across database, API, and client applications |
| `FEATURE_REQUEST` | New features for API endpoints or client apps |
| `SCHEMA_CHANGE` | Database schema modifications (new tables, columns, migrations) |
| `CODE_REVIEW` | Code review and quality tasks |
| `ARCHITECTURE` | System design and architecture decisions |
| `GENERAL` | Anything that does not fit the above |

## AI Task Types and Routing

The default task→provider mapping is shown below. These defaults can be overridden per task type and per client via the `AiModelConfig` DB table (managed in the control panel's AI Models tab on the Prompts page). Resolution order: CLIENT-scoped override → APP_WIDE override → hardcoded default.

System prompts for each task are registered in `packages/ai-provider/src/prompts/` and resolved at runtime via `PromptResolver`. Workers pass `promptKey` (e.g. `"imap.triage.system"`) instead of inline prompt strings, so prompt overrides (prepend/append, per-client) created in the control panel are applied at AI generation time.

**Local LLM (Ollama)** — fast, cost-free (default):
- `TRIAGE` — Set priority, extract key entities
- `CATEGORIZE` — Classify into TicketCategory
- `SUMMARIZE` — Summarize email threads
- `DRAFT_EMAIL` — Generate draft responses
- `EXTRACT_FACTS` — Pull structured data from text
- `SUMMARIZE_TICKET` — Summarize ticket context for analysis
- `SUGGEST_NEXT_STEPS` — Suggest next actions for a ticket
- `CLASSIFY_INTENT` — Classify user comment intent (approval, rejection, question)
- `SUMMARIZE_LOGS` — Summarize application log entries
- `ANALYZE_WORK_ITEM` — Analyze DevOps work items and compose user-facing responses
- `DRAFT_COMMENT` — Compose DevOps comments (clarifications, execution results)
- `GENERATE_DEVOPS_PLAN` — Generate structured execution plans for DevOps workflow approval
- `GENERATE_TITLE` — Generate concise ticket titles from email content
- `CLASSIFY_EMAIL` — Classify inbound emails (ticket-worthy vs noise/auto-reply)
- `GENERATE_RELEASE_NOTE` — Generate concise release note from a git commit message and changed files
- `SUMMARIZE_ROUTE` — Summarize ticket routing options and decisions
- `SELECT_ROUTE` — Select appropriate route for ticket processing

**Claude API** — heavy reasoning (default):
- `ANALYZE_QUERY` — Query plan analysis
- `GENERATE_SQL` — SQL generation
- `REVIEW_CODE` — Code review
- `DEEP_ANALYSIS` — General deep analysis
- `BUG_ANALYSIS` — Cross-stack bug investigation
- `ARCHITECTURE_REVIEW` — Architecture decisions
- `SCHEMA_REVIEW` — Database schema change review
- `FEATURE_ANALYSIS` — Break down feature requests
- `RESOLVE_ISSUE` — Automated code generation for issue resolution
- `CHANGE_CODEBASE_SMALL` — Small-scope codebase modifications
- `CHANGE_CODEBASE_LARGE` — Large-scope codebase modifications
- `ANALYZE_TICKET_CLOSURE` — Post-closure analysis for system improvement suggestions
- `GENERATE_RESOLUTION_PLAN` — Generate a resolution plan for operator review before code execution
- `CUSTOM_AI_QUERY` — Flexible configurable AI query within a route pipeline (task type and model overridable per step)

### Task Type Discipline (CRITICAL)

Each AI task type controls provider routing (Ollama vs Claude), model selection, and per-client overrides via `AiModelConfig`. **Never reuse an existing task type for a different purpose.** If an operator overrides `DEEP_ANALYSIS` to use a cheaper model for a client, that override affects every call site using `DEEP_ANALYSIS` — including any unrelated operations that were reusing it as a catch-all.

Rules:
- **Create a new task type** when the work has a fundamentally different capability requirement, output format, or provider routing need than any existing type.
- **`DEEP_ANALYSIS` is for single-shot ticket analysis**, not a generic fallback. Do not use it for agentic tool loops, admin operations, or plan generation.
- **`SUMMARIZE` is for email threads.** Use `SUMMARIZE_LOGS` for monitoring data, probe results, and log entries.
- **`GENERATE_DEVOPS_PLAN` is for DevOps workflow plans (Ollama).** Use `GENERATE_RESOLUTION_PLAN` for code resolution plans (Claude).
- **`RESOLVE_ISSUE` is for code generation**, not plan generation.
- **`CUSTOM_AI_QUERY` is the correct choice** for one-off administrative AI calls that don't fit any specific task type (e.g., pricing catalog refresh).
- When adding a new task type: add to `packages/shared-types/src/ai.ts`, `packages/ai-provider/src/model-config-resolver.ts` (default provider), `packages/ai-provider/src/task-capabilities.ts`, and update this section of CLAUDE.md.

## Client Memory Management

Per-client operational knowledge (playbooks, procedures, architectural guidance) stored in the DB and automatically injected into AI analysis contexts. Enables AI to leverage client-specific expertise when analyzing tickets.

### Memory Types

| Type | Description |
|------|-------------|
| `CONTEXT` | General client knowledge — environment, databases, architecture |
| `PLAYBOOK` | Step-by-step procedures for specific scenarios |
| `TOOL_GUIDANCE` | Which tools/resources to use and how |

### Memory Source

| Source | Description |
|--------|-------------|
| `MANUAL` | Created by the operator via API/UI |
| `AI_LEARNED` | Extracted by AI from resolved tickets |

### How It Works

1. Operator creates memory entries for a client via the control panel (Memory tab on Client detail) or `POST /api/client-memory`.
2. Each entry can optionally be scoped to a `TicketCategory` (e.g., only inject for `DATABASE_PERF` tickets). Entries with `category: null` apply to all categories.
3. During ticket analysis, the `LOAD_CLIENT_CONTEXT` route step loads active memories for the client, filters by category, and injects them as markdown into the AI context.
4. Additionally, `AIRouter.generate()` auto-injects client memory when `clientId` is present in the request (unless `skipClientMemory` context flag is set).
5. The `ClientMemoryResolver` caches entries per-client with a 5-minute TTL. Cache is invalidated on create/update/delete via the API.

### Key Files

| File | Purpose |
|------|---------|
| `packages/shared-types/src/client-memory.ts` | MemoryType, MemorySource enums and ClientMemory interface |
| `packages/ai-provider/src/client-memory-resolver.ts` | Resolver with caching, category/tag filtering, markdown composition |
| `services/copilot-api/src/routes/client-memory.ts` | CRUD API endpoints with validation and cache invalidation |

## Ticket Route Step Types

Ticket routes define configurable analysis pipelines executed when tickets are processed. Each route consists of ordered steps, each performing a specific processing function.

### Pipeline Phases

| Phase | Steps | Description |
|-------|-------|-------------|
| **Phase 1: Triage** | SUMMARIZE_EMAIL, CATEGORIZE, TRIAGE_PRIORITY, DRAFT_RECEIPT, GENERATE_TITLE | Fast initial processing |
| **Context Loading** | LOAD_CLIENT_CONTEXT | Inject per-client memories and playbooks |
| **Phase 2: Analysis** | EXTRACT_FACTS, GATHER_REPO_CONTEXT, GATHER_DB_CONTEXT, DEEP_ANALYSIS, DRAFT_FINDINGS_EMAIL, SUGGEST_NEXT_STEPS, UPDATE_TICKET_SUMMARY, CUSTOM_AI_QUERY | Comprehensive AI analysis with full context |

### Step Type Reference

| Step Type | Phase | AI Task | Description |
|-----------|-------|---------|-------------|
| `SUMMARIZE_EMAIL` | Triage | SUMMARIZE | Condense email threads |
| `CATEGORIZE` | Triage | CATEGORIZE | Classify into TicketCategory |
| `TRIAGE_PRIORITY` | Triage | TRIAGE | Set priority level |
| `DRAFT_RECEIPT` | Triage | DRAFT_EMAIL | Generate auto-reply |
| `GENERATE_TITLE` | Triage | GENERATE_TITLE | Create ticket title |
| `LOAD_CLIENT_CONTEXT` | Context | — | Inject client memories |
| `EXTRACT_FACTS` | Analysis | EXTRACT_FACTS | Pull structured data |
| `GATHER_REPO_CONTEXT` | Analysis | — | Load code from repos via MCP |
| `GATHER_DB_CONTEXT` | Analysis | — | Load DB schema/metrics via MCP |
| `DEEP_ANALYSIS` | Analysis | DEEP_ANALYSIS | Comprehensive Claude analysis |
| `DRAFT_FINDINGS_EMAIL` | Analysis | DRAFT_EMAIL | Compose findings email |
| `SUGGEST_NEXT_STEPS` | Analysis | SUGGEST_NEXT_STEPS | Recommend actions |
| `UPDATE_TICKET_SUMMARY` | Analysis | — | Finalize ticket summary |
| `CUSTOM_AI_QUERY` | Analysis | CUSTOM_AI_QUERY | Configurable AI query with selectable context sources and optional fresh MCP/repo searches |

Routes are managed via `POST/PATCH/DELETE /api/ticket-routes` and configured per-client in the control panel. Each route can target a specific `TicketCategory` or apply to all categories.

## Automated Issue Resolution

The issue-resolver service (`services/issue-resolver/`) automatically resolves tickets by generating code changes via the `AIRouter` (which resolves the provider/model dynamically per task type and client) and pushing them to a branch.

### How It Works

1. A ticket is created (manually, via email, or AI-detected) describing a bug or feature.
2. A code repo is registered for the client via `POST /api/repos` with a configurable `branchPrefix` (default: `claude`).
3. A resolution job is triggered via `POST /api/issue-jobs` with `ticketId` and `repoId`.
4. The issue-resolver BullMQ worker:
   - Clones/pulls the target repo
   - Analyzes the codebase and issue with Claude
   - Generates and applies file changes
   - Commits and pushes to `{branchPrefix}/{sanitized-issue-subject}`
5. A `CODE_CHANGE` ticket event is created with the commit SHA, branch name, and summary.

### Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `REPO_WORKSPACE_PATH` | Local dir for repo clones | `/tmp/issue-resolver-repos` (Docker: `/var/lib/issue-resolver/repos`) |
| `REPO_RETENTION_DAYS` | Days before stale repo clones are cleaned up | `14` |
| `GIT_AUTHOR_NAME` | Git commit author name | `Bronco Bot` |
| `GIT_AUTHOR_EMAIL` | Git commit author email | `bot@bronco.dev` |

### Per-Client Repo Config

Each `CodeRepo` record stores:
- `repoUrl` — Git clone URL (HTTPS or SSH)
- `defaultBranch` — Branch to base work on (default: `master`)
- `branchPrefix` — Prefix for generated branches (default: `claude`, configurable per client)

### Branch Safety

The issue resolver **never** pushes directly to `main`, `master`, `develop`, `release`, or the repo's `defaultBranch`. All work is pushed to `{branchPrefix}/{slug}` branches only. This is enforced at three layers:
1. **API validation** — `branchPrefix` cannot be empty or a protected branch name (`repos.ts`). Generated branch names are checked before job creation (`issue-jobs.ts`).
2. **Git layer** — `prepareRepo()` and `commitAndPush()` in `git.ts` refuse to operate on any protected branch.
3. **Branch format** — Branch names must contain a `/` separator (enforced in `git.ts`).

## Lockfile Discipline (CRITICAL)

After modifying ANY `package.json` file (adding/removing/changing dependencies, or creating a new workspace package), you MUST run:

```bash
pnpm install
```

Then include the updated `pnpm-lock.yaml` in the same commit. CI uses `--frozen-lockfile` and will fail if the lockfile is out of sync. This applies to every commit that touches `package.json`, `pnpm-workspace.yaml`, or adds a new workspace directory.

## Build and Test

```bash
pnpm install              # Install all dependencies
pnpm build                # Build all packages
pnpm typecheck            # Type check all packages
pnpm clean                # Remove all dist/ folders

pnpm db:generate          # Regenerate Prisma client
pnpm db:migrate           # Run Prisma migrations
pnpm db:seed              # Seed development data

pnpm dev:api              # Start copilot-api (Fastify, port 3000)
pnpm dev:worker           # Start imap-worker
pnpm dev:analyzer         # Start ticket-analyzer worker
pnpm dev:devops           # Start devops-worker (Azure DevOps sync)
pnpm dev:mcp-db           # Start MCP database server (Express, port 3100, needs DATABASE_URL + ENCRYPTION_KEY)
pnpm dev:resolver         # Start issue-resolver worker
pnpm dev:status-monitor   # Start system status monitor
pnpm dev:panel            # Start control panel (Angular, port 4200)
pnpm dev:portal           # Start ticket portal (Angular, port 4201)
```

## Important Files

| File | Purpose |
|------|---------|
| `packages/shared-types/src/*.ts` | All enums and interfaces. Edit these first for any data model change. |
| `packages/db/prisma/schema.prisma` | Prisma schema. Keep enums in sync with shared-types. |
| `mcp-servers/database/src/config.ts` | Server config schema (Zod) and SystemConfigEntry interface. |
| `mcp-servers/database/src/systems-loader.ts` | Loads active systems from Postgres, decrypts passwords. |
| `mcp-servers/database/src/connections/pool-manager.ts` | Connection factory with extensibility guide. |
| `mcp-servers/database/src/tools/index.ts` | MCP tool registration (Zod schemas + handlers). |
| `mcp-servers/database/src/security/query-validator.ts` | SQL keyword blocklist. |
| `mcp-servers/database/src/security/audit-logger.ts` | Query audit logging (Pino structured JSON to stdout). |
| `packages/ai-provider/src/router.ts` | AI task routing (dynamic provider/model resolution via ModelConfigResolver). |
| `packages/ai-provider/src/client-memory-resolver.ts` | Per-client memory context resolver for AI analysis pipeline (cached, 5-min TTL). |
| `packages/ai-provider/src/model-config-resolver.ts` | DB-backed model config resolver (CLIENT → APP_WIDE → default layering, cached). |
| `services/copilot-api/src/routes/ai-config.ts` | AI model config CRUD + resolution preview endpoints (`/api/ai-config`). |
| `services/copilot-api/src/routes/tickets.ts` | Ticket CRUD endpoints. |
| `services/imap-worker/src/processor.ts` | Email collector: parse, noise-filter, push to ingestion queue. |
| `services/ticket-analyzer/src/analyzer.ts` | Ticket analysis with repo cloning (bare+worktree) and MCP tools. |
| `services/ticket-analyzer/src/index.ts` | Ticket analyzer service entry (BullMQ workers, probe scheduler, health). |
| `services/ticket-analyzer/src/probe-worker.ts` | Scheduled probe execution (cron + one-off via API). |
| `services/issue-resolver/src/worker.ts` | Issue resolution BullMQ worker with plan/approve/execute flow. |
| `services/issue-resolver/src/resolver.ts` | Claude-based code analysis and generation. |
| `services/issue-resolver/src/planner.ts` | Resolution plan generation and regeneration (GENERATE_RESOLUTION_PLAN). |
| `services/issue-resolver/src/learner.ts` | Learning extraction from plan approvals/rejections → client memory. |
| `services/issue-resolver/src/notify.ts` | Operator notification on plan generation (email). |
| `services/copilot-api/src/routes/operators.ts` | Operator CRUD endpoints (multi-operator support). |
| `packages/shared-utils/src/notify-operators.ts` | Broadcast notifications to active operators. |
| `services/copilot-api/src/routes/repos.ts` | Code repo CRUD endpoints. |
| `services/copilot-api/src/routes/issue-jobs.ts` | Issue resolution job trigger and status. |
| `services/devops-worker/src/processor.ts` | Azure DevOps work item sync and comment threading. |
| `services/devops-worker/src/workflow.ts` | Conversational AI workflow state machine. |
| `services/copilot-api/src/services/mcp-discovery.ts` | MCP server discovery via Streamable HTTP (tools, version, systems count). |
| `services/control-panel/src/app/shared/components/mcp-server-info.component.ts` | Reusable Angular component for MCP server info display. |
| `.github/workflows/ci.yml` | CI: typecheck + build on push to staging. |
| `.github/workflows/deploy-hugo.yml` | Deploy all Docker services to Hugo via GHCR. |
| `services/copilot-api/src/routes/client-memory.ts` | Client memory CRUD endpoints with resolver cache invalidation. |
| `services/copilot-api/src/routes/ticket-routes.ts` | Ticket route CRUD + step type registry for configurable analysis pipelines. |
| `services/copilot-api/src/routes/release-notes.ts` | Release notes API: commit ingestion, AI summarization, GitHub backfill, service filtering. |
| `services/copilot-api/src/routes/ingest.ts` | Ingestion API: queue endpoints for email/scheduled/manual payloads, plus `GET /api/ingest/runs` and `GET /api/ingest/runs/:id` for run history. |
| `services/ticket-analyzer/src/ingestion-engine.ts` | BullMQ processor for the ingestion pipeline; delegates to route steps and wraps tracker calls in a best-effort safeTracker proxy. |
| `services/ticket-analyzer/src/ingestion-tracker.ts` | `IngestionRunTracker` — records per-step status, timing, and output to `ingestion_runs`/`ingestion_run_steps` DB tables. |
| `services/copilot-api/src/routes/failed-jobs.ts` | Failed job management API: list, retry (single/all), discard (single/all) across all BullMQ queues. |
| `services/copilot-api/src/routes/email-logs.ts` | Email processing log API: list/filter logs, stats summary, retry and reclassify endpoints. |

## Adding a New Service or Worker

Every new service or worker **must** integrate with the operational infrastructure before it ships. Follow this checklist:

### Health & Monitoring
1. **Health endpoint** — Use `createHealthServer(name, port, { getDetails })` from shared-utils. Pick the next available `HEALTH_PORT` (current: imap-worker=3101, devops-worker=3102, issue-resolver=3103, status-monitor=3105, ticket-analyzer=3106, probe-worker=3107). Note: copilot-api uses port 3000 for its API server with a `/api/health` route, not a separate health port.
2. **Structured logging** — Use `createLogger(name)` from shared-utils (Pino, writes to stderr).
3. **Zod config** — Validate all env vars via `loadConfig(schema)` from shared-utils.

### Control Panel Status Page
4. **Backend probe** — Add the service to `services/copilot-api/src/routes/system-status.ts`:
   - Add a `checkWorkerHealth()` call in the `Promise.all` array.
   - Add the health URL env var (e.g. `SERVICE_HEALTH_URL`) to `services/copilot-api/src/config.ts` with a default pointing at the Docker Compose hostname/port.
   - Add the result to the `components` array.
   - Add the service to the `allowedServices` whitelist in the control endpoint.
5. **Frontend card** — Update `services/control-panel/src/app/features/system-status/system-status.component.ts`:
   - Add a `'Display Name': 'docker-service-key'` entry to the `serviceKey()` map.
6. **BullMQ queue** (if applicable) — Add the queue name to the `queues` array in `getBullMQQueueStats()` in `system-status.ts`.

### Containerization & Deployment
7. **Dockerfile** — Create `services/<name>/Dockerfile` following the multi-stage pattern (base → deps → build → production). Copy all workspace `package.json` files in the deps stage for lockfile resolution.
8. **docker-compose.yml** — Add the service entry with env vars, health check, and named volume (if needed for persistent state).
9. **deploy-hugo.yml** — Add to the build matrix and the `docker pull` list in the deploy script.

## Overnight Issue Resolution Workflow

Instructions for cloud sessions (launched via `claude --remote`) that fix batches of GitHub issues autonomously. These sessions load CLAUDE.md but do not have access to custom commands or agents.

### Prerequisites

- The session prompt will list specific GitHub issue numbers and a batch theme.
- The repo is `siir/bronco`. Clone it if not already available.
- Use `gh` CLI for read-only GitHub operations (issue details, labels, etc.).

### Per-Issue Loop

For each issue in the batch, execute these steps in order:

1. **Read the issue** — `gh issue view <number> --json title,body,labels` to get full context.
2. **Create a branch** — `git checkout -b fix/<number>-<short-slug> staging` (e.g., `fix/12-api-validation`). Always branch from `staging`.
3. **Understand the code** — Read the relevant files identified in the issue or implied by the batch theme. Understand existing patterns before making changes.
4. **Fix the issue** — Make the minimum changes necessary. Follow all conventions in this CLAUDE.md (TypeScript, const enum pattern, ESM imports with `.js` extensions, etc.).
5. **Typecheck** — Run `pnpm typecheck`. If it fails, fix the errors. If a fix introduces new type errors in unrelated files, revert and skip (see error handling below).
6. **Build** — Run `pnpm build`. Fix any build errors.
7. **Lockfile check** — If you modified any `package.json`, run `pnpm install` and include `pnpm-lock.yaml` in the commit.
8. **Commit** — Stage only the files you changed. Write a clear commit message that includes `fixes #<number>` so the issue is auto-closed when merged to master: `fix: <description> (fixes #<number>)`. If a single commit fixes multiple issues, include `fixes #N` for each.
9. **Push** — `git push -u origin fix/<number>-<short-slug>`.
10. **Return to staging** — `git checkout staging` before starting the next issue.

**Do NOT create pull requests** — remote sessions cannot create PRs. Just commit and push to the feature branch. PRs will be created manually.

### Error Handling

- **Typecheck/build fails after two attempts**: Revert all changes for that issue (`git checkout staging`), note it as skipped, and move to the next issue.
- **Issue is unclear or requires design decisions**: Skip it. Do not guess at requirements.
- **Merge conflicts**: Each issue gets its own branch from `staging`, so conflicts should not occur between issues in the same batch. If `staging` has moved, `git pull origin staging` before branching.

### Session Summary

After processing all issues, print a summary table:

```
## Results

| Issue | Status | Branch | Notes |
|-------|--------|--------|-------|
| #12 | Fixed | fix/12-api-validation | Added Zod validation to POST /api/tickets |
| #15 | Fixed | fix/15-email-input-checks | Added input length checks to email routes |
| #18 | Skipped | — | Unclear requirements, needs design decision |
```

### Branch Naming

- Pattern: `fix/<issue-number>-<short-slug>`
- The slug should be 2-4 words, lowercase, hyphen-separated
- Examples: `fix/12-api-validation`, `fix/7-devops-retry-logic`, `fix/31-sql-injection-guard`

### What NOT to Do

- Do not push to `master`, `main`, `develop`, or `release` — always use feature branches.
- Do not create pull requests — remote sessions cannot create PRs.
- Do not make unrelated changes or "improvements" outside the scope of each issue.
- Do not add dependencies without explicit justification in the issue.
- Do not amend or force-push — create new commits if fixes are needed.
- Do not skip the typecheck/build step.
