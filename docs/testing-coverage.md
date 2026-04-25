# Testing Coverage

Snapshot of what is and isn't covered by automated tests in the Bronco monorepo, plus what's planned next. Updated as part of the initial testing buildout (PR for `sess/testing-infrastructure`).

## How tests are organized

- **Unit tests** — `*.test.ts`, colocated with the source file. Run via `pnpm test`. Fast, no external dependencies, mock at the minimum interface.
- **Integration tests** — `*.integration.test.ts`. Run via `pnpm test:integration`. Require `TEST_DATABASE_URL` pointing at an empty Postgres. Locally, point at the round-claw container's `bronco_test` DB; CI uses a `postgres:17` service container.
- **Skip discipline** — integration tests are skipped (not failed) when `TEST_DATABASE_URL` is unset, so `pnpm test` is always runnable in any dev environment.

## Test infrastructure

| File / package | Purpose |
|---|---|
| `packages/test-utils/` | Shared test helpers — `getTestDb()`, `truncateAll()`, `applyMigrations()`, plus fixture factories for Client, Ticket, AiModelConfig, ClientMemory. Add new fixtures here when they're broadly useful. |
| `.github/workflows/ci.yml` | Postgres service + `prisma migrate deploy` + `pnpm test` + `pnpm test:integration` steps. |
| Per-package `vitest.config.ts` | Unit test config — excludes `**/*.integration.test.ts`. |
| Per-package `vitest.integration.config.ts` | Integration test config — only includes `**/*.integration.test.ts`, `pool: 'forks'`, `maxWorkers: 1`, 30s timeout. |

## Coverage at a glance

| Package / service | Unit | Integration | Notes |
|---|---:|---:|---|
| `@bronco/shared-utils` | 188 | — | knowledge-doc parse/compose/buildToc/readSection (full pure-function surface), logger, transient-error |
| `@bronco/test-utils` | — | 23 | Proof-of-life DB round-trip + kd_* writer concurrency / cap / invalid-key / addSubsection |
| `@bronco/ai-provider` | 51 | 20 | ModelConfigResolver layering + cache; ClientMemoryResolver TTL + filtering + isolation |
| `@bronco/ticket-analyzer` | 169 | 29 | analysis/shared.ts agentic-tool execution + retry-limiter; v2-knowledge-doc helpers; ingestion-engine + tracker |
| `@bronco/control-panel` | 15 | — | Pre-existing analysis-trace merge spec |

**Total: 423 unit + 72 integration = 495 tests.**

## What's tested

### Knowledge doc (load-bearing data contract)

- `parse / compose` round-trip across the 9-section template
- `splitIntoSections` — top-level + subsection parsing, slug dedup on parse (fix in this PR — see Code bugs found below)
- `readSection` — top-level slug, `parent.childSlug`, unknown-key handling
- `updateSection` — REPLACE / APPEND, 10k-char cap enforcement, invalid-key rejection, sidecar metadata maintained, all under `pg_advisory_xact_lock`
- `addSubsection` — permitted parents, INVALID_PARENT rejection on others, slug dedup with `-2` / `-3` suffix scheme
- `buildToc` — TOC shape + permissive sectionMeta handling (intentional)
- **Concurrency, real Postgres** — same-ticket same-section concurrent writes serialize cleanly (no torn writes); same-ticket different-section concurrent writes both land; cross-ticket writes don't block each other (lock is keyed per-ticket)

### AI provider resolvers

- **`ModelConfigResolver`** — CLIENT → APP_WIDE → default precedence verified for provider, model, and `maxTokens`; cache hit path issues a single DB query per (clientId, taskType) pair; unknown-task-type fallthrough to Sonnet documented
- **`ClientMemoryResolver`** — TTL cache invalidation, category filter (memories with `category: null` always pass; explicitly-categorized memories filter by ticketCategory), tag filtering OR-logic, per-client isolation, markdown composition shape

### Analysis pipeline primitives

- **`analysis/shared.ts`** — `parseSufficiencyEvaluation`, `executeAgenticToolCall` with mocked `callMcpToolViaSdk`, structured `_mcp_tool_error` envelope construction, error-class categorization (transient / rate_limit / not-retryable / repeated_failure), per-run retry-limiter (under-cap pass, at-cap reject, per-run isolation), input injection per tool name (`repoId` for per-repo tools, `clientId` for `list_repos`, `ticketId` for `kd_*` and `request_tool` and `read_tool_result_artifact`), filename sanitizer
- **`v2-knowledge-doc.ts`** — `composeFinalAnalysis` (Executive Summary + Problem Statement + Root Cause + Recommended Fix + Risks ordering, empty-section skipping, null-doc handling), `fallbackFillRequiredSections` (fills empty required sections, skips populated ones, includes the reason text), `writeKnowledgeDocSnapshot` (best-effort, swallows errors, payload shape), `writeStallMarker` (REPLACE when rootCause empty, APPEND when populated, includes iteration + reason)

