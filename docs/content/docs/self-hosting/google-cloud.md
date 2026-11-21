---
title: "Google Cloud"
description: "Run CompanyFlags on Google Cloud: Cloud Run behind a global load balancer, Cloud SQL over its built-in socket, Secret Manager, and Cloud CDN for the CDN files only."
---

One VM? Use [Docker](/self-hosting/docker) with [Proxies and HTTPS](/self-hosting/proxies). This page is for managed
containers with two or more instances: Cloud Run, Cloud SQL, and Cloud CDN for the CDN files.

## What you build

```text
flags.example.com ─► global external Application Load Balancer (HTTPS)
                      ├─ /cdn/v1/flags/*  ─► backend flags-cdn (Cloud CDN on) ─┐
                      └─ everything else  ─► backend flags-app (no CDN) ───────┴─► Cloud Run service, 2+ instances, :8787
every instance, the migrate job ─► Cloud SQL for PostgreSQL (built-in socket, encrypted)
secrets: Secret Manager, pinned versions          logs: Cloud Logging
```

- **Compute: Cloud Run.** One stateless container with its state in Postgres is what it is built for. Use GKE only if
  you already run it, or need streams longer than an hour.
- **Database: Cloud SQL for PostgreSQL, Enterprise edition.** AlloyDB has no built-in Cloud Run socket and costs more
  for a load this small.
- **Cloud CDN** is on one backend, for the CDN files only. Media CDN doesn't fit: it is built for video.

## Read first

