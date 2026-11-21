---
title: "Google Cloud"
description: "Run CompanyFlags on Google Cloud, top to bottom: Cloud Run behind a global load balancer, Cloud SQL over its built-in socket, Secret Manager, and Cloud CDN for the CDN files only."
---

This recipe runs CompanyFlags on managed containers with two or more instances: Cloud Run, Cloud SQL, and Cloud CDN
for the CDN files. Everything it needs is on this page. For one server, see [Docker Compose](/deploy/docker-compose);
for a cluster, [Kubernetes](/deploy/kubernetes).

## What you build

```text
flags.example.com ─► global external Application Load Balancer (HTTPS)
                      ├─ /cdn/v1/flags/*  ─► backend flags-cdn (Cloud CDN on) ─┐
                      └─ everything else  ─► backend flags-app (no CDN) ───────┴─► Cloud Run service, 2+ instances, :8787
every instance, the migrate job ─► Cloud SQL for PostgreSQL (built-in socket, encrypted)
secrets: Secret Manager, pinned versions          logs: Cloud Logging
```

- **Compute: Cloud Run.** One stateless container with its state in Postgres is what it is built for. Use GKE only if
  you already run it, or need streams longer than an hour: then follow [Kubernetes](/deploy/kubernetes).
- **Database: Cloud SQL for PostgreSQL, Enterprise edition.** Postgres 15 or later works; this recipe uses 18.
  AlloyDB has no built-in Cloud Run socket and costs more for a load this small.
- **Cloud CDN** is on one backend, for the CDN files only. Media CDN doesn't fit: it is built for video.
- **One image, many instances.** Every instance runs the same image with the same settings. A publish reaches every
  instance in about a second. A background loop in each instance runs publishes, scheduled changes, webhooks and the
  second CDN purge every second, so the CPU must never be throttled and instances must never scale to zero.

## First deploy

Check the flags against `--help` on your `gcloud` version.

1. **Network and permissions.** Turn on the APIs, make the service account, and give it the Cloud SQL client role
   and a custom role with only `compute.urlMaps.invalidateCache`:

   ```bash
   P=acme-flags R=europe-west1 I=flags-pg D=flags.example.com
   SA=companyflags@$P.iam.gserviceaccount.com
   gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
     compute.googleapis.com artifactregistry.googleapis.com
   gcloud iam service-accounts create companyflags
   gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/cloudsql.client
   gcloud iam roles create cdnInvalidator --project=$P --title="CDN invalidator" \
     --permissions=compute.urlMaps.invalidateCache
   gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=projects/$P/roles/cdnInvalidator
   ```

