#!/usr/bin/env bash
# Build the ClickHouse Grafana datasource plugin from this repo and
# start a Grafana container that exposes four pre-configured
# datasources (one against the official marketplace plugin, three
# against the PR build) plus the new OTel dashboards on
# http://localhost:3033.
#
# Usage:
#   ./start.sh             # build + run
#   GF_PORT=4000 ./start.sh # override port
#
# Re-running the script tears down the previous container, rebuilds
# the plugin, and starts again. The first run takes a couple of
# minutes (Node install + Go compile + Grafana image pull); subsequent
# runs reuse Docker layer caches and are faster.

set -euo pipefail

# Resolve paths regardless of cwd.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
BUILD_DIR="$HERE/.build"
PLUGIN_OUT="$BUILD_DIR/plugin"
DASHBOARDS_OUT="$BUILD_DIR/dashboards"

GF_PORT="${GF_PORT:-3033}"

# Dashboards to copy out of src/dashboards/ and rebind to the PR-build
# datasource. Extend this list to pre-import more.
DASHBOARDS=(
  otel-logs-explorer.json
  otel-traces-explorer.json
  otel-service-dashboard.json
)

CUSTOM_DS_UID="ch-pr-build"
CUSTOM_PLUGIN_ID="grafana-clickhouse-datasource-custom"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is required on PATH."
docker info >/dev/null 2>&1 || die "docker daemon is not reachable; start Docker Desktop first."
command -v jq >/dev/null || die "jq is required on PATH (brew install jq)."

# Prefer the modern compose subcommand; fall back to docker-compose.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "neither 'docker compose' nor 'docker-compose' is available."
fi

# Step 1: build the plugin via Docker.
log "Building plugin image (this can take a couple of minutes on a cold cache)"
docker build \
  -f "$HERE/Dockerfile.plugin" \
  --build-context plugin="$REPO_ROOT" \
  -t clickhouse-datasource-local-builder \
  "$HERE"

# Step 2: extract the built plugin into .build/plugin.
#
# Use `docker create` + `docker cp` so the script works the same when
# run from the host shell and when run from inside a container that
# shells out to the host's docker daemon (in which case bind-mount
# paths would not line up).
log "Extracting plugin artifacts to $PLUGIN_OUT"
rm -rf "$PLUGIN_OUT"
mkdir -p "$PLUGIN_OUT"
cid="$(docker create clickhouse-datasource-local-builder)"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$cid:/plugin/." "$PLUGIN_OUT/"
docker rm -f "$cid" >/dev/null
trap - EXIT

[ -f "$PLUGIN_OUT/plugin.json" ] || die "plugin.json missing in build output."

# Step 3: copy + patch dashboards so they bind to the PR-build datasource.
log "Patching dashboards to bind to '$CUSTOM_DS_UID' (custom plugin: $CUSTOM_PLUGIN_ID)"
rm -rf "$DASHBOARDS_OUT"
mkdir -p "$DASHBOARDS_OUT"
for dash in "${DASHBOARDS[@]}"; do
  src="$REPO_ROOT/src/dashboards/$dash"
  [ -f "$src" ] || { warn "skipping missing dashboard: $dash"; continue; }
  jq \
    --arg uid "$CUSTOM_DS_UID" \
    --arg plugin "$CUSTOM_PLUGIN_ID" '
      # Walk every nested datasource ref and:
      #  - point grafana-clickhouse-datasource refs at the PR-build uid
      #  - rewrite the plugin type to the custom plugin id
      # Other datasource refs (e.g. "-- Grafana --") are left untouched.
      (.. | objects | select(.type? == "grafana-clickhouse-datasource")) |=
        (.type = $plugin | .uid = $uid)
      # Seed the dashboards `datasource` template variable so the first
      # paint already targets the PR build; users can still switch via
      # the picker.
      | (.templating?.list?[]? | select(.name == "datasource") | .current) =
          { selected: true, text: "ClickHouse", value: $uid }
      | (.templating?.list?[]? | select(.name == "datasource") | .query) = $plugin
    ' "$src" > "$DASHBOARDS_OUT/$dash"
done

# Step 4: bring up Grafana.
log "Starting Grafana on http://localhost:$GF_PORT"
cd "$HERE"

# Translate container-internal paths under $HOME to the host-aligned
# path under $HOST_HOME when this script runs inside a container that
# shells out to the host docker daemon. When HOST_HOME is unset (the
# normal case when invoked from a developer shell on the host), the
# substitution is a no-op and the absolute paths point at the right
# location anyway.
host_path() {
  if [ -n "${HOST_HOME:-}" ] && [ -n "${HOME:-}" ]; then
    printf '%s' "${1/#$HOME/$HOST_HOME}"
  else
    printf '%s' "$1"
  fi
}
export BUILD_DIR_HOST="$(host_path "$BUILD_DIR")"
export PROVISIONING_DIR_HOST="$(host_path "$HERE/provisioning")"

GF_PORT="$GF_PORT" "${COMPOSE[@]}" up -d --force-recreate

# Step 5: wait for /api/health to respond OK.
log "Waiting for Grafana to come up"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$GF_PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS "http://localhost:$GF_PORT/api/health" >/dev/null 2>&1; then
  warn "Grafana did not respond on /api/health within 120s. Check logs:"
  warn "  ${COMPOSE[*]} logs grafana"
fi

cat <<EOF

Ready. Open http://localhost:$GF_PORT (anonymous admin; password 'admin' if asked).

Datasources (all pointed at sql-clickhouse.clickhouse.com/otel_v2):
  - ClickHouse (Official)   official marketplace plugin, classic mode
  - ClickHouse - Logs       PR build, single-table mode (logs)
  - ClickHouse - Traces     PR build, single-table mode (traces)
  - ClickHouse              PR build, classic mode (default; dashboards bind here)

Pre-imported dashboards (bound to "ClickHouse"):
  - OTel Logs Explorer
  - OTel Traces Explorer
  - OTel Service Dashboard

Stop: ./stop.sh
Logs: ${COMPOSE[*]} -f docker-compose.yml logs -f grafana
EOF
