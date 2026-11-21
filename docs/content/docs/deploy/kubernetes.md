---
title: "Kubernetes"
description: "Run CompanyFlags on a Kubernetes cluster: a Deployment behind an Ingress, a migrate Job, Postgres managed or from an operator, probes, and scaling."
---

This page runs CompanyFlags on a cluster you already have, from top to bottom: Postgres, the Secret, the migrate Job,
the Deployment, the Service, the Ingress, the admin account, the CDN, metrics, scaling and upgrades. On one VM, use
[Docker Compose](/deploy/docker-compose) instead. On a managed container platform, see [AWS](/deploy/aws),
[Google Cloud](/deploy/google-cloud) or [Azure](/deploy/azure).

## What you build

```text
console, API, OFREP, streams ─► flags.example.com ─► Ingress (HTTPS) ─► Service companyflags ─► Deployment, 2+ pods, :8787
apps' CDN files ──────────────► cdn.flags.example.com ─► CDN (/cdn/v1/flags/* only) ─► the same Ingress
every pod, the migrate Job ───► Postgres 15 or later (managed, or an operator in the cluster), TLS checked
secrets: Kubernetes Secrets (from your secret manager)          logs: the pods' standard output
```

- **One image.** `ghcr.io/dvir-daniel/companyflags` holds the server, the console and the CDN files. It listens on
  port 8787 and runs as the unprivileged `node` user (uid 1000).
- **Postgres holds all state.** Nothing is kept on the pods' disks, so pods come and go freely.
- **A background loop** runs every second in each pod: publishes, scheduled changes, webhooks and the second CDN
  purge. Never scale to zero.
