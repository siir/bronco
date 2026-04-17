---
name: batch-issues
description: Triage open GitHub issues and group them by file overlap for parallel remote sessions. Triggers when the user wants to triage, batch, or group issues — phrases like "triage the open issues", "batch these issues", "group these for parallel sessions", "what can we run in parallel", "what's open that needs work", "let's clean up", or asking "what's next" at session start.
argument-hint: [issue-numbers] [label-filter]
user-invocable: true
allowed-tools: Bash(gh *), Bash(git *), Read, Grep, Glob, Agent
---

# batch-issues

Survey open GitHub issues, group them by file overlap, and recommend parallel session splits. Output a batching table with effort estimates and recommended models. Hand off to `gen-prompt` for the actual prompt generation.

## Parse arguments

From `$ARGUMENTS` (or natural language context):
- **Specific issue numbers** (optional) — subset to batch instead of all open
- **Label filter** (optional) — e.g., `bug`, `review-followup`
- **Default:** all open issues NOT labeled `parked`

If the user asks for a subset (e.g., "just the bugs"), apply the label filter.

## Workflow

### 1. Survey open issues

```
gh issue list --state open --repo <owner>/<repo> --limit 50 --json number,title,labels
```

### 2. Filter out parked

Exclude issues labeled `parked` unless the user explicitly says "include parked" or similar override.

### 3. Fetch each issue body

For each remaining issue:

```
gh issue view <N> --json title,body,labels --repo <owner>/<repo>
```

### 4. Identify affected files per issue

Parse the issue body for:
- **"Files affected" / "Key files" sections**
- **File paths referenced inline** — `services/...`, `packages/...`, `mcp-servers/...`
- **Code snippets** — files shown in example code

If the issue body doesn't list files clearly, note "unclear scope" and flag for the user.

### 5. Estimate effort per issue

- **Trivial** — one-line fix, single file (e.g., property binding swap)
- **Small** — handful of lines, 1-2 files (e.g., add validation, fix a bug)
- **Medium** — cross-cutting, 3-5 files (e.g., add a new field threaded through layers)
- **Large** — architectural, many files or migrations (e.g., RBAC, schema overhaul)

### 6. Group by file overlap

Issues touching the same files go in the same batch — safe for parallel execution. Issues touching disjoint file sets can run in separate parallel sessions without merge conflicts.

Natural separation lines for this monorepo:
- **Backend** — `services/copilot-api/`, `services/ticket-analyzer/`, `services/issue-resolver/`, `packages/ai-provider/`, `packages/db/`, `packages/shared-*/`
- **Frontend control panel** — `services/control-panel/`
- **Frontend portal** — `services/ticket-portal/`
- **MCP servers** — `mcp-servers/`
- **Workers** — `services/imap-worker/`, `services/devops-worker/`, `services/scheduler-worker/`, etc.

Cross-cutting issues (touching backend + frontend) may need to ship standalone or be split into coordinated pieces.

### 7. Recommend model per batch

- **Opus** — auth, schema migrations, architecture, cross-cutting changes, security
- **Sonnet** — mechanical fixes (UI tweaks, single-file refactors, bug fixes with clear instructions)

### 8. Flag non-parallelizable issues

- **Too large** — Issues classified as "Large" effort may deserve their own session even without file conflicts
- **Explicit dependencies** — If issue A blocks issue B per the body, don't parallelize them
- **Migration conflicts** — Never batch a new migration with unrelated schema changes (high conflict risk on Prisma migration ordering)

### 9. Output the batching table

```
## Triage — <N> batches

### Batch A: <name>
| # | Issue | Effort | Files |
|---|-------|--------|-------|
| 203 | ... | Small | analyzer.ts |

Recommended model: **<Sonnet | Opus>**

### Batch B: <name>
...

### Not parallelizable / needs own session
- #<N> — <reason>

### Flagged (unclear scope)
- #<N> — <what's missing>
```

### 10. Offer next action

"Generate prompts for these batches?" — hands off to `gen-prompt` which can process multiple issue lists in parallel.

If the user confirms, invoke `gen-prompt` with each batch's issue list and recommended model.

## Anti-patterns to avoid

- **Don't generate prompts here** — delegate to `gen-prompt`. This skill triages; `gen-prompt` writes.
- **Don't modify labels** — the user applies `parked`, `bug`, etc. This skill reads them.
- **Don't create new issues** — if something is unclear, flag it for the user to triage manually.
- **Don't batch migrations with other schema changes** — even if files don't directly overlap, migration timestamp ordering can conflict.

## Hand-off

- Primary: `gen-prompt` for each batch
- If the user wants to refine the batching, ask and re-run grouping
- If issues need labels applied (e.g., marking parked), the user does that manually via `gh issue edit`
