# @bronco/mcp-database

MCP Database Server for SQL Server analysis. Gives Claude Code and the copilot-api direct, read-only access to client database instances for diagnostics, schema inspection, and performance analysis. Supports Azure SQL Managed Instances (primary) and on-prem SQL Server.

## Why This Exists

Client databases are primarily **Azure SQL Managed Instances** on private vnets, accessible today via AVD. This server runs as an Azure App Service on the same vnet, acting as the bridge between Claude (wherever it runs) and the databases. It also supports **on-prem SQL Server** for future clients reachable via VPN/vnet peering.

## Architecture

Single Express HTTP server with two interfaces:

- **`POST /mcp`** -- MCP Streamable HTTP transport. Claude Code connects here as a remote MCP server.
- **`POST /tools/*`** -- REST bridge. copilot-api on Hugo calls these endpoints when it needs database operations for automated pipeline tasks.
- **`GET /health`** -- Health check (no auth).

```
Claude Code (MacBook)  ──HTTPS──▶  POST /mcp     ─┐                    ┌── Azure SQL MIs (primary)
                                                    ├──▶  SQL Tools  ──▶ ┤
copilot-api (Hugo)     ──HTTPS──▶  POST /tools/* ─┘                    └── On-prem SQL Server (future)
```

## MCP Tools

| Tool | Description | Params |
|------|-------------|--------|
| `list_systems` | List all active client database systems | (none) |
| `run_query` | Execute a read-only SQL SELECT/WITH query | `systemId`, `query`, `maxRows?` |
| `inspect_schema` | Tables, columns, data types, constraints | `systemId`, `objectName?`, `includeColumns?`, `includeConstraints?` |
| `list_indexes` | Index catalog with usage stats | `systemId`, `tableName?`, `includeStats?` |
| `get_blocking_tree` | Current blocking chains from DMVs | `systemId` |
| `get_wait_stats` | Top N waits by cumulative time | `systemId`, `topN?` |
| `get_database_health` | Composite health: sizes, backups, VLFs, CPU, memory, I/O | `systemId` |

## REST Bridge Endpoints

All require `x-api-key` header (or `Authorization: Bearer` for MCP).

| Method | Path | Body |
|--------|------|------|
| GET | `/health` | -- |
| GET | `/systems` | -- |
| POST | `/tools/run-query` | `{ systemId, query, maxRows? }` |
| POST | `/tools/inspect-schema` | `{ systemId, objectName?, includeColumns?, includeConstraints? }` |
| POST | `/tools/list-indexes` | `{ systemId, tableName?, includeStats? }` |
| POST | `/tools/blocking-tree` | `{ systemId }` |
| POST | `/tools/wait-stats` | `{ systemId, topN? }` |
| POST | `/tools/database-health` | `{ systemId }` |

## Security Model

Five layers of protection -- this server touches production databases, so defense-in-depth is critical.

**Layer 1: SQL Server Login Permissions**
The credentials stored in the systems config JSON file must be for a login with `db_datareader` role **only**. No write permissions at the database level.

**Layer 2: Query Keyword Blocklist**
`run_query` rejects any query containing: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, EXEC, EXECUTE, GRANT, REVOKE, DENY, TRUNCATE, BULK, OPENROWSET, OPENQUERY, xp_, sp_configure, RECONFIGURE, SHUTDOWN, BACKUP, RESTORE.

**Layer 3: READ UNCOMMITTED Isolation**
All user queries are wrapped with `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` to prevent taking any locks on production databases.

**Layer 4: Audit Logging**
Every query execution is logged via Pino structured JSON to stdout: query text, SHA-256 hash, tool name, caller identity (mcp:claude-code vs api:copilot), duration, row count, and errors.

**Layer 5: Azure Secret Management**
SQL Server passwords are stored as plaintext in a local JSON configuration file (`SYSTEMS_CONFIG_PATH`). Azure App Service handles secret management — the JSON file can reference App Service environment variables or Key Vault references. The MCP server has no dependency on the control plane Postgres database.