### Ingestion pipeline

- **`createIngestionProcessor`** — RESOLVE_THREAD smoke + threading; CREATE_TICKET against real DB with per-client `ticketNumber` sequencing and requester linking; ADD_FOLLOWER row insertion; route resolution + dispatch
- **`IngestionRunTracker`** — `recordStep` row writes with status / timing / output; multi-step run linking via shared `ingestion_runs.id`; `markCompleted` / `markFailed` final state

## What's NOT tested

Tracked under issue **#432** (umbrella) — read that for the full list and pickup order. Highlights:

| Area | Why it's not covered yet |
|---|---|
| `flat-v2.ts` / `orchestrated-v2.ts` runners | Heavy AI mocking required — needs an Anthropic SDK fake at the minimum interface, plus seeded MCP tool registries |
| `analyzer.ts` (entry) | Subprocess + repo cloning (bare + worktree) make it integration-only |
| `client-learning-worker.ts`, `recommendation-executor.ts`, `probe-worker.ts` | Adjacent workers, AI-heavy, deferred for a focused pass |
| `AIRouter.generate()` / `generateWithTools()` orchestration | The resolvers are tested in isolation; the call-site wiring (auto-inject client memory, `skipClientMemory` flag) is not |
| `SUMMARIZE_EMAIL` / `DRAFT_RECEIPT` ingestion steps | One-line AI passthroughs — coverage requires SMTP mock + AIRouter mock for a thin payoff |
| `RESOLVE_THREAD` 7-day window + case-insensitive subject normalization | Basic threading covered, edge cases not |
| `maybeEnqueueReanalysis` loop prevention / dedupe / author gate | Lightly touched by threading test; needs dedicated coverage |
| `saveProbeArtifact` filesystem path | Untested |
| `CREATE_TICKET` ticketNumber retry-on-P2002 | The retry loop is intact but the conflict path isn't exercised |
| Most `services/copilot-api` REST routes | None of the API surface has tests yet |
| `mcp-servers/*` tool implementations | Tested indirectly through analyzer call sites; tool dispatch + auth not covered directly |

## Code bugs found and fixed during the buildout

These are real defects that were sitting latent because the code paths had never been exercised by a test:

1. **Duplicate Prisma migration** — `20260410020000_add_parent_log_pointers/migration.sql` was a straight duplicate of `20260409010000_add_parent_log_lineage` (same columns, same tables, same indexes, committed a day apart for #187). Every fresh DB (test, dev reset, new env) failed the second migration with `column "parent_log_id" of relation "ai_usage_logs" already exists`. Fixed with `IF NOT EXISTS` guards on all `ALTER TABLE`/`CREATE INDEX` statements in the second migration, following the existing hotfix pattern from commit `6673242`. Production unaffected — Prisma doesn't re-checksum already-applied migrations.

2. **Knowledge-doc subsection slug dedup on parse** — `addSubsection` correctly suffixes duplicate-title subsections (`-2`, `-3`), but `splitIntoSections` did not. After a compose → persist → parse cycle, two subsections with the same title (e.g. two `### Finding` under Evidence) both round-tripped to `evidence.finding` and the second became unreadable via `readSection` / `kd_read_section`. Fixed by mirroring the suffix loop in the parser. Caught by the kd_* concurrency integration test.

## Architectural findings (not bugs — flagged as issues for triage)

These are intended-or-unintended behaviors that the tests surfaced. They are NOT fixed in this PR — they're filed for review:

- **#430** — Ingestion engine silently skips `LOAD_CLIENT_CONTEXT` / `LOAD_ENVIRONMENT_CONTEXT` / `DISPATCH_TO_ROUTE` / `NOTIFY_OPERATOR`. These are documented step types but have no `case` in the engine's switch.
- **#431** — Zero-step ticket route silently falls through to the built-in default pipeline. A misconfigured route (all steps deactivated) is indistinguishable from "no route".

## What's coming next

Next testing pass (next PR) will tackle issue **#432** in priority order:

1. **`AIRouter` orchestration** — verify the auto-inject client-memory behavior and `skipClientMemory` flag at the call site.
2. **`flat-v2.ts` runner** — agentic loop with mocked Anthropic SDK; iteration cap, kd_* tool injection, fallback-fill ordering.
3. **`orchestrated-v2.ts` runner** — strategist dispatch loop, sub-task tool budget, stall-guard marker write.
4. **`maybeEnqueueReanalysis`** — author gate + in-flight dedupe.

Run `pnpm test` and `pnpm test:integration` before / after every change to keep the loop tight. CI will gate both on every push to `staging`.
