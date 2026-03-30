# Copilot Skills Reference

All capabilities of the Bronco platform, organized by domain. Each skill describes what triggers it, which services are involved, and how data flows between them.

Each skill also includes a **Configurability** section showing what is currently configurable (via env vars, DB, or API) and what remains hardcoded. The end goal is for every skill's triggers, endpoints, and key behavior to be configurable from the control panel — both as system-wide defaults and per-client overrides.

---

## 1. Ticket Intake

### 1a. Email Intake

Polls IMAP mailboxes (global + per-client integrations) for new messages and converts them into tickets.

**Trigger:** imap-worker polling loop (every 60s, configurable per integration)

**Flow:**

```
IMAP mailbox
  → imap-worker (poller)
  → Redis: email-ingestion queue
  → imap-worker (emailProcessor)
      ├─ Parse RFC822 (mailparser)
      ├─ Dedup by Message-ID or SHA-256 hash
      ├─ Match sender → Contact → Client (domain mapping)
      ├─ Thread by In-Reply-To / References headers
      ├─ Create/update Ticket (Postgres)
      └─ Create TicketEvent (EMAIL_INBOUND)
  → Redis: ticket-analysis queue (see Skill 2)
```

**Key calls:** IMAP FETCH, Prisma Ticket/TicketEvent/Contact upserts

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| Poll interval | ✅ Configurable | Env: `POLL_INTERVAL_SECONDS` (default 60) | Global only — not yet per-client |
| IMAP endpoint | ✅ Per-client | DB: `ClientIntegration` (type IMAP) | Host, port, user, encrypted password |
| SMTP endpoint | ⚠️ Global only | Env: `SMTP_HOST`, `SMTP_PORT`, etc. | Not per-client — all replies go through one SMTP server |
| Summary event limit | ❌ Hardcoded | `SUMMARY_EVENT_LIMIT = 50` in analyzer | Should be configurable |
| Auto-reply behavior | ❌ Hardcoded | Always drafts + sends reply | No toggle to disable auto-reply per client |

**Needs implementation:**
- Per-client poll interval (override the global default per integration)
- Per-client SMTP config (different reply-from addresses per client)
- Toggle to enable/disable auto-reply per client
- Expose poll interval and auto-reply toggle in control panel integration settings

---

### 1b. Azure DevOps Intake

Polls an Azure DevOps project for new/updated work items and syncs each as a ticket.

**Trigger:** devops-worker polling loop (every 120s, configurable)

**Flow:**

```
Azure DevOps REST API (WIQL query)
  → devops-worker (poller, incremental watermark)
  → Redis: devops-sync queue
  → devops-worker (processor)
      ├─ Resolve/create Client by shortCode
      ├─ Create/sync Ticket (title, description, priority, linked items)
      ├─ Sync comments → TicketEvent (DEVOPS_INBOUND)
      └─ If assigned to AZDO_ASSIGNED_USER → trigger Conversational Workflow (see Skill 6)
```

**Key calls:** Azure DevOps WIQL queries, work item GET/PATCH, comment POST, Prisma Ticket/DevOpsSyncState upserts

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| Poll interval | ✅ Configurable | Env: `POLL_INTERVAL_SECONDS` (default 120) | Global only |
| Azure DevOps endpoint | ⚠️ Global only | Env: `AZDO_ORG_URL`, `AZDO_PROJECT`, `AZDO_PAT` | Per-client planned (integration type `AZURE_DEVOPS` exists in DB schema) but not yet wired to the worker |
| Assigned user filter | ⚠️ Global only | Env: `AZDO_ASSIGNED_USER` | Single operator per instance |
| Client mapping | ⚠️ Global only | Env: `AZDO_CLIENT_SHORT_CODE` | All work items map to one client |
| Max question rounds | ❌ Hardcoded | `MAX_QUESTION_ROUNDS = 10` in workflow.ts | Should be configurable |

