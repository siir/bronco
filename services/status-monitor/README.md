# @bronco/status-monitor

Polling-based health monitoring service that periodically checks system status from copilot-api and sends alerts via notification channels (email, Pushover) when service state changes.

## Runs On

**Hugo** (control plane VM) via Docker Compose, alongside other services.

## How It Works

1. Polls `/api/system-status` on copilot-api at configurable intervals (default 60s)
2. Tracks component status changes (UP, DOWN, DEGRADED, UNKNOWN) with state persistence
3. Sends alerts via email (SMTP) or Pushover push notifications when status changes
4. Implements cooldown logic to suppress duplicate notifications within a configurable window
5. Records all status transitions and notifications to `ServiceAlert` table in the control plane DB
6. Loads active notification channels from the database dynamically, decrypting stored credentials

## Development

```bash
# From monorepo root
pnpm dev:status-monitor
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `ENCRYPTION_KEY` | Yes | — | 64+ char hex for decrypting stored credentials |
| `STATUS_API_URL` | No | `http://copilot-api:3000/api/system-status` | Copilot API status endpoint |
| `API_KEY` | Yes | — | Auth header for status endpoint |
| `POLL_INTERVAL_SECONDS` | No | 60 | Polling interval (min 10s) |
| `COOLDOWN_SECONDS` | No | 300 | Notification suppression window |
| `NOTIFY_ON_FIRST_POLL` | No | false | Alert on initial startup if services are down |
| `HEALTH_PORT` | No | 3105 | Health server port |

## Source Layout

```
src/
├── index.ts          # Entry point, polling loop
├── config.ts         # Zod-validated env config
├── monitor.ts        # Status polling and state diffing
└── notifiers/
    ├── email.ts      # Email notification dispatch
    └── pushover.ts   # Pushover notification dispatch
```
