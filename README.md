# Bronco - AI-Augmented Operations Platform

A local-first, AI-assisted operations platform for fractional database administration and software architecture work. This system ingests client support emails, creates and manages tickets, stores artifacts (query plans, deadlocks, scripts), and uses AI to triage, analyze, and recommend actions across client environments.

Tickets span the full scope of operations work: **database performance issues**, **bug fixes**, **feature requests**, **schema changes**, **code reviews**, and **architecture tasks** — across database, API, and client application layers.

This is a **single-operator** tool, not SaaS. It is designed to be secure by default, deterministic first, and AI-augmented second.

## Architecture Overview

```
                         You (MacBook)
                         ├── VS Code / Claude Code
                         └── Browser (Copilot UI)
                              │
                    Tailscale / SSH
                              │
         ┌────────────────────┼─────────────────────┐
         │         Hugo (control plane VM)             │
         │  ┌──────────────────────────────────────┐ │
         │  │ Docker Compose                       │ │
         │  │  ├── postgres (control plane DB)     │ │
         │  │  ├── redis (BullMQ job queue)        │ │
         │  │  ├── copilot-api (Fastify REST API)  │ │
         │  │  ├── imap-worker (email ingestion)   │ │
         │  │  ├── devops-worker (Azure DevOps)    │ │
         │  │  ├── issue-resolver (code gen)       │ │
         │  │  ├── ticket-analyzer (ingestion)    │ │
         │  │  ├── probe-worker (scheduled probes) │ │
         │  │  ├── status-monitor (health alerts)  │ │
         │  │  └── caddy (control panel + TLS)     │ │
         │  └──────────────────────────────────────┘ │
         │        │                                  │
         │  QNAP mount (/mnt/qnap)                  │
         │  └── artifact storage (replicated x2)     │
         └───────────────────────────────────────────┘
                              │
                   Mac mini (siiriaplex)
                   └── Ollama (local LLM)
                       http://siiriaplex:11434
                       Used for: triage, categorize,
                       summaries, draft emails,
                       fact extraction

         ┌───────────────────────────────────────────┐
         │          Azure (same vnet as AVD)          │
         │  ┌──────────────────────────────────────┐  │
         │  │ App Service: mcp-database             │  │
         │  │  ├── POST /mcp  (MCP protocol)       │  │
         │  │  ├── POST /tools/* (REST bridge)     │  │
         │  │  └── GET /health                     │  │
         │  └───────────────┬──────────────────────┘  │
         │                  │ VPN / vnet peering       │
         │                  ▼                          │
         │         Client Databases                    │
         │         ├── Azure SQL Managed Instances     │
         │         │   (primary — SQL cred auth)       │
         │         └── On-prem SQL Server (future)     │
         └───────────────────────────────────────────┘
```

**Why Azure for the MCP server?** Client databases are primarily Azure SQL Managed Instances on private vnets (accessible via AVD today). The MCP Database Server is deployed as an Azure App Service on the same vnet, giving it direct network access to those MIs. It also supports on-prem SQL Servers reachable via VPN/vnet peering for future clients. Claude Code on your MacBook and copilot-api on Hugo both call the MCP server over HTTPS.

## Monorepo Structure

This is a **pnpm workspace** monorepo. All projects share types and utilities through internal packages.

