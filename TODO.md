# TODO - Implementation Roadmap

## Secrets & Credentials Setup

All secrets that need to be created, and where they live.

### GitHub Actions Secrets (Settings → Secrets → Actions)

| Secret | Value | Status |
|--------|-------|--------|
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (Trust credentials) | ✅ Done |
| `TS_OAUTH_SECRET` | Tailscale OAuth secret | ✅ Done |
| `HUGO_TAILSCALE_IP` | `100.106.127.1` | ✅ Done |
| `HUGO_SSH_USER` | `bronco` | ✅ Done |
| `HUGO_SSH_KEY` | Private key from `/home/bronco/.ssh/id_ed25519` on Hugo | ✅ Done |
| `MCP_PUBLISH_PROFILE` | Azure App Service publish profile | ✅ Done |
| `MCP_WEBAPP_NAME` | Azure App Service web app name | ✅ Done |

### Hugo `.env` (on the control plane VM)

| Variable | Value | Status |
|----------|-------|--------|
| `POSTGRES_PASSWORD` | Postgres password | ✅ Done |
| `POSTGRES_PASSWORD_URLENCODED` | URL-encoded Postgres password | ✅ Done |
| `DATABASE_URL` | Postgres connection string | ✅ Done |
| `REDIS_URL` | Redis connection string | ✅ Done |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM | ✅ Done |
| `API_KEY` | API key for copilot-api auth | ✅ Done |
| `IMAP_HOST` | IMAP server hostname | ✅ Done |
| `IMAP_USER` | IMAP mailbox username | ✅ Done |
| `IMAP_PASSWORD` | IMAP mailbox password / app password | ✅ Done |
| `MCP_DATABASE_URL` | URL of the MCP database server in Azure | ✅ Done |
| `MCP_AUTH_TOKEN` | Auth token for MCP database server | ✅ Done |
| `OLLAMA_BASE_URL` | `http://siiriaplex:11434` | ✅ Done |
| `CLAUDE_API_KEY` | Anthropic API key for deep analysis | ✅ Done |

### Azure MCP App Service (environment variables)

| Variable | Value | Status |
|----------|-------|--------|
| `SYSTEMS_CONFIG_PATH` | Path to systems config JSON file | ✅ Done |
| `API_KEY` | API key for REST bridge auth | ✅ Done |
| `MCP_AUTH_TOKEN` | Bearer token for MCP endpoint auth | ✅ Done |

---

## Phase 1: Core Infrastructure (Current)

The scaffold is complete. All packages build. These are the immediate next steps to get the system operational.

### Environment Setup

- [x] Generate an `ENCRYPTION_KEY` and store securely
- [x] Create `.env` and fill in all values
- [x] Start Postgres + Redis via Docker Compose
- [x] Run Prisma migration: `pnpm db:migrate`
- [x] Run seed: `pnpm db:seed`
- [x] Verify copilot-api starts and is healthy
- [x] Test health endpoint: `curl -H "x-api-key: <key>" http://localhost:3000/api/health`

### Hugo (Control Plane VM) Deployment

- [x] Set up Ubuntu Server 24.04 LTS VM on ESXi
- [x] Install Docker and Docker Compose
- [x] Install Tailscale for secure remote access
- [x] Mount QNAP storage to `/mnt/qnap` (NFS from 192.168.86.241:/copilot-storage)
- [x] Clone repo to Hugo, configure `.env` with production values
- [x] Run `docker compose up -d` — all services running
- [x] Run initial migration: Prisma migrations applied
- [x] Configure Caddy (reverse proxy, auto-TLS for localhost)
- [x] Verify all services are healthy: `docker compose ps`

### Email Ingestion Setup

- [x] Create Google Workspace mailbox (chad@siirial.com)
- [x] Generate an app password
- [x] Configure IMAP env vars in Hugo `.env`
- [ ] Forward a test email to the support mailbox
- [ ] Verify a ticket is created: `GET /api/tickets`
- [ ] Forward a reply to the same thread
- [ ] Verify it threads as a `ticket_event`, not a new ticket

---

## Phase 2: AI Pipeline & Azure MCP

