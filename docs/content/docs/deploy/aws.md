---
title: "AWS"
description: "Run CompanyFlags on AWS, top to bottom: ECS on Fargate behind an ALB, RDS for PostgreSQL, Secrets Manager, and CloudFront for the CDN files only."
---

This recipe runs CompanyFlags on managed containers with two or more instances: ECS tasks on Fargate, RDS for
PostgreSQL, and CloudFront for the CDN files. Everything it needs is on this page. For one server, see
[Docker Compose](/deploy/docker-compose); for a cluster, [Kubernetes](/deploy/kubernetes).

## What you build

```text
console, API, OFREP, streams ─► flags.example.com ─► ALB (HTTPS) ─► ECS service on Fargate, 2+ tasks, :8787
apps' CDN files ──────────────► cdn.flags.example.com ─► CloudFront (/cdn/v1/flags/* only) ─► the same ALB
every task, the migrate task ─► RDS for PostgreSQL (Multi-AZ, TLS with the RDS CA bundle)
secrets: Secrets Manager → ECS secrets          logs: CloudWatch Logs
```

- **Compute: a standard ECS service on Fargate.** App Runner takes no new accounts since April 30, 2026. Use EKS
  only if you already run it: then follow [Kubernetes](/deploy/kubernetes).
- **Database: RDS for PostgreSQL 18.** Postgres 15 or later works. Aurora Serverless v2 never pauses for this app:
  every task keeps a pool open and asks the database once a second.
- **CloudFront has its own hostname** and caches the CDN files only. Everything else goes to the ALB.
- **One image, many tasks.** Every task runs the same image with the same settings. A publish reaches every task in
  about a second. A background loop in each task runs publishes, scheduled changes, webhooks and the second CDN purge
  every second, so tasks must never scale to zero.

## First deploy

