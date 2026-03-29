#!/usr/bin/env bash
# setup-acme.sh — Issue a TLS cert for hugo.siirial.com via acme.sh + Dyn DNS
#
# Run this on the Hugo VM as root (or with sudo):
#   ssh hugo
#   sudo bash ~/bronco/scripts/setup-acme.sh
#
# You will be prompted for your Dyn credentials.
# After the cert is issued, auto-renewal is registered via cron.
#
# NOTE: This script installs acme.sh by downloading and executing the upstream
# installer from get.acme.sh. Verify the installer integrity before running in
# security-sensitive environments:
#   curl -fsSL https://get.acme.sh -o /tmp/acme-install.sh
#   cat /tmp/acme-install.sh   # inspect
#   sh /tmp/acme-install.sh --home "$ACME_HOME"

set -euo pipefail

# Must run as root (writes to /etc/ssl and /root/.acme.sh)
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Error: this script must be run as root (use sudo)." >&2
  exit 1
fi

DOMAIN="hugo.siirial.com"
CERT_DIR="/etc/ssl/bronco"
ACME_HOME="/root/.acme.sh"

# Derive COMPOSE_DIR from the script's location (repo root = parent of scripts/)
# Allow override via environment variable.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-"$SCRIPT_DIR/.."}"

# Prompt for Dyn credentials (not stored in source)
read -rp "Dyn Customer name: " DYN_Customer
read -rp "Dyn Username: "       DYN_Username
read -rsp "Dyn Password: "      DYN_Password
echo

export DYN_Customer DYN_Username DYN_Password

# Install acme.sh for root if not already present
if [ ! -f "$ACME_HOME/acme.sh" ]; then
  echo "==> Installing acme.sh..."
  ACME_INSTALLER="$(mktemp)"
  trap 'rm -f "$ACME_INSTALLER"' EXIT
  curl -fsSL https://get.acme.sh -o "$ACME_INSTALLER"
  sh "$ACME_INSTALLER" --home "$ACME_HOME"
fi

# Issue cert using Dyn DNS challenge
echo "==> Issuing cert for $DOMAIN via Dyn DNS challenge..."
"$ACME_HOME/acme.sh" --issue \
  --dns dns_dyn \
  -d "$DOMAIN" \
  --home "$ACME_HOME"

# Create cert directory readable by the Docker daemon
echo "==> Creating $CERT_DIR..."
mkdir -p "$CERT_DIR"
chmod 755 "$CERT_DIR"

# Install cert files to /etc/ssl/bronco/
# The --reloadcmd restarts Caddy on renewal; if Caddy isn't running yet it starts it.
echo "==> Installing cert files to $CERT_DIR..."
"$ACME_HOME/acme.sh" --install-cert \
  -d "$DOMAIN" \
  --home "$ACME_HOME" \
  --cert-file      "$CERT_DIR/cert.pem" \
  --key-file       "$CERT_DIR/privkey.pem" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --reloadcmd      "if docker compose -f $COMPOSE_DIR/docker-compose.yml ps caddy > /dev/null 2>&1; then docker compose -f $COMPOSE_DIR/docker-compose.yml restart caddy || docker compose -f $COMPOSE_DIR/docker-compose.yml up -d caddy; else docker compose -f $COMPOSE_DIR/docker-compose.yml up -d caddy; fi"

echo ""
echo "Done. Cert installed to $CERT_DIR"
echo "acme.sh will auto-renew via cron and restart Caddy on renewal."
echo ""
echo "Next steps:"
echo "  1. In Dyn, add an A record: $DOMAIN → 100.106.127.1 (Tailscale IP — site is reachable from devices on your Tailscale network)"
echo "  2. Update .env on Hugo: DOMAIN=$DOMAIN"
echo "  3. Redeploy: docker compose -f $COMPOSE_DIR/docker-compose.yml pull && docker compose -f $COMPOSE_DIR/docker-compose.yml up -d"
