# CLAUDE.md - Project Instructions for Claude Code

## Project: Bronco

AI-augmented database and software architecture operations platform. Single-operator tool for managing client database systems (primarily Azure SQL Managed Instances), triaging tickets across database performance, bug fixes, feature requests, code reviews, and architecture tasks.

## Architecture Quick Reference

- **Monorepo**: pnpm workspaces. Shared packages in `packages/`, services in `services/`, MCP servers in `mcp-servers/`.
- **Control plane DB**: PostgreSQL (Prisma ORM). Schema at `packages/db/prisma/schema.prisma`.
- **Client databases**: Azure SQL Managed Instances (primary, SQL cred auth), on-prem SQL Server (future clients). Connected via MCP database server (Node.js/Express) running on Hugo in Docker Compose. The MCP server reads system configs directly from the control plane Postgres `System` table and decrypts passwords using `ENCRYPTION_KEY`.
- **MCP Platform Server**: Exposes all Bronco platform operations (tickets, clients, people, probes, AI usage, etc.) as MCP tools. Uses Prisma directly (no HTTP hop to copilot-api). Exception: `run_tool_request_dedupe` proxies to copilot-api via HTTP because the dedupe logic depends on AIRouter and `mcp-discovery` which don't live in the mcp-platform dep graph. Runs on Hugo in Docker Compose (port 3110).
- **AI routing**: Local Ollama for triage/categorize/summarize/extract; Claude API for deep analysis, code review, architecture review, bug analysis, schema review, feature analysis.
- **Hugo** (control plane VM): Ubuntu 24.04 LTS on ESXi NUC. Runs copilot-api (Fastify), imap-worker, ticket-analyzer, devops-worker, issue-resolver, status-monitor, slack-worker, scheduler-worker, mcp-database, mcp-platform, mcp-repo, Postgres, Redis, Caddy, and cloudflared (Cloudflare Tunnel for public ingress at `itrack.siirial.com`) via Docker Compose.
- **Mac mini (siiriaplex)**: Runs Ollama for local LLM inference.
- **CI/CD**: GitHub Actions — CI runs on push to `staging` (typecheck + build), not on every PR update. Feature branches PR into `staging`; staging PRs into `master`. Pushes to `master` that change app-relevant paths (packages/, services/, mcp-servers/, docker-compose.yml, lockfile) auto-tag a semver release (`tag-release.yml`), which triggers deploy-hugo (GHCR + SSH via Tailscale). Docs-only or workflow-only changes do not trigger a release or deploy. To bump major/minor, push a tag manually before merging staging → master.
- **Analysis strategies (v1 vs v2)**: Four runners live in parallel files under `services/ticket-analyzer/src/analysis/`: `flat-v1.ts`, `flat-v2.ts`, `orchestrated-v1.ts`, `orchestrated-v2.ts`. `shared.ts` holds version-agnostic primitives only; `v2-knowledge-doc.ts` and `v2-prompts.ts` hold v2-only helpers (`kd_*` compose, fallback-fill, snapshot, prompt snippets). v2 is default; v1 is opt-in via AppSetting `analysis-strategy-version`. v1 is historical fidelity (pre-truncation, pre-`kd_*`, pre-sub-task-summary split) and must not be modified to add v2 features. v1 never supported orchestrated re-analysis — the dispatcher redirects re-analysis on v1 orchestrated to v1 flat.

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
- **MCP Platform Server Sync**: When adding or modifying a copilot-api route, also add or update the corresponding MCP tool in `mcp-servers/platform/src/tools/`. Every API operation should be accessible via both REST and MCP.

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

## Ticket Statuses

| Status | Class | Description |
|--------|-------|-------------|
| `NEW` | open | Pre-analysis: ticket was just created and the analyzer pipeline has not yet run. All ingestion paths set this. |
| `OPEN` | open | Post-analysis: analysis complete, ticket is active and awaiting operator action or external response. The analyzer auto-transitions `NEW → OPEN` at end-of-run (unless the ticket was set to `WAITING` by the sufficiency check). |
| `IN_PROGRESS` | open | Actively being worked on by the operator. |
| `WAITING` | open | Awaiting external input or response. Set by the analyzer when sufficiency eval returns `NEEDS_USER_INPUT`. |
| `RESOLVED` | closed | Issue has been resolved. |
| `CLOSED` | closed | Ticket is closed. |

