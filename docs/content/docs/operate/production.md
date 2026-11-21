---
title: "Production Checklist"
description: "Check these before people and apps depend on your installation, on any platform, and the few ideas every operator needs once."
---

Go through this list after you deploy, and before people and apps depend on it. Your
[deploy recipe](/deploy/docker-compose) has a short checklist of its own for its platform; this one holds for every
install. Each line links to where it is explained.

## Before the first start

- [ ] Postgres 15 or later, with `btree_gist` allowed and the certificate checked:
  [Configuration → Database](/reference/configuration#database).
- [ ] `FF_SECRET` made once, and stored with your backups: [Configuration → FF_SECRET](/reference/configuration#ff_secret).
- [ ] `FF_PUBLIC_URL` is the `https` address people type:
  [Configuration → The console's address](/reference/configuration#the-consoles-address).
- [ ] The image pinned to an `X.Y` version: [Docker Compose → Image tags](/deploy/docker-compose#image-tags).

## Right after the first start

- [ ] The admin account is made, the log no longer prints the setup link, and few people can read the logs:
  [Sign-In → The first account](/operate/sign-in#the-first-account).
- [ ] HTTPS with HSTS in front, and `FF_TRUSTED_PROXIES` set:
  [Configuration → Client addresses](/reference/configuration#client-addresses).
- [ ] `/metrics` and `/readyz` only on your network, or `FF_METRICS_TOKEN` set:
  [Configuration → What to expose](/reference/configuration#what-to-expose).
- [ ] Single sign-on required with a break-glass admin, or two-factor required of admins:
  [Single Sign-On](/operate/single-sign-on#require-single-sign-on).
- [ ] The integrations you don't use are off (`FF_INTEGRATIONS_OFF`): [Integrations](/integrations/overview).
- [ ] *Only if apps read CDN files:* the CDN caches only `/cdn/v1/flags/*`, and a purge runs on publish:
  [CDN Files](/integrations/cdn-files) and [CDN Purge](/integrations/cdn-purge).

## Before go-live

- [ ] Probes follow the rule: `/healthz` for liveness and readiness, `/readyz` only for startup:
  [Monitoring → Health checks](/operate/monitoring#health-checks).
- [ ] Alerts on `failing`, `warnings` and `lagSeconds`: [Monitoring → Alerts](/operate/monitoring#alerts).
- [ ] Backups run, and a restore was tested: [Backups](/operate/backups#testing-a-restore).
- [ ] With several instances, the connection budget fits:
  [Configuration → Connection pool and budget](/reference/configuration#connection-pool-and-budget).
- [ ] With several instances, the stop timeout is above 5 seconds: [Monitoring → Shutdown](/operate/monitoring#shutdown).
- [ ] An upgrade plan, with migrations as their own step if you run several instances:
  [Upgrading](/operate/upgrading).

## Concepts for operators

The few ideas every recipe relies on, explained once.

### What you run

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

### Which database

Use Postgres for anything people depend on. The embedded database is for trying CompanyFlags: it lives in one
folder, and only one container may open it. It can't run where a deploy starts the new container before the old one
stops. See [Configuration → The embedded database](/reference/configuration#the-embedded-database).

### One instance or several

Several instances on one Postgres server are supported.

- Give every instance the same `FF_SECRET`, `FF_PUBLIC_URL` and other settings.
- A publish reaches every instance in about a second: each one watches the environments' revision numbers.
- API keys, links and services are cached for up to a minute per instance.
- Sign-in rate limits and stream limits are counted by each instance on its own.
- The platform must not throttle CPU between requests, must not scale to zero, and needs a stop timeout above 5
  seconds. The background loop stops when the CPU does.
- Each instance opens its own pool of connections: see
  [Configuration → Connection pool and budget](/reference/configuration#connection-pool-and-budget).
- Run migrations as their own step: see [Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade).

### The health-check rule

`/healthz` answers `200` once the instance can serve. `/readyz` also fails while the database doesn't answer, on
every instance at once. So use `/healthz` for liveness, readiness and load balancers, and `/readyz` only as a startup
probe and for alerts: an instance keeps serving what it has in memory while the database is down. See
[Monitoring → Health checks](/operate/monitoring#health-checks).

## Next

Set up probes and alerts: [Monitoring](/operate/monitoring). Who signs in, and how:
[Sign-In and People](/operate/sign-in).
