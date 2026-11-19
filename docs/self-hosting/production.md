# Production checklist

Go through this list before people and apps depend on your installation. Each item links to the page with the
details.

## 1. Postgres, with backups

- Set `DATABASE_URL` to a Postgres 15 or later server, e.g.
  `postgres://flags:secret@db.example.com:5432/flags?sslmode=verify-full`. A managed server with a standby and
  point-in-time backups is a good fit.
- The first start creates the `btree_gist` extension: the database user needs the right to create it, or create it
  beforehand.
- Back up the database, and test a restore. Everything is in it: flags, history, people, password hashes, and the
  secrets the server keeps (each environment's link secret, single sign-on client secrets, the Cloudflare token).
  Protect the backups like those secrets.
- `FF_DB_POOL` (default 10) is per instance. Make sure the server allows that many connections for every instance.

The embedded database (no `DATABASE_URL`) is for trying CompanyFeatures and for small setups. It lives in one folder
(`FF_DATA_DIR`, `/data/db` in the Docker image), and only one process may open it: the server keeps a lock file next
to the folder (`/data/db.lock`) and a second server refuses to start. Keep the folder on a persistent volume and back
it up while the server is stopped.

## 2. Production mode, secret and address

```bash
NODE_ENV=production                         # the Docker image sets it
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://flags.example.com
```

With `NODE_ENV=production` the server refuses to start without the secret or the address, turns on rate limits on
sign-in, and accepts only `https` issuers for single sign-on. Keep the secret the same across restarts and instances:
a new one signs everyone out. See [Configuration](/self-hosting/configuration).

## 3. HTTPS in front

The server speaks plain HTTP on `PORT` (8787). Put a proxy or load balancer in front that ends TLS, and serve the
console only over `https`.

- The server sends no `Strict-Transport-Security` header. Add HSTS at the proxy.
- Rate limits on sign-in count each client's address. By default that is the address of the connection, which a
  client can't fake, so behind a proxy every sign-in would look like the proxy's. Tell the server where the real one
  is: `FF_CLIENT_IP_HEADER` for a header your proxy or CDN sets itself (`cf-connecting-ip` behind Cloudflare,
  `x-real-ip` behind many nginx setups), or `FF_TRUSTED_PROXIES` with your proxies' addresses, to read
  `X-Forwarded-For` past them. Only use a header the proxy always replaces, never one a client can send.
- `BETTER_AUTH_URL` must be the address people type. Sign-in from another address is refused.

## 4. A CDN for the app files

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

## 8. The admin account, right after deploying

The first account made on the sign-in page becomes the admin. Until it exists, whoever reaches the console first can
claim it. Open the console and make it as soon as the server is up, then invite everyone else from
**Settings → People**. See [Sign-in and single sign-on](/self-hosting/sign-in).

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
environments' revision numbers; API keys, links and apps are cached for up to a minute per instance. With the
embedded database, run one.

When you run several:

- give them all the same `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and other settings;
- rate limits on sign-in are counted by each instance on its own;
- the database must allow `FF_DB_POOL` connections for each instance.

## 11. Logs

The server logs to standard output; its own lines start with `[ff]`: migrations applied, publishes, CDN purges and
their failures, scheduled changes. An unexpected error is logged with its stack, and the request gets
`500 {"error":"internal error"}`, which says nothing more.

## Also read

- [Security model](/guide/security): what apps, backends and people can see and do.
- [Docker](/self-hosting/docker): the image and Docker Compose.
