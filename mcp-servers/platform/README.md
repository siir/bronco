# @bronco/mcp-platform

MCP Platform Server for Bronco. Exposes all Bronco control-plane operations (tickets, clients, people, probes, AI usage, knowledge docs, tool requests, etc.) as MCP tools, giving Claude Code and the analysis pipeline direct Prisma access to the control-plane Postgres database without an HTTP hop to copilot-api.

## Architecture

Single Express HTTP server with two interfaces:

- **`POST /mcp`** -- MCP Streamable HTTP transport.
- **`GET /health`** -- Health check (no auth).

Runs on Hugo in Docker Compose (port 3110). Other services connect via the Docker Compose network: `http://mcp-platform:3110`.

Exception: `run_tool_request_dedupe` proxies to copilot-api via HTTP because the dedupe logic depends on `AIRouter` and `mcp-discovery`, which do not live in the mcp-platform dependency graph.

## Security Model

### Current posture (operator-only, network-edge guarded)

The MCP platform server is an **operator-only internal tool**. It is not exposed on the public internet. All access is gated at the network edge:

- **Tailscale** -- administrative access from operator machines on the Tailscale mesh.
- **Cloudflare Tunnel Access** -- public ingress at `itrack.siirial.com` is mediated by Cloudflare Access (identity-provider authentication). The tunnel terminates on Hugo and does not forward traffic to port 3110.

Because every caller is already an authenticated operator, the platform server does not implement per-request client-scope filtering. All tools query Postgres with no `clientId` predicate unless the caller supplies one explicitly as a parameter.

**This is documented behavior, not a bug.**

### Known cross-client leakage surfaces

Four search tools return results across all clients with no scope restriction. This is fine while the server is operator-only, but must be addressed before the server is exposed to non-operator principals:

| Tool | File | What it exposes |
|------|------|----------------|
| `search_people` | `src/tools/people.ts` | Person email addresses + client membership across all clients |
| `search_users` | `src/tools/users.ts` | Operator account emails and roles |
| `search_scheduled_probes` | `src/tools/probes.ts` | Probe names, tool names, and client association across all clients |
| `search_clients` | `src/tools/clients.ts` | Client names and short codes (all non-internal clients) |

All other platform tools (`get_ticket`, `list_tickets`, `search_tickets`, `list_probes`, `list_clients`, `list_people`, etc.) have the same property -- they accept an optional `clientId` filter but do not enforce it. The pattern is consistent and intentional for the current single-operator use case.

### When to add a scope layer

Add a scope-resolution layer if any of the following become true:

1. The MCP platform server is made callable by non-operator principals (e.g., client-scoped portal users, a second operator tier with restricted client access, or a shared automation pipeline).
2. The server is exposed on a network segment reachable without Tailscale or Cloudflare Access authentication.
3. A multi-tenant Claude Code deployment needs to call platform tools scoped to a single client.

**Template to follow:** `services/copilot-api/src/plugins/client-scope.ts` -- `resolveClientScope()` maps the caller identity (admin operator, assigned-client operator, portal user, API key) to a `ClientScope` union (`all` | `assigned` | `single`). A companion `scopeToWhere()` helper translates that union into a Prisma `where` clause fragment. The same pattern needs to be introduced in the platform server's `ServerDeps` / request context and threaded through each tool handler that queries client-owned data.

The REST equivalents in copilot-api already apply this scope -- the MCP tools are the gap to close when the time comes.

## Development

```bash
# From monorepo root
pnpm dev:mcp-platform

# Requires:
#   DATABASE_URL      -- Postgres connection string (control-plane DB)
#   ENCRYPTION_KEY    -- AES-256-GCM key for decrypting stored credentials
#   REDIS_URL         -- BullMQ connection (used by probe queue tools)
```

The server starts on port 3110 by default.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | -- | Postgres connection string |
| `ENCRYPTION_KEY` | Yes | -- | AES-256-GCM key for credential decryption |
| `REDIS_URL` | Yes | -- | Redis connection string (BullMQ) |
| `PORT` | No | 3110 | HTTP listen port |
| `MCP_AUTH_TOKEN` | No | -- | Bearer token for MCP endpoint auth |
| `COPILOT_API_URL` | No | `http://copilot-api:3000` | copilot-api base URL (used by `run_tool_request_dedupe`) |
| `LOG_LEVEL` | No | info | Pino log level |

## Source Layout

```
src/
├── index.ts                 # Express server: MCP transport
├── server.ts                # McpServer factory + ServerDeps wiring
├── config.ts                # Zod-validated env config
└── tools/
    ├── index.ts             # Tool registration entrypoint
    ├── tickets.ts           # Ticket CRUD + search + events
    ├── clients.ts           # Client CRUD + search_clients (cross-client, see Security Model)
    ├── people.ts            # People CRUD + search_people (cross-client, see Security Model)
    ├── probes.ts            # Probe CRUD + search_scheduled_probes (cross-client, see Security Model)
    ├── users.ts             # search_users -- operator accounts (cross-client, see Security Model)
    ├── knowledge-doc.ts     # kd_read_toc, kd_read_section, kd_update_section, kd_add_subsection
    ├── tool-requests.ts     # Gap request CRUD + GitHub issue creation
    ├── request-tool.ts      # request_tool -- capability gap reporting from analyzers
    ├── ai-usage.ts          # AI usage log queries
    ├── client-memory.ts     # Per-client memory CRUD
    ├── operators.ts         # Operator CRUD
    ├── integrations.ts      # Client integration CRUD
    ├── issue-jobs.ts        # Issue resolution job management
    ├── settings.ts          # AppSetting read/write
    ├── systems.ts           # Database system CRUD
    ├── system-status.ts     # Platform health checks
    ├── slack-conversations.ts  # Slack conversation queries
    └── read-tool-result-artifact.ts  # Truncated artifact retrieval
```