**Needs implementation:**
- Wire per-client `ClientIntegration` (type `AZURE_DEVOPS`) to the worker — the DB schema already supports it
- Per-client poll interval override
- Configurable max question rounds in control panel
- Multi-project support (poll multiple Azure DevOps projects, each mapped to a client)

---

### 1c. Manual Ticket Creation

Created directly through the REST API or control panel UI.

**Trigger:** `POST /api/tickets` (copilot-api)

**Flow:**

```
Client/UI → copilot-api (POST /api/tickets)
  ├─ Auto-provisions CLIENT user for requester contact
  ├─ Create Ticket (source: MANUAL) in Postgres
  └─ Return ticket
```

**Configurability:** Fully configurable — all fields are set by the caller. No hardcoded behavior.

---

## 2. Ticket Triage & Analysis

AI classifies, summarizes, and recommends actions for newly created tickets.

**Trigger:** Enqueued by email intake (Skill 1a) on the `ticket-analysis` queue

**Flow:**

```
Redis: ticket-analysis queue
  → imap-worker (analysisProcessor)
      ├─ AIRouter → Ollama: CATEGORIZE (set TicketCategory)
      ├─ AIRouter → Ollama: TRIAGE (set Priority, extract entities)
      ├─ AIRouter → Ollama: SUMMARIZE (email thread summary)
      ├─ AIRouter → Ollama: SUGGEST_NEXT_STEPS
      ├─ (optional) MCP database server: inspect_schema / run_query
      │   if ticket mentions database issues
      ├─ AIRouter → Ollama: DRAFT_EMAIL (response draft)
      ├─ SMTP: send outbound email
      ├─ Create TicketEvents (AI_ANALYSIS, AI_RECOMMENDATION, EMAIL_OUTBOUND)
      └─ Update Ticket (status, priority, category, summary)
```

**AI routing:** All triage tasks use local Ollama (fast, cost-free). MCP database calls are optional based on ticket content.

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| AI provider (Ollama vs Claude) | ✅ Configurable | DB: `AiModelConfig` + control panel AI Models tab | Per-task, per-client provider+model overrides via `ModelConfigResolver` |
| Ollama model | ✅ Configurable | DB: `AiModelConfig` (hardcoded default `llama3.1:8b`) | Per-task, per-client via `ModelConfigResolver` |
| MCP database URL | ✅ Configurable | Env: `MCP_DATABASE_URL` | Optional; enables DB context in analysis |
| Temperature per task | ❌ Hardcoded | Per-prompt in `prompts/imap.ts` | Should be overridable |
| Pipeline steps | ❌ Hardcoded | Always runs full pipeline (categorize → triage → summarize → draft → send) | No way to skip steps or reorder per client |

**Needs implementation:**
- Configurable pipeline — toggle individual steps on/off per client (e.g., skip auto-reply, skip DB enrichment)
- Temperature/maxTokens overridable via prompt override system (see Skill 9)

---

## 3. Email Response Drafting

Generates and sends an AI-drafted reply to the ticket requester.

**Trigger:** Part of the ticket analysis pipeline (Skill 2)

**Flow:**

```
analysisProcessor
  → AIRouter → Ollama: DRAFT_EMAIL
  → SMTP transport (nodemailer)
  → Create TicketEvent (EMAIL_OUTBOUND)
```

**Key calls:** Ollama DRAFT_EMAIL, SMTP send

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| Sender name | ✅ Configurable | Env: `EMAIL_SENDER_NAME` (default "Support Team") | Global only |
| SMTP server | ✅ Configurable | Env: `SMTP_HOST`, `SMTP_PORT`, etc. | Global only |
| Draft prompt | ✅ Wired | DB `PromptOverride` for `imap.draft-email.*` keys | Overrides applied at generation time via `PromptResolver` |
| Auto-send toggle | ❌ Hardcoded | Always sends | No option to draft-only (save without sending) per client |

**Needs implementation:**
- Per-client sender name and SMTP config
- Draft-only mode (save to ticket event, let operator review before sending)
- Wire prompt overrides to generation time (Skill 9 dependency)

