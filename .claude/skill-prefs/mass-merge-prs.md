# mass-merge-prs preferences — bronco

## Target Branch

- PRs merge INTO: **staging**
- Branch flow: `feature branch → staging → master → auto-tag → deploy`

## Merge Strategy

- When target is **staging**: `--squash` (clean single-commit history on staging)
- When target is **master**: `--merge` (preserve full commit history for release tags)
- Delete branch after merge: yes (`--delete-branch`)

## Deploy Pipeline (informational — no action needed from this skill)

Deploys are NOT triggered by merges to staging. They trigger automatically when staging is merged to master:
1. `tag-release.yml` pushes a semver tag
2. Tag triggers `deploy-hugo` (GHCR + SSH via Tailscale to Hugo VM)
3. Tag conditionally triggers `deploy-mcp` (ZIP deploy to Azure App Service — only when MCP-relevant paths changed)

Include this in the summary reminder so the user knows to merge staging → master when ready to deploy.

## Review-Followup Label

- Label name: `review-followup`
- Color: `e4e669`
- Description: `Unresolved PR review comment tracked as issue`
