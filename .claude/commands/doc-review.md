---
description: Audit the monorepo for code and documentation gaps — fix code issues first, then update all docs
allowed-tools: Bash(git *), Bash(ls *), Bash(pnpm *), Bash(npx tsc *), Bash(python3 *), Read, Edit, Write, Glob, Grep, Task
---

## Your task

Audit the entire monorepo for code-level gaps and documentation staleness. Fix code issues first (so docs reflect reality), then update all documentation. Work in 4 phases: audit, report, fix code, update docs.

## Shell command rules (CRITICAL)

- **NEVER** use pipes (`|`), `&&` chains, or command substitution in shell commands.
- Use separate Bash tool calls for each command.
- Quote all paths with spaces using double quotes.

## Phase 1 — Audit (read-only)

Perform a comprehensive audit. Do NOT make any changes yet.

### 1.1 Workspace inventory

- Read `pnpm-workspace.yaml` to discover all workspace members.
- Glob for `packages/*/package.json`, `services/*/package.json`, `mcp-servers/*/package.json`.
- For each workspace member, check if a `README.md` exists.

### 1.2 README accuracy (for each existing README)

For each service/package that has a README:

| What to check | How |
|----------------|-----|
| Source layout tree | `ls src/` and compare against the tree in the README |
| Env vars table | Read `config.ts` (or `src/config.ts`) Zod schema keys vs table in README |
| Routes (API services) | `ls src/routes/` vs route table in README |
| Exports (packages) | Read `src/index.ts` vs documented exports |
| Dependencies | Read `package.json` dependencies vs any listed in README |
| "Runs On" / deployment | Cross-check with `docker-compose.yml` and `.github/workflows/` |

### 1.3 TODO.md audit

- Read `TODO.md`.
- For each unchecked item (`- [ ]`), grep the codebase to determine if the feature/fix has been implemented.
- Note items that are complete but still unchecked, and items that are obsolete.

### 1.4 CLAUDE.md audit

- Read `CLAUDE.md` and verify:
  - **Important Files** table — glob each path to confirm it still exists.
  - **AI Task Types** — read `packages/shared-types/src/ai.ts` and compare against the documented task type lists.
  - **Health ports** — grep for `createHealthServer` across all services and compare port numbers against the documented list.
  - **`pnpm dev:*` commands** — read root `package.json` scripts and compare against documented dev commands.
  - **Service descriptions** — spot-check that each service's described purpose matches its actual code.
  - **Ticket Categories** — read `packages/shared-types/src/ticket.ts` (or wherever `TicketCategory` is defined) and compare.
  - **Ticket Sources** — verify the source enum matches the documented table.

### 1.5 docs/copilot-skills.md audit

If `docs/copilot-skills.md` exists:
- Verify queue names by grepping for `createQueue(` or BullMQ queue definitions.
- Verify configurability tables against actual config schemas.
- Verify AI task type lists match `shared-types`.
- Cross-reference any tables for consistency with CLAUDE.md and READMEs.

### 1.6 Root README.md audit

- Compare monorepo structure description against actual directory layout.
- Verify any route tables, env var tables, or architecture descriptions.

### 1.7 Code-level gap scan

Check for infrastructure gaps across all services:

| What | How |
|------|-----|
| Missing health endpoints | Grep `createHealthServer` — compare against service list |
| Missing barrel exports | For each package, read `src/index.ts` vs actual `src/` files |
| Missing Dockerfile | Check each service for `Dockerfile` |
| Missing docker-compose entry | Read `docker-compose.yml` and compare against service list |
| Missing CI matrix entry | Read `.github/workflows/deploy-hugo.yml` and `.github/workflows/ci.yml` for service lists |
| Stale config schemas | Spot-check that Zod schemas in `config.ts` match actual env vars used in code |

## Phase 2 — Report (present findings, wait for go-ahead)

### 2.1 Create tasks

Use TaskCreate to create tasks grouped by type. Use these prefixes in the subject:

- **`[code]`** — missing health endpoints, incomplete exports, missing infra entries, stale configs
- **`[missing-doc]`** — services/packages with no README
- **`[stale-doc]`** — incorrect source layouts, missing env vars, outdated tables in existing docs
- **`[minor]`** — unchecked TODO items that are done, small wording issues
- **`[manual]`** — subjective items needing human judgment