---

## 4. Database Operations (MCP)

On-demand database inspection and querying through the MCP database server. Used by AI analysis pipelines and directly by Claude Code sessions.

**Trigger:** Called by workers during ticket analysis, or interactively via MCP protocol

**Available tools:**

| Tool | Purpose |
|------|---------|
| `list_systems` | List available database connections |
| `inspect_schema` | Table/column metadata, keys, constraints |
| `run_query` | Read-only SELECT queries (SQL keyword blocklist enforced) |
| `list_indexes` | Index definitions + usage stats (seeks, scans, lookups) |
| `get_blocking_tree` | Current blocking chains with SQL text and wait info |
| `get_wait_stats` | Cumulative wait statistics (benign waits filtered) |
| `get_database_health` | DB sizes, backup status, VLFs, CPU history, memory, I/O latency |

**Flow:**

```
Worker / Claude Code session
  → HTTP request to MCP database server (port 3100)
  → pool-manager.ts (connection factory, by systemId)
  → Client SQL Server (Azure SQL MI, on-prem, etc.)
  → Query validator (blocklist) + audit logger (Pino JSON)
  → JSON result set returned
```

**Key calls:** MCP HTTP endpoint, tedious/mssql driver, audit logger

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| Database connections | ✅ Per-system | JSON config file (`SYSTEMS_CONFIG_PATH`) | Host, port, auth, TLS, pool size, timeouts |
| Max pool size | ✅ Per-system | `maxPoolSize` in config (default 5) | |
| Connection/request timeout | ✅ Per-system | `connectionTimeout` / `requestTimeout` (default 30s) | |
| SQL keyword blocklist | ❌ Hardcoded | `query-validator.ts` | No way to allow additional keywords per system |
| Pool idle timeout | ❌ Hardcoded | 10 minutes in pool-manager | |
| Pool cleanup interval | ❌ Hardcoded | 60 seconds in pool-manager | |
| Available tools | ❌ Hardcoded | All tools always available | No per-system tool restrictions |

**Needs implementation:**
- Move system config from JSON file to DB (or sync JSON → DB) so it's manageable from control panel
- Per-system tool restrictions (e.g., disable `run_query` for production systems)
- Configurable SQL blocklist per system or environment

---

## 5. Automated Issue Resolution

Claude analyzes a ticket and codebase, generates code changes, and pushes a feature branch.

**Trigger:** `POST /api/issue-jobs` (copilot-api) with `ticketId` + `repoId`

**Flow:**

```
copilot-api (POST /api/issue-jobs)
  ├─ Validate: ticket + repo belong to same client
  ├─ Generate branch name: {branchPrefix}/{sanitized-slug}
  ├─ Safety check: not a protected branch (main/master/develop/release)
  ├─ Create IssueJob record (PENDING)
  └─ Redis: issue-resolve queue

issue-resolver worker
  ├─ CLONING — git clone/fetch repo to REPO_WORKSPACE_PATH
  ├─ ANALYZING — Claude API: RESOLVE_ISSUE
  │   (reads codebase structure, matches issue to files, generates changes)
  ├─ APPLYING — write file changes to working directory
  ├─ PUSHING — git commit + push to {branchPrefix}/{slug}
  ├─ COMPLETED — update IssueJob (commitSha, filesChanged, aiUsage)
  └─ Create TicketEvent (CODE_CHANGE)
```

**Safety enforcement (3 layers):**
1. API validation — branchPrefix cannot be empty or a protected name
2. Git layer — `prepareRepo()` and `commitAndPush()` refuse protected branches
3. Branch format — must contain `/` separator

