---
title: "Production Checklist"
description: "Check these before people and apps depend on your installation. Each line links to the page that explains it."
---

Go through this list after you deploy, on one server or in a cloud, and before people and apps depend on it. Each
line is one check, and links to the page that explains it.

## Before the first start

- [ ] Postgres 15 or later, with `btree_gist` allowed and the certificate checked: [Database](/self-hosting/database).
- [ ] `BETTER_AUTH_SECRET` made once, and stored with your backups: [Secrets](/self-hosting/secrets).
- [ ] `BETTER_AUTH_URL` is the `https` address people type: [Proxies and HTTPS](/self-hosting/proxies#the-consoles-address).
- [ ] The image pinned to an `X.Y` version: [Docker → Image tags](/self-hosting/docker#image-tags).

## Right after the first start

- [ ] The admin account is made, the log no longer prints the setup link, and few people can read the logs:
  [Sign-In](/self-hosting/sign-in#the-first-account).
- [ ] HTTPS with HSTS in front, and `FF_TRUSTED_PROXIES` set: [Proxies and HTTPS](/self-hosting/proxies).
- [ ] `/metrics` and `/readyz` only on your network, or `FF_METRICS_TOKEN` set:
  [Proxies and HTTPS → What to expose](/self-hosting/proxies#what-to-expose).
- [ ] Single sign-on required with a break-glass admin, or two-factor required of admins:
  [Single Sign-On](/self-hosting/single-sign-on#require-single-sign-on).
- [ ] *Only if apps read CDN files:* the CDN caches only `/cdn/v1/flags/*`, and a purge runs on publish:
  [CDN](/self-hosting/cdn).

## Before go-live

- [ ] Probes follow the rule: `/healthz` for liveness and readiness, `/readyz` only for startup:
  [Monitoring → Health checks](/self-hosting/monitoring#health-checks).
- [ ] Alerts on `failing`, `warnings` and `lagSeconds`: [Monitoring → Alerts](/self-hosting/monitoring#alerts).
- [ ] Backups run, and a restore was tested: [Backups](/self-hosting/backups#testing-a-restore).
- [ ] With several instances, the connection budget fits:
  [Database → Connection pool and budget](/self-hosting/database#connection-pool-and-budget).
- [ ] With several instances, the stop timeout is above 5 seconds: [Monitoring → Shutdown](/self-hosting/monitoring#shutdown).
- [ ] An upgrade plan, with migrations as their own step if you run several instances:
  [Upgrading](/self-hosting/upgrading).

## Next

Set up probes and alerts: [Monitoring](/self-hosting/monitoring).
