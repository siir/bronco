---
argument-hint: <pr-number>
description: Review code changes in a PR — analyze commits, post review, optionally implement fixes on the parent branch
allowed-tools: Bash(gh *), Bash(git *), Bash(cd *), Bash(npx tsc *), Bash(pnpm *), Bash(mkdir *), Bash(for *), Read, Edit, Write, Glob, Grep, Task
---

## Your task

Review the committed code changes in PR #$ARGUMENTS. You are the reviewer — analyze the code, find issues, and post a formal review.

## Shell command rules (CRITICAL)

- **NEVER** use pipes (`|`), `&&` chains, or command substitution in shell commands.
- Use separate Bash tool calls for each command. Use `--jq` flags on `gh` commands instead of piping to `jq`.
- Pass `--body` content inline or via heredoc (`$(cat <<'EOF' ... EOF)`) — never via echo/pipe.

## Workflow

1. **Fetch PR details:**
   - `gh pr view $ARGUMENTS --json title,body,state,headRefName,baseRefName,isDraft,commits,files,additions,deletions`
   - `gh pr diff $ARGUMENTS` to see the full diff
   - Note whether this is a draft PR

2. **Understand context:**
   - Read the PR description to understand intent
   - Read the full diff carefully
   - Check out the **base branch** (not the PR branch) to read surrounding code for context
   - For each changed file, read the current version on the base branch to understand what the diff is modifying

3. **Review the changes for:**
   - **Correctness**: Does the code do what the PR description claims?
   - **Bugs**: Off-by-one errors, null checks, race conditions, type mismatches
   - **Security**: Injection, unsafe input handling, leaked secrets, missing auth checks
   - **Style**: Does it follow project conventions (see CLAUDE.md)?
   - **Edge cases**: What happens with empty inputs, boundary values, concurrent access?
   - **Stale base**: Is the PR based on an outdated version of the base branch? Will it conflict?
   - **Completeness**: Are there missing tests, missing error handling, incomplete implementations?
   - **Over-engineering**: Is the solution more complex than necessary?

4. **Post a review on the PR:**
   Use `gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews` with one of:
   - `-f event="APPROVE"` — if the code looks good
   - `-f event="REQUEST_CHANGES"` — if there are issues that must be fixed
   - `-f event="COMMENT"` — if there are observations but no blocking issues

   Include a structured body with:
   - Summary of what the PR does
   - Issues found (numbered, with severity)
   - Whether you'll implement fixes on the parent branch or leave for the author

5. **Decide on next steps** — ask the user:
   - **Implement on parent**: If the change is small and correct (or easily fixable), implement it directly on the parent branch with improvements, then close the draft PR.
   - **Request changes**: If the issues are significant, leave the review and let the author fix.
   - **Approve**: If the code is good, approve and optionally mark ready for review.

6. **If implementing on parent branch:**
   - Check out the parent branch
   - Apply the changes with any fixes/improvements
   - Typecheck: `npx tsc --noEmit` on affected packages
   - Commit with a message that references the PR
   - Push to the parent branch
   - Close the PR with a comment explaining it was superseded

## Important notes

- This is a REVIEW workflow. You are the reviewer, not the fixee.
- If you need to address existing review comments instead, use `/resolve-pr`.
- Be constructive but direct. Flag real issues, don't nitpick style on generated code.
- Always check if the PR's base branch has moved ahead (stale base = merge conflicts).
- For draft PRs from Copilot, the code is often close but may have subtle issues.
- Use task tracking (TaskCreate/TaskUpdate) if the review surfaces 4+ issues.