`NEW`, `OPEN`, `IN_PROGRESS`, and `WAITING` are all in `OPEN_STATUSES` and are treated as "active" tickets throughout the codebase (filters, notifications, MCP queries).

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

`maxTokens` is also configurable per task type via `AiModelConfig` (Settings page → AI Models). When unset, the provider default is used. Replaces the removed `ANALYSIS_MAX_TOKENS` env var.

**Local LLM (Ollama)** — fast, cost-free (default):
- `TRIAGE` — Set priority, extract key entities
- `CATEGORIZE` — Classify into TicketCategory
- `SUMMARIZE` — Summarize email threads
- `DRAFT_EMAIL` — Generate draft responses
- `EXTRACT_FACTS` — Pull structured data from text
- `SUMMARIZE_TICKET` — Summarize ticket context for analysis
- `SUGGEST_NEXT_STEPS` — Suggest next actions for a ticket
- `CLASSIFY_INTENT` — Classify user comment intent (approval, rejection, question)
- `CLASSIFY_CHAT_INTENT` — Classify operator chat-reply intent (continue / refine / fresh_start / not_a_question) for the ticket Chat tab
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
- `EXTRACT_CLIENT_LEARNINGS` — Extract client-specific knowledge from resolved tickets into client memory
- `GENERATE_RESOLUTION_PLAN` — Generate a resolution plan for operator review before code execution
- `CUSTOM_AI_QUERY` — Flexible configurable AI query within a route pipeline (task type and model overridable per step)
- `ANALYZE_APP_HEALTH` — Scheduled platform health analysis — ticket patterns, AI usage trends, error logs, and codebase review
- `DETECT_TOOL_GAPS` — Post-hoc review of a completed analysis to detect capability gaps; upserts tool requests into the registry (default: Claude Haiku for cheap review)
- `ANALYZE_TOOL_REQUESTS` — Admin-triggered dedupe agent: compares a client's PROPOSED/APPROVED tool requests against each other and against the live MCP tool catalog (platform + repo + database + per-client integrations) and writes `suggestedDuplicateOf*` / `suggestedImprovesExisting*` fields on rows (default: Claude Sonnet)

### Task Type Discipline (CRITICAL)

Each AI task type controls provider routing (Ollama vs Claude), model selection, and per-client overrides via `AiModelConfig`. **Never reuse an existing task type for a different purpose.** If an operator overrides `DEEP_ANALYSIS` to use a cheaper model for a client, that override affects every call site using `DEEP_ANALYSIS` — including any unrelated operations that were reusing it as a catch-all.

Rules:
- **Create a new task type** when the work has a fundamentally different capability requirement, output format, or provider routing need than any existing type.
- **`DEEP_ANALYSIS` is for single-shot ticket analysis**, not a generic fallback. Do not use it for agentic tool loops, admin operations, or plan generation.
- **`SUMMARIZE` is for email threads.** Use `SUMMARIZE_LOGS` for monitoring data, probe results, and log entries.
- **`CLASSIFY_INTENT` is for DevOps workflow intent.** Use `CLASSIFY_CHAT_INTENT` for the ticket Chat tab reply classifier — separate task type so operator model overrides don't cross-contaminate.
- **`GENERATE_DEVOPS_PLAN` is for DevOps workflow plans (Ollama).** Use `GENERATE_RESOLUTION_PLAN` for code resolution plans (Claude).
- **`RESOLVE_ISSUE` is for code generation**, not plan generation.
- **`CUSTOM_AI_QUERY` is the correct choice** for one-off administrative AI calls that don't fit any specific task type (e.g., pricing catalog refresh).
- When adding a new task type: add to `packages/shared-types/src/ai.ts`, `packages/ai-provider/src/model-config-resolver.ts` (default provider), `packages/ai-provider/src/task-capabilities.ts`, and update this section of CLAUDE.md.

