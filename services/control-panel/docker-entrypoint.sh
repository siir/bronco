#!/bin/sh
# Caddy entrypoint: falls back to tls internal when host certs are not yet provisioned.
# The host path /etc/ssl/bronco is bind-mounted into the container at /etc/caddy/certs.
set -e

CERT_FILE="/etc/caddy/certs/fullchain.pem"
KEY_FILE="/etc/caddy/certs/privkey.pem"
CADDYFILE="/etc/caddy/Caddyfile"
RUNTIME_CADDYFILE="/tmp/Caddyfile"

cp "$CADDYFILE" "$RUNTIME_CADDYFILE"

if [ ! -f "$CERT_FILE" ] || [ ! -r "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ] || [ ! -r "$KEY_FILE" ]; then
  echo "TLS certs not available or unreadable at $CERT_FILE / $KEY_FILE — falling back to tls internal (self-signed)"
  sed -i 's|tls[[:space:]][[:space:]]*/etc/caddy/certs/fullchain\.pem[[:space:]][[:space:]]*/etc/caddy/certs/privkey\.pem|tls internal|' "$RUNTIME_CADDYFILE"
fi

exec caddy run --config "$RUNTIME_CADDYFILE" --adapter caddyfile "$@"