2. **Database and roles.** The instance, the database and `flags_owner`, which `gcloud` makes a member of
   `cloudsqlsuperuser`. Then, as `flags_owner`, `btree_gist` and the `flags_app` role in SQL ([Database](#database)):

   ```bash
   gcloud sql instances create $I --database-version=POSTGRES_18 --edition=ENTERPRISE --tier=db-custom-1-3840 \
     --region=$R --availability-type=REGIONAL --enable-point-in-time-recovery --ssl-mode=ENCRYPTED_ONLY --deletion-protection
   gcloud sql databases create flags --instance=$I
   OWNER_PW=$(openssl rand -hex 24); gcloud sql users create flags_owner --instance=$I --password=$OWNER_PW
   APP_PW=$(openssl rand -hex 24)    # for CREATE ROLE flags_app … PASSWORD '<APP_PW>'
   ```

3. **Image.** Cloud Run runs images from Artifact Registry, not from `ghcr.io`. Copy the released image there,
   unchanged: no image of your own is needed, since environment variables turn on every integration.

   ```bash
   gcloud artifacts repositories create flags --repository-format=docker --location=$R
   gcloud auth configure-docker $R-docker.pkg.dev
   IMG=$R-docker.pkg.dev/$P/flags/companyflags:0.9
   docker pull ghcr.io/dvir-daniel/companyflags:0.9
   docker tag ghcr.io/dvir-daniel/companyflags:0.9 $IMG && docker push $IMG
   ```

   > **Check this on your setup:** an Artifact Registry remote repository with `https://ghcr.io` as its upstream can
   > mirror the image instead, so you never copy it by hand.

   Pin `0.9`: it gets that release line's fixes, never a new schema.

4. **Secrets.** One for `FF_SECRET`, one for the metrics token, and one address for each role: `flags_app` for the
   service, `flags_owner` for the migrate job only ([Secrets](#secrets)):

   ```bash
   openssl rand -base64 32 | tr -d '\n' | gcloud secrets create flags-auth-secret --data-file=-
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets create flags-metrics-token --data-file=-
   printf 'postgres://flags_app:%s@localhost/flags?host=/cloudsql/%s:%s:%s' $APP_PW $P $R $I \
     | gcloud secrets create flags-database-url --data-file=-
   printf 'postgres://flags_owner:%s@localhost/flags?host=/cloudsql/%s:%s:%s' $OWNER_PW $P $R $I \
     | gcloud secrets create flags-database-url-migrate --data-file=-
   for s in flags-auth-secret flags-metrics-token flags-database-url flags-database-url-migrate; do
     gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor; done
   ```

5. **Migrate job.** Make it, and run it once before the service starts:

   ```bash
   gcloud run jobs deploy flags-migrate --image=$IMG --region=$R --service-account=$SA \
     --set-cloudsql-instances=$P:$R:$I \
     --set-secrets=DATABASE_URL=flags-database-url-migrate:1,FF_SECRET=flags-auth-secret:1 \
     --set-env-vars=FF_PUBLIC_URL=https://$D,FF_DB_POOL=2 --command=companyflags --args=migrate --max-retries=0
   gcloud run jobs execute flags-migrate --region=$R --wait
   ```

6. **Service:**

   ```bash
   gcloud run deploy companyflags --image=$IMG --region=$R --service-account=$SA --port=8787 \
     --cpu=1 --memory=1Gi --no-cpu-throttling --min=2 --max-instances=4 --concurrency=1000 --timeout=3600 --cpu-boost \
     --ingress=internal-and-cloud-load-balancing --allow-unauthenticated \
     --add-cloudsql-instances=$P:$R:$I \
     --set-secrets=DATABASE_URL=flags-database-url:1,FF_SECRET=flags-auth-secret:1,FF_METRICS_TOKEN=flags-metrics-token:1 \
     --set-env-vars=FF_PUBLIC_URL=https://$D,FF_MIGRATE=off,FF_DB_POOL=10,FF_TRUSTED_PROXIES=169.254.0.0/16,FF_CLIENT_IP_HEADER=x-client-ip,FF_METRICS=on,FF_CLOUD_CDN_PROJECT=$P,FF_CLOUD_CDN_URL_MAP=flags-map,FF_CLOUD_CDN_HOST=$D \
     --startup-probe=httpGet.path=/readyz,httpGet.port=8787,periodSeconds=5,timeoutSeconds=3,failureThreshold=24 \
     --liveness-probe=httpGet.path=/healthz,httpGet.port=8787,periodSeconds=30,timeoutSeconds=5,failureThreshold=3
   ```

   `--allow-unauthenticated` is needed: the load balancer forwards people who aren't signed in to Google. An
   organization policy that forbids `allUsers` blocks it. In Terraform, instance-based billing is
   `containers.resources.cpu_idle = false` on `google_cloud_run_v2_service`.

7. **Load balancer and CDN.** Two NEGs, two backends, and a path rule for the CDN files:

   ```bash
   gcloud compute addresses create flags-ip --global --ip-version=IPV4 --network-tier=PREMIUM
   for n in flags-neg-app flags-neg-cdn; do gcloud compute network-endpoint-groups create $n --region=$R \
     --network-endpoint-type=serverless --cloud-run-service=companyflags; done
   HSTS='Strict-Transport-Security: max-age=31536000; includeSubDomains'
   gcloud compute backend-services create flags-app --global --load-balancing-scheme=EXTERNAL_MANAGED \
     --custom-request-header='X-Client-IP:{client_ip_address}' --custom-response-header="$HSTS"
   gcloud compute backend-services create flags-cdn --global --load-balancing-scheme=EXTERNAL_MANAGED \
     --enable-cdn --cache-mode=USE_ORIGIN_HEADERS --no-cache-key-include-query-string --no-negative-caching \
     --custom-response-header="$HSTS" --custom-response-header='CF-IPCountry:{client_region}' \
     --enable-logging --logging-sample-rate=0.05
   gcloud compute backend-services add-backend flags-app --global --network-endpoint-group=flags-neg-app --network-endpoint-group-region=$R
   gcloud compute backend-services add-backend flags-cdn --global --network-endpoint-group=flags-neg-cdn --network-endpoint-group-region=$R
   gcloud compute url-maps create flags-map --default-service=flags-app
   gcloud compute url-maps add-path-matcher flags-map --path-matcher-name=flags --default-service=flags-app \
     --path-rules='/cdn/v1/flags/*=flags-cdn' --new-hosts=$D
   gcloud compute ssl-certificates create flags-cert --domains=$D --global
   gcloud compute target-https-proxies create flags-https --url-map=flags-map --ssl-certificates=flags-cert
   gcloud compute forwarding-rules create flags-https --global --load-balancing-scheme=EXTERNAL_MANAGED \
     --network-tier=PREMIUM --address=flags-ip --target-https-proxy=flags-https --ports=443
   ```

8. **DNS.** An A record for `flags.example.com` to `flags-ip`, and a URL map on :80 that redirects to HTTPS.
9. **The admin account.** Make it at once ([below](#the-admin-account)). The setup link is in Cloud Logging.

### The admin account

A new install has no accounts. While nobody has one, every instance prints a setup link at every start:

```text
[companyflags] nobody has an account yet: make the admin account at https://flags.example.com/api/setup/<secret>
```

Open it and create the admin account, then invite everyone else from **Settings → People**. The link is built on
`FF_PUBLIC_URL` and made from `FF_SECRET`, so every instance prints the same one. It stops working once the account
exists.

:::warning[Make the account right after the first start]
Until the admin account exists, whoever has the link can make it, and it is in Cloud Logging at every start. Make
the account as soon as the service first starts, and limit who can read the project's logs until then.
:::

People then sign in with email and password, Google, GitHub or Microsoft, or your identity provider: see
[Sign-In](/operate/sign-in) and [Single Sign-On](/operate/single-sign-on).

## Compute

The service runs the released image as it is. Environment variables turn on the integrations, so there is no config
file to build in:

- `FF_CLOUD_CDN_PROJECT` and `FF_CLOUD_CDN_URL_MAP` turn on the Cloud CDN purge; `FF_CLOUD_CDN_HOST` keeps it to one
  host. One of the first two alone stops the start ([CDN](#cdn)).
- `FF_METRICS=on` serves `/metrics`, and `FF_METRICS_TOKEN` guards it ([Health checks](#health-checks)).
- `FF_INTEGRATIONS_OFF=mcp,webhooks` turns default ones off ([Integrations](/integrations/overview)).

The image sets `NODE_ENV=production`: the service then refuses to start without `FF_SECRET` (at least 32
characters) or `FF_PUBLIC_URL`, and says which one is wrong.

The service's settings that matter, and why:

| Setting | Why |
|---|---|
| `--no-cpu-throttling` (instance-based billing) | The background loop works between requests. With request-based billing, CPU stops between requests and publishes, scheduled changes and webhooks stall. |
| `--min=2` | Without a minimum, an idle instance stops within 15 minutes, and the loop stops with it. Minimum instances may still be restarted at any time; that's fine, every instance works from the same database. |
| `--timeout=3600` | The default 300 seconds cuts every change-event stream every 5 minutes. 3600 is the most: streams reconnect once an hour. |
| `--concurrency=1000` | The most. Each open stream holds one slot for its whole life, so an instance holds at most 1,000 streams, whatever `FF_EVENT_STREAMS_PER_ENVIRONMENT` says. |
| `--max-instances=4` | Always set it: streams can scale instances out, and each one opens its own pool ([connection budget](#database)). |
| `--port=8787` | Cloud Run sets `PORT` to it. Leave HTTP/2 off: the server speaks HTTP/1.1. |
| `--ingress=internal-and-cloud-load-balancing` | The `run.app` address is no longer reachable from the internet, only through the load balancer. |

> **Check this on your setup:** that a stream holds a concurrency slot the way a WebSocket does. Google documents it
> for WebSockets only.

On `SIGTERM`, Cloud Run gives 10 seconds before it kills the container. The server stops taking requests, closes
streams after 5 seconds, finishes its round of background work and exits, so that fits
([Monitoring → Shutdown](/operate/monitoring#shutdown)). The server's log lines start with `[companyflags]`.

## Database

Never use the embedded database on Cloud Run: its disk is memory, gone at every restart, and each instance would get
its own empty database ([Configuration → The embedded database](/reference/configuration#the-embedded-database)).

**Connect through the built-in socket.** `--add-cloudsql-instances` on the service and `--set-cloudsql-instances` on
the job mount `/cloudsql/<project>:<region>:<instance>`. These connections are encrypted with no setup, and IAM allows
them (`roles/cloudsql.client`):

```text
DATABASE_URL=postgres://flags_app:<hex password>@localhost/flags?host=/cloudsql/acme-flags:europe-west1:flags-pg
```

- Keep `localhost`: `companyflags backup` needs a host in the address, and `pg` uses `?host=` instead.
- Add no `sslmode`: the socket is already encrypted. Connecting by IP instead needs the instance's own authority in
  `FF_DATABASE_CA_FILE` ([Configuration → TLS](/reference/configuration#tls-and-certificate-authorities)).
- Use a hex password (`openssl rand -hex 24`), so nothing needs encoding.
- Set `--ssl-mode=ENCRYPTED_ONLY` on the instance, for any connection by IP. The socket isn't affected.

**`btree_gist`.** The first migration creates the `btree_gist` extension. On Cloud SQL, only members of
`cloudsqlsuperuser` create extensions. Users made with `gcloud sql users create` are members, so `flags_owner`
creates it.

**Two roles: one that migrates, one that serves.** The migrate job changes the schema; the service only reads and
writes rows. Once, connected as `flags_owner` to the `flags` database (made by `gcloud` above, so there is no
`CREATE DATABASE` line):

```sql
CREATE ROLE flags_app LOGIN PASSWORD '<APP_PW>';   -- the service, with FF_MIGRATE=off
CREATE EXTENSION IF NOT EXISTS btree_gist;
GRANT CONNECT ON DATABASE flags TO flags_app;
GRANT USAGE ON SCHEMA public TO flags_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flags_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flags_app;
```

The migrate job connects as `flags_owner`, the service as `flags_app`.

> **Check this on your setup:** these grants weren't tested end to end. Try them on a copy first, or start with one
> role for both.

**Connection budget.** `FF_DB_POOL` (default 10) is the most connections one instance opens. A deploy runs old and
new instances side by side, so count both:

```text
2 × most instances × FF_DB_POOL + the migrate job's pool + room for you  ≤  max_connections
2 × 4              × 10         + 2                      + 10            =  92
```

The built-in socket allows 100 connections per instance, far above a pool of 10. The real limit is
`max_connections`, which follows the instance's memory (3.75 to 6 GB: 100; 6 to 7.5 GB: 200; 7.5 to 15 GB: 400).
With `--max-instances=4`, 92 fits `db-custom-1-3840` (100). Move to `db-custom-2-7680` before you raise
`--max-instances`. Run `SHOW max_connections;` rather than guess.

**Backups.** Automated backups and point-in-time recovery, `--availability-type=REGIONAL` for a standby, and an
on-demand backup before each upgrade ([Backups → A managed database](/operate/backups#a-managed-database)). Keep
`FF_SECRET` with your backups. Now and then, restore the latest backup into a new instance, run a test instance on it
with the same `FF_SECRET`, and check that `/readyz` answers `200` and the flags are there
([Backups → Testing a restore](/operate/backups#testing-a-restore)).

## Secrets

`FF_SECRET` signs sessions, makes the setup link, and seals or encrypts what the database keeps for other systems:
sign-in providers' tokens, two-factor secrets, webhooks' secrets and the CDN files' cache tags. Make it once, never
rotate it, and keep it with your backups: a backup restored with another secret loses those values, and a new
secret signs everyone out ([Configuration → FF_SECRET](/reference/configuration#ff_secret)).

Secret Manager, as environment variables, **pinned to a version** (`flags-auth-secret:1`, not `latest`). Cloud Run
reads secrets when an instance starts: with `latest`, instances started after a new version get it and older ones
don't, and people are signed out depending on which instance answers.

- Pinned, a change is a new revision, and every instance changes together.
- Keep `flags-database-url` (`flags_app`) and `flags-database-url-migrate` (`flags_owner`) apart. Only the job gets
  the owner's. Limit who may run the job: running it grants the use of its secrets.
- To change the database password with no downtime: a second user, a new secret version with it, a deploy, then drop
  the old user.
- The service account needs `roles/secretmanager.secretAccessor` on each secret.
- Changing a secret on purpose, and what it breaks: [Configuration → Changing a secret](/reference/configuration#changing-a-secret).

The database also holds secrets of its own, such as each environment's link secret: protect backups like
production credentials ([Configuration → What the database holds](/reference/configuration#what-the-database-holds)).

## Load balancer and client addresses

Cloud Run's own address has TLS, but no CDN and no way to add HSTS. Put a global external Application Load Balancer
(`EXTERNAL_MANAGED`) in front, with a Google-managed certificate and serverless NEGs.

- **`FF_PUBLIC_URL`** is the `https` address people type, `https://flags.example.com`. Sign-in from any other
  address is refused, and the setup link and single sign-on addresses are built on it.
- **HSTS:** the server sends none, so a custom response header adds it on both backends.
- **Keep-alive.** The server keeps an idle connection open 65 seconds (`FF_KEEPALIVE_SECONDS`), longer than Google's
  load balancers (60 seconds), so it never closes a connection the load balancer is about to use (a `502`)
  ([Configuration → Timeouts](/reference/configuration#timeouts-and-body-sizes)).
- **Stream timeout:** the backend service timeout doesn't apply to serverless NEGs. Cloud Run's `--timeout=3600` is
  the limit that counts. Streams send a heartbeat every 25 seconds; anything in front must not buffer them and must
  keep a read timeout above 120 seconds.
- **Bodies:** the server takes up to 4 MB (imports). Anything you add in front (Cloud Armor) must let them through.
- **No load balancer health checks** for serverless backends: Cloud Run's probes are the only ones.

**The client's address.** Sign-in rate limits and the change-event streams count each client's address. The load
balancer appends the client and its own address to `X-Forwarded-For`, and Cloud Run's front end connects to the
container from a link-local address. Don't depend on that chain: have the load balancer set a header of its own on
the `flags-app` backend, which a client can't forge through it
([Configuration → Client addresses](/reference/configuration#client-addresses)):

```bash
--custom-request-header='X-Client-IP:{client_ip_address}'       # on the flags-app backend service
FF_TRUSTED_PROXIES=169.254.0.0/16                                # on the Cloud Run service
FF_CLIENT_IP_HEADER=x-client-ip
```

> **Check this on your setup:** Google doesn't document the address Cloud Run's front end connects from. Deploy a
> small service that echoes its peer address behind the same load balancer, and check it is in `169.254.0.0/16`. If
> it isn't, the header is ignored and every device counts as one address: one shared sign-in limit, and only 100
> streams per instance.

**What to expose.** Everyone reaches `/ofrep/…` and the CDN files. Keep `/metrics` and `/readyz` on your network: a
Cloud Armor policy on `flags-app` that allows those paths only from your ranges and your monitoring's, or at least
`FF_METRICS_TOKEN` for `/metrics`. `/sdk/…` is for your backends; `/hooks/…` only if you use webhooks in. The
console, `/api`, `/oauth`, `/.well-known` and `/mcp` are your choice: everyone, or your network only
([Configuration → What to expose](/reference/configuration#what-to-expose)).

## Health checks

The rule: `/healthz` for liveness and readiness; `/readyz` only for startup and alerts. `/healthz` answers `200` once
the server listens, and it listens only after it has checked the migrations and loaded every environment. `/readyz`
fails on every instance at once during a database outage, while they could still serve what they have in memory
([Monitoring → Health checks](/operate/monitoring#health-checks)).

Cloud Run has startup and liveness probes, set on the service in [First deploy](#first-deploy):

- **Startup probe on `/readyz`.** The startup window (`failureThreshold × periodSeconds`) can't be more than 600
  seconds.
- **Liveness probe on `/healthz`.**
- **No readiness probe.**
- Watch `/readyz` for `failing` and `warnings` with an uptime check, or scrape `/metrics` (`FF_METRICS=on`, with
  `Authorization: Bearer <FF_METRICS_TOKEN>`).

Alerts worth having ([Monitoring → Alerts](/operate/monitoring#alerts)):

- `/readyz` lists an environment in `failing` (`companyflags_publish_failing`): a publish can't be built. Read the
  log line `publishing … failed`, fix what it names, publish again. A log-based alert on it works too;
- `/readyz` lists `warnings` (`companyflags_purge_failing`): a Cloud CDN purge didn't go through;
- `lagSeconds` keeps growing (`companyflags_publish_lag_seconds`): check that CPU isn't throttled, and the log;
- `companyflags_database_up` is `0`: fix the database, and don't restart the instances, which can't load without it;
- a high rate of `5xx` answers on the load balancer.

## CDN

You need the CDN only if apps read [CDN files](/integrations/cdn-files). Apps that read flags with OFREP need none.

Two backend services, each with its own serverless NEG for the same Cloud Run service:

- `flags-app`, CDN off: the URL map's default. `/api`, `/ofrep`, `/sdk`, `/healthz` and the console go here. Never
  enable CDN or dynamic compression on it: OFREP and its streams go this way. A stream held back or cached leaves
  providers on old values
  ([Configuration → Keep OFREP and streams off the CDN](/reference/configuration#keep-ofrep-and-streams-off-the-cdn)).
- `flags-cdn`, CDN on, for the path rule `/cdn/v1/flags/*`:
  - **cache mode `USE_ORIGIN_HEADERS`.** It caches only what the server says may be cached: a wrong link's `404` has
    `no-store` and is never kept, and browsers get `max-age=0` unchanged. Not `FORCE_CACHE_ALL`: it overrides the
    server's headers;
  - **`--no-cache-key-include-query-string`**, so `?x=1` can't bypass the cache; no header or cookie keys;
  - negative caching and dynamic compression off. The server already gzips.

Cloud CDN reads `CDN-Cache-Control` (since August 2026): 60 seconds, with `stale-while-revalidate`. It doesn't
support `stale-if-error`. While the server can't be reached, it serves a stale copy only for the
`stale-while-revalidate` window: a day while the purge integration runs, 10 minutes otherwise
([CDN Files → What each CDN honours](/integrations/cdn-files#what-each-cdn-honours)). `Cache-Tag` reaches the
device, but the tags are opaque: they show no entity's key.

> **Check this on your setup:** stop the service and see how long the CDN keeps answering. And whether Cloud CDN
> answers a browser's own `If-None-Match` with a `304` (look for an `Age` header).

**Purge on publish.** `FF_CLOUD_CDN_PROJECT`, `FF_CLOUD_CDN_URL_MAP` and `FF_CLOUD_CDN_HOST` on the service turn on
the Cloud CDN purge integration ([CDN Purge → Cloud CDN](/integrations/cdn-purge#cloud-cdn)).

- It invalidates by cache tag, with the service account's own token from the metadata server: no token is stored,
  and `FF_SECRET` plays no part.
- The service account has the custom role with only `compute.urlMaps.invalidateCache`
  ([First deploy](#first-deploy)), not `roles/compute.networkAdmin`.
- Cloud CDN takes 10 tags a call, so it sends up to 3 calls; more tags invalidate the environment's tag instead.
- An invalidation takes effect in about 10 seconds. Each publish purges twice, the second about 11 seconds later,
  which covers it.
- A purge that fails (a missing permission, too many invalidations a minute) is kept on the publish and listed in
  `/readyz` under `warnings`. The change still reaches apps within the cache's minute.

A manual purge of one environment:

```bash
gcloud compute url-maps invalidate-cdn-cache flags-map --path='/cdn/v1/flags/prod/*' --host=flags.example.com --async
```

**Checking it.** Run this twice; the second answer should carry an `Age` header:

```bash
curl -sI https://flags.example.com/cdn/v1/flags/prod/web | grep -iE 'cache-control|etag|age|cf-ipcountry'
```

**The country.** Rules can check `geo.country`, and the app reads it from a `CF-IPCountry` header next to the file
([CDN Files → The country header](/integrations/cdn-files#the-country-header)). The `flags-cdn` backend sets the
custom response header `CF-IPCountry` to `{client_region}` ([First deploy](#first-deploy)). Without it, `geo.country`
is unknown and locked rules apply.

> **Check this on your setup:** this way hasn't been tried. Request a file and look for the header.

## Upgrades

The service runs with `FF_MIGRATE=off`: it doesn't migrate, it checks that the schema has every migration it needs,
and stops if it doesn't. The `flags-migrate` job runs `companyflags migrate` before each deploy, as `flags_owner`
([Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade)). Read the
[changelog](https://github.com/dvir-daniel/companyflags/blob/main/CHANGELOG.md) first, and copy the new image into
Artifact Registry ([First deploy](#first-deploy)):

```bash
IMG=europe-west1-docker.pkg.dev/acme-flags/flags/companyflags:0.9
gcloud sql backups create --instance=flags-pg
gcloud run jobs update flags-migrate --image=$IMG --region=europe-west1
gcloud run jobs execute flags-migrate --region=europe-west1 --wait
gcloud run deploy companyflags --image=$IMG --region=europe-west1
```

- `companyflags migrate --check` lists what an upgrade would apply.
- Old and new instances serve side by side during the deploy: each release's migrations work with the version before
  it. A rolling upgrade goes one release line at a time (0.9 to 0.10, then 0.10 to 0.11).
- A revision you roll back to must also run with `FF_MIGRATE=off`: an older version that migrates at start refuses a
  newer schema.

**Rolling back.** The schema doesn't go back. Stop traffic to the service, restore the backup you took into a new
instance, point the `flags-database-url` secrets at it, keep the same `FF_SECRET`, and deploy the version you had
before. Check that `/readyz` answers `200`. Everything changed since the backup is lost: look at History first
([Upgrading → Rolling back](/operate/upgrading#rolling-back)).

## Pitfalls

- **No embedded database on Cloud Run.** Its disk is memory, gone at every restart, and each instance would get its
  own empty database.
- **Request-based billing** stalls publishes, scheduled changes and webhooks whenever no request is in flight.
- **Streams scale instances out:** 1,000 per instance at most, and each new instance opens its own pool. Keep
  `--max-instances` inside the connection budget.
- **Without the client header**, every device counts as one address: one sign-in limit for everyone, and 100
  streams per instance.
- **Access logs hold secrets.** CDN file paths carry each entity's link secret: limit who can read the load
  balancer's logs.
- **Cost:** instance-based billing charges for every instance's whole life, minimum instances included; a regional
  Cloud SQL instance costs about twice a zonal one; the forwarding rule has an hourly charge; log only a sample of the
  CDN backend's requests. Keep Cloud Run and Cloud SQL in one region.

## Checklist

- [ ] Cloud SQL for PostgreSQL 15 or later, regional, with `btree_gist` and the two roles, reached over the built-in
  socket.
- [ ] `FF_SECRET` in Secret Manager, made once, pinned to a version, stored with your backups.
- [ ] `FF_PUBLIC_URL` is the `https` address; HSTS on both backends.
- [ ] The image copied to Artifact Registry and pinned to `0.9`.
- [ ] The admin account made; few people can read the logs.
- [ ] `--no-cpu-throttling`, `--min=2`, `--max-instances` inside the connection budget, `--timeout=3600`.
- [ ] `FF_TRUSTED_PROXIES=169.254.0.0/16` and `FF_CLIENT_IP_HEADER=x-client-ip`, checked with an echo service.
- [ ] Startup probe on `/readyz`, liveness on `/healthz`; an uptime check or alert on `/readyz`.
- [ ] `/metrics` and `/readyz` not open to the internet, or `FF_METRICS_TOKEN` set.
- [ ] *Only with CDN files:* Cloud CDN on `flags-cdn` only, and `FF_CLOUD_CDN_PROJECT` and `FF_CLOUD_CDN_URL_MAP`
  set.
- [ ] Backups and point-in-time recovery on, and a restore tested.
- [ ] The migrate job runs before each deploy.

Then go through the full [Production Checklist](/operate/production).
