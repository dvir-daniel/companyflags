---
title: "Configuration"
description: "CompanyFlags reads its settings from two places when it starts:"
---

1. **`companyflags.config.ts`**, a typed file in the folder it runs in (optional);
2. **environment variables**, for whatever the file doesn't set.

Then come the defaults. Without a config file, the environment variables decide everything, as in the Docker image.
CompanyFlags doesn't read a `.env` file itself: set the variables in your container, your process manager or your
shell. The repository's [`.env.example`](https://github.com/dvir-daniel/companyflags/blob/main/.env.example)
lists the ones you are most likely to need.

## The config file

One file says how the server runs, the way Better Auth has its `auth.ts`. A config file looks like this
(`companyflags init` writes a commented one):

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';
import { cdnFiles, cloudflare, flagd, ofrep, webhooks } from 'companyflags/plugins';

export default defineConfig({
  database: { url: process.env.DATABASE_URL },          // or { dataDir: './data' }
  server: { port: 8787 },
  auth: { baseURL: 'https://flags.example.com' },      // Better Auth: secret, baseURL, providers, …
  plugins: [
    ofrep(),
    flagd(),
    cdnFiles(),
    cloudflare(),                                       // CF_ZONE_ID and CF_API_TOKEN, unless given here
    webhooks(),
  ],
});
```

The file's imports (`companyflags/config`, `companyflags/plugins`) must resolve from its folder: the clone's root,
or `/app` in the Docker image. A file anywhere else, `FF_CONFIG` naming one included, stops the start with a message
that says where it can go.

| Setting | Instead of | What it does |
|---|---|---|
| `database.url` | `DATABASE_URL` | A Postgres 15+ server. |
| `database.dataDir` | `FF_DATA_DIR` | Without a server: where embedded Postgres keeps its files. |
| `database.migrate` | `FF_MIGRATE` | `false` (`FF_MIGRATE=off`): the server doesn't apply migrations at the start, it only checks the schema has them ([Upgrading](/self-hosting/upgrading)). Default `true`. |
| `database.pool` | `FF_DB_POOL` | The most connections to a Postgres server, per instance. Default 10. |
| `retention.publishLogDays` | `FF_PUBLISH_LOG_DAYS` | Days the publish log keeps a publish (and its CDN purge). Default 30; each environment's newest stays. History is kept forever. |
| `server.port`, `server.host` | `PORT`, `HOST` | Where the server listens. |
| `auth` | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, the providers' variables, … | Sign-in with Better Auth: `secret`, `baseURL`, `google`, `github`, `microsoft`, `signupDomains`, `trustedOrigins`, `clientIp`, `rateLimit` ([below](#auth)). Each one left out comes from its variable. |
| `plugins` | — | What reads flags besides the console, and what runs after a publish. Left out: all of them. See [Plugins](/reference/plugins). |
| `appearance` | Settings → Appearance | The console's name, logo, icon, accent color, default look, notice, sign-in note and links. Set here, they can't be changed in the console. See [Appearance](/self-hosting/appearance). |

- The file is TypeScript, run by Node directly (type stripping): no build step. The npm package has the types. It can read `process.env`, so secrets stay in
  the environment.
- A setting the file leaves out, or sets to `undefined`, comes from its environment variable.
- The server looks for the file in the folder it starts in. `FF_CONFIG` names another one.
- In Docker, mount it at `/app/companyflags.config.ts`: `-v ./companyflags.config.ts:/app/companyflags.config.ts:ro`.
  It imports `companyflags/config` and `companyflags/plugins` from the server itself, so it stays in `/app`.
- The server says which file it read, and which plugins run, when it starts.

With the repository's `docker-compose.yml`, every variable in `.env` reaches the server. `DATABASE_URL` is set by the
Compose file itself and points at its Postgres.

### `auth`

Each field left out comes from its environment variable.

| Field | Type | Instead of | Example |
|---|---|---|---|
| `secret` | string | `BETTER_AUTH_SECRET` | Leave it to the variable, so the secret stays out of the file. |
| `baseURL` | string | `BETTER_AUTH_URL` | `baseURL: 'https://flags.example.com'` |
| `google` | `{ clientId, clientSecret }` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! }` |
| `github` | `{ clientId, clientSecret }` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | as `google` |
| `microsoft` | `{ clientId, clientSecret, tenantId? }` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | as `google`, plus `tenantId: process.env.MICROSOFT_TENANT_ID` |
| `signupDomains` | string[] | `FF_SIGNUP_DOMAINS` | `signupDomains: ['acme.example']` |
| `ssoSessionHours` | number | `FF_SSO_SESSION_HOURS` | `ssoSessionHours: 8` |
| `trustedOrigins` | string[] | `BETTER_AUTH_TRUSTED_ORIGINS` | `trustedOrigins: ['https://idp.internal.example.com']` |
| `clientIp` | `{ header?, trustedProxies? }` | `FF_CLIENT_IP_HEADER`, `FF_TRUSTED_PROXIES` | `clientIp: { trustedProxies: ['10.0.0.0/8'], header: 'x-real-ip' }` |
| `rateLimit` | boolean | `NODE_ENV` | Sign-in rate limits. From the environment: on unless `NODE_ENV` is `development` or `test`. |

