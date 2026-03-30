# @bronco/db

Prisma ORM package for the control plane PostgreSQL database. Defines the schema for all core entities and provides a singleton PrismaClient.

## Models

The schema defines 50+ models. Key models include:

| Model | Description |
|-------|-------------|
| **User** | Application users with role-based access. |
| **Operator** | System operators with notification preferences (multi-operator support). |
| **Client** | DBA clients (companies). Has `shortCode` for quick reference. |
| **ClientEnvironment** | Per-client environment configurations. |
| **ClientUser** | Portal users scoped to a client. |
| **Contact** | People at client organizations. Linked to clients, can be ticket requesters. |
| **System** | Client database instances. Stores encrypted connection details for the MCP server. |
| **Ticket** | Work items with sufficiency tracking and operator assignment. |
| **TicketEvent** | Timeline entries: comments, status changes, emails, AI analysis, code changes, plan events. |
| **TicketRoute** / **TicketRouteStep** | Configurable analysis pipelines with ordered steps. |
| **TicketFollower** | Contacts following a ticket (requester, CC). |
| **DevOpsSyncState** | Azure DevOps work item sync state and workflow state. |
| **Artifact** | File metadata for stored artifacts. |
| **Finding** / **Playbook** | DBA findings and runbooks. |
| **CodeRepo** | Git repositories for automated issue resolution. |
| **IssueJob** | Resolution job tracking with plan, approval, and execution state. |
| **ClientIntegration** | Per-client integration configurations (IMAP, Azure DevOps). |
| **ClientMemory** | Per-client AI memories (MANUAL or AI_LEARNED). |
| **ScheduledProbe** / **ProbeRun** | Scheduled monitoring probes and execution history. |
| **IngestionRun** / **IngestionRunStep** | Ingestion pipeline execution tracking. |
| **AiProvider** / **AiProviderModel** | AI provider configs with per-model capabilities. |
| **AiModelConfig** | Per-task-type AI model overrides (APP_WIDE or CLIENT scoped). |
| **EmailProcessingLog** | Email processing audit trail. |
| **ReleaseNote** | Auto-generated release notes from commits. |
| **AppLog** / **LogSummary** | Application logs and AI summaries. |
| **AiUsageLog** / **AiModelCost** | AI usage tracking and cost configuration. |

## Enums (30+)

`LogLevel`, `DbEngine`, `AuthMethod`, `Environment`, `TicketStatus`, `Priority`, `TicketSource`, `TicketEventType`, `Severity`, `TicketCategory`, `FindingStatus`, `IssueJobStatus`, `IntegrationType`, `UserRole`, `OverrideScope`, `OverridePosition`, `LogSummaryType`, `ExternalServiceCheckType`, `SufficiencyStatus`, `RouteStepType`, `RouteType`, `FollowerType`, `AnalysisStatus`, `MemoryType`, `MemorySource`, `ClientUserType`, `AttentionLevel`, `ReleaseNoteType`, `NotificationChannelType`, `OperationalTaskStatus`, `OperationalTaskSource`, `OperationalTaskEventType`, `SystemAnalysisStatus`

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
├── schema.prisma    # Full Prisma schema (50+ models, 30+ enums)
└── seed.ts          # Development seed data
src/
├── client.ts        # Singleton PrismaClient factory
└── index.ts         # Re-exports PrismaClient + helpers
```
