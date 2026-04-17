# Coordinator Workflow Skills — Design

**Date:** 2026-04-15
**Status:** Approved
**Author:** Chad + Claude (coordinator session)

## Problem

The coordinator workflow (triage → design → prompt → review → merge) has three high-friction steps that take significantly longer than the decisions they support:

1. **Prompt generation** — reading affected files for line numbers and assembling a grounded remote session prompt takes 10+ minutes per issue. The actual design decision takes 2-3 minutes.
2. **Branch review** — fetching, diffing, reading changed files, and comparing to the spec is the same mechanical work every time a remote session finishes.
3. **Issue triage/batching** — grouping open issues by file overlap for parallel execution is repeated manual work at session start.

These are deterministic processes that currently live in the coordinator session as ad-hoc operations. They deserve dedicated skills so they execute faster, more consistently, and can fire from any session — not just inside a coordinator.

## Goals

- Reduce the coordinator's "watch time" (user waiting while Claude reads files) without changing where user decisions happen.
- Make each skill standalone — any Claude Code session in this repo can trigger them from natural conversation.
- Codify conventions learned from memory/feedback (branch naming, prompt structure, migration safety, etc.) so they're applied consistently.
- Keep the coordinator skill as a high-level session-starter; these new skills are the heavy-lifting components it (and any session) can invoke.

## Non-Goals

- Not replacing the coordinator skill — it remains the orchestrator for long design discussions.
- Not building a generic issue-management framework — these skills are Bronco-specific, live in `.claude/skills/`.
- Not automating decisions that require user input (design choices, merge approval, etc.).

## Skill Specifications

### 1. `gen-prompt`

**Location:** `.claude/skills/gen-prompt/skill.md`

**Purpose:** Generate a grounded remote coding session prompt from one or more GitHub issues.

**Trigger description:** "Use when the user wants to generate a prompt for a remote coding session, or after a design discussion concludes with an explicit plan ready to execute. Triggers on phrases like 'generate a prompt for <issues>', 'kick off a session for <issues>', 'write up the prompt', 'let's get a session going'."

**Inputs:**
- Required: issue numbers (parsed from conversation — e.g., "203, 200")
- Optional: model preference (`sonnet` | `opus` | `haiku`)
- Optional: parallel batches (for generating multiple prompts at once)

**Workflow:**

1. Fetch each issue body and labels via `gh issue view <N> --json title,body,labels`
2. Identify affected files — parse from issue body's "Files affected" section or grep for referenced symbols
3. For complex multi-issue workstreams (5+ issues or 10+ files), dispatch parallel sub-agents to explore distinct file clusters
4. Assemble prompt using these conventions:
   - Four backticks for the outer fence (preserves any inner triple-backticks)
   - Opens with "Read `CLAUDE.md` before starting"
   - No branch creation instructions — Claude Code manages branch naming
   - "Use sub agents for independent workstreams" when 3+ distinct file clusters exist
   - Exact file paths with line numbers (never guessed — read from step 2)
   - Each issue gets its own numbered section with "What's the problem" + "Fix" + exact code snippets
   - Verification steps: `pnpm typecheck`, `pnpm build`
   - Final: squash commit with `feat:`/`fix:` + `(fixes #N)` or `(refs #N)`, then `git push`, then `gh pr create --base staging`
5. Output the prompt ready to copy/paste

**Does NOT:**
- Create branches, push, or create PRs itself
- Guess file paths or line numbers
- Include `cd <repo> && git <cmd>` patterns (uses `git -C` where needed in setup steps)
- Include PR management instructions beyond the final `gh pr create`

**Conventions captured from memory:**
- Absolute paths quoted with double quotes
- Never backslash-escape spaces
- Multi-prompt sessions: state "prompt N of M" upfront, mention "continue on same branch" for subsequent prompts
- Last prompt in a sequence is the only one that commits + pushes

**Model recommendation logic:**
- If user specifies a model, honor it
- If not: Opus for auth/schema/architecture/migrations/cross-cutting changes; Sonnet for mechanical fixes (UI tweaks, straightforward refactors, single-file changes)

---

### 2. `review-branch`

**Location:** `.claude/skills/review-branch/skill.md`

**Purpose:** Review a completed branch or PR against the spec in its linked issue(s).

**Trigger description:** "Use when the user wants to review a completed branch or PR against its spec. Triggers on phrases like 'review the branch', 'review <branch-name>', 'prompt is complete', 'branch is done', 'let's see what came back', or when a branch/PR number is mentioned in a post-remote-session context."

**Inputs:**
- Required: branch name OR PR number (if PR, resolve via `gh pr view --json headRefName`)
- Optional: issue numbers the branch addresses (if not provided, parse from commit messages via `fixes #N` / `refs #N`)

**Workflow:**

