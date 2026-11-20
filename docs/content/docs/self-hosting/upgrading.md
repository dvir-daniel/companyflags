---
title: "Upgrading"
description: "Upgrade one server or several, with the migrations as their own step, and roll an upgrade out while the version before keeps serving."
---

A new version may come with migrations: numbered changes to the database's schema. They only move forward, so take
a backup first ([Backups](/self-hosting/backups)): going back a version means restoring it. The changelog says which
migrations each version brings.

## One server

1. Back up the database.
2. Stop the server, start the new version.

It applies the new migrations when it starts, then serves.

## Several servers, or a rolling upgrade

When several instances share a Postgres server, or your platform replaces them one at a time (Kubernetes,
most PaaS), make the migrations a step of their own:

1. Back up the database.
2. Run the new version's `companyflags migrate`, once (a Kubernetes Job, or a step of the deploy before the new
   instances start). It can run as a database role that may change the schema.
3. Start the new instances with `companyflags start --no-migrate` (or `FF_MIGRATE=off`, or
   `database.migrate: false` in the config file). They don't migrate: they check that the schema has every migration
   they need, and stop if it doesn't. So the server itself can run as a role that may only read and write rows.
4. Replace the old instances one at a time.

While that happens, old and new instances serve side by side. **Each release's migrations work with the version
before it**: they add tables and columns and loosen rules, and a change that would break the version before (a
rename, a dropped column) is split over two releases, adding first and removing in the next. So an old instance
started with `--no-migrate` keeps running, and restarting, on the upgraded schema: it logs a warning that the
database has a newer version's migrations. Upgrade every instance before the next upgrade.

A server that migrates at start (the default) refuses to start on a database that has migrations it doesn't know.
That keeps an old version from running on a schema it was never tested with when nobody planned it, which is why a
rolling upgrade uses `--no-migrate`.

```yaml
# Kubernetes: the migration as a Job, then the servers without migrating
apiVersion: batch/v1
kind: Job
metadata: { name: companyflags-migrate-0-8-0 }
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/dvir-daniel/companyflags:0.9
          command: ["companyflags", "migrate"]
          envFrom: [{ secretRef: { name: companyflags } }]
---
# in the Deployment's container:
#   command: ["companyflags", "start", "--no-migrate"]
```

## Checking an upgrade

- `companyflags migrate --check` lists the migrations an upgrade would apply, and exits with `1` when there are some.
- `companyflags --version`, the first line of the server's log and `GET /healthz` say which version runs.
- `GET /readyz` answers `200` once every environment publishes ([Production](/self-hosting/production#5-health-checks)).
