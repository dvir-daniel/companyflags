---
title: "Docker Compose"
description: "Run CompanyFlags on one server: Docker Compose with Postgres, HTTPS with Caddy or nginx, the admin account, a CDN, backups and updates."
---

This page runs CompanyFlags on one server, from top to bottom. Docker Compose runs the server and Postgres 18; Caddy
or nginx ends HTTPS in front. It is the way to start for a team. For a cluster, see [Kubernetes](/deploy/kubernetes);
for managed containers, [AWS](/deploy/aws), [Google Cloud](/deploy/google-cloud) or [Azure](/deploy/azure).

## What you build

```text
console, API, OFREP, streams ─► flags.example.com ─────► Caddy or nginx (HTTPS) ─► CompanyFlags :8787 ─► Postgres
apps' CDN files ─────────────► cdn.flags.example.com ─► Cloudflare (only /cdn/v1/flags/*) ─┘   (all in Compose)
```

- **One image.** `ghcr.io/dvir-daniel/companyflags` holds the server, the console and the CDN files. It listens on
  port 8787 and runs as the unprivileged `node` user.
- **Postgres** holds all state: flags, history, people, keys and settings. Nothing is kept on the server's disk.
- **A background loop** runs every second: publishes, scheduled changes, webhooks and the second CDN purge.
- **A CDN is optional.** You need one only if apps read [CDN files](/reading/local-apps).

You need a Linux machine with Docker Engine and the Compose plugin, a DNS name such as `flags.example.com` that points
at it, and ports 80 and 443 open to the people and apps that use it.

## Run it

The repository's [docker-compose.yml](https://github.com/dvir-daniel/companyflags/blob/main/docker-compose.yml)
runs CompanyFlags with Postgres 18. It reads its settings from a `.env` file beside it, and won't start without the
secrets.

1. Download the Compose file, in a folder of its own such as `/srv/companyflags`:

   ```bash
   curl -O https://raw.githubusercontent.com/dvir-daniel/companyflags/main/docker-compose.yml
   ```

2. Write `.env` and keep it private:

   ```bash
   echo "FF_SECRET=$(openssl rand -base64 32)" > .env
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
   echo "FF_PUBLIC_URL=https://flags.example.com" >> .env
   chmod 600 .env
   ```

3. Start it:

   ```bash
   docker compose up -d
   ```

The Compose file reads these from `.env`. Every other line in `.env` reaches the server too
([Configuration](/reference/configuration)):