**AI routing:** Claude API (RESOLVE_ISSUE) — heavy agentic reasoning

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| Claude model | ✅ Configurable | DB: `AiModelConfig` (hardcoded default `claude-sonnet-4-6`) | Per-task, per-client via `ModelConfigResolver` |
| Branch prefix | ✅ Per-repo | DB: `CodeRepo.branchPrefix` (default `claude`) | Set via API/control panel |
| Default branch | ✅ Per-repo | DB: `CodeRepo.defaultBranch` (default `master`) | |
| Git author name/email | ✅ Configurable | Env: `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | Global only |
| Repo workspace path | ✅ Configurable | Env: `REPO_WORKSPACE_PATH` | |
| System prompt | ❌ Hardcoded | `resolver.ts` — fixed JSON-output prompt | |
| Max tokens | ❌ Hardcoded | 16,384 | |
| Temperature | ❌ Hardcoded | 0 (deterministic) | |
| File size limit | ❌ Hardcoded | 200KB total source read | |
| Ignored directories | ❌ Hardcoded | `node_modules`, `.git`, `dist`, etc. | |

**Needs implementation:**
- ~~Per-client Claude model override (use opus for high-value clients)~~ ✅ Done — issue-resolver now uses `AIRouter` + `ModelConfigResolver` + `PromptResolver` (no longer calls Anthropic SDK directly)
- Configurable system prompt via prompt override system
- Per-repo ignore patterns and file size limits
- Git author configurable per client

---

## 6. Azure DevOps Conversational Workflow

For work items assigned to the configured operator, runs an AI-driven conversation: asks clarifying questions, proposes a plan, awaits approval, executes, and reports results — all via Azure DevOps comments.

**Trigger:** devops-worker detects an actionable work item (assigned to `AZDO_ASSIGNED_USER`)

**State machine:**

```
idle → analyzing → questioning → planning → awaiting_approval → executing → completed
```

**Flow:**

```
devops-worker (processor, from Skill 1b)
  → WorkflowEngine (state machine)
      ├─ ANALYZING
      │   └─ AIRouter → Ollama: ANALYZE_WORK_ITEM
      │       → post questions as Azure DevOps comments
      ├─ QUESTIONING
      │   └─ Poll for user replies in DevOps comments
      │       → AIRouter → Ollama: CLASSIFY_INTENT (approval / rejection / question)
      ├─ PLANNING
      │   └─ AIRouter → Ollama: GENERATE_DEVOPS_PLAN
      │       → post proposed plan as DevOps comment
      ├─ AWAITING_APPROVAL
      │   └─ Poll for user approval/rejection comment
      ├─ EXECUTING
      │   └─ Execute plan (API calls, SQL, etc.)
      │       → AIRouter → Ollama: DRAFT_COMMENT (results)
      │       → post execution results as DevOps comment
      └─ COMPLETED
          └─ Update DevOpsSyncState, create TicketEvents
```

**Key calls:** Azure DevOps comment POST, Ollama (ANALYZE_WORK_ITEM, CLASSIFY_INTENT, GENERATE_DEVOPS_PLAN, DRAFT_COMMENT), Prisma DevOpsSyncState updates

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| All workflow prompts | ❌ Hardcoded | Constants in `workflow.ts` (SYSTEM_PROMPT_ANALYZE, etc.) | 7 system prompts, none registered as base prompts |
| Max question rounds | ❌ Hardcoded | `MAX_QUESTION_ROUNDS = 10` | Forces plan generation after 10 Q&A cycles |
| Comment marker | ❌ Hardcoded | `<!-- bronco-bot -->` | Used to identify bot comments |
| Approval detection | ❌ Hardcoded | Regex fallback + LLM classification | Regex patterns not configurable |
| State machine transitions | ❌ Hardcoded | Fixed state graph | |

**Needs implementation:**
- Register all 7 workflow prompts as base prompts in the prompt registry so they can be overridden
- Configurable max question rounds (per client or system-wide)
- Wire prompt overrides into workflow engine (currently builds prompts inline)

---

## 7. Log Summarization

AI summarizes application logs — both per-ticket and orphan (unlinked) logs.

**Triggers:**
- **Per-ticket:** Enqueued on `log-summarize` queue when a ticket's status changes (`PATCH /api/tickets/:id`)
- **Orphan logs:** Scheduled every 30 minutes via BullMQ cron (`log-summarize-cron`)
- **On-demand:** `POST /api/log-summaries/generate`, `generate-ticket`, or `generate-orphan`

**Flow:**

```
copilot-api
  ├─ ticket status change → Redis: log-summarize { ticketId }
  ├─ cron (every 30 min) → Redis: log-summarize { orphanOnly: true }
  └─ on-demand API call → Redis: log-summarize { ... }

