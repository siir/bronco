---
name: review-branch
description: Review a completed branch or PR against the spec in its linked issue(s). Triggers when the user wants to review a completed branch — phrases like "review the branch", "review <branch-name>", "prompt is complete", "branch is done", "let's see what came back", or when a branch/PR number is mentioned in a post-remote-session context.
argument-hint: <branch-name-or-PR-number>
user-invocable: true
allowed-tools: Bash(gh *), Bash(git *), Read, Grep, Glob, Agent
---

# review-branch

Review a branch or PR against the design spec in its linked issue(s). Output a structured verdict and offer next actions. Never push fixes or merge without explicit user confirmation.

## Parse arguments

From `$ARGUMENTS` (or natural language context):
- **Branch name OR PR number** (required). If PR, resolve the head ref via `gh pr view <N> --json headRefName`.
- **Issue numbers** (optional). If not provided, parse from commit messages (`fixes #N` / `refs #N` via `git log --format=%B`).

If neither is present in context, ask the user for the branch or PR.

## Workflow

### 1. Fetch the branch

```
git -C "<repo>" fetch origin <branch>
```

Never `cd + git`. Always `git -C`.

### 2. Determine base branch

- Default: `staging`
- Design branches (name matches `design/*` or the PR base is `design/staging`): `design/staging`

Confirm via:
```
gh pr view <N> --json baseRefName
```

if reviewing a PR.

### 3. Diff stat

```
git -C "<repo>" diff origin/<base>..origin/<branch> --stat
```

Note the file count and scope.

### 4. Read changed files

- **Small diff (<20 files):** read each changed file directly
- **Large diff (>20 files):** dispatch one sub-agent per service/package (e.g., `services/copilot-api/`, `packages/db/`, `services/control-panel/`). Each agent summarizes what changed in its scope and flags concerns.

### 5. Fetch linked issues

For each issue referenced in commits or provided in args:

```
gh issue view <N> --json title,body,labels --repo <owner>/<repo>
```

Note the design spec — what the branch is supposed to do.

### 6. Compare implementation against spec

For each issue/design section, categorize findings:

- **Covered** — spec item is implemented correctly
- **Missing** — spec item not addressed
- **Drift** — unrelated changes, reverted code from other PRs, scope creep
- **Concerns** — bugs, security issues, convention violations

Convention checks specific to this project:
- ESM imports with `.js` extensions in relative TypeScript imports
- `const object + type` pattern for enums (not TS `enum` keyword)
- Prisma enum values match shared-types enum values
- No `cd + git` chains in any shell code
- Double-quoted paths with spaces (never backslash-escaped)

### 7. Check new migrations

If the diff includes files in `packages/db/prisma/migrations/`:

- **Timestamp ordering** — no duplicate timestamps across migration directories
- **Dedup before UNIQUE** — if a UNIQUE constraint is being added, verify existing data is deduplicated first
- **Data integrity** — backfills for new NOT NULL columns, safe drops (CASCADE vs RESTRICT)
- **Lockfile discipline** — if `package.json` changed, verify `pnpm-lock.yaml` is in the same commit

### 8. Output structured report

```
## Review: <branch-name>

**Verdict:** <Ready to merge | Needs fixes | Major concerns>

### Covered
- <spec item 1>
- <spec item 2>

### Missing / Drift
- <actionable item>

### Concerns
- <bug, security, or convention issue>

### Nits (optional)
- <cosmetic findings>
```

Keep each section tight. Link file paths with line numbers where relevant (`file:line` format).

### 9. Offer next action

Based on the verdict:
- **Ready to merge:** "Ready to merge. Want me to squash-merge via `gh pr merge --squash --delete-branch`?"
- **Needs fixes (small):** "Want me to push fixes to this branch, or generate a follow-up prompt for a remote session?"
- **Needs fixes (large):** "This needs substantial work. Generate a follow-up prompt for a remote session."
- **Major concerns:** "Recommend blocking the merge. Do you want to open review comments, or discuss a redesign?"

Never act without user confirmation.

## Anti-patterns to avoid

- **Don't auto-push fixes** — always ask first. The user is the merge authority.
- **Don't auto-merge** — defer to user, `ship-release`, or `mass-merge-prs`.
- **Don't create issues for findings** — that's `gap-analysis`'s job. This skill reports; the user decides where findings go.
- **Don't `cd + git`** — always `git -C`.
- **Don't skip the migration check** — migration safety bugs are high-blast-radius.

## Parked issues

If the branch references a `parked`-labeled issue, warn the user:

> "This branch touches #N which is labeled `parked`. Proceed with review, or pause and ask about the status change?"

## Hand-off

- If fixes are needed → `gen-prompt` for a follow-up session, or push directly if small and confirmed
- If ready to merge → `mass-merge-prs` (for batches) or direct `gh pr merge`
- If findings deserve tracking → recommend `gap-analysis`
