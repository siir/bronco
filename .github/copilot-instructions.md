# Bronco — Copilot Instructions

## What This Repo Does

Bronco is an AI-augmented database and software architecture operations platform. It manages client Azure SQL Managed Instances, triages tickets (database performance, bugs, features, code reviews, architecture), and integrates with email (IMAP), Azure DevOps, and YouTube for automated workflows.

## Tech Stack

- **Language**: TypeScript (ESM throughout, `.js` extensions on all relative imports)
- **Monorepo**: pnpm workspaces — shared packages in `packages/`, services in `services/`, MCP servers in `mcp-servers/`
- **Backend services**: Fastify (copilot-api), BullMQ workers (imap-worker, ticket-analyzer, probe-worker, devops-worker, issue-resolver)
- **Database**: PostgreSQL via Prisma ORM (control plane); Azure SQL Managed Instances (client data via MCP server)
- **Frontend**: Angular apps (`services/control-panel`, `services/ticket-portal`)
- **Deployment**: Docker Compose on Ubuntu 24.04 VM (Hugo); MCP server on Azure App Service

## Build & Validate

Always run these commands in order from the repo root:

```bash
pnpm install              # install all dependencies (required before any other step)
pnpm db:generate          # regenerate Prisma client (required after schema.prisma changes)
pnpm build                # compile all packages and services
pnpm typecheck            # TypeScript type check (must pass before committing)
```

CI runs `pnpm install --frozen-lockfile` → `pnpm db:generate` → `pnpm build` → `pnpm typecheck`. If `package.json` is modified, run `pnpm install` and commit the updated `pnpm-lock.yaml` — CI uses `--frozen-lockfile` and will fail without it.

There is no test suite; typecheck + build is the validation gate.

## Key Conventions

1. **Enum pattern** — always `const object + type`, never `enum`:
   ```typescript
   export const Foo = { A: 'A', B: 'B' } as const;
   export type Foo = (typeof Foo)[keyof typeof Foo];
   ```
   Prisma enums must match shared-types values exactly.

2. **ESM imports** — relative imports use `.js` extensions (TypeScript resolves them to `.ts` at compile time). Example: `import { foo } from './bar.js'`.

3. **Zod config** — services validate env vars via `loadConfig(schema)` from `@bronco/shared-utils`. Use `z.output<typeof schema>` (not `z.infer`) when the schema has `.default()` values.

4. **Logging** — use `createLogger(name)` from `@bronco/shared-utils` (Pino, writes to stderr). No `console.log` in service code.

5. **Shared packages** — `@bronco/shared-types`, `@bronco/shared-utils`, `@bronco/ai-provider`, `@bronco/db` are imported by all services. Changes to these packages require checking all consumers.

## Project Layout

```
packages/
  shared-types/src/      # All enums and interfaces — edit these first for data model changes
  shared-utils/src/      # createLogger, loadConfig, createHealthServer, encrypt/decrypt
  ai-provider/src/       # AI router, model config resolver, prompts
  db/prisma/             # schema.prisma, migrations

services/
  copilot-api/src/       # Fastify API server (port 3000) — routes/, config.ts
  control-panel/src/     # Angular control panel (served by Caddy at /cp/)
  ticket-portal/src/     # Angular client-facing ticket portal (served by Caddy at /portal/)
  imap-worker/src/       # IMAP email polling and ticket creation
  ticket-analyzer/src/   # BullMQ worker — ingestion pipeline, route step execution, probe scheduling
  probe-worker/src/      # Scheduled probe execution (cron + one-off via API)
  devops-worker/src/     # Azure DevOps work item sync and conversational AI workflow
  issue-resolver/src/    # Automated code generation via Claude
  status-monitor/src/    # Service and system status monitoring with alert notifications

mcp-servers/
  database/src/          # MCP server for Azure SQL / SQL Server (port 3100)
    config.ts            # Systems config schema (Zod)
    connections/         # Pool manager (factory pattern for DB engines)
    security/            # Query validator and audit logger
    tools/               # MCP tool registration

docker-compose.yml       # Production service definitions
tsconfig.base.json       # Shared TypeScript config
pnpm-workspace.yaml      # Workspace package declarations
```

## CI Checks

GitHub Actions (`.github/workflows/ci.yml`):
1. **Sync Lockfile** (PRs only) — auto-commits `pnpm-lock.yaml` if out of sync
2. **Typecheck & Build** — `pnpm install --frozen-lockfile` → `pnpm db:generate` → `pnpm build` → `pnpm typecheck`

Deployments: `deploy-hugo.yml` (Docker Compose to VM via GHCR + Tailscale SSH), `deploy-mcp.yml` (ZIP deploy to Azure App Service).

## Adding a New Service

See `CLAUDE.md` for the full checklist. Key requirements: health endpoint via `createHealthServer()`, Zod config validation, structured Pino logging, backend probe in `system-status.ts`, Dockerfile (multi-stage), `docker-compose.yml` entry, `deploy-hugo.yml` build matrix entry.

## Security Notes

- SQL inputs to the MCP server must be parameterized — never string-concatenated. See `mcp-servers/database/src/security/query-validator.ts`.
- Git URLs may contain tokens — use `redactUrls()` before logging.
- Issue resolver must never push to protected branches (`main`, `master`, `develop`, `release`) — enforced by `assertNotProtected()` in `services/issue-resolver/src/git.ts`.
