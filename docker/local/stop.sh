#!/usr/bin/env bash
# Tear down the local Grafana test stack started by start.sh.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "error: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

cd "$HERE"
"${COMPOSE[@]}" down --remove-orphans

echo "stopped. Build artifacts under .build/ are preserved; remove with:"
echo "  rm -rf '$HERE/.build'"