This is a list of resources for Terraform, CDK or CloudFormation, in the order you need them, not a script. The
commands for the migrate task are under [Upgrades](#upgrades).

1. **Network.** A VPC in 3 zones; public subnets for the ALB, private ones for tasks and RDS; NAT, or VPC endpoints for
   `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager` and S3. Tasks need the internet for single sign-on, webhooks and the
   CloudFront API. Security groups: the ALB takes 443 and 80; tasks take 8787 from the ALB only; RDS takes 5432 from
   tasks only.
2. **Database and roles.** A subnet group, a `postgres18` parameter group, and the instance (Multi-AZ, gp3,
   `backup_retention_period=14`, deletion protection). Then, as the master user, `btree_gist` and the roles
   `flags_owner` and `flags_app` ([Database](#database)).
3. **Image.** An ECR repository, and the thin image below pushed to it ([Compute](#compute)).
4. **Secrets.** `companyflags/prod` and `companyflags/migrate` in Secrets Manager ([Secrets](#secrets)).
5. **IAM.** The execution role (`AmazonECSTaskExecutionRolePolicy` and `secretsmanager:GetSecretValue`); the task role
   (`cloudfront:CreateInvalidation`).
6. **Migrate task.** The `companyflags-migrate` task definition, run once before the service starts
   ([Upgrades](#upgrades)).
7. **Service.** The cluster, the `companyflags` task definition and the service ([Compute](#compute)).
8. **Load balancer and CDN.** The ALB with idle timeout 60, its target group and listeners on 443 and 80
   ([below](#load-balancer-and-client-addresses)); CloudFront with its cache policy, its 404 function and its
   `CacheTagConfig` ([CDN](#cdn)).
9. **Certificates and DNS.** ACM in your region and in `us-east-1`; `flags` to the ALB, `cdn` to CloudFront.
10. **The admin account.** Make it at once ([below](#the-admin-account)). The setup link is in CloudWatch Logs.

> **Check this on your setup:** `CacheTagConfig` is in CloudFormation and CDK (`CfnDistribution.cacheTagConfig`).
> If your Terraform provider doesn't have it yet, set it with `aws cloudfront update-distribution`.

### The admin account

A new install has no accounts. While nobody has one, every task prints a setup link at every start:

```text
[companyflags] nobody has an account yet: make the admin account at https://flags.example.com/api/setup/<secret>
```

Open it and create the admin account, then invite everyone else from **Settings → People**. The link is built on
`FF_PUBLIC_URL` and made from `FF_SECRET`, so every task prints the same one. It stops working once the account
exists.

:::warning[Make the account right after the first start]
Until the admin account exists, whoever has the link can make it, and it is in the log group at every start. Make
the account as soon as the service first starts, and limit who can read the log group until then.
:::

People then sign in with email and password, Google, GitHub or Microsoft, or your identity provider: see
[Sign-In](/operate/sign-in) and [Single Sign-On](/operate/single-sign-on).

## Compute

**The image is a thin one of your own**, only for the RDS CA bundle. Fargate can't mount a file, so the bundle goes
in the image:

```dockerfile
FROM ghcr.io/dvir-daniel/companyflags:0.9
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
```

Integrations need no file: environment variables turn them on. `FF_CLOUDFRONT_DISTRIBUTION_ID` turns on the
CloudFront purge ([CDN](#cdn)). `FF_METRICS=on` serves `/metrics`, and `FF_METRICS_TOKEN` (a secret) guards it
([Health checks](#health-checks)). `FF_INTEGRATIONS_OFF=mcp,webhooks` turns default ones off
([Integrations](/integrations/overview)). Pin the image to `0.9`: it gets that release line's fixes, never a new
schema.

The parts of the task definition that matter:

```json
{
  "family": "companyflags",
  "requiresCompatibilities": ["FARGATE"], "networkMode": "awsvpc",
  "cpu": "512", "memory": "1024",
  "runtimePlatform": { "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX" },
  "containerDefinitions": [{
    "name": "companyflags",
    "image": "<account>.dkr.ecr.<region>.amazonaws.com/companyflags:0.9",
    "portMappings": [{ "containerPort": 8787, "protocol": "tcp" }],
    "environment": [
      { "name": "FF_PUBLIC_URL", "value": "https://flags.example.com" },
      { "name": "FF_MIGRATE", "value": "off" },
      { "name": "FF_DB_POOL", "value": "10" },
      { "name": "FF_TRUSTED_PROXIES", "value": "10.0.0.0/24,10.0.1.0/24,10.0.2.0/24" },
      { "name": "FF_DATABASE_CA_FILE", "value": "/etc/ssl/rds-global-bundle.pem" },
      { "name": "FF_CLOUDFRONT_DISTRIBUTION_ID", "value": "E2EXAMPLE123" },
      { "name": "FF_METRICS", "value": "on" }
    ],
    "secrets": [
      { "name": "FF_SECRET", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:companyflags/prod:FF_SECRET::" },
      { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:companyflags/prod:DATABASE_URL::" },
      { "name": "FF_METRICS_TOKEN", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:companyflags/prod:FF_METRICS_TOKEN::" }
    ],
    "healthCheck": {
      "command": ["CMD-SHELL", "wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1"],
      "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30
    },
    "stopTimeout": 30,
    "logConfiguration": { "logDriver": "awslogs", "options": {
      "awslogs-group": "/ecs/companyflags", "awslogs-region": "<region>", "awslogs-stream-prefix": "ecs", "mode": "non-blocking" } }
  }]
}
```

- **The image sets `NODE_ENV=production`.** The task then refuses to start without `FF_SECRET` (at least 32
  characters) or `FF_PUBLIC_URL`, and says which one is wrong.
- **Images are built for amd64 and arm64.** The image includes `wget`, for the health check. It listens on 8787 and
  runs as the unprivileged `node` user.
- **Scale out, not up.** Node mostly uses one core: give each task 0.5 to 1 vCPU and run more tasks.
- **Service:** `desiredCount` 2 or more, in private subnets in at least 2 zones; `minimumHealthyPercent=100`,
  `maximumPercent=200`; the deployment circuit breaker with rollback; `healthCheckGracePeriodSeconds=60`. Cap the
  service's maximum tasks (4 here) so scaling out can't pass the [connection budget](#database).
- **Stop timeout above 5 seconds.** On `SIGTERM` the server stops taking requests, closes the console's streams after
  5 seconds, finishes its round of background work and exits. `stopTimeout` 30 is enough
  ([Monitoring → Shutdown](/operate/monitoring#shutdown)).
- **Logs:** set a retention on the log group (the default keeps them forever). The server's own lines start with
  `[companyflags]`.

## Database

Use Multi-AZ, gp3 storage and automated backups. `db.t4g.small` or `db.t4g.medium` is plenty to start. Never use the
embedded database on Fargate: its disk is gone when a task stops, and a rolling deploy can't start a second task on it
([Configuration → The embedded database](/reference/configuration#the-embedded-database)).

**`btree_gist`.** The first migration creates the `btree_gist` extension. On RDS, the master user, or the database's
owner role, creates it. Create it once yourself, below.

**Two roles: one that migrates, one that serves.** The migrate task changes the schema; the service only reads and
writes rows. Once, as the master user, before the first migration:

```sql
CREATE ROLE flags_owner LOGIN PASSWORD '…';   -- migrations
CREATE ROLE flags_app   LOGIN PASSWORD '…';   -- the service, with FF_MIGRATE=off
CREATE DATABASE flags OWNER flags_owner;
\c flags
CREATE EXTENSION IF NOT EXISTS btree_gist;
GRANT CONNECT ON DATABASE flags TO flags_app;
GRANT USAGE ON SCHEMA public TO flags_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flags_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flags_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flags_app;
```

The service connects as `flags_app`, the migrate task as `flags_owner`. Keep the two addresses in two secrets
([Secrets](#secrets)), and give the owner's only to the migrate task.

> **Check this on your setup:** these grants weren't tested end to end. Try them on a copy first, or start with one
> role for both.

**TLS.** RDS certificates are signed by RDS's own authorities. Without them, the server can't connect. The thin image
carries the global bundle, which has every region's authorities, and `FF_DATABASE_CA_FILE` names it. The server then
always connects with TLS, and checks the certificate and the host name against that file
([Configuration → TLS](/reference/configuration#tls-and-certificate-authorities)):

```text
DATABASE_URL=postgres://flags_app:<password>@companyflags.abc123.<region>.rds.amazonaws.com:5432/flags?sslmode=verify-full
```

Write `sslmode=verify-full`, so the address says what happens. A `sslmode` that doesn't check the certificate
(`disable`, `no-verify`) with the file set stops the start, and so does a file with no certificate in it.
`companyflags migrate` uses the same file.

**Connection budget.** `FF_DB_POOL` (default 10) is the most connections one task opens. A deploy runs old and new
tasks side by side, so count both:

```text
2 × most tasks × FF_DB_POOL + the migrate task's pool + room for you  ≤  max_connections
2 × 4          × 10         + 2                       + 10            =  92
```

`max_connections` follows the instance's memory: run `SHOW max_connections;` rather than guess. Give the migrate task
`FF_DB_POOL=2`.

**Backups.** RDS's own automated backups, with point-in-time recovery, run while the service serves. Take a snapshot
before each upgrade ([Upgrades](#upgrades); [Backups → A managed database](/operate/backups#a-managed-database)).
Keep `FF_SECRET` with your backups. Now and then, restore the latest snapshot into a new instance, start a test task
on it with the same `FF_SECRET`, and check that `/readyz` answers `200` and the flags are there
([Backups → Testing a restore](/operate/backups#testing-a-restore)).

## Secrets

`FF_SECRET` signs sessions, makes the setup link, and seals or encrypts what the database keeps for other systems:
sign-in providers' tokens, two-factor secrets, webhooks' secrets and the CDN files' cache tags. Make it once with
`openssl rand -base64 32`, never rotate it, and keep it with your backups: a backup restored with another secret
loses those values, and a new secret signs everyone out
([Configuration → FF_SECRET](/reference/configuration#ff_secret)).

- One Secrets Manager secret, `companyflags/prod`, holds a JSON object: `FF_SECRET`, `DATABASE_URL` (the
  `flags_app` address), `FF_METRICS_TOKEN`, and single sign-on client secrets. The migrate task's own secret,
  `companyflags/migrate`, holds the `flags_owner` address.
- The execution role needs `secretsmanager:GetSecretValue` (and `kms:Decrypt` with your own key).
- ECS reads secrets when a task starts. A changed secret needs a new deployment, and every task must have the same
  `FF_SECRET`: tasks with two secrets sign and seal differently.
- Never turn on automatic rotation for `FF_SECRET`: see [Configuration → Changing a secret](/reference/configuration#changing-a-secret).
- Don't build `DATABASE_URL` from the RDS-managed master secret: RDS rotates it every 7 days, and running tasks don't
  notice. To change the database password with no downtime: make a second user, put its address in a new version of
  the secret, deploy, then drop the old user.
- **Limit who may run the migrate task.** Running it grants the use of its secret, the owner's address included.

The database also holds secrets of its own, such as each environment's link secret: protect snapshots like
production credentials ([Configuration → What the database holds](/reference/configuration#what-the-database-holds)).

## Load balancer and client addresses

- **Listener:** 443 with an ACM certificate for `flags.example.com` and a TLS 1.3 policy; 80 redirects to 443. Keep
  HTTP/2 to clients on. The server speaks plain HTTP and sends no HSTS header: add
  `max-age=31536000; includeSubDomains` at the ALB, in the listener's
  `routing.http.response.strict_transport_security.header_value` attribute.
- **`FF_PUBLIC_URL`** is the `https` address people type, `https://flags.example.com`. Sign-in from any other
  address is refused, and the setup link and single sign-on addresses are built on it.
- **Target group:** `target_type=ip`, port 8787, HTTP/1.1, health check `/healthz`, `deregistration_delay=30`. The
  default 300 seconds would hold every deploy for 5 minutes per batch, because open streams keep a draining task busy.
- **Idle timeout:** keep the default 60 seconds. The server keeps an idle connection open 65 seconds
  (`FF_KEEPALIVE_SECONDS`), longer than the ALB, so it never closes a connection the ALB is about to use (a `502`).
  If you raise the ALB's idle timeout, raise `FF_KEEPALIVE_SECONDS` above it too
  ([Configuration → Timeouts](/reference/configuration#timeouts-and-body-sizes)).
- **Bodies and streams.** The server takes bodies up to 4 MB (imports), and OFREP's change-event streams stay open
  with a heartbeat every 25 seconds, so the 60-second idle timeout keeps them open. Anything you add in front (a WAF)
  must let 4 MB bodies through and must not buffer the streams.
- **No sticky sessions:** everything is in Postgres.

**The client's address.** Sign-in rate limits and the change-event streams count each client's address. Behind the
ALB every client would look like the ALB: one shared sign-in limit, and only 100 devices per task with live updates
(`FF_EVENT_STREAMS_PER_CLIENT`). So tell the server which connections are the ALB:

- **`FF_TRUSTED_PROXIES`:** the CIDRs of the subnets the ALB is attached to, e.g.
  `10.0.0.0/24,10.0.1.0/24,10.0.2.0/24`. The ALB connects to tasks from addresses in those subnets. The VPC's CIDR
  works too if security groups let only the ALB reach the tasks. From those addresses only, the server reads
  `X-Forwarded-For`, from the right ([Configuration → Client addresses](/reference/configuration#client-addresses)).
- Leave the ALB's `X-Forwarded-For` mode at `append`, and `routing.http.xff_client_port.enabled` off. With the port
  on, each entry is an address and a port, which the server doesn't read. Don't set `FF_CLIENT_IP_HEADER`.

**What to expose.** Everyone reaches `/ofrep/…`, and the CDN files through CloudFront. Keep `/metrics` and `/readyz`
on your network: a listener rule that answers `403` for them from the internet, or `FF_METRICS_TOKEN` for
`/metrics`. `/sdk/…` is for your backends; `/hooks/…` only if you use webhooks in. The console, `/api`, `/oauth`,
`/.well-known` and `/mcp` are your choice: everyone, or your network or VPN only
([Configuration → What to expose](/reference/configuration#what-to-expose)).

## Health checks

The rule: `/healthz` for liveness, readiness and the load balancer; `/readyz` only for startup and alerts.
`/healthz` answers `200` once the server listens, and it listens only after it has checked the migrations and loaded
every environment. `/readyz` fails on every task at once during a database outage, while they could still serve what
they have in memory ([Monitoring → Health checks](/operate/monitoring#health-checks)).

ECS replaces a task that fails its container check **or** the ALB's check, and has no separate readiness check.
Point both at `/healthz`:

- the container check is in the task definition above, since ECS ignores the image's `HEALTHCHECK`;
- the target group's check is `/healthz`;
- `startPeriod` and the service's grace period cover the start;
- watch `/readyz` with a CloudWatch Synthetics canary, or scrape `/metrics` (`FF_METRICS=on`).

Alarms worth having ([Monitoring → Alerts](/operate/monitoring#alerts)):

- `/readyz` lists an environment in `failing` (`companyflags_publish_failing`): a publish can't be built. Read the
  log line `publishing … failed`, fix what it names, publish again. A log filter on it works too;
- `/readyz` lists `warnings` (`companyflags_purge_failing`): a CloudFront purge didn't go through;
- `lagSeconds` keeps growing (`companyflags_publish_lag_seconds`): check the task's CPU and the log;
- `companyflags_database_up` is `0`: fix the database, and don't restart the tasks, which can't load without it;
- the ALB's `HTTPCode_Target_5XX_Count` and `UnHealthyHostCount`; RDS's `DatabaseConnections` and
  `FreeStorageSpace`.

## CDN

You need the CDN only if apps read [CDN files](/integrations/cdn-files). Apps that read flags with OFREP need none.

**Distribution** for `cdn.flags.example.com`:

- **Certificate:** in ACM in `us-east-1`.
- **Origin:** `flags.example.com` (the ALB's certificate covers it; the ALB's own DNS name gives `502`s), HTTPS only,
  TLS 1.2 or later.
- **Cache tags:** a `CacheTagConfig` with header name `Cache-Tag`. Set it when you create the distribution: files
  cached before it carry no tags.
- **Behavior `/cdn/v1/flags/*`:**
  - redirect to HTTPS; allow `GET`, `HEAD`, `OPTIONS`; cache `GET` and `HEAD`;
  - a **custom cache policy**: Min TTL 0, Default TTL 0, Max TTL 86400; no headers, cookies or query strings in the
    key; gzip and Brotli on. Min TTL above 0 would cache `no-store` answers (a wrong link's `404`), so not the managed
    `CachingOptimized`. Max TTL below 86400 would cut `stale-if-error`;
  - origin request policy: the managed `CORS-S3Origin`, which forwards `Origin` and the preflight headers. Nothing
    else: no cookies, no query strings, never `Authorization`.
- **Default behavior `*`:** a CloudFront Function on viewer request that answers `404`, so `/api`, `/ofrep` and
  `/sdk` are never reachable through the CDN host. OFREP and its streams go to `flags.example.com`, straight to the
  ALB: a stream held back or cached leaves providers on old values, and CloudFront's origin response timeout (30
  seconds) leaves only 5 seconds over the heartbeat
  ([Configuration → Keep OFREP and streams off the CDN](/reference/configuration#keep-ofrep-and-streams-off-the-cdn)).
  `CloudFront-Viewer-Address` also carries a port, which `FF_CLIENT_IP_HEADER` can't read.
- **Custom error response** for `404`: error caching minimum TTL 0. CloudFront keeps a `404` for 10 seconds by
  default, and a new entity's file would look missing for that long.

CloudFront caches for `s-maxage` (60 seconds), honours `stale-if-error` (it may serve the last file for a day while
the server is down), and revalidates with `If-None-Match`
([CDN Files → What each CDN honours](/integrations/cdn-files#what-each-cdn-honours)). Apps read CDN files from
`https://cdn.flags.example.com`, at the same path the app link gives.

**Purge on publish.** `FF_CLOUDFRONT_DISTRIBUTION_ID` in the task definition turns on the CloudFront purge
integration ([CDN Purge → CloudFront](/integrations/cdn-purge#cloudfront)). Give the **task role**
`cloudfront:CreateInvalidation` on the distribution's ARN, and nothing else:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "cloudfront:CreateInvalidation",
    "Resource": "arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE123"
  }]
}
```

- No key is stored: the task role's credentials sign the calls, and `FF_SECRET` plays no part.
- It invalidates by tag, so a publish drops only the files it changed. More than 100 tags invalidate the
  environment's tag instead.
- Each publish purges twice: at once, and again about 11 seconds later, in case a task a round behind refilled the
  CDN with the old file. Tag invalidations count against the same monthly free paths as path ones.
- A purge that fails (`TooManyInvalidationsInProgress`, a missing permission) is kept on the publish and listed in
  `/readyz` under `warnings`. The change still reaches apps within the cache's minute.

> **Check this on your setup:** publish a change, then check that the next request is a miss
> (`x-cache: Miss from cloudfront` or `RefreshHit`). Invalidations usually take effect in seconds, but AWS promises
> "under two minutes".

A manual purge of one environment, by path:

```bash
aws cloudfront create-invalidation --distribution-id E2EXAMPLE123 --paths '/cdn/v1/flags/prod/*'
```

**Checking it.** Run this twice; the second answer should say `x-cache: Hit from cloudfront`:

```bash
curl -sI https://cdn.flags.example.com/cdn/v1/flags/prod/web | grep -iE 'cache-control|etag|age|x-cache|cf-ipcountry'
```

**The country.** Rules can check `geo.country`, and the app reads it from a `CF-IPCountry` header next to the file
([CDN Files → The country header](/integrations/cdn-files#the-country-header)). CloudFront doesn't send it. A
viewer-response CloudFront Function can copy `CloudFront-Viewer-Country` into a `CF-IPCountry` header. Without it,
`geo.country` is unknown and locked rules apply.

> **Check this on your setup:** whether `CloudFront-Viewer-Country` is visible to a viewer-response function, and
> whether CloudFront reads `CDN-Cache-Control` (assume it doesn't).

## Upgrades

Every service task runs with `FF_MIGRATE=off`: it doesn't migrate, it checks that the schema has every migration it
needs, and stops if it doesn't. Each upgrade runs the new image's `companyflags migrate` once, as a one-off task, with
its own task definition (`companyflags-migrate`) whose `DATABASE_URL` is the `flags_owner` address and whose
`FF_DB_POOL` is 2 ([Upgrading](/operate/upgrading#several-servers-or-a-rolling-upgrade)). Read the
[changelog](https://github.com/dvir-daniel/companyflags/blob/main/CHANGELOG.md) first, then build and push the new
thin image:

```bash
aws rds create-db-snapshot --db-instance-identifier companyflags --db-snapshot-identifier before-0-9-1
aws rds wait db-snapshot-available --db-snapshot-identifier before-0-9-1

TASK=$(aws ecs run-task --cluster companyflags --launch-type FARGATE \
  --task-definition companyflags-migrate:42 \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-a,subnet-b],securityGroups=[sg-tasks],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"companyflags","command":["companyflags","migrate"]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster companyflags --tasks "$TASK"
aws ecs describe-tasks --cluster companyflags --tasks "$TASK" --query 'tasks[0].containers[0].exitCode'   # 0

aws ecs update-service --cluster companyflags --service companyflags --task-definition companyflags:42
aws ecs wait services-stable --cluster companyflags --services companyflags
```

The first deploy runs the same migrate task, before the service exists. `companyflags migrate --check` lists what an
upgrade would apply.

- Old and new tasks serve side by side during the deploy: each release's migrations work with the version before
  it. A rolling upgrade goes one release line at a time (0.9 to 0.10, then 0.10 to 0.11).
- The circuit breaker's rollback works only if the task definition it rolls back to also has `FF_MIGRATE=off`: an
  older version that migrates at start refuses a newer schema.

**Rolling back.** The schema doesn't go back. Stop the service (desired count 0), restore the snapshot you took into
a new instance, point `DATABASE_URL` at it, keep the same `FF_SECRET`, and start the version you had before. Check
that `/readyz` answers `200`. Everything changed since the snapshot is lost: look at History first
([Upgrading → Rolling back](/operate/upgrading#rolling-back)).

## Pitfalls

- **No embedded database on Fargate.** Its disk is gone when a task stops, and a rolling deploy can't start.
- **The ALB on `/readyz`** can make ECS replace every task during a database outage.
- **Every stream reconnects** on each deploy and scale-in. That is expected: providers reconnect or poll.
- **Access logs hold secrets.** ALB and CloudFront logs record CDN file paths, which carry each entity's link secret.
  Treat those buckets as secret.
- **Cost:** NAT hours and data, log groups that never expire, Multi-AZ (twice the RDS cost), invalidations doubled by
  the second purge, Aurora that never pauses.

## Checklist

- [ ] RDS for PostgreSQL 15 or later, Multi-AZ, with `btree_gist`, the two roles and `sslmode=verify-full` with the
  RDS bundle.
- [ ] `FF_SECRET` in Secrets Manager, made once, no automatic rotation, stored with your backups.
- [ ] `FF_PUBLIC_URL` is the `https` address; HSTS added at the ALB.
- [ ] The image pinned to `0.9`, in your ECR.
- [ ] The admin account made; few people can read the log group.
- [ ] `FF_TRUSTED_PROXIES` set to the ALB's subnets.
- [ ] Container and target group checks on `/healthz`; a canary or alarm on `/readyz`.
- [ ] At most 4 tasks inside the connection budget; `stopTimeout` above 5 seconds.
- [ ] `/metrics` and `/readyz` not open to the internet, or `FF_METRICS_TOKEN` set.
- [ ] *Only with CDN files:* CloudFront serves only `/cdn/v1/flags/*`, `FF_CLOUDFRONT_DISTRIBUTION_ID` set, and the
  task role may invalidate.
- [ ] RDS backups on, and a restore tested.
- [ ] The migrate task runs before each deploy.

Then go through the full [Production Checklist](/operate/production).
