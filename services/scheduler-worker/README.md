# @bronco/scheduler-worker

Background worker service that runs scheduled BullMQ cron jobs, auto-invoicing, and operational alert checks. Handles log summarization, system closure analysis, MCP server discovery, AI model catalog refresh, and prompt archive retention.

## Runs On

**Hugo** (control plane VM) via Docker Compose.

## How It Works

The service manages five BullMQ cron workers and two interval-based tasks:

### BullMQ Workers

| Queue | Schedule | Description |
|-------|----------|-------------|
| `log-summarize` | Every 30 minutes | AI-summarizes unsummarized application log entries |
| `system-analysis` | On-demand (triggered by ticket-analyzer) | Analyzes ticket closures and post-analysis results for system improvement suggestions. Handles `TICKET_CLOSE`, `POST_ANALYSIS`, and `SCHEDULED` trigger types. |
| `mcp-discovery` | Daily | Re-verifies all active MCP database integrations (tool list, version, connectivity) |
| `model-catalog-refresh` | Daily | Refreshes available AI model catalog from active providers |
| `prompt-retention` | Nightly at 3am | Archives old AI prompt logs: summarizes after `fullRetentionDays` (default 30), deletes after `summaryRetentionDays` (default 90) |

### Interval Tasks

| Task | Interval | Description |
|------|----------|-------------|
| Auto-invoicing | 24 hours | Checks all clients with active billing periods, generates PDF invoices for completed periods |
| Operational alerts | 5 minutes | Checks for pending operational alerts and sends notifications |

## Development

```bash
pnpm dev:scheduler
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `ENCRYPTION_KEY` | Yes | — | 64-char hex for credential encryption |
| `HEALTH_PORT` | No | 3109 | Health server port |
| `INVOICE_STORAGE_PATH` | No | /var/lib/scheduler/invoices | File storage path for generated invoice PDFs |

## Source Layout

```
src/
├── index.ts                   # Worker bootstrap: config, queues, cron schedulers, health server
├── config.ts                  # Zod-validated env config
├── log-summarizer.ts          # AI log summarization (per-ticket and full pass)
├── system-analyzer.ts         # System analysis dispatcher (TICKET_CLOSE, POST_ANALYSIS, SCHEDULED triggers)
├── mcp-discovery.ts           # MCP server Streamable HTTP discovery and verification
├── model-catalog-refresher.ts # AI provider model catalog refresh
├── invoice-generator.ts       # PDF invoice generation and billing period computation
├── operational-alerts.ts      # Operational alert checking and notification dispatch
└── redis.ts                   # Shared Redis connection utilities
```
