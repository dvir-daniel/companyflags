---
title: "Backups"
description: "Back up the database, test a restore, and know what a backup holds."
---

Every install that people depend on needs backups. Back up before each upgrade too: the schema only moves forward,
so going back a version means restoring one.

## What a backup holds

Everything CompanyFlags keeps is in its database: flags, history, people, keys, links and settings. A backup of the
database is a backup of the installation. Keep `FF_SECRET` with it: some values in it are sealed with a key
from that secret, and it holds secrets of its own. See
[Configuration → What the database holds](/reference/configuration#what-the-database-holds).

## A managed database

A managed server's own backups (snapshots, point-in-time recovery) are as good as a dump, and run while the server
serves. Take a snapshot before each upgrade.

| Provider | Backups | Before an upgrade |
|---|---|---|
| Amazon RDS | Automated backups with point-in-time recovery | `aws rds create-db-snapshot` ([AWS → Upgrades](/deploy/aws#upgrades)) |
| Cloud SQL | Automated backups and point-in-time recovery; `--availability-type=REGIONAL` for a standby | `gcloud sql backups create` ([Google Cloud → Upgrades](/deploy/google-cloud#upgrades)) |
| Azure Flexible Server | Point-in-time restore keeps 7 days by default, up to 35. Geo-redundant backup can only be chosen when you create the server | Note the time you start: point-in-time restore goes back to it ([Azure → Upgrades](/deploy/azure#upgrades)) |

On Azure, a restore makes a **new** server, without the old one's parameters: allowlist `btree_gist` there again
([Configuration → The btree_gist extension](/reference/configuration#the-btree_gist-extension)).

## Postgres in Docker Compose

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

Copy the dumps and `.env` off the machine. A backup on the same disk goes with it.

## Your own Postgres server

`companyflags backup` runs `pg_dump` on `DATABASE_URL`, in its custom format. Run it on a host that has `pg_dump`, the
same major version as the server or newer: a clone of the repository, say. The Docker image has no `pg_dump`, so it
doesn't run there. The password goes to `pg_dump` in its environment, not on its command line.

```bash
companyflags backup                      # companyflags-backup-2026-11-20-1530.dump
companyflags backup flags.dump
```

To put a backup back, into a new, empty database:

```bash
pg_restore --no-owner -d postgres://user:pass@db.example.com:5432/flags flags.dump
```

## The embedded database

The embedded database is one folder (`FF_DATA_DIR`). The backup is a copy of it, made while no server has it open:
stop the server first. The command refuses while a server runs on the folder (the lock file beside it says so).

```bash
companyflags backup                      # a folder: companyflags-backup-2026-11-20-1530
companyflags backup /backups/flags
```

In Docker, with the volume `companyflags`, write the backup to a folder on the host:

```bash
docker stop companyflags
docker run --rm -v companyflags:/data -v ./backups:/backups ghcr.io/dvir-daniel/companyflags:0.9 \
  companyflags backup /backups/flags
docker start companyflags
```

Never write it into the data volume itself: a backup there is lost with the volume, and it isn't off the machine.
The `node` user in the container must be able to write to `./backups`.

To put it back, stop the server, move the folder aside and copy the backup into its place. The embedded database
opens only with the Postgres major version that made it: see
[Configuration → The embedded database](/reference/configuration#the-embedded-database).

## Testing a restore

A backup you haven't restored is a guess. Now and then:

1. Restore the latest backup into a new database.
2. Start a test instance on it, with the same `FF_SECRET` and `DATABASE_URL` pointing at the new database.
3. Check that `GET /readyz` answers `200` and that the flags are there.

## Next

Plan your upgrades: [Upgrading](/operate/upgrading).
