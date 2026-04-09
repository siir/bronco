---
description: Start a live debug session — set up worktree, connect to Hugo, and fix reported bugs interactively. Triggers on "debugger", "debug session", "start debugging".
---

# Debugger Session

Interactive bug-hunting and fix session across the full Bronco stack. The operator reports issues (screenshots, descriptions, URLs), you investigate, fix, and commit — with the option to hot-patch Hugo live so changes are visible immediately even when no local dev server is running.

## Scope

The entire Bronco monorepo:
- **Control panel** (`services/control-panel/`) — Angular UI, themes, components, dialogs
- **Ticket portal** (`services/ticket-portal/`)
- **Backend services** (`services/copilot-api/`, `services/ticket-analyzer/`, `services/imap-worker/`, etc.)
- **MCP servers** (`mcp-servers/database/`, `mcp-servers/platform/`, `mcp-servers/repo/`)
- **Shared packages** (`packages/shared-types/`, `packages/db/`, `packages/ai-provider/`, `packages/shared-utils/`)
- **CI/CD & deploy** (`.github/workflows/`, `docker-compose.yml`, Dockerfiles, Caddyfile)

## Session Setup

1. **Check git state.** Confirm the current branch. If on `staging` or `design/staging`, create a fix branch (`fix/<slug>`) unless the operator says to commit directly.

2. **Offer Hugo connection.** Ask if the operator has a local dev server running or wants to work against Hugo directly. If Hugo:
   - `ssh hugo-app` reaches the Hugo VM (Ubuntu, Docker Compose, all services running)
   - You can read logs, inspect running containers, check API responses, and hot-patch files
   - When fixing UI issues, offer to make **dual changes**: edit the repo locally for the commit AND patch the running code on Hugo so the operator sees it live without waiting for a deploy

3. **Offer local dev server.** If the operator has `pnpm dev:panel` (`:4200`) or `pnpm dev:api` (`:3000`) running locally, changes are visible on save via hot reload. Confirm which services are running so you know whether to proxy API calls to localhost or Hugo.

## Core Loop

Repeat until the operator says stop:

### 1. Receive the Report

The operator provides a bug report — usually a screenshot, sometimes a description or URL. Read the screenshot carefully. Note:
- What page / route / tab is visible
- What's wrong (visual, data, behavior)
- What theme is active (light vs dark — check the background)
- Any error text visible in the UI or console

### 2. Investigate

- **Read the relevant component/service code** before proposing a fix. Never guess at structure.
- **Trace the data flow** end-to-end: UI component → service call → API endpoint → database query. The bug might be at any layer.
- **Check compiled `dist/` vs source** if the operator reports something that "should work" — stale compiled JS on Hugo is a common source of phantom bugs (the source is correct but the running code is old).
- **Check theme tokens** if the visual bug is color/contrast related. The design system uses CSS custom properties defined in `services/control-panel/src/styles/theme.css` (light) and `services/control-panel/src/styles/themes/*.css` (dark themes). Common bugs: wrong token pairing (e.g. `--text-secondary` on `--bg-code`), missing token in a theme file.
- **Use `console.log` diagnostics temporarily** if the data flow is ambiguous — add them, let the operator test, read the output, then remove them before committing.

### 3. Fix

- Apply the minimum change that fixes the bug. Don't refactor surrounding code.
- Run `pnpm --filter @bronco/control-panel typecheck` (or the relevant package) after every fix to catch regressions immediately.
- If the operator is testing against Hugo, offer to hot-patch:
  - For Angular UI: the built assets are in `/srv/control-panel/` on Hugo (served by Caddy). For quick CSS/template tweaks, editing the compiled JS directly can work for verification before committing the real fix.
  - For backend services: running in Docker Compose. `ssh hugo-app` then inspect logs, restart containers, or tweak environment variables.

  **Hugo safety rules — READ-ONLY for data, SAFE EDITS ONLY for code:**
  - **SAFE**: editing static assets, restarting containers, tweaking env vars, reading logs, inspecting container state, Caddy config changes
  - **UNSAFE — NEVER do on Hugo**: database schema changes (migrations must go through the repo pipeline — direct DDL desyncs Prisma migration history), data mutations (INSERT/UPDATE/DELETE on the control-plane Postgres), Docker image rebuilds (images come from GHCR via deploy-hugo, not built locally on the VM)
  - When in doubt, make the change in the repo, commit, and let the deploy pipeline handle it. Hugo hot-patches are for **temporary verification** only — they get overwritten on the next deploy.

