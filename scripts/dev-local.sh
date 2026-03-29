#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# dev-local.sh — Local macOS development environment
#
# Environment: macOS with Docker Desktop
# Starts: Postgres, Redis (Docker), Copilot API, Control Panel
# Prereqs: Docker Desktop running, pnpm installed, .env populated
#
# Usage:
#   ./scripts/dev-local.sh          # start everything
#   ./scripts/dev-local.sh stop     # stop everything
#   ./scripts/dev-local.sh restart  # stop then start
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[dev]${NC} $*"; }
err()  { echo -e "${RED}[dev]${NC} $*" >&2; }

cd "$PROJECT_ROOT"

# ── Stop ────────────────────────────────────────────────────
stop_services() {
  log "Stopping dev services..."
  pkill -f "tsx.*copilot-api" 2>/dev/null && log "Stopped copilot-api" || true
  pkill -f "ng serve" 2>/dev/null && log "Stopped control-panel" || true
  sleep 1
}

if [[ "${1:-}" == "stop" ]]; then
  stop_services
  log "Done."
  exit 0
fi

if [[ "${1:-}" == "restart" ]]; then
  stop_services
fi

# ── Preflight checks ───────────────────────────────────────
if [[ ! -f .env ]]; then
  err ".env file not found. Copy .env.example and fill in values."
  exit 1
fi

if ! docker info &>/dev/null; then
  err "Docker is not running. Start Docker Desktop first."
  exit 1
fi

# ── Load .env ───────────────────────────────────────────────
log "Loading .env..."
set -a
# shellcheck disable=SC1091
source .env
set +a

# ── Docker (Postgres + Redis) ──────────────────────────────
log "Starting Postgres and Redis..."
docker compose -f docker-compose.dev.yml up -d

log "Waiting for Postgres..."
until docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U bronco &>/dev/null; do
  sleep 1
done
log "Postgres ready."

# ── Deps + build ────────────────────────────────────────────
log "Installing dependencies..."
pnpm install --frozen-lockfile

log "Generating Prisma client..."
pnpm db:generate

log "Building packages..."
pnpm build

# ── Migrations ──────────────────────────────────────────────
log "Running database migrations..."
pnpm --filter @bronco/db exec prisma migrate deploy

# ── Start services ──────────────────────────────────────────
log "Starting Copilot API on :3000..."
pnpm dev:api &
API_PID=$!

log "Starting Control Panel on :4200..."
pnpm dev:panel &
PANEL_PID=$!

# ── Wait for readiness ──────────────────────────────────────
log "Waiting for services..."
for i in {1..30}; do
  if lsof -i :3000 &>/dev/null; then
    break
  fi
  sleep 1
done

if lsof -i :3000 &>/dev/null; then
  log "Copilot API ready at http://localhost:3000"
else
  warn "Copilot API may not have started — check output above"
fi

for i in {1..30}; do
  if lsof -i :4200 &>/dev/null; then
    break
  fi
  sleep 1
done

if lsof -i :4200 &>/dev/null; then
  log "Control Panel ready at http://localhost:4200"
else
  warn "Control Panel may not have started — check output above"
fi

echo ""
log "Login: admin@bronco.dev / changeme"
log "Stop with: ./scripts/dev-local.sh stop"
echo ""

# ── Keep alive ──────────────────────────────────────────────
wait $API_PID $PANEL_PID
