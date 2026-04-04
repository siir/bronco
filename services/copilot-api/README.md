# @bronco/copilot-api

The main REST API for the Bronco platform. Manages clients, contacts, systems, tickets, ticket events, artifacts, client memories, ticket routes, AI configuration, and more. Acts as the central coordination point between workers, AI providers, and the MCP Database Server.

## Runs On

**Hugo** (control plane VM) via Docker Compose, alongside Postgres, Redis, and Caddy.

## API Routes

All routes (except health and auth) require JWT authentication or `x-api-key` header.

### Core
| Route file | Prefix | Description |
|------------|--------|-------------|
| `health.ts` | `/api/health` | Health check (no auth) |
| `auth.ts` | `/api/auth` | JWT authentication (login, token refresh) |
| `clients.ts` | `/api/clients` | Client CRUD with ticket/system counts |
| `contacts.ts` | `/api/contacts` | Contact directory management |
| `systems.ts` | `/api/systems` | Database system connection management |
| `tickets.ts` | `/api/tickets` | Ticket lifecycle, events, filtering |
| `artifacts.ts` | `/api/artifacts` | File upload/download (QNAP storage) |

### Code & Issues
| Route file | Prefix | Description |
|------------|--------|-------------|
| `repos.ts` | `/api/repos` | Code repository registration |
| `issue-jobs.ts` | `/api/issue-jobs` | Issue resolution job trigger and status |

### AI & Prompts
| Route file | Prefix | Description |
|------------|--------|-------------|
| `ai-config.ts` | `/api/ai-config` | Per-task AI model config CRUD + resolution preview |
| `ai-providers.ts` | `/api/ai-providers` | AI provider config management |
| `ai-usage.ts` | `/api/ai-usage` | AI usage analytics and cost tracking |
| `prompts.ts` | `/api/prompts` | Prompt override management |
| `keywords.ts` | `/api/keywords` | Keyword-based prompt routing rules |

### Integrations & Services
| Route file | Prefix | Description |
|------------|--------|-------------|
| `integrations.ts` | `/api/integrations` | Client integration configs (IMAP, DevOps) |
| `external-services.ts` | `/api/external-services` | External service health monitoring |
| `notification-channels.ts` | `/api/notification-channels` | Notification channel management |
| `notification-preferences.ts` | `/api/notification-preferences` | Per-operator notification preference management |
| `slack-conversations.ts` | `/api/slack-conversations` | Slack conversation history and thread management |

### Operations & Analysis
| Route file | Prefix | Description |
|------------|--------|-------------|
| `ticket-routes.ts` | `/api/ticket-routes` | Configurable ticket analysis pipelines |
| `client-memory.ts` | `/api/client-memory` | Per-client AI memory CRUD |
| `operational-tasks.ts` | `/api/operational-tasks` | Operational task management |
| `system-analyses.ts` | `/api/system-analyses` | System analysis job management |
| `system-issues.ts` | `/api/system-issues` | System issue tracking |
| `settings.ts` | `/api/settings` | Application settings (including self-analysis config) |
| `release-notes.ts` | `/api/release-notes` | Release note generation and management |
| `pending-actions.ts` | `/api/pending-actions` | Pending operator action management |

### Ingest & Probes
| Route file | Prefix | Description |
|------------|--------|-------------|
| `ingest.ts` | `/api/ingest` | Ingestion pipeline queue endpoints + run history |
| `scheduled-probes.ts` | `/api/scheduled-probes` | Scheduled probe CRUD and one-off trigger |
| `email-logs.ts` | `/api/email-logs` | Email processing log viewer + retry/reclassify |
| `failed-jobs.ts` | `/api/failed-jobs` | BullMQ failed job management (list/retry/discard) |

### Portal
| Route file | Prefix | Description |
|------------|--------|-------------|
| `portal-auth.ts` | `/api/portal/auth` | Client portal JWT authentication |
| `portal-tickets.ts` | `/api/portal/tickets` | Client-facing ticket read + submit |
| `portal-users.ts` | `/api/portal/users` | Client portal user management |

### Users & Billing
| Route file | Prefix | Description |
|------------|--------|-------------|
| `users.ts` | `/api/users` | Internal user management |
| `client-users.ts` | `/api/client-users` | Client-scoped user management |
| `invoices.ts` | `/api/invoices` | Invoice generation and management |
| `client-ai-credentials.ts` | `/api/client-ai-credentials` | Per-client AI API credential management |
| `client-environments.ts` | `/api/client-environments` | Client environment config |
| `ticket-filter-presets.ts` | `/api/ticket-filter-presets` | Saved ticket filter presets |

### System
| Route file | Prefix | Description |
|------------|--------|-------------|
| `system-status.ts` | `/api/system-status` | Service health dashboard + worker control |
| `logs.ts` | `/api/logs` | Application log viewer |
| `log-summaries.ts` | `/api/log-summaries` | AI-generated log summaries |

## Development

```bash
# From monorepo root

# 1. Start backing services
docker compose -f docker-compose.dev.yml up -d

# 2. Ensure .env has:
#   DATABASE_URL=postgresql://bronco:devpassword@localhost:5432/bronco
#   REDIS_URL=redis://localhost:6379
#   ENCRYPTION_KEY=<64-char hex>
#   API_KEY=devapikey
#   JWT_SECRET=<32+ char secret>

# 3. Run migration and seed
pnpm db:migrate
pnpm db:seed

# 4. Start in dev mode (hot reload via tsx watch)
pnpm dev:api

# 5. Test
curl -H "x-api-key: devapikey" http://localhost:3000/api/health
curl -H "x-api-key: devapikey" http://localhost:3000/api/clients
```

## Deployment (Hugo)

