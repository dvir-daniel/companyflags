---
title: "Docker"
description: "Run CompanyFlags with Docker Compose and Postgres, or as one container."
---

This page puts CompanyFlags on one machine with Docker. Compose with Postgres is the way to run it for a team. One
container suits your own Postgres, or a try with the embedded database.

## Docker Compose with Postgres

The repository's [docker-compose.yml](https://github.com/dvir-daniel/companyflags/blob/main/docker-compose.yml)
runs CompanyFlags with Postgres 18. It reads its settings from a `.env` file beside it, and won't start without the
secrets.

1. Download the Compose file:

   ```bash
   curl -O https://raw.githubusercontent.com/dvir-daniel/companyflags/main/docker-compose.yml
   ```

2. Write `.env` and keep it private:

   ```bash
   echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
   echo "BETTER_AUTH_URL=http://localhost:8787" >> .env
   chmod 600 .env
   ```

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Make the admin account with the setup link the server prints:

   ```bash
   docker compose logs companyflags
   ```

   ```text
   [companyflags] nobody has an account yet: make the admin account at http://localhost:8787/api/setup/<secret>
   ```

   See [Sign-In → The first account](/self-hosting/sign-in#the-first-account).

The Compose file reads these from `.env`. Every other line in `.env` reaches the server too
([Configuration](/self-hosting/configuration)):

| In `.env` | What it does | Default |
|---|---|---|
| `BETTER_AUTH_SECRET` | Signs sessions and makes the setup link ([Secrets](/self-hosting/secrets)) | Required |
| `POSTGRES_PASSWORD` | The Postgres user's password, used when its volume is new | Required |
| `BETTER_AUTH_URL` | The address people open the console at. Change it to that address, such as `https://flags.example.com` | `http://localhost:8787` |
| `COMPANYFLAGS_VERSION` | The image tag to run, such as `0.9` or `0.9.0` | The latest release when the file was written |
| `COMPANYFLAGS_BIND` | The host address Compose publishes port 8787 on | `127.0.0.1`: this machine only |

`COMPANYFLAGS_BIND` is the host port Compose publishes; `HOST` is where the server listens inside the container. The
port listens on this machine only, for a proxy in front of it ([Proxies and HTTPS](/self-hosting/proxies)). To open
it to the network without one, set `COMPANYFLAGS_BIND=0.0.0.0`, and set `BETTER_AUTH_URL` to the address people
then type.

Coming from the older Compose file, which had the password `companyflags` built in: put
`POSTGRES_PASSWORD=companyflags` in `.env`, or change it ([Secrets → Changing a secret](/self-hosting/secrets#changing-a-secret)).

## One container

Write `.env` once, then start the container with it. Never make a secret or a password inline with `-e`: it ends up
in your shell's history, and a new one each time signs everyone out.

```bash tab="Your Postgres"
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
echo "BETTER_AUTH_URL=https://flags.example.com" >> .env
echo "DATABASE_URL=postgres://user:password@db.example.com:5432/flags?sslmode=verify-full" >> .env
chmod 600 .env
docker run -d --name companyflags -p 127.0.0.1:8787:8787 --env-file .env ghcr.io/dvir-daniel/companyflags:0.9
```

```bash tab="Embedded database"
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
echo "BETTER_AUTH_URL=http://localhost:8787" >> .env
chmod 600 .env
docker run -d --name companyflags -p 127.0.0.1:8787:8787 -v companyflags:/data --env-file .env \
  ghcr.io/dvir-daniel/companyflags:0.9
```

`docker logs companyflags` shows the setup link for the admin account.

Without `DATABASE_URL`, data goes to the embedded database in `/data/db`, kept in the `companyflags` volume. It is
for one container only: see [Database → The embedded database](/self-hosting/database#the-embedded-database).

A managed Postgres may need its cloud's certificates in the container: see
[Database → TLS and certificate authorities](/self-hosting/database#tls-and-certificate-authorities). To upgrade, see
[Upgrading](/self-hosting/upgrading).

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
  changes it. See [Monitoring → Health checks](/self-hosting/monitoring#health-checks).
- On `SIGTERM` it stops gracefully: see [Monitoring → Shutdown](/self-hosting/monitoring#shutdown).

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

Mount a config file at `/app/companyflags.config.ts`: see
[Configuration → The config file](/self-hosting/configuration#the-config-file).

## Next

Set up the database: [Database](/self-hosting/database).