With infrastructure running, wire up the AI triage and analysis pipeline and deploy the MCP database server to Azure.

### Azure MCP Database Server Deployment

> **Note:** Approach changed from Container App/ACR to App Service with ZIP deploy via publish profile. Systems config is now a local JSON file (`SYSTEMS_CONFIG_PATH`), not Postgres-backed.

- [x] ~~Identify the Azure vnet/subnet~~ — Deployed to Azure App Service on correct vnet
- [x] ~~Create an Azure Container Registry (ACR)~~ — Using App Service ZIP deploy instead
- [x] ~~Build and push the MCP server Docker image~~ — ZIP deploy via publish profile
- [x] ~~Create a Container App Environment~~ — Using App Service instead
- [x] ~~Deploy the Container App~~ — Deployed as App Service
- [x] Test health check: `curl https://<app-url>/health`
- [x] Test MCP endpoint with a simple tool call
- [x] Update Hugo `.env` with `MCP_DATABASE_URL` and `MCP_AUTH_TOKEN`
- [x] Update `.claude/settings.json` with the real URL and auth token
- [x] Verify Claude Code can list systems via the MCP server

### Client System Onboarding

> **Note:** Systems are now configured via a local JSON file (`SYSTEMS_CONFIG_PATH`) on the MCP server, not via API/Postgres. Credentials are stored as plaintext in the JSON file; Azure App Service handles secret management.

- [x] Create first real client via API: `POST /api/clients`
- [x] Create a read-only SQL login on the client's Azure SQL MI (`db_datareader` only)
- [x] ~~Encrypt the password and register the system via API~~ — Systems configured via JSON file instead
- [x] Test from Claude Code: `list_systems` then `inspect_schema` on the new system
- [x] Test `run_query` with a simple SELECT
- [x] Test `get_database_health` for baseline metrics

### Local LLM (Ollama) Integration

- [x] Install Ollama on Mac mini (siiriaplex), pull `llama3:8b`
- [x] Verify connectivity from Hugo: `curl http://siiriaplex:11434/api/tags` — reachable, llama3:8b loaded
- [x] Create triage prompt template — `IMAP_TRIAGE_SYSTEM` in `packages/ai-provider/src/prompts/imap.ts`
- [x] Create categorization prompt template — `IMAP_CATEGORIZE_SYSTEM` in `packages/ai-provider/src/prompts/imap.ts`
- [x] Add BullMQ job: on new ticket creation, enqueue triage + categorize tasks — `ticket-analysis` queue in `imap-worker/processor.ts`
- [x] Process triage result: update ticket priority and category, add `AI_ANALYSIS` event — `imap-worker/analyzer.ts`
- [x] Create summarization prompt template — `IMAP_SUMMARIZE_SYSTEM` in `packages/ai-provider/src/prompts/imap.ts`
- [x] Add auto-summary on email ingestion — runs via `TaskType.SUMMARIZE` in `imap-worker/analyzer.ts`

### Claude API Integration

- [ ] Create query plan analysis prompt template (`ANALYZE_QUERY`)
- [ ] Create stored procedure review prompt template (`REVIEW_CODE`)
- [ ] Create bug analysis prompt template (`BUG_ANALYSIS`) for cross-stack bug reports (DB + API + client)
- [ ] Create architecture review prompt template (`ARCHITECTURE_REVIEW`)
- [ ] Create schema review prompt template (`SCHEMA_REVIEW`) for database schema change requests
- [ ] Create feature analysis prompt template (`FEATURE_ANALYSIS`) for breaking down feature requests into tasks
- [ ] Add `/api/ai/submit` endpoint to copilot-api
- [ ] Implement escalation workflow: preview prompt -> approve -> send to Claude
- [ ] Add redaction rules (strip connection strings, passwords from prompts)
- [ ] Log all Claude API calls as `ticket_event` entries
- [ ] Test end-to-end: submit a query plan artifact, get Claude's analysis

### AI-Driven MCP Workflows

- [ ] Create a Claude Code workflow: "Analyze blocking on system X"
  - `list_systems` -> `get_blocking_tree` -> Claude analyzes results
