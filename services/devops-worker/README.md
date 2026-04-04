# @bronco/devops-worker

Background worker that polls Azure DevOps for work items and syncs them as tickets in the copilot system. For actionable items (assigned to the configured user), triggers a conversational AI workflow that analyzes the issue, asks clarifying questions via DevOps comments, proposes an execution plan, and carries it out upon approval.

## Runs On

**Hugo** (control plane VM) via Docker Compose.

## How It Works

1. **Poll** — Queries Azure DevOps REST API for work items (incremental after first sync, watermark persisted in Redis)
2. **Enqueue** — Each work item is pushed to the `devops-sync` BullMQ queue
3. **Process** — Creates/updates a ticket for each work item, syncing title, description, priority, and linked items
4. **Workflow** — For items assigned to `AZDO_ASSIGNED_USER`, triggers the conversational AI workflow:
   - AI analyzes the issue and posts questions as DevOps comments
   - User responds via DevOps comments, AI processes answers
   - When enough context is gathered, AI proposes an execution plan
   - User approves, AI executes the plan and posts results

### Workflow States

`idle` → `analyzing` → `questioning` → `planning` → `awaiting_approval` → `executing` → `completed`

## Development

```bash
# From monorepo root

# 1. Start backing services
docker compose -f docker-compose.dev.yml up -d

# 2. Ensure .env has Azure DevOps credentials:
#   AZDO_ORG_URL=https://dev.azure.com/{organization}
#   AZDO_PROJECT={project}
#   AZDO_PAT={personal-access-token}
#   AZDO_ASSIGNED_USER={email-or-display-name}

# 3. Start in dev mode
pnpm dev:devops
```

## Deployment (Hugo)

```bash
docker compose up -d devops-worker
docker compose logs -f devops-worker
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string for BullMQ |
| `ENCRYPTION_KEY` | Yes | — | 64-char hex for credential encryption |
| `AZDO_ORG_URL` | No | — | Azure DevOps organization URL |
| `AZDO_PROJECT` | No | — | Azure DevOps project name |
| `AZDO_PAT` | No | — | Personal access token |
| `AZDO_ASSIGNED_USER` | No | — | User to trigger conversational workflow |
| `AZDO_CLIENT_SHORT_CODE` | No | — | Map work items to an existing client |
| `AZDO_API_VERSION` | No | 7.1 | REST API version |
| `AZDO_API_VERSION_COMMENTS` | No | 7.1-preview.4 | Comments API version |
| `POLL_INTERVAL_SECONDS` | No | 120 | Seconds between polls |
| `MAX_QUESTION_ROUNDS` | No | 10 | Max AI question rounds before forcing plan |
| `MAX_DESCRIPTION_LENGTH` | No | 2000 | Max work item description length stored |
| `HEALTH_PORT` | No | 3102 | Health server port |

## Source Layout

```
src/
├── index.ts              # Worker bootstrap: config, queue, polling loop, health server
├── config.ts             # Zod-validated env config
├── client.ts             # Azure DevOps REST API client (PAT auth, WIQL queries, comments)
├── poller.ts             # Incremental work item polling
├── processor.ts          # Work item → ticket sync, comment sync, linked item context
├── workflow.ts           # Conversational AI workflow engine (state machine)
└── workflow-target.ts    # Workflow target resolution (determines which work items to process)
```
