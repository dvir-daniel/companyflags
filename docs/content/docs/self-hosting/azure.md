---
title: "Azure"
description: "Run CompanyFlags on Azure: Container Apps, Database for PostgreSQL Flexible Server, Key Vault, and Front Door for the CDN files only, with no purge on publish."
---

This page sets up CompanyFlags on Azure for production: two or more replicas, a managed Postgres, and a CDN that
answers apps' CDN files. It assumes you know the [production checklist](/self-hosting/production); it says only
what is different on Azure.

## What you build

```text
console, API, OFREP, streams ─► flags.example.com ─► Container Apps ingress ─► app companyflags, 2+ replicas, :8787
apps' CDN files ──────────────► cdn.flags.example.com ─► Front Door (/cdn/v1/flags/* only) ─► the same app
every replica, the migrate job ─► Database for PostgreSQL Flexible Server (TLS, verify-full)
secrets: Key Vault references, pinned versions          logs: Log Analytics
```

- **Compute: Container Apps.** It has startup, liveness and readiness probes, jobs for migrations, and a rolling
  revision. Use AKS only if you already run it. App Service has a fixed timeout and reports of buffered streams.
- **Database: Flexible Server.** The app takes a fixed `DATABASE_URL`, so use password roles, not Entra sign-in.
- **Front Door Standard** caches the CDN files only, on its own hostname. Everything else goes straight to Container
  Apps: Microsoft says Front Door doesn't support server-sent events.

## Compute: Container Apps

- **`--min-replicas 2`.** The default is 0. At 0 the background loop stops: no publishes, no scheduled changes, no
  streams, and a cold start can outlast Front Door's origin timeout.
- **A CPU scale rule**, not the default HTTP one. The HTTP rule counts requests per 15 seconds, and long-lived streams
  don't fit it. Use `cpu` at 70% utilization, or fixed replicas (min = max).
- **Single revision mode.** The old revision serves until the new one has the same replica count and passes its
  probes. Old and new overlap, which is safe because each release's migrations work with the version before.
- **Ingress:** external, `--transport http` (the server speaks HTTP/1.1), target port 8787. Premium ingress isn't
  needed.
- **Logs:** the server's lines are in `ContainerAppConsoleLogs_CL` and start with `[companyflags]`. The setup link is
  there until the admin account exists: make it right away, and limit who can read the workspace.

> **Check this on your setup:** Microsoft says only "Request time out is 240 seconds". It looks like an idle limit,
> which the 25-second heartbeat keeps open. Run `curl -N` on a stream through the Container Apps hostname for more than
> 5 minutes. If it is a hard cap, streams reconnect every 4 minutes.

## Database: Flexible Server

**Size.** General Purpose `Standard_D2ds_v5` (2 vCores, 844 user connections) for production, with zone-redundant
high availability if you need it. `B2s` (414) for small setups. Not `B1ms`: 35 user connections is less than three
replicas.

**TLS.** Azure requires it, and its root CAs are in Node's own store. Connect by the server's name and write
`verify-full` yourself (`pg` treats `require` as `verify-full` anyway, with a warning):

```text
DATABASE_URL=postgres://flags_app:<password>@flags-pg.postgres.database.azure.com:5432/flags?sslmode=verify-full
```

Don't pin intermediate CAs: Azure rotated them in 2026.

**`btree_gist` must be allowlisted** before it can be created:

```bash
az postgres flexible-server parameter set -g flags -s flags-pg -n azure.extensions --value BTREE_GIST
# then, as the admin, in the database flags:  CREATE EXTENSION btree_gist;
```

Create a `flags_owner` role for migrations and a `flags_app` role for the service, as on the
[AWS page](/self-hosting/aws#database-rds-for-postgresql).

**Connection budget.** Old and new revisions overlap during a deploy, so count both:

```text
2 × max replicas × FF_DB_POOL + the job's pool + room for you  ≤  max user connections
2 × 4 × 10                    + 2              + 10            =  92
```

You don't need the built-in PgBouncer at these numbers. The app works with it in transaction mode (no `LISTEN`, no
session state), but run backups against port 5432, not 6432.

**Backups.** Point-in-time restore keeps 7 days by default, up to 35, and restores to a **new** server, without the
old one's parameters: allowlist `btree_gist` there again. Geo-redundant backup can only be chosen when you create the
server ([Backups](/self-hosting/backups)).

## Secrets

Key Vault references, read with a user-assigned identity that has **Key Vault Secrets User** on the vault:

