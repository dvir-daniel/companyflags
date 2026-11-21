---
title: "Self-Hosting Overview"
description: "What you run, which path fits you, and what every install needs."
---

This section is for whoever runs CompanyFlags for a team. Read this page first: it says what the server is, which
pages fit your setup, and what every install needs before people depend on it.

## What you run

- **One image.** `ghcr.io/dvir-daniel/companyflags` holds the server, the console and the CDN files. It listens on
  port 8787 and runs as the unprivileged `node` user.
- **Postgres** holds all state: flags, history, people, keys and settings. Nothing is kept on the server's disk.
- **A background loop** runs every second in each instance: publishes, scheduled changes, webhooks and the second
  CDN purge.
- **A CDN is optional.** You need one only if apps read [CDN files](/reading/local-apps).

```text
console, API, OFREP, streams ─► flags.example.com ─────► proxy or load balancer (HTTPS) ─► CompanyFlags :8787 ─► Postgres
apps' CDN files ─────────────► cdn.flags.example.com ─► CDN (only /cdn/v1/flags/*) ──────┘
```

The CDN serves only `/cdn/v1/flags/*`. Everything else goes straight to the server.

## Choose a path

| Path | For | Database | Read |
|---|---|---|---|
| Try it | A look on your own machine | Embedded | [Quickstart](/guide/quickstart) |
| One server | A team, on one VM. Recommended to start | Postgres in Compose | [Docker](/self-hosting/docker), then [Proxies and HTTPS](/self-hosting/proxies), then [Backups](/self-hosting/backups) |
| A managed cloud | Two or more instances on managed containers | The cloud's Postgres | [AWS](/self-hosting/aws), [Google Cloud](/self-hosting/google-cloud) or [Azure](/self-hosting/azure) |
| Kubernetes | A cluster you already run | Your Postgres | No guide yet. Read [Docker](/self-hosting/docker), [Monitoring → Health checks](/self-hosting/monitoring#health-checks) and the Job in [Upgrading](/self-hosting/upgrading#several-servers-or-a-rolling-upgrade) |

Every path ends with the [Production Checklist](/self-hosting/production).

## Choose a database

Use Postgres for anything people depend on. The embedded database is for trying CompanyFlags: it lives in one
folder, and only one container may open it. It can't run where a deploy starts the new container before the old one
stops. See [Database → The embedded database](/self-hosting/database#the-embedded-database).

## What every install needs

- **Postgres 15 or later.** See [Database](/self-hosting/database).
- **`BETTER_AUTH_SECRET`**, made once and never changed. See [Secrets](/self-hosting/secrets).
- **`BETTER_AUTH_URL`**, the address people open the console at. See
  [Proxies and HTTPS → The console's address](/self-hosting/proxies#the-consoles-address).
- **HTTPS in front.** The server speaks plain HTTP. See [Proxies and HTTPS](/self-hosting/proxies).
- **The admin account**, made with the setup link right after the first start. See
  [Sign-In → The first account](/self-hosting/sign-in#the-first-account).

The image sets `NODE_ENV=production`. Then the server refuses to start without the secret or the address.

## One instance or several

Several instances on one Postgres server are supported.

- Give every instance the same `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and other settings.
- A publish reaches every instance in about a second: each one watches the environments' revision numbers.
- API keys, links and services are cached for up to a minute per instance.
- Sign-in rate limits are counted by each instance on its own.
- The platform must not throttle CPU between requests, must not scale to zero, and needs a stop timeout above 5
  seconds. The background loop stops when the CPU does.
- Each instance opens its own pool of connections: see
  [Database → Connection pool and budget](/self-hosting/database#connection-pool-and-budget).
- Run migrations as their own step: see [Upgrading](/self-hosting/upgrading#several-servers-or-a-rolling-upgrade).

## Next

Put the server on a machine: [Docker](/self-hosting/docker).
