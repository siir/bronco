# resolve-pr preferences — bronco

## Package Manager & Build

- Package manager: **pnpm**
- Typecheck command: `pnpm typecheck` (runs tsc across all packages via turbo)
- Install command: `pnpm install`
- ORM: Prisma — regenerate command: `pnpm db:generate` (run before typecheck whenever `schema.prisma` is modified)
- Lockfile: `pnpm-lock.yaml` — always include in commit when `package.json` is changed

## Docs to Check for Updates

When a PR changes code patterns, adds services, modifies config schemas, or adds new features, check these files for stale references and update them if needed:

- `CLAUDE.md` — project instructions (architecture, conventions, key files, env vars, new services)
- `README.md` — if present and relevant
- `TODO.md` — if present and relevant
- `docs/copilot-skills.md` — if skills or workflows are changed

If changes are significant enough to affect the architecture PowerPoint, update `scripts/generate-architecture-pptx.py` and regenerate `docs/bronco-architecture.pptx`.

## Branch Strategy

- Base branch for all feature PRs: **staging** (feature branches PR into staging; staging PRs into master)
- Protected branches (never push directly): `master`, `main`, `develop`, `release`, the repo's defaultBranch
- Every push to master auto-tags a semver release (`tag-release.yml`), which triggers `deploy-hugo` and conditionally `deploy-mcp` (only when MCP-relevant paths changed)

## Worktree Path

- Worktrees go in: `.claude/worktrees/pr-<PR>`
- GraphQL temp files go in: `usr/tmp/` inside the worktree (cleaned up on exit)

## Additional Notes

- ESM throughout — use `.js` extensions in relative TypeScript imports
- All enums use `const object + type` pattern (not TS enums)
- Prisma enum values must match shared-types enum values exactly
- If a migration file is new in this PR's diff, it has NOT been applied — fix it directly rather than deferring to an issue