```
bronco/
├── packages/                          # Shared libraries
│   ├── shared-types/                  # TypeScript interfaces and enums
│   ├── db/                            # Prisma schema and client
│   ├── shared-utils/                  # Logger, config, crypto, queue helpers
│   ├── shared-ui/                     # Shared Angular components and utilities
│   └── ai-provider/                   # Ollama + Claude API client with routing
│
├── services/                          # Deployable services (Hugo via Docker)
│   ├── copilot-api/                   # Fastify REST API (central coordination)
│   ├── imap-worker/                   # Email ingestion via IMAP polling
│   ├── ticket-analyzer/               # Ingestion pipeline + route step execution + probe scheduling
│   ├── probe-worker/                  # Scheduled probe execution (cron + one-off)
│   ├── devops-worker/                 # Azure DevOps work item sync + AI workflow
│   ├── issue-resolver/                # Automated code generation for issue resolution
│   ├── status-monitor/                # System health monitoring + alert notifications
│   ├── control-panel/                 # Angular admin UI (served by Caddy at /cp/)
│   └── ticket-portal/                 # Angular client-facing ticket portal (served by Caddy at /portal/)
│
├── mcp-servers/                       # MCP servers (Azure deployment)
│   └── database/                      # SQL Server MCP server
│
├── docker-compose.yml                 # Production: Hugo deployment
├── docker-compose.dev.yml             # Dev: Postgres + Redis only
├── Caddyfile                          # Reverse proxy config
├── pnpm-workspace.yaml                # Workspace definition
├── tsconfig.base.json                 # Shared TypeScript config
└── .env.example                       # Environment variable template
```

## Prerequisites