- **No embedded database.** It lives in one folder that only one process may open, and a rolling update starts the
  new pod before the old one stops: the new one can't start. Use Postgres
  ([Configuration → The embedded database](/reference/configuration#the-embedded-database)).

Make a namespace for everything below:

```bash
kubectl create namespace flags
```

## Postgres

Postgres 15 or later; the project tests on 18. Use a managed server, or run one in the cluster with an operator.

### A managed server

Amazon RDS, Cloud SQL and Azure Flexible Server all work. Connect by the server's name and write
`sslmode=verify-full`, so the URL says what happens:

```text
DATABASE_URL=postgres://flags_app:<password>@flags.abc123.eu-west-1.rds.amazonaws.com:5432/flags?sslmode=verify-full
```

The server checks the certificate against the system's authorities, and its name against the host in the URL
([Configuration → TLS and certificate authorities](/reference/configuration#tls-and-certificate-authorities)):

- **Amazon RDS** signs with its own authorities. Put the global bundle in a ConfigMap, mount it, and name it in
  `FF_DATABASE_CA_FILE` (the Deployment below does). Without it, the server can't connect.
- **Azure Flexible Server**: nothing to add. Its roots are in Node's own store.
- **Cloud SQL** by private IP needs the instance's own authority in `FF_DATABASE_CA_FILE`. On GKE, the Cloud SQL Auth
  Proxy as a sidecar is the other way.

```bash
curl -fsSo rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
kubectl -n flags create configmap db-ca --from-file=ca.crt=rds-global-bundle.pem
```

### An operator: CloudNativePG

[CloudNativePG](https://cloudnative-pg.io) runs Postgres in the cluster, with a standby, TLS and backups. This
cluster has three instances, makes the database `app` owned by the role `app`, and creates `btree_gist` once:

```yaml
# postgres.yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: flags-pg, namespace: flags }
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:18
  storage: { size: 20Gi }
  bootstrap:
    initdb:
      database: app
      owner: app
      postInitApplicationSQL:
        - CREATE EXTENSION IF NOT EXISTS btree_gist
```

The operator makes two Secrets the server uses:

- `flags-pg-app`, whose `uri` key is the address of the `app` role on the primary (`flags-pg-rw`). Use it as
  `DATABASE_URL`.
- `flags-pg-ca`, whose `ca.crt` key is the cluster's own authority. Mount it, and name it in `FF_DATABASE_CA_FILE`.
  With a CA file, the server always connects with TLS and checks the certificate and its name.

> **Check this on your setup:** the Secrets' names and keys on your operator version, that the host in `uri` is one
> the server certificate names (`flags-pg-rw`, `flags-pg-rw.flags` or `flags-pg-rw.flags.svc`), and backups: set up
> the operator's own backups to object storage before people depend on it.

### The btree_gist extension

The first start creates `btree_gist`. The role that migrates needs the right to create it, or you create it once
yourself, before the first start
([Configuration → The btree_gist extension](/reference/configuration#the-btree_gist-extension)):

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

On RDS, the master user or the database's owner creates it. On Cloud SQL, a member of `cloudsqlsuperuser`. On Azure,
allowlist it first (`azure.extensions`), then create it as the admin.

### Two roles (optional)

The migrate Job below runs migrations as their own step, so the pods can run as a role that only reads and writes
rows. Once, as the master user, before the first migration:

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

The Job connects as `flags_owner`, the pods as `flags_app`.

> **Check this on your setup:** these grants weren't tested end to end. Try them on a copy first, or start with one
> role for both (CloudNativePG's `app` role is one role for both).

### The connection budget

Each pod opens its own pool of up to `FF_DB_POOL` connections (default 10). A rolling update runs old and new pods
side by side, so count both
([Configuration → Connection pool and budget](/reference/configuration#connection-pool-and-budget)):

```text
2 × most replicas × FF_DB_POOL + the migrate Job's pool + room for you  ≤  max_connections
2 × 4 × 10                     + 2                      + 10            =  92
```

Run `SHOW max_connections;` rather than guess, and cap the HPA's `maxReplicas` so scaling out can't pass it.

## The Secret

`FF_SECRET` is the server's own secret: at least 32 random characters, made once and never changed. It signs
sessions and makes the setup link, and seals the secrets kept for other systems (the Cloudflare token, webhooks'
signing secrets, two-factor secrets). A new one signs everyone out and makes those unreadable. Keep it with your
backups ([Configuration → FF_SECRET](/reference/configuration#ff_secret),
[Changing a secret](/reference/configuration#changing-a-secret)).

Two Secrets: one for the pods, and one for the migrate Job, which holds the owner's address and nothing else.

```bash
kubectl -n flags create secret generic companyflags \
  --from-literal=FF_SECRET="$(openssl rand -base64 32)" \
  --from-literal=DATABASE_URL='postgres://flags_app:<password>@db.example.com:5432/flags?sslmode=verify-full'

kubectl -n flags create secret generic companyflags-migrate \
  --from-literal=DATABASE_URL='postgres://flags_owner:<password>@db.example.com:5432/flags?sslmode=verify-full'
```

- Copy `FF_SECRET` into your secret manager now. The migrate Job reads it from the same Secret.
- For a real cluster, keep the values in your secret manager and sync them with External Secrets, or commit them
  sealed with Sealed Secrets. Pin `FF_SECRET` to one version: pods started after a new version would sign
  differently from the others.
- With CloudNativePG, skip `DATABASE_URL` here: the Deployment reads `uri` from `flags-pg-app`.
- Limit who may read Secrets and create Jobs in the namespace: creating a Job grants the use of its Secrets.

## The migrate Job

Every pod starts with `--no-migrate`. Each version's migrations run once, before its pods, as a Job with a name per
version ([Upgrading → Several servers](/operate/upgrading#several-servers-or-a-rolling-upgrade)):

```yaml
# migrate.yaml
apiVersion: batch/v1
kind: Job
metadata: { name: companyflags-migrate-0-9-0, namespace: flags }
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 1000 }
      containers:
        - name: migrate
          image: ghcr.io/dvir-daniel/companyflags:0.9.0
          command: ["companyflags", "migrate"]
          env:
            - { name: FF_DB_POOL, value: "2" }
            - name: FF_SECRET
              valueFrom: { secretKeyRef: { name: companyflags, key: FF_SECRET } }
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: companyflags-migrate, key: DATABASE_URL } }
```

```bash
kubectl apply -f migrate.yaml
kubectl -n flags wait --for=condition=complete job/companyflags-migrate-0-9-0 --timeout=10m
kubectl -n flags logs job/companyflags-migrate-0-9-0
```

- Each file runs once, in its own transaction, in order, under a lock
  ([Upgrading → How migrations work](/operate/upgrading#how-migrations-work), [CLI → migrate](/reference/cli#migrate)).
- `companyflags migrate --check` lists what would be applied, and exits with `1` when something is pending.
- With an RDS or CloudNativePG authority, add the same `FF_DATABASE_CA_FILE` and volume as the Deployment.
- To automate it: a Helm `pre-install,pre-upgrade` hook, or an Argo CD `PreSync` hook, runs the Job before the new
  Deployment.

## The Deployment

```yaml
# companyflags.yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: companyflags, namespace: flags }
spec:
  replicas: 2
  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
  selector: { matchLabels: { app: companyflags } }
  template:
    metadata: { labels: { app: companyflags } }
    spec:
      terminationGracePeriodSeconds: 30
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: { matchLabels: { app: companyflags } }
      containers:
        - name: companyflags
          image: ghcr.io/dvir-daniel/companyflags:0.9
          command: ["companyflags", "start", "--no-migrate"]
          ports: [{ name: http, containerPort: 8787 }]
          env:
            - { name: FF_PUBLIC_URL, value: "https://flags.example.com" }
            - { name: FF_TRUSTED_PROXIES, value: "10.244.0.0/16" }    # your ingress controller's pods
            - { name: FF_DB_POOL, value: "10" }
            - name: FF_SECRET
              valueFrom: { secretKeyRef: { name: companyflags, key: FF_SECRET } }
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: companyflags, key: DATABASE_URL } }   # CloudNativePG: flags-pg-app, key uri
            # - { name: FF_DATABASE_CA_FILE, value: /etc/db-ca/ca.crt }               # RDS or CloudNativePG
          startupProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
            failureThreshold: 24
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 5
            failureThreshold: 3
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits: { memory: 1Gi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
            # - { name: db-ca, mountPath: /etc/db-ca, readOnly: true }
      volumes:
        - { name: tmp, emptyDir: {} }
        # - { name: db-ca, configMap: { name: db-ca } }            # RDS
        # - { name: db-ca, secret: { secretName: flags-pg-ca } }   # CloudNativePG
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: companyflags, namespace: flags }
spec:
  minAvailable: 1
  selector: { matchLabels: { app: companyflags } }
```

- **Pin `X.Y`** (`0.9`): it gets that line's fixes, never a new schema. Images are built for `linux/amd64` and
  `linux/arm64`.
- **`--no-migrate`** (or `FF_MIGRATE=off`): the pods only check that the schema has every migration they need, and stop
  if it doesn't. So they can run as `flags_app`.
- **The probes follow the rule** ([Monitoring → Health checks](/operate/monitoring#health-checks)): `/healthz` for
  liveness and readiness, `/readyz` only for startup. The server listens only once it has loaded every environment,
  so `/healthz` already means it can serve. Never put readiness on `/readyz`: in a database outage every pod fails
  it at once, and Kubernetes takes them all out while they could still serve what they have in memory.
- **The stop:** on `SIGTERM` the server lets open requests finish, closes streams after 5 seconds, finishes its
  background round and exits. A grace period of 30 seconds is plenty
  ([Monitoring → Shutdown](/operate/monitoring#shutdown)).
- **The read-only disk:** the server writes the port it listens on to `/tmp/companyflags.port` (`FF_PORT_FILE`), so
  `/tmp` is an `emptyDir`. Nothing else is written.
- **Scale out, not up.** Node mostly uses one core: 0.5 to 1 CPU and 512 MB to 1 GB per pod, and more pods.
- **Other settings** go in `env` too: sign-in providers, `FF_SIGNUP_DOMAINS`, `FF_TRUSTED_ORIGINS` for an identity
  provider on your network ([Configuration](/reference/configuration), [Single Sign-On](/operate/single-sign-on)). No
  config file is needed. To use one anyway, mount it at `/app/companyflags.config.ts` from a ConfigMap with `subPath`.

## The Service

```yaml
apiVersion: v1
kind: Service
metadata: { name: companyflags, namespace: flags, labels: { app: companyflags } }
spec:
  type: ClusterIP
  selector: { app: companyflags }
  ports: [{ name: http, port: 80, targetPort: http }]
```

No session affinity: everything is in Postgres, and any pod answers any request.

## The Ingress

The server speaks plain HTTP. Whatever is in front of it must:

- end TLS, and add HSTS: the server sends no `Strict-Transport-Security` header;
- send the client's address in `X-Forwarded-For`;
- not buffer answers, so OFREP's change-event streams and the console's live updates flow;
- keep a read timeout above 120 seconds, for the streams (they send a heartbeat every 25 seconds);
- let bodies of 4 MB through, for imports;
- close idle connections to the pods before the server does: it keeps them 65 seconds (`FF_KEEPALIVE_SECONDS`).

See [Configuration → Timeouts and body sizes](/reference/configuration#timeouts-and-body-sizes).

An example with ingress-nginx's annotations and a certificate from cert-manager. Other controllers name these
settings differently; the HTTPRoute is the Gateway API's way:

```yaml tab="Ingress"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: companyflags
  namespace: flags
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: 4m
    nginx.ingress.kubernetes.io/server-snippet: |
      location ~ ^/(metrics|readyz) { return 404; }
spec:
  ingressClassName: nginx
  tls: [{ hosts: [flags.example.com], secretName: flags-tls }]
  rules:
    - host: flags.example.com
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: companyflags, port: { name: http } } } }
```

```yaml tab="Gateway API"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: companyflags, namespace: flags }
spec:
  parentRefs: [{ name: public, namespace: gateways }]     # a Gateway with a listener for flags.example.com on 443
  hostnames: [flags.example.com]
  rules:
    - matches: [{ path: { type: PathPrefix, value: / } }]
      timeouts: { request: 0s }                            # no limit: streams stay open
      filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set: [{ name: Strict-Transport-Security, value: "max-age=31536000; includeSubDomains" }]
      backendRefs: [{ name: companyflags, port: 80 }]
```

> **Check this on your setup:** your controller's own settings for buffering, timeouts, body size and HSTS.
> ingress-nginx adds HSTS on TLS hosts by default, and its server snippets may be turned off by its admin; it no
> longer gets new releases, so on a new cluster prefer a Gateway API implementation. With the Gateway API, the body
> size and idle timeouts are set in the implementation's own policy, and `request: 0s` is an extended feature.

**Client addresses.** Sign-in rate limits and the stream limits count each client's address. Behind the controller,
every client looks like the controller's pod, so tell the server which connections are your proxies:
`FF_TRUSTED_PROXIES` is the range the controller's pods have (the pod network, such as `10.244.0.0/16`, or the
controller's node range with `hostNetwork`). From those connections only, the server reads `X-Forwarded-For`, from the
right ([Configuration → Client addresses](/reference/configuration#client-addresses)).

- Leave `FF_CLIENT_IP_HEADER` unset, unless the controller sets a header of its own that a client can't send (then
  name it, with `FF_TRUSTED_PROXIES` still set).
- Behind a cloud load balancer, the controller must see the client's address: `externalTrafficPolicy: Local` on its
  Service, or the PROXY protocol.

**What to expose** ([Configuration → What to expose](/reference/configuration#what-to-expose)):

| Path | Expose it to |
|---|---|
| `/cdn/v1/flags/…`, `/ofrep/…` | Everyone: apps read flags there |
| `/sdk/…` | Your backends. Inside the cluster they can use `http://companyflags.flags.svc` |
| `/hooks/…` | The systems that post to webhooks in |
| `/healthz` | Your load balancer |
| `/readyz`, `/metrics` | Inside the cluster only: the example answers `404` for them on the public host |
| The console, `/api`, `/oauth`, `/.well-known`, `/mcp` | Everyone, or your network or VPN only |

## The admin account

Apply everything, then read the setup link from the log:

```bash
kubectl apply -f companyflags.yaml -f service.yaml -f ingress.yaml
kubectl -n flags rollout status deploy/companyflags
kubectl -n flags logs deploy/companyflags | grep setup
```

```text
[companyflags] nobody has an account yet: make the admin account at https://flags.example.com/api/setup/<secret>
```

Open it and create the admin account, then invite everyone else from **Settings → People**
([Sign-In → The first account](/operate/sign-in#the-first-account)).

:::warning[Make the account right after the first start]
Until the admin account exists, whoever has the link can make it, and every pod prints it at every start. Make the
account at once, and limit who can read the namespace's logs (and your log store) until then.
:::

## CDN and purge

Only if apps read CDN files ([CDN Files](/integrations/cdn-files)). Apps that read flags with OFREP need no CDN.

- Give the CDN its own host, `cdn.flags.example.com`, with `flags.example.com` as its origin, and let it cache only
  `/cdn/v1/flags/*`. OFREP and its streams go straight to the Ingress
  ([Configuration → Keep OFREP and streams off the CDN](/reference/configuration#keep-ofrep-and-streams-off-the-cdn)).
- Have the CDN set `CF-IPCountry` on the files' answers, for rules on `geo.country`.

A purge after each publish gets a change to apps in seconds instead of within the minute the CDN keeps a file
([CDN Purge](/integrations/cdn-purge)). Turn it on with variables in the Deployment's `env`; no config file:

| CDN | Variables | Credentials |
|---|---|---|
| Cloudflare | `CF_ZONE_ID`, `CF_API_TOKEN` (from a Secret), or save both in **Settings → CDN** | A token with only **Zone → Cache Purge → Purge** |
| CloudFront | `FF_CLOUDFRONT_DISTRIBUTION_ID` | On EKS, IRSA or Pod Identity for the pods' service account, with only `cloudfront:CreateInvalidation` on the distribution |
| Cloud CDN | `FF_CLOUD_CDN_PROJECT`, `FF_CLOUD_CDN_URL_MAP` (and `FF_CLOUD_CDN_HOST`) | On GKE, Workload Identity, with a custom role that has only `compute.urlMaps.invalidateCache` |

Azure Front Door has no purge: a change reaches apps within about a minute.

## Metrics

Turn on `/metrics` with `FF_METRICS=on`, and guard it with `FF_METRICS_TOKEN`
([Metrics](/integrations/metrics), [Monitoring → Metrics](/operate/monitoring#metrics)):

```yaml
# in the Deployment's env
- { name: FF_METRICS, value: "on" }
- name: FF_METRICS_TOKEN
  valueFrom: { secretKeyRef: { name: companyflags-metrics, key: token } }
```

With the Prometheus Operator, scrape every pod through the Service:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: companyflags, namespace: flags }
spec:
  selector: { matchLabels: { app: companyflags } }
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
      authorization: { type: Bearer, credentials: { name: companyflags-metrics, key: token } }
```

Each pod counts its own requests, so scrape every one. Alert on `companyflags_publish_failing`,
`companyflags_purge_failing`, `companyflags_warnings`, `companyflags_publish_lag_seconds` and
`companyflags_database_up` ([Monitoring → Alerts](/operate/monitoring#alerts)).

The default integrations (OFREP, flagd, CDN files, the Cloudflare purge, webhooks, MCP) are on. Turn some off with
`FF_INTEGRATIONS_OFF`, e.g. `mcp,webhooks` ([Integrations](/integrations/overview)).

## Scaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: companyflags, namespace: flags }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: companyflags }
  minReplicas: 2
  maxReplicas: 4               # inside the connection budget
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
```

- **Never fewer than 2**, and never zero: the background loop runs every second in each pod.
- **Cap `maxReplicas`** by the connection budget: each new pod opens its own pool.
- **Streams grow memory, not CPU.** Each open change-event stream is a connection the pod holds. Each pod keeps at most
  `FF_EVENT_STREAMS_PER_ENVIRONMENT` (10000) for one environment and `FF_EVENT_STREAMS_PER_CLIENT` (100) for one
  client address; past them, providers poll instead.
- **Each pod counts on its own:** stream limits and sign-in rate limits.
- **A publish reaches every pod** in about a second. API keys, links and services are cached for up to a minute per
  pod.
- **Scale-in and deploys reconnect streams.** That is expected: providers reconnect, or poll.

## Upgrades

1. Read the [changelog](https://github.com/dvir-daniel/companyflags/blob/main/CHANGELOG.md) for what each version
   brings.
2. Back up the database ([Backups](/operate/backups)): the schema only moves forward.
3. Run the new version's migrate Job, with a new name, and wait for it.
4. Move the Deployment to the new image:

   ```bash
   kubectl -n flags set image deploy/companyflags companyflags=ghcr.io/dvir-daniel/companyflags:0.10
   kubectl -n flags rollout status deploy/companyflags
   ```

Old and new pods serve side by side while it rolls, which is safe: each release's migrations work with the version
before it. Upgrade one release line at a time (0.9 to 0.10, then 0.10 to 0.11), and every pod before the next one.
A pod started without `--no-migrate` refuses a database with migrations it doesn't know, so keep the flag on every
version you might roll back to.

**Rolling back** means restoring the backup: stop every pod (`kubectl scale --replicas=0`), restore it, start the
version you had with the same `FF_SECRET`, and check `/readyz` answers `200`. Changes made since the backup are lost
([Upgrading → Rolling back](/operate/upgrading#rolling-back)).

## Pitfalls

- **The embedded database** can't run here: a rolling update starts the new pod first, and the folder opens in one
  process only.
- **Readiness on `/readyz`** takes every pod out during a database outage.
- **Buffering or a short read timeout** in the Ingress leaves providers on old values, or cuts streams.
- **`FF_TRUSTED_PROXIES` unset:** every device counts as the controller's address. One sign-in limit for everyone,
  and 100 streams per pod.
- **A CPU limit too tight** throttles the background loop: publishes and scheduled changes lag.
- **Access logs hold secrets.** CDN file paths carry each entity's link secret: treat the Ingress's and the CDN's logs
  as secret.

## Checklist

- [ ] Postgres 15 or later, `btree_gist` created, the certificate checked (`verify-full` or `FF_DATABASE_CA_FILE`).
- [ ] `FF_SECRET` made once, in your secret manager, pinned, and kept with the backups.
- [ ] `FF_PUBLIC_URL` is the `https` address people type, and the image is pinned to `X.Y`.
- [ ] The migrate Job ran, and the pods start with `--no-migrate`.
- [ ] The admin account is made, and few people can read the logs.
- [ ] TLS with HSTS, no buffering, a read timeout above 120 seconds, 4 MB bodies, and `FF_TRUSTED_PROXIES` set.
- [ ] Probes: `/healthz` for liveness and readiness, `/readyz` only for startup.
- [ ] `/metrics` and `/readyz` not on the public host; alerts on `failing`, `warnings` and lag.
- [ ] At least 2 replicas, a PodDisruptionBudget, and `maxReplicas` inside the connection budget.
- [ ] Backups run, and a restore was tested.
- [ ] *Only with CDN files:* the CDN caches only `/cdn/v1/flags/*`, and a purge runs on publish.

Then go through the full [Production Checklist](/operate/production).
