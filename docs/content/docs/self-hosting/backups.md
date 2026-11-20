---
title: "Backups"
description: "Back up the database, put a backup back, and move from the embedded database to a Postgres server."
---

Everything CompanyFlags keeps is in its database: flags, history, people, keys, links and settings. A backup of the
database is a backup of the installation. Keep `BETTER_AUTH_SECRET` with it: the CDN token and the webhooks' headers
and signing secrets are sealed with a key from it, and sessions are signed with it.

## A Postgres server

```bash
companyflags backup                      # companyflags-backup-2026-11-20-1530.dump
companyflags backup flags.dump
```

It runs `pg_dump` on `DATABASE_URL`, in its custom format. `pg_dump` must be installed where you run it, the same
major version as the server or newer. The password goes to it in its environment, not on its command line.

To put a backup back, into a new, empty database:

```bash
pg_restore --no-owner -d postgres://user:pass@db.example.com:5432/flags flags.dump
```

A managed server's own backups (snapshots, point-in-time recovery) are as good, and run while the server serves.
Test a restore before you depend on it.

## The embedded database

```bash
companyflags backup                      # a folder: companyflags-backup-2026-11-20-1530
companyflags backup /backups/flags
```

The embedded database is one folder (`FF_DATA_DIR`). The backup is a copy of it, made while no server has it open:
stop the server first. The command refuses while a server runs on the folder (the lock file beside it says so). To
put it back, stop the server, move the folder aside and copy the backup into its place.

In Docker, with the volume `companyflags`:

```bash
docker stop companyflags
docker run --rm -v companyflags:/data ghcr.io/dvir-daniel/companyflags:0.9 companyflags backup /data/backup
docker start companyflags
```

The embedded database is PGlite, pinned to one version, which embeds Postgres 18. Postgres folders open only with the
major version that made them: when a CompanyFlags release moves to another major version, it says so in the
changelog, and it won't open an older folder. Move to a Postgres server (below) before such an upgrade, or with the
version you have.

## Moving to Postgres

The embedded database is for trying CompanyFlags and for small setups. To move to a Postgres server, with everything
in it as it is (history, people, API keys, app links and their secrets):

1. Make a new, empty database on a Postgres 15 or later server.
2. Stop the server, and back up its folder (above).
3. Copy it over:

   ```bash
   companyflags copy-to-postgres postgres://user:pass@db.example.com:5432/flags
   ```

   It migrates the new database, then copies every row, in one transaction: all of it or nothing. It refuses a
   database that has tables already. The embedded folder isn't changed.
4. Set `DATABASE_URL` (or `database.url` in the config file) to the new database, keep `BETTER_AUTH_SECRET` as it
   was, and start the server.

Apps and backends keep working: their keys, app links and tokens are copied as they are. Keep the embedded folder
until you've checked the new database.

In Docker, run it in a stopped server's volume:

```bash
docker stop companyflags
docker run --rm -v companyflags:/data ghcr.io/dvir-daniel/companyflags:0.9 \
  companyflags copy-to-postgres postgres://user:pass@db.example.com:5432/flags
```
