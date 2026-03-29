---
argument-hint: [sonnet|opus|haiku] [--script]
description: Triage open GitHub issues — prioritize, batch, then generate detailed remote session prompts on demand
allowed-tools: Bash(gh *), Bash(cd *), Bash(chmod *), Read, Glob, Grep, Write, Edit, Agent
---

## Model selection

This skill defaults to **Sonnet** for cost-efficient triage.

Parse `$ARGUMENTS` for a model name: `sonnet`, `opus`, or `haiku` (case-insensitive). If present, use that model for the entire session — skip auto-escalation.

Also parse `$ARGUMENTS` for the flag `--script` (case-insensitive). If present, use **Script mode** instead of the default interactive mode. See the "Script mode" section at the end.

- **Tell the user**: "Using <model> for issue triage." (If `--script`: also say "Script mode — will write overnight batch script.")
- All Agent tool calls MUST use `model: "<model>"`.

If no model name is specified, default to Sonnet and auto-escalate to Opus if the repo has more than 30 open issues or issues require deep architectural analysis to categorize.
- **Tell the user**: "Escalating to Opus for deep analysis."
- Use `model: "opus"` for Agent tool calls for the remainder of the skill.

At the end of the skill, **tell the user**: "Done. Switching back to default model."

## Your task

Triage all open GitHub issues in this repository. Categorize, prioritize, and present batches.

- **Default (interactive) mode**: Present a menu, user picks batches, generate detailed prompts on demand.
- **Script mode (`--script`)**: Generate simple `claude --remote` commands for all batches and write them to `usr/overnight-batches.sh`.

## Shell command rules (CRITICAL — violations cause permission prompts)

These rules exist so the permission auto-approve system works smoothly. Breaking ANY of them forces manual approval on every command, which defeats automation.

- **NEVER** use pipes (`|`), `&&` chains, `||`, or command substitution (`$(...)`) in shell commands.
- **NEVER** use `for`/`do`/`done` loops — run each command as a **separate** Bash tool call.
- **NEVER** prefix commands with `cd` — the working directory persists between Bash calls. Run `cd` as its own separate call if needed.
- Use `--jq` flags on `gh` commands instead of piping to `jq`.
- For `gh issue create`, `gh pr comment`, or any command with markdown / multi-line body content: **write the body to a temp file** with the Write tool, then use `--body-file /tmp/<name>.md`. Never pass multi-line markdown inline via `--body`.
- For `gh api graphql` commands: **write the GraphQL query to a temp file** with the Write tool, then use `-f query=@/tmp/<name>.graphql`. Never inline complex GraphQL queries.
- Simple single-line string arguments can be passed inline.

## Workflow

### Phase 1: Triage

1. **Fetch all open issues:**
   - `gh issue list --state open --json number,title,labels,createdAt,assignees,milestone --limit 100`

2. **Fetch details on each issue:**
   - Use `gh issue view <number> --json title,body` to get the full body for every issue.
   - Run these in parallel where possible (separate Bash tool calls in one message).
   - If there are more than 50 open issues, skip detail fetch for issues whose title is already clear enough to categorize.

3. **Categorize each issue** into one of these groups:
   - **Security / Data Protection** — authentication, encryption, secrets, access control
   - **Bugs / Correctness** — broken behavior, incorrect output, threading issues, misleading config
   - **Resilience / Robustness** — error handling, retries, race conditions, state machine hardening
   - **Technical Debt / Improvements** — cleanup, validation, new endpoints, CI/CD, architecture enhancements
   - **Low Priority / Deferred** — theoretical concerns, small repos not hitting limits, nice-to-haves

4. **Assign priority** (P1 highest → P5 lowest) based on:
   - P1: Security gaps, data exposure, unauthenticated endpoints
   - P2: Bugs with visible user impact, broken functionality, deprecated APIs that will stop working
   - P3: Resilience issues — race conditions, unhandled errors, silent failures
   - P4: Code quality, validation improvements, new features, CI hardening
   - P5: Theoretical concerns not hitting current scale, nice-to-haves, duplicates

5. **Identify duplicates or overlapping issues** — note when multiple issues cover the same topic and suggest which to close or merge.

### Phase 2: Batch and present menu

6. **Group issues into fix batches:**
   - Examine each issue's affected area (service, package, file paths, subsystem).
   - Cluster issues that touch the same code area or have logical dependencies.
   - A batch can contain a single issue if it's unrelated to others.
   - Do NOT group unrelated issues just to reduce batch count.

7. **Present the batch menu** as a numbered table, ranked by importance:

   ```
   | # | Batch | Issues | Complexity | Area | Summary |
   |---|-------|--------|------------|------|---------|
   | 1 | API input validation | #12, #15, #18 | medium | copilot-api | Add Zod validation to 3 POST routes |
   | 2 | DevOps worker resilience | #7, #22 | small | devops-worker | Retry logic + error handling |
   | 3 | Logger unification | #421 | large | shared-utils, all services | Tee Pino errors to app_logs |
   ```

   - **Complexity**: `small` (< 30 min), `medium` (30 min–2 hrs), `large` (2+ hrs)
   - **Summary**: One sentence describing what the remote session will do

8. **Ask the user to pick batches:**

   > "Pick 2-3 batches by number and I'll generate detailed prompts for remote sessions."

   Then **stop and wait** for the user's selection.

### Phase 3: Generate prompts (repeatable)