### 2.2 Present gap analysis

Present a summary table to the user:

```
| Type | Count | Examples |
|------|-------|----------|
| Code fixes | N | missing health endpoint in X, ... |
| Missing docs | N | services/foo, packages/bar |
| Stale docs | N | wrong env vars in X README, ... |
| Minor | N | TODO items already done |
| Manual review | N | .pptx needs update |
```

**Stop here and wait for the user to acknowledge before proceeding to Phase 3.** Ask: "Ready to proceed with code fixes (Phase 3)?"

## Phase 3 — Fix code gaps

Fix discovered code issues BEFORE touching documentation, so the docs will reflect the corrected state.

### 3.1 Apply code fixes

Work through the `[code]` tasks created in Phase 2:
- Add missing health endpoints using `createHealthServer(name, port, { getDetails })` from shared-utils.
- Add missing barrel exports to `src/index.ts` files.
- Add missing Dockerfile / docker-compose / CI entries following existing patterns.
- Fix stale config schemas.

### 3.2 Verify

- Run `pnpm typecheck` (or targeted `npx tsc --noEmit` for affected packages).
- If typecheck fails, fix the errors. If a fix introduces errors in unrelated packages, revert and note it.

### 3.3 Commit code fixes

- Stage only the changed files.
- Present the diff to the user and ask for confirmation before committing.
- Commit message: `fix: address code gaps found during doc review`
- If no code fixes were needed, skip this step.

## Phase 4 — Update documentation

Now that the codebase is fixed, update all documentation to match.

### 4.1 Create missing READMEs

For each service/package lacking a README, generate one by reading:
- `package.json` (name, description, dependencies)
- `src/index.ts` or main entry point (what it does)
- `config.ts` / `src/config.ts` (env vars — Zod schema keys become the env var table)
- `Dockerfile` (if present — deployment info)

Follow the established README template pattern from existing READMEs in the repo (title, description, "Runs On", "How It Works", development, deployment, env vars table, source layout tree).

**Edge cases:**
- Angular services (`control-panel`, `ticket-portal`) have `src/app/` component structure, not flat `src/*.ts`. Use `src/app/` layout.
- Some services have no `config.ts` (frontends use `angular.json` / `proxy.conf.json`). Skip env vars table for these.

### 4.2 Update stale READMEs

Edit only the stale sections identified in Phase 1. Do not rewrite entire READMEs.

### 4.3 Update TODO.md

- Check off (`- [x]`) items confirmed as complete.
- Add a note next to obsolete items (e.g., `~~obsolete — removed in v2~~`).

### 4.4 Update docs/copilot-skills.md

- Fix queue name maps, configurability tables, AI task type lists.
- Cross-reference for consistency with CLAUDE.md.

### 4.5 Update CLAUDE.md

- Update the **Important Files** table (add new files, remove deleted ones).
- Update **AI Task Types** section if task types changed.
- Update health port list if new services were added.
- Update `pnpm dev:*` commands if new scripts exist.
- Update service descriptions if they changed.

### 4.6 Regenerate architecture PowerPoint

The architecture presentation is generated programmatically by `scripts/generate-architecture-pptx.py` (python-pptx).

1. Review the script and update it to reflect any architectural changes found during the audit (new services, removed services, changed connections, new task types, updated infrastructure).
2. Run the script: `python3 scripts/generate-architecture-pptx.py`
3. Verify the output file exists at `docs/bronco-architecture.pptx`.
4. Include the updated script and generated `.pptx` in the documentation commit.

### 4.7 Commit documentation updates

- Stage only documentation files.
- Present the diff to the user and ask for confirmation before committing.
- Commit message: `docs: update documentation to match current codebase`

## Cross-reference consistency rule

The same fact appearing in multiple places (README, CLAUDE.md, copilot-skills.md, TODO.md) must agree everywhere. When updating one doc, check if the same info exists in others and update them too.

## Verification checklist (before finishing)

After all changes, verify:
- [ ] `pnpm typecheck` passes (if code was changed)
- [ ] Every Important Files path in CLAUDE.md exists
- [ ] Every `pnpm dev:*` command in CLAUDE.md exists in root `package.json`
- [ ] Health port numbers in CLAUDE.md match `createHealthServer` calls
- [ ] Code commits and doc commits are separate