| In `.env` | What it does | Default |
|---|---|---|
| `FF_SECRET` | Signs sessions and makes the setup link ([Secrets](#secrets)) | Required |
| `POSTGRES_PASSWORD` | The Postgres user's password, used when its volume is new | Required |
| `FF_PUBLIC_URL` | The address people open the console at, such as `https://flags.example.com`. Sign-in works only from it | `http://localhost:8787` |
| `COMPANYFLAGS_VERSION` | The image tag to run, such as `0.9` or `0.9.0` | The latest release when the file was written |
| `COMPANYFLAGS_BIND` | The host address Compose publishes port 8787 on | `127.0.0.1`: this machine only |

`COMPANYFLAGS_BIND` is the host port Compose publishes; `HOST` is where the server listens inside the container. The
port listens on this machine only, for the proxy in front of it (next). To open it to the network without one, set
`COMPANYFLAGS_BIND=0.0.0.0`, and set `FF_PUBLIC_URL` to the address people then type. Use that only to try it: the
console needs `https`.

Coming from the older Compose file, which had the password `companyflags` built in: put
`POSTGRES_PASSWORD=companyflags` in `.env`, or change it ([The database password](#secrets)).

## HTTPS with Caddy or nginx

The server speaks plain HTTP. Add a proxy with a file named `docker-compose.override.yml` beside
`docker-compose.yml`: Compose reads both. The proxy reaches the server over Compose's network, and the server's own
port stays on `127.0.0.1`.

The proxy:

- ends TLS and adds HSTS (the server sends no `Strict-Transport-Security` header);
- sends the client's address in `X-Forwarded-For`;
- doesn't buffer answers, so the change-event streams flow;
- keeps a read timeout above 120 seconds, for the streams;
- lets bodies of 4 MB through, for imports;
- answers `404` for `/metrics` and `/readyz`, which are for your own monitoring only.

First, the proxy's own config, beside `docker-compose.yml`. Caddy gets a certificate by itself, sets
`X-Forwarded-For`, and has no read timeout by default. nginx needs your certificate in `./certs`.

```text tab="Caddy"
# Caddyfile
flags.example.com {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	request_body {
		max_size 4MB
	}
	@private path /metrics /readyz
	respond @private 404
	reverse_proxy companyflags:8787 {
		flush_interval -1
	}
}
```

```nginx tab="nginx"
# nginx.conf
server {
  listen 80;
  server_name flags.example.com;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  http2 on;
  server_name flags.example.com;
  ssl_certificate     /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  client_max_body_size 4m;
  location = /metrics { return 404; }
  location = /readyz  { return 404; }
  location / {
    proxy_pass http://companyflags:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 300s;
  }
}
```

Then the override, which starts the proxy and pins the Compose network's subnet, so the server can trust the proxy's
address:

```yaml tab="Caddy"
# docker-compose.override.yml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy:/data
    depends_on: [companyflags]
    restart: unless-stopped

networks:
  default:
    ipam:
      config:
        - subnet: 172.30.0.0/24

volumes:
  caddy:
```

```yaml tab="nginx"
# docker-compose.override.yml
services:
  nginx:
    image: nginx:1.27-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./certs:/etc/nginx/certs:ro          # fullchain.pem and privkey.pem
    depends_on: [companyflags]
    restart: unless-stopped

networks:
  default:
    ipam:
      config:
        - subnet: 172.30.0.0/24
```

Then add this line to `.env` (`FF_PUBLIC_URL` is there already), and run `docker compose up -d`:

```bash
FF_TRUSTED_PROXIES=172.30.0.0/24          # the subnet pinned in the override
```

`FF_TRUSTED_PROXIES` matters: sign-in rate limits and the change-event streams count each client's address. Without
it, every client looks like the proxy, everyone shares one sign-in limit, and only 100 devices get live updates
(`FF_EVENT_STREAMS_PER_CLIENT`). The server reads `X-Forwarded-For` only from the addresses it names
([Configuration → Client addresses](/reference/configuration#client-addresses)).

The server keeps an idle connection open 65 seconds (`FF_KEEPALIVE_SECONDS`). Keep any load balancer you put in
front of the proxy below that ([Timeouts and body sizes](/reference/configuration#timeouts-and-body-sizes)).

## The admin account

A new install has no accounts. The server prints a **setup link** at every start until the admin account exists:

```bash
docker compose logs companyflags
```

```text
[companyflags] nobody has an account yet: make the admin account at https://flags.example.com/api/setup/<secret>
```

Open it and create the admin account. Then invite everyone else from **Settings → People**.

:::warning[Make the account right after the first start]
Until the admin account exists, whoever has the link can make it, and the link is in the server's log at every
start. Make the account as soon as the server first starts, and limit who can read the logs until then.
:::

How people join, two-factor and Google, GitHub or Microsoft sign-in are in [Sign-In and People](/operate/sign-in);
your identity provider in [Single Sign-On](/operate/single-sign-on).

## The database

Postgres runs in Compose, on Compose's own network: its port isn't published, so it needs no TLS. Its data is in
the `postgres` volume. The server creates the `btree_gist` extension and applies every migration at the start.

To use a Postgres server of your own instead, see [One container](#one-container).

## Secrets

`.env` holds the two secrets: `FF_SECRET` and `POSTGRES_PASSWORD`. Keep it with `chmod 600`, and copy it off the
machine with your backups.

- **`FF_SECRET`** signs sessions and makes the setup link. It also seals the Cloudflare token, webhooks' secrets and
  two-factor secrets kept in the database. Make it once and never change it on a schedule: a new one signs everyone
  out and makes those values unreadable ([Configuration → Changing a secret](/reference/configuration#changing-a-secret)).
  A backup restored with another secret loses them.
- **`POSTGRES_PASSWORD`** is set in Postgres once, when its volume is new. To change it later, change it in Postgres,
  then in `.env`, then start again:

  ```bash
  docker compose exec postgres psql -U companyflags -c "ALTER USER companyflags PASSWORD '<new password>'"
  # set POSTGRES_PASSWORD in .env to the same password
  docker compose up -d
  ```

Never pass a secret inline with `-e`: it ends up in your shell's history.

## A CDN with Cloudflare

Skip this unless apps read [CDN files](/reading/local-apps). Apps that read flags with OFREP need no CDN.

Give the CDN its own hostname, `cdn.flags.example.com`, that serves only `/cdn/v1/flags/*`. OFREP, its streams and
the console stay on `flags.example.com`, straight to your proxy: a CDN that holds back a stream leaves apps on old
values ([Keep OFREP and streams off the CDN](/reference/configuration#keep-ofrep-and-streams-off-the-cdn)).

1. **DNS.** In Cloudflare, add `cdn.flags.example.com` pointing at the server, proxied. Set the zone's SSL mode to
   **Full (strict)**.
2. **The proxy** answers on the CDN host for the files only:

   ```text tab="Caddy"
   # add to the Caddyfile
   cdn.flags.example.com {
   	handle /cdn/v1/flags/* {
   		reverse_proxy companyflags:8787
   	}
   	handle {
   		respond 404
   	}
   }
   ```

   ```nginx tab="nginx"
   # add to nginx.conf, with a certificate for cdn.flags.example.com
   server {
     listen 443 ssl;
     server_name cdn.flags.example.com;
     ssl_certificate     /etc/nginx/certs/cdn-fullchain.pem;
     ssl_certificate_key /etc/nginx/certs/cdn-privkey.pem;
     location /cdn/v1/flags/ {
       proxy_pass http://companyflags:8787;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     }
     location / { return 404; }
   }
   ```

   > **Check this on your setup:** Caddy gets the CDN host's certificate over HTTP behind Cloudflare's proxy. If it
   > can't, use a Cloudflare origin certificate in the proxy instead.

3. **Cache the files.** Cloudflare doesn't cache JSON at an address without a file extension by default. In the zone,
   open **Caching → Cache Rules** and create a rule:
   - When: **URI Path** starts with `/cdn/v1/flags/`.
   - Then: **Eligible for cache**.
   - Edge TTL: **Use cache-control header if present, bypass cache if not**. The files say how long to keep them, and
     a wrong link's `404` says `no-store`, so it isn't kept.
   - Browser TTL: **Respect origin TTL**. Browsers then ask every time and get the change as soon as the CDN has it.

   Match only that path. Don't use "Cache Everything" on the whole host: the console's API must never be cached.
4. **The country.** Rules can check `geo.country`, and the app reads it from a `CF-IPCountry` header next to the file.
   Add **Rules → Transform Rules → Modify Response Header**: for **URI Path** starts with `/cdn/v1/flags/`, set the
   dynamic header `CF-IPCountry` to `ip.src.country`.
5. **Purge on publish.** Make a token in **My Profile → API Tokens → Create Token** with only **Zone → Cache Purge →
   Purge**, on this zone only. Your plan must offer purge by cache tag. Then either save it with the domain's Zone ID
   in **Settings → CDN** (admins), or put both in `.env` and run `docker compose up -d`:

   ```bash
   CF_ZONE_ID=<32 hex characters>
   CF_API_TOKEN=<token with Cache Purge only>
   ```

   Values in `.env` win over the console, which then shows them read-only. A token saved in the console is sealed
   with a key from `FF_SECRET`. A publish then purges only the files it changed, at once and again 11 seconds later.

Apps read CDN files from `https://cdn.flags.example.com`, at the path the app link gives. Only CDN files come through
Cloudflare, and they have no per-client limits, so `FF_TRUSTED_PROXIES` stays as it is. If you put Cloudflare in
front of `flags.example.com` too, add Cloudflare's published ranges to `FF_TRUSTED_PROXIES` and set
`FF_CLIENT_IP_HEADER=cf-connecting-ip`.

Check it: run this twice. The second answer should say `cf-cache-status: HIT`. Publish a change, and **Settings →
CDN** shows the purge went through.

```bash
curl -sI https://cdn.flags.example.com/cdn/v1/flags/prod/web | grep -iE 'cache-control|etag|cf-cache-status|cf-ipcountry'
```

Other CDNs, and what each does with the files' headers: [CDN Files](/integrations/cdn-files) and
[CDN Purge](/integrations/cdn-purge).

## Health checks and monitoring

- **The image's own health check** calls `/healthz` every 30 seconds, on the port the server listens on.
  `docker compose ps` shows `healthy`. `restart: unless-stopped` starts it again after a crash or a reboot.
- **Watch `/readyz`** from your monitoring, on the machine itself: `curl -s http://127.0.0.1:8787/readyz`. It answers
  `503` when the database doesn't answer. Alert when `failing` or `warnings` isn't empty
  ([Monitoring → Alerts](/operate/monitoring#alerts)).
- **Metrics** for Prometheus: add `FF_METRICS=on` and `FF_METRICS_TOKEN=$(openssl rand -hex 24)` to `.env`, and
  scrape `http://127.0.0.1:8787/metrics` with that token ([Metrics](/integrations/metrics)).
- **Logs:** `docker compose logs -f companyflags`. Its lines start with `[companyflags]`. Alert on
  `publishing … failed`.
- **Stopping:** `docker compose stop` sends `SIGTERM`, and the server stops gracefully within Docker's 10 seconds.

## Backups

The server's image has no `pg_dump`, so run it in the Postgres container:

```bash tab="Back up"
docker compose exec -T postgres pg_dump -Fc -U companyflags companyflags > companyflags-$(date +%F).dump
```

```bash tab="Restore"
docker compose stop companyflags
docker compose exec -T postgres dropdb -U companyflags companyflags
docker compose exec -T postgres createdb -U companyflags companyflags
docker compose exec -T postgres pg_restore --no-owner -U companyflags -d companyflags < companyflags-2026-11-20.dump
docker compose start companyflags
```

To back up every night, add a cron line on the machine (in the folder with `docker-compose.yml`):

```text
30 2 * * * cd /srv/companyflags && docker compose exec -T postgres pg_dump -Fc -U companyflags companyflags > backups/companyflags-$(date +\%F).dump
```

Copy the dumps and `.env` off the machine. A backup on the same disk goes with it. Now and then, restore one into a
test instance and check that `/readyz` answers `200` ([Backups → Testing a restore](/operate/backups#testing-a-restore)).

## Updates

A new version may bring migrations, which the server applies when it starts. They only move forward, so back up
first: going back a version means restoring that backup.

1. Read the [changelog](https://github.com/dvir-daniel/companyflags/blob/main/CHANGELOG.md) for what to do first.
2. Back up ([above](#backups)).
3. Set the new version in `.env`, then pull and start:

   ```bash
   # in .env: COMPANYFLAGS_VERSION=0.9
   docker compose pull && docker compose up -d
   ```

4. Check `curl -s http://127.0.0.1:8787/healthz`: it says the version.

One server stops before the new one starts, so it can skip versions: the new version applies every migration it's
missing, in order. To roll back, start the version you had on the backup you took, with the same `FF_SECRET`
([Upgrading → Rolling back](/operate/upgrading#rolling-back)).

## One container

For a Postgres server you already run, or to try it with the embedded database. Write `.env` once, then start the
container with it. Never make a secret or a password inline with `-e`: it ends up in your shell's history, and a new
one each time signs everyone out.

```bash tab="Your Postgres"
echo "FF_SECRET=$(openssl rand -base64 32)" > .env
echo "FF_PUBLIC_URL=https://flags.example.com" >> .env
echo "DATABASE_URL=postgres://user:password@db.example.com:5432/flags?sslmode=verify-full" >> .env
chmod 600 .env
docker run -d --name companyflags -p 127.0.0.1:8787:8787 --env-file .env ghcr.io/dvir-daniel/companyflags:0.9
```

```bash tab="Embedded database"
echo "FF_SECRET=$(openssl rand -base64 32)" > .env
echo "FF_PUBLIC_URL=http://localhost:8787" >> .env
chmod 600 .env
docker run -d --name companyflags -p 127.0.0.1:8787:8787 -v companyflags:/data --env-file .env \
  ghcr.io/dvir-daniel/companyflags:0.9
```

`docker logs companyflags` shows the setup link for the admin account. Put the same proxy in front, as
[above](#https-with-caddy-or-nginx), on the host's network.

**Your Postgres.** Postgres 15 or later. The user that migrates must be able to create `btree_gist`, or create it
once yourself: `CREATE EXTENSION IF NOT EXISTS btree_gist;`. Write `sslmode=verify-full`. A managed server whose
certificate comes from its cloud's own authority (Amazon RDS) needs that authority's certificates mounted and named in
`FF_DATABASE_CA_FILE` ([Configuration → TLS](/reference/configuration#tls-and-certificate-authorities)). Back it up
with `companyflags backup` from a host that has `pg_dump`, or the provider's snapshots
([Backups](/operate/backups#your-own-postgres-server)).

**The embedded database.** Without `DATABASE_URL`, data goes to the embedded database in `/data/db`, kept in the
`companyflags` volume. It is for one container only: never two containers on one volume, never `SIGKILL`, and back
it up while it is stopped ([Backups → The embedded database](/operate/backups#the-embedded-database)). Move to
Postgres before people depend on it: `companyflags copy-to-postgres` copies everything
([Configuration → Moving to Postgres](/reference/configuration#moving-to-postgres)).

To update one container:

```bash
docker pull ghcr.io/dvir-daniel/companyflags:0.9
docker stop companyflags && docker rm companyflags
docker run -d --name companyflags -p 127.0.0.1:8787:8787 -v companyflags:/data --env-file .env \
  ghcr.io/dvir-daniel/companyflags:0.9
```

Start it with the same `.env` and the same volume, so it keeps `FF_SECRET` and its data.

## Image tags

```text
ghcr.io/dvir-daniel/companyflags:<version>     e.g. 0.9.0, 0.9, latest
```

- Each release tag `vX.Y.Z` publishes `X.Y.Z`, `X.Y` and `latest` (not for a pre-release such as `v1.0.0-rc.1`).
- Pin `X.Y` in production: it gets the fixes of that release line, never a new schema. `latest` moves to every new
  release.
- Images are built for `linux/amd64` and `linux/arm64`.
- The container listens on port 8787 and runs as the unprivileged `node` user.
- Its health check calls `/healthz` on the port the server listens on, also when `server.port` in a config file
  changes it. See [Monitoring → Health checks](/operate/monitoring#health-checks).
- On `SIGTERM` it stops gracefully: see [Monitoring → Shutdown](/operate/monitoring#shutdown).

## Building the image yourself

```bash
git clone https://github.com/dvir-daniel/companyflags.git
cd companyflags
docker build -t companyflags .
```

To run your build with the Compose file, give it the image's name and a tag of its own:

```bash
docker build -t ghcr.io/dvir-daniel/companyflags:dev .
COMPANYFLAGS_VERSION=dev docker compose up -d
```

## A config file

You don't need one: every setting, integrations included, has an environment variable for `.env`. For what you want
in Git (the look, an integration of your own), mount one at `/app/companyflags.config.ts`. In
`docker-compose.override.yml`:

```yaml
services:
  companyflags:
    volumes:
      - ./companyflags.config.ts:/app/companyflags.config.ts:ro
```

See [Configuration → The config file](/reference/configuration#the-config-file).

## Checklist

- [ ] `.env` has `FF_SECRET` and `POSTGRES_PASSWORD`, with `chmod 600`, and a copy is kept off the machine.
- [ ] `FF_PUBLIC_URL` is the `https` address people type, and `COMPANYFLAGS_VERSION` pins an `X.Y` version.
- [ ] Caddy or nginx ends TLS with HSTS, and `FF_TRUSTED_PROXIES` is the pinned subnet.
- [ ] `/metrics` and `/readyz` answer `404` from outside, and port 8787 listens on `127.0.0.1` only.
- [ ] The admin account is made, and the log no longer prints the setup link.
- [ ] Single sign-on required with a break-glass admin, or two-factor required of admins
  ([Single Sign-On](/operate/single-sign-on#require-single-sign-on)).
- [ ] *Only if apps read CDN files:* Cloudflare caches only `/cdn/v1/flags/*`, and a publish purges it.
- [ ] Something watches `/readyz` and alerts on `failing` and `warnings`.
- [ ] A nightly backup runs, is copied off the machine, and a restore was tested.

Then go through the full [Production Checklist](/operate/production).