- [Database](/self-hosting/database): `btree_gist`, the two roles, TLS and the connection budget.
- [Proxies and HTTPS](/self-hosting/proxies): client addresses, keep-alive and what to expose.
- [Secrets](/self-hosting/secrets): what `BETTER_AUTH_SECRET` protects.
- [Monitoring](/self-hosting/monitoring): the health-check rule and the alerts.

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
   `cloudsqlsuperuser`. Then, as `flags_owner`, `btree_gist` and the `flags_app` role in SQL
   ([Database → Two roles](/self-hosting/database#two-roles-one-that-migrates-one-that-serves); skip its
   `CREATE DATABASE` line):

   ```bash
   gcloud sql instances create $I --database-version=POSTGRES_18 --edition=ENTERPRISE --tier=db-custom-1-3840 \
     --region=$R --availability-type=REGIONAL --enable-point-in-time-recovery --ssl-mode=ENCRYPTED_ONLY --deletion-protection
   gcloud sql databases create flags --instance=$I
   OWNER_PW=$(openssl rand -hex 24); gcloud sql users create flags_owner --instance=$I --password=$OWNER_PW
   APP_PW=$(openssl rand -hex 24)    # for CREATE ROLE flags_app … PASSWORD '<APP_PW>'
   ```

3. **Image.** Cloud Run runs images from Artifact Registry, not from `ghcr.io`, and the purge needs a config file in
   the image. Build a thin image ([Compute](#compute)) and push it:

   ```bash
   gcloud artifacts repositories create flags --repository-format=docker --location=$R
   gcloud auth configure-docker $R-docker.pkg.dev
   IMG=$R-docker.pkg.dev/$P/flags/companyflags:0.9
   docker build -t $IMG . && docker push $IMG
   ```

   > **Check this on your setup:** an Artifact Registry remote repository with `https://ghcr.io` as its upstream can
   > mirror the image instead, but you still need the config file in an image of your own.

4. **Secrets.** One for the secret, and one address for each role: `flags_app` for the service, `flags_owner` for
   the migrate job only ([below](#secrets)):

   ```bash
   openssl rand -base64 32 | tr -d '\n' | gcloud secrets create flags-auth-secret --data-file=-
   printf 'postgres://flags_app:%s@localhost/flags?host=/cloudsql/%s:%s:%s' $APP_PW $P $R $I \
     | gcloud secrets create flags-database-url --data-file=-
   printf 'postgres://flags_owner:%s@localhost/flags?host=/cloudsql/%s:%s:%s' $OWNER_PW $P $R $I \
     | gcloud secrets create flags-database-url-migrate --data-file=-
   for s in flags-auth-secret flags-database-url flags-database-url-migrate; do
     gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor; done
   ```

5. **Migrate job.** Make it, and run it once before the service starts:

   ```bash
   gcloud run jobs deploy flags-migrate --image=$IMG --region=$R --service-account=$SA \
     --set-cloudsql-instances=$P:$R:$I \
     --set-secrets=DATABASE_URL=flags-database-url-migrate:1,BETTER_AUTH_SECRET=flags-auth-secret:1 \
     --set-env-vars=BETTER_AUTH_URL=https://$D,FF_DB_POOL=2 --command=companyflags --args=migrate --max-retries=0
   gcloud run jobs execute flags-migrate --region=$R --wait
   ```

6. **Service:**

   ```bash
   gcloud run deploy companyflags --image=$IMG --region=$R --service-account=$SA --port=8787 \
     --cpu=1 --memory=1Gi --no-cpu-throttling --min=2 --max-instances=4 --concurrency=1000 --timeout=3600 --cpu-boost \
     --ingress=internal-and-cloud-load-balancing --allow-unauthenticated \
     --add-cloudsql-instances=$P:$R:$I \
     --set-secrets=DATABASE_URL=flags-database-url:1,BETTER_AUTH_SECRET=flags-auth-secret:1 \
     --set-env-vars=BETTER_AUTH_URL=https://$D,FF_MIGRATE=off,FF_DB_POOL=10,FF_TRUSTED_PROXIES=169.254.0.0/16,FF_CLIENT_IP_HEADER=x-client-ip,FF_CLOUD_CDN_PROJECT=$P,FF_CLOUD_CDN_URL_MAP=flags-map,FF_CLOUD_CDN_HOST=$D \
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
9. **Setup link.** Make the admin account at once ([Sign-In → The first account](/self-hosting/sign-in#the-first-account)).
   The link is in Cloud Logging.

## Compute

The thin image adds the config file that turns on the Cloud CDN purge. Cloud Run can't mount a file, so it goes in
the image:

```dockerfile
FROM ghcr.io/dvir-daniel/companyflags:0.9
COPY companyflags.config.ts /app/companyflags.config.ts
```

```ts
// companyflags.config.ts: without it, the purge never runs
import { defineConfig } from 'companyflags/config';
import { cloudCdn, defaultPlugins } from 'companyflags/plugins';

export default defineConfig({ plugins: [...defaultPlugins(), cloudCdn()] });
```

`cloudCdn()` reads `FF_CLOUD_CDN_PROJECT`, `FF_CLOUD_CDN_URL_MAP` and `FF_CLOUD_CDN_HOST`. Add `metrics()` to the list
for [Monitoring → Metrics](/self-hosting/monitoring#metrics).

The service's settings that matter, and why:

| Setting | Why |
|---|---|
| `--no-cpu-throttling` (instance-based billing) | The background loop works between requests. With request-based billing, CPU stops between requests and publishes, scheduled changes and webhooks stall. |
| `--min=2` | Without a minimum, an idle instance stops within 15 minutes, and the loop stops with it. Minimum instances may still be restarted at any time; that's fine, every instance works from the same database. |
| `--timeout=3600` | The default 300 seconds cuts every change-event stream every 5 minutes. 3600 is the most: streams reconnect once an hour. |
| `--concurrency=1000` | The most. Each open stream holds one slot for its whole life, so an instance holds at most 1,000 streams, whatever `FF_EVENT_STREAMS_PER_ENVIRONMENT` says. |
| `--max-instances=4` | Always set it: streams can scale instances out, and each one opens its own pool. |
| `--port=8787` | Cloud Run sets `PORT` to it. Leave HTTP/2 off: the server speaks HTTP/1.1. |
| `--ingress=internal-and-cloud-load-balancing` | The `run.app` address is no longer reachable from the internet, only through the load balancer. |

> **Check this on your setup:** that a stream holds a concurrency slot the way a WebSocket does. Google documents it
> for WebSockets only.

On `SIGTERM`, Cloud Run gives 10 seconds before it kills the container. The server closes streams after 5, so that
fits ([Monitoring → Shutdown](/self-hosting/monitoring#shutdown)).

## Database

**Connect through the built-in socket.** `--add-cloudsql-instances` on the service and `--set-cloudsql-instances` on
the job mount `/cloudsql/<project>:<region>:<instance>`. These connections are encrypted with no setup, and IAM allows
them (`roles/cloudsql.client`):

```text
DATABASE_URL=postgres://flags_app:<hex password>@localhost/flags?host=/cloudsql/acme-flags:europe-west1:flags-pg
```

- Keep `localhost`: `companyflags backup` needs a host in the address, and `pg` uses `?host=` instead.
- Add no `sslmode`: the socket is already encrypted.
- Use a hex password (`openssl rand -hex 24`), so nothing needs encoding.
- Set `--ssl-mode=ENCRYPTED_ONLY` on the instance, for any connection by IP. The socket isn't affected.
- **Roles:** the migrate job connects as `flags_owner`, the service as `flags_app`
  ([Database → Two roles](/self-hosting/database#two-roles-one-that-migrates-one-that-serves)).
- **Connection budget:** the built-in socket allows 100 connections per instance, far above a pool of 10. The real
  limit is `max_connections`, which follows the instance's memory (3.75 to 6 GB: 100; 6 to 7.5 GB: 200; 7.5 to 15 GB:
  400). With `--max-instances=4`, `2 × 4 × 10 + 2 + 10 = 92`, which fits `db-custom-1-3840` (100). Move to
  `db-custom-2-7680` before you raise `--max-instances`
  ([Database → Connection pool and budget](/self-hosting/database#connection-pool-and-budget)).
- **Backups:** automated backups and point-in-time recovery, `--availability-type=REGIONAL` for a standby, and an
  on-demand backup before each upgrade ([Backups](/self-hosting/backups#a-managed-database)).

## Secrets

Secret Manager, as environment variables, **pinned to a version** (`flags-auth-secret:1`, not `latest`): see
[Secrets → Where to keep it](/self-hosting/secrets#where-to-keep-it).

- Pinned, a change is a new revision, and every instance changes together.
- Keep `flags-database-url` (`flags_app`) and `flags-database-url-migrate` (`flags_owner`) apart. Only the job gets
  the owner's.
- To change the database password with no downtime: a second user, a new secret version with it, a deploy, then drop
  the old user.
- The service account needs `roles/secretmanager.secretAccessor` on each secret.

## Load balancer and client addresses

Cloud Run's own address has TLS, but no CDN and no way to add HSTS. Put a global external Application Load Balancer
(`EXTERNAL_MANAGED`) in front, with a Google-managed certificate and serverless NEGs.

- **Stream timeout:** the backend service timeout doesn't apply to serverless NEGs. Cloud Run's `--timeout=3600` is
  the limit that counts.
- **No load balancer health checks** for serverless backends: Cloud Run's probes are the only ones.
- **HSTS:** a custom response header on both backends.

**The client's address.** The load balancer appends the client and its own address to `X-Forwarded-For`, and Cloud
Run's front end connects to the container from a link-local address. Don't depend on that chain: have the load
balancer set a header of its own on the `flags-app` backend, which a client can't forge through it:

```bash
--custom-request-header='X-Client-IP:{client_ip_address}'       # on the flags-app backend service
FF_TRUSTED_PROXIES=169.254.0.0/16                                # on the Cloud Run service
FF_CLIENT_IP_HEADER=x-client-ip
```

> **Check this on your setup:** Google doesn't document the address Cloud Run's front end connects from. Deploy a
> small service that echoes its peer address behind the same load balancer, and check it is in `169.254.0.0/16`. If
> it isn't, the header is ignored and every device counts as one address: one shared sign-in limit, and only 100
> streams per instance.

## Health checks

Cloud Run has startup and liveness probes, set on the service in [First deploy](#first-deploy)
([Monitoring → Health checks](/self-hosting/monitoring#health-checks)):

- **Startup probe on `/readyz`.** The startup window (`failureThreshold × periodSeconds`) can't be more than 600
  seconds.
- **Liveness probe on `/healthz`.**
- **No readiness probe.**
- Watch `/readyz` for `failing` and `warnings` with an uptime check, or the `metrics()` plugin.

## CDN

Two backend services, each with its own serverless NEG for the same Cloud Run service:

- `flags-app`, CDN off: the URL map's default. `/api`, `/ofrep`, `/sdk`, `/healthz` and the console go here. Never
  enable CDN or dynamic compression on it: OFREP and its streams go this way
  ([Proxies and HTTPS](/self-hosting/proxies#keep-ofrep-and-streams-off-the-cdn)).
- `flags-cdn`, CDN on, for the path rule `/cdn/v1/flags/*`:
  - **cache mode `USE_ORIGIN_HEADERS`.** It caches only what the server says may be cached: a wrong link's `404` has
    `no-store` and is never kept, and browsers get `max-age=0` unchanged. Not `FORCE_CACHE_ALL`: it overrides the
    server's headers;
  - **`--no-cache-key-include-query-string`**, so `?x=1` can't bypass the cache; no header or cookie keys;
  - negative caching and dynamic compression off. The server already gzips.

Cloud CDN reads `CDN-Cache-Control` (since August 2026): 60 seconds, with `stale-while-revalidate`. It doesn't
support `stale-if-error`. While the server can't be reached, it serves a stale copy only for the
`stale-while-revalidate` window, not for a day. With a purge set up the server sends a longer window
([CDN → What each CDN honours](/self-hosting/cdn#what-each-cdn-honours)). `Cache-Tag` reaches the device, but the
tags are opaque: they show no entity's key.

> **Check this on your setup:** stop the service and see how long the CDN keeps answering. And whether Cloud CDN
> answers a browser's own `If-None-Match` with a `304` (look for an `Age` header).

**Purge on publish** with the [`cloudCdn()` plugin](/reference/plugins#cloudcdnoptions), listed in the thin image's
config file ([Compute](#compute)). It invalidates by cache tag, with the service account's own token: no token is
stored. The service account has the custom role with only `compute.urlMaps.invalidateCache`
([First deploy](#first-deploy)), not `roles/compute.networkAdmin`. An invalidation takes effect in about 10 seconds,
which the second purge, about 11 seconds after a publish, covers.

A manual purge of one environment:

```bash
gcloud compute url-maps invalidate-cdn-cache flags-map --path='/cdn/v1/flags/prod/*' --host=flags.example.com --async
```

**The country.** The `flags-cdn` backend sets the custom response header `CF-IPCountry` to `{client_region}`
([First deploy](#first-deploy)). Without it, `geo.country` is unknown and locked rules apply.

> **Check this on your setup:** this way hasn't been tried. Request a file and look for the header.

## Upgrades

The service runs with `FF_MIGRATE=off`. The `flags-migrate` job runs `companyflags migrate` before each deploy, as
`flags_owner` ([Upgrading](/self-hosting/upgrading#several-servers-or-a-rolling-upgrade)). Build and push the new thin
image first:

```bash
IMG=europe-west1-docker.pkg.dev/acme-flags/flags/companyflags:0.9
gcloud sql backups create --instance=flags-pg
gcloud run jobs update flags-migrate --image=$IMG --region=europe-west1
gcloud run jobs execute flags-migrate --region=europe-west1 --wait
gcloud run deploy companyflags --image=$IMG --region=europe-west1
```

## Pitfalls

- **No embedded database on Cloud Run.** Its disk is memory, gone at every restart, and each instance would get its
  own empty database ([Database → The embedded database](/self-hosting/database#the-embedded-database)).
- **Request-based billing** stalls publishes, scheduled changes and webhooks whenever no request is in flight.
- **Streams scale instances out:** 1,000 per instance at most, and each new instance opens its own pool. Keep
  `--max-instances` inside the connection budget.
- **Without the client header**, every device counts as one address: one sign-in limit for everyone, and 100
  streams per instance.
- **Cost:** instance-based billing charges for every instance's whole life, minimum instances included; a regional
  Cloud SQL instance costs about twice a zonal one; the forwarding rule has an hourly charge; log only a sample of the
  CDN backend's requests. Keep Cloud Run and Cloud SQL in one region.

## Go live

Go through the [Production Checklist](/self-hosting/production).
