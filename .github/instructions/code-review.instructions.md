# GitHub Copilot PR Review Instructions

## Project Context

This is a TypeScript monorepo (pnpm workspaces) with shared packages in `packages/`, services in `services/`, and MCP servers in `mcp-servers/`. The control plane DB is PostgreSQL (Prisma ORM). All services run as Docker containers deployed to a single VM (Hugo) via Docker Compose.

Read `CLAUDE.md` at the repo root for full architecture, conventions, and checklists.

---

## 1. Feature Drops and Behavioral Regressions

This is the single most important review concern. Many PRs in this repo are AI-generated.

- **Deleted code**: If a function, export, route, enum value, config field, or interface property is removed, flag it. It may be intentional refactoring, but it must be called out explicitly.
- **Changed signatures**: If a function's parameters, return type, or thrown errors change, check all callers. Especially watch for optional parameters becoming required or vice versa.
- **Default value changes**: If a Zod schema `.default()`, a config fallback, or a hardcoded constant changes value, flag it — even small changes to defaults can break production behavior.
- **Removed exports**: If `export` is removed from a function/type/const, check whether other packages in the monorepo import it. Cross-package imports are common (`@bronco/shared-types`, `@bronco/shared-utils`, `@bronco/ai-provider`, `@bronco/db`).
- **Conditional logic changes**: If an `if`/`else`, `switch`, `try`/`catch`, or early return is modified, verify the original cases are still handled. Watch for swallowed errors (empty `catch {}` replacing error handling).
- **Summarize all drops in one comment** if there are several obvious ones.

## 2. Cross-Package Consistency (Monorepo Gaps)

PRs that touch one layer often need matching changes elsewhere. Flag when these are missing:

### Enum / Type Sync
- **shared-types ↔ Prisma schema**: If an enum value is added/removed in `packages/shared-types/src/`, the corresponding Prisma enum in `packages/db/prisma/schema.prisma` must match. The convention is `const object + type` pattern in shared-types, not TS `enum`.
- **shared-types ↔ consumers**: If a type/interface changes in shared-types, check if services that import it need updating (copilot-api routes, workers, AI provider).

### Config Propagation
- **Zod schema ↔ docker-compose.yml**: If a new env var is added to a service's Zod config schema, it should also appear in the `docker-compose.yml` environment section (especially if the default isn't suitable for production).
- **Zod schema ↔ .env.example**: New env vars should be documented in `.env.example` with a comment.
- **Zod schema ↔ CLAUDE.md**: If the env var is user-facing or operator-relevant, it should be documented in CLAUDE.md's configuration tables.

### API Contract Sync
- **Route changes ↔ control panel**: If a copilot-api route's request/response shape changes, check if the Angular control panel (`services/control-panel/`) needs a matching update.
- **Prisma schema ↔ migrations**: If `schema.prisma` changes, there should be a migration file. If there isn't one, flag it.

## 3. New Service / Worker Checklist

If the PR adds a new service or worker, verify against the checklist in CLAUDE.md "Adding a New Service or Worker":

- [ ] Health endpoint via `createHealthServer()` with unique `HEALTH_PORT`
- [ ] Structured logging via `createLogger(name)`
- [ ] Zod config validation via `loadConfig(schema)`
- [ ] Backend health probe in `system-status.ts`
- [ ] Health URL env var in `copilot-api/src/config.ts`
- [ ] Frontend card in `system-status.component.ts`
- [ ] BullMQ queue registered (if applicable)
- [ ] Dockerfile (multi-stage pattern)
- [ ] docker-compose.yml entry with env vars, health check, volumes
- [ ] deploy-hugo.yml build matrix entry

## 4. Security

- **SQL injection**: The MCP database server has a query validator (`mcp-servers/database/src/security/query-validator.ts`). If new SQL-executing code is added anywhere, ensure inputs are parameterized, not string-concatenated.
- **Path traversal**: Repo cloning and file operations must sanitize paths. Check for unsanitized `join()` calls where user-controlled input (repo names, branch names, file paths) flows into filesystem operations.
- **Credential exposure**: Git URLs may contain tokens. Error messages and logs must redact credentials (the pattern is `redactUrls()` in imap-worker). Check new log statements for leaked secrets.
- **Branch safety**: The issue resolver must never push to protected branches (`main`, `master`, `develop`, `release`). If git-related code is modified, verify `assertNotProtected()` is still called.
- **OWASP top 10**: Watch for XSS in control panel templates, command injection in `execFile`/`exec` calls, and unvalidated redirects.

## 5. Lockfile and Dependency Discipline

- If any `package.json` is modified (added/removed/changed dependencies, new workspace), `pnpm-lock.yaml` must be updated in the same commit. CI uses `--frozen-lockfile`.
- If a new workspace package is created, verify it's listed in `pnpm-workspace.yaml`.
- New dependencies should be justified — flag unnecessary additions.

## 6. TypeScript Conventions

- **ESM imports**: Relative imports must use `.js` extensions (e.g., `import { foo } from './bar.js'`). Flag `.ts` extensions or missing extensions in relative imports.
- **Enum pattern**: Must use `const object + type` pattern, never `enum`. Example:
  ```typescript
  export const Foo = { A: 'A', B: 'B' } as const;
  export type Foo = (typeof Foo)[keyof typeof Foo];
  ```
- **Zod config**: Services must use `z.output<typeof schema>` (not `z.infer`) when the schema has `.default()` values.
- **Logging**: Must use `createLogger(name)` from shared-utils (Pino), not `console.log`.

## 7. Docker and Deployment

- **Dockerfile changes**: Must follow the multi-stage pattern (base → deps → build → production). The deps stage must copy all workspace `package.json` files for lockfile resolution.
- **docker-compose.yml**: New services need health checks, restart policies, dependency declarations, and appropriate env vars. Persistent data must use named volumes (not bind mounts to `/tmp`).
- **deploy-hugo.yml**: If a new service is added, it must appear in both the build matrix and the deploy script's `docker pull` list.
- **deploy-mcp.yml**: Only applies to the MCP database server (Azure App Service ZIP deploy).

## 8. AI Provider Changes

- **Task routing**: If a new `TaskType` is added in shared-types, it needs a default provider mapping in the AI router and documentation in CLAUDE.md's "AI Task Types and Routing" table.
- **Prompt keys**: AI calls should use `promptKey` (e.g., `'imap.triage.system'`) for prompt resolution, not inline system prompts. This enables per-client prompt overrides via the control panel.
- **Model config**: The `AiModelConfig` resolution order is CLIENT → APP_WIDE → hardcoded default. If the router logic changes, verify this layering is preserved.

## 9. Review Tone

- Be direct and specific. Reference file paths and line numbers.
- Distinguish between blocking issues (bugs, security, broken contracts) and suggestions (style, minor improvements).
- If something looks intentional but risky, ask for confirmation rather than blocking.
- When flagging a missing sync (e.g., "Prisma enum updated but shared-types not"), state exactly which file and value needs the corresponding change.
