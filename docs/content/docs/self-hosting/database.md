---
title: "Database"
description: "Postgres for real use, the embedded database for trying it, and how to set up either one."
---

Every install needs a database, and everything CompanyFlags keeps is in it. Use Postgres for anything people depend
on. The embedded database is for trying it, in one container.

## Postgres

Postgres 15 or later; the project tests on 18. Name it in `DATABASE_URL` (or `database.url` in the config file):

```bash
DATABASE_URL=postgres://flags:<password>@db.example.com:5432/flags?sslmode=verify-full
```

When `DATABASE_URL` is set, `FF_DATA_DIR` is ignored. A managed server with a standby and point-in-time recovery is a
good fit. The settings are in [Configuration → Database](/self-hosting/configuration#database).

## The btree_gist extension

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

## Two roles: one that migrates, one that serves

With several instances, run migrations as their own step ([Upgrading](/self-hosting/upgrading#several-servers-or-a-rolling-upgrade)).
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

## TLS and certificate authorities

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

## Connection pool and budget

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
- The cloud guides give each platform's numbers: [AWS](/self-hosting/aws#database),
  [Google Cloud](/self-hosting/google-cloud#database), [Azure](/self-hosting/azure#database).

## The embedded database

Without `DATABASE_URL`, data goes to an embedded database: PGlite, Postgres compiled to run inside the process. It is
pinned to one version, which embeds Postgres 18. It lives in one folder: `FF_DATA_DIR` (`database.dataDir`), `./data`
by default and `/data/db` in the Docker image. Keep the folder on a persistent volume.

It is for trying CompanyFlags, in one container:

- Only one process may open the folder. Never run several containers on one volume.
- Don't run it where a deploy starts the new container before the old one stops (ECS, Cloud Run, Container Apps, a
  rolling update): the new one can't start. Use Postgres there.
- Stop the server with `SIGTERM`, never `SIGKILL` ([Monitoring → Shutdown](/self-hosting/monitoring#shutdown)).
- Back it up while the server is stopped ([Backups](/self-hosting/backups#the-embedded-database)).

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

## Moving to Postgres

To move from the embedded database to a Postgres server, with everything in it as it is (history, people, API keys,
app links and their secrets):

1. Make a new, empty database on a Postgres 15 or later server.
2. Stop the server, and back up its folder ([Backups](/self-hosting/backups#the-embedded-database)).
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
4. Set `DATABASE_URL` (or `database.url`) to the new database, keep `BETTER_AUTH_SECRET` as it was, and start the
   server.

Apps and backends keep working: their keys, app links and tokens are copied as they are. Keep the embedded folder
until you've checked the new database.

## Next

Put HTTPS in front: [Proxies and HTTPS](/self-hosting/proxies).
