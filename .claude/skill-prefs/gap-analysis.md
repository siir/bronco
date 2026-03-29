# gap-analysis preferences — bronco

## Package Manager & Build

- Package manager: **pnpm**
- Typecheck command: `pnpm typecheck`
- Install command: `pnpm install` (required in worktrees before typechecking — node_modules are not shared)
- ORM: Prisma — regenerate command: `pnpm db:generate` (run before typecheck when `schema.prisma` is modified)

## ORM Migration Directory

- Migration path: `packages/db/prisma/migrations/`
- New migrations in the PR diff have NOT been applied to production — fix them directly
- Pre-existing migration files (NOT in the PR diff) have already been applied — do NOT create issues for findings in those files, note them as informational only

## Additional Analysis Focus Areas

Beyond the standard gap analysis checklist, also look for:
- Prisma schema enum values out of sync with shared-types enums (`packages/shared-types/src/`)
- Relative TypeScript imports missing `.js` extensions (ESM throughout)
- New services missing health endpoints, structured logging (`createLogger`), or Zod config validation
- New env vars without defaults in Zod config schema
- New Docker services not added to `docker-compose.yml` or `deploy-hugo.yml`
- `const object + type` enum pattern violations (no native TS enums)
