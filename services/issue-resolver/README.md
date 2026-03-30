# @bronco/issue-resolver

BullMQ worker that automatically resolves tickets by generating code changes via Claude and pushing them to a branch. Clones the target repository, analyzes the codebase and issue, generates file changes, and commits/pushes to a prefixed branch.

## Runs On

**Hugo** (control plane VM) via Docker Compose.

## How It Works

1. A ticket describes a bug or feature; a code repo is registered for the client via `POST /api/repos`
2. A resolution job is triggered via `POST /api/issue-jobs` with `ticketId` and `repoId`
3. The worker picks up the job from the `issue-resolve` BullMQ queue:
   - Clones/pulls the target repo
   - Analyzes the codebase and issue with Claude (via AIRouter)
   - Generates and applies file changes
   - Commits and pushes to `{branchPrefix}/{sanitized-issue-subject}`
4. A `CODE_CHANGE` ticket event is created with the commit SHA, branch name, and summary

### Branch Safety

Never pushes to `main`, `master`, `develop`, `release`, or the repo's `defaultBranch`. Enforced at API validation, git layer, and branch format (must contain `/` separator).

## Development

```bash
# From monorepo root

# 1. Start backing services
docker compose -f docker-compose.dev.yml up -d

# 2. Start in dev mode
pnpm dev:resolver
```

## Deployment (Hugo)

```bash
docker compose up -d issue-resolver
docker compose logs -f issue-resolver
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string for BullMQ |
| `ENCRYPTION_KEY` | Yes | — | 64-char hex for credential encryption |
| `REPO_WORKSPACE_PATH` | No | /tmp/issue-resolver-repos | Local dir for repo clones |
| `GIT_CLONE_DEPTH` | No | 0 | Clone depth (0 = full history) |
| `REPO_RETENTION_DAYS` | No | 14 | Days before stale clones are cleaned |
| `GIT_AUTHOR_NAME` | No | Bronco Bot | Git commit author name |
| `GIT_AUTHOR_EMAIL` | No | bot@bronco.dev | Git commit author email |
| `LOG_LEVEL` | No | info | Pino log level |
| `HEALTH_PORT` | No | 3103 | Health server port |

## Source Layout

```
src/
├── index.ts          # Worker bootstrap: config, queue, health server, repo cleanup
├── config.ts         # Zod-validated env config
├── worker.ts         # BullMQ job processor (plan → approve → execute flow)
├── planner.ts        # Resolution plan generation and regeneration (GENERATE_RESOLUTION_PLAN)
├── resolver.ts       # Claude-based code analysis and generation (RESOLVE_ISSUE)
├── learner.ts        # Learning extraction from plan approvals/rejections → client memory
├── notify.ts         # Operator notification on plan generation (email)
└── git.ts            # Git operations: clone, commit, push, branch safety, cleanup
```
