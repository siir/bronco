# @bronco/shared-types

Pure TypeScript interfaces and const enums shared across all packages and services in the monorepo. Zero runtime dependencies — this package only produces type declarations.

## Usage

```typescript
import {
  // Interfaces
  type Client, type Contact,
  type System, type SystemConnectionConfig,
  type Ticket, type TicketEvent,
  type Artifact, type Finding, type Playbook,
  type AIRequest, type AIResponse,

  // Const enums (also usable as types)
  DbEngine, AuthMethod, Environment,
  TicketStatus, Priority, TicketSource, TicketCategory, TicketEventType,
  Severity, FindingStatus,
  TaskType, AIProvider,
} from '@bronco/shared-types';
```

## Modules

### `client.ts` — Client & Contact

| Interface | Key Fields |
|-----------|-----------|
| `Client` | `id`, `name`, `shortCode` (unique), `isActive`, `notes` |
| `Contact` | `id`, `clientId`, `name`, `email`, `phone`, `role`, `isPrimary` |

### `system.ts` — Database Systems

| Export | Type | Values |
|--------|------|--------|
| `DbEngine` | const enum | `MSSQL`, `AZURE_SQL_MI`, `POSTGRESQL`, `MYSQL` |
| `AuthMethod` | const enum | `SQL_AUTH`, `WINDOWS_AUTH`, `AZURE_AD` |
| `Environment` | const enum | `PRODUCTION`, `STAGING`, `DEVELOPMENT`, `DR` |

| Interface | Description |
|-----------|-------------|
| `System` | Full system record including `encryptedPassword`, `connectionString`, and metadata timestamps |
| `SystemConnectionConfig` | Runtime connection config with decrypted `password` field, `connectionString` (no timestamps) |

### `ticket.ts` — Tickets & Events

| Export | Type | Values |
|--------|------|--------|
| `TicketStatus` | const enum | `OPEN`, `IN_PROGRESS`, `WAITING`, `RESOLVED`, `CLOSED` |
| `Priority` | const enum | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `TicketSource` | const enum | `MANUAL`, `EMAIL`, `AZURE_DEVOPS`, `AI_DETECTED`, `SCHEDULED` |
| `TicketCategory` | const enum | `DATABASE_PERF`, `BUG_FIX`, `FEATURE_REQUEST`, `SCHEMA_CHANGE`, `CODE_REVIEW`, `ARCHITECTURE`, `GENERAL` |
| `TicketEventType` | const enum | `COMMENT`, `STATUS_CHANGE`, `PRIORITY_CHANGE`, `CATEGORY_CHANGE`, `ASSIGNMENT`, `AI_ANALYSIS`, `AI_RECOMMENDATION`, `EMAIL_INBOUND`, `EMAIL_OUTBOUND`, `DEVOPS_INBOUND`, `DEVOPS_OUTBOUND`, `PLAN_PROPOSED`, `PLAN_APPROVED`, `PLAN_REJECTED`, `PLAN_EXECUTING`, `PLAN_COMPLETED`, `ARTIFACT_ADDED`, `SYSTEM_NOTE`, `CODE_CHANGE` |

| Interface | Key Fields |
|-----------|-----------|
| `Ticket` | `id`, `clientId`, `systemId?`, `requesterId?`, `subject`, `status`, `priority`, `source`, `category?`, `externalRef?` |
| `TicketEvent` | `id`, `ticketId`, `eventType`, `content`, `metadata` (JSON), `actor` |

### `artifact.ts` — Artifacts, Findings & Playbooks

| Export | Type | Values |
|--------|------|--------|
| `Severity` | const enum | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `FindingStatus` | const enum | `OPEN`, `ACKNOWLEDGED`, `IN_PROGRESS`, `RESOLVED`, `WONT_FIX` |

| Interface | Key Fields |
|-----------|-----------|
| `Artifact` | `id`, `ticketId?`, `findingId?`, `filename`, `mimeType`, `sizeBytes`, `storagePath` |
| `Finding` | `id`, `systemId`, `title`, `severity`, `category`, `description`, `recommendation`, `sqlEvidence`, `status` |
| `Playbook` | `id`, `findingId?`, `title`, `category`, `content` (markdown), `isTemplate` |

### `ai.ts` — AI Task Types & Interfaces

| Export | Type | Values |
|--------|------|--------|
| `TaskType` | const enum | `TRIAGE`, `CATEGORIZE`, `SUMMARIZE`, `DRAFT_EMAIL`, `EXTRACT_FACTS`, `SUMMARIZE_TICKET`, `SUGGEST_NEXT_STEPS`, `CLASSIFY_INTENT`, `SUMMARIZE_LOGS`, `ANALYZE_WORK_ITEM`, `DRAFT_COMMENT`, `GENERATE_PLAN`, `ANALYZE_QUERY`, `GENERATE_SQL`, `REVIEW_CODE`, `DEEP_ANALYSIS`, `BUG_ANALYSIS`, `ARCHITECTURE_REVIEW`, `SCHEMA_REVIEW`, `FEATURE_ANALYSIS`, `RESOLVE_ISSUE`, `CHANGE_CODEBASE_SMALL`, `CHANGE_CODEBASE_LARGE` |
| `AIProvider` | const enum | `LOCAL`, `CLAUDE` |

| Interface | Key Fields |
|-----------|-----------|
| `AIRequest` | `taskType`, `prompt`, `context?`, `promptKey?`, `systemPrompt?`, `maxTokens?`, `temperature?` |
| `AIResponse` | `provider`, `content`, `model`, `usage?` (`{ inputTokens, outputTokens }`), `durationMs` |
| `AiModelConfigRecord` | `id`, `taskType`, `scope`, `clientId?`, `provider`, `model`, `isActive` |
| `TaskTypeDefault` | `taskType`, `provider`, `model` |
| `AiProviderConfigRecord` | `id`, `name`, `provider`, `baseUrl?`, `model`, `capabilityLevel`, `isActive`, `hasApiKey` |

## Source Layout

```
src/
├── index.ts              # Barrel re-export of all modules
├── client.ts             # Client, Contact
├── system.ts             # DbEngine, AuthMethod, Environment, System, SystemConnectionConfig
├── ticket.ts             # TicketStatus, Priority, TicketSource, TicketCategory, TicketEventType, Ticket, TicketEvent
├── artifact.ts           # Severity, FindingStatus, Artifact, Finding, Playbook
├── ai.ts                 # TaskType, AIProvider, CapabilityLevel, AIRequest, AIResponse, AiModelConfigRecord, AiProviderConfigRecord
├── ai-usage.ts           # AI usage logging types
├── code-repo.ts          # CodeRepo, IssueJob types
├── devops.ts             # DevOps sync and work item types
├── external-service.ts   # External service monitoring types
├── integration.ts        # Client integration types
├── log.ts                # Application log types
├── prompt.ts             # Prompt override types
├── user.ts               # User and role types
├── workflow.ts           # Workflow state types
└── youtube.ts            # YouTube account, job, broadcast types
```

## Design Notes

- **Const enum pattern** — All enums use the `as const` + type extraction pattern instead of TypeScript `enum`. This avoids runtime enum objects while preserving type safety and tree-shaking.
- **No runtime dependencies** — This package has zero `dependencies`. Only `typescript` as a dev dependency.
- **Interface vs. Prisma types** — These interfaces mirror the Prisma schema but are decoupled from it. Services that don't use Prisma directly (like the MCP server) can still consume these types without pulling in `@prisma/client`.
