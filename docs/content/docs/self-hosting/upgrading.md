---
title: "Upgrading"
description: "Upgrade one server or several, with migrations as their own step, and roll back by restoring a backup."
---

Every install upgrades. A new version may come with migrations: numbered changes to the database's schema. They only
move forward, so take a backup first ([Backups](/self-hosting/backups)): going back a version means restoring it.

## Before you upgrade

Read the [changelog](https://github.com/dvir-daniel/companyflags/blob/main/CHANGELOG.md): it says which migrations each
version brings, and what to do first.

| Upgrade | What to do |
|---|---|
| 0.8 → 0.9 | Stop every instance, then start them all on 0.9. 0.8 can't read the secrets 0.9 seals, and has no `--no-migrate`. From 0.9 on, rolling upgrades work |
| A release that moves the embedded database to another Postgres major version | Move to Postgres first ([Database → The embedded database](/self-hosting/database#the-embedded-database)). The changelog says when |

**Skipping versions.** A rolling upgrade goes one release line at a time (0.9 to 0.10, then 0.10 to 0.11), because
each release's migrations work with the version before it, not older ones. Stopping every instance first can go
forward any number of versions at once: the new version applies every migration it's missing, in order.

## How migrations work

The schema is built and changed only by the numbered files in `server/migrations`. Every start applies the ones the
database doesn't have yet:

- each file runs once, in its own transaction, in order;
- servers take a lock while migrating, so several can start at the same time;
- the schema only moves forward: nothing is ever undone or reset;
- each applied file's checksum is kept. The server refuses to start if an applied file has changed, or if the
  database has a migration this version doesn't know (an older version started after a newer one upgraded it),
  unless it runs with `--no-migrate` (below).

To migrate before the new version starts, for example as a step of a deploy, run
[`companyflags migrate`](/reference/cli#migrate). `companyflags migrate --check` lists what an upgrade would apply,
and exits with `1` when something is pending. Then start the servers with `--no-migrate` (or `FF_MIGRATE=off`, or
`database.migrate: false` in the config file). They only check that the schema has every migration they need, may run
as a database role that can't change the schema, and keep running while a newer version's migrations are applied.

## One server

1. Back up the database ([Backups](/self-hosting/backups)).
2. Stop the server and start the new version:

   ```bash tab="Compose"
   # in .env: COMPANYFLAGS_VERSION=0.9
   docker compose pull && docker compose up -d
   ```

   ```bash tab="docker run"
   docker pull ghcr.io/dvir-daniel/companyflags:0.9
   docker stop companyflags && docker rm companyflags
   docker run -d --name companyflags -p 127.0.0.1:8787:8787 -v companyflags:/data --env-file .env \
     ghcr.io/dvir-daniel/companyflags:0.9
   ```

   ```bash tab="From source"
   git fetch --tags && git checkout v0.9.0
   pnpm install
   pnpm serve
   ```

It applies the new migrations when it starts, then serves. Start it with the same `.env` and the same volume, so it
keeps `BETTER_AUTH_SECRET` and its data.

## Several servers, or a rolling upgrade

When several instances share a Postgres server, or your platform replaces them one at a time (Kubernetes, most PaaS),
make the migrations a step of their own:

1. Back up the database.
2. Run the new version's `companyflags migrate`, once (a Kubernetes Job, or a step of the deploy before the new
   instances start). It can run as a database role that may change the schema
   ([Database → Two roles](/self-hosting/database#two-roles-one-that-migrates-one-that-serves)).
3. Start the new instances with `companyflags start --no-migrate` (or `FF_MIGRATE=off`, or `database.migrate: false`
   in the config file). They don't migrate: they check that the schema has every migration they need, and stop if it
   doesn't. So the server itself can run as a role that may only read and write rows.
4. Replace the old instances one at a time.

While that happens, old and new instances serve side by side. **Each release's migrations work with the version
before it**: they add tables and columns and loosen rules, and a change that would break the version before (a
rename, a dropped column) is split over two releases, adding first and removing in the next. So an old instance
started with `--no-migrate` keeps running, and restarting, on the upgraded schema: it logs a warning that the
database has a newer version's migrations. Upgrade every instance before the next upgrade.

A server that migrates at start (the default) refuses to start on a database that has migrations it doesn't know.
That keeps an old version from running on a schema it was never tested with when nobody planned it, which is why a
rolling upgrade uses `--no-migrate`. A platform that rolls back to an older version needs that version started with
`--no-migrate` too.

```yaml
# Kubernetes: the migration as a Job, then the servers without migrating
apiVersion: batch/v1
kind: Job
metadata: { name: companyflags-migrate-0-9-0 }
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/dvir-daniel/companyflags:0.9.0
          command: ["companyflags", "migrate"]
          envFrom: [{ secretRef: { name: companyflags-migrate } }]
---
# in the Deployment's container:
#   command: ["companyflags", "start", "--no-migrate"]
```

| On your platform | The migrate step |
|---|---|
| AWS | A one-off ECS task: [AWS → Upgrades](/self-hosting/aws#upgrades) |
| Google Cloud | A Cloud Run job: [Google Cloud → Upgrades](/self-hosting/google-cloud#upgrades) |
| Azure | A Container Apps job: [Azure → Upgrades](/self-hosting/azure#upgrades) |

## Rolling back

The schema doesn't go back, so rolling back means restoring the backup you took before the upgrade:

1. Stop every instance.
2. Restore the backup, into a new database or in place of the upgraded one ([Backups](/self-hosting/backups)).
3. Point the servers at the restored database, on the version you had before.
4. Keep the same `BETTER_AUTH_SECRET`.
5. Start them, and check that `GET /readyz` answers `200`.

Everything changed since the backup is lost: flag changes, history, people and keys made after it. Look at History in
the upgraded database first, and make those changes again.

## Checking an upgrade

- `companyflags migrate --check` lists the migrations an upgrade would apply, and exits with `1` when there are some.
- `companyflags --version`, the first line of the server's log and `GET /healthz` say which version runs.
- `GET /readyz` answers `200` once the instance can serve, and `failing` is empty once every environment publishes
  ([Monitoring → Health checks](/self-hosting/monitoring#health-checks)).

## Next

Review what apps, backends and people can see and do: [Security model](/guide/security).
