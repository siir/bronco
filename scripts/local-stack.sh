#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# local-stack.sh — Run the full Bronco stack locally against a
# fresh snapshot of Hugo's Postgres.
#
# Default service set (safe — no real-world side effects):
#   copilot-api, mcp-database, mcp-platform, mcp-repo,
#   ticket-analyzer, control-panel
#
# --with-pollers also starts (will hit real prod integrations):
#   imap-worker, devops-worker, slack-worker, scheduler-worker,
#   issue-resolver
#
# Usage:
#   ./scripts/local-stack.sh                # snapshot + start safe set
#   ./scripts/local-stack.sh --no-restore   # start without re-snapshotting
#   ./scripts/local-stack.sh --with-pollers # also start polling workers
#   ./scripts/local-stack.sh stop           # kill services + tear down docker
#   ./scripts/local-stack.sh status         # show running services
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HUGO_TS_IP="${HUGO_TS_IP:-100.106.127.1}"
HUGO_SSH_USER="${HUGO_SSH_USER:-hugo-app}"
# HUGO_SSH_TARGET is what's passed to ssh/scp. Defaults to user@ip, but can be
# overridden to an SSH config Host alias (e.g. "hugo-app") so per-host
# IdentityFile / User settings in ~/.ssh/config are honored.
HUGO_SSH_TARGET="${HUGO_SSH_TARGET:-${HUGO_SSH_USER}@${HUGO_TS_IP}}"
HUGO_ENV_PATH="${HUGO_ENV_PATH:-/home/roundclaw/bronco/.env}"
HUGO_PG_CONTAINER="${HUGO_PG_CONTAINER:-bronco-postgres-1}"

# Host port for the local dev Postgres / Redis. Override these when other
# containers (e.g. round-claw's test postgres) already bind 5432/6379.
BRONCO_DEV_POSTGRES_PORT="${BRONCO_DEV_POSTGRES_PORT:-5432}"
BRONCO_DEV_REDIS_PORT="${BRONCO_DEV_REDIS_PORT:-6379}"
export BRONCO_DEV_POSTGRES_PORT BRONCO_DEV_REDIS_PORT

LOG_DIR="$PROJECT_ROOT/.tmp/local-stack-logs"
PID_DIR="$PROJECT_ROOT/.tmp/local-stack-pids"
SNAPSHOT_PATH="$PROJECT_ROOT/.tmp/hugo-snapshot.dump"
HUGO_ENV_LOCAL="$PROJECT_ROOT/.tmp/hugo.env"
ENV_LOCAL="$PROJECT_ROOT/.env.local"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[local-stack]${NC} $*"; }
warn() { echo -e "${YELLOW}[local-stack]${NC} $*"; }
err()  { echo -e "${RED}[local-stack]${NC} $*" >&2; }
info() { echo -e "${BLUE}[local-stack]${NC} $*"; }

cd "$PROJECT_ROOT"

SAFE_SERVICES=(
  "api:dev:api:3000"
  "mcp-db:dev:mcp-db:3100"
  "mcp-platform:dev:mcp-platform:3110"
  "mcp-repo:dev:mcp-repo:3111"
  "analyzer:dev:analyzer:3106"
  "panel:dev:panel:4200"
)

POLLER_SERVICES=(
  "imap:dev:worker:3101"
  "devops:dev:devops:3102"
  "resolver:dev:resolver:3103"
  "slack:dev:slack:3108"
  "scheduler:dev:scheduler:3109"
)

# ── Subcommand routing ──────────────────────────────────────
SUBCOMMAND="${1:-start}"
WITH_POLLERS=false
NO_RESTORE=false

for arg in "$@"; do
  case "$arg" in
    --with-pollers) WITH_POLLERS=true ;;
    --no-restore)   NO_RESTORE=true ;;
  esac
done