1. Fetch the branch: `git -C <repo> fetch origin <branch>`
2. Determine base:
   - Default: `staging`
   - Design branches (matching `design/*`): `design/staging`
3. Diff stat: `git -C <repo> diff origin/<base>..origin/<branch> --stat`
4. Read each changed file on the branch. For large diffs (>20 files), dispatch one sub-agent per service/package (e.g., one for `services/copilot-api/`, one for `packages/db/`, one for `services/control-panel/`) with instructions to summarize what changed and flag concerns
5. Fetch linked issue(s) to get the design spec
6. Compare implementation against spec:
   - **Covered** — what's done
   - **Missing** — spec items not addressed
   - **Drift** — unrelated changes, reverted code from other PRs
   - **Concerns** — bugs, security, convention violations (ESM imports, const+type enums, ORM patterns)
7. Check new migrations:
   - Timestamp ordering (no duplicates)
   - Dedup before UNIQUE constraints
   - Data integrity (backfills, NOT NULL changes)
8. Output structured report:
   - **Verdict:** Ready to merge | Needs fixes | Major concerns
   - **Covered:** bullet list
   - **Missing/drift:** actionable items
   - **Nits:** optional cosmetic findings
9. Offer next action: "Push fixes to this branch?" or "Ready to merge?" (does not act without confirmation)

**Does NOT:**
- Push fixes automatically (always asks)
- Merge the PR (defer to user, `ship-release`, or `mass-merge-prs`)
- Create issues for findings (that's `gap-analysis`)

**Conventions:**
- Always `git -C` — never `cd + git`
- For PRs: `gh pr view` for head ref, merge state, existing review comments
- Respect the `parked` label — if the branch references a parked issue, warn and ask if review should still proceed

---

### 3. `batch-issues`

**Location:** `.claude/skills/batch-issues/skill.md`

**Purpose:** Triage open GitHub issues, group by file overlap, recommend parallel session splits.

**Trigger description:** "Use when the user wants to triage open issues, group issues for parallel remote sessions, or asks 'what's next' at session start. Triggers on phrases like 'triage the open issues', 'batch these issues', 'group these for parallel sessions', 'what can we run in parallel', 'what's open that needs work', 'let's clean up'."

**Inputs:**
- Optional: specific issue numbers to batch (subset)
- Optional: label filters (e.g., `bug`, `review-followup`)
- Default: all open issues NOT labeled `parked`

**Workflow:**

1. Survey: `gh issue list --state open --repo <owner/repo>`
2. Filter out `parked` unless user explicitly overrides
3. For each issue, fetch body via `gh issue view --json title,body,labels`
4. Identify affected files from the issue body (parse "Files affected" / "Key files" sections, or extract from code snippets referenced)
5. Estimate effort:
   - **Trivial** — one-line fix, single file
   - **Small** — handful of lines, 1-2 files
   - **Medium** — cross-cutting, 3-5 files
   - **Large** — architectural, many files or migrations
6. Group by file overlap — issues touching the same files go in the same batch (safe for parallel)
7. Recommend session splits:
   - Natural separation: backend vs frontend by file paths
   - Flag issues that can't be parallelized (too large, explicit dependencies)
   - Recommend model per batch (Opus for complex/auth/architecture/migration work, Sonnet for mechanical fixes)
8. Output a table: batch name → issues → effort → files touched → recommended model
9. Offer next action: "Generate prompts for these batches?" (hands off to `gen-prompt`)

**Does NOT:**
- Generate the prompts (delegates to `gen-prompt`)
- Modify issue labels (user does that)
- Create new issues

**Conventions:**
- `parked` label always excluded unless user says otherwise
- Categorize review-followup issues alongside their subject (backend vs frontend)
- Never batch a migration with unrelated schema changes (conflict risk)

## Interaction Between Skills

These skills are standalone but complement each other:

```
batch-issues → (hand off) → gen-prompt → (remote session runs) → review-branch → (user decides: merge or fix)
```

A coordinator session can chain all three naturally. A standalone session can invoke any one in isolation.

## Anti-Patterns to Avoid

- **Don't auto-push fixes** — always ask. The user is the merge authority.
- **Don't auto-merge PRs** — skills report; user decides.
- **Don't bundle unrelated work** — if `batch-issues` can't cleanly group an issue, mark it standalone.
- **Don't skip verification** — every `gen-prompt` output includes typecheck + build as the last step before commit.

## File Structure

```
.claude/skills/
├── control-panel-test/     (existing)
├── gen-prompt/
│   └── skill.md
├── review-branch/
│   └── skill.md
└── batch-issues/
    └── skill.md
```

Each `skill.md` follows the standard skill format:
- YAML frontmatter: `name`, `description` (trigger logic), optional `argument-hint`, optional `allowed-tools`
- Body: workflow steps, conventions, anti-patterns

## Open Questions

None — all design decisions finalized.
