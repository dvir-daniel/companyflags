# Configuration

CompanyFeatures reads its settings from two places when it starts:

1. **`companyfeatures.config.ts`**, a typed file in the folder it runs in (optional);
2. **environment variables**, for whatever the file doesn't set.

Then come the defaults. Without a config file, the environment variables decide everything, as in the Docker image.
CompanyFeatures doesn't read a `.env` file itself: set the variables in your container, your process manager or your
shell. The repository's [`.env.example`](https://github.com/dvir-daniel/companyfeatures/blob/main/.env.example)
lists the ones you are most likely to need.

## The config file

One file says how the server runs, the way Better Auth has its `auth.ts`. `companyfeatures init` writes one:

```ts
// companyfeatures.config.ts
import { defineConfig } from 'companyfeatures/config';
import { appFiles, cloudflare, flagd, ofrep } from 'companyfeatures/plugins';

export default defineConfig({
  database: { url: process.env.DATABASE_URL },          // or { dataDir: './data' }
  server: { port: 8787 },
  auth: { baseURL: 'https://flags.example.com' },      // Better Auth: secret, baseURL, providers, …
  plugins: [ofrep(), flagd(), appFiles(), cloudflare()],
});
```

| Setting | Instead of | What it does |
|---|---|---|
| `database.url` | `DATABASE_URL` | A Postgres 15+ server. |
| `database.dataDir` | `FF_DATA_DIR` | Without a server: where embedded Postgres keeps its files. |
| `server.port`, `server.host` | `PORT`, `HOST` | Where the server listens. |
| `auth` | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, the providers' variables, … | Sign-in with Better Auth: `secret`, `baseURL`, `google`, `github`, `microsoft`, `signupDomains`, `trustedOrigins`, `clientIp`. Each one left out comes from its variable. |
| `plugins` | — | What reads flags besides the console, and what runs after a publish. Left out: all of them. See [Plugins](/reference/plugins). |

- The file is TypeScript, run by Node as the server is: no build step. It can read `process.env`, so secrets stay in
  the environment.
- A setting the file leaves out, or sets to `undefined`, comes from its environment variable.
- The server looks for the file in the folder it starts in. `FF_CONFIG` names another one.
- In Docker, mount it at `/app/companyfeatures.config.ts`: `-v ./companyfeatures.config.ts:/app/companyfeatures.config.ts:ro`.
  It imports `companyfeatures/config` and `companyfeatures/plugins` from the server itself, so it stays in `/app`.
- The server says which file it read, and which plugins run, when it starts.

::: warning Docker Compose passes only what it names
The repository's `docker-compose.yml` hands the container only the variables in its `environment:` block
(`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `FF_SIGNUP_DOMAINS`, `CF_ZONE_ID`, `CF_API_TOKEN`). To use
another one, such as a provider's keys or `BETTER_AUTH_TRUSTED_ORIGINS`, add it to that block as well as to `.env`.
:::

## What production needs

| Variable | Why |
|---|---|
| `NODE_ENV=production` | Turns on rate limits on sign-in, requires the two settings below, and allows only `https` issuers for single sign-on. The Docker image sets it. |
| `BETTER_AUTH_SECRET` | Signs the session cookies and encrypts stored provider tokens. |
| `BETTER_AUTH_URL` | The address people open the console at. |
| `DATABASE_URL` | A Postgres 15+ server. Without it the data lives in an embedded database (see below). |

With `NODE_ENV=production`, the server refuses to start without `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL`, and says
which one is missing.

## Database

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | none | A Postgres 15 or later server, e.g. `postgres://user:pass@db.example.com:5432/flags?sslmode=verify-full`. When it is set, `FF_DATA_DIR` is ignored. |
| `FF_DB_POOL` | `10` | The most connections this server opens to Postgres. Each instance has its own pool. |
| `FF_DATA_DIR` | `./data` | Without `DATABASE_URL`: the folder of the embedded database (PGlite, Postgres compiled to run inside the process). The Docker image sets `/data/db`. |

- Only one process may open an embedded database folder. The server writes a lock file next to the folder (`./data`
  gets `./data.lock`) with its process ID. A second server on the same folder refuses to start; a lock left by a
  process that has ended is taken over.
- The first start creates the `btree_gist` extension. On a managed Postgres server the database user needs the right
  to create it, or create it once yourself.

### Migrations

The schema is built and changed only by the numbered files in `server/migrations`. Every start applies the ones the
database doesn't have yet:

- each file runs once, in its own transaction, in order;
- servers take a lock while migrating, so several can start at the same time;
- the schema only moves forward: nothing is ever undone or reset;
- each applied file's checksum is kept. The server refuses to start if an applied file has changed, or if the
  database has a migration this version doesn't know (an older version started after a newer one upgraded it).

So going back to an older version means restoring the backup you took before upgrading. See
[Production checklist](/self-hosting/production).

To migrate before the new version starts, for example as a step of a deploy, run
[`companyfeatures migrate`](/reference/cli#migrate). `companyfeatures migrate --check` lists what an upgrade would
apply, and exits with 1 when something is pending.

## Server

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | The port the server listens on. If something already listens there, the server stops with a message. |
| `HOST` | `0.0.0.0` | The address it listens on. `127.0.0.1` keeps it to this machine, e.g. behind a proxy on the same host. |
| `NODE_ENV` | none | `production` for real use (see above). Anything else is development mode. |
| `FF_CLIENT_IP_HEADER` | none | A header your proxy or CDN sets to the client's address (`cf-connecting-ip`, `x-real-ip`), for sign-in rate limits. Without it and `FF_TRUSTED_PROXIES`, the connection's own address is used. |
| `FF_TRUSTED_PROXIES` | none | Your proxies' addresses or ranges, comma-separated (`10.0.0.0/8`): rate limits then read `X-Forwarded-For` past them. |

In development mode (no `NODE_ENV=production`):

- without `BETTER_AUTH_SECRET`, a secret is made on the first start and kept in the database, so sessions survive
  restarts;
- without `BETTER_AUTH_URL`, sign-in works on any `localhost` or `127.0.0.1` address and port, and nowhere else;
- sign-in has no rate limits, and single sign-on issuers may be `http`.

## Sign-in

See [Sign-in and single sign-on](/self-hosting/sign-in) for how these are used.

| Variable | Default | What it does |
|---|---|---|
| `BETTER_AUTH_SECRET` | made and kept in the database, outside production | Signs session cookies and encrypts provider tokens. Use at least 32 random characters: `openssl rand -base64 32`. Keep it the same across restarts and instances: a new secret signs everyone out. |
| `BETTER_AUTH_URL` | none | The console's address, e.g. `https://flags.example.com`. Sign-in only works from this address, and the single sign-on addresses shown in Settings are built from it. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | none | Comma-separated origins to trust besides the console, e.g. `https://idp.internal.example.com`. Needed for an identity provider on a private network: the server won't read the settings of an issuer on a private or loopback address unless its origin is here. |
| `FF_SIGNUP_DOMAINS` | none | Comma-separated email domains, e.g. `acme.example`. People who sign in with Google, GitHub or Microsoft with a confirmed email at one of these domains (the domain itself, not its subdomains) join as viewers without an invite. |

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
read-only. Without them an admin can set the zone and token in the console instead. See [CDN](/self-hosting/cdn).

## Other

| Variable | Default | What it does |
|---|---|---|

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