stop_services() {
  log "Stopping local services..."
  if [[ -d "$PID_DIR" ]]; then
    for pidfile in "$PID_DIR"/*.pid; do
      [[ -f "$pidfile" ]] || continue
      local pid
      pid=$(cat "$pidfile" 2>/dev/null || true)
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        log "  stopped $(basename "$pidfile" .pid) (pid $pid)"
      fi
      rm -f "$pidfile"
    done
  fi
  # Sweep for any child processes the parent PIDs missed (tsx spawns workers,
  # ng serve forks builders). Scope to PROJECT_ROOT so adjacent dev sessions
  # on other worktrees / clones aren't collateral-damaged. (#487 review)
  pkill -f "$PROJECT_ROOT/services/" 2>/dev/null || true
  pkill -f "$PROJECT_ROOT/mcp-servers/" 2>/dev/null || true
  pkill -f "$PROJECT_ROOT/.* ng serve" 2>/dev/null || true
  sleep 1
}

stop_docker() {
  log "Tearing down docker-compose.dev.yml..."
  docker compose -f docker-compose.dev.yml down
}

cmd_status() {
  if [[ ! -d "$PID_DIR" ]]; then
    info "No PID dir — stack is not running."
    return 0
  fi
  local any=false
  for pidfile in "$PID_DIR"/*.pid; do
    [[ -f "$pidfile" ]] || continue
    any=true
    local name pid
    name=$(basename "$pidfile" .pid)
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      info "  ${GREEN}●${NC} $name (pid $pid)"
    else
      warn "  ${RED}✗${NC} $name (pid $pid — dead)"
    fi
  done
  if [[ "$any" == false ]]; then
    info "No tracked services."
  fi
  if docker compose -f docker-compose.dev.yml ps --status running 2>/dev/null | grep -q .; then
    info "Docker (postgres/redis): running"
  else
    info "Docker (postgres/redis): stopped"
  fi
}

if [[ "$SUBCOMMAND" == "stop" ]]; then
  stop_services
  stop_docker
  log "Done."
  exit 0
fi

if [[ "$SUBCOMMAND" == "status" ]]; then
  cmd_status
  exit 0
fi

if [[ "$SUBCOMMAND" == "restart" ]]; then
  stop_services
  stop_docker
fi

# ── Preflight ────────────────────────────────────────────────
log "Preflight checks..."

if ! docker info &>/dev/null; then
  err "Docker is not running. Start Docker Desktop first."
  exit 1
fi

if ! command -v pnpm &>/dev/null; then
  err "pnpm not found. Install pnpm first."
  exit 1
fi

# SSH-based reachability check rather than `ping -W` — `ping`'s `-W` unit
# differs between macOS (milliseconds) and Linux (seconds), which makes a
# 2-second portable timeout impossible to express. SSH BatchMode also
# exercises HUGO_SSH_TARGET directly, so users who set HUGO_SSH_TARGET to an
# ~/.ssh/config Host alias get checked against the actual target rather than
# the (now decoupled) HUGO_TS_IP. (#487 review)
if ! ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=accept-new "$HUGO_SSH_TARGET" true &>/dev/null; then
  err "Cannot reach Hugo via SSH at $HUGO_SSH_TARGET. Is Tailscale up and SSH access configured?"
  exit 1
fi

mkdir -p "$LOG_DIR" "$PID_DIR"

# ── Pull Hugo .env (for ENCRYPTION_KEY, ANTHROPIC keys, etc.) ─
log "Fetching Hugo's .env (for shared secrets)..."
if ! scp -q "$HUGO_SSH_TARGET:$HUGO_ENV_PATH" "$HUGO_ENV_LOCAL"; then
  err "Failed to scp $HUGO_SSH_TARGET:$HUGO_ENV_PATH"
  err "  Check SSH access and HUGO_ENV_PATH (currently: $HUGO_ENV_PATH)"
  err "  May need: ssh $HUGO_SSH_TARGET \"sudo chmod +r $HUGO_ENV_PATH\""
  exit 1
fi
# Lock down the snapshot of Hugo's env — it carries the production
# ENCRYPTION_KEY plus every API key. Default umask on shared dev hosts can
# leave it world-readable. (#487 review)
chmod 600 "$HUGO_ENV_LOCAL"

# Extract individual keys from Hugo env
get_hugo_env() {
  # Return empty string (exit 0) when the key isn't present so that
  # `set -e` + pipefail don't kill the script when an optional key is missing.
  grep -E "^${1}=" "$HUGO_ENV_LOCAL" | head -n1 | cut -d= -f2- | sed 's/^["'"'"']//' | sed 's/["'"'"']$//' || true
}

ENCRYPTION_KEY=$(get_hugo_env ENCRYPTION_KEY)
API_KEY=$(get_hugo_env API_KEY)
ANTHROPIC_API_KEY=$(get_hugo_env ANTHROPIC_API_KEY)
OLLAMA_BASE_URL=$(get_hugo_env OLLAMA_BASE_URL)
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://siiriaplex:11434}"

if [[ -z "$ENCRYPTION_KEY" ]]; then
  err "ENCRYPTION_KEY missing from Hugo .env. Aborting (decrypted secrets will fail)."
  exit 1
fi

# ── Start local Postgres + Redis ────────────────────────────
log "Starting local Postgres + Redis (docker-compose.dev.yml)..."
docker compose -f docker-compose.dev.yml up -d

log "Waiting for Postgres..."
until docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U bronco &>/dev/null; do
  sleep 1
done
log "Postgres ready."

# ── Snapshot + restore ──────────────────────────────────────
if [[ "$NO_RESTORE" == false ]]; then
  log "Snapshotting Hugo Postgres → $SNAPSHOT_PATH"
  ssh "$HUGO_SSH_TARGET" "docker exec $HUGO_PG_CONTAINER pg_dump -U bronco -Fc bronco" > "$SNAPSHOT_PATH"

  local_size=$(wc -c < "$SNAPSHOT_PATH" | tr -d ' ')
  log "Snapshot received ($local_size bytes)"

  log "Restoring snapshot into local Postgres (drops existing bronco DB)..."
  docker compose -f docker-compose.dev.yml exec -T postgres psql -U bronco -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'bronco' AND pid <> pg_backend_pid();" >/dev/null
  docker compose -f docker-compose.dev.yml exec -T postgres psql -U bronco -d postgres -c "DROP DATABASE IF EXISTS bronco;" >/dev/null
  docker compose -f docker-compose.dev.yml exec -T postgres psql -U bronco -d postgres -c "CREATE DATABASE bronco OWNER bronco;" >/dev/null
  # `pg_restore` exits non-zero on any failure (failed roles, partial restore,
  # missing source). Drop the previous `>/dev/null 2>&1 || true` so the script
  # aborts cleanly under `set -e` instead of marking a broken DB "Restore
  # complete." Output is left attached so the operator sees what failed. (#487
  # review)
  docker compose -f docker-compose.dev.yml exec -T postgres pg_restore -U bronco -d bronco --no-owner --no-acl < "$SNAPSHOT_PATH"
  log "Restore complete."
else
  warn "Skipping snapshot+restore (--no-restore)."
fi

# ── Generate .env.local ─────────────────────────────────────
# Hugo-derived values (encryption keys, API keys, OLLAMA_BASE_URL) are
# wrapped in single quotes so values containing shell-significant chars
# (#, $, &, spaces) survive `source $ENV_LOCAL` cleanly. PROJECT_ROOT
# paths are double-quoted because they may contain spaces (e.g. macOS
# "Source Code/"). Single-quoted values with embedded single quotes are
# uncommon enough in API keys / encryption keys that we accept the
# limitation rather than escape every value through a helper. (#487 review)
log "Writing $ENV_LOCAL..."
cat > "$ENV_LOCAL" <<EOF
# Generated by scripts/local-stack.sh
# Snapshot of Hugo .env with localhost overrides.
# Do not commit.

# ── Local DB / Redis ────────────────────────────────────────
DATABASE_URL='postgresql://bronco:devpassword@localhost:${BRONCO_DEV_POSTGRES_PORT}/bronco'
REDIS_URL='redis://localhost:${BRONCO_DEV_REDIS_PORT}'

# ── Secrets pulled from Hugo ────────────────────────────────
ENCRYPTION_KEY='$ENCRYPTION_KEY'
API_KEY='$API_KEY'
ANTHROPIC_API_KEY='$ANTHROPIC_API_KEY'

# ── External services ──────────────────────────────────────
OLLAMA_BASE_URL='$OLLAMA_BASE_URL'

# ── Local service URLs (override docker compose hostnames) ──
COPILOT_API_URL='http://localhost:3000'
MCP_DATABASE_URL='http://localhost:3100'
MCP_PLATFORM_URL='http://localhost:3110'
MCP_REPO_URL='http://localhost:3111'

# ── Local artifact + invoice storage ───────────────────────
# Double-quoted because PROJECT_ROOT may contain spaces (e.g. "Source Code/").
# Default deploy paths (/var/lib/...) are unwritable on macOS dev.
ARTIFACT_STORAGE_PATH="$PROJECT_ROOT/.tmp/artifacts"
INVOICE_STORAGE_PATH="$PROJECT_ROOT/.tmp/invoices"
REPO_WORKSPACE_PATH="$PROJECT_ROOT/.tmp/issue-resolver-repos"

# ── Misc ────────────────────────────────────────────────────
NODE_ENV=development
LOG_LEVEL=debug
EOF

mkdir -p "$PROJECT_ROOT/.tmp/artifacts" "$PROJECT_ROOT/.tmp/invoices" "$PROJECT_ROOT/.tmp/issue-resolver-repos"

# Append any remaining Hugo env values that aren't overridden
log "Merging non-overridden Hugo env values..."
declare -a OVERRIDDEN=(
  DATABASE_URL REDIS_URL POSTGRES_PASSWORD POSTGRES_PASSWORD_URLENCODED
  COPILOT_API_URL MCP_DATABASE_URL MCP_PLATFORM_URL MCP_REPO_URL
  ARTIFACT_STORAGE_PATH INVOICE_STORAGE_PATH REPO_WORKSPACE_PATH
  NODE_ENV LOG_LEVEL
  ENCRYPTION_KEY API_KEY ANTHROPIC_API_KEY OLLAMA_BASE_URL
)
{
  echo ""
  echo "# ── Pass-through values from Hugo .env ─────────────────────"
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)= ]] || continue
    key="${BASH_REMATCH[1]}"
    skip=false
    for o in "${OVERRIDDEN[@]}"; do
      [[ "$key" == "$o" ]] && skip=true && break
    done
    [[ "$skip" == true ]] && continue
    echo "$line"
  done < "$HUGO_ENV_LOCAL"
} >> "$ENV_LOCAL"
# Lock down the generated env — same secrets as $HUGO_ENV_LOCAL plus the
# pass-through values from the merge loop above. (#487 review)
chmod 600 "$ENV_LOCAL"

# ── Install + build ─────────────────────────────────────────
log "Installing deps + building packages..."
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build

log "Running prisma migrate deploy (no-op if snapshot is current)..."
( set -a; source "$ENV_LOCAL"; pnpm --filter @bronco/db exec prisma migrate deploy ) || warn "Migration step had issues — may be ok if snapshot is current."

# ── Start services ──────────────────────────────────────────
start_service() {
  local name="$1"
  local pnpm_script="$2"
  local port="$3"
  local logfile="$LOG_DIR/$name.log"
  local pidfile="$PID_DIR/$name.pid"

  log "Starting $name ($pnpm_script, port $port)..."
  (
    # Redirect early so any errors from `source $ENV_LOCAL` (e.g. malformed
    # var with spaces) land in the per-service log instead of getting lost.
    exec >"$logfile" 2>&1
    set -a
    # shellcheck disable=SC1090
    source "$ENV_LOCAL"
    set +a
    exec pnpm "$pnpm_script"
  ) &
  echo $! > "$pidfile"
}

for entry in "${SAFE_SERVICES[@]}"; do
  IFS=":" read -r name script1 script2 port <<< "$entry"
  start_service "$name" "${script1}:${script2}" "$port"
done

if [[ "$WITH_POLLERS" == true ]]; then
  warn "═══════════════════════════════════════════════════════════"
  warn "STARTING POLLING WORKERS — these connect to REAL integrations"
  warn "(IMAP, Slack, Azure DevOps, GitHub) using prod credentials."
  warn "Real emails / comments / tickets WILL be processed."
  warn "═══════════════════════════════════════════════════════════"
  for entry in "${POLLER_SERVICES[@]}"; do
    IFS=":" read -r name script1 script2 port <<< "$entry"
    start_service "$name" "${script1}:${script2}" "$port"
  done
fi

# ── Wait for readiness ──────────────────────────────────────
log "Waiting for services to come up..."
for i in {1..60}; do
  if lsof -i :3000 &>/dev/null && lsof -i :4200 &>/dev/null; then
    break
  fi
  sleep 1
done

# ── Summary ─────────────────────────────────────────────────
echo ""
log "═══════════════════════════════════════════════════════════"
log "Local stack up."
log "  Control panel:  http://localhost:4200/cp/"
log "  API:            http://localhost:3000"
log "  MCP database:   http://localhost:3100"
log "  MCP platform:   http://localhost:3110"
log "  MCP repo:       http://localhost:3111"
log ""
log "  Logs:    $LOG_DIR/*.log"
log "  PIDs:    $PID_DIR/*.pid"
log "  Env:     $ENV_LOCAL"
if [[ "$WITH_POLLERS" == true ]]; then
  warn "  POLLERS ARE LIVE — hitting real IMAP/Slack/DevOps/GitHub"
fi
log ""
log "  Stop with: ./scripts/local-stack.sh stop"
log "═══════════════════════════════════════════════════════════"