copilot-api (logSummarizeWorker)
  ├─ Fetch unsummarized logs from Postgres (since last summary windowEnd)
  ├─ Build log digest (timestamp, level, service, message, error)
  ├─ AIRouter → Ollama: SUMMARIZE_LOGS
  └─ Create LogSummary record (ticketId, window, summary, services[])
```

**AI routing:** Ollama (SUMMARIZE_LOGS) — local, cost-free

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| Orphan cron interval | ❌ Hardcoded | 30 minutes in copilot-api queue setup | |
| Per-ticket trigger | ✅ Automatic | Enqueued on ticket status change | |
| On-demand generation | ✅ API | `POST /api/log-summaries/generate*` | |
| Summary prompt | ✅ Wired | DB `PromptOverride` for log summary keys | Overrides applied at generation time via `PromptResolver` |

**Needs implementation:**
- Configurable cron interval (env var or DB setting)
- Wire prompt overrides to generation time

---

## 8. Prompt Management

Customizable AI system prompts with per-client and app-wide overrides. The infrastructure for tuning AI behavior without code changes exists, but is not yet wired into the runtime AI generation pipeline.

**Trigger:** `GET/POST/PATCH/DELETE /api/prompts`, `/api/prompt-overrides`, `/api/keywords`

**Flow:**

```
copilot-api
  ├─ GET /api/prompts — list base prompts (hardcoded, grouped by TaskType)
  ├─ GET /api/prompts/:key — get prompt with active overrides + composed preview
  ├─ POST /api/prompts/preview — preview composed prompt with placeholder values
  ├─ CRUD /api/prompt-overrides — app-wide or per-client prepend/append overrides
  └─ CRUD /api/keywords — token placeholders (e.g., {{CLIENT_NAME}}) for prompts
