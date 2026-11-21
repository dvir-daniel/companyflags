---
title: "Docker"
description: "CompanyFlags is one image: the server, the console and the CDN files. It needs Postgres for real use, and runs on its own embedded database for trying it."
---

```text
ghcr.io/dvir-daniel/companyflags:<version>     e.g. 0.9.0, 0.9, latest
```

Each release tag `vX.Y.Z` publishes `X.Y.Z`, `X.Y` and `latest` (not for a pre-release such as `v1.0.0-rc.1`). Pin a
version in production: `X.Y` gets the fixes of that release line, `latest` moves to every new release.

Images are built for `linux/amd64` and `linux/arm64`. The container listens on port 8787, runs as the unprivileged
`node` user, and has a health check (`/healthz`, on the port the server listens on, also one set in a config file).

## Docker Compose with Postgres

The repository's [docker-compose.yml](https://github.com/dvir-daniel/companyflags/blob/main/docker-compose.yml)
runs CompanyFlags with Postgres 18. It reads its secrets from a `.env` file beside it, and won't start without them:

```bash
curl -O https://raw.githubusercontent.com/dvir-daniel/companyflags/main/docker-compose.yml
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose up -d
```

Then make the admin account with the setup link the server prints:

```bash
docker compose logs companyflags
```

```text
[companyflags] nobody has an account yet: make the admin account at http://localhost:8787/api/setup/<secret>
```

Open the link and create the account. Only that link can make the first account, and it stops working once it
exists. The server prints it at every start until then. See
[Sign-in → The first account](/self-hosting/sign-in#the-first-account).

Add settings to `.env` (see [Configuration](/self-hosting/configuration)). At least set `BETTER_AUTH_URL` to the
address people open the console at, such as `https://flags.example.com`. The Compose file reads these too:

| In `.env` | What it does | Default |
|---|---|---|
| `BETTER_AUTH_SECRET` | Signs sessions and makes the setup link | Required |
| `POSTGRES_PASSWORD` | The Postgres user's password, used when its volume is new | Required |
| `COMPANYFLAGS_VERSION` | The image tag to run, such as `0.9` or `0.9.0` | The latest release when the file was written |
| `COMPANYFLAGS_BIND` | The address port 8787 listens on | `127.0.0.1`: this machine only |

The port listens on this machine only, for a proxy in front of it (TLS, your domain). To open it to the network
without one, set `COMPANYFLAGS_BIND=0.0.0.0`.

Postgres sets the password once, when its volume is new. To change it later, change it in Postgres too
(`docker compose exec postgres psql -U companyflags -c "ALTER USER companyflags PASSWORD '…'"`), then in `.env`.
Coming from the older Compose file, which had the password `companyflags` built in: put
`POSTGRES_PASSWORD=companyflags` in `.env`, or change it as above.

## One container

With your own Postgres:

```bash
docker run -d --name companyflags -p 8787:8787 \
  -e DATABASE_URL="postgres://user:password@db.example.com:5432/flags?sslmode=verify-full" \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=https://flags.example.com \
  ghcr.io/dvir-daniel/companyflags:0.9
```

Without `DATABASE_URL`, data goes to an embedded Postgres in `/data/db`. Mount a volume there to keep it:

```bash
docker run -d --name companyflags -p 8787:8787 -v companyflags:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" -e BETTER_AUTH_URL=http://localhost:8787 \
  ghcr.io/dvir-daniel/companyflags:0.9
```

`docker logs companyflags` shows the setup link for the admin account.

:::warning[The embedded database is for trying it and small setups]
It is for one container only: never run several on one volume. A second container on it refuses to start, with
"the embedded database is open in another container", while the first one runs (the lock file, `/data/db.lock`, says
which container has it, and when it was last seen). For several containers, or a platform that starts the new one
before the old one stops, use Postgres, with backups (see the [production checklist](/self-hosting/production)).
:::

Keep the same `BETTER_AUTH_SECRET` across restarts and upgrades: it signs sessions, so a new one signs everyone out.

A managed Postgres whose certificate comes from its cloud's own authority (Amazon RDS) needs that authority's
certificates in the container. Mount them and name the file:

```bash
curl -fsSo rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
docker run -d --name companyflags -p 8787:8787 \
  -v ./rds-global-bundle.pem:/etc/ssl/rds-global-bundle.pem:ro \
  -e FF_DATABASE_CA_FILE=/etc/ssl/rds-global-bundle.pem \
  -e DATABASE_URL="postgres://user:password@flags.xxxx.eu-west-1.rds.amazonaws.com:5432/flags?sslmode=verify-full" \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=https://flags.example.com \
  ghcr.io/dvir-daniel/companyflags:0.9
```

## Upgrading

1. Back up the database. With Compose's Postgres, from its own container (the server's image has no `pg_dump`):
   `docker compose exec postgres pg_dump -Fc -U companyflags companyflags > companyflags.dump`. With the embedded
   database, stop the server and back up its volume:
   `docker stop companyflags && docker run --rm -v companyflags:/data ghcr.io/dvir-daniel/companyflags:0.9 companyflags backup /data/backup`.
2. Pull the new image and restart the container. With Compose, set `COMPANYFLAGS_VERSION` in `.env` to the new
   version, then `docker compose pull && docker compose up -d`.

The server applies new migrations at start, each once, in order, under a lock, so several containers can start
together. The schema only moves forward: to go back a version, restore the backup. For a rolling upgrade, see
[Upgrading](/self-hosting/upgrading).

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

## Health checks

| Path | Answers |
|---|---|
| `GET /healthz` | `200 {"ok":true,"version":"…"}` while the process runs |
| `GET /readyz` | `200` while this instance can serve, with the environments whose publish fails in `failing`; `503` when the database doesn't answer ([Production](/self-hosting/production#5-health-checks)) |

On `SIGTERM` the server stops taking requests, lets open ones finish and closes the database before it exits.
