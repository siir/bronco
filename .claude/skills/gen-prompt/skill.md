---
name: gen-prompt
description: Generate a grounded remote coding session prompt from one or more GitHub issues. Triggers when the user wants to generate a prompt for a remote session — phrases like "generate a prompt for <issues>", "kick off a session for <issues>", "write up the prompt", "let's get a session going", or after a design discussion concludes with an explicit plan ready to execute.
argument-hint: <issue-numbers> [sonnet|opus|haiku]
user-invocable: true
allowed-tools: Bash(gh *), Bash(git *), Read, Grep, Glob, Agent, Write
---

# gen-prompt

Generate a grounded remote coding session prompt from one or more GitHub issues. The output is a single fenced code block the user can copy into a remote Claude Code session.

## Parse arguments

From `$ARGUMENTS` (or natural language context), extract:
- **Issue numbers** (required) — e.g., "203, 200" or "#203 and #200"
- **Model preference** (optional) — `sonnet`, `opus`, or `haiku`. If not provided, recommend based on complexity (see Model Selection).
- **Context flags** — if the user mentions "parallel sessions" or multiple batches, generate separate prompts.

If the issue numbers can't be determined from context, ask the user which issues.

## Workflow

### 1. Fetch issue details

For each issue number, run:

```
gh issue view <N> --json title,body,labels --repo <owner>/<repo>
```

Use the repo from git context (`git -C <repo> config --get remote.origin.url`).

### 2. Identify affected files

For each issue, parse the body for:
- **"Files affected" / "Key files" sections** — these typically list paths
- **Code snippets** — files referenced in example code
- **File paths mentioned inline** — `services/...`, `packages/...`

If the issue body doesn't list files clearly, grep for referenced symbols/function names in the codebase.

### 3. Read files for line numbers

For each affected file, read the relevant sections to get exact line numbers. NEVER guess line numbers.

For complex multi-issue workstreams (5+ issues OR 10+ files), dispatch parallel sub-agents — one per service/package — to explore concurrently. Give each agent:
- The issues it's responsible for
- The files in its scope
- Instructions to return file paths, line numbers, and current code patterns

### 4. Assemble the prompt

The entire prompt goes in a single fenced code block using **four backticks** as the outer fence (so any inner triple-backticks survive).

**Prompt structure:**

```
## <Title describing the work> — fixes #<issues>

Read `CLAUDE.md` before starting. Branch from staging. Use sub agents for independent workstreams. This is the full task — commit, push, and create a PR into staging when done.

---

### Issue #<N> — <short title>

<What's wrong, with file path and line number references>

**Fix:** <specific instructions with code snippets showing exact pattern>

---

<repeat for each issue>

---

### Verification

```
pnpm typecheck
pnpm build
```
```

**Conventions to enforce:**

- **No branch creation instructions** — let Claude Code manage the branch name
- **No `cd <repo> && git ...` patterns** — use `git -C "<path>"` in any git commands
- **Absolute paths double-quoted** — never backslash-escape spaces
- **Sub-agent guidance** — include "Use sub agents for independent workstreams" when the prompt covers 3+ distinct file clusters
- **Verification always** — every prompt ends with `pnpm typecheck` and `pnpm build`
- **Commit + push at end** — squash into single commit with `feat:` / `fix:` + `(fixes #N)` or `(refs #N)`, then `git push`, then `gh pr create --base staging`
- **Multi-prompt sessions** — if generating a sequence, state "This is prompt N of M" upfront and "continue on same branch" for subsequent prompts. Only the last prompt commits + pushes + creates the PR.

**Do NOT include:**
- Branch creation steps (no `git checkout -b ...`)
- `cd` + git chains
- Guessed line numbers

### 5. Output the prompt

Output the complete prompt in a single four-backtick code block. No preamble or explanation outside the code block — the user copies it as-is.

If generating multiple parallel prompts (e.g., backend batch + frontend batch), output each in its own code block with a brief header identifying the batch and recommended model.

## Model Selection

If the user didn't specify a model:

- **Opus** — auth changes, schema migrations, cross-cutting architecture, complex refactors, anything touching security or data integrity
- **Sonnet** — mechanical fixes (UI tweaks, single-file refactors, straightforward bug fixes, property binding changes)

State the recommendation at the top of the response (outside the code block).

## Anti-patterns to avoid

- **Don't create branches** — Claude Code manages branch naming. Specifying branch names has caused duplicate branches when prompts didn't align.
- **Don't push or create PRs** — that's the remote session's job, not the prompt-generator's.
- **Don't guess line numbers** — read the file first, every time.
- **Don't skip the verification steps** — every prompt ends with typecheck + build.
- **Don't combine unrelated work** — if the issues touch completely different file clusters, generate separate prompts for parallel sessions.

## Hand-off

After generating, suggest the next step:
- If one prompt: "Ready to paste into a remote session."
- If multiple parallel prompts: "These batches have zero file overlap — safe to run simultaneously."
- After the remote session completes, the user should return with `review <branch-name>` to trigger `review-branch`.
