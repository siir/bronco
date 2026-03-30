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
| `SMTP_HOST` | Yes | — | SMTP server hostname for notifications |
| `SMTP_PORT` | No | 587 | SMTP server port |
| `SMTP_USER` | Yes | — | SMTP username |
| `SMTP_PASSWORD` | Yes | — | SMTP password |
| `SMTP_FROM` | Yes | — | Sender email address |
| `EMAIL_SENDER_NAME` | No | Support Team | Display name for outbound emails |
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
