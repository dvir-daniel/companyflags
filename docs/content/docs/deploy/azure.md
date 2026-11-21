---
title: "Azure"
description: "Run CompanyFlags on Azure, top to bottom: Container Apps, Database for PostgreSQL Flexible Server, Key Vault, and Front Door for the CDN files only, with no purge on publish."
---

This recipe runs CompanyFlags on managed containers with two or more instances: Container Apps, Flexible Server, and
Front Door for the CDN files. Everything it needs is on this page. For one server, see
[Docker Compose](/deploy/docker-compose); for a cluster, [Kubernetes](/deploy/kubernetes).

## What you build

```text
console, API, OFREP, streams ─► flags.example.com ─► Container Apps ingress ─► app companyflags, 2+ replicas, :8787
apps' CDN files ──────────────► cdn.flags.example.com ─► Front Door (/cdn/v1/flags/* only) ─► the same app
every replica, the migrate job ─► Database for PostgreSQL Flexible Server (TLS, verify-full)
secrets: Key Vault references, pinned versions          logs: Log Analytics
```

- **Compute: Container Apps.** It has startup, liveness and readiness probes, jobs for migrations, and a rolling
  revision. Use AKS only if you already run it: then follow [Kubernetes](/deploy/kubernetes). App Service has a fixed
  timeout and reports of buffered streams.
- **Database: Flexible Server.** Postgres 15 or later. The app takes a fixed `DATABASE_URL`, so use password roles,
  not Entra sign-in.
- **Front Door Standard** caches the CDN files only, on its own hostname. Everything else goes straight to Container
  Apps.
- **One image, many replicas.** Container Apps pulls `ghcr.io/dvir-daniel/companyflags` as it is: no image of your
  own, and no config file. A publish reaches every replica in about a second. A background loop in each replica runs
  publishes, scheduled changes and webhooks every second, so replicas must never scale to zero.

## First deploy

Check the flags against `--help` on your CLI's version.

1. **Network.** A subnet for Container Apps and one for Postgres:

   ```bash
   RG=flags LOC=westeurope IMG=ghcr.io/dvir-daniel/companyflags:0.9
   az network vnet create -g $RG -n vnet --address-prefixes 10.20.0.0/16 --subnet-name aca --subnet-prefixes 10.20.0.0/23
   az network vnet subnet update -g $RG --vnet-name vnet -n aca --delegations Microsoft.App/environments
   az network vnet subnet create -g $RG --vnet-name vnet -n pg --address-prefixes 10.20.4.0/24 \
     --delegations Microsoft.DBforPostgreSQL/flexibleServers
   ```