- [ ] Create a workflow: "Health check for client Y"
  - `list_systems` -> `get_database_health` -> Claude summarizes findings
- [ ] Create a workflow: "Tune indexes on table Z"
  - `inspect_schema` -> `list_indexes` (with stats) -> Claude recommends changes
- [ ] Create a workflow: "Investigate slow query"
  - `run_query` (capture plan) -> Claude analyzes execution plan XML

---

## Phase 3: Operational Features

### Findings and Playbooks

- [ ] Add `POST /api/findings` endpoint (create findings from AI analysis)
- [ ] Add `POST /api/playbooks` endpoint
- [ ] Create playbook templates for common DBA tasks:
  - Index rebuild/reorganize
  - Blocking investigation
  - TempDB contention
  - Log file management
  - Statistics update
- [ ] Link findings to playbooks: when AI detects an issue, reference the relevant playbook

### Artifact Handling

- [ ] Parse deadlock XML artifacts (extract victim, resources, queries)
- [ ] Parse execution plan XML (extract costly operators, missing indexes)
- [ ] Auto-detect artifact type on upload based on content/extension
- [ ] Store parsed/structured data in `findings.structured_json`

### Draft Email Responses

- [x] Create email draft prompt template (context: ticket history, findings, playbook)
- [x] Use Ollama to generate draft responses
- [x] Add `EMAIL_OUTBOUND` draft as a ticket event for review
- [x] Send drafts via SMTP (auto-send in current implementation)

---

## Phase 4: Additional MCP Tools

### Missing Index Recommendations

- [ ] Implement `find_missing_indexes` tool
  - Query `sys.dm_db_missing_index_details` + `sys.dm_db_missing_index_group_stats`
  - Return table, equality/inequality/include columns, improvement measure
  - Generate `CREATE INDEX` statement
- [ ] Register in MCP tool catalog

### Active Sessions

- [ ] Implement `get_active_sessions` tool
  - Query `sys.dm_exec_sessions` + `sys.dm_exec_requests` + `sys.dm_exec_sql_text`
  - Show SPID, login, database, status, wait type, current SQL
- [ ] Register in MCP tool catalog

### Execution Plan Capture

- [ ] Implement `get_execution_plan` tool
  - `SET SHOWPLAN_XML ON` for estimated plans
  - `SET STATISTICS XML ON` for actual plans
  - Return XML + key cost metrics
- [ ] Register in MCP tool catalog

### Table Stats

- [ ] Implement `get_table_stats` tool
  - `sp_spaceused` + `sys.dm_db_partition_stats`
  - Return row count, reserved/data/index/unused space
- [ ] Register in MCP tool catalog

---

## Phase 5: UI and Workflow

### Admin UI

- [x] Choose a frontend approach — Angular 19 with Material (`services/control-panel/`)
- [x] Ticket list view with filtering (by client, status, priority, category)
- [x] Ticket detail view with event timeline
- [x] Client management view
- [x] System management view (add/edit connection details)
- [ ] Finding and playbook browser
- [ ] AI interaction panel (submit prompts, review responses)

### Scheduled Health Checks

- [ ] Add BullMQ repeatable job: run `get_database_health` for all active systems daily
- [ ] Auto-create findings for anomalies (backup age > 24h, high VLF count, I/O latency spikes)
- [ ] Add notification mechanism (email alert to operator)

### Knowledge Base (Future)

- [ ] Add embedding model to Ollama (e.g., nomic-embed-text)
- [ ] Generate embeddings for ticket events, findings, playbooks
- [ ] Store in `kb_chunks` table with pgvector
- [ ] Implement semantic search: "find similar issues to this ticket"
- [ ] Use RAG to augment Claude prompts with relevant past findings

---

## Non-Goals (For Now)

- ~~Multi-user authentication / RBAC~~ ✅ Implemented — JWT auth with ADMIN/OPERATOR/CLIENT roles + multi-operator support (#7)
- Public SaaS model
- ~~Client-facing portal~~ ✅ Implemented — `services/ticket-portal/` (Angular app for client users)
- Billing / invoicing automation
- Real-time WebSocket push (polling is fine for single operator)
- Mobile app
