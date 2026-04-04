# @bronco/probe-worker

Background worker service that executes scheduled monitoring probes against client database systems via MCP tools. Probe results can trigger ticket creation through the unified ingestion queue, send email notifications, and store artifacts.

## Runs On

**Hugo** (control plane VM) via Docker Compose.

## How It Works

1. **Schedule** — Reads `ScheduledProbe` configs from the database, each with a cron expression
2. **Execute** — At the scheduled time, calls the configured MCP tool (e.g., `get_database_health`, `get_blocking_tree`) via the MCP database server
3. **Process results** — AI summarizes probe output (using `SUMMARIZE_LOGS` task type), generates a ticket title
4. **Ingest** — Pushes results to the `ticket-ingest` queue for ticket creation via the unified ingestion pipeline
5. **Notify** — Sends email notification with summarized results if configured
6. **Store** — Saves probe run history and optionally stores raw results as artifacts

Also handles one-off probe execution triggered via the `probe-execution` BullMQ queue (from the API).

### Built-in Probe Tools

In addition to calling MCP server tools, the probe worker includes built-in tools that execute locally:
- `scan_app_logs` — Scans application log entries for errors/warnings (configurable by service, level, time window)
- `analyze_app_health` — AI-powered platform health analysis using the `ANALYZE_APP_HEALTH` task type

## Development

```bash
pnpm dev:analyzer  # probe-worker runs alongside ticket-analyzer
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
| `MCP_REPO_URL` | No | — | MCP repo server URL (for code repository access in built-in tools) |
| `ARTIFACT_STORAGE_PATH` | No | /var/lib/bronco/artifacts | File storage for probe result artifacts |
| `HEALTH_PORT` | No | 3107 | Health server port |

## Source Layout

```
src/
├── index.ts          # Worker bootstrap: config, queues, cron scheduler, health server
├── config.ts         # Zod-validated env config
├── probe-worker.ts   # Probe execution logic: MCP tool calls, AI summarization, ingestion
└── builtin-tools.ts  # Built-in probe tool definitions
```
