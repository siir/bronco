# @bronco/imap-worker

Background worker service that polls IMAP mailboxes for inbound support emails, filters noise, and pushes normalized payloads to the unified ingestion queue. Ticket creation, threading, and analysis are handled downstream by the ingestion engine.

## Runs On

**Hugo** (control plane VM) via Docker Compose.

## How It Works

1. **Poll** — Connects to IMAP every 60 seconds (configurable), fetches all unseen messages from INBOX
2. **Enqueue raw** — Each email is base64-encoded and pushed to the `email-ingestion` BullMQ queue
3. **Process** — BullMQ worker picks up each job and:
   - Parses the email with `mailparser` (headers, body, attachments)
   - Checks for duplicates (Message-ID + SHA-256 hash)
   - Filters noise: automated senders, noise subjects, AI classification
   - Resolves sender to a `Contact` and determines `clientId`
   - Classifies as `THREAD_REPLY` when `In-Reply-To`/`References` headers are present
   - Pushes a normalized `EmailIngestionPayload` to the `ticket-ingest` queue
4. **Mark seen** — Processed emails are flagged as `\Seen` in IMAP

Threading, ticket creation, and re-analysis triggering are handled by the ingestion engine's `RESOLVE_THREAD` step.

## Development

```bash
# From monorepo root
pnpm dev:worker
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `ENCRYPTION_KEY` | Yes | — | 64-char hex for credential encryption |
| `IMAP_HOST` | No | *(empty)* | Global IMAP server hostname (optional with per-client integrations) |
| `IMAP_PORT` | No | 993 | IMAP server port |
| `IMAP_USER` | No | *(empty)* | IMAP username (optional with per-client integrations) |
| `IMAP_PASSWORD` | No | *(empty)* | IMAP password (optional with per-client integrations) |
| `POLL_INTERVAL_SECONDS` | No | 60 | Seconds between IMAP polls |
| `HEALTH_PORT` | No | 3101 | Health server port |

## Source Layout

```
src/
├── index.ts          # Worker bootstrap: config, queues, polling loop, health server, shutdown
├── config.ts         # Zod-validated env config
├── poller.ts         # IMAP connection, fetch unseen, mark as seen
└── processor.ts      # BullMQ worker: parse, noise filter, push to ingestion queue
```