```

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| Base prompt text | ✅ Defined | Hardcoded in `packages/ai-provider/src/prompts/*.ts` | Read-only in API; source of truth is code |
| App-wide overrides | ✅ CRUD exists | DB: `PromptOverride` (scope `APP_WIDE`, position `PREPEND`/`APPEND`) | Can create/edit/delete via API and control panel |
| Per-client overrides | ✅ CRUD exists | DB: `PromptOverride` (scope `CLIENT`, requires `clientId`) | Can create/edit/delete via API and control panel |
| Composition preview | ✅ Works | `POST /api/prompts/preview` | Shows what the composed prompt would look like |
| Keyword placeholders | ✅ CRUD exists | DB: `PromptKeyword` (`{{token}}` → value mapping) | |
| **Runtime application** | ✅ Wired | `AIRouter.generate()` resolves via `PromptResolver` when `promptKey` is set | All workers pass `promptKey` — overrides applied at generation time |

**Resolved:**

- ✅ `clientId` threaded from ticket data through queue jobs to all AI calls (via `AIRequest.context.clientId`)
- ✅ Task→provider+model routing configurable per task type and per client (see Skill 10)
- ✅ `promptKey` added to `AIRequest` — workers pass registry keys instead of inline strings
- ✅ `PromptResolver` injected into `AIRouter` — resolves overrides before calling the provider
- ✅ All workers refactored: inline system prompts removed, prompt keys used throughout
- ✅ DevOps workflow prompts removed from `workflow.ts` — resolved from registry at runtime

**Remaining:**

- Surface temperature and maxTokens as overridable per prompt in the override system (currently they come from the base prompt definition only)

---

## 9. Deep Analysis (Claude API)

Heavy-reasoning AI tasks that require Claude for complex analysis. Triggered as part of other skills or on-demand.

| Task Type | Description | Typical Trigger |
|-----------|-------------|-----------------|
| `ANALYZE_QUERY` | SQL query plan analysis | Ticket analysis (DB perf tickets) |
| `GENERATE_SQL` | SQL generation / optimization | Ticket analysis, DevOps workflow |
| `REVIEW_CODE` | Code review and quality | Ticket with CODE_REVIEW category |
| `DEEP_ANALYSIS` | General deep analysis | Complex tickets |
| `BUG_ANALYSIS` | Cross-stack bug investigation | BUG_FIX tickets |
| `ARCHITECTURE_REVIEW` | System design decisions | ARCHITECTURE tickets |
| `SCHEMA_REVIEW` | Database schema change review | SCHEMA_CHANGE tickets |
| `FEATURE_ANALYSIS` | Feature request breakdown | FEATURE_REQUEST tickets |

**AI routing:** All use Claude API (requires `CLAUDE_API_KEY`). Falls back to error if unavailable.

**Configurability:**

| Aspect | Status | How | Notes |
|--------|--------|-----|-------|
| Claude API key | ✅ Configurable | Env: `CLAUDE_API_KEY` | Global |
| Claude model | ✅ Configurable | DB: `AiModelConfig` (hardcoded default `claude-sonnet-4-6`) | Per-task, per-client via `ModelConfigResolver` |
| Task → provider routing | ✅ Configurable | DB: `AiModelConfig` table + control panel AI Models tab | Layered resolution: CLIENT → APP_WIDE → hardcoded default. Managed via `ModelConfigResolver` |
| Ollama base URL | ✅ Configurable | Env: `OLLAMA_BASE_URL` | |
| Ollama model | ✅ Configurable | DB: `AiModelConfig` (hardcoded default `llama3.1:8b`) | Per-task, per-client via `ModelConfigResolver` |
| Per-task temperature | ❌ Hardcoded | Set in prompt definitions | |
| Per-task max tokens | ❌ Hardcoded | Set in prompt definitions or callers | |

**Needs implementation:**
- Per-prompt temperature and maxTokens overrides in the prompt override system

---

## AI Routing Summary

| Provider | Tasks | Cost | Latency |
|----------|-------|------|---------|
| **Ollama** (Mac Mini) | TRIAGE, CATEGORIZE, SUMMARIZE, SUMMARIZE_TICKET, SUMMARIZE_LOGS, DRAFT_EMAIL, EXTRACT_FACTS, SUGGEST_NEXT_STEPS, CLASSIFY_INTENT, ANALYZE_WORK_ITEM, DRAFT_COMMENT, GENERATE_DEVOPS_PLAN, GENERATE_TITLE, CLASSIFY_EMAIL, GENERATE_RELEASE_NOTE, SUMMARIZE_ROUTE, SELECT_ROUTE | Free | ~1-5s |
| **Claude API** | ANALYZE_QUERY, GENERATE_SQL, REVIEW_CODE, DEEP_ANALYSIS, BUG_ANALYSIS, ARCHITECTURE_REVIEW, SCHEMA_REVIEW, FEATURE_ANALYSIS, RESOLVE_ISSUE, GENERATE_RESOLUTION_PLAN, CHANGE_CODEBASE_SMALL, CHANGE_CODEBASE_LARGE, ANALYZE_TICKET_CLOSURE, CUSTOM_AI_QUERY | Per-token | ~5-60s |

---

## Service & Queue Map

```
┌───────────────────────────────────────────────────────────────────┐
│  copilot-api (Fastify, :3000)                                     │
│  ├─ REST API (tickets, repos, issue-jobs, logs, prompts, etc.)    │
│  ├─ Produces: issue-resolve, log-summarize, mcp-discovery,        │
│  │   system-analysis queues                                        │
│  └─ Consumes: log-summarize queue (inline worker)                 │
├───────────────────────────────────────────────────────────────────┤
│  imap-worker                                                      │
│  ├─ Produces: email-ingestion, ticket-analysis queues             │
│  └─ Consumes: email-ingestion, ticket-analysis queues             │
├───────────────────────────────────────────────────────────────────┤
│  devops-worker                                                    │
│  ├─ Produces: devops-sync queue                                   │
│  └─ Consumes: devops-sync queue (+ WorkflowEngine state machine) │
├───────────────────────────────────────────────────────────────────┤
│  issue-resolver                                                   │
│  └─ Consumes: issue-resolve queue                                 │
├───────────────────────────────────────────────────────────────────┤
│  ticket-analyzer                                                  │
│  ├─ Consumes: ticket-ingestion queue                              │
│  └─ Executes route steps, manages probe scheduling                │
├───────────────────────────────────────────────────────────────────┤
│  probe-worker                                                     │
│  └─ Cron + one-off probe execution, produces ticket-ingestion     │
├───────────────────────────────────────────────────────────────────┤
│  status-monitor                                                   │
│  └─ Polls system-status, sends notifications on state changes     │
├───────────────────────────────────────────────────────────────────┤
│  mcp-database (Express, :3100, Azure)                             │
│  └─ MCP tools → client SQL Servers                                │
└───────────────────────────────────────────────────────────────────┘

Shared infrastructure: PostgreSQL (Prisma), Redis (BullMQ), Ollama, Claude API
```

---

## Skill → Service Cross-Reference

| # | Skill | Services | Queues | AI Provider |
|---|-------|----------|--------|-------------|
| 1a | Email Intake | imap-worker | email-ingestion | — |
| 1b | Azure DevOps Intake | devops-worker | devops-sync | — |
| 1c | Manual Ticket | copilot-api | — | — |
| 2 | Ticket Triage & Analysis | imap-worker, (mcp-database) | ticket-analysis | Ollama |
| 3 | Email Response Drafting | imap-worker | (part of ticket-analysis) | Ollama |
| 4 | Database Operations | mcp-database | — | — |
| 5 | Issue Resolution | copilot-api, issue-resolver | issue-resolve | Claude |
| 6 | DevOps Conversational Workflow | devops-worker | devops-sync | Ollama |
| 7 | Log Summarization | copilot-api | log-summarize | Ollama |
| 8 | Prompt Management | copilot-api | — | — |
| 9 | Deep Analysis | (embedded in other skills) | — | Claude |

---

## Configurability Summary

### Current state at a glance

| Skill | Trigger configurable? | Endpoints per-client? | Prompts overridable? | Behavior tunable? | Config source |
|-------|----------------------|----------------------|---------------------|-------------------|---------------|
| 1a. Email Intake | ✅ Poll interval (env) | ✅ IMAP per-client (DB) | ✅ Wired via promptKey | ❌ Pipeline hardcoded | Env + DB |
| 1b. Azure DevOps Intake | ✅ Poll interval (env) | ❌ Global only (env) | ✅ Wired via promptKey | ❌ Max rounds hardcoded | Env only |
| 1c. Manual Ticket | ✅ API-driven | N/A | N/A | N/A | N/A |
| 2. Ticket Triage | ❌ Auto-enqueued | ✅ MCP URL (env) | ✅ Wired via promptKey | ❌ Pipeline hardcoded | Env |
| 3. Email Drafting | ❌ Part of pipeline | ❌ SMTP global only | ✅ Wired via promptKey | ❌ Always auto-sends | Env |
| 4. Database Ops (MCP) | ✅ On-demand | ✅ Per-system (JSON file) | N/A | ❌ Blocklist hardcoded | JSON file |
| 5. Issue Resolution | ✅ API-triggered | ✅ Per-repo (DB) | ✅ Via promptKey | ✅ Model via DB | Env + DB |
| 6. DevOps Workflow | ❌ Auto-triggered | ❌ Global only (env) | ✅ Registered in prompt registry | ❌ State machine hardcoded | Env |
| 7. Log Summarization | ❌ 30min cron hardcoded | N/A | ✅ Wired via promptKey | ❌ Cron interval hardcoded | Hardcoded |
| 8. YouTube Scheduling | ✅ Poll interval (env) | ✅ Multi-account (DB jobs) | N/A | ✅ Templates (env + DB) | Env + DB |
| 9. Prompt Management | ✅ API-driven | ✅ Per-client overrides (DB) | ✅ CRUD works | ✅ Wired to runtime | DB |
| 10. Deep Analysis | ❌ Embedded in skills | ✅ Per-client model (DB) | ✅ Wired via promptKey | ✅ Routing configurable (DB) | Env + DB |

### Legend

- ✅ = Working and configurable today
- ⚠️ = Infrastructure exists (DB schema, API, UI) but not wired to runtime
- ❌ = Hardcoded, requires code changes

---

## End Goal: Fully Configurable Skills from the Control Panel

The target architecture makes every skill's **triggers**, **endpoints**, and **behavior** configurable from the control panel, both as system-wide defaults and per-client overrides.

### Design Principles

1. **DB-first configuration** — All runtime config lives in Postgres, manageable via API and control panel. Env vars are for infrastructure only (ports, secrets, connection strings to Postgres/Redis).
2. **System-wide defaults + per-client overrides** — Every setting has a system-wide default. Per-client overrides (when present) take precedence. Same pattern as prompt overrides (APP_WIDE + CLIENT scope).
3. **Skills registry in DB** — Each skill is a registered entity with its trigger config, enabled/disabled state, and tunable parameters.
4. **Hot-reloadable** — Config changes take effect without service restarts (workers poll config from DB, with a short cache TTL).

### What needs to happen

#### Phase 1: Wire prompt overrides to runtime (unblock per-client AI behavior) ✅ DONE

- ~~Thread `clientId` through queue jobs~~ ✅ Done
- ~~Per-client AI provider+model routing~~ ✅ Done — `AiModelConfig` table + `ModelConfigResolver`
- ~~Add `promptKey` to `AIRequest`~~ ✅ Done
- ~~Inject `PromptResolver` into `AIRouter`~~ ✅ Done — resolves overrides before calling provider
- ~~Register all inline prompts as base prompts~~ ✅ Done — already registered in prompt registry
- ~~Refactor workers to use prompt keys instead of inline strings~~ ✅ Done — imap-worker, devops-worker, log-summarizer, issue-resolver all use promptKey
- ~~Issue-resolver: replace direct Anthropic SDK with AIRouter~~ ✅ Done

#### Phase 2: Skill configuration table (control panel admin for triggers + behavior)

- New `SkillConfig` model in Prisma: `{ skillKey, scope (APP_WIDE|CLIENT), clientId?, config (JSON), isEnabled }`
- Config schema per skill (Zod-validated JSON): poll intervals, toggles, thresholds, model overrides
- API endpoints: CRUD `/api/skill-configs`
- Control panel UI: skills settings page with per-skill forms, system-wide defaults tab, per-client overrides tab
- Workers read config from DB (with cache) instead of env vars for runtime settings

#### Phase 3: Per-client endpoints and integrations

- Wire DevOps worker to read from `ClientIntegration` (type `AZURE_DEVOPS`) — schema already supports it
- Per-client SMTP config for email replies
- YouTube scheduler as a `ClientIntegration` type (`YOUTUBE`) — support multiple channels
- MCP database system config migrated from JSON file to DB (or synced)
- ~~Per-client AI provider routing (override which model or provider handles which task)~~ ✅ Done

#### Phase 4: Control panel UI for full skill management

- Skills dashboard: grid of all skills with enabled/disabled toggles, health status, last-run timestamps
- Per-skill detail page: trigger config, endpoint config, prompt overrides, behavior toggles
- Per-client skill overrides tab on the client detail page
- Audit log for config changes (who changed what, when)