- **Pin `BETTER_AUTH_SECRET` to a versioned URI.** A versionless reference picks up a new version within 30 minutes
  and restarts the revision on its own. A new secret signs everyone out, changes the setup link, and makes sealed
  values unreadable (webhooks' headers and signing secrets). Change it only on purpose, then save those values again.
  Keep it with your backups.
- A versionless reference is fine for `DATABASE_URL`, so a new password reaches the replicas.
- Keep `database-url` (`flags_app`) and `database-url-migrate` (`flags_owner`) apart. Only the job gets the owner's.
  Starting a job grants the use of its secrets: limit who may start it.

> **Check this on your setup:** whether the restart after a new secret version is rolling or all replicas at once.

## Client addresses

`flags.example.com` is a custom domain on the container app, with a managed certificate. The ingress appends the
client's address to `X-Forwarded-For` and connects from a private address:

```bash
FF_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7
# no FF_CLIENT_IP_HEADER
```

Requests through Front Door carry a Front Door address last, so they count as Front Door's. That is fine: only CDN
files go that way, and they have no per-client limits. Never read `X-Azure-ClientIP`: Front Door takes it from
`X-Forwarded-For`, which the client sends.

> **Check this on your setup:** the ingress's peer address. Run `az containerapp exec … --command "netstat -tn"`,
> then narrow `FF_TRUSTED_PROXIES` to that range.

Container Apps' ingress can't add HSTS. To add it, or a firewall, route the console's hostname through Front Door with
caching off, and test the console's live updates there first: it uses a stream too.

## Health checks

A replica that fails readiness on Container Apps is restarted. During a database outage every replica fails
`/readyz` at once and would lose the snapshots it still serves from. So:

```yaml
probes:
  - type: Startup              # first traffic waits until every snapshot is loaded
    httpGet: { path: /readyz, port: 8787 }
    initialDelaySeconds: 5
    periodSeconds: 5
    failureThreshold: 10
  - type: Liveness
    httpGet: { path: /healthz, port: 8787 }
    periodSeconds: 10
    failureThreshold: 3
  - type: Readiness
    httpGet: { path: /healthz, port: 8787 }
    periodSeconds: 5
    failureThreshold: 3
```

Watch `/readyz` for `failing` and `warnings` apart from the probes: an availability test, or the `metrics()` plugin
([Production](/self-hosting/production#5-health-checks)).

## Migrations

The app runs with `FF_MIGRATE=off`. A manual Container Apps job runs `companyflags migrate` with the owner's
address before each update ([Upgrading](/self-hosting/upgrading)):

```bash
az containerapp job update -g flags -n flags-migrate --image ghcr.io/dvir-daniel/companyflags:0.9
az containerapp job start  -g flags -n flags-migrate
az containerapp job execution list -g flags -n flags-migrate -o table     # wait for Succeeded
az containerapp update     -g flags -n companyflags --image ghcr.io/dvir-daniel/companyflags:0.9
```

## CDN: Front Door for the CDN files

Front Door Standard, with the container app as its origin, on `cdn.flags.example.com`:

- **Route `/cdn/v1/flags/*`:** caching on, "Honor origin"; **Ignore Query String**, so `?x=1` can't bypass the cache;
  compression off (the server already gzips).
- **No other route,** so apps reach only the CDN files through this hostname.
- **Origin group:** health probe `GET /healthz` over HTTPS, every 60 seconds.
- **The country:** a rule set on the CDN route, Modify response header, Overwrite `CF-IPCountry` with
  `{geo_country}`.

What Front Door does with the files' headers:

- it keeps a file for `s-maxage` (60 seconds);
- it always honours `no-store`, so a wrong link's `404` isn't kept;
- it ignores `CDN-Cache-Control`, `stale-while-revalidate` and `Cache-Tag`, and doesn't honour `stale-if-error`;
- it doesn't support ETags. It can revalidate with `Last-Modified`, which the files carry.

> **Check this on your setup:** that Front Door answers a repeat request with a `304` from `Last-Modified`, and
> whether its cache key varies by `Accept-Encoding`. Try `curl` with and without `--compressed`.

## No purge on publish

There is no purge plugin for Front Door, and one wouldn't help:

- it purges by path only, with no tags;
- a purge takes up to 10 minutes, longer than the 60-second cache;
- a new purge sent before the last one finishes may be rejected, so the second purge after a publish would fail.

So a change reaches apps within about a minute, as the cache expires on each point of presence. For an incident,
purge one environment by hand:

```bash
az afd endpoint purge -g flags --profile-name flags-afd --endpoint-name flags \
  --content-paths '/cdn/v1/flags/prod/*' --domains cdn.flags.example.com
```

A request holds at most 100 paths. Paths ignore case and query strings.

## Keep OFREP and streams on the direct hostname

Apps and backends use `https://flags.example.com` for OFREP: Container Apps, not Front Door. The stream address OFREP
gives is relative, so streams follow the base address. Through Front Door, a stream may be held back (Microsoft's only
statement is that it doesn't support server-sent events) or cut by the origin timeout, and providers stop polling
while they have a stream.

## Setup sketch

Check the flags against `--help` on your CLI's version.

```bash
RG=flags LOC=westeurope IMG=ghcr.io/dvir-daniel/companyflags:0.9

# Network: a subnet for Container Apps and one for Postgres
az network vnet create -g $RG -n vnet --address-prefixes 10.20.0.0/16 --subnet-name aca --subnet-prefixes 10.20.0.0/23
az network vnet subnet update -g $RG --vnet-name vnet -n aca --delegations Microsoft.App/environments
az network vnet subnet create -g $RG --vnet-name vnet -n pg --address-prefixes 10.20.4.0/24 \
  --delegations Microsoft.DBforPostgreSQL/flexibleServers

# Postgres
az postgres flexible-server create -g $RG -n flags-pg --tier GeneralPurpose --sku-name Standard_D2ds_v5 --version 17 \
  --storage-size 32 --backup-retention 14 --high-availability ZoneRedundant --vnet vnet --subnet pg \
  --admin-user pgadmin --admin-password "$PGADMIN_PW"
az postgres flexible-server parameter set -g $RG -s flags-pg -n azure.extensions --value BTREE_GIST
az postgres flexible-server db create -g $RG -s flags-pg -d flags
# as pgadmin, in flags: CREATE EXTENSION btree_gist; and the roles flags_owner and flags_app

# Key Vault and the identity
az identity create -g $RG -n flags-id
az keyvault create -g $RG -n flags-kv
# secrets better-auth-secret, database-url, database-url-migrate; "Key Vault Secrets User" for flags-id
AUTH_URI=$(az keyvault secret show --vault-name flags-kv -n better-auth-secret --query id -o tsv)   # versioned

# Container Apps
az containerapp env create -g $RG -n flags-env -l $LOC --infrastructure-subnet-resource-id $ACA_SUBNET_ID --zone-redundant

az containerapp job create -g $RG -n flags-migrate --environment flags-env --trigger-type Manual \
  --image $IMG --command companyflags --args migrate --replica-timeout 1800 --replica-retry-limit 0 \
  --cpu 0.5 --memory 1Gi --user-assigned $ID_RES \
  --secrets "db=keyvaultref:https://flags-kv.vault.azure.net/secrets/database-url-migrate,identityref:$ID_RES" \
            "auth=keyvaultref:$AUTH_URI,identityref:$ID_RES" \
  --env-vars DATABASE_URL=secretref:db BETTER_AUTH_SECRET=secretref:auth FF_DB_POOL=2

az containerapp create -g $RG -n companyflags --environment flags-env --image $IMG --user-assigned $ID_RES \
  --ingress external --target-port 8787 --transport http --cpu 1 --memory 2Gi --min-replicas 2 --max-replicas 4 \
  --secrets "db=keyvaultref:https://flags-kv.vault.azure.net/secrets/database-url,identityref:$ID_RES" \
            "auth=keyvaultref:$AUTH_URI,identityref:$ID_RES" \
  --env-vars DATABASE_URL=secretref:db BETTER_AUTH_SECRET=secretref:auth BETTER_AUTH_URL=https://flags.example.com \
    FF_MIGRATE=off FF_DB_POOL=10 FF_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7
# then: az containerapp update --yaml with the probes above and a cpu scale rule (utilization 70);
#       the custom domain flags.example.com with a managed certificate

# Front Door
az afd profile create -g $RG --profile-name flags-afd --sku Standard_AzureFrontDoor
az afd endpoint create -g $RG --profile-name flags-afd --endpoint-name flags
az afd origin-group create -g $RG --profile-name flags-afd --origin-group-name aca --probe-path /healthz \
  --probe-protocol Https --probe-request-type GET --probe-interval-in-seconds 60 \
  --sample-size 4 --successful-samples-required 3
az afd origin create -g $RG --profile-name flags-afd --origin-group-name aca --origin-name app \
  --host-name $ACA_FQDN --origin-host-header $ACA_FQDN --priority 1 --weight 1000 --enabled-state Enabled
az afd route create -g $RG --profile-name flags-afd --endpoint-name flags --route-name cdn --origin-group aca \
  --patterns-to-match "/cdn/v1/flags/*" --enable-caching true --query-string-caching-behavior IgnoreQueryString \
  --enable-compression false --rule-sets cdnfiles --https-redirect Enabled --forwarding-protocol HttpsOnly
# rule set cdnfiles: ModifyResponseHeader, Overwrite, CF-IPCountry = {geo_country}
# then: the custom domain cdn.flags.example.com on the endpoint
```

## Pitfalls

- **No embedded database on Container Apps.** Its disk is gone at each restart and new revision; Azure Files can't
  change file permissions after mounting; and the server refuses a second container on the same folder, which a
  rolling revision always starts. Use Flexible Server; `companyflags copy-to-postgres` moves an existing one
  ([Backups](/self-hosting/backups#moving-to-postgres)).
- **Scale to zero is the default.** Set `--min-replicas 2`.
- **`B1ms`** has 35 user connections: three replicas fill it.
- **Streams through Front Door** aren't supported. Keep OFREP on the direct hostname.
- **A versionless Key Vault reference** for `BETTER_AUTH_SECRET` signs everyone out the day someone adds a version.
- **A restore** makes a new server without the old parameters: `btree_gist` isn't allowlisted there.
- **Cost:** Front Door Premium's base fee is about ten times Standard's, and only Private Link or managed firewall
  rules need it. Replicas never reach the idle rate: open streams and the loop keep them active. Log only what you
  read: `ContainerAppHTTPLogs` and Front Door logs record every poll. Zone-redundant Postgres doubles its compute.