A field set in the file replaces its variables as a whole: `clientIp: { header: 'x-real-ip' }` also drops
`FF_TRUSTED_PROXIES`, and the server then refuses to start (a header needs the proxies). Give both.

Whether the server runs as production comes from `NODE_ENV` only: `auth` has no `production`.

## What production needs

| Variable | Why |
|---|---|
| `NODE_ENV=production` | Requires `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`, and allows only `https` issuers for single sign-on. The Docker image sets it. |
| `BETTER_AUTH_SECRET` | Signs the session cookies, encrypts stored provider tokens and makes the [setup link](/self-hosting/sign-in#the-first-account). |
| `BETTER_AUTH_URL` | The address people open the console at. |
| `DATABASE_URL` | A Postgres 15+ server. Without it the data lives in an embedded database (see below). |

With `NODE_ENV=production`, the server refuses to start without `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL`, or with a
secret shorter than 32 characters, and says which one is wrong.

## Database

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | none | A Postgres 15 or later server, e.g. `postgres://user:pass@db.example.com:5432/flags?sslmode=verify-full`. When it is set, `FF_DATA_DIR` is ignored. |
| `FF_DB_POOL` | `10` | The most connections this server opens to Postgres. Each instance has its own pool. |
| `FF_MIGRATE` | `on` | `off`: don't apply migrations at the start, only check the schema has them (as `companyflags start --no-migrate`). |
| `FF_PUBLISH_LOG_DAYS` | `30` | Days the publish log keeps a publish. |
| `FF_DATA_DIR` | `./data` | Without `DATABASE_URL`: the folder of the embedded database (PGlite, Postgres compiled to run inside the process). The Docker image sets `/data/db`. |

- Only one process may open an embedded database folder. The server writes a lock file next to the folder (`./data`
  gets `./data.lock`) with its process ID and command. A second server on the same folder refuses to start. A lock
  left behind is taken over: by a process that has ended, by a hard stop (in Docker the next start is PID 1 again),
  or with a process ID that now runs another program.
- The first start creates the `btree_gist` extension. On a managed Postgres server the database user needs the right
  to create it, or create it once yourself.
- The embedded database is PGlite, pinned to one version, which embeds Postgres 18. A folder made by another Postgres
  major version isn't opened: the server says so and stops. [Backups](/self-hosting/backups) has the commands to back
  it up and to move to a Postgres server.

### Migrations

The schema is built and changed only by the numbered files in `server/migrations`. Every start applies the ones the
database doesn't have yet:

- each file runs once, in its own transaction, in order;
- servers take a lock while migrating, so several can start at the same time;
- the schema only moves forward: nothing is ever undone or reset;
- each applied file's checksum is kept. The server refuses to start if an applied file has changed, or if the
  database has a migration this version doesn't know (an older version started after a newer one upgraded it),
  unless it runs with `--no-migrate` (below).

So going back to an older version means restoring the backup you took before upgrading. See
[Production checklist](/self-hosting/production).

To migrate before the new version starts, for example as a step of a deploy, run
[`companyflags migrate`](/reference/cli#migrate). `companyflags migrate --check` lists what an upgrade would
apply, and exits with 1 when something is pending. Then start the servers with `--no-migrate` (or
`FF_MIGRATE=off`, `database.migrate: false`): they only check that the schema has every migration they need, may run
as a database role that can't change the schema, and keep running while a newer version's migrations are applied.
See [Upgrading](/self-hosting/upgrading).

## Server

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | The port the server listens on. If something already listens there, the server stops with a message. |
| `FF_PORT_FILE` | none | A file the server writes the port it listens on to, once it listens (the Docker image's health check reads `/tmp/companyflags.port`, so it follows `server.port` in a config file). |
| `HOST` | `0.0.0.0` | The address it listens on. `127.0.0.1` keeps it to this machine, e.g. behind a proxy on the same host. |
| `NODE_ENV` | none | `production` for real use (see above). Anything else is development mode. `development` and `test` also turn off sign-in rate limits. |
| `FF_TRUSTED_PROXIES` | none | Your proxies' addresses or ranges, comma-separated (`10.0.0.0/8`). For sign-in rate limits and the change-event streams' per-client limit, a connection from one of them is believed about the client's address: `X-Forwarded-For`, read from the right past the proxies, or `FF_CLIENT_IP_HEADER`. Any other connection counts as its own address. Behind a load balancer, set it: without it, every device counts as the load balancer's address. |
| `FF_CLIENT_IP_HEADER` | none | A header your proxy or CDN sets to the client's address (`cf-connecting-ip`, `x-real-ip`), read instead of `X-Forwarded-For`. Needs `FF_TRUSTED_PROXIES`: without it the server refuses to start. |
| `FF_EVENT_STREAMS_PER_ENVIRONMENT` | `10000` | The most change-event streams (OFREP's server-sent events) this server keeps open for one environment. At the limit, answers list no stream and providers poll instead (their `pollInterval`); a stream asked for anyway gets `429`. Each instance counts its own. |
| `FF_EVENT_STREAMS_PER_CLIENT` | `100` | The most it keeps open for one client address: the connection's, or what `FF_TRUSTED_PROXIES` says, as for sign-in rate limits. Many devices behind one office address count together. Behind a load balancer without `FF_TRUSTED_PROXIES`, every device has the load balancer's address, so only this many devices get streams on each instance: set it. |

Without either, rate limits and event streams count the connection's own address. The server refuses to start when an
entry in `FF_TRUSTED_PROXIES` isn't an address or a range, or when an `FF_EVENT_STREAMS_…` value isn't a whole number
above 0.

In development mode (no `NODE_ENV=production`):

- without `BETTER_AUTH_SECRET`, a secret is made on the first start and kept in the database, so sessions and the
  setup link survive restarts;
- without `BETTER_AUTH_URL`, sign-in works on any `localhost` or `127.0.0.1` address and port, and nowhere else;
- single sign-on issuers may be `http`.

Sign-in rate limits are on unless `NODE_ENV` is `development` or `test`. When they're off and `HOST` isn't a
loopback address, the server warns at start.

## Sign-in

See [Sign-in and single sign-on](/self-hosting/sign-in) for how these are used.

| Variable | Default | What it does |
|---|---|---|
| `BETTER_AUTH_SECRET` | made and kept in the database, outside production | Signs session cookies and encrypts provider tokens. Use at least 32 random characters: `openssl rand -base64 32`. Keep it the same across restarts and instances: a new secret signs everyone out. |
| `BETTER_AUTH_URL` | none | The console's address, e.g. `https://flags.example.com`. Sign-in only works from this address, and the single sign-on addresses shown in Settings are built from it. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | none | Comma-separated origins to trust besides the console, e.g. `https://idp.internal.example.com`. Needed for an identity provider on a private network: the server won't read the settings of an issuer on a private or loopback address unless its origin is here. |
| `FF_SIGNUP_DOMAINS` | none | Comma-separated email domains, e.g. `acme.example`. People who sign in with Google, GitHub or Microsoft with a confirmed email at one of these domains (the domain itself, not its subdomains) join without an invite, with the join role (Viewer unless an admin chose another). |
| `FF_SSO_SESSION_HOURS` | `12` | Where a single sign-on connection requires single sign-on, the most hours a session lasts. Then it ends, and signing in again asks the identity provider whether the person still works there. From 1 to 720. |

### Sign-in providers

Each provider is turned on only when both its ID and its secret are set.

| Variable | What it does |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Sign in with GitHub. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Sign in with Microsoft (Entra ID). |
| `MICROSOFT_TENANT_ID` | Default `common` (any Microsoft account). Set your directory's tenant ID to allow only your organization. |

At start the server logs the ways to sign in it has, e.g.
`sign-in with Better Auth: email and password, google`.

## CDN

| Variable | Default | What it does |
|---|---|---|
| `CF_ZONE_ID` | none | The Cloudflare zone (the domain's Zone ID) to purge after each publish. |
| `CF_API_TOKEN` | none | A Cloudflare API token with only **Zone → Cache Purge → Purge** on that zone. |

Both are needed. When they are set they win over what an admin saved in **Settings → CDN**, which then shows them
read-only. Without them an admin can set the zone and token in the console instead. `cloudflare({ zoneId, token })`
in the config file wins over the variables. See [CDN](/self-hosting/cdn).

Each publish purges twice: at once, and again about 11 seconds later. With several servers, one still a round behind
may refill the CDN with the old file right after the first purge; the second one drops it.

## Webhooks

| Variable | Default | What it does |
|---|---|---|
| `FF_WEBHOOK_ALLOWED_ORIGINS` | none | Comma-separated origins on your own network that webhooks out may reach, e.g. `http://ci.internal:8080`. Without it, webhooks go to public addresses only. `webhooks({ allowedOrigins })` in the config file wins over it. |

See [Webhooks](/guide/webhooks#where-they-can-go).

## Other

| Variable | Default | What it does |
|---|---|---|
| `FF_CONFIG` | `./companyflags.config.ts` | Another config file to read, in a folder where `companyflags/config` resolves. A named file that is missing, or can't import it, stops the start. |
| `FF_METRICS_TOKEN` | none | With the `metrics()` plugin: the token a scraper sends to `/metrics` (`Authorization: Bearer …`). |

For contributors: `FF_TEST_PG` points `pnpm test:pg` at a Postgres server for the test suite; the server itself
never reads it.

## Example

```bash
NODE_ENV=production
PORT=8787
DATABASE_URL=postgres://flags:secret@db.example.com:5432/flags?sslmode=verify-full
FF_DB_POOL=10
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://flags.example.com
FF_SIGNUP_DOMAINS=acme.example
MICROSOFT_CLIENT_ID=<from Entra ID>
MICROSOFT_CLIENT_SECRET=<from Entra ID>
MICROSOFT_TENANT_ID=<your tenant ID>
CF_ZONE_ID=<32 hex characters>
CF_API_TOKEN=<token with Cache Purge only>
```
