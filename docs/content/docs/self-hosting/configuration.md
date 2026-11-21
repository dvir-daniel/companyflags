---
title: "Configuration"
description: "Every setting the server reads: its environment variable, its config-file key and its default."
---

This is the reference of every setting. Each row links to the page that explains it. For what a new install needs,
start with the [Self-Hosting Overview](/self-hosting/overview).

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
- `BETTER_AUTH_`, `GOOGLE_`, `GITHUB_` and `MICROSOFT_`: Better Auth, for sign-in;
- `CF_`: the `cloudflare()` plugin;
- `COMPANYFLAGS_`: Docker Compose or the CLI, never the server ([below](#read-by-compose-and-the-cli));
- unprefixed: `DATABASE_URL`, `PORT`, `HOST`, `NODE_ENV`, and AWS's and Google's own credentials for the purge plugins.

## The config file

One file says how the server runs, the way Better Auth has its `auth.ts`:

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';
import { cdnFiles, cloudflare, flagd, mcp, ofrep, webhooks } from 'companyflags/plugins';

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
- The server says which file it read, and which plugins run, when it starts.

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
| `auth` | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, the providers' variables, … | Sign-in with Better Auth: [below](#sign-in). Each field left out comes from its variable. |
| `retention` | `FF_PUBLISH_LOG_DAYS` | How long the publish log keeps a publish: [below](#other). |
| `plugins` | — | What reads flags besides the console, and what runs after a publish. Left out: the six in `defaultPlugins()`; `metrics()`, `cloudfront()` and `cloudCdn()` run only when listed. See [Plugins](/reference/plugins). |
| `appearance` | Settings → Appearance | The console's name, logo, icon, accent color, default look, notice, sign-in note and links. Set here, they can't be changed in the console. See [Appearance](/self-hosting/appearance). |

## Database

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | `database.url` | none | A Postgres 15 or later server, e.g. `postgres://user:pass@db.example.com:5432/flags?sslmode=verify-full`. When it is set, `FF_DATA_DIR` is ignored ([Database](/self-hosting/database#postgres)). |
| `FF_DATA_DIR` | `database.dataDir` | `./data`; the Docker image sets `/data/db` | Without `DATABASE_URL`: the folder of the embedded database ([Database → The embedded database](/self-hosting/database#the-embedded-database)). |
| `FF_DB_POOL` | `database.pool` | `10` | The most connections this instance opens to Postgres, from 1 to 1000. Each instance has its own pool ([Database → Connection pool and budget](/self-hosting/database#connection-pool-and-budget)). |
| `FF_DATABASE_CA_FILE` | `database.caFile` | none | A PEM file of the certificate authorities the database's certificate is checked against, e.g. Amazon RDS's global bundle ([Database → TLS](/self-hosting/database#tls-and-certificate-authorities)). |
| `FF_MIGRATE` | `database.migrate` | `on` (`true`) | `off` (`false`): don't apply migrations at the start, only check the schema has them, as `companyflags start --no-migrate` ([Upgrading](/self-hosting/upgrading#how-migrations-work)). |

## Server

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `PORT` | `server.port` | `8787` | The port the server listens on. If something already listens there, the server stops with a message. |
| `HOST` | `server.host` | `0.0.0.0` | The address it listens on. `127.0.0.1` keeps it to this machine, e.g. behind a proxy on the same host. |
| `FF_PORT_FILE` | — | set by the image: `/tmp/companyflags.port` | A file the server writes the port it listens on to, once it listens. The image's health check reads it, so it follows `server.port` ([Monitoring](/self-hosting/monitoring#health-checks)). |
| `FF_KEEPALIVE_SECONDS` | `server.keepAliveSeconds` | `65` | Seconds an idle connection stays open, from 1 to 3600. Keep it above your load balancer's idle timeout ([Proxies and HTTPS → Timeouts](/self-hosting/proxies#timeouts-and-body-sizes)). |
| `NODE_ENV` | — (environment only) | none; the image sets `production` | `production` for real use: it requires `BETTER_AUTH_SECRET` (at least 32 characters) and `BETTER_AUTH_URL`, says which one is wrong, and allows only `https` issuers for single sign-on. Anything else is development mode. `development` and `test` also turn off sign-in rate limits. |
| `FF_TRUSTED_PROXIES` | `auth.clientIp.trustedProxies` | none | Your proxies' addresses or ranges, comma-separated (`10.0.0.0/8`). From them only, the server believes `X-Forwarded-For` or `FF_CLIENT_IP_HEADER` about the client's address. Sign-in and the change-event streams both read it ([Proxies and HTTPS → Client addresses](/self-hosting/proxies#client-addresses)). |
| `FF_CLIENT_IP_HEADER` | `auth.clientIp.header` | none | A header your proxy or CDN sets to the client's address (`cf-connecting-ip`, `x-real-ip`), read instead of `X-Forwarded-For`. Needs `FF_TRUSTED_PROXIES`: without it the server refuses to start. |
| `FF_EVENT_STREAMS_PER_ENVIRONMENT` | — | `10000` | The most change-event streams (OFREP's server-sent events) this instance keeps open for one environment. At the limit, answers list no stream and providers poll instead (their `pollInterval`); a stream asked for anyway gets `429`. Each instance counts its own. |
| `FF_EVENT_STREAMS_PER_CLIENT` | — | `100` | The most it keeps open for one client address: the connection's, or what `FF_TRUSTED_PROXIES` says. Many devices behind one office address count together. |

Without `FF_TRUSTED_PROXIES`, rate limits and event streams count the connection's own address. The server refuses to
start when an entry in `FF_TRUSTED_PROXIES` isn't an address or a range, or when an `FF_EVENT_STREAMS_…` value isn't a
whole number above 0.

**Development mode** (no `NODE_ENV=production`):

- without `BETTER_AUTH_SECRET`, a secret is made on the first start and kept in the database, so sessions and the
  setup link survive restarts;
- without `BETTER_AUTH_URL`, sign-in works on any `localhost` or `127.0.0.1` address and port, and nowhere else;
- single sign-on issuers may be `http`.

Sign-in rate limits are on unless `NODE_ENV` is `development` or `test`. When they're off and `HOST` isn't a loopback
address, the server warns at start.

## Sign-in

How these are used is in [Sign-In](/self-hosting/sign-in) and [Single Sign-On](/self-hosting/single-sign-on).

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | `auth.secret` | made and kept in the database, outside production | Signs sessions, makes the setup link, and seals or encrypts the secrets kept for other systems. At least 32 random characters: `openssl rand -base64 32`. Leave it to the variable, so it stays out of the file ([Secrets](/self-hosting/secrets#better_auth_secret)). |
| `BETTER_AUTH_URL` | `auth.baseURL` | none | The console's address, e.g. `https://flags.example.com`. Sign-in only works from this address, and the setup link and the single sign-on addresses are built from it ([Proxies and HTTPS → The console's address](/self-hosting/proxies#the-consoles-address)). |
| `BETTER_AUTH_TRUSTED_ORIGINS` | `auth.trustedOrigins` | none | Comma-separated origins to trust besides the console, e.g. `https://idp.internal.example.com`. Needed for an identity provider on a private network ([Single Sign-On](/self-hosting/single-sign-on#an-identity-provider-on-a-private-network)). |
| `FF_SIGNUP_DOMAINS` | `auth.signupDomains` | none | Comma-separated email domains, e.g. `acme.example`. People who sign in with Google, GitHub or Microsoft with a confirmed email at one of these domains (the domain itself, not its subdomains) join without an invite, with the join role ([Sign-In → Who can join](/self-hosting/sign-in#who-can-join)). |
| `FF_SSO_SESSION_HOURS` | `auth.ssoSessionHours` | `12` | Where a connection requires single sign-on, the most hours a session lasts, from 1 to 720 ([Sign-In → Sessions](/self-hosting/sign-in#sessions)). |
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
| `MICROSOFT_TENANT_ID` | `auth.microsoft.tenantId` | `common` (any Microsoft account) | Your directory's tenant ID, to allow only your organization ([Sign-In](/self-hosting/sign-in#google-github-and-microsoft)). |

At start the server logs the ways to sign in it has, e.g. `sign-in with Better Auth: email and password, google`.

## CDN and purge plugins

How these are used is in [CDN → Purge on publish](/self-hosting/cdn#purge-on-publish).

| Variable | Plugin option | Default | What it does |
|---|---|---|---|
| `CF_ZONE_ID` | `cloudflare({ zoneId })` | none; else **Settings → CDN** | The Cloudflare zone (the domain's Zone ID) to purge after each publish. |
| `CF_API_TOKEN` | `cloudflare({ token })` | none; else **Settings → CDN** | A Cloudflare API token with only **Zone → Cache Purge → Purge** on that zone. |
| `FF_CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront({ distributionId })` | none | The CloudFront distribution to invalidate after each publish. AWS's usual credentials sign the calls. Read only while `cloudfront()` is listed. |
| `FF_CLOUD_CDN_PROJECT`, `FF_CLOUD_CDN_URL_MAP` | `cloudCdn({ project, urlMap })` | none | The Google Cloud project and the URL map to invalidate after each publish. Read only while `cloudCdn()` is listed. |
| `FF_CLOUD_CDN_HOST` | `cloudCdn({ host })` | every host of the URL map | Only this host's files. |

- Cloudflare needs both values. When they are set they win over what an admin saved in **Settings → CDN**, which then
  shows them read-only. The plugin's options win over the variables.
- `cloudfront()` and `cloudCdn()` aren't in `defaultPlugins()`: their variables only fill in options of a plugin your
  config file lists ([Plugins](/reference/plugins#cloudfrontoptions)).
- Each publish purges twice: at once, and again about 11 seconds later. With several servers, one still a round
  behind may refill the CDN with the old file right after the first purge; the second one drops it.

## Webhooks

| Variable | Plugin option | Default | What it does |
|---|---|---|---|
| `FF_WEBHOOK_ALLOWED_ORIGINS` | `webhooks({ allowedOrigins })` | none | Comma-separated origins on your own network that webhooks out may reach, e.g. `http://ci.internal:8080`. Without it, webhooks go to public addresses only ([Webhooks](/guide/webhooks#where-they-can-go)). |

## Metrics

| Variable | Plugin option | Default | What it does |
|---|---|---|---|
| `FF_METRICS_TOKEN` | `metrics({ token })` | none: `/metrics` is open | The token a scraper sends to `/metrics` (`Authorization: Bearer …`). Read only while `metrics()` is listed ([Monitoring → Metrics](/self-hosting/monitoring#metrics)). |

## Other

| Variable | Config key | Default | What it does |
|---|---|---|---|
| `FF_CONFIG` | — | `./companyflags.config.ts` | Another config file to read, in a folder where `companyflags/config` resolves. A named file that is missing, or can't import it, stops the start. |
| `FF_PUBLISH_LOG_DAYS` | `retention.publishLogDays` | `30` | Days the publish log keeps a publish (and its CDN purge). Each environment's newest stays. History is kept forever ([Monitoring → What grows](/self-hosting/monitoring#what-grows)). |

## Read by Compose and the CLI

The server never reads these.

| Variable | Read by | What it does |
|---|---|---|
| `COMPANYFLAGS_VERSION` | Compose | The image tag to run, such as `0.9` ([Docker](/self-hosting/docker#docker-compose-with-postgres)). |
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
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://flags.example.com
FF_TRUSTED_PROXIES=10.0.0.0/8
FF_SIGNUP_DOMAINS=acme.example
MICROSOFT_CLIENT_ID=<from Entra ID>
MICROSOFT_CLIENT_SECRET=<from Entra ID>
MICROSOFT_TENANT_ID=<your tenant ID>
CF_ZONE_ID=<32 hex characters>
CF_API_TOKEN=<token with Cache Purge only>
```
