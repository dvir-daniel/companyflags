---
title: "Monitoring"
description: "Health checks, alerts, metrics and logs: how to tell the server is serving, and what to do when it isn't."
---

Every install that people depend on needs this page. It says which address each probe should use, what to alert on,
and what the server's metrics and logs tell you.

## Health checks

| Address | Answers |
|---|---|
| `GET /healthz` | `200 {"ok":true,"version":"…"}` while the process runs |
| `GET /readyz` | `200` while this instance can serve: the database answers and it has every environment's snapshot loaded. `503` when the database doesn't answer, or it has no snapshot loaded |

The answers' full shape is in [HTTP API → Health](/reference/http-api#health).

**The rule:** use `/healthz` for liveness, readiness and load balancer checks. Use `/readyz` only as a startup probe,
where the platform has one, and as a source of alerts.

- `/healthz` is enough: the server listens only once it has checked the migrations and loaded every environment's
  snapshot, so a `200` already means the instance can serve.
- Never use `/readyz` for readiness or for a load balancer. During a database outage every instance fails it at once.
  The platform then takes every instance out, or replaces them, and they stop serving the values they still have in
  memory.
- One environment's failed publish doesn't take an instance out either: `/readyz` still answers `200`, with the
  environment in `failing`. Alert on that instead (below).

| Platform | Liveness | Readiness | Startup |
|---|---|---|---|
| Docker | The image's own health check: `/healthz` every 30 seconds | — | — |
| Kubernetes | `livenessProbe` on `/healthz` | `readinessProbe` on `/healthz` | `startupProbe` on `/readyz` |
| ECS and ALB | The container's check on `/healthz` (ECS ignores the image's) | The target group's check on `/healthz` | `startPeriod` and the service's grace period |
| Cloud Run | Liveness probe on `/healthz` | none | Startup probe on `/readyz` |
| Container Apps | `Liveness` on `/healthz` | `Readiness` on `/healthz` | `Startup` on `/readyz` |

The Docker image's health check runs on the port the server listens on, also one set with `server.port` in a config
file: the server writes it to `FF_PORT_FILE`. Each cloud guide has its platform's syntax.

## Alerts

Watch `/readyz` apart from the probes: an uptime check, a synthetic canary, or the `metrics()` plugin (below).

| Signal | When | What to do |
|---|---|---|
| `failing` isn't empty (`companyflags_publish_failing`) | A new snapshot can't be built. The environment keeps serving what it served before, so devices show nothing wrong | Read the log line `publishing prod@43 failed …`, written on every try, every 30 seconds. Fix what it names, and publish again |
| `warnings` isn't empty, or `companyflags_purge_failing` | A CDN purge didn't go through, or can't run because the saved token can't be read after `BETTER_AUTH_SECRET` changed. Apps reading CDN files get a change only once the CDN's minute is up | See [CDN → Purge on publish](/self-hosting/cdn#purge-on-publish), save the token again if needed, and purge by hand from your cloud guide's CDN section |
| `lagSeconds` keeps growing (`companyflags_publish_lag_seconds`) | A publish waits and isn't picked up | Check the instance's CPU isn't throttled, and the log |
| `companyflags_database_up` is `0`, or `/readyz` answers `503` | The database doesn't answer | Instances keep serving what they have in memory. Fix the database; don't restart the instances, which can't load without it |
| A high rate of `5xx` answers | Errors on the server or in front of it | Read the log: each unexpected error is logged with its route and stack |

`/readyz` lists the failing environment like this: `{"ok":true,"failing":["prod"],…}`.

## Metrics

Add the `metrics()` plugin for Prometheus's text format at `/metrics`:

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';
import { defaultPlugins, metrics } from 'companyflags/plugins';

export default defineConfig({ plugins: [...defaultPlugins(), metrics()] });
```

Set `FF_METRICS_TOKEN`, and a scraper sends `Authorization: Bearer <token>`. Without a token, `/metrics` is open to
whoever reaches the server: keep it on your own network. Each instance counts its own requests: scrape every one.

| Metric | What it is |
|---|---|
| `companyflags_http_requests_total{method,route,status}` | requests answered, by route as written (`/api/flags/:key`), never an address with a secret |
| `companyflags_http_request_duration_seconds{route}` | how long they took, a histogram |
| `companyflags_flag_requests_total{protocol,status}` | apps' and backends' reads: `ofrep`, `ofrep_bulk`, `cdn`, `flagd` |
| `companyflags_event_streams{route}` | live-update streams open now (OFREP's change events, the console's) |
| `companyflags_publish_lag_seconds{environment}` | how long the oldest publish still waiting has waited |
| `companyflags_publish_failing{environment}` | `1` while a new snapshot can't be built |
| `companyflags_purge_failing{environment}` | `1` while the CDN purge after the environment's last publish hasn't gone through |
| `companyflags_warnings` | how many `warnings` `/readyz` lists |
| `companyflags_revision{environment}`, `companyflags_serving_revision{environment}` | the version in the database, and the one this instance serves |
| `companyflags_database_up`, `companyflags_info{version}` | the database answers; the version |

A plugin can add middleware of its own (an access log, OpenTelemetry): see [Plugins](/reference/plugins).

## Logs

The server logs to standard output; its own lines start with `[companyflags]`.

At start:

- its version (`CompanyFlags 0.9.0`), the config file it read, and the plugins and ways to sign in it runs
  (`sign-in with Better Auth: email and password, google`);
- `CompanyFlags 0.9.0 on http://…` once it listens;
- the setup link, while nobody has an account ([Sign-In → The first account](/self-hosting/sign-in#the-first-account)).

After that: migrations applied, publishes, a publish that failed, CDN purges and what failed after a publish,
scheduled changes, webhooks switched off, and old publish log rows dropped.

- A request the database refused (a key that is taken) is logged with the database's words, and answered in plain
  ones.
- An unexpected error is logged with its stack and its route (never an address with a secret in it). The request
  gets `500 {"error":"internal error","code":"internal"}`, which says nothing more.

Lines worth matching: `publishing … failed` (alert on it), `nobody has an account yet` (make the admin account), and
the sign-in line at start (check the ways to sign in are the ones you set up).

## Shutdown

On `SIGTERM` (or `SIGINT`) the server:

1. stops taking new requests and lets the open ones finish, closing each idle connection at once (not after the
   65 seconds of keep-alive);
2. closes the console's live-update streams after 5 seconds;
3. lets the background worker finish its round (a publish or a scheduled change);
4. closes the database and exits.

A second signal stops it at once. Give your platform a stop timeout of more than 5 seconds: Docker's default of 10 is
enough. With the embedded database, always stop it this way, never with `SIGKILL`.

## What grows

- **History** is kept forever: it is the record of every change, and nothing deletes it.
- **The publish log** (each publish and how its CDN purge went, **Settings → CDN**) keeps 30 days
  (`retention.publishLogDays`, `FF_PUBLISH_LOG_DAYS`), and each environment's newest publish always.
- **No evaluation log.** The server stores nothing about what apps and backends read: it is counted in
  [metrics](#metrics), not stored.

## Next

Back up the database: [Backups](/self-hosting/backups).
