---
title: "Google Cloud"
description: "Run CompanyFlags on Google Cloud: Cloud Run behind a global load balancer, Cloud SQL over its built-in socket, Secret Manager, and Cloud CDN for the CDN files only."
---

This page sets up CompanyFlags on Google Cloud for production: two or more instances, a managed Postgres, and a CDN
that answers apps' CDN files. It assumes you know the [production checklist](/self-hosting/production); it says
only what is different on Google Cloud.

## What you build

```text
flags.example.com ─► global external Application Load Balancer (HTTPS)
                      ├─ /cdn/v1/flags/*  ─► backend cf-cdn (Cloud CDN on) ─┐
                      └─ everything else  ─► backend cf-app (no CDN) ───────┴─► Cloud Run service, 2+ instances, :8787
every instance, the migrate job ─► Cloud SQL for PostgreSQL (built-in socket, encrypted)
secrets: Secret Manager, pinned versions          logs: Cloud Logging
```

- **Compute: Cloud Run.** One stateless container with its state in Postgres is what it is built for. Use GKE only if
  you already run it, or need streams longer than an hour.
- **Database: Cloud SQL for PostgreSQL, Enterprise edition.** AlloyDB has no built-in Cloud Run socket and costs more
  for a load this small.
- **Cloud CDN** is on one backend, for the CDN files only. Media CDN doesn't fit: it is built for video.

## Compute: Cloud Run

The settings that matter, and why:

| Setting | Why |
|---|---|
| `--no-cpu-throttling` (instance-based billing) | The server works between requests: publishes, scheduled changes, webhooks and the second CDN purge run in loops every second. With request-based billing, CPU stops between requests and they stall. |
| `--min=2` | Without a minimum, an idle instance stops within 15 minutes, and the loops stop with it. Minimum instances may still be restarted at any time; that's fine, every instance works from the same database. |
| `--timeout=3600` | The default 300 seconds cuts every change-event stream every 5 minutes. 3600 is the most: streams reconnect once an hour. |
| `--concurrency=1000` | The most. Each open stream holds one slot for its whole life, so an instance holds at most 1,000 streams, whatever `FF_EVENT_STREAMS_PER_ENVIRONMENT` says. |
| `--max-instances=4` | Always set it: streams can scale instances out, and each one opens its own pool (below). |
| `--port=8787` | Cloud Run sets `PORT` to it. Leave HTTP/2 off: the server speaks HTTP/1.1. |
| `--ingress=internal-and-cloud-load-balancing` | The `run.app` address is no longer reachable from the internet, only through the load balancer. |

> **Check this on your setup:** that a stream holds a concurrency slot the way a WebSocket does. Google documents it
> for WebSockets only.