## Connection Management

- **Pool-per-system**: Each client system gets its own `mssql.ConnectionPool`, lazily created on first use
- **Idle cleanup**: Pools are closed after 10 minutes of inactivity
- **Config source**: System connection details are loaded from a local JSON file (`SYSTEMS_CONFIG_PATH` env var) at startup. The MCP server has no dependency on the control plane Postgres database — adding a new system requires updating the JSON file and restarting the server.

### Connection Types

The pool manager uses a factory pattern (`buildMssqlConfig`) that dispatches based on `dbEngine`:

| `dbEngine` | Connection Method | Auth | Notes |
|------------|------------------|------|-------|
| `AZURE_SQL_MI` | `connectionString` or host + port | SQL credentials | Port 3342 for private endpoint, 1433 for public. TLS always on. |
| `MSSQL` | host + port + optional instanceName | SQL or Windows auth | Traditional on-prem SQL Server |

### Adding New Connection Types

The pool manager has a detailed extensibility guide in the JSDoc on `buildMssqlConfig()` in `src/connections/pool-manager.ts`. The short version:

1. Add the new `DbEngine` value to `packages/shared-types/src/system.ts` and `packages/db/prisma/schema.prisma`
2. Run `pnpm db:migrate && pnpm db:generate`
3. Add a new case in the `buildMssqlConfig` switch and a corresponding `buildXxxConfig()` method
4. If the new engine uses a different driver (not mssql/tedious), the tools and pool abstraction need updating — see the detailed guide in the source

## Development

```bash
# From monorepo root
pnpm dev:mcp-db

# Requires:
#   SYSTEMS_CONFIG_PATH pointing to a JSON file with system connection configs
```

The server starts on port 3100 by default. In dev mode (no `API_KEY` set), all routes are unauthenticated.

## Deployment (Azure App Service)

Deployed via ZIP deploy using a publish profile. See `.github/workflows/deploy-mcp.yml` for the CI workflow.

```bash
# Manual deployment (if needed):
# 1. Build the project
pnpm build

# 2. The deploy-mcp workflow handles:
#    - Building the mcp-database package
#    - Creating a ZIP archive
#    - Deploying to Azure App Service via publish profile

# The App Service must be on a vnet with access to client SQL Servers
# (Azure SQL MIs via vnet peering, on-prem via VPN)
```

## Claude Code Configuration

After deploying, update `.claude/settings.json` in the repo root:

```json
{
  "mcpServers": {
    "bronco-database": {
      "type": "url",
      "url": "https://<your-app>.azurewebsites.net/mcp",
      "headers": {
        "x-api-key": "<API_KEY>"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SYSTEMS_CONFIG_PATH` | Yes | -- | Path to JSON file with system connection configs |
| `PORT` | No | 3100 | HTTP listen port |
| `API_KEY` | No | -- | API key for all endpoint auth (`x-api-key` header) |
| `LOG_LEVEL` | No | info | Pino log level |

## Source Layout

```
src/
├── index.ts                 # Express server: MCP transport + REST bridge
├── server.ts                # McpServer factory with tool registration
├── config.ts                # Zod-validated env config
├── connections/
│   └── pool-manager.ts      # Multi-tenant SQL Server connection pool manager
├── security/
│   ├── query-validator.ts   # SQL keyword blocklist + READ UNCOMMITTED wrapper
│   └── audit-logger.ts      # Query audit logging (Pino structured JSON to stdout)
└── tools/
    ├── index.ts             # Tool registration (Zod schemas + handlers)
    ├── run-query.ts         # Read-only SQL execution
    ├── inspect-schema.ts    # INFORMATION_SCHEMA queries
    ├── list-indexes.ts      # sys.indexes + usage stats
    ├── blocking-tree.ts     # sys.dm_exec_requests blocking chains
    ├── wait-stats.ts        # sys.dm_os_wait_stats (filtered)
    └── database-health.ts   # Composite health report
```
