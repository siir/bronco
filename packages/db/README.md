# @bronco/db

Prisma ORM package for the control plane PostgreSQL database. Defines the schema for all core entities and provides a singleton PrismaClient.

## Models (27)

| Model | Description |
|-------|-------------|
| **User** | Application users with role-based access. |
| **Client** | DBA clients (companies). Has `shortCode` for quick reference. |
| **Contact** | People at client organizations. Linked to clients, can be ticket requesters. |
| **Repository** | Legacy repository model. |
| **System** | Client database instances (SQL Server, Postgres, MySQL). Stores encrypted connection details consumed by the MCP Database Server at runtime. |
| **Ticket** | Work items. Created from emails, manual entry, DevOps, or AI detection. Linked to a client and optionally a system. |
| **TicketEvent** | Timeline entries on a ticket: comments, status changes, inbound/outbound emails, AI analysis results, DevOps sync, code changes. |
| **DevOpsSyncState** | Tracks Azure DevOps work item sync state and conversational workflow state. |
| **Artifact** | File metadata for stored artifacts (query plans, deadlock XML, scripts). Files live on QNAP; metadata in Postgres. |
| **Finding** | DBA findings (performance issues, missing indexes, blocking patterns). Linked to a system. |
| **Playbook** | Runbooks for addressing findings. Can be templates or linked to specific findings. |
| **QueryAuditLog** | Audit trail of every query the MCP Database Server executes against client SQL Servers. |
| **CodeRepo** | Git repositories registered for automated issue resolution. |
| **IssueJob** | Issue resolution job tracking (status, branch, commit SHA). |
| **ExternalService** | External service definitions for health monitoring. |
| **ClientIntegration** | Per-client integration configurations (IMAP, Azure DevOps). |
| **AppLog** | Application-level structured logs. |
| **LogSummary** | AI-generated log summaries. |
| **AiUsageLog** | AI provider usage tracking (tokens, duration, cost). |
| **AiModelCost** | Per-model cost configuration (input/output token pricing). |
| **AiProviderConfig** | DB-managed AI provider configurations (model, capability level). |
| **AiModelConfig** | Per-task-type AI model overrides (APP_WIDE or CLIENT scoped). |
| **PromptOverride** | System prompt overrides (prepend/append, per-client). |
| **PromptKeyword** | Keyword-based prompt routing rules. |
| **GoogleAccount** | Google OAuth2 account credentials (encrypted tokens). |
| **YoutubeScheduleJob** | YouTube broadcast scheduling job configuration. |
| **YoutubeBroadcastLog** | YouTube broadcast execution history. |

## Enums (19)

`LogLevel`, `DbEngine`, `AuthMethod`, `Environment`, `TicketStatus`, `Priority`, `TicketSource`, `TicketEventType`, `Severity`, `TicketCategory`, `FindingStatus`, `IssueJobStatus`, `IntegrationType`, `UserRole`, `OverrideScope`, `OverridePosition`, `LogSummaryType`, `BroadcastStatus`, `ExternalServiceCheckType`

## Usage

```typescript
import { getDb, disconnectDb } from '@bronco/db';

const db = getDb(); // Singleton PrismaClient

const clients = await db.client.findMany();

// On shutdown
await disconnectDb();
```

## Commands

Run from monorepo root:

```bash
pnpm db:generate    # Regenerate Prisma client after schema changes
pnpm db:migrate     # Create and apply migrations (dev)
pnpm db:seed        # Seed development data
```

Or from this package:

```bash
npx prisma migrate dev       # Interactive migration (dev)
npx prisma migrate deploy    # Apply pending migrations (production)
npx prisma studio            # Open Prisma Studio GUI
```

## The `System` Model

This model is the bridge between the copilot platform and the MCP Database Server. It stores everything needed to connect to a client SQL Server:

- `host`, `port`, `instanceName` -- Network location
- `authMethod` -- SQL Auth, Windows Auth, or Azure AD
- `username`, `encryptedPassword` -- Credentials (password is AES-256-GCM encrypted)
- `useTls`, `trustServerCert` -- TLS settings
- `connectionTimeout`, `requestTimeout`, `maxPoolSize` -- Pool tuning
- `environment` -- Production, Staging, Development, DR

When the MCP Database Server receives a tool call with a `systemId`, it queries this table, decrypts the password, and creates a connection pool.

## Source Layout

```
prisma/
├── schema.prisma    # Full Prisma schema (27 models, 19 enums)
└── seed.ts          # Development seed data
src/
├── client.ts        # Singleton PrismaClient factory
└── index.ts         # Re-exports PrismaClient + helpers
```