### Enforcement

Direct imports from `@anthropic-ai/sdk` outside `packages/ai-provider/src/` are banned via ESLint's `no-restricted-imports` rule (see `eslint.config.mjs`). All AI calls MUST go through `AIRouter.generate()` / `AIRouter.generateWithTools()` so every call writes an `ai_usage_logs` row for cost tracking. Every call site MUST also pass `context: { entityId, entityType, clientId }` so the row is queryable from entity-scoped views (ticket pages, AI Usage reports). `entityType` values (canonical — see `EntityType` in `packages/shared-types/src/log.ts`): `'ticket'`, `'operational_task'`, `'probe'`, `'email'`, `'system'`, `'operator'`, `'client'` — match the consumer query's filter. If a call is genuinely not entity-scoped (cross-ticket summarization, archive retention), pass `context: { entityType: null, entityId: null, clientId: null }` explicitly so reviewers know it's intentional.

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

## Knowledge Document

Each ticket carries a structured "knowledge document" (`Ticket.knowledgeDoc`) that the analysis pipeline incrementally fills during investigation. As of the section-keyed restructure it is a templated markdown artifact — not an append-only blob — and agents edit it through the `kd_*` MCP tools rather than concatenating text.

### Template

The doc always contains nine top-level sections in this order: `Problem Statement`, `Environment`, `Evidence`, `Hypotheses`, `Root Cause`, `Recommended Fix`, `Risks`, `Open Questions`, `Run Log`. Subsections (`### …`) are only permitted under `Evidence`, `Hypotheses`, and `Open Questions`. Each section body is capped at 10 000 characters. Sidecar metadata (`Ticket.knowledgeDocSectionMeta`) stores per-section `length` / `lastUpdatedAt` / `updatedByRunId` so the control panel can render the TOC without re-parsing the markdown.

### MCP tools (platform server)

| Tool | Purpose |
|------|---------|
| `kd_read_toc` | Return the section tree for a ticket (titles, lengths, timestamps, subsections). |
| `kd_read_section` | Read one section by `sectionKey` (top-level slug or `parent.childSlug`). |
| `kd_update_section` | Replace or append content for a top-level section. |
| `kd_add_subsection` | Add a `### <title>` child under `evidence` / `hypotheses` / `openQuestions`. |

All four tools run inside `withTicketLock` (Postgres advisory transaction lock on `hashtext(ticketId)`) so concurrent agent calls and REST writes serialize per ticket. REST mirrors live at `/api/tickets/:id/knowledge-doc/{toc,section/:key,subsection}`.

### Analysis pipeline integration

- Flat and orchestrated analyzers append `KD_SYSTEM_PROMPT_SNIPPET` to their system prompts, nudging (not forcing) the agent to use `kd_*` tools during investigation.
- End-of-run, `fallbackFillRequiredSections(db, ticketId, reason)` populates any empty required sections (`problemStatement`, `rootCause`, `recommendedFix`) with a marker so downstream composition never renders a blank analysis.
- `composeFinalAnalysis(knowledgeDoc, sectionMeta, agentExecutiveSummary)` merges the agent's executive summary with Problem Statement / Root Cause / Recommended Fix / Risks pulled from the doc — that composed text is what lands in the `AI_ANALYSIS` ticket event and email.
- After each iteration (and at run end) the orchestrator writes a `KnowledgeDocSnapshot` row capturing the doc + sidecar, so future iteration-diff views have ground truth per iteration.

## Ticket Route Step Types

Ticket routes define configurable analysis pipelines executed when tickets are processed. Each route consists of ordered steps, each performing a specific processing function.

### Pipeline Phases