Deployed as part of the `docker-compose.yml` stack. The Dockerfile builds a multi-stage image including all workspace dependencies.

```bash
# On Hugo
docker compose up -d copilot-api

# First time: run migrations
docker compose exec copilot-api npx prisma migrate deploy

# Logs
docker compose logs -f copilot-api
```

Caddy sits in front as a reverse proxy, providing HTTPS. The API listens on port 3000 internally, bound to 127.0.0.1 (not exposed directly).

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string for BullMQ |
| `ENCRYPTION_KEY` | Yes | — | 64-char hex for credential encryption |
| `API_KEY` | Yes | — | API key for request authentication |
| `JWT_SECRET` | Yes | — | JWT signing secret (min 32 chars) |
| `ARTIFACT_STORAGE_PATH` | No | /tmp/artifacts | File storage path for artifacts |
| `PORT` | No | 3000 | HTTP listen port |
| `PORTAL_JWT_SECRET` | Yes | — | JWT signing secret for portal auth (min 32 chars) |
| `INVOICE_STORAGE_PATH` | No | /var/lib/copilot-api/invoices | File storage path for invoices |
| `GITHUB_TOKEN` | No | — | GitHub token for release note backfill |
| `GITHUB_REPO` | No | siir/bronco | GitHub repo for release notes |
| `BUILD_VERSION` | No | dev | Build version string for health endpoint |
| `LOG_LEVEL` | No | info | Pino log level |
| `IMAP_WORKER_HEALTH_URL` | No | http://imap-worker:3101 | imap-worker health endpoint |
| `DEVOPS_WORKER_HEALTH_URL` | No | http://devops-worker:3102 | devops-worker health endpoint |
| `ISSUE_RESOLVER_HEALTH_URL` | No | http://issue-resolver:3103 | issue-resolver health endpoint |
| `TICKET_ANALYZER_HEALTH_URL` | No | http://ticket-analyzer:3106 | ticket-analyzer health endpoint |
| `PROBE_WORKER_HEALTH_URL` | No | http://probe-worker:3107 | probe-worker health endpoint |
| `STATUS_MONITOR_HEALTH_URL` | No | http://status-monitor:3105 | status-monitor health endpoint |
| `MCP_DATABASE_HEALTH_URL` | No | http://mcp-database:3100 | MCP database server health endpoint |
| `SLACK_WORKER_HEALTH_URL` | No | http://slack-worker:3108 | slack-worker health endpoint |
| `SCHEDULER_WORKER_HEALTH_URL` | No | http://scheduler-worker:3109 | scheduler-worker health endpoint |
| `MCP_PLATFORM_HEALTH_URL` | No | http://mcp-platform:3110 | MCP platform server health endpoint |
| `MCP_REPO_HEALTH_URL` | No | http://mcp-repo:3111 | MCP repo server health endpoint |

AI provider configuration (API keys, model selection) is managed through the database via `AiProviderConfig` and `AiModelConfig` tables, not env vars.

## Source Layout

```
src/
├── index.ts              # Server bootstrap
├── app.ts                # Fastify app factory (plugins, routes, BullMQ queues)
├── config.ts             # Zod-validated env config
├── plugins/
│   ├── prisma.ts         # Fastify plugin: decorates app with PrismaClient
│   └── auth.ts           # Fastify plugin: JWT + x-api-key verification
└── routes/
    ├── index.ts          # Route registration
    ├── health.ts         # Health check
    ├── auth.ts           # JWT authentication
    ├── clients.ts        # Client CRUD
    ├── contacts.ts       # Contact management
    ├── systems.ts        # Database system management
    ├── tickets.ts        # Ticket lifecycle + events
    ├── artifacts.ts      # Upload/download artifacts
    ├── repos.ts          # Code repo registration
    ├── issue-jobs.ts     # Issue resolution jobs
    ├── ai-config.ts      # AI model config CRUD + resolution
    ├── ai-providers.ts   # AI provider config management
    ├── ai-usage.ts       # AI usage analytics
    ├── prompts.ts        # Prompt override management
    ├── keywords.ts       # Keyword routing rules
    ├── integrations.ts   # Client integrations
    ├── external-services.ts  # External service monitoring
    ├── ingest.ts             # Ingestion pipeline queue + run history
    ├── scheduled-probes.ts   # Scheduled probe CRUD + trigger
    ├── email-logs.ts         # Email processing log viewer
    ├── failed-jobs.ts        # BullMQ failed job management
    ├── portal-auth.ts        # Client portal authentication
    ├── portal-tickets.ts     # Client-facing ticket endpoints
    ├── portal-users.ts       # Client portal user management
    ├── users.ts              # Internal user management
    ├── client-users.ts       # Client-scoped users
    ├── invoices.ts           # Invoice generation
    ├── client-ai-credentials.ts # Per-client AI credentials
    ├── client-environments.ts   # Client environment config
    ├── ticket-filter-presets.ts # Saved ticket filter presets
    ├── system-status.ts      # Service health dashboard
    ├── logs.ts               # App log viewer
    ├── log-summaries.ts      # AI log summaries
    ├── ticket-routes.ts      # Configurable analysis pipelines
    ├── client-memory.ts      # Per-client AI memory
    ├── notification-channels.ts  # Notification channels
    ├── notification-preferences.ts # Per-operator notification preferences
    ├── operational-tasks.ts  # Operational tasks
    ├── pending-actions.ts    # Pending operator actions
    ├── system-analyses.ts    # System analysis jobs
    ├── system-issues.ts      # System issues
    ├── settings.ts           # App settings (including self-analysis config)
    ├── release-notes.ts      # Release notes
    ├── slack-conversations.ts # Slack conversation history
    └── operators.ts          # Operator CRUD (multi-operator support)
```
