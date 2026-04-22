#!/bin/sh
# mcp-repo entrypoint: non-fatal SSH preflight.
#
# We probe `ssh -T git@github.com` to surface broken SSH auth in the logs
# early. This is intentionally informational — HTTPS-URL repos clone fine
# without any SSH setup, so we never block startup on this check.
#
# See issue #367: first-time SSH clones were failing with
# "Host key verification failed" because known_hosts was empty. The
# Dockerfile now seeds known_hosts at build time; this probe helps
# operators notice if the identity key is missing or rejected.

set -e

if command -v ssh >/dev/null 2>&1; then
  # BatchMode=yes prevents any password/passphrase prompts.
  # StrictHostKeyChecking=yes keeps us honest — we want to verify the
  # baked-in known_hosts is actually trusted.
  # `ssh -T git@github.com` exits non-zero even on success (github prints
  # a greeting then disconnects), so we grep for the success string.
  probe_output=$(ssh -T \
    -o StrictHostKeyChecking=yes \
    -o BatchMode=yes \
    -o ConnectTimeout=5 \
    git@github.com 2>&1 || true)

  if echo "$probe_output" | grep -q "successfully authenticated"; then
    echo "[mcp-repo] SSH to github.com authenticated — SSH-URL clones should work" >&2
  else
    echo "[mcp-repo] WARNING: SSH to github.com not authenticating — SSH-URL repos will fail to clone. HTTPS-URL repos are unaffected." >&2
    echo "[mcp-repo] ssh probe output: $probe_output" >&2
  fi
fi

exec "$@"