| Phase | Steps | Description |
|-------|-------|-------------|
| **Ingestion** | RESOLVE_THREAD, SUMMARIZE_EMAIL, CATEGORIZE, TRIAGE_PRIORITY, DRAFT_RECEIPT, GENERATE_TITLE, CREATE_TICKET | Source-specific ticket enrichment and creation |
| **Context Loading** | LOAD_CLIENT_CONTEXT, LOAD_ENVIRONMENT_CONTEXT | Inject per-client memories, playbooks, and environment instructions |
| **Analysis** | EXTRACT_FACTS, GATHER_REPO_CONTEXT, GATHER_DB_CONTEXT, DEEP_ANALYSIS, AGENTIC_ANALYSIS, UPDATE_ANALYSIS, DRAFT_FINDINGS_EMAIL, SUGGEST_NEXT_STEPS, UPDATE_TICKET_SUMMARY, CUSTOM_AI_QUERY | Comprehensive AI analysis with full context |
| **Dispatch** | NOTIFY_OPERATOR, DISPATCH_TO_ROUTE, ADD_FOLLOWER | Notification, routing, and follow-up actions |

### Step Type Reference

| Step Type | Phase | AI Task | Description |
|-----------|-------|---------|-------------|
| `RESOLVE_THREAD` | Ingestion | — | Email threading (Message-ID + subject fallback, client-scoped) |
| `SUMMARIZE_EMAIL` | Ingestion | SUMMARIZE | Condense email threads |
| `CATEGORIZE` | Ingestion | CATEGORIZE | Classify into TicketCategory |
| `TRIAGE_PRIORITY` | Ingestion | TRIAGE | Set priority level |
| `DRAFT_RECEIPT` | Ingestion | DRAFT_EMAIL | Generate auto-reply |
| `GENERATE_TITLE` | Ingestion | GENERATE_TITLE | Create ticket title |
| `CREATE_TICKET` | Ingestion | — | Create ticket with requester linking and deduplication |
| `LOAD_CLIENT_CONTEXT` | Context | — | Inject client memories |
| `LOAD_ENVIRONMENT_CONTEXT` | Context | — | Loads the ticket's environment `operationalInstructions` and injects them into the pipeline context for downstream analysis steps |
| `EXTRACT_FACTS` | Analysis | EXTRACT_FACTS | Pull structured data |
| `GATHER_REPO_CONTEXT` | Analysis | — | Load code from repos via MCP |
| `GATHER_DB_CONTEXT` | Analysis | — | Load DB schema/metrics via MCP |
| `DEEP_ANALYSIS` | Analysis | DEEP_ANALYSIS | Comprehensive Claude analysis |
| `AGENTIC_ANALYSIS` | Analysis | DEEP_ANALYSIS | Claude analysis with MCP tool loops (agentic) |
| `UPDATE_ANALYSIS` | Analysis | DEEP_ANALYSIS | Incremental analysis for reply handling (delta, not full re-run) |
| `DRAFT_FINDINGS_EMAIL` | Analysis | DRAFT_EMAIL | Compose findings email |
| `SUGGEST_NEXT_STEPS` | Analysis | SUGGEST_NEXT_STEPS | Recommend actions |
| `UPDATE_TICKET_SUMMARY` | Analysis | — | Finalize ticket summary |
| `CUSTOM_AI_QUERY` | Analysis | CUSTOM_AI_QUERY | Configurable AI query with selectable context sources and optional fresh MCP/repo searches |
| `DETECT_TOOL_GAPS` | Analysis | DETECT_TOOL_GAPS | Scans completed analysis for missing-tool gaps; upserts into ToolRequest registry via the shared registry helper. |
| `NOTIFY_OPERATOR` | Dispatch | — | Send notification to operator |
| `DISPATCH_TO_ROUTE` | Dispatch | — | Dispatch ticket to another route for further processing |
| `ADD_FOLLOWER` | Dispatch | — | Add a follower to the ticket |

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

## PR Review Comment Handling

When subscribed to PR activity and review comments arrive, **do not just fix the code silently**. For each review comment:

1. **Push the code fix** addressing the feedback.
2. **Reply to the review comment** on GitHub (via `mcp__github__add_reply_to_pull_request_comment`) explaining what was changed and why.
3. **Resolve the review thread** (via `mcp__github__resolve_review_thread`) once the fix is pushed.