On `SIGTERM`, Cloud Run gives 10 seconds before it kills the container. The server closes streams after 5, so that
fits ([Production](/self-hosting/production#6-graceful-shutdown)).

## Database: Cloud SQL

**Connect through the built-in socket.** `--add-cloudsql-instances` on the service and `--set-cloudsql-instances`
on the job mount `/cloudsql/<project>:<region>:<instance>`. These connections are encrypted with no setup, and IAM
allows them (`roles/cloudsql.client`):

```text
DATABASE_URL=postgres://flags_owner:<hex password>@localhost/flags?host=/cloudsql/acme-flags:europe-west1:flags-pg
```

- Keep `localhost`: `companyflags backup` needs a host in the address, and `pg` uses `?host=` instead.
- Add no `sslmode`: the socket is already encrypted.
- Use a hex password (`openssl rand -hex 24`), so nothing needs encoding.
- Set `--ssl-mode=ENCRYPTED_ONLY` on the instance, for any connection by IP. The socket isn't affected.

**Connection budget.** The built-in socket allows 100 connections per instance; a pool of 10 is far below it. The real
limit is `max_connections`, which follows the instance's memory (3.75 to 6 GB: 100; 6 to 7.5 GB: 200; 7.5 to 15 GB:
400). A deploy runs the old and new revisions side by side, so count both:

```text
2 × max-instances × FF_DB_POOL + the job's pool + room for you  ≤  max_connections
2 × 4 × 10                     + 2              + 10            =  92    (db-custom-1-3840: 100)
```

Move to `db-custom-2-7680` before you raise `--max-instances`.

**`btree_gist`.** Only members of `cloudsqlsuperuser` may create extensions. Users made with `gcloud sql users
create` are members, so the migrate job runs as one (`flags_owner`). For the service on a role that only reads and
writes rows, create `flags_app` in SQL, as on the [AWS page](/self-hosting/aws#database-rds-for-postgresql).

**Backups.** Automated backups and point-in-time recovery, `--availability-type=REGIONAL` for a standby, and an
on-demand backup before each upgrade (`gcloud sql backups create`). The image has no `pg_dump`
([Backups](/self-hosting/backups)).

## Secrets

Secret Manager, as environment variables, **pinned to a version**:

```bash
--set-secrets=BETTER_AUTH_SECRET=cf-auth-secret:1,DATABASE_URL=cf-database-url:1
```

- Secrets are read when an instance starts. With `latest`, instances started after a new version get it and older
  ones don't: people are signed out depending on which instance answers. Pinned, a change is a new revision, and
  every instance changes together.
- **Never rotate `BETTER_AUTH_SECRET` on a schedule.** A new one signs everyone out, changes the setup link, and makes
  sealed values unreadable (webhooks' headers and signing secrets) until an admin saves them again. Keep it with your
  backups.
- To change the database password with no downtime: a second user, a new secret version with it, a deploy, then drop
  the old user.
- The service account needs `roles/secretmanager.secretAccessor` on each secret. The job gets the same secrets.

## Load balancer and client addresses

Cloud Run's own address has TLS, but no CDN and no way to add HSTS. Put a global external Application Load Balancer
(`EXTERNAL_MANAGED`) in front, with a Google-managed certificate and serverless NEGs.

- **Stream timeout:** the backend service timeout doesn't apply to serverless NEGs. Cloud Run's `--timeout=3600` is
  the limit that counts.
- **No load balancer health checks** for serverless backends: Cloud Run's probes are the only ones.
- **HSTS:** a custom response header on both backends.

**The client's address.** The load balancer appends the client and its own address to `X-Forwarded-For`, and Cloud
Run's front end connects to the container from a link-local address. Don't depend on that chain: have the load
balancer set a header of its own on the `cf-app` backend, which a client can't forge through it:

```bash
--custom-request-header='X-Client-IP:{client_ip_address}'       # on the cf-app backend service
FF_TRUSTED_PROXIES=169.254.0.0/16                                # on the Cloud Run service
FF_CLIENT_IP_HEADER=x-client-ip
```

> **Check this on your setup:** Google doesn't document the address Cloud Run's front end connects from. Deploy a
> small service that echoes its peer address behind the same load balancer, and check it is in `169.254.0.0/16`. If
> it isn't, the header is ignored and every device counts as one address: one shared sign-in limit, and only 100
> streams per instance.

## Health checks

- **Startup probe on `/readyz`:** traffic waits until the database answers and every snapshot is loaded. The startup
  window (`failureThreshold × periodSeconds`) can't be more than 600 seconds.
- **Liveness probe on `/healthz`:** a failed liveness probe kills the instance, so it checks only that the process
  answers.
- **No readiness probe.** During a database outage every instance fails `/readyz` at once, and they would all stop
  serving the values they still have.
- Watch `/readyz` for `failing` and `warnings` with an uptime check or the `metrics()` plugin
  ([Production](/self-hosting/production#5-health-checks)).

## Migrations

The service runs with `FF_MIGRATE=off`. A Cloud Run job runs `companyflags migrate` before each deploy, as
`flags_owner` ([Upgrading](/self-hosting/upgrading)):

```bash
gcloud sql backups create --instance=flags-pg
gcloud run jobs update cf-migrate --image=ghcr.io/dvir-daniel/companyflags:0.9 --region=europe-west1
gcloud run jobs execute cf-migrate --region=europe-west1 --wait
gcloud run deploy companyflags --image=ghcr.io/dvir-daniel/companyflags:0.9 --region=europe-west1
```

## CDN: Cloud CDN on the CDN files

Two backend services, each with its own serverless NEG for the same Cloud Run service:

- `cf-app`, CDN off: the URL map's default. `/api`, `/ofrep`, `/sdk`, `/healthz` and the console go here.
- `cf-cdn`, CDN on, for the path rule `/cdn/v1/flags/*`:
  - **cache mode `USE_ORIGIN_HEADERS`.** It caches only what the server says may be cached: a wrong link's `404` has
    `no-store` and is never kept, and browsers get `max-age=0` unchanged. Not `FORCE_CACHE_ALL`: it overrides the
    server's headers;
  - **`--no-cache-key-include-query-string`**, so `?x=1` can't bypass the cache; no header or cookie keys;
  - negative caching and dynamic compression off. The server already gzips.

Cloud CDN reads `CDN-Cache-Control` (since August 2026): 60 seconds, with `stale-while-revalidate`. It doesn't
support `stale-if-error`. While the server can't be reached, it serves a stale copy only for the
`stale-while-revalidate` window, not for a day. With a purge set up the server sends a longer window
([CDN](/self-hosting/cdn#what-each-cdn-honours)).

> **Check this on your setup:** stop the service and see how long the CDN keeps answering. And whether Cloud CDN
> answers a browser's own `If-None-Match` with a `304` (look for an `Age` header).

**Purge on publish** with the [`cloudCdn()` plugin](/reference/plugins#cloudcdnoptions). Set `FF_CLOUD_CDN_PROJECT`,
`FF_CLOUD_CDN_URL_MAP` and `FF_CLOUD_CDN_HOST`, or in the config file:

```ts
import { defaultPlugins, cloudCdn } from 'companyflags/plugins';

export default defineConfig({
  plugins: [...defaultPlugins(), cloudCdn({ project: 'acme-flags', urlMap: 'cf-map', host: 'flags.example.com' })],
});
```

It invalidates by cache tag, with the service account's own token: no token is stored. Give the service account a
custom role with only `compute.urlMaps.invalidateCache`, not `roles/compute.networkAdmin`. An invalidation takes
effect in about 10 seconds, which the second purge, about 11 seconds after a publish, covers.

A manual purge of one environment:

```bash
gcloud compute url-maps invalidate-cdn-cache cf-map --path='/cdn/v1/flags/prod/*' --host=flags.example.com --async
```

## Keep OFREP and streams off the CDN

OFREP and its change-event streams go to `cf-app`, which has no CDN. Never enable CDN or dynamic compression on the
backend that carries `/ofrep`: a stream that is held back or cached leaves providers on old values.

## Setup sketch

```bash
P=acme-flags R=europe-west1 I=flags-pg D=flags.example.com
IMG=ghcr.io/dvir-daniel/companyflags:0.9
SA=companyflags@$P.iam.gserviceaccount.com
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com compute.googleapis.com
gcloud iam service-accounts create companyflags
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/cloudsql.client
gcloud iam roles create cdnInvalidator --project=$P --permissions=compute.urlMaps.invalidateCache,compute.urlMaps.get
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=projects/$P/roles/cdnInvalidator

# Database
gcloud sql instances create $I --database-version=POSTGRES_18 --edition=ENTERPRISE --tier=db-custom-1-3840 \
  --region=$R --availability-type=REGIONAL --enable-point-in-time-recovery --ssl-mode=ENCRYPTED_ONLY --deletion-protection
gcloud sql databases create flags --instance=$I
PW=$(openssl rand -hex 24); gcloud sql users create flags_owner --instance=$I --password=$PW

# Secrets
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create cf-auth-secret --data-file=-
printf 'postgres://flags_owner:%s@localhost/flags?host=/cloudsql/%s:%s:%s' $PW $P $R $I \
  | gcloud secrets create cf-database-url --data-file=-
for s in cf-auth-secret cf-database-url; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor; done

# The migrate job, then the service
gcloud run jobs deploy cf-migrate --image=$IMG --region=$R --service-account=$SA \
  --set-cloudsql-instances=$P:$R:$I --set-secrets=DATABASE_URL=cf-database-url:1,BETTER_AUTH_SECRET=cf-auth-secret:1 \
  --set-env-vars=BETTER_AUTH_URL=https://$D,FF_DB_POOL=2 --command=companyflags --args=migrate --max-retries=0
gcloud run jobs execute cf-migrate --region=$R --wait

gcloud run deploy companyflags --image=$IMG --region=$R --service-account=$SA --port=8787 \
  --cpu=1 --memory=1Gi --no-cpu-throttling --min=2 --max-instances=4 --concurrency=1000 --timeout=3600 --cpu-boost \
  --ingress=internal-and-cloud-load-balancing --allow-unauthenticated \
  --add-cloudsql-instances=$P:$R:$I --set-secrets=DATABASE_URL=cf-database-url:1,BETTER_AUTH_SECRET=cf-auth-secret:1 \
  --set-env-vars=BETTER_AUTH_URL=https://$D,FF_MIGRATE=off,FF_DB_POOL=10,FF_TRUSTED_PROXIES=169.254.0.0/16,FF_CLIENT_IP_HEADER=x-client-ip,FF_CLOUD_CDN_PROJECT=$P,FF_CLOUD_CDN_URL_MAP=cf-map,FF_CLOUD_CDN_HOST=$D \
  --startup-probe=httpGet.path=/readyz,httpGet.port=8787,periodSeconds=5,timeoutSeconds=3,failureThreshold=24 \
  --liveness-probe=httpGet.path=/healthz,httpGet.port=8787,periodSeconds=30,timeoutSeconds=5,failureThreshold=3

# Load balancer: two NEGs, two backends, a path rule for the CDN files
gcloud compute addresses create cf-ip --global --ip-version=IPV4 --network-tier=PREMIUM
for n in cf-neg-app cf-neg-cdn; do gcloud compute network-endpoint-groups create $n --region=$R \
  --network-endpoint-type=serverless --cloud-run-service=companyflags; done
HSTS='Strict-Transport-Security: max-age=31536000; includeSubDomains'
gcloud compute backend-services create cf-app --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --custom-request-header='X-Client-IP:{client_ip_address}' --custom-response-header="$HSTS"
gcloud compute backend-services create cf-cdn --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --enable-cdn --cache-mode=USE_ORIGIN_HEADERS --no-cache-key-include-query-string --no-negative-caching \
  --custom-response-header="$HSTS" --enable-logging --logging-sample-rate=0.05
gcloud compute backend-services add-backend cf-app --global --network-endpoint-group=cf-neg-app --network-endpoint-group-region=$R
gcloud compute backend-services add-backend cf-cdn --global --network-endpoint-group=cf-neg-cdn --network-endpoint-group-region=$R
gcloud compute url-maps create cf-map --default-service=cf-app
gcloud compute url-maps add-path-matcher cf-map --path-matcher-name=flags --default-service=cf-app \
  --path-rules='/cdn/v1/flags/*=cf-cdn' --new-hosts=$D
gcloud compute ssl-certificates create cf-cert --domains=$D --global
gcloud compute target-https-proxies create cf-https --url-map=cf-map --ssl-certificates=cf-cert
gcloud compute forwarding-rules create cf-https --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --network-tier=PREMIUM --address=cf-ip --target-https-proxy=cf-https --ports=443
# then: an A record for $D to cf-ip, and a URL map on :80 that redirects to HTTPS
```

- `--allow-unauthenticated` is needed: the load balancer forwards people who aren't signed in to Google. An
  organization policy that forbids `allUsers` blocks it.
- The setup link is in Cloud Logging until the admin account exists. Make it right away, and limit who can read the
  logs.
- In Terraform, instance-based billing is `containers.resources.cpu_idle = false` on `google_cloud_run_v2_service`.

## Pitfalls

- **No embedded database on Cloud Run.** Its disk is memory, gone at every restart, and each instance would get its
  own empty database. The server refuses a second container on the same folder, so a shared volume doesn't help.
  Use Cloud SQL; `companyflags copy-to-postgres` moves an existing one
  ([Backups](/self-hosting/backups#moving-to-postgres)).
- **Request-based billing** stalls publishes, scheduled changes and webhooks whenever no request is in flight.
- **The default 300-second timeout** cuts every stream every 5 minutes. Even at 3600, streams reconnect hourly.
- **Streams scale instances out:** 1,000 per instance at most, and each new instance opens its own pool. Keep
  `--max-instances` inside the connection budget.
- **Without the client header**, every device counts as one address: one sign-in limit for everyone, and 100
  streams per instance.
- **Cloud CDN isn't Cloudflare:** no `stale-if-error`, so a shorter outage cover; and `Cache-Tag` reaches the device
  (the tags are opaque: they show no entity's key).
- **Cost:** instance-based billing charges for every instance's whole life, minimum instances included; a regional
  Cloud SQL instance costs about twice a zonal one; the forwarding rule has an hourly charge; log only a sample of the
  CDN backend's requests. Keep Cloud Run and Cloud SQL in one region.
