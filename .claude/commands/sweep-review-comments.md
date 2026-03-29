---
description: Sweep merged PRs for unresolved review comments — triage, create issues, resolve threads
allowed-tools: Bash(gh *), Bash(cat *), Bash(git *), Bash(node *), Read, Glob, Grep, Agent
---

## Your task

Scan all merged PRs since the last sweep for unresolved review comments. For each unresolved thread, check if the issue is still present in the codebase, create GitHub issues for relevant ones, resolve all threads, and update the high-water mark.

## Shell command rules (CRITICAL)

- **NEVER** use pipes (`|`), `&&` chains, or command substitution in shell commands.
- Use separate Bash tool calls for each command.
- Use `--jq` flags on `gh` commands instead of piping to `jq`.
- Write GraphQL queries and issue bodies to temp files — do NOT inline them.
- Do NOT prompt the user for approval on individual `gh` read commands — these are all read-only.

## Workflow

### Step 1 — Read high-water mark

Read the state file at `.claude/state/sweep-review-comments.json` (relative to the repo root). Parse the JSON and extract `lastReviewedPrNumber`. If the file does not exist, treat it as 0 (full scan).

**State file path:** `.claude/state/sweep-review-comments.json`

```json
{
  "lastReviewedPrNumber": 166,
  "lastSweepDate": "2026-03-02"
}
```

### Step 2 — Fetch merged PRs since last sweep

```
gh pr list --state merged --limit 200 --json number,title --jq '[.[] | select(.number > LAST_NUMBER)] | sort_by(.number)'
```

Replace `LAST_NUMBER` with the high-water mark from step 1.

- If no new PRs are found, report **"No new merged PRs since last sweep (last reviewed: #N)"** and stop.
- Record the list of PR numbers to scan.

### Step 3 — Batch-query unresolved threads via GraphQL

Group the PRs into batches of up to 10. For each batch, write a GraphQL query to a temp file and execute it.

**Query template** (write to `/tmp/sweep-graphql.txt`):

```graphql
{
  repository(owner: "siir", name: "bronco") {
    pr1: pullRequest(number: 101) {
      number
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          comments(first: 10) {
            nodes {
              body
              author { login }
            }
          }
        }
      }
    }
    pr2: pullRequest(number: 102) {
      ...same shape...
    }
  }
}
```

Use aliases `pr1`, `pr2`, ..., `pr10` for each PR in the batch. Execute:

```
gh api graphql -f query=@/tmp/sweep-graphql.txt
```

Parse the response. Collect all unresolved threads (where `isResolved == false`) across all PRs, along with their thread `id`, `path`, and comment bodies.

- If zero unresolved threads are found across all PRs, update the high-water mark (skip to step 7) and report that no action was needed.

### Step 4 — Check relevance against current codebase

For each unresolved thread, check whether the issue described in the comment is still present in the current codebase:

- Read the file at the `path` referenced by the thread.
- If the file no longer exists, mark as **NOT relevant** (code was removed/moved).
- If the file exists, analyze whether the specific concern raised in the comment still applies to the current code.

Use Agent(s) (subagent_type: `general-purpose`) to parallelize this work when there are more than 3 threads to check. Each agent should return: `PR #N | path | relevant (yes/no) | one-line summary`.

Classify each thread as:
- **RELEVANT** — the issue described in the comment still exists in the code
- **NOT_RELEVANT** — the code has changed, the file is gone, or the concern was already addressed

### Step 5 — Create issues for relevant comments

For threads marked RELEVANT:

1. Ensure the `review-followup` label exists:
   ```
   gh label create "review-followup" --color "e4e669" --description "Unresolved PR review comment tracked as issue" --force
   ```

2. Group all relevant threads from the same PR into a single issue.

3. For each issue to create:
   - **Title:** `[PR #N] Unresolved review: <short summary>`
   - **Body:** Write to `/tmp/sweep-issue-body.md`, then use `--body-file`:
     ```markdown
     ## Unresolved review comments from PR #N

     ### `path/to/file.ts`
     > Original comment by @author:
     > comment body here

     **Status:** Still present in codebase as of this sweep.

     ---
     Source PR: https://github.com/siir/bronco/pull/N
     ```
   - **Label:** `review-followup`
   - **Command:** `gh issue create --title "..." --body-file /tmp/sweep-issue-body.md --label "review-followup"`

4. Track all created issue numbers for the summary.

### Step 6 — Resolve all unresolved threads

Resolve **every** unresolved thread found in step 3 — both RELEVANT (now tracked as issues) and NOT_RELEVANT (no longer applicable).

For each thread, write the mutation to a temp file and execute:

```graphql
mutation {
  resolveReviewThread(input: { threadId: "THREAD_NODE_ID" }) {
    thread { isResolved }
  }
}
```

```
gh api graphql -f query=@/tmp/sweep-resolve.txt
```

Process threads one at a time to avoid rate limits. If a resolve fails, log the error and continue with the next thread.

### Step 7 — Update high-water mark and commit

Write the updated state to `.claude/state/sweep-review-comments.json`:

```json
{
  "lastReviewedPrNumber": <highest PR number processed>,
  "lastSweepDate": "<today's date YYYY-MM-DD>"
}
```

Then commit the updated state file:

```
git add .claude/state/sweep-review-comments.json
git commit -m "chore: update sweep-review-comments high-water mark to PR #N"
git push
```

### Step 8 — Report results

Print a summary:

```
## Sweep Review Comments — Results

| Metric | Value |
|--------|-------|
| PRs scanned | N |
| Unresolved threads found | N |
| Still relevant | N |
| Not relevant | N |
| Issues created | N |
| Threads resolved | N |

### Issues Created
- #123: [PR #150] Unresolved review: missing validation
- #124: [PR #155] Unresolved review: error handling gap

### Threads Resolved
- PR #150: 2 threads
- PR #155: 1 thread
```

If no unresolved threads were found, just report the PRs scanned count and that everything is clean.
