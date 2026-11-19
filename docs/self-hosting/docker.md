# Docker

CompanyFeatures is one image: the server, the console and the app files. It needs Postgres for real use, and runs on
its own embedded database for trying it.

```text
ghcr.io/dvir-daniel/companyfeatures:<version>     e.g. 0.1.0, 0.1, latest
```

Images are built for `linux/amd64` and `linux/arm64`. The container listens on port 8787, runs as the unprivileged
`node` user, and has a health check (`/healthz`).

## Docker Compose with Postgres

The repository's [docker-compose.yml](https://github.com/dvir-daniel/companyfeatures/blob/main/docker-compose.yml)
runs CompanyFeatures with Postgres 18:

```bash
curl -O https://raw.githubusercontent.com/dvir-daniel/companyfeatures/main/docker-compose.yml
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
docker compose up -d
```

Open <http://localhost:8787> and create the admin account right away: until it exists, whoever reaches the sign-in
page first becomes the admin.

Add settings to `.env` (see [Configuration](/self-hosting/configuration)). At least set `BETTER_AUTH_URL` to the
address people open the console at, such as `https://flags.example.com`.

## One container

With your own Postgres:

```bash
docker run -d --name companyfeatures -p 8787:8787 \
  -e DATABASE_URL="postgres://user:password@db.example.com:5432/flags?sslmode=verify-full" \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=https://flags.example.com \
  ghcr.io/dvir-daniel/companyfeatures:0.1
```

Without `DATABASE_URL`, data goes to an embedded Postgres in `/data/db`. Mount a volume there to keep it:

```bash
docker run -d -p 8787:8787 -v companyfeatures:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" -e BETTER_AUTH_URL=http://localhost:8787 \
  ghcr.io/dvir-daniel/companyfeatures:0.1
```

::: warning The embedded database is for trying it and small setups
It is one process's: run one container with it, never several on one volume. For production use Postgres, with
backups (see the [production checklist](/self-hosting/production)).
:::

Keep the same `BETTER_AUTH_SECRET` across restarts and upgrades: it signs sessions, so a new one signs everyone out.

## Upgrading

1. Back up the database.
2. Pull the new image and restart the container (`docker compose pull && docker compose up -d`).

The server applies new migrations at start, each once, in order, under a lock, so several containers can start
together. The schema only moves forward: to go back a version, restore the backup.

## Building the image yourself

```bash
git clone https://github.com/dvir-daniel/companyfeatures.git
cd companyfeatures
docker build -t companyfeatures .
```

## Health checks

| Path | Answers |
|---|---|
| `GET /healthz` | `200 {"ok":true}` while the process runs |
| `GET /readyz` | `200` once the database answers, `503` when it doesn't |

On `SIGTERM` the server stops taking requests, lets open ones finish and closes the database before it exits.
