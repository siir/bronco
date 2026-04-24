# @bronco/ticket-analyzer

Core analysis service that processes tickets through configurable route-driven pipelines. Handles the unified ingestion queue (ticket creation from all sources), ticket analysis (triage, deep analysis, agentic MCP tool loops), update analysis for reply handling, and sufficiency evaluation.

## Runs On

**Hugo** (control plane VM) via Docker Compose.

## How It Works

The service runs four BullMQ workers:

### Ingestion Worker (`ticket-ingest` queue)
Processes normalized payloads from all ticket sources (IMAP, DevOps, Manual, Portal, Probes) through configurable ingestion routes:
- `RESOLVE_THREAD` — Email threading (Message-ID + subject fallback, client-scoped)
- `SUMMARIZE_EMAIL`, `CATEGORIZE`, `TRIAGE_PRIORITY`, `GENERATE_TITLE` — AI triage steps
- `CREATE_TICKET` — Ticket creation with requester linking and deduplication

### Ticket-Created Worker (`ticket-created` queue)
Dispatches newly created tickets to matching ANALYSIS routes for deep processing.

### Analysis Worker (`ticket-analysis` queue)
Runs analysis routes with steps like:
- `LOAD_CLIENT_CONTEXT` — Inject per-client memories and playbooks
- `LOAD_ENVIRONMENT_CONTEXT` — Inject environment operational instructions
- `EXTRACT_FACTS`, `GATHER_REPO_CONTEXT`, `GATHER_DB_CONTEXT` — Context gathering
- `DEEP_ANALYSIS` / `AGENTIC_ANALYSIS` — Claude analysis with optional MCP tool loops
- `UPDATE_ANALYSIS` — Incremental analysis for reply handling (delta, not full re-run)
- `DRAFT_FINDINGS_EMAIL` — Send findings to user (with questions when NEEDS_USER_INPUT)
- Sufficiency evaluation: SUFFICIENT / NEEDS_USER_INPUT / INSUFFICIENT gating for resolution
- Produces `system-analysis` jobs (POST_ANALYSIS trigger) after analysis completion

### Client Learning Worker (`client-learning` queue)
Extracts operational knowledge from resolved tickets into per-client memory entries (via `EXTRACT_CLIENT_LEARNINGS` task type).

## Development

```bash
pnpm dev:analyzer
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `ENCRYPTION_KEY` | Yes | — | 64-char hex for credential encryption |
| `SMTP_HOST` | No | *(empty)* | SMTP server hostname (DB config takes priority) |
| `SMTP_PORT` | No | 587 | SMTP server port |
| `SMTP_USER` | No | *(empty)* | SMTP username (DB config takes priority) |
| `SMTP_PASSWORD` | No | *(empty)* | SMTP password (DB config takes priority) |
| `SMTP_FROM` | No | *(empty)* | Sender email address (DB config takes priority) |
| `EMAIL_SENDER_NAME` | No | Support Team | Display name for outbound emails |
| `MCP_DATABASE_URL` | No | http://mcp-database:3100 | MCP database server URL (for DB analysis) |
| `MCP_REPO_URL` | No | http://mcp-repo:3111 | MCP repo server URL (for code repository access) |
| `API_KEY` | No | — | API key for authenticated MCP calls (`x-api-key` header) |
| `ARTIFACT_STORAGE_PATH` | No | — | File storage for analysis artifacts |
| `REPO_WORKSPACE_PATH` | No | /tmp/bronco-repos | Local dir for repo clones (code analysis) |
| `REPO_RETENTION_DAYS` | No | 14 | Days before stale repo clones are cleaned |
| `HEALTH_PORT` | No | 3106 | Health server port |

## Source Layout

```
src/
├── index.ts                    # Worker bootstrap: config, queues, workers, health server
├── config.ts                   # Zod-validated env config
├── analyzer.ts                 # Route step handlers (analysis pipeline, sufficiency, MCP tools)
├── ingestion-engine.ts         # Ingestion pipeline processor (RESOLVE_THREAD, CREATE_TICKET, etc.)
├── ingestion-tracker.ts        # Ingestion run tracking (per-step status, timing, output)
├── route-dispatcher.ts         # Route resolution: match tickets to analysis routes by source/client/category
├── client-learning-worker.ts   # Client learning extraction from resolved tickets → client memory
└── recommendation-executor.ts  # Executes system analysis recommendations (operational tasks)
```
