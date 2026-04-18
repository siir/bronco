# coder preferences — bronco

## Scope

The entire Bronco monorepo:
- **Control panel** (`services/control-panel/`) — Angular UI, themes, components, dialogs
- **Ticket portal** (`services/ticket-portal/`)
- **Backend services** (`services/copilot-api/`, `services/ticket-analyzer/`, `services/imap-worker/`, etc.)
- **MCP servers** (`mcp-servers/database/`, `mcp-servers/platform/`, `mcp-servers/repo/`)
- **Shared packages** (`packages/shared-types/`, `packages/db/`, `packages/ai-provider/`, `packages/shared-utils/`)
- **CI/CD & deploy** (`.github/workflows/`, `docker-compose.yml`, Dockerfiles, Caddyfile)

## Base Branch

Feature branches PR into **staging**; staging PRs into **master**.

## Build & Typecheck

- `pnpm --filter @bronco/control-panel typecheck` (or the relevant package) after every fix
- `pnpm install` for dependencies
- Run `pnpm db:generate` after changes to `packages/db/prisma/schema.prisma` before `pnpm build` or `pnpm typecheck`

## Committing

- Write commit messages to `.tmp/commit-msg.txt` and use `git commit -F .tmp/commit-msg.txt` (never heredoc).
- Use the project convention: `fix:`, `feat:`, `chore:`, `refactor:` + `(refs #N)` or `(fixes #N)`.

## Hugo Deployment Server

`ssh hugo-app` reaches the Hugo VM (Ubuntu, Docker Compose, all services running). You can read logs, inspect running containers, check API responses, and hot-patch files.

### Verify connectivity

```bash
ssh hugo-app "docker ps --format '{{.Names}}' | head -5"
```

### Access patterns

```bash
# View container logs
ssh hugo-app "docker logs bronco-copilot-api-1 --tail 50"

# Query the database
ssh hugo-app "docker exec bronco-postgres-1 psql -U bronco -d bronco -c \"SELECT ...\""

# Check a container's env
ssh hugo-app "docker exec bronco-ticket-analyzer-1 printenv SOME_VAR"

# Restart a service
ssh hugo-app "docker restart bronco-<service>-1"

# Check container status
ssh hugo-app "docker ps --format '{{.Names}}: {{.Status}}'"
```

### Safety rules — READ-ONLY for data, SAFE EDITS ONLY for code

- **SAFE**: editing static assets, restarting containers, tweaking env vars, reading logs, inspecting container state, Caddy config changes
- **UNSAFE — NEVER do on Hugo**: database schema changes (migrations must go through the repo pipeline — direct DDL desyncs Prisma migration history), data mutations (INSERT/UPDATE/DELETE on the control-plane Postgres), Docker image rebuilds (images come from GHCR via deploy-hugo, not built locally on the VM)
- When in doubt, make the change in the repo, commit, and let the deploy pipeline handle it. Hugo hot-patches are for **temporary verification** only — they get overwritten on the next deploy.

### Hot-patching

When fixing UI issues, offer to make **dual changes**: edit the repo locally for the commit AND patch the running code on Hugo so the operator sees it live without waiting for a deploy.

- For Angular UI: the built assets are in `/srv/control-panel/` on Hugo (served by Caddy). For quick CSS/template tweaks, editing the compiled JS directly can work for verification before committing the real fix.
- For backend services: running in Docker Compose. `ssh hugo-app` then inspect logs, restart containers, or tweak environment variables.
- If it's a control-panel-only change, offer to `/deploy-hugo` for immediate preview.

## Local Dev Server

If the operator has `pnpm dev:panel` (`:4200`) or `pnpm dev:api` (`:3000`) running locally, changes are visible on save via hot reload. Confirm which services are running so you know whether to proxy API calls to localhost or Hugo.

## Investigation Tips

- **Read the relevant component/service code** before proposing a fix. Never guess at structure.
- **Trace the data flow** end-to-end: UI component → service call → API endpoint → database query. The bug might be at any layer.
- **Check compiled `dist/` vs source** if the operator reports something that "should work" — stale compiled JS on Hugo is a common source of phantom bugs.
- **Check theme tokens** if the visual bug is color/contrast related. The design system uses CSS custom properties defined in `services/control-panel/src/styles/theme.css` (light) and `services/control-panel/src/styles/themes/*.css` (dark themes).

## Shipping

- If merging a PR into staging: use `--squash` (keeps staging history linear — one commit per PR).
- If you need to sync your local feature branch before merging, rebasing is fine (`git pull --rebase` / `git rebase`), but that is separate from the PR merge strategy.
- If promoting staging to master: use `--merge` (regular merge commit, no squash).
- Watch `deploy-hugo.yml` after the tag is created to confirm a clean deploy.
- Walk `.tmp/post-deploy-verification.md` against the live deploy.

## Common Pitfalls (from experience)

- **`app-select` value binding**: uses `[attr.selected]` on each `<option>`, NOT `[value]` on the `<select>`. The latter evaluates before children render and shows the wrong option.
- **`--bg-code` + `--text-code`** is the correct pair for code blocks. Never pair `--bg-code` with `--text-secondary` (invisible in light theme).
- **`--text-on-accent`** is only valid against `--accent` background. Don't pair it with `--text-primary` or any other background token.
- **Stale compiled `dist/`**: if the operator reports something that should work per the source, check whether the running service (locally or on Hugo) is serving old compiled JS.
- **Dialog scroll**: `app-dialog` caps at `calc(100vh - 48px)` with a scrollable body. If a new dialog is clipping, check that it uses `<app-dialog>` and not a custom wrapper.
- **Native `<select>` has no real placeholder**: consumers must include a `{ value: '', label: '...' }` option for the empty/default state.