- **Node.js** 20+
- **pnpm** 9+ (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- **Docker** and **Docker Compose** (for Postgres/Redis locally, full stack on Hugo)
- **Azure subscription** with a vnet peered to client SQL Server networks (for MCP server)
- **Tailscale** (recommended for Hugo remote access)

## Quick Start (Local Development)

```bash
# 1. Clone and install
git clone <repo-url> bronco
cd bronco
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install

# 2. Start Postgres and Redis
docker compose -f docker-compose.dev.yml up -d

# 3. Configure environment
cp .env.example .env
# Edit .env:
#   DATABASE_URL=postgresql://bronco:devpassword@localhost:5432/bronco
#   REDIS_URL=redis://localhost:6379
#   ENCRYPTION_KEY=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
#   CLAUDE_API_KEY=<your key>
#   OLLAMA_BASE_URL=http://siiriaplex:11434  (or http://localhost:11434 for local-only dev)
#   API_KEY=<any secret string for auth>

# 4. Build all packages
pnpm build

# 5. Run database migration
pnpm db:migrate

# 6. Seed sample data (optional)
pnpm db:seed

# 7. Start the API
pnpm dev:api
# API is now running at http://localhost:3000
# Test: curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/api/health
```

## Package Details

### `packages/shared-types`

TypeScript-only package (no runtime dependencies). Defines all interfaces and enums used across the monorepo: `Client`, `Contact`, `System`, `Ticket`, `TicketEvent`, `Artifact`, `Finding`, `Playbook`, `TicketCategory`, and AI-related types (`TaskType`, `AIRequest`, `AIResponse`).

### `packages/db`

Prisma ORM package for the control plane PostgreSQL database.

**Models:** Client, Contact, System, Ticket, TicketEvent, Artifact, Finding, Playbook, QueryAuditLog

The `System` model stores SQL Server connection metadata in the control plane. Note: the MCP Database Server does NOT read from this table — it uses a local JSON config file (`SYSTEMS_CONFIG_PATH`) that must be maintained separately on the Azure App Service.

**Commands:**
```bash
pnpm db:generate   # Regenerate Prisma client after schema changes
pnpm db:migrate    # Create/apply migrations
pnpm db:seed       # Seed development data
```

### `packages/shared-utils`

Runtime utilities shared across services:

- **`createLogger(name)`** -- Pino logger factory, writes to stderr
- **`loadConfig(zodSchema)`** -- Validates `process.env` against a Zod schema
- **`encrypt(plaintext, keyHex)` / `decrypt(encrypted, keyHex)`** -- AES-256-GCM encryption for stored credentials
- **`createQueue(name, redisUrl)` / `createWorker(name, redisUrl, processor)`** -- BullMQ factory helpers

### `packages/ai-provider`

AI routing abstraction with two providers:

- **`OllamaClient`** -- HTTP client for local LLM (Mac mini at `siiriaplex`). Used for triage, categorization, summarization, draft emails, fact extraction.
- **`ClaudeClient`** -- Anthropic SDK wrapper. Used for query plan analysis, bug analysis, architecture review, schema review, feature analysis, deep analysis, SQL generation, code review.
- **`AIRouter`** -- Routes tasks by `TaskType` to the appropriate provider automatically.

### `services/copilot-api`

The main REST API. Fastify-based, deployed on Hugo via Docker. Central coordination point between workers, AI providers, and the MCP Database Server. Over 20 route modules covering clients, tickets, artifacts, systems, repos, issue jobs, AI config, prompts, integrations, YouTube management, logs, and system status.

All routes (except health and auth) require JWT authentication or `x-api-key` header.

### `services/imap-worker`

Background worker that polls a Google Workspace IMAP mailbox for inbound emails and creates/updates tickets. Fully idempotent — safe to restart at any time without creating duplicate tickets or events.

**Flow:**
1. Polls IMAP every 60 seconds for unseen messages
2. Enqueues each email as a BullMQ job (with `messageId` and base64-encoded source)
3. Worker processes each email:
   - **Dedup check**: skips if `emailMessageId` (Message-ID header) or `emailHash` (SHA-256 of raw source) already exists in the database
   - Parses with `mailparser`
   - Matches sender to existing `Contact` by email
   - Threads into existing ticket via `In-Reply-To`/`References` headers (indexed `emailMessageId` column lookup), or subject+sender+time fallback within 7 days
   - Creates new ticket if no thread match
   - Appends `EMAIL_INBOUND` event with `emailMessageId` and `emailHash` for future dedup

**Idempotency guarantees:**
- `emailMessageId` (unique constraint) — catches re-delivery of emails with a real Message-ID header
- `emailHash` (unique constraint, SHA-256 of raw RFC822 source) — catches duplicates when Message-ID is missing or unreliable (e.g., generated UIDs)

### `services/devops-worker`

Background worker that polls Azure DevOps for work items and syncs them as tickets. For actionable items (assigned to the configured user), triggers a conversational AI workflow: analyzes the issue, posts questions via DevOps comments, proposes an execution plan, and carries it out upon approval.

### `services/issue-resolver`

BullMQ worker that automatically resolves tickets by generating code changes via Claude and pushing them to a branch. Clones the target repository, analyzes the codebase and issue, generates file changes, and commits/pushes to a prefixed branch. Never pushes to protected branches.

### `services/ticket-analyzer`

BullMQ worker that processes the ticket ingestion pipeline. Executes route steps (SUMMARIZE_EMAIL, CATEGORIZE, TRIAGE_PRIORITY, GENERATE_TITLE, LOAD_CLIENT_CONTEXT, DEEP_ANALYSIS, etc.) and manages the probe scheduling system (cron-based health checks against client databases).

### `services/probe-worker`

BullMQ + node-cron worker that executes scheduled database probes. Runs preconfigured SQL queries against client systems on a schedule, stores raw results as artifacts, and enqueues the results through the ingestion pipeline for AI-powered ticket creation and analysis.

### `services/control-panel`

Angular 19 web application for managing the Bronco platform. Provides UI for clients, tickets, systems, integrations, AI configuration, service health monitoring, and more. Built as a static bundle and served by Caddy at `/cp/`.

### `services/ticket-portal`

Angular 19 client-facing web portal for ticket submission and status tracking. Built as a static bundle and served by Caddy at `/portal/` (bundled into the same Docker image as the control panel).

### `mcp-servers/database`

The SQL Server MCP Database Server. This is the key component that gives Claude direct access to client database environments for analysis. Supports both Azure SQL Managed Instances (primary) and on-prem SQL Server. The pool manager uses a factory pattern designed for extensibility — see the inline guide in `pool-manager.ts` for adding new connection types.

**Deployed to:** Azure App Service (same vnet as client Azure SQL MIs and on-prem SQL Servers via VPN/peering)

**Dual interface:**
- `POST /mcp` -- MCP Streamable HTTP transport (Claude Code connects here)
- `POST /tools/*` -- REST bridge (copilot-api calls these programmatically)
- `GET /health` -- Health check

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `list_systems` | List all active client database systems |
| `run_query` | Execute a read-only SQL query (SELECT/WITH only) |
| `inspect_schema` | Tables, columns, data types, constraints |
| `list_indexes` | Index catalog with usage stats and fragmentation |
| `get_blocking_tree` | Current blocking chains from DMVs |
| `get_wait_stats` | Top N waits by cumulative time (filters benign waits) |
| `get_database_health` | Composite: DB sizes, backups, VLFs, CPU, memory, I/O latency |

**Security model (5 layers):**

1. **SQL Server login permissions** -- Credentials in the systems config JSON file must be for a login with `db_datareader` role only
2. **Query keyword blocklist** -- Rejects INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, EXEC, and other dangerous keywords
3. **READ UNCOMMITTED wrapper** -- All user queries run with `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` to prevent taking locks on production
4. **Audit logging** -- Every query is logged via Pino structured JSON with SHA-256 hash, caller identity, duration, and row count
5. **Azure secret management** -- SQL Server passwords are stored as plaintext in a local JSON config file; Azure App Service handles secret management via environment variables or Key Vault references

**Connection management:**
- Lazy pool-per-system initialization (pool created on first use)
- Idle timeout cleanup (pools closed after 10 minutes of inactivity)
- System configs loaded from a local JSON file (`SYSTEMS_CONFIG_PATH`) at runtime

## Deployment

### Hugo (Control Plane VM)

Hugo is an Ubuntu Server 24.04 LTS VM running on an ESXi NUC. It hosts the core platform: API, email worker, Postgres, Redis, and Caddy.

#### Prerequisites (install on Hugo)

```bash
# Docker Engine + Compose plugin
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Node.js 20 (needed for Prisma CLI and key generation)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Add the app user to the docker group
sudo usermod -aG docker bronco
# Log out and back in for group change to take effect

# Verify
docker compose version
node --version
```

#### QNAP Storage Mount (do this first)

Mount the QNAP NAS at the **host** level before starting containers. Containers bind-mount this path from the host — do NOT mount NFS/SMB inside containers (Docker + network mounts cause stale handles and deadlocks).

**NFS mount (preferred):**
```bash
sudo apt install nfs-common
sudo mkdir -p /mnt/qnap
sudo mount -t nfs <qnap-ip>:/share/artifacts /mnt/qnap
```

**SMB mount (alternative):**
```bash
sudo apt install cifs-utils
sudo mkdir -p /mnt/qnap
sudo mount -t cifs //<qnap-ip>/artifacts /mnt/qnap \
  -o username=<user>,password=<pass>,uid=1000,gid=1000
```

**Persist across reboots (`/etc/fstab`):**
```
# NFS
<qnap-ip>:/share/artifacts  /mnt/qnap  nfs  defaults,_netdev  0  0

# SMB (store creds in /root/.smbcredentials, chmod 600)
//<qnap-ip>/artifacts  /mnt/qnap  cifs  credentials=/root/.smbcredentials,uid=1000,gid=1000,_netdev  0  0
```

**Verify the mount:**
```bash
df -h /mnt/qnap          # Should show the QNAP volume
touch /mnt/qnap/test && rm /mnt/qnap/test   # Write test
```

#### Deploy (initial setup)

After the initial setup, use the **Deploy Hugo** GitHub Action for subsequent deploys (see [CI/CD](#cicd-github-actions)).

```bash
# On Hugo (Ubuntu Server 24.04 LTS VM)
git clone <repo-url> bronco
cd bronco

# Configure
cp .env.example .env
# Edit .env with production values:
#   POSTGRES_PASSWORD=<strong password>
#   DATABASE_URL=postgresql://bronco:<password>@postgres:5432/bronco
#   ENCRYPTION_KEY=<64-char hex>
#   CLAUDE_API_KEY=<key>
#   API_KEY=<key>
#   OLLAMA_BASE_URL=http://siiriaplex:11434
#   IMAP_USER=support@yourdomain.com
#   IMAP_PASSWORD=<app password>
#   MCP_DATABASE_URL=https://<your-app>.azurewebsites.net
#   QNAP_MOUNT_PATH=/mnt/qnap
#   CLOUDFLARE_TUNNEL_TOKEN=<from Cloudflare Zero Trust dashboard>

# Verify QNAP is mounted before starting containers
ls /mnt/qnap

# Deploy
docker compose up -d

# Run migrations (first time)
docker compose exec copilot-api npx prisma migrate deploy

# Check logs
docker compose logs -f copilot-api
docker compose logs -f imap-worker
```

#### Access model

Hugo has no public inbound ports. Two access paths:

| Path | Hostname | Used for | Auth |
|------|----------|----------|------|
| Tailscale | `http://100.106.127.1` | Admin / direct development | Tailscale ACL |
| Cloudflare Tunnel | `https://itrack.siirial.com` | Mobile / public | Cloudflare Access (email OTP / SSO) |

Caddy serves plain HTTP on port 80 inside the VM. TLS is handled *outside* Caddy:
- On the Tailscale path, Tailscale's WireGuard tunnel encrypts everything end-to-end.
- On the public path, Cloudflare terminates TLS at the edge and `cloudflared` carries traffic to Caddy over an encrypted outbound tunnel.

```bash
# Install Tailscale on Hugo
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Use Tailscale ACLs or firewall rules to control which devices can reach Hugo. Do NOT port-forward 80 on your router.

#### Public access via Cloudflare Tunnel

The `cloudflared` container in `docker-compose.yml` maintains an outbound QUIC tunnel to Cloudflare's edge. No inbound ports are opened on Hugo.

**Initial setup (one-time):**

1. **DNS migration** — At your registrar, point the domain's nameservers at Cloudflare (sign up at [cloudflare.com](https://cloudflare.com), add the domain, pick the free plan). Cloudflare imports existing records; verify MX, DKIM, and any other email-related records survive the move before flipping nameservers. Propagation is usually under an hour.
2. **Create tunnel** — In the Cloudflare Zero Trust dashboard ([one.dash.cloudflare.com](https://one.dash.cloudflare.com)): **Networks → Tunnels → Create a tunnel → Cloudflared**. Name it (e.g. `hugo`). Copy the tunnel token shown in the Docker install command.
3. **Configure env** — Set `CLOUDFLARE_TUNNEL_TOKEN=<token>` in Hugo's `.env`.
4. **Add public hostname** — In the same tunnel page, **Public Hostname** tab: `itrack` . `siirial.com`, type `HTTP`, URL `caddy:80`. Save.
5. **Create Access application** — In **Access controls → Applications → Add self-hosted**. App name `Bronco Control Panel`, domain `itrack.siirial.com`. Add policy: `Allow` where `Emails` includes your operator email. Enable **One-time PIN** as an identity provider for easy auth.

**Rebuild after tunnel is lost or recreated:**

Creating a new tunnel invalidates the old token. Update `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, then `docker compose up -d cloudflared` to pick it up. The public hostname and Access policy in the dashboard persist across tunnel recreations as long as the same Cloudflare account owns them.

**Service-to-service endpoints:**

| From | To | URL | Notes |
|------|----|-----|-------|
| copilot-api | Ollama (Mac mini) | `http://siiriaplex:11434` | LAN via Google WiFi DNS reservation |
| ticket-analyzer | MCP Database | `${MCP_DATABASE_URL}` | Azure App Service over HTTPS |
| copilot-api | QNAP artifacts | `/mnt/qnap` (bind mount) | Host-level NFS/SMB mount |
| cloudflared | Caddy | `http://caddy:80` | Configured in the Cloudflare dashboard, not in the repo |
| Claude Code (MacBook) | MCP Database | `https://<app>.azurewebsites.net/mcp` | Bearer token auth |
| Claude Code (MacBook) | copilot-api (Hugo) | `https://itrack.siirial.com/api/*` | Via Cloudflare Tunnel + Access |

#### Disaster recovery: rebuild Hugo from scratch

If the Hugo VM is lost, these are the steps to restore from nothing. Assumes you have:
- The repo (GitHub)
- Your last Postgres backup (`pg_dump` output on QNAP or external storage)
- The `.env` file from your password manager / secrets backup
- Cloudflare account access (tunnel and Access policies are preserved in the Cloudflare dashboard)

1. **Provision the VM** — Ubuntu Server 24.04 LTS on the ESXi host. Assign it hostname `hugo` and whatever local-net IP/DHCP you use.
2. **Install prerequisites** — Docker Engine + Compose plugin, Node.js 20, `nfs-common` (or `cifs-utils`). See [Prerequisites (install on Hugo)](#prerequisites-install-on-hugo) above.
3. **Install Tailscale** — `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`. Authorize the machine from the Tailscale admin. Confirm it gets the same stable Tailscale IP as before (`tailscale ip -4`) — if the IP changes, update the `http://100.106.127.1` hostname in `Caddyfile` to match.
4. **Mount QNAP** — `/mnt/qnap` via NFS or SMB. See [QNAP Storage Mount](#qnap-storage-mount-do-this-first) above. Persist via `/etc/fstab` so the mount survives reboots.
5. **Clone the repo** — `git clone <repo-url> bronco && cd bronco`.
6. **Restore `.env`** — place your backed-up `.env` at `bronco/.env`. Includes `CLOUDFLARE_TUNNEL_TOKEN`. If the tunnel token has rotated or needs to be recreated, get a new one from the Cloudflare dashboard (existing public hostname config in the dashboard attaches to any token under the same tunnel name).
7. **Start containers** — `docker compose up -d`. Postgres starts with an empty database.
8. **Restore Postgres** — restore your latest dump:
   ```bash
   docker compose cp ~/postgres-backup.sql postgres:/tmp/backup.sql
   docker compose exec postgres psql -U bronco -d bronco -f /tmp/backup.sql
   ```
9. **Run migrations** — `docker compose exec copilot-api npx prisma migrate deploy` (no-op if the restore was current, safe to run).
10. **Verify** — hit `https://itrack.siirial.com` from your phone (should reach the Cloudflare Access login page, then the control panel) and `http://100.106.127.1` over Tailscale from your Mac (direct, no auth). Check `docker compose ps` for all-healthy services.

**Ongoing backups to make recovery possible:**

- **Postgres** — scheduled `pg_dump` to `/mnt/qnap/backups/` (QNAP already replicates). Add a cron on Hugo or make it a scheduler-worker job.
- **`.env`** — store in a password manager; update whenever any secret rotates.
- **Tailscale** — the machine re-auths via the admin console; no backup needed beyond the Tailscale admin login.
- **Cloudflare** — tunnel public hostname config, Access policies, and DNS records live in the Cloudflare dashboard, not on Hugo. Safe from a Hugo loss.

### Azure (MCP Database Server)

The MCP Database Server must run in Azure on the same vnet that has VPN/peering to client SQL Server networks. After initial setup, use the **Deploy MCP** GitHub Action for subsequent deploys (see [CI/CD](#cicd-github-actions)).

**Azure App Service (ZIP deploy via publish profile)**

The MCP server is deployed to an Azure App Service on a vnet-integrated App Service Plan. The `deploy-mcp.yml` GitHub Action handles this automatically via ZIP deploy using a publish profile.

For manual setup:
1. Create an App Service Plan on a subnet with access to client SQL Servers
2. Create a Web App with Node.js runtime
3. Configure environment variables: `SYSTEMS_CONFIG_PATH`, `API_KEY`, `PORT`
4. Upload the systems config JSON file
5. Download the publish profile and add it as `MCP_PUBLISH_PROFILE` GitHub secret

**Networking considerations:**
- The App Service must be on a subnet in the same vnet (or a peered vnet) that has the VPN/ExpressRoute connection to client SQL Server networks
- The MCP server reads system configs from a local JSON file (`SYSTEMS_CONFIG_PATH`), not from the control plane Postgres — no `DATABASE_URL` is needed
- Ingress should be restricted -- consider using Entra ID authentication or at minimum the `API_KEY` header (`x-api-key`)

### Claude Code Configuration

After deploying the MCP server to Azure, configure Claude Code to connect:

Edit `.claude/settings.json`:

```json
{
  "mcpServers": {
    "bronco-database": {
      "type": "url",
      "url": "https://<your-app>.azurewebsites.net/mcp",
      "headers": {
        "x-api-key": "<your-API_KEY>"
      }
    }
  }
}
```

Once configured, Claude Code will have access to the database tools (`list_systems`, `run_query`, `inspect_schema`, etc.) in every conversation within this repo.

### Mac mini (Ollama — hostname: siiriaplex)

The Mac mini runs Ollama for local LLM inference. Its hostname is `siiriaplex`, reachable on the LAN via a Google WiFi DNS reservation.

```bash
# On the Mac mini (siiriaplex)
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3.1:8b

# Ollama serves on port 11434 by default
# Verify from the Mac mini:
curl http://localhost:11434/api/tags

# Verify from Hugo:
curl http://siiriaplex:11434/api/tags
```

Hugo reaches Ollama at `http://siiriaplex:11434` via `OLLAMA_BASE_URL`. For local-only dev without the Mac mini, set `OLLAMA_BASE_URL=http://localhost:11434` in your `.env`.

## CI/CD (GitHub Actions)

Three workflows in `.github/workflows/`:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| **CI** (`ci.yml`) | Push to `master`, all PRs | `pnpm install` → `db:generate` → `typecheck` → `build` |
| **Deploy Hugo** (`deploy-hugo.yml`) | Push to `master` (when `packages/`, `services/`, or `docker-compose.yml` change), manual | Builds all service Docker images (copilot-api, imap-worker, ticket-analyzer, probe-worker, devops-worker, issue-resolver, status-monitor, control-panel) → pushes to GHCR → SSHs to Hugo via Tailscale → pulls images → restarts services → runs migrations |
| **Deploy MCP** (`deploy-mcp.yml`) | Push to `master` (when `packages/shared-types/`, `packages/db/`, `packages/shared-utils/`, or `mcp-servers/database/` change), manual | Builds mcp-database → ZIP deploys to Azure App Service via publish profile |

All workflows can also be triggered manually via `workflow_dispatch`.

### Required GitHub Secrets

**Hugo (control plane) deployment:**

| Secret | Description |
|--------|-------------|
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (for GitHub Action runner to join your tailnet) |
| `TS_OAUTH_SECRET` | Tailscale OAuth secret |
| `HUGO_TAILSCALE_IP` | Hugo's Tailscale IP (e.g., `100.x.y.z`) |
| `HUGO_SSH_USER` | SSH username on Hugo |
| `HUGO_SSH_KEY` | SSH private key for Hugo |

**Azure MCP deployment:**

| Secret | Description |
|--------|-------------|
| `MCP_PUBLISH_PROFILE` | Azure App Service publish profile (download from Azure Portal → App Service → Deployment Center) |
| `MCP_WEBAPP_NAME` | The App Service web app name (e.g., `bronco-mcp`) |

### Setup: Tailscale OAuth for CI

The Hugo deploy workflow uses [Tailscale's GitHub Action](https://github.com/tailscale/github-action) to connect the runner to your tailnet. Create an OAuth client (called "Trust credentials" in the Tailscale admin UI):

1. Go to **Settings → Trust credentials** in [Tailscale admin](https://login.tailscale.com/admin/settings/oauth)
2. Create an OAuth client with the `tag:ci` tag
3. Add `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` to GitHub repo secrets
4. In your Tailscale ACLs, grant `tag:ci` SSH access to Hugo

### Setup: Azure App Service Publish Profile

1. Go to Azure Portal → App Service → Deployment Center
2. Download the publish profile
3. Add it as `MCP_PUBLISH_PROFILE` GitHub secret
4. Set `MCP_WEBAPP_NAME` to the App Service name

### Docker Image Strategy

- **Hugo services** (copilot-api, imap-worker, ticket-analyzer, probe-worker, devops-worker, issue-resolver, status-monitor, control-panel) → **GHCR** (`ghcr.io`) — free with GitHub, no extra registry
- **MCP server** → **Azure App Service** — ZIP deploy via publish profile (no container registry needed)

`docker-compose.yml` has both `image:` and `build:` directives. When CI deploys to Hugo, it uses `docker compose up -d --no-build` (pulls pre-built images from GHCR). For local dev, `docker compose up -d --build` builds from source.

## Development Commands

```bash
# Build
pnpm build                    # Build all packages
pnpm build:packages           # Build shared packages only
pnpm build:services           # Build services only
pnpm build:mcp                # Build MCP servers only

# Dev (watch mode)
pnpm dev:api                  # Start copilot-api with hot reload
pnpm dev:worker               # Start imap-worker with hot reload
pnpm dev:analyzer             # Start ticket-analyzer worker
pnpm dev:probe-worker         # Start probe-worker
pnpm dev:devops               # Start devops-worker (Azure DevOps sync)
pnpm dev:resolver             # Start issue-resolver worker
pnpm dev:status-monitor       # Start system status monitor
pnpm dev:panel                # Start control panel (Angular, port 4200)
pnpm dev:portal               # Start ticket portal (Angular, port 4201)
pnpm dev:mcp-db               # Start MCP database server locally

# Database
pnpm db:generate              # Regenerate Prisma client
pnpm db:migrate               # Run migrations
pnpm db:seed                  # Seed development data

# Quality
pnpm typecheck                # Type check all packages
pnpm clean                    # Remove all dist/ folders
```

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `DATABASE_URL` | All services | PostgreSQL connection string (control plane DB) |
| `REDIS_URL` | copilot-api, imap-worker | Redis connection for BullMQ |
| `ENCRYPTION_KEY` | copilot-api, imap-worker | 64-char hex string for AES-256-GCM credential encryption |
| `CLAUDE_API_KEY` | copilot-api | Anthropic API key |
| `OLLAMA_BASE_URL` | copilot-api | Ollama server URL (default: `http://siiriaplex:11434`) |
| `API_KEY` | copilot-api, mcp-database, mcp-platform, mcp-repo | Shared API key for service-to-service and MCP auth (`x-api-key` header) |
| `MCP_DATABASE_URL` | imap-worker | URL of the Azure-hosted MCP Database Server (for DB-context analysis) |
| `IMAP_HOST` | imap-worker | IMAP server hostname |
| `IMAP_PORT` | imap-worker | IMAP server port (default 993) |
| `IMAP_USER` | imap-worker | IMAP username (email address) |
| `IMAP_PASSWORD` | imap-worker | IMAP password or app password |
| `ARTIFACT_STORAGE_PATH` | copilot-api | Local path for artifact file storage |
| `QNAP_MOUNT_PATH` | docker-compose | Host path to QNAP mount (mapped into container) |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (Node.js 20+) |
| Monorepo | pnpm workspaces |
| API Framework | Fastify 5 |
| ORM | Prisma 6 (PostgreSQL) |
| Job Queue | BullMQ + Redis 7 |
| SQL Server Client | mssql (tedious) |
| MCP Server | @modelcontextprotocol/sdk (Streamable HTTP) |
| Local LLM | Ollama |
| Cloud LLM | Claude API (Anthropic SDK) |
| Reverse Proxy | Caddy 2 |
| Container Runtime | Docker Compose |
| Cloud Deployment | Azure App Service |
| CI/CD | GitHub Actions |
| Container Registry | GHCR (Hugo services) |
| Secure Access | Tailscale |
