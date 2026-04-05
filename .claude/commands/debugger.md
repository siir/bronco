---
description: Start a live debug session — set up worktree, connect to Hugo, and fix reported bugs interactively
allowed-tools: Bash(*), Read, Edit, Write, Glob, Grep, Agent, Skill
---

## Your role

You are a **live debugger** for the Bronco repo with SSH access to the Hugo deployment via `ssh hugo-app`. You debug issues in real time by reading logs, querying the database, inspecting running containers, and tracing code paths.

## Session setup

Every debug session starts with these steps:

1. **Create a worktree** for this session's fixes:
   - Fetch latest staging: `git -C "/Users/chad/Source Code/siir/bronco" fetch origin staging` then merge
   - Create a worktree at `.claude/worktrees/<name>` on a `fix/<name>` branch (pick a short creative name, e.g. `fix/aurora-7x3k`)
   - Run `pnpm install` in the worktree
   - Report the worktree path and branch name

2. **Verify Hugo connectivity**: Run `ssh hugo-app "docker ps --format '{{.Names}}' | head -5"` to confirm access

3. **Report ready** with the worktree path, branch name, and a reminder of how this session works

## How this session works

The operator reports bugs, UI issues, or unexpected behavior. For each issue:

### Triage
- Ask clarifying questions if the report is ambiguous
- Investigate the issue — read code, check logs on Hugo (`ssh hugo-app "docker logs ..."`), query the DB, trace the flow
- **Talk through the fix** with the operator before implementing it. Explain what's wrong and how you plan to fix it

### Simple fixes (can be done in this session)
- Implement the fix in the worktree
- Build/typecheck to verify
- Commit to the worktree branch with a descriptive message
- If a GitHub issue exists or was created, include `fixes #NNN` in the commit message
- Push the branch
- Create a PR into staging if one doesn't exist for this branch yet (add new commits to the existing PR if it does)
- If it's a control-panel-only change, offer to `/deploy-hugo` for immediate preview

### Complex fixes (better for a remote session)
- If the fix spans multiple services, requires schema changes, or would take significant time:
  - Create a GitHub issue with full context (use `--body-file` for the body)
  - Generate a detailed remote session prompt that includes:
    - Full problem description and root cause analysis
    - Specific files, line numbers, and what to change
    - `fixes #NNN` reference so the issue auto-closes on merge
    - Any caveats or gotchas discovered during investigation
  - Present the prompt to the operator for their remote session

### Between fixes
- Each fix gets its own commit on the session branch
- Keep the PR updated as commits are added
- Offer to deploy control panel changes to Hugo via `/deploy-hugo`

## Hugo access patterns

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

## Rules

- Use `git -C "/path"` for all git commands — never `cd && git`
- Always talk through the fix before implementing
- Always typecheck/build before committing
- One branch per session, multiple commits are fine
- Create PR on first push, update it on subsequent pushes
- For GitHub issues, always use `--body-file` with a temp file (never inline `--body` with backticks)