2. **Database and roles.** The server, `btree_gist` allowlisted, the database, then, as `pgadmin`, the extension and
   the roles `flags_owner` and `flags_app` ([Database](#database)):

   ```bash
   az postgres flexible-server create -g $RG -n flags-pg --tier GeneralPurpose --sku-name Standard_D2ds_v5 --version 18 \
     --storage-size 32 --backup-retention 14 --high-availability ZoneRedundant --vnet vnet --subnet pg \
     --admin-user pgadmin --admin-password "$PGADMIN_PW"
   az postgres flexible-server parameter set -g $RG -s flags-pg -n azure.extensions --value BTREE_GIST
   az postgres flexible-server db create -g $RG -s flags-pg -d flags
   # as pgadmin, in flags: the SQL under Database
   ```

   > **Check this on your setup:** Postgres 18 on Flexible Server in your region. Where it isn't offered yet, use
   > `--version 17`: the server needs 15 or later.

3. **Secrets.** Key Vault and the identity, with the secrets `ff-secret`, `metrics-token`, `database-url` and
   `database-url-migrate` ([Secrets](#secrets)):

   ```bash
   az identity create -g $RG -n flags-id
   az keyvault create -g $RG -n flags-kv
   az keyvault secret set --vault-name flags-kv -n ff-secret --value "$(openssl rand -base64 32)"
   az keyvault secret set --vault-name flags-kv -n metrics-token --value "$(openssl rand -hex 32)"
   # and database-url, database-url-migrate; then "Key Vault Secrets User" on the vault for flags-id
   AUTH_URI=$(az keyvault secret show --vault-name flags-kv -n ff-secret --query id -o tsv)   # versioned
   ```

4. **Migrate job.** The environment, then a manual job, started once before the app:

   ```bash
   az containerapp env create -g $RG -n flags-env -l $LOC --infrastructure-subnet-resource-id $ACA_SUBNET_ID --zone-redundant

   az containerapp job create -g $RG -n flags-migrate --environment flags-env --trigger-type Manual \
     --image $IMG --command companyflags --args migrate --replica-timeout 1800 --replica-retry-limit 0 \
     --cpu 0.5 --memory 1Gi --user-assigned $ID_RES \
     --secrets "db=keyvaultref:https://flags-kv.vault.azure.net/secrets/database-url-migrate,identityref:$ID_RES" \
               "auth=keyvaultref:$AUTH_URI,identityref:$ID_RES" \
     --env-vars DATABASE_URL=secretref:db FF_SECRET=secretref:auth FF_DB_POOL=2
   az containerapp job start -g $RG -n flags-migrate
   ```

5. **Service.** The app, then its probes and a CPU scale rule ([Compute](#compute), [Health checks](#health-checks)):

   ```bash
   az containerapp create -g $RG -n companyflags --environment flags-env --image $IMG --user-assigned $ID_RES \
     --ingress external --target-port 8787 --transport http --cpu 1 --memory 2Gi --min-replicas 2 --max-replicas 4 \
     --secrets "db=keyvaultref:https://flags-kv.vault.azure.net/secrets/database-url,identityref:$ID_RES" \
               "auth=keyvaultref:$AUTH_URI,identityref:$ID_RES" \
               "metrics=keyvaultref:https://flags-kv.vault.azure.net/secrets/metrics-token,identityref:$ID_RES" \
     --env-vars DATABASE_URL=secretref:db FF_SECRET=secretref:auth FF_PUBLIC_URL=https://flags.example.com \
       FF_MIGRATE=off FF_DB_POOL=10 FF_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7 \
       FF_METRICS=on FF_METRICS_TOKEN=secretref:metrics
   # then: az containerapp update --yaml with the probes below and a cpu scale rule (utilization 70)
   ```

6. **Load balancer and CDN.** Container Apps' ingress is the load balancer. Front Door for the CDN files:

   ```bash
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
   ```

7. **DNS.** The custom domain `flags.example.com` on the container app, with a managed certificate; the custom domain
   `cdn.flags.example.com` on the Front Door endpoint.
8. **The admin account.** Make it at once ([below](#the-admin-account)). The setup link is in Log Analytics, in
   `ContainerAppConsoleLogs_CL`.

### The admin account

A new install has no accounts. While nobody has one, every replica prints a setup link at every start:

```text
[companyflags] nobody has an account yet: make the admin account at https://flags.example.com/api/setup/<secret>
```

Open it and create the admin account, then invite everyone else from **Settings → People**. The link is built on
`FF_PUBLIC_URL` and made from `FF_SECRET`, so every replica prints the same one. It stops working once the account
exists.

:::warning[Make the account right after the first start]
Until the admin account exists, whoever has the link can make it, and it is in the Log Analytics workspace at every
start. Make the account as soon as the app first starts, and limit who can read the workspace until then.
:::

People then sign in with email and password, Google, GitHub or Microsoft, or your identity provider: see
[Sign-In](/operate/sign-in) and [Single Sign-On](/operate/single-sign-on).

## Compute

The app runs the released image as it is. Environment variables turn on the integrations: `FF_METRICS=on` serves
`/metrics`, guarded by `FF_METRICS_TOKEN` ([Health checks](#health-checks)), and `FF_INTEGRATIONS_OFF=mcp,webhooks`
turns default ones off ([Integrations](/integrations/overview)). Pin the image to `0.9`: it gets that release line's
fixes, never a new schema. The image sets `NODE_ENV=production`: the app then refuses to start without `FF_SECRET`
(at least 32 characters) or `FF_PUBLIC_URL`, and says which one is wrong.

- **`--min-replicas 2`.** The default is 0. At 0 the background loop stops: no publishes, no scheduled changes, no
  streams, and a cold start can outlast Front Door's origin timeout.
- **`--max-replicas 4`.** Always cap it, so scaling out can't pass the [connection budget](#database).
- **A CPU scale rule**, not the default HTTP one. The HTTP rule counts requests per 15 seconds, and long-lived streams
  don't fit it. Use `cpu` at 70% utilization, or fixed replicas (min = max).
- **Single revision mode.** The old revision serves until the new one has the same replica count and passes its
  probes. Old and new overlap, which is safe because each release's migrations work with the version before.
- **Ingress:** external, `--transport http` (the server speaks HTTP/1.1), target port 8787. Premium ingress isn't
  needed.
- **Shutdown.** On `SIGTERM` the server stops taking requests, closes the console's streams after 5 seconds,
  finishes its round of background work and exits. Keep the termination grace period above 5 seconds
  ([Monitoring → Shutdown](/operate/monitoring#shutdown)).
- **Logs:** the server's lines are in `ContainerAppConsoleLogs_CL` and start with `[companyflags]`.

> **Check this on your setup:** Microsoft says only "Request time out is 240 seconds". It looks like an idle limit,
> which the 25-second heartbeat keeps open. Run `curl -N` on a stream through the Container Apps hostname for more than
> 5 minutes. If it is a hard cap, streams reconnect every 4 minutes.

## Database

Never use the embedded database on Container Apps: its disk is gone at each restart and new revision, Azure Files
can't change file permissions after mounting, and a rolling revision always starts a second container
([Configuration → The embedded database](/reference/configuration#the-embedded-database)).

- **Size.** General Purpose `Standard_D2ds_v5` (2 vCores, 844 user connections) for production, with zone-redundant
  high availability if you need it. `B2s` (414) for small setups. Not `B1ms`: 35 user connections is less than three
  replicas.
- **TLS.** Azure requires it, and its root authorities are in Node's own store: nothing to add. Connect by the
  server's name and write `verify-full` yourself (`pg` treats `require` as `verify-full` anyway, with a warning).
  Don't pin intermediate authorities: Azure rotated them in 2026
  ([Configuration → TLS](/reference/configuration#tls-and-certificate-authorities)):

  ```text
  DATABASE_URL=postgres://flags_app:<password>@flags-pg.postgres.database.azure.com:5432/flags?sslmode=verify-full
  ```

- **`btree_gist` must be allowlisted** before it can be created: `azure.extensions` set to `BTREE_GIST`
  ([First deploy](#first-deploy)), then created as the admin. A restore makes a new server without the parameter:
  allowlist it there again.

**Two roles: one that migrates, one that serves.** The job changes the schema; the app only reads and writes rows.
Once, as `pgadmin` in the `flags` database (made above, so there is no `CREATE DATABASE` line: `flags_owner` gets
the right to create in it instead):

```sql
CREATE ROLE flags_owner LOGIN PASSWORD '…';   -- migrations
CREATE ROLE flags_app   LOGIN PASSWORD '…';   -- the app, with FF_MIGRATE=off
GRANT CONNECT, CREATE ON DATABASE flags TO flags_owner;
GRANT USAGE, CREATE ON SCHEMA public TO flags_owner;
CREATE EXTENSION IF NOT EXISTS btree_gist;
GRANT CONNECT ON DATABASE flags TO flags_app;
GRANT USAGE ON SCHEMA public TO flags_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flags_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flags_app;
```

The job connects as `flags_owner`, the app as `flags_app`.

> **Check this on your setup:** these grants weren't tested end to end. Try them on a copy first, or start with one
> role for both.

**Connection budget.** `FF_DB_POOL` (default 10) is the most connections one replica opens. A new revision runs
beside the old one, so count both:

```text
2 × most replicas × FF_DB_POOL + the migrate job's pool + room for you  ≤  max user connections
2 × 4             × 10         + 2                      + 10            =  92
```

You don't need the built-in PgBouncer at these numbers. The app works with it in transaction mode (no `LISTEN`, no
session state), but run backups against port 5432, not 6432.

**Backups.** Point-in-time restore keeps 7 days by default, up to 35 (`--backup-retention 14` above).
Geo-redundant backup can only be chosen when you create the server. A restore makes a **new** server. Before an
upgrade, note the time you start: point-in-time restore goes back to it
([Backups → A managed database](/operate/backups#a-managed-database)). Keep `FF_SECRET` with your backups. Now and
then, restore into a new server, run a test replica on it with the same `FF_SECRET`, and check that `/readyz` answers
`200` and the flags are there ([Backups → Testing a restore](/operate/backups#testing-a-restore)).

## Secrets

`FF_SECRET` signs sessions, makes the setup link, and seals or encrypts what the database keeps for other systems:
sign-in providers' tokens, two-factor secrets, webhooks' secrets and the CDN files' cache tags. Make it once, never
rotate it, and keep it with your backups: a backup restored with another secret loses those values, and a new
secret signs everyone out ([Configuration → FF_SECRET](/reference/configuration#ff_secret)).

Key Vault references, read with a user-assigned identity that has **Key Vault Secrets User** on the vault.

- **Pin `FF_SECRET` to a versioned URI.** A versionless reference picks up a new version within 30 minutes
  and restarts the revision on its own, which signs everyone out the day someone adds a version
  ([Configuration → Changing a secret](/reference/configuration#changing-a-secret)).
- A versionless reference is fine for `DATABASE_URL`, so a new password reaches the replicas. To change the password
  with no downtime: make a second user, put its address in a new version, let it roll out, then drop the old user.
- Keep `database-url` (`flags_app`) and `database-url-migrate` (`flags_owner`) apart. Only the job gets the owner's.
- **Limit who may start the migrate job.** Starting a job grants the use of its secrets, the owner's address
  included.

The database also holds secrets of its own, such as each environment's link secret: protect backups like
production credentials ([Configuration → What the database holds](/reference/configuration#what-the-database-holds)).

> **Check this on your setup:** whether the restart after a new secret version is rolling or all replicas at once.

## Load balancer and client addresses

`flags.example.com` is a custom domain on the container app, with a managed certificate.

- **`FF_PUBLIC_URL`** is the `https` address people type, `https://flags.example.com`. Sign-in from any other
  address is refused, and the setup link and single sign-on addresses are built on it.
- **Keep-alive.** The server keeps an idle connection open 65 seconds (`FF_KEEPALIVE_SECONDS`). Keep it above the
  ingress's idle timeout, so the server never closes a connection the ingress is about to use (a `502`)
  ([Configuration → Timeouts](/reference/configuration#timeouts-and-body-sizes)).
- **Bodies and streams.** The server takes bodies up to 4 MB (imports), and OFREP's change-event streams stay open
  with a heartbeat every 25 seconds. Anything you add in front must let 4 MB through, must not buffer the streams,
  and must keep a read timeout above 120 seconds.

**The client's address.** Sign-in rate limits and the change-event streams count each client's address. The ingress
appends the client's address to `X-Forwarded-For` and connects from a private address, so trust the private ranges
([Configuration → Client addresses](/reference/configuration#client-addresses)):

```bash
FF_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7
# no FF_CLIENT_IP_HEADER
```

Without it, every device would count as the ingress: one shared sign-in limit, and only 100 devices per replica with
live updates. Requests through Front Door carry a Front Door address last, so they count as Front Door's. That is
fine: only CDN files go that way, and they have no per-client limits. Never read `X-Azure-ClientIP`: Front Door takes
it from `X-Forwarded-For`, which the client sends.

> **Check this on your setup:** the ingress's peer address. Run `az containerapp exec … --command "netstat -tn"`,
> then narrow `FF_TRUSTED_PROXIES` to that range.

**No HSTS.** Container Apps' ingress can't add the `Strict-Transport-Security` header, and the server sends none, so
the console has no HSTS as set up here. To add it, or a firewall, route the console's hostname through Front Door with
caching off, and test the console's live updates there first: it uses a stream too.

**What to expose.** Everyone reaches `/ofrep/…` and the CDN files. Keep `/metrics` and `/readyz` on your network:
the ingress's IP restrictions can't match a path, so rely on `FF_METRICS_TOKEN` for `/metrics`, and read `/readyz`
from inside the environment or from your monitoring's addresses. `/sdk/…` is for your backends; `/hooks/…` only if
you use webhooks in. The console, `/api`, `/oauth`, `/.well-known` and `/mcp` are your choice
([Configuration → What to expose](/reference/configuration#what-to-expose)).

## Health checks

The rule: `/healthz` for liveness and readiness; `/readyz` only for startup and alerts. `/healthz` answers `200` once
the server listens, and it listens only after it has checked the migrations and loaded every environment. `/readyz`
fails on every replica at once during a database outage, while they could still serve what they have in memory
([Monitoring → Health checks](/operate/monitoring#health-checks)). A replica that fails readiness on Container Apps
is restarted, which is one more reason readiness uses `/healthz`:

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

Watch `/readyz` for `failing` and `warnings` apart from the probes: an availability test, or scrape `/metrics`
(`FF_METRICS=on`, with `Authorization: Bearer <FF_METRICS_TOKEN>`).

Alerts worth having ([Monitoring → Alerts](/operate/monitoring#alerts)):

- `/readyz` lists an environment in `failing` (`companyflags_publish_failing`): a publish can't be built. Read the
  log line `publishing … failed`, fix what it names, publish again. A log alert on it works too;
- `lagSeconds` keeps growing (`companyflags_publish_lag_seconds`): check the replicas' CPU, and the log;
- `companyflags_database_up` is `0`: fix the database, and don't restart the replicas, which can't load without it;
- a high rate of `5xx` answers in `ContainerAppHTTPLogs`.

## CDN

You need the CDN only if apps read [CDN files](/integrations/cdn-files). Apps that read flags with OFREP need none.

Front Door Standard, with the container app as its origin, on `cdn.flags.example.com`:

- **Route `/cdn/v1/flags/*`:** caching on, "Honor origin"; **Ignore Query String**, so `?x=1` can't bypass the cache;
  compression off (the server already gzips).
- **No other route,** so apps reach only the CDN files through this hostname. OFREP and its streams go to
  `flags.example.com`: Microsoft says Front Door doesn't support server-sent events, and a stream held back leaves
  providers on old values
  ([Configuration → Keep OFREP and streams off the CDN](/reference/configuration#keep-ofrep-and-streams-off-the-cdn)).
- **Origin group:** health probe `GET /healthz` over HTTPS, every 60 seconds.

What Front Door does with the files' headers ([CDN Files → What each CDN honours](/integrations/cdn-files#what-each-cdn-honours)):

- it keeps a file for `s-maxage` (60 seconds);
- it always honours `no-store`, so a wrong link's `404` isn't kept;
- it ignores `CDN-Cache-Control`, `stale-while-revalidate` and `Cache-Tag`, and doesn't honour `stale-if-error`, so
  it may not serve the last file at all while the server is down;
- it doesn't support ETags. It can revalidate with `Last-Modified`, which the files carry.

> **Check this on your setup:** that Front Door answers a repeat request with a `304` from `Last-Modified`, and
> whether its cache key varies by `Accept-Encoding`. Try `curl` with and without `--compressed`.

**Checking it.** Run this twice; the second answer should carry an `Age` header:

```bash
curl -sI https://cdn.flags.example.com/cdn/v1/flags/prod/web | grep -iE 'cache-control|last-modified|age|cf-ipcountry'
```

**The country.** Rules can check `geo.country`, and the app reads it from a `CF-IPCountry` header next to the file
([CDN Files → The country header](/integrations/cdn-files#the-country-header)). A rule set on the CDN route sets it:
Modify response header, Overwrite `CF-IPCountry` with `{geo_country}`. Without it, `geo.country` is unknown and
locked rules apply.

### No purge on publish

There is no purge integration for Front Door, and one wouldn't help
([CDN Purge → Azure Front Door](/integrations/cdn-purge#azure-front-door)):

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

## Upgrades

The app runs with `FF_MIGRATE=off`: it doesn't migrate, it checks that the schema has every migration it needs, and
stops if it doesn't. The `flags-migrate` job runs `companyflags migrate` with the owner's address before each update
([Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade)). Read the
[changelog](https://github.com/dvir-daniel/companyflags/blob/main/CHANGELOG.md) first, and note the time for
point-in-time restore:

```bash
az containerapp job update -g flags -n flags-migrate --image ghcr.io/dvir-daniel/companyflags:0.9
az containerapp job start  -g flags -n flags-migrate
az containerapp job execution list -g flags -n flags-migrate -o table     # wait for Succeeded
az containerapp update     -g flags -n companyflags --image ghcr.io/dvir-daniel/companyflags:0.9
```

- `companyflags migrate --check` lists what an upgrade would apply.
- Old and new revisions serve side by side: each release's migrations work with the version before it. A rolling
  upgrade goes one release line at a time (0.9 to 0.10, then 0.10 to 0.11).
- A revision you roll back to must also run with `FF_MIGRATE=off`: an older version that migrates at start refuses a
  newer schema.

**Rolling back.** The schema doesn't go back. Stop the app (min and max replicas 0), restore to the time you noted,
into a new server, allowlist `btree_gist` there again, point `database-url` at it, keep the same `FF_SECRET`, and
deploy the version you had before. Check that `/readyz` answers `200`. Everything changed since that time is lost:
look at History first ([Upgrading → Rolling back](/operate/upgrading#rolling-back)).

## Pitfalls

- **No embedded database on Container Apps.** Its disk is gone at each restart and new revision, and a rolling
  revision always starts a second container.
- **Scale to zero is the default.** Set `--min-replicas 2`.
- **`B1ms`** has 35 user connections: three replicas fill it.
- **Access logs hold secrets.** CDN file paths carry each entity's link secret: limit who can read
  `ContainerAppHTTPLogs` and Front Door logs.
- **Cost:** Front Door Premium's base fee is about ten times Standard's, and only Private Link or managed firewall
  rules need it. Replicas never reach the idle rate: open streams and the loop keep them active. Log only what you
  read: `ContainerAppHTTPLogs` and Front Door logs record every poll. Zone-redundant Postgres doubles its compute.

## Checklist

- [ ] Flexible Server with Postgres 15 or later, `btree_gist` allowlisted and created, the two roles, and
  `sslmode=verify-full`.
- [ ] `FF_SECRET` in Key Vault, made once, read by a versioned URI, stored with your backups.
- [ ] `FF_PUBLIC_URL` is the `https` address on the custom domain.
- [ ] The image pinned to `0.9`.
- [ ] The admin account made; few people can read the Log Analytics workspace.
- [ ] `--min-replicas 2`, `--max-replicas` inside the connection budget, a CPU scale rule.
- [ ] `FF_TRUSTED_PROXIES` set, and narrowed to the ingress's range once you've checked it.
- [ ] Startup probe on `/readyz`, liveness and readiness on `/healthz`; an availability test or alert on `/readyz`.
- [ ] `FF_METRICS_TOKEN` set if `/metrics` is on.
- [ ] *Only with CDN files:* Front Door routes only `/cdn/v1/flags/*`, and you know how to purge it by hand.
- [ ] Point-in-time restore set, and a restore tested.
- [ ] The migrate job runs before each update; few people may start it.

Then go through the full [Production Checklist](/operate/production).