For each batch the user selected:

9. **Read relevant source code** to build context:
   - Use Glob/Grep/Read to find the files each issue references or implies.
   - Identify existing patterns, interfaces, and conventions the remote session needs to follow.
   - Note any dependencies between the issues in the batch.
   - Check for related open PRs that might conflict.

10. **Generate a detailed prompt** for each selected batch. The prompt must include:

    **Structure:**
    ```
    ## Context
    [What the issue(s) are about, why they matter, any related work]

    ## Issues
    [For each issue: number, title, full description, and what specifically needs to change]

    ## Key Files
    [Exact file paths with line numbers and brief descriptions of what each file does.
     Include files to modify AND files to reference for patterns.]

    ## Implementation Guide
    [Step-by-step instructions: what to create/modify, code patterns to follow,
     edge cases to handle. Include actual code snippets from the repo where
     the session needs to match existing patterns.]

    ## Constraints
    - Branch from `staging` (create branch: `fix/<number>-<slug>` or `feat/<number>-<slug>`)
    - Follow all conventions in CLAUDE.md
    - Every commit message MUST include `fixes #<number>` for auto-close
    - Do NOT create pull requests — just commit and push the branch
    - Run `pnpm typecheck` and `pnpm build` before pushing
    - If any `package.json` changes, run `pnpm install` and include `pnpm-lock.yaml`

    ## Testing
    [How to verify the fix works — typecheck, build, specific things to check]
    ```

    **Quality bar:** The prompt should give the remote session everything it needs to succeed without reading the full codebase. Include actual code snippets where the session needs to match patterns. Reference specific line numbers. Be explicit about what NOT to do if there are common pitfalls.

11. **Present each prompt inline** in the conversation so the user can copy it directly. This is the primary delivery method — the user copies from the terminal into their remote session launcher.

    **CRITICAL formatting rule:** Prompts contain code snippets with triple backticks that will break a standard fenced code block. Always wrap the prompt in a fence using **4+ backticks** (e.g., ``````````) so that inner ``` blocks render correctly and don't close the outer fence.

    Only fall back to writing a file (`usr/prompts/batch-<N>-<slug>.md`) if the user explicitly asks for file output.

12. **Re-present the remaining batches** that weren't selected:

    > "Remaining batches:"
    > [Updated table with only unselected batches, same format as step 7]
    > "Pick more batches, or we're done."

    Then **stop and wait**. If the user picks more, repeat from step 9. If they say done, end the skill.

## Prompt generation guidelines

- **Be specific, not generic.** "Add Zod validation to the `POST /api/tickets` route in `services/copilot-api/src/routes/tickets.ts`" is good. "Add input validation" is not.
- **Show, don't tell.** Include actual code from the repo as examples of the pattern to follow. If there's a similar endpoint already validated, show it.
- **Scope tightly.** Each prompt should be completable in one remote session. If a batch is too large, split it and note the dependency.
- **Flag dependencies.** If batch 2 depends on batch 1 being merged first, say so explicitly in the prompt.
- **Include the why.** Remote sessions work better when they understand the motivation, not just the mechanics.

## Script mode (`--script`)

**Skip this entire section unless `--script` was passed.** When `--script` is set, skip Phase 3 entirely and replace it with this:

After presenting the batch table (Phase 2, step 7), generate `claude --remote` commands and write them to a script.

### Script generation

For each batch, output a command like:

```bash
claude --remote "Fix the following GitHub issues in the siir/bronco repo. Follow the 'Overnight Issue Resolution Workflow' instructions in CLAUDE.md exactly. Issues to fix: #12 (title), #15 (title), #18 (title). These all relate to API input validation in copilot-api. CRITICAL: Every commit message MUST use 'fixes #N' to auto-close the issue when merged (e.g., 'fix: description (fixes #12)'). Do NOT create pull requests — remote sessions cannot create PRs. Just commit and push to the feature branch."
```

Rules for the suggested commands:
- Include all issue numbers and short titles in the prompt.
- Mention the batch theme / affected area so the session has context.
- Reference the "Overnight Issue Resolution Workflow" section in CLAUDE.md.
- One command per batch.
- **Always include this reminder in every command:** "CRITICAL: Every commit message MUST use 'fixes #N' to auto-close the issue when merged to master (e.g., 'fix: description (fixes #12)'). Do NOT create pull requests — remote sessions cannot create PRs. Just commit and push to the feature branch."

### Write overnight batch script (REQUIRED in script mode)

Write the batch commands to a shell script file:

- Overwrite the existing file at `usr/overnight-batches.sh` in the repo root.
- Format: bash script with `#!/usr/bin/env bash` and `set -euo pipefail`. Do NOT comment out the commands — they should be ready to run as-is.
- Each batch is a `claude --remote "..."` command followed by `&` (for background execution).
- Include a header comment with the generation date.
- End with `echo` status line and `wait`.
- Use the full absolute path when writing and chmod (the working directory has spaces): `"/Users/chad/Source Code/siir/bronco/usr/overnight-batches.sh"`
- After writing the file, run `chmod +x "/Users/chad/Source Code/siir/bronco/usr/overnight-batches.sh"` to make it executable.
- Then tell the user: **"Overnight batch script written to `usr/overnight-batches.sh`. Review the batches, then launch with:**
  ```
  "/Users/chad/Source Code/siir/bronco/usr/overnight-batches.sh"
  ```
  **"**
