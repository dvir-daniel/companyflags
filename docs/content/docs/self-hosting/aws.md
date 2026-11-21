---
title: "AWS"
description: "Run CompanyFlags on AWS: ECS on Fargate behind an ALB, RDS for PostgreSQL, Secrets Manager, and CloudFront for the CDN files only."
---

This page sets up CompanyFlags on AWS for production: two or more tasks, a managed Postgres, and a CDN that
answers apps' CDN files. It assumes you know the [production checklist](/self-hosting/production); it says only
what is different on AWS.

## What you build

```text
console, API, OFREP, streams ─► flags.example.com ─► ALB (HTTPS) ─► ECS service on Fargate, 2+ tasks, :8787
apps' CDN files ──────────────► cdn.flags.example.com ─► CloudFront (/cdn/v1/flags/* only) ─► the same ALB
every task, the migrate task ─► RDS for PostgreSQL (Multi-AZ, TLS with the RDS CA bundle)
secrets: Secrets Manager → ECS secrets          logs: CloudWatch Logs
```

- **Compute: a standard ECS service on Fargate.** App Runner takes no new accounts since April 30, 2026. Use EKS
  only if you already run it: then the Kubernetes Job in [Upgrading](/self-hosting/upgrading) works as written.
- **Database: RDS for PostgreSQL 18.** Aurora Serverless v2 never pauses for this app: every task keeps a pool open
  and asks the database once a second.
- **CloudFront has its own hostname** and caches the CDN files only. Everything else goes to the ALB.

