---
title: "Metrics"
description: "Prometheus's text format at /metrics: requests, reads, publish lag and open streams. Off until FF_METRICS=on."
---

**What it does.** It serves Prometheus's text format at `GET /metrics`: requests by route, apps' and backends' reads,
publish lag, failing publishes and purges, and open event streams.

**When you need it.** When you scrape with Prometheus, or anything that reads its format, and want alerts on the
server's own numbers. Without it, watch `/readyz` instead ([Monitoring → Alerts](/operate/monitoring#alerts)).

## Turn it on

It is off by default. Turn it on with two variables:

```bash
FF_METRICS=on
FF_METRICS_TOKEN=<openssl rand -hex 24>
```

A scraper then sends `Authorization: Bearer <token>`. Without a token, `/metrics` is open to whoever reaches the
server: keep it on your own network. `FF_METRICS_TOKEN` without `FF_METRICS=on` stops the start, so a token is never
set for nothing.

In a config file that lists integrations, it is `metrics()`, or `metrics({ token })`. Left out, the token comes from
`FF_METRICS_TOKEN`.

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';
import { defaultPlugins, metrics } from 'companyflags/plugins';

export default defineConfig({ plugins: [...defaultPlugins(), metrics()] });
```

## What it counts

Each instance counts its own requests: scrape every one.

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

What to alert on: [Monitoring → Alerts](/operate/monitoring#alerts). To change its token:
[Configuration → Changing a secret](/reference/configuration#changing-a-secret).