### 4. Classify the Outcome

After investigating, each reported issue falls into one of these buckets:

| Outcome | Action |
|---------|--------|
| **Fixed locally** | Stage the files, note it for the commit. Typecheck must pass. |
| **Backend/data issue** | The fix is in a backend service, ingestion engine, schema, or external system (e.g. SQL-DBAdmin). File a GitHub issue with root-cause analysis. Add to `.tmp/post-deploy-verification.md` if it needs post-deploy confirmation. |
| **Needs more info** | Ask the operator for a screenshot, network tab output, console log, or reproduction steps. |
| **Won't fix / by design** | Explain why and confirm the operator agrees. |

### 5. Track

- **Post-deploy verification**: maintain `.tmp/post-deploy-verification.md` for anything that can't be fully verified locally (stale backend, missing data, Hugo-specific behavior). Each entry should note WHY it couldn't be verified and WHAT to check after deploy.
- **GitHub issues**: file issues for bugs that are out of scope for the current fix branch — especially backend/data issues, architectural changes, or cross-repo work (e.g. SQL-DBAdmin). Include root-cause analysis, file:line references, and a proposed fix sketch.
- **Copilot review comments**: if the operator mentions review comments to address, fetch them from the PR, fix the actionable ones, reply + resolve threads, and note any won't-fix items with rationale.

## Committing

When the operator says "commit" or you've accumulated a logical batch of fixes:

- **Split into logical commits** — one per bug class or feature area, not one giant commit.
- **Write detailed commit messages** using the project convention (`fix:`, `feat:`, `chore:`, `refactor:` + `(refs #N)` or `(fixes #N)`).
- **Write commit messages to `.tmp/commit-msg.txt`** and use `git commit -F .tmp/commit-msg.txt` (never heredoc).
- **Always typecheck before committing.** If the build fails, fix it before the commit.

## Shipping

When the operator wants to ship fixes:

- Push the fix branch, create a PR to `staging` with a structured body (summary + test plan).
- If merging to staging: use `--rebase`.
- If promoting staging to master: use `--merge` (regular merge commit, no squash).
- Watch `deploy-hugo.yml` after the tag is created to confirm a clean deploy.
- Walk `.tmp/post-deploy-verification.md` against the live deploy.

## Common Pitfalls (from experience)

- **`app-select` value binding**: uses `[attr.selected]` on each `<option>`, NOT `[value]` on the `<select>`. The latter evaluates before children render and shows the wrong option.
- **`--bg-code` + `--text-code`** is the correct pair for code blocks. Never pair `--bg-code` with `--text-secondary` (invisible in light theme).
- **`--text-on-accent`** is only valid against `--accent` background. Don't pair it with `--text-primary` or any other background token.
- **Stale compiled `dist/`**: if the operator reports something that should work per the source, check whether the running service (locally or on Hugo) is serving old compiled JS. Compare `dist/routes/tickets.js` (or equivalent) against the source `.ts` file.
- **Dialog scroll**: `app-dialog` caps at `calc(100vh - 48px)` with a scrollable body. If a new dialog is clipping, check that it uses `<app-dialog>` and not a custom wrapper.
- **Native `<select>` has no real placeholder**: consumers must include a `{ value: '', label: '...' }` option for the empty/default state. The `app-select` component does not render fake placeholder options.
