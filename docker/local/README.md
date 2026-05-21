# Local Grafana test stack

A self-contained way to build this branch's version of the ClickHouse
datasource plugin and run it inside Grafana with four pre-configured
datasources and the new OpenTelemetry dashboards pre-imported.

## What you get

`./start.sh` builds the plugin from the current checkout and starts a
Grafana container with both the official marketplace plugin and the
PR build installed side by side. Four datasources are provisioned,
all pointed at the public ClickHouse OTel demo
(`sql-clickhouse.clickhouse.com/otel_v2`, read-only `otel_demo` user):

| Name                   | Plugin     | Mode                      |
| ---------------------- | ---------- | ------------------------- |
| `ClickHouse (Official)` | marketplace | classic, all tables       |
| `ClickHouse - Logs`     | PR build    | single-table, logs        |
| `ClickHouse - Traces`   | PR build    | single-table, traces      |
| `ClickHouse` (default)  | PR build    | classic, all tables       |

The new OTel dashboards in `src/dashboards/` (Logs Explorer, Traces
Explorer, Service Dashboard) are auto-imported and bound to the
`ClickHouse` datasource. Switch the dashboard's `datasource` variable
to one of the single-table datasources to see how the same dashboard
behaves in that mode.

## Prerequisites

- Docker Desktop or any docker daemon (the build uses `docker build`
  and `docker compose`).
- `jq` on the PATH for the dashboard rewrite step.

That is the whole list. Node, Go, and Grafana are all containerised.

## Usage

```sh
cd docker/local
./start.sh
```

Open http://localhost:3033. Anonymous admin is enabled, so no login
is needed; the admin password is `admin` if a prompt appears.

To stop:

```sh
./stop.sh
```

To rebuild from scratch (for example after pulling new commits on the
branch):

```sh
./start.sh   # tears down, rebuilds, restarts
```

To remove the cached build output:

```sh
rm -rf .build
```

## Configuration

Environment variables understood by `start.sh` and `docker-compose.yml`:

| Variable               | Default  | Purpose                              |
| ---------------------- | -------- | ------------------------------------ |
| `GF_PORT`              | `3033`   | Host port Grafana listens on.        |
| `GF_VERSION`           | `12.4.1` | Tag of the `grafana/grafana` image.  |
| `CH_OFFICIAL_VERSION`  | (latest) | Version of the marketplace plugin. Leave unset for the current release. |

To pre-import extra dashboards, add filenames from `src/dashboards/`
to the `DASHBOARDS` array near the top of `start.sh`. Every entry is
rewritten so the plugin type and `datasource` template variable point
at the PR-build datasource (`ch-pr-build`), which is what makes
auto-import work for unsigned custom plugins.

## How it works

1. `Dockerfile.plugin` is a three-stage build: Node 22 compiles the
   frontend with `npm ci && npm run build`, Go 1.26 cross-compiles
   the backend for `linux/amd64` and `linux/arm64`, and a tiny
   assembler image patches `plugin.json` so the plugin id becomes
   `grafana-clickhouse-datasource-custom`. That id is what lets the
   custom build coexist with the signed marketplace plugin in the
   same Grafana instance.

2. `start.sh` runs the build image once to copy the assembled plugin
   out to `.build/plugin`, then rewrites each dashboard in the
   `DASHBOARDS` list with `jq` so every nested
   `"type": "grafana-clickhouse-datasource"` reference becomes the
   custom plugin id with `uid` `ch-pr-build`, and so the dashboards'
   `datasource` template variable defaults to that datasource. The
   patched dashboards land in `.build/dashboards`.

3. `docker-compose.yml` boots Grafana with bind mounts for the plugin
   (`.build/plugin`), the patched dashboards (`.build/dashboards`),
   and the provisioning directory (datasources, dashboard provider
   manifest).

4. Grafana installs the official plugin from the marketplace via
   `GF_INSTALL_PLUGINS`, loads the custom plugin via
   `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS`, applies the
   datasource and dashboard provisioning files, and is reachable on
   `GF_PORT`.

## Notes

- The build output under `.build/` is `.gitignore`d.
- The container is named `clickhouse-datasource-local`; the
  containers spawned by `npm run server` (the canonical dev compose
  in `.config/`) use a different name and do not collide.
- The custom plugin is unsigned. That is fine for local development
  but means it will not load on a Grafana that does not allowlist it.
  The `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` env var handles
  that for this stack.