This applies to both automated reviewers (Copilot) and human reviewers. The goal is to close the feedback loop on GitHub itself so the PR author doesn't have to manually respond to and resolve each thread.

## Build and Test

**Build order matters.** On a fresh checkout (or after `pnpm clean`), you MUST run `pnpm build` BEFORE `pnpm typecheck`. Workspace packages like `ai-provider`, `shared-utils`, and the services depend on the compiled `.d.ts` outputs of `shared-types` and `shared-utils`. Running `pnpm typecheck` first will fail with errors like `Cannot find module '@bronco/shared-types' or its corresponding type declarations` because those declarations only exist after `pnpm build` produces them in each package's `dist/` folder. The same rule applies after pulling changes that touch `packages/shared-types/`, `packages/shared-utils/`, or `packages/db/` — rebuild before typechecking.

```bash
pnpm install              # Install all dependencies
pnpm build                # Build all packages (REQUIRED before typecheck on a fresh checkout)
pnpm typecheck            # Type check all packages (run AFTER pnpm build)
pnpm clean                # Remove all dist/ folders (after this, re-run pnpm build before typecheck)

pnpm db:generate          # Regenerate Prisma client
pnpm db:migrate           # Run Prisma migrations
pnpm db:seed              # Seed development data

pnpm dev:api              # Start copilot-api (Fastify, port 3000)
pnpm dev:worker           # Start imap-worker
pnpm dev:analyzer         # Start ticket-analyzer worker
pnpm dev:devops           # Start devops-worker (Azure DevOps sync)
pnpm dev:mcp-db           # Start MCP database server (Express, port 3100, needs DATABASE_URL + ENCRYPTION_KEY)
pnpm dev:mcp-platform     # Start MCP platform server (Express, port 3110, needs DATABASE_URL + ENCRYPTION_KEY + REDIS_URL)
pnpm dev:resolver         # Start issue-resolver worker
pnpm dev:status-monitor   # Start system status monitor
pnpm dev:slack            # Start slack-worker (Slack Socket Mode connections)
pnpm dev:scheduler        # Start scheduler-worker (cron jobs, alerts, invoicing)
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
| `mcp-servers/platform/src/tools/index.ts` | MCP platform tool registration (all Bronco API operations). |
| `mcp-servers/platform/src/tools/read-tool-result-artifact.ts` | Platform MCP tool for reading truncated tool-result artifacts (head/tail preview → full content via offset+limit or grep). |
| `mcp-servers/platform/src/tools/knowledge-doc.ts` | Platform MCP `kd_*` tools (`kd_read_toc`, `kd_read_section`, `kd_update_section`, `kd_add_subsection`) — templated section-keyed edits on `Ticket.knowledgeDoc` + `knowledgeDocSectionMeta` sidecar, guarded by a per-ticket `pg_advisory_xact_lock`. |
| `packages/shared-utils/src/knowledge-doc.ts` | Shared knowledge-doc core: 9-section template, parse/compose, slug-keyed read/update with 10k-char per-section cap; used by MCP tools, REST mirrors, and the analysis pipeline. |
| `packages/shared-utils/src/advisory-lock.ts` | `withTicketLock(db, ticketId, fn)` — wraps a Prisma transaction with `pg_advisory_xact_lock(hashtext($1))` so kd_* writes from agents and REST endpoints can't race. |
| `services/copilot-api/src/routes/knowledge-doc.ts` | REST mirrors for the four kd tools under `/api/tickets/:id/knowledge-doc/*` — used by the Knowledge tab to render the TOC + section bodies. |
| `mcp-servers/database/src/security/query-validator.ts` | SQL keyword blocklist. |
| `mcp-servers/database/src/security/audit-logger.ts` | Query audit logging (Pino structured JSON to stdout). |
| `packages/ai-provider/src/router.ts` | AI task routing (dynamic provider/model resolution via ModelConfigResolver). |
| `packages/ai-provider/src/client-memory-resolver.ts` | Per-client memory context resolver for AI analysis pipeline (cached, 5-min TTL). |
| `packages/ai-provider/src/model-config-resolver.ts` | DB-backed model config resolver (CLIENT → APP_WIDE → default layering, cached). |
| `services/copilot-api/src/routes/ai-config.ts` | AI model config CRUD + resolution preview endpoints (`/api/ai-config`). |
| `services/copilot-api/src/routes/tickets.ts` | Ticket CRUD endpoints. |
| `services/imap-worker/src/processor.ts` | Email collector: parse, noise-filter, push to ingestion queue. |
| `services/ticket-analyzer/src/analysis/shared.ts` | Agentic tool-call execution + structured MCP error envelopes (`_mcp_tool_error`), per-run retry-limiter, and error-class categorization consumed by v2 runners. |
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
| `services/copilot-api/src/routes/people.ts` | People (unified Contact + Portal User) CRUD endpoints; replaces legacy contacts.ts and client-users.ts. |
| `packages/shared-types/src/person.ts` | Person model — unified contact/portal-user with `hasPortalAccess` discriminator. |
| `mcp-servers/platform/src/tools/people.ts` | MCP people tools (list, get, create, update, delete). |
| `services/copilot-api/src/routes/client-memory.ts` | Client memory CRUD endpoints with resolver cache invalidation. |
| `services/copilot-api/src/routes/ticket-routes.ts` | Ticket route CRUD + step type registry for configurable analysis pipelines. |
| `services/copilot-api/src/routes/tool-requests.ts` | Gap Requests CRUD API (admin-only): list/filter tool-request records (by status, kind, client), view rationale history, transition status (approve/reject/duplicate/implemented/reopen), delete; PATCH accepts `kind` for operator corrections. |
| `packages/shared-utils/src/tool-request-registry.ts` | Dedup upsert helper for tool-request records keyed on `(clientId, requestedName)`; appends rationale rows without clobbering operator edits. |
| `services/copilot-api/src/services/tool-request-dedupe.ts` | Admin-triggered dedupe agent: discovers MCP catalog per-client + shared, calls Claude via `ANALYZE_TOOL_REQUESTS`, persists `suggestedDuplicateOf*` / `suggestedImprovesExisting*` suggestions transactionally. |
| `packages/shared-utils/src/tool-request-github.ts` | Shared GitHub-issue helper for tool requests: reads encrypted token from `system-config-github`, repo from `tool-requests-github-default-repo` AppSetting (or override), POSTs via GitHub REST v3, persists `githubIssueUrl` + `implementedInIssue` on the row. |
| `mcp-servers/platform/src/tools/request-tool.ts` | MCP `request_tool` that analyzers call when they hit a capability gap; accepts `kind` (`NEW_TOOL` / `BROKEN_TOOL` / `IMPROVE_TOOL`); enforces the per-run rate limit from AppSetting `tool-request-rate-limit-per-run`. |
| `mcp-servers/platform/src/tools/tool-requests.ts` | MCP CRUD tools for tool requests (list/get/update/delete) + `create_tool_request_github_issue` wrapper used by the platform surface. |
| `services/control-panel/src/app/features/tool-requests/tool-request-list.component.ts` | Admin Tool Requests page: list + detail dialog with rationale history, linked tickets, status transition controls, client filter + Run Dedupe button, AI suggestion pills with Accept/Dismiss, and Create GitHub Issue flow for approved requests. |
| `mcp-servers/repo/src/tools/search-code.ts` | Per-repo MCP `search_code` tool — grep across repo tree, broad default extension list with per-repo `CodeRepo.fileExtensions` override. |
| `mcp-servers/repo/src/tools/read-file.ts` | Per-repo MCP `read_file` tool — read a single file by path with optional line-range slice. |
| `mcp-servers/repo/src/tools/list-files.ts` | Per-repo MCP `list_files` tool — list files in a directory tree, extension-filtered. |
| `mcp-servers/repo/src/tools/prepare-repo.ts` | Per-repo MCP `prepare_repo` tool — called in parallel by `GATHER_REPO_CONTEXT` to clone/pull active repos before analysis. |
| `services/control-panel/src/app/features/tickets/chat/chat-tab.component.ts` | Chat tab: operator-facing conversation surface with intent-based re-analysis (`continue` / `refine` / `fresh_start`) classified via `CLASSIFY_CHAT_INTENT`. Posts `CHAT_MESSAGE` ticket events. |
| `services/control-panel/src/app/features/tickets/analysis-trace/analysis-trace.component.ts` | Analysis Trace tab: three-pass merge (tree build → same-prompt merge → tool-call collapse) over `ai_usage_logs` with strategy stamp rendering and Raw Logs fallback for legacy data. |
| `packages/shared-types/src/access-type.ts` | `AccessType` + `OperatorRole` (ADMIN / STANDARD) enums — foundation for scoped-ops access control and portal-user vs operator discrimination. Used by `resolveClientScope` in `services/copilot-api/src/plugins/client-scope.ts`. |
| `services/copilot-api/src/routes/artifacts.ts` | MCP tool artifact storage and retrieval endpoints (`/api/artifacts`). |
| `services/copilot-api/src/routes/release-notes.ts` | Release notes API: commit ingestion, AI summarization, GitHub backfill, service filtering. |
| `services/copilot-api/src/routes/ingest.ts` | Ingestion API: queue endpoints for email/scheduled/manual payloads, plus `GET /api/ingest/runs` and `GET /api/ingest/runs/:id` for run history. |
| `services/ticket-analyzer/src/ingestion-engine.ts` | BullMQ processor for the ingestion pipeline; delegates to route steps and wraps tracker calls in a best-effort safeTracker proxy. |
| `services/ticket-analyzer/src/ingestion-tracker.ts` | `IngestionRunTracker` — records per-step status, timing, and output to `ingestion_runs`/`ingestion_run_steps` DB tables. |
| `services/copilot-api/src/routes/failed-jobs.ts` | Failed job management API: list, retry (single/all), discard (single/all) across all BullMQ queues. |
| `services/copilot-api/src/routes/email-logs.ts` | Email processing log API: list/filter logs, stats summary, retry and reclassify endpoints. |
| `services/slack-worker/src/index.ts` | Slack worker entry: system + per-client Slack Socket Mode connections, interaction handlers. |
| `services/scheduler-worker/src/index.ts` | Scheduler worker entry: BullMQ cron workers (log-summarize, system-analysis, mcp-discovery, model-catalog-refresh, prompt-retention), auto-invoicing, operational alerts. |
| `services/scheduler-worker/src/system-analyzer.ts` | System analysis dispatcher (TICKET_CLOSE, POST_ANALYSIS, SCHEDULED trigger types). `analyze-post-pipeline` jobs run up to 4 attempts total (1 initial + 3 retries at 5s / 10s / 20s exponential backoff) on transient Anthropic 5xx / network errors; non-transient errors short-circuit via `UnrecoverableError`. Post-pipeline failures are non-blocking (best-effort meta-analysis). |
| `services/ticket-analyzer/src/client-learning-worker.ts` | Client learning extraction from resolved tickets → client memory. |
| `services/ticket-analyzer/src/recommendation-executor.ts` | Executes system analysis recommendations (operational tasks). |
| `services/probe-worker/src/builtin-tools.ts` | Built-in probe tool definitions (scan_app_logs, analyze_app_health). |

## Adding a New Service or Worker

Every new service or worker **must** integrate with the operational infrastructure before it ships. Follow this checklist:

### Health & Monitoring
1. **Health endpoint** — Use `createHealthServer(name, port, { getDetails })` from shared-utils. Pick the next available `HEALTH_PORT` (current: imap-worker=3101, devops-worker=3102, issue-resolver=3103, status-monitor=3105, ticket-analyzer=3106, probe-worker=3107, slack-worker=3108, scheduler-worker=3109, mcp-platform=3110, mcp-repo=3111). Note: copilot-api uses port 3000 for its API server with a `/api/health` route, not a separate health port. MCP servers use their main Express port for `/health`.
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
