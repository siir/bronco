# @bronco/imap-worker

Background worker service that polls a Google Workspace IMAP mailbox for inbound support emails and converts them into tickets in the copilot system.

## Runs On

**Hugo** (control plane VM) via Docker Compose.

## How It Works

1. **Poll** -- Connects to IMAP every 60 seconds (configurable), fetches all unseen messages from INBOX
2. **Enqueue** -- Each email is base64-encoded and pushed to a `email-ingestion` BullMQ queue
3. **Process** -- BullMQ worker picks up each job and:
   - Parses the email with `mailparser` (headers, body, attachments)
   - Matches sender email to an existing `Contact` in the database
   - Threads into an existing ticket by matching `In-Reply-To` / `References` headers
   - Falls back to subject + sender matching within a 7-day window
   - Creates a new ticket if no thread match is found
   - Appends an `EMAIL_INBOUND` ticket event with the full email body and metadata
4. **Mark seen** -- Processed emails are flagged as `\Seen` in IMAP

## Ticket Threading Logic

**Primary match:** Email `In-Reply-To` or `References` header matches a `messageId` stored in an existing ticket event's metadata.

**Fallback match:** Normalized subject (strip `Re:`, `Fwd:`, `Fw:`) matches an open ticket for the same client within the last 7 days.

**No match:** A new ticket is created with `source: EMAIL`.

## Development

```bash
# From monorepo root

# 1. Start backing services
docker compose -f docker-compose.dev.yml up -d

# 2. Ensure .env has IMAP credentials:
#   IMAP_HOST=imap.gmail.com
#   IMAP_PORT=993
#   IMAP_USER=support@yourdomain.com
#   IMAP_PASSWORD=<app password>

# 3. Start in dev mode
pnpm dev:worker
```

For Google Workspace, you'll need an **app password** (if using 2FA) or OAuth2 credentials. App password is simpler for a single-operator setup.

## Deployment (Hugo)

```bash
docker compose up -d imap-worker
docker compose logs -f imap-worker
```

The worker runs as a standalone container. It connects to the same Postgres and Redis instances as copilot-api.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `ENCRYPTION_KEY` | Yes | — | 64-char hex for credential encryption |
| `SMTP_HOST` | Yes | — | SMTP server hostname for outbound email |
| `SMTP_PORT` | No | 587 | SMTP server port |
| `SMTP_USER` | Yes | — | SMTP username |
| `SMTP_PASSWORD` | Yes | — | SMTP password |
| `SMTP_FROM` | Yes | — | Sender email address |
| `EMAIL_SENDER_NAME` | No | Support Team | Display name for outbound emails |
| `IMAP_HOST` | No | *(empty)* | Global IMAP server hostname (optional when using per-client integrations) |
| `IMAP_PORT` | No | 993 | IMAP server port |
| `IMAP_USER` | No | *(empty)* | IMAP username (optional when using per-client integrations) |
| `IMAP_PASSWORD` | No | *(empty)* | IMAP password (optional when using per-client integrations) |
| `POLL_INTERVAL_SECONDS` | No | 60 | Seconds between IMAP polls |
| `MCP_DATABASE_URL` | No | — | MCP database server URL (for DB issue analysis) |
| `REPO_WORKSPACE_PATH` | No | /tmp/bronco-repos | Local dir for repo clones (analysis) |
| `REPO_RETENTION_DAYS` | No | 14 | Days before stale repo clones are cleaned |
| `HEALTH_PORT` | No | 3101 | Health server port |

## Source Layout

```
src/
├── index.ts          # Worker bootstrap: config, queue, polling loop, health server, shutdown
├── config.ts         # Zod-validated env config
├── poller.ts         # IMAP connection, fetch unseen, mark as seen
├── processor.ts      # BullMQ worker: parse email, match contact, thread/create ticket
├── analyzer.ts       # Ticket analysis with repo cloning (bare+worktree) and MCP tools
└── mailer.ts         # SMTP outbound email sending
```