## Compute: ECS on Fargate

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
      { "name": "BETTER_AUTH_URL", "value": "https://flags.example.com" },
      { "name": "FF_MIGRATE", "value": "off" },
      { "name": "FF_DB_POOL", "value": "10" },
      { "name": "FF_TRUSTED_PROXIES", "value": "10.0.0.0/24,10.0.1.0/24,10.0.2.0/24" },
      { "name": "FF_DATABASE_CA_FILE", "value": "/etc/ssl/rds-global-bundle.pem" },
      { "name": "FF_CLOUDFRONT_DISTRIBUTION_ID", "value": "E2EXAMPLE123" }
    ],
    "secrets": [
      { "name": "BETTER_AUTH_SECRET", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:companyflags/prod:BETTER_AUTH_SECRET::" },
      { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:companyflags/prod:DATABASE_URL::" }
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

- **The image is your own thin one** (below), with the RDS CA bundle in it. Images are built for amd64 and arm64.
- **ECS ignores the image's `HEALTHCHECK`**, so the task definition has its own. The image includes `wget`.
- **Scale out, not up.** Node mostly uses one core: give each task 0.5 to 1 vCPU and run more tasks.
- **Service:** `desiredCount` 2 or more, in private subnets in at least 2 zones; `minimumHealthyPercent=100`,
  `maximumPercent=200`; the deployment circuit breaker with rollback; `healthCheckGracePeriodSeconds=60`.
- **Logs:** set a retention on the log group (the default keeps them forever). The setup link is printed there until
  the admin account exists: make it right after the first deploy, and limit who can read the logs.

## Database: RDS for PostgreSQL

Use Multi-AZ, gp3 storage and automated backups. `db.t4g.small` or `db.t4g.medium` is plenty to start.

**TLS.** RDS certificates are signed by RDS's own CAs, which Node doesn't trust, and `pg` treats `sslmode=require`
as `verify-full`: without the bundle, the connection fails. Add the bundle to a thin image of your own:

```dockerfile
FROM ghcr.io/dvir-daniel/companyflags:0.9
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
```

Then `FF_DATABASE_CA_FILE=/etc/ssl/rds-global-bundle.pem`, and:

```text
DATABASE_URL=postgres://flags_app:<password>@companyflags.abc123.<region>.rds.amazonaws.com:5432/flags?sslmode=verify-full
```

Push the image to ECR. A config file (for the [`metrics()` plugin](/self-hosting/production#metrics), say) goes in
the same image, in `/app`: Fargate can't mount one.

**Roles and `btree_gist`.** Once, as the master user, before the first migration:

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

> **Check this on your setup:** these grants weren't tested end to end. Try them on a copy first, or start with one
> role for both.

**Connection budget.** A deploy runs old and new tasks side by side, so count both:

```text
2 × most tasks × FF_DB_POOL + the migrate task's pool + room for you  ≤  max_connections
2 × 4 × 10                  + 2                       + 10            =  92
```

`max_connections` follows the instance's memory: run `SHOW max_connections;` rather than guess. Give the migrate
task `FF_DB_POOL=2`.

**Backups.** Use RDS's own: point-in-time recovery, and a snapshot before each upgrade. The image has no `pg_dump`,
so `companyflags backup` doesn't run in it ([Backups](/self-hosting/backups)).

## Secrets

- One Secrets Manager secret, `companyflags/prod`, holds a JSON object: `BETTER_AUTH_SECRET`, `DATABASE_URL` (the
  `flags_app` address), and single sign-on client secrets. The migrate task's own secret holds the `flags_owner`
  address.
- The execution role needs `secretsmanager:GetSecretValue` (and `kms:Decrypt` with your own key).
- ECS reads secrets when a task starts. A changed secret needs a new deployment.
- **Never turn on automatic rotation for `BETTER_AUTH_SECRET`.** A new one signs everyone out, changes the setup
  link, and makes sealed values unreadable (webhooks' headers and signing secrets). Keep it with your backups.
- Don't build `DATABASE_URL` from the RDS-managed master secret: RDS rotates it every 7 days, and running tasks don't
  notice.

## Load balancer: ALB

- **Listener:** 443 with an ACM certificate for `flags.example.com` and a TLS 1.3 policy; 80 redirects to 443. Keep
  HTTP/2 to clients on. The server sends no HSTS header: add it at the ALB.
- **Target group:** `target_type=ip`, port 8787, HTTP/1.1, health check `/healthz`, `deregistration_delay=30`. The
  default 300 seconds would hold every deploy for 5 minutes, because open streams keep a draining task busy.
- **Idle timeout:** keep the default 60 seconds. Streams send a heartbeat every 25 seconds. The server keeps an idle
  connection open for 65 seconds (`FF_KEEPALIVE_SECONDS`), longer than the ALB, so the ALB never reuses a connection
  the server just closed. If you raise the ALB's idle timeout, raise `FF_KEEPALIVE_SECONDS` above it.
- **`FF_TRUSTED_PROXIES`:** the CIDRs of the subnets the ALB is attached to, e.g.
  `10.0.0.0/24,10.0.1.0/24,10.0.2.0/24`. The ALB connects to tasks from addresses in those subnets. The VPC's CIDR
  works too if security groups let only the ALB reach the tasks.
- Leave the ALB's `X-Forwarded-For` mode at `append`, and `routing.http.xff_client_port.enabled` off. With the port
  on, each entry is an address and a port, which the server doesn't read. Don't set `FF_CLIENT_IP_HEADER`.
- No sticky sessions: everything is in Postgres.

## Health checks

ECS replaces a task that fails its container check **or** the ALB's check. It has no separate readiness check.

- Point both at **`/healthz`**. The server listens only once it has checked the migrations and loaded every
  environment's snapshot, so a `200` already means the task can serve.
- Don't point the ALB at `/readyz`. During a database outage every task fails it at once; ECS then replaces tasks
  that were still serving from memory with ones that can't start.
- Watch `/readyz` apart from the ALB, for `failing` and `warnings`: a CloudWatch Synthetics canary, or the
  `metrics()` plugin ([Production](/self-hosting/production#5-health-checks)).

## Migrations

Every service task runs with `FF_MIGRATE=off`. Each upgrade runs the new image's `companyflags migrate` once, as a
one-off task, with its own task definition (`companyflags-migrate`) whose `DATABASE_URL` is the `flags_owner`
address. See [Upgrading](/self-hosting/upgrading).

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

The circuit breaker's rollback works only if the task definition it rolls back to also has `FF_MIGRATE=off`: an older
version that migrates at start refuses a newer schema.

## CDN: CloudFront for the CDN files

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
  `/sdk` are never reachable through the CDN host.
- **Custom error response** for `404`: error caching minimum TTL 0. CloudFront keeps a `404` for 10 seconds by
  default, and a new entity's file would look missing for that long.

CloudFront caches for `s-maxage` (60 seconds), honours `stale-if-error`, and revalidates with `If-None-Match`
([CDN](/self-hosting/cdn#what-each-cdn-honours)).

**Purge on publish** with the [`cloudfront()` plugin](/reference/plugins#cloudfrontoptions). Set
`FF_CLOUDFRONT_DISTRIBUTION_ID`, or in the config file:

```ts
import { defaultPlugins, cloudfront } from 'companyflags/plugins';

export default defineConfig({ plugins: [...defaultPlugins(), cloudfront({ distributionId: 'E2EXAMPLE123' })] });
```

Give the **task role** `cloudfront:CreateInvalidation` on the distribution's ARN. No token is stored. The plugin
invalidates by tag, so a publish drops only the files it changed. Tag invalidations count against the same monthly
free paths as path ones, and each publish purges twice.

> **Check this on your setup:** publish a change, then check that the next request is a miss
> (`x-cache: Miss from cloudfront` or `RefreshHit`). Invalidations usually take effect in seconds, but AWS promises
> "under two minutes".

A manual purge of one environment, by path:

```bash
aws cloudfront create-invalidation --distribution-id E2EXAMPLE123 --paths '/cdn/v1/flags/prod/*'
```

Apps read CDN files from `https://cdn.flags.example.com`, at the same path the app link gives.

**The country.** CloudFront doesn't send `CF-IPCountry`. A viewer-response CloudFront Function can copy
`CloudFront-Viewer-Country` into a `CF-IPCountry` header. Without it, `geo.country` is unknown and locked rules apply.

> **Check this on your setup:** whether `CloudFront-Viewer-Country` is visible to a viewer-response function, and
> whether CloudFront reads `CDN-Cache-Control` (assume it doesn't).

## Keep OFREP and streams off CloudFront

Apps and backends use `https://flags.example.com` for OFREP and its change-event streams, straight to the ALB:

- through CloudFront, the server would have to trust every CloudFront range to find a device's address, and that list
  changes; `CloudFront-Viewer-Address` carries a port, which `FF_CLIENT_IP_HEADER` can't read;
- CloudFront's origin response timeout (30 seconds) leaves 5 seconds over the 25-second heartbeat.

## Setup sketch

In Terraform, CDK or CloudFormation, the resources are:

- **Network:** a VPC in 3 zones; public subnets for the ALB, private ones for tasks and RDS; NAT, or VPC endpoints
  for `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager` and S3. Tasks need the internet for single sign-on, webhooks and
  the CloudFront API.
- **Image:** an ECR repository for the thin image.
- **Database:** a subnet group, a `postgres18` parameter group, the instance (Multi-AZ, gp3,
  `backup_retention_period=14`, deletion protection).
- **Secrets:** `companyflags/prod` and `companyflags/migrate`.
- **IAM:** the execution role (`AmazonECSTaskExecutionRolePolicy` and `GetSecretValue`); the task role
  (`cloudfront:CreateInvalidation`).
- **ECS:** the cluster, the `companyflags` and `companyflags-migrate` task definitions, the service.
- **ALB:** idle timeout 60, the target group above, listeners on 443 and 80.
- **Certificates and DNS:** ACM in your region and in `us-east-1`; `flags` to the ALB, `cdn` to CloudFront.
- **Security groups:** the ALB takes 443 and 80; tasks take 8787 from the ALB only; RDS takes 5432 from tasks only.
- **CloudFront:** the cache policy, the 404 function, the distribution with its `CacheTagConfig`.
- **Alarms:** the ALB's `HTTPCode_Target_5XX_Count` and `UnHealthyHostCount`; RDS's `DatabaseConnections` and
  `FreeStorageSpace`; a log filter on `publishing … failed`; the `/readyz` canary.

> **Check this on your setup:** `CacheTagConfig` is in CloudFormation and CDK (`CfnDistribution.cacheTagConfig`).
> If your Terraform provider doesn't have it yet, set it with `aws cloudfront update-distribution`.

## Pitfalls

- **No embedded database on Fargate.** Its disk is gone when a task stops, and the server refuses a second container
  on the same folder, so a rolling deploy can't start. Use RDS; `companyflags copy-to-postgres` moves an existing one
  ([Backups](/self-hosting/backups#moving-to-postgres)).
- **The ALB on `/readyz`** can make ECS replace every task during a database outage.
- **`sslmode=require` still verifies** the certificate with `pg`. Without the bundle in `FF_DATABASE_CA_FILE`, the
  server can't connect to RDS.
- **A deregistration delay of 300 seconds** makes every deploy wait 5 minutes per batch.
- **Every stream reconnects** on each deploy and scale-in. That is expected: providers reconnect or poll.
- **CloudFront Min TTL above 0** caches `no-store` answers, and its default 10-second `404` caching hides new files.
- **Access logs hold secrets.** ALB and CloudFront logs record CDN file paths, which carry each entity's link secret.
  Treat those buckets as secret.
- **Cost:** NAT hours and data, log groups that never expire, Multi-AZ (twice the RDS cost), invalidations doubled by
  the second purge, Aurora that never pauses.
