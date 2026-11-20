---
title: "Production checklist"
description: "Go through this list before people and apps depend on your installation. Each item links to the page with the details."
---

## 1. Postgres, with backups

- Set `DATABASE_URL` to a Postgres 15 or later server, e.g.
  `postgres://flags:secret@db.example.com:5432/flags?sslmode=verify-full`. A managed server with a standby and
  point-in-time backups is a good fit.
- The first start creates the `btree_gist` extension: the database user needs the right to create it, or create it
  beforehand.
- Back up the database, and test a restore. Everything is in it: flags, history, people, password hashes, and the
  secrets the server keeps (each environment's link secret, single sign-on client secrets, the Cloudflare token,
  webhooks' addresses, headers and signing secrets).
  Protect the backups like those secrets.
- `FF_DB_POOL` (default 10) is per instance. Make sure the server allows that many connections for every instance.

The embedded database (no `DATABASE_URL`) is for trying CompanyFlags and for small setups. It lives in one folder
(`FF_DATA_DIR`, `/data/db` in the Docker image), and only one process may open it: the server keeps a lock file next
to the folder (`/data/db.lock`) and a second server refuses to start. Keep the folder on a persistent volume and back
it up while the server is stopped.

## 2. Production mode, secret and address

```bash
NODE_ENV=production                         # the Docker image sets it
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://flags.example.com
```

With `NODE_ENV=production` the server refuses to start without the secret or the address, or with a secret shorter
than 32 characters, and accepts only `https` issuers for single sign-on. Keep the secret the same across restarts and
instances: a new one signs everyone out. See [Configuration](/self-hosting/configuration).

Sign-in has rate limits unless `NODE_ENV` is `development` or `test`. When they're off and the server listens on more
than this machine (`HOST` isn't a loopback address), it says so at start.

## 3. HTTPS in front

The server speaks plain HTTP on `PORT` (8787). Put a proxy or load balancer in front that ends TLS, and serve the
console only over `https`.

- The server sends no `Strict-Transport-Security` header. Add HSTS at the proxy.
- Rate limits on sign-in count each client's address. By default that is the address of the connection, which a
  client can't fake, so behind a proxy every sign-in would look like the proxy's. Tell the server which connections
  are your proxies: `FF_TRUSTED_PROXIES`, their addresses or ranges (`10.0.0.0/8`; behind Cloudflare, its published
  ranges). From those connections only, the server reads `X-Forwarded-For`, from the right, past the proxies. Add
  `FF_CLIENT_IP_HEADER` to read a header your proxy or CDN sets itself instead (`cf-connecting-ip` behind
  Cloudflare, `x-real-ip` behind many nginx setups).
- A connection from any other address counts as its own address, whatever its headers say. The server refuses to
  start with `FF_CLIENT_IP_HEADER` but no `FF_TRUSTED_PROXIES`, or with a proxy entry that isn't an address or range.
- `BETTER_AUTH_URL` must be the address people type. Sign-in from another address is refused.
- Each request body has a size limit: 64 KB for OFREP, 256 KB for sign-in, 1 MB for webhooks in and the console's
  API, 4 MB for imports. A larger one gets `413`, also when it's sent in chunks. Let your proxy pass bodies that big.

## 4. A CDN in front of the CDN files

Put Cloudflare (or another CDN) in front of `/client/v1/flags/`, with a cache rule and purge on publish. See
[CDN](/self-hosting/cdn).

## 5. Health checks

| Address | Answers |
|---|---|
| `GET /healthz` | `200 {"ok":true}` while the process runs |
| `GET /readyz` | `200 {"ok":true,"environments":<n>}` when the database answers; `503 {"ok":false,"error":"…"}` when it doesn't |

Use `/healthz` for liveness (restart the process if it stops answering) and `/readyz` for readiness (send traffic
only while it answers `200`). The Docker image's own health check calls `/healthz` every 30 seconds.

## 6. Graceful shutdown

On `SIGTERM` (or `SIGINT`) the server:

1. stops taking new requests and lets the open ones finish;
2. closes the console's live-update streams after 5 seconds;
3. lets the background worker finish its round (a publish or a scheduled change);
4. closes the database and exits.

A second signal stops it at once. Give your platform a stop timeout of more than 5 seconds (Docker's default of 10
is enough). With the embedded database, always stop it this way, never with `SIGKILL`.

## 7. Upgrades

1. Take a backup.
2. Pull the new image (or check out the new version) and restart.
3. The server applies the new migrations when it starts, then serves.

Migrations only move forward. An older version refuses to start on a database a newer one has upgraded, so going
back means restoring the backup from step 1. With several instances, upgrade them together: the first to start
migrates, under a lock, and an old instance that restarts afterwards refuses to start. See
[Configuration → Migrations](/self-hosting/configuration#migrations).

## 8. The admin account, with the setup link

Only a setup link makes the first account, the admin's. While nobody has an account, the server prints it at every
start:

```text
[companyflags] nobody has an account yet: make the admin account at https://flags.example.com/api/setup/<secret>
```

Open it, create the admin account, then invite everyone else from **Settings → People**. Until then nobody can
join, `FF_SIGNUP_DOMAINS` and single sign-on included. The secret comes from `BETTER_AUTH_SECRET`, so every instance
prints the same link, and it stops working once the first account exists. Until it does, keep the link as you keep
the secret.

Upgrading a database from before accounts? An existing admin opens the link and makes the first account with their
own email. See [Sign-in → The first account](/self-hosting/sign-in#the-first-account).

## 9. The console's security headers

Every response has `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin` and `Cross-Origin-Opener-Policy: same-origin`. The console's page
also has a Content-Security-Policy:

```text
default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none';
base-uri 'self'; frame-ancestors 'none'
```

Scripts run only from the server itself, plus the page's own inline script by its hash. The page is never cached
(`no-cache, no-store, must-revalidate`); the files under `/assets/` have hashed names and are cached for a year.
If your proxy adds headers of its own, don't loosen these.

## 10. Running more than one instance

Several instances on one Postgres server are supported: each picks up a publish within about a second by watching the
environments' revision numbers; API keys, links and services are cached for up to a minute per instance. With the
embedded database, run one.

When you run several:

- give them all the same `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and other settings;
- rate limits on sign-in are counted by each instance on its own;
- the database must allow `FF_DB_POOL` connections for each instance.

## 11. Logs

The server logs to standard output; its own lines start with `[companyflags]`. At start: the config file it read,
the plugins and ways to sign in it runs, then `CompanyFlags on http://…` once it listens, and the setup link while
nobody has an account. After that: migrations applied, publishes, CDN purges and what failed after a publish,
scheduled changes, and webhooks switched off. An unexpected error is logged with its stack and its route (never an
address with a secret in it), and the request gets `500 {"error":"internal error"}`, which says nothing more.

## Also read

- [Security model](/guide/security): what apps, backends and people can see and do.
- [Docker](/self-hosting/docker): the image and Docker Compose.
