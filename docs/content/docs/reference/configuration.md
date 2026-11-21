---
title: "Configuration"
description: "Every setting the server reads, with its variable, config key and default, and what the database, the addresses and the secrets need."
---

This is the reference of every setting, and of what the database, the addresses and the secrets need. Each
[deploy recipe](/deploy/docker-compose) sets the ones its platform needs, so start there. For a first install, see
[Installation](/guide/installation).

## How settings are read

The server reads each setting from the first of these that has it:

1. **the config file**, `companyflags.config.ts` (optional);
2. **the environment variable**;
3. **the value saved in the console**, for the settings that have one (**Settings → CDN**, **Settings → Appearance**);
4. **the default**.

Without a config file, the environment variables decide everything, as in the Docker image. CompanyFlags doesn't read
a `.env` file itself: set the variables in your container, your process manager or your shell. With the repository's
`docker-compose.yml`, every variable in `.env` reaches the server. The repository's
[`.env.example`](https://github.com/dvir-daniel/companyflags/blob/main/.env.example) lists the ones you are most
likely to need.

The exceptions:

- **An `auth` field set in the file replaces all its variables.** `clientIp: { header: 'x-real-ip' }` also drops
  `FF_TRUSTED_PROXIES`, and the server then refuses to start (a header needs the proxies). Give both.
- **`NODE_ENV` comes only from the environment.** A config file can't turn off the production checks: `auth` has no
  `production`.
- **Relative paths.** `database.caFile` starts from the config file's folder; `FF_DATABASE_CA_FILE` and
  `database.dataDir` from the folder the server runs in.

Who reads which variables, by prefix:

- `FF_`: the server itself;
- `GOOGLE_`, `GITHUB_` and `MICROSOFT_`: the sign-in's providers;
- `CF_`: the Cloudflare purge;
- `COMPANYFLAGS_`: Docker Compose or the CLI, never the server ([below](#read-by-compose-and-the-cli));
- unprefixed: `DATABASE_URL`, `PORT`, `HOST`, `NODE_ENV`, and AWS's and Google's own credentials for the CloudFront
  and Cloud CDN purges.

## The config file

You don't need one: every setting has a variable, and [integrations](/integrations/overview) turn on with variables
too. A file is for what you want in Git: the look, sign-in settings, or an integration of your own. One file says how
the server runs:

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';
import { cdnFiles, cloudflare, flagd, mcp, ofrep, webhooks } from 'companyflags/plugins';

export default defineConfig({
  database: { url: process.env.DATABASE_URL },          // or { dataDir: './data' }
  server: { port: 8787 },
  auth: { baseURL: 'https://flags.example.com' },      // sign-in: secret, baseURL, providers, …
  plugins: [                                            // the integrations; left out, the variables decide
    ofrep(),
    flagd(),
    cdnFiles(),
    cloudflare(),                                       // CF_ZONE_ID and CF_API_TOKEN, unless given here
    webhooks(),
    mcp(),
  ],
});
```

- The file is TypeScript, run by Node directly (type stripping): no build step. It can read `process.env`, so
  secrets stay in the environment.
- A setting the file leaves out, or sets to `undefined`, comes from its environment variable.
- The server looks for the file in the folder it starts in. `FF_CONFIG` names another one.
- The file's imports (`companyflags/config`, `companyflags/plugins`) must resolve from its folder: the clone's root,
  or `/app` in the Docker image. A file anywhere else, `FF_CONFIG` naming one included, stops the start with a
  message that says where it can go.
- In Docker, mount it at `/app/companyflags.config.ts`:
  `-v ./companyflags.config.ts:/app/companyflags.config.ts:ro`. On a platform that can't mount a file (Fargate,
  Cloud Run), copy it into a thin image of your own, at the same place.
- The server says which file it read, and which integrations run, when it starts.

`companyflags init` writes a commented file in the folder it runs in. In Docker, `/app` isn't writable, so write it
in `/tmp` and copy it out:

```bash
docker run --rm -w /tmp ghcr.io/dvir-daniel/companyflags:0.9 \
  sh -c 'companyflags init >&2 && cat companyflags.config.ts' > companyflags.config.ts
```

It warns that the server can't load the file in `/tmp`: that's expected, since you mount it at `/app`.

| Key | Instead of | What it does |
|---|---|---|
| `database` | `DATABASE_URL`, `FF_DATA_DIR`, … | The database: [below](#database). |
| `server` | `PORT`, `HOST`, `FF_KEEPALIVE_SECONDS` | Where the server listens: [below](#server). |
| `auth` | `FF_SECRET`, `FF_PUBLIC_URL`, the providers' variables, … | Sign-in: [below](#sign-in). Each field left out comes from its variable. |
| `retention` | `FF_PUBLISH_LOG_DAYS` | How long the publish log keeps a publish: [below](#other). |
| `plugins` | `FF_INTEGRATIONS_OFF`, `FF_METRICS`, … | The integrations: what reads flags besides the console, and what runs after a publish. Listed, it wins over the variables. Left out: the variables decide ([Integrations](/integrations/overview)). |
| `appearance` | Settings → Appearance | The console's name, logo, icon, accent color, default look, notice, sign-in note and links. Set here, they can't be changed in the console. See [Appearance](/operate/appearance). |

## Database

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | `database.url` | none | A Postgres 15 or later server, e.g. `postgres://user:pass@db.example.com:5432/flags?sslmode=verify-full`. When it is set, `FF_DATA_DIR` is ignored ([Postgres](#postgres)). |
| `FF_DATA_DIR` | `database.dataDir` | `./data`; the Docker image sets `/data/db` | Without `DATABASE_URL`: the folder of the embedded database ([The embedded database](#the-embedded-database)). |
| `FF_DB_POOL` | `database.pool` | `10` | The most connections this instance opens to Postgres, from 1 to 1000. Each instance has its own pool ([Connection pool and budget](#connection-pool-and-budget)). |
| `FF_DATABASE_CA_FILE` | `database.caFile` | none | A PEM file of the certificate authorities the database's certificate is checked against, e.g. Amazon RDS's global bundle ([TLS](#tls-and-certificate-authorities)). |
| `FF_MIGRATE` | `database.migrate` | `on` (`true`) | `off` (`false`): don't apply migrations at the start, only check the schema has them, as `companyflags start --no-migrate` ([Upgrading](/operate/upgrading#how-migrations-work)). |

Everything CompanyFlags keeps is in the database. Use Postgres for anything people depend on. The embedded database is
for trying it, in one container.

### Postgres

Postgres 15 or later; the project tests on 18. Name it in `DATABASE_URL` (or `database.url` in the config file):

```bash
DATABASE_URL=postgres://flags:<password>@db.example.com:5432/flags?sslmode=verify-full
```

When `DATABASE_URL` is set, `FF_DATA_DIR` is ignored. A managed server with a standby and point-in-time recovery is a
good fit.

### The btree_gist extension

The first start creates the `btree_gist` extension. The database user that migrates needs the right to create
it, or you create it once yourself, before the first start:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

| Provider | What it takes |
|---|---|
| Amazon RDS | The master user, or the database's owner role, creates it. |
| Cloud SQL | Only members of `cloudsqlsuperuser` create extensions. Users made with `gcloud sql users create` are members. |
| Azure Flexible Server | Allowlist it first: `az postgres flexible-server parameter set … -n azure.extensions --value BTREE_GIST`, then create it as the admin. A restore makes a new server without the parameter: allowlist it there again. |

### Two roles: one that migrates, one that serves

With several instances, run migrations as their own step ([Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade)).
Then the servers can run as a role that only reads and writes rows. Once, as the master user, before the first
migration:

```sql
CREATE ROLE flags_owner LOGIN PASSWORD '…';   -- migrations
CREATE ROLE flags_app   LOGIN PASSWORD '…';   -- the servers, with FF_MIGRATE=off
CREATE DATABASE flags OWNER flags_owner;
\c flags
CREATE EXTENSION IF NOT EXISTS btree_gist;
GRANT CONNECT ON DATABASE flags TO flags_app;
GRANT USAGE ON SCHEMA public TO flags_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flags_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flags_app;
```

The migrate step connects as `flags_owner`; the servers connect as `flags_app`, with `FF_MIGRATE=off`. Keep the two
addresses in two secrets, and give the owner's only to the migrate step.

> **Check this on your setup:** these grants weren't tested end to end. Try them on a copy first, or start with one
> role for both.

### TLS and certificate authorities

The server connects with node-postgres, which reads `sslmode` in `DATABASE_URL` its own way: `require`, `prefer` and
`verify-ca` all mean `verify-full`. The server's certificate is checked against the system's certificate authorities,
and its name must match the host in the URL. Write `sslmode=verify-full`, so the URL says what happens.

A managed server whose certificate comes from its cloud's own authority needs that authority's certificates. Put them
in a file and name it in `FF_DATABASE_CA_FILE` (or `database.caFile`). The server then always connects with TLS and
checks the certificate against that file, and its name too (with `sslmode=verify-ca`, only the certificate).

| Provider | What to add |
|---|---|
| Amazon RDS | The global bundle, which has every region's authorities, in `FF_DATABASE_CA_FILE` (below). Without it, the server can't connect. |
| Azure Flexible Server | Nothing: its root authorities are in Node's own store. Connect by the server's name with `sslmode=verify-full`. Don't pin intermediate authorities: Azure rotated them in 2026. |
| Cloud SQL | Nothing, through the built-in Unix socket: it is encrypted already, so add no `sslmode`. Connecting by IP instead needs the instance's own authority in `FF_DATABASE_CA_FILE`. |

For Amazon RDS, mount the bundle, or build it into a thin image of your own:

```bash tab="Mount it"
curl -fsSo rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
echo "FF_DATABASE_CA_FILE=/etc/ssl/rds-global-bundle.pem" >> .env
echo "DATABASE_URL=postgres://flags_app:<password>@flags.xxxx.eu-west-1.rds.amazonaws.com:5432/flags?sslmode=verify-full" >> .env
docker run -d --name companyflags -p 127.0.0.1:8787:8787 --env-file .env \
  -v ./rds-global-bundle.pem:/etc/ssl/rds-global-bundle.pem:ro ghcr.io/dvir-daniel/companyflags:0.9
```

```dockerfile tab="Thin image"
FROM ghcr.io/dvir-daniel/companyflags:0.9
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
# then set FF_DATABASE_CA_FILE=/etc/ssl/rds-global-bundle.pem
```

These stop the start:

- a file set with a `sslmode` that doesn't check the certificate (`disable`, `no-verify`);
- a file that can't be read, or has no certificate in it.

`companyflags migrate` and `copy-to-postgres` use the same file.

### Connection pool and budget

`FF_DB_POOL` (`database.pool`, default 10) is the most connections one instance opens. Each instance has its own
pool. A deploy runs old and new instances side by side, so count both:

```text
2 × most instances × FF_DB_POOL + the migrate step's pool + room for you  ≤  max_connections
2 × 4 × 10                      + 2                       + 10            =  92
```

- `max_connections` follows the database's memory on most managed servers: run `SHOW max_connections;` rather than
  guess.
- Give the migrate step `FF_DB_POOL=2`.
- Cap the number of instances (a max instances or max replicas setting), so scaling out can't pass the budget.
- Each recipe gives its platform's numbers: [AWS](/deploy/aws#database), [Google Cloud](/deploy/google-cloud#database),
  [Azure](/deploy/azure#database), [Kubernetes](/deploy/kubernetes).

### The embedded database

Without `DATABASE_URL`, data goes to an embedded database: PGlite, Postgres compiled to run inside the process. It is
pinned to one version, which embeds Postgres 18. It lives in one folder: `FF_DATA_DIR` (`database.dataDir`), `./data`
by default and `/data/db` in the Docker image. Keep the folder on a persistent volume.

It is for trying CompanyFlags, in one container:

- Only one process may open the folder. Never run several containers on one volume.
- Don't run it where a deploy starts the new container before the old one stops (ECS, Cloud Run, Container Apps, a
  rolling update): the new one can't start. Use Postgres there.
- Stop the server with `SIGTERM`, never `SIGKILL` ([Monitoring → Shutdown](/operate/monitoring#shutdown)).
- Back it up while the server is stopped ([Backups](/operate/backups#the-embedded-database)).

**The lock file.** The server writes a lock file next to the folder (`./data` gets `./data.lock`; `/data/db.lock` in
the image). It holds its host name, the machine's boot ID, its process ID and command, and the time. It writes the
time again every 5 seconds while it runs. A second server on the same folder refuses to start:

- on the same host, while the process in the lock runs. A lock left behind is taken over: by a process that has
  ended, by a hard stop (a restarted container is PID 1 again), or with a process ID that now runs another program;
- from another container (a volume shared by two: EFS, Azure Files, a Cloud Storage mount), while that container
  wrote the time in the last 30 seconds. It says "the embedded database is open in another container". After 30
  seconds without a new time, the lock is taken over: the other container stopped without letting go.

**The major version.** Postgres folders open only with the major version that made them. A folder made by another
major version isn't opened: the server says so and stops. When a CompanyFlags release moves PGlite to another major
version, the changelog says so, and that release won't open an older folder. Move to Postgres before such an upgrade
(below), with the version you have.

### Moving to Postgres

To move from the embedded database to a Postgres server, with everything in it as it is (history, people, API keys,
app links and their secrets):

1. Make a new, empty database on a Postgres 15 or later server.
2. Stop the server, and back up its folder ([Backups](/operate/backups#the-embedded-database)).
3. Copy it over:

   ```bash tab="From a clone"
   companyflags copy-to-postgres postgres://user:pass@db.example.com:5432/flags
   ```

   ```bash tab="Docker"
   docker stop companyflags
   docker run --rm -v companyflags:/data ghcr.io/dvir-daniel/companyflags:0.9 \
     companyflags copy-to-postgres postgres://user:pass@db.example.com:5432/flags
   ```

   It migrates the new database, then copies every row, in one transaction: all of it or nothing. It refuses a
   database that has tables already. The embedded folder isn't changed.
4. Set `DATABASE_URL` (or `database.url`) to the new database, keep `FF_SECRET` as it was, and start the
   server.

Apps and backends keep working: their keys, app links and tokens are copied as they are. Keep the embedded folder
until you've checked the new database.

## Server

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `PORT` | `server.port` | `8787` | The port the server listens on. If something already listens there, the server stops with a message. |
| `HOST` | `server.host` | `0.0.0.0` | The address it listens on. `127.0.0.1` keeps it to this machine, e.g. behind a proxy on the same host. |
| `FF_PORT_FILE` | — | set by the image: `/tmp/companyflags.port` | A file the server writes the port it listens on to, once it listens. The image's health check reads it, so it follows `server.port` ([Monitoring](/operate/monitoring#health-checks)). |
| `FF_KEEPALIVE_SECONDS` | `server.keepAliveSeconds` | `65` | Seconds an idle connection stays open, from 1 to 3600. Keep it above your load balancer's idle timeout ([Timeouts](#timeouts-and-body-sizes)). |
| `NODE_ENV` | — (environment only) | none; the image sets `production` | `production` for real use: it requires `FF_SECRET` (at least 32 characters) and `FF_PUBLIC_URL`, says which one is wrong, and allows only `https` issuers for single sign-on. Anything else is development mode. `development` and `test` also turn off sign-in rate limits. |
| `FF_TRUSTED_PROXIES` | `auth.clientIp.trustedProxies` | none | Your proxies' addresses or ranges, comma-separated (`10.0.0.0/8`). From them only, the server believes `X-Forwarded-For` or `FF_CLIENT_IP_HEADER` about the client's address. Sign-in and the change-event streams both read it ([Client addresses](#client-addresses)). |
| `FF_CLIENT_IP_HEADER` | `auth.clientIp.header` | none | A header your proxy or CDN sets to the client's address (`cf-connecting-ip`, `x-real-ip`), read instead of `X-Forwarded-For`. Needs `FF_TRUSTED_PROXIES`: without it the server refuses to start. |
| `FF_EVENT_STREAMS_PER_ENVIRONMENT` | — | `10000` | The most change-event streams (OFREP's server-sent events) this instance keeps open for one environment. At the limit, answers list no stream and providers poll instead (their `pollInterval`); a stream asked for anyway gets `429`. Each instance counts its own. |
| `FF_EVENT_STREAMS_PER_CLIENT` | — | `100` | The most it keeps open for one client address: the connection's, or what `FF_TRUSTED_PROXIES` says. Many devices behind one office address count together. |

Without `FF_TRUSTED_PROXIES`, rate limits and event streams count the connection's own address. The server refuses to
start when an entry in `FF_TRUSTED_PROXIES` isn't an address or a range, or when an `FF_EVENT_STREAMS_…` value isn't a
whole number above 0.

**Development mode** (no `NODE_ENV=production`):

- without `FF_SECRET`, a secret is made on the first start and kept in the database, so sessions and the
  setup link survive restarts;
- without `FF_PUBLIC_URL`, sign-in works on any `localhost` or `127.0.0.1` address and port, and nowhere else;
- single sign-on issuers may be `http`.

Sign-in rate limits are on unless `NODE_ENV` is `development` or `test`. When they're off and `HOST` isn't a loopback
address, the server warns at start.

The server speaks plain HTTP on port 8787, so a proxy or load balancer in front ends TLS, and the console is served
only over `https`. Each recipe sets one up: [Docker Compose](/deploy/docker-compose#https-with-caddy-or-nginx) with
Caddy or nginx, [Kubernetes](/deploy/kubernetes) with an Ingress, and each cloud with its load balancer. What follows
is what any of them must do.

### The console's address

`FF_PUBLIC_URL` must be the address people type, such as `https://flags.example.com`. Sign-in from any other
address is refused, and the setup link and the single sign-on addresses are built on it.

### Client addresses

Sign-in rate limits and the change-event streams count each client's address. By default that is the address of the
connection, which a client can't fake. Behind a proxy, every client would look like the proxy:

- one shared sign-in limit for everyone;
- at most `FF_EVENT_STREAMS_PER_CLIENT` (100) streams per instance in all, so only 100 devices get live updates and
  the rest poll.

Tell the server which connections are your proxies:

- **`FF_TRUSTED_PROXIES`**: their addresses or ranges, comma-separated (`10.0.0.0/8`). From those connections only,
  the server reads `X-Forwarded-For`, from the right, past the proxies.
- **`FF_CLIENT_IP_HEADER`**: a header your proxy or CDN sets itself (`cf-connecting-ip`, `x-real-ip`), read instead of
  `X-Forwarded-For`. It needs `FF_TRUSTED_PROXIES`.

A connection from any other address counts as its own address, whatever its headers say. The server refuses to start
with `FF_CLIENT_IP_HEADER` but no `FF_TRUSTED_PROXIES`, or with a proxy entry that isn't an address or a range.

| Setup | `FF_TRUSTED_PROXIES` | `FF_CLIENT_IP_HEADER` |
|---|---|---|
| Caddy or nginx in Compose | The subnet pinned in the override, e.g. `172.30.0.0/24` ([Docker Compose](/deploy/docker-compose#https-with-caddy-or-nginx)) | none |
| Cloudflare straight to the server | Cloudflare's published ranges | `cf-connecting-ip` |
| An Ingress in Kubernetes | The ingress controller's pod range ([Kubernetes](/deploy/kubernetes)) | none |
| AWS Application Load Balancer | The subnets the ALB is attached to ([AWS](/deploy/aws#load-balancer-and-client-addresses)) | none |
| Google load balancer and Cloud Run | `169.254.0.0/16` ([Google Cloud](/deploy/google-cloud#load-balancer-and-client-addresses)) | `x-client-ip`, set by the load balancer |
| Azure Container Apps | The private ranges ([Azure](/deploy/azure#load-balancer-and-client-addresses)) | none |

With a proxy between Cloudflare and the server, add the proxy's address too, and let only Cloudflare reach the proxy.

Set them as variables, or as `auth.clientIp` in the config file: sign-in and the change-event streams read the same
setting.

### Timeouts and body sizes

- **Keep-alive.** The server keeps an idle connection open 65 seconds (`FF_KEEPALIVE_SECONDS`). That is longer than
  AWS's Application Load Balancer and Google's load balancers keep one (60 seconds), so the server never closes a
  connection the load balancer is about to use (a `502`). If you raise the load balancer's idle timeout, raise this
  above it too. A stop still closes idle connections at once.
- **Bodies.** 64 KB for OFREP, 256 KB for sign-in, 1 MB for webhooks in and the console's API, 4 MB for imports. A
  larger one gets `413`, also when it's sent in chunks ([HTTP API → Request size](/reference/http-api#request-size)).
  Let your proxy pass bodies that big.
- **Streams.** OFREP's change-event streams and the console's live updates stay open, with a heartbeat every 25
  seconds. Don't buffer them, and keep the proxy's read timeout above 120 seconds. A platform with a hard request
  limit cuts every stream at that limit, and providers reconnect.
- **HSTS.** The server sends no `Strict-Transport-Security` header: add it at the proxy or load balancer.

### Keep OFREP and streams off the CDN

Only `/cdn/v1/flags/*` may be cached. Everything else, OFREP and its streams above all, goes straight to the server.
Give the CDN its own hostname, such as `cdn.flags.example.com`, that serves only those files.

- A stream held back or cached leaves providers on old values, and providers stop polling while they have a stream.
- Through a CDN, the server would have to trust every CDN range to find a device's address, and those lists change.
- CDNs cut long requests: CloudFront's origin response timeout (30 seconds) leaves 5 seconds over the heartbeat, and
  Microsoft says Front Door doesn't support server-sent events.

See [CDN Files → What a CDN can cache](/integrations/cdn-files#what-a-cdn-can-cache).

### What to expose

| Path | Expose it to |
|---|---|
| `/cdn/v1/flags/…` | Everyone, through the CDN when you have one |
| `/ofrep/…` | Everyone: apps read flags there |
| `/sdk/…` | Your backends. Public only if a backend outside your network reads flags |
| `/hooks/…` | The systems that post to webhooks in, only if you use them |
| `/healthz` | Your load balancer. It says only the version |
| `/readyz` | Your network only: your monitoring reads it |
| `/metrics` | Your network only, or set `FF_METRICS_TOKEN` ([Metrics](/integrations/metrics)) |
| The console (`/`, `/assets`), `/api`, `/oauth`, `/.well-known`, `/mcp` | Your choice: everyone, or your network or VPN only. People sign in at `/api`, and AI agents use `/oauth` and `/mcp` |

The console's security headers are in [Security model → The console page](/reference/security#the-console-page).

## Sign-in

How these are used is in [Sign-In and People](/operate/sign-in) and [Single Sign-On](/operate/single-sign-on).

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `FF_SECRET` | `auth.secret` | made and kept in the database, outside production | Signs sessions, makes the setup link, and seals or encrypts the secrets kept for other systems. At least 32 random characters: `openssl rand -base64 32`. Leave it to the variable, so it stays out of the file ([FF_SECRET](#ff_secret)). |
| `FF_PUBLIC_URL` | `auth.baseURL` | none | The console's address, e.g. `https://flags.example.com`. Sign-in only works from this address, and the setup link and the single sign-on addresses are built from it ([The console's address](#the-consoles-address)). |
| `FF_TRUSTED_ORIGINS` | `auth.trustedOrigins` | none | Comma-separated origins to trust besides the console, e.g. `https://idp.internal.example.com`. Needed for an identity provider on a private network ([Single Sign-On](/operate/single-sign-on#an-identity-provider-on-a-private-network)). |
| `FF_SIGNUP_DOMAINS` | `auth.signupDomains` | none | Comma-separated email domains, e.g. `acme.example`. People who sign in with Google, GitHub or Microsoft with a confirmed email at one of these domains (the domain itself, not its subdomains) join without an invite, with the join role ([Sign-In → Who can join](/operate/sign-in#who-can-join)). |
| `FF_SSO_SESSION_HOURS` | `auth.ssoSessionHours` | `12` | Where a connection requires single sign-on, the most hours a session lasts, from 1 to 720 ([Sign-In → Sessions](/operate/sign-in#sessions)). |
| `FF_TRUSTED_PROXIES`, `FF_CLIENT_IP_HEADER` | `auth.clientIp` (`{ trustedProxies, header }`) | none | See [Server](#server). Sign-in and the change-event streams both read them. |
| `NODE_ENV` | `auth.rateLimit` | on unless `NODE_ENV` is `development` or `test` | Sign-in rate limits. |

### Sign-in providers

Each provider is turned on only when both its ID and its secret are set. In the file, each is an object:
`google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! }`.

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `auth.google` | none | Sign in with Google. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `auth.github` | none | Sign in with GitHub. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | `auth.microsoft` | none | Sign in with Microsoft (Entra ID). |
| `MICROSOFT_TENANT_ID` | `auth.microsoft.tenantId` | `common` (any Microsoft account) | Your directory's tenant ID, to allow only your organization ([Sign-In](/operate/sign-in#google-github-and-microsoft)). |

At start the server logs the ways to sign in it has, e.g. `sign-in: email and password, google`.

## Secrets

Every install has secrets: one the server needs to start, a database password, and the ones people make in the
console.

### FF_SECRET

The server's own secret. Make it once, with at least 32 random characters:

```bash
openssl rand -base64 32          # or: companyflags secret
```

With `NODE_ENV=production` (the Docker image sets it), the server refuses to start without it, or with one shorter
than 32 characters. Outside production, a server without it makes one on its first start and keeps it in the
database. Give every instance the same one.

It signs, seals or keys all of these:

- **sessions**: the session cookies are signed with it;
- **the setup link**: its secret is made from it, so every instance prints the same link;
- **sign-in providers' tokens**: Google's, GitHub's and Microsoft's tokens are stored encrypted with it;
- **two-factor sign-in**: each person's authenticator secret and recovery codes are stored encrypted with it;
- **the Cloudflare token** saved in **Settings → CDN**: sealed with a key from it;
- **webhooks out**: their headers' values and signing secrets are sealed with a key from it;
- **integrations' sealed values**: an integration that seals what it stores uses a key from it;
- **cache tags**: an entity's and a link's tag on the CDN files are keyed hashes made with it.

Never rotate it on a schedule: see [Changing a secret](#changing-a-secret). Keep it with your backups: a backup
restored with another secret loses everything on that list.

### Where to keep it

| Where it runs | Where the secret goes |
|---|---|
| Docker Compose | `.env` beside `docker-compose.yml`, with `chmod 600 .env` ([Docker Compose](/deploy/docker-compose)) |
| `docker run` | A `.env` file, passed with `--env-file .env`, never inline with `-e` |
| Kubernetes | A Secret, or your secret manager through it ([Kubernetes](/deploy/kubernetes)) |
| AWS | Secrets Manager, read as ECS secrets ([AWS](/deploy/aws#secrets)) |
| Google Cloud | Secret Manager, pinned to a version ([Google Cloud](/deploy/google-cloud#secrets)) |
| Azure | Key Vault, by a versioned reference ([Azure](/deploy/azure#secrets)) |

Platforms read secrets when an instance starts. Pin `FF_SECRET` to one version: with "latest", instances
started after a new version get it and older ones don't, and people are signed out depending on which instance
answers.

### What the database holds

Everything is in the database: flags, history, people, and the secrets the server needs.

| Secret | Stored |
|---|---|
| Passwords | As hashes |
| API keys | Their SHA-256 hash and a readable prefix |
| Access tokens | Their hash and a prefix (`cfp_` and 6 characters) |
| AI agents' OAuth tokens and codes | As hashes |
| A webhook in's address | A hash of its secret |
| Each environment's link secret | As is. Every app link of that environment can be made from it |
| Single sign-on client secrets | As is |
| Webhooks out's addresses | As is |
| Webhooks out's headers' values and signing secrets | Sealed with a key from `FF_SECRET` |
| The Cloudflare token | Sealed with a key from `FF_SECRET` |
| Sign-in providers' tokens | Encrypted with `FF_SECRET` |
| Two-factor secrets and recovery codes | Encrypted with `FF_SECRET` |

A backup without `FF_SECRET` doesn't give the sealed values away. Anyone who can read the database or a
backup can still read every entity's file, from the link secrets. Protect backups like production credentials.

### Changing a secret

#### A new FF_SECRET

Change it only on purpose. A new secret:

- signs everyone out;
- changes the setup link;
- makes the sealed and encrypted values unreadable: the Cloudflare token, webhooks' headers and signing secrets,
  integrations' sealed values, providers' tokens, and two-factor secrets and recovery codes;
- changes the cache tags, so a purge misses the files the CDN already holds until their minute is up.

After the change, save these again:

1. **The Cloudflare token** in **Settings → CDN**. Until then `/readyz` lists a warning and nothing is purged.
2. **Each webhook out**: **New secret** in its drawer, and set its headers again. Until then it isn't sent.
3. **Two-factor sign-in**: everyone who uses it gets a reset link from an admin (**Settings → People → Reset
   password**), which turns it off, and sets it up again.

:::warning[It can lock out the admins]
An admin who signs in with a password and two-factor can't sign in after the change: their codes can't be read. If
every admin signs in that way, nobody is left to make the reset links. Before you change the secret, make sure one
admin signs in another way (single sign-on, Google, GitHub or Microsoft).
:::

If it leaked:

1. Make a new secret.
2. Stop every instance, then start them all with the new one. Instances with two secrets sign and seal differently.
3. Save the Cloudflare token, the webhooks and two-factor again, as above. Replace the Cloudflare token itself, and
   each webhook out's signing secret and headers, since the old secret could open them in a backup.
4. In **Settings → CDN**, **Purge now** for each environment.

#### The database password

With Postgres in Docker Compose, Postgres sets the password once, when its volume is new. To change it later:

1. Change it in Postgres:

   ```bash
   docker compose exec postgres psql -U companyflags -c "ALTER USER companyflags PASSWORD '<new password>'"
   ```

2. Set `POSTGRES_PASSWORD` in `.env` to the same password.
3. Run `docker compose up -d`, which starts the server with it.

With a managed database, change it with no downtime: make a second user, put its address in a new version of the
secret, deploy, then drop the old user.

#### Everything else

| Secret | How to change it |
|---|---|
| An API key | **API Keys**: make a new key, move the app or backend to it, then revoke the old one. A key is shown once |
| An access token | Your name at the foot of the sidebar → **Account**: make a new one, then **Revoke** the old one |
| An environment's link secret | **Settings → Environments → Edit → Replace every link in this environment**. Old links stop working |
| One entity's app link | The entity's page → **App link** → **Replace link** |
| A single sign-on client secret | **Settings → Single Sign-On → Edit**. On a connection that requires single sign-on, this turns the requirement off until a new **Test sign-in** ([Single Sign-On](/operate/single-sign-on#test-sign-in-and-editing)) |
| `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` | In the provider, then in the environment, and restart |
| The Cloudflare token | **Settings → CDN**, or `CF_API_TOKEN` and a restart |
| A webhook out's signing secret | **New secret** in the webhook's drawer, on the **Webhooks** page. It is shown once |
| A webhook in's address | **New address** in the webhook's drawer. The old address stops at once |
| The metrics token | `FF_METRICS_TOKEN` and a restart; then your scraper's |

### Keep secrets out of logs

- **The setup link** is in the server's log at every start until the admin account exists. Make the account right
  after the first start, and limit who can read the logs until then.
- **CDN file addresses** carry each entity's link secret. Load balancer and CDN access logs record them: treat those
  logs as secret.
- **`--token`** on `companyflags mcp` and `companyflags flags` shows the token in the computer's process list. Use
  `COMPANYFLAGS_TOKEN` instead on a shared computer.
- **The migrate step's secret** holds the address of the role that changes the schema. Limit who may start the
  migrate job or task: starting it grants the use of its secrets.

## Integrations

Without a config file's `plugins` list, these variables decide which integrations run. With a list, the list
decides, and the variables only fill in the options of the integrations it names. See
[Integrations](/integrations/overview).

| Variable | In the config file | Default | What it does |
|---|---|---|---|
| `FF_INTEGRATIONS_OFF` | `plugins` | none | Comma-separated ids of default integrations to turn off, e.g. `mcp,webhooks`. An unknown id, or a part of the core, stops the start. |
| `FF_METRICS` | `metrics()` in `plugins` | `off` | `on` serves `/metrics` ([Metrics](/integrations/metrics)). |
| `FF_METRICS_TOKEN` | `metrics({ token })` | none: `/metrics` is open | The token a scraper sends to `/metrics` (`Authorization: Bearer …`). Set without `FF_METRICS=on` (and no `plugins` list), it stops the start. |
| `FF_WEBHOOK_ALLOWED_ORIGINS` | `webhooks({ allowedOrigins })` | none | Comma-separated origins on your own network that webhooks out may reach, e.g. `http://ci.internal:8080`. Without it, webhooks go to public addresses only ([Webhooks](/integrations/webhooks#where-they-can-go)). |

### CDN purge

How these are used is in [CDN Purge](/integrations/cdn-purge).

| Variable | In the config file | Default | What it does |
|---|---|---|---|
| `CF_ZONE_ID` | `cloudflare({ zoneId })` | none; else **Settings → CDN** | The Cloudflare zone (the domain's Zone ID) to purge after each publish. |
| `CF_API_TOKEN` | `cloudflare({ token })` | none; else **Settings → CDN** | A Cloudflare API token with only **Zone → Cache Purge → Purge** on that zone. |
| `FF_CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront({ distributionId })` | none | The CloudFront distribution to invalidate after each publish. AWS's usual credentials sign the calls. Setting it turns on the CloudFront purge. |
| `FF_CLOUD_CDN_PROJECT`, `FF_CLOUD_CDN_URL_MAP` | `cloudCdn({ project, urlMap })` | none | The Google Cloud project and the URL map to invalidate after each publish. Setting both turns on the Cloud CDN purge; one alone stops the start. |
| `FF_CLOUD_CDN_HOST` | `cloudCdn({ host })` | every host of the URL map | Only this host's files. |

- Cloudflare needs both values. When they are set they win over what an admin saved in **Settings → CDN**, which then
  shows them read-only. The config file's options win over the variables.
- Each publish purges twice: at once, and again about 11 seconds later. With several servers, one still a round
  behind may refill the CDN with the old file right after the first purge; the second one drops it.

## Other

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `FF_CONFIG` | — | `./companyflags.config.ts` | Another config file to read, in a folder where `companyflags/config` resolves. A named file that is missing, or can't import it, stops the start. |
| `FF_PUBLISH_LOG_DAYS` | `retention.publishLogDays` | `30` | Days the publish log keeps a publish (and its CDN purge). Each environment's newest stays. History is kept forever ([Monitoring → What grows](/operate/monitoring#what-grows)). |

## Read by Compose and the CLI

The server never reads these.

| Variable | Read by | What it does |
|---|---|---|
| `COMPANYFLAGS_VERSION` | Compose | The image tag to run, such as `0.9` ([Docker Compose](/deploy/docker-compose#run-it)). |
| `COMPANYFLAGS_BIND` | Compose | The host address port 8787 is published on. Default `127.0.0.1`. |
| `POSTGRES_PASSWORD` | Compose | The Postgres user's password, used when its volume is new. Compose builds `DATABASE_URL` from it. |
| `COMPANYFLAGS_URL` | The CLI | The server the `flags` and `mcp` commands talk to, instead of `--url` ([CLI](/reference/cli#over-http---url-and---token)). |
| `COMPANYFLAGS_TOKEN` | The CLI | The access token they send, instead of `--token`, so it stays out of the process list. |

## Example

```bash
NODE_ENV=production
PORT=8787
DATABASE_URL=postgres://flags:secret@db.example.com:5432/flags?sslmode=verify-full
FF_DB_POOL=10
FF_SECRET=<openssl rand -base64 32>
FF_PUBLIC_URL=https://flags.example.com
FF_TRUSTED_PROXIES=10.0.0.0/8
FF_SIGNUP_DOMAINS=acme.example
MICROSOFT_CLIENT_ID=<from Entra ID>
MICROSOFT_CLIENT_SECRET=<from Entra ID>
MICROSOFT_TENANT_ID=<your tenant ID>
CF_ZONE_ID=<32 hex characters>
CF_API_TOKEN=<token with Cache Purge only>
FF_METRICS=on
FF_METRICS_TOKEN=<openssl rand -hex 24>
```
