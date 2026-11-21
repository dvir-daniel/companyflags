---
title: "AWS"
description: "Run CompanyFlags on AWS: ECS on Fargate behind an ALB, RDS for PostgreSQL, Secrets Manager, and CloudFront for the CDN files only."
---

One VM? Use [Docker](/self-hosting/docker) with [Proxies and HTTPS](/self-hosting/proxies). This page is for managed
containers with two or more instances: ECS tasks on Fargate, RDS for PostgreSQL, and CloudFront for the CDN files.

## What you build

```text
console, API, OFREP, streams ─► flags.example.com ─► ALB (HTTPS) ─► ECS service on Fargate, 2+ tasks, :8787
apps' CDN files ──────────────► cdn.flags.example.com ─► CloudFront (/cdn/v1/flags/* only) ─► the same ALB
every task, the migrate task ─► RDS for PostgreSQL (Multi-AZ, TLS with the RDS CA bundle)
secrets: Secrets Manager → ECS secrets          logs: CloudWatch Logs
```

- **Compute: a standard ECS service on Fargate.** App Runner takes no new accounts since April 30, 2026. Use EKS
  only if you already run it: then the Kubernetes Job in [Upgrading](/self-hosting/upgrading#several-servers-or-a-rolling-upgrade)
  works as written.
- **Database: RDS for PostgreSQL 18.** Aurora Serverless v2 never pauses for this app: every task keeps a pool open
  and asks the database once a second.
- **CloudFront has its own hostname** and caches the CDN files only. Everything else goes to the ALB.

## Read first

- [Database](/self-hosting/database): `btree_gist`, the two roles, TLS and the connection budget.
- [Proxies and HTTPS](/self-hosting/proxies): client addresses, keep-alive and what to expose.
- [Secrets](/self-hosting/secrets): what `BETTER_AUTH_SECRET` protects.
- [Monitoring](/self-hosting/monitoring): the health-check rule and the alerts.

## First deploy

This is a list of resources for Terraform, CDK or CloudFormation, in the order you need them, not a script. The
commands for the migrate task are under [Upgrades](#upgrades).

1. **Network.** A VPC in 3 zones; public subnets for the ALB, private ones for tasks and RDS; NAT, or VPC endpoints for
   `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager` and S3. Tasks need the internet for single sign-on, webhooks and the
   CloudFront API. Security groups: the ALB takes 443 and 80; tasks take 8787 from the ALB only; RDS takes 5432 from
   tasks only.
2. **Database and roles.** A subnet group, a `postgres18` parameter group, and the instance (Multi-AZ, gp3,
   `backup_retention_period=14`, deletion protection). Then, as the master user, `btree_gist` and the roles
   `flags_owner` and `flags_app` ([Database → Two roles](/self-hosting/database#two-roles-one-that-migrates-one-that-serves)).
3. **Image.** An ECR repository, and the thin image below pushed to it.
4. **Secrets.** `companyflags/prod` and `companyflags/migrate` in Secrets Manager ([below](#secrets)).
5. **IAM.** The execution role (`AmazonECSTaskExecutionRolePolicy` and `secretsmanager:GetSecretValue`); the task role
   (`cloudfront:CreateInvalidation`).
6. **Migrate task.** The `companyflags-migrate` task definition, run once before the service starts
   ([Upgrades](#upgrades)).
7. **Service.** The cluster, the `companyflags` task definition and the service ([Compute](#compute)).
8. **Load balancer and CDN.** The ALB with idle timeout 60, its target group and listeners on 443 and 80
   ([below](#load-balancer-and-client-addresses)); CloudFront with its cache policy, its 404 function and its
   `CacheTagConfig` ([CDN](#cdn)).
9. **Certificates and DNS.** ACM in your region and in `us-east-1`; `flags` to the ALB, `cdn` to CloudFront.
10. **Setup link.** Make the admin account at once ([Sign-In → The first account](/self-hosting/sign-in#the-first-account)).
    The link is in CloudWatch Logs.

> **Check this on your setup:** `CacheTagConfig` is in CloudFormation and CDK (`CfnDistribution.cacheTagConfig`).
> If your Terraform provider doesn't have it yet, set it with `aws cloudfront update-distribution`.

## Compute

**The image is a thin one of your own**, with the RDS CA bundle and a config file that turns on the CloudFront purge.
Fargate can't mount a file, so both go in the image:

```dockerfile
FROM ghcr.io/dvir-daniel/companyflags:0.9
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
COPY companyflags.config.ts /app/companyflags.config.ts
```

```ts
// companyflags.config.ts: without it, the purge never runs
import { defineConfig } from 'companyflags/config';
import { cloudfront, defaultPlugins } from 'companyflags/plugins';

export default defineConfig({ plugins: [...defaultPlugins(), cloudfront()] });
```

`cloudfront()` reads `FF_CLOUDFRONT_DISTRIBUTION_ID`. Add `metrics()` to the list for
[Monitoring → Metrics](/self-hosting/monitoring#metrics).

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

- **Images are built for amd64 and arm64.** The image includes `wget`, for the health check.
- **Scale out, not up.** Node mostly uses one core: give each task 0.5 to 1 vCPU and run more tasks.
- **Service:** `desiredCount` 2 or more, in private subnets in at least 2 zones; `minimumHealthyPercent=100`,
  `maximumPercent=200`; the deployment circuit breaker with rollback; `healthCheckGracePeriodSeconds=60`.
- **Logs:** set a retention on the log group (the default keeps them forever).

## Database

Use Multi-AZ, gp3 storage and automated backups. `db.t4g.small` or `db.t4g.medium` is plenty to start.

- **TLS:** RDS certificates are signed by RDS's own authorities, so the thin image above carries the global bundle,
  and `FF_DATABASE_CA_FILE` names it ([Database → TLS](/self-hosting/database#tls-and-certificate-authorities)):

  ```text
  DATABASE_URL=postgres://flags_app:<password>@companyflags.abc123.<region>.rds.amazonaws.com:5432/flags?sslmode=verify-full
  ```

- **Roles:** the master user makes `flags_owner` and `flags_app`
  ([Database → Two roles](/self-hosting/database#two-roles-one-that-migrates-one-that-serves)). The service connects
  as `flags_app`, the migrate task as `flags_owner`.
- **Connection budget:** with at most 4 tasks, `2 × 4 × 10 + 2 + 10 = 92` connections. `max_connections` follows the
  instance's memory: run `SHOW max_connections;` ([Database → Connection pool and budget](/self-hosting/database#connection-pool-and-budget)).
- **Backups:** RDS's own, with point-in-time recovery, and a snapshot before each upgrade
  ([Backups](/self-hosting/backups#a-managed-database)).

## Secrets

- One Secrets Manager secret, `companyflags/prod`, holds a JSON object: `BETTER_AUTH_SECRET`, `DATABASE_URL` (the
  `flags_app` address), and single sign-on client secrets. The migrate task's own secret, `companyflags/migrate`,
  holds the `flags_owner` address.
- The execution role needs `secretsmanager:GetSecretValue` (and `kms:Decrypt` with your own key).
- ECS reads secrets when a task starts. A changed secret needs a new deployment.
- Never turn on automatic rotation for `BETTER_AUTH_SECRET`: see [Secrets](/self-hosting/secrets#changing-a-secret).
- Don't build `DATABASE_URL` from the RDS-managed master secret: RDS rotates it every 7 days, and running tasks don't
  notice.

## Load balancer and client addresses

- **Listener:** 443 with an ACM certificate for `flags.example.com` and a TLS 1.3 policy; 80 redirects to 443. Keep
  HTTP/2 to clients on. The server sends no HSTS header: add it at the ALB.
- **Target group:** `target_type=ip`, port 8787, HTTP/1.1, health check `/healthz`, `deregistration_delay=30`. The
  default 300 seconds would hold every deploy for 5 minutes per batch, because open streams keep a draining task busy.
- **Idle timeout:** keep the default 60 seconds, below the server's 65
  ([Proxies and HTTPS → Timeouts](/self-hosting/proxies#timeouts-and-body-sizes)).
- **`FF_TRUSTED_PROXIES`:** the CIDRs of the subnets the ALB is attached to, e.g.
  `10.0.0.0/24,10.0.1.0/24,10.0.2.0/24`. The ALB connects to tasks from addresses in those subnets. The VPC's CIDR
  works too if security groups let only the ALB reach the tasks.
- Leave the ALB's `X-Forwarded-For` mode at `append`, and `routing.http.xff_client_port.enabled` off. With the port
  on, each entry is an address and a port, which the server doesn't read. Don't set `FF_CLIENT_IP_HEADER`.
- No sticky sessions: everything is in Postgres.

## Health checks

ECS replaces a task that fails its container check **or** the ALB's check, and has no separate readiness check.
Point both at `/healthz` ([Monitoring → Health checks](/self-hosting/monitoring#health-checks)):

- the container check is in the task definition above, since ECS ignores the image's `HEALTHCHECK`;
- the target group's check is `/healthz`;
- watch `/readyz` with a CloudWatch Synthetics canary, or the `metrics()` plugin.

Alarms worth having: the ALB's `HTTPCode_Target_5XX_Count` and `UnHealthyHostCount`; RDS's `DatabaseConnections` and
`FreeStorageSpace`; a log filter on `publishing … failed`; the `/readyz` canary
([Monitoring → Alerts](/self-hosting/monitoring#alerts)).

## CDN

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
  ALB ([Proxies and HTTPS](/self-hosting/proxies#keep-ofrep-and-streams-off-the-cdn)). `CloudFront-Viewer-Address`
  also carries a port, which `FF_CLIENT_IP_HEADER` can't read.
- **Custom error response** for `404`: error caching minimum TTL 0. CloudFront keeps a `404` for 10 seconds by
  default, and a new entity's file would look missing for that long.

CloudFront caches for `s-maxage` (60 seconds), honours `stale-if-error`, and revalidates with `If-None-Match`
([CDN → What each CDN honours](/self-hosting/cdn#what-each-cdn-honours)). Apps read CDN files from
`https://cdn.flags.example.com`, at the same path the app link gives.

**Purge on publish** with the [`cloudfront()` plugin](/reference/plugins#cloudfrontoptions), listed in the thin
image's config file ([Compute](#compute)). Give the **task role** `cloudfront:CreateInvalidation` on the
distribution's ARN. No token is stored. The plugin invalidates by tag, so a publish drops only the files it changed.
Tag invalidations count against the same monthly free paths as path ones, and each publish purges twice.

> **Check this on your setup:** publish a change, then check that the next request is a miss
> (`x-cache: Miss from cloudfront` or `RefreshHit`). Invalidations usually take effect in seconds, but AWS promises
> "under two minutes".

A manual purge of one environment, by path:

```bash
aws cloudfront create-invalidation --distribution-id E2EXAMPLE123 --paths '/cdn/v1/flags/prod/*'
```

**The country.** CloudFront doesn't send `CF-IPCountry`. A viewer-response CloudFront Function can copy
`CloudFront-Viewer-Country` into a `CF-IPCountry` header. Without it, `geo.country` is unknown and locked rules apply.

> **Check this on your setup:** whether `CloudFront-Viewer-Country` is visible to a viewer-response function, and
> whether CloudFront reads `CDN-Cache-Control` (assume it doesn't).

## Upgrades

Every service task runs with `FF_MIGRATE=off`. Each upgrade runs the new image's `companyflags migrate` once, as a
one-off task, with its own task definition (`companyflags-migrate`) whose `DATABASE_URL` is the `flags_owner`
address and whose `FF_DB_POOL` is 2 ([Upgrading](/self-hosting/upgrading#several-servers-or-a-rolling-upgrade)):

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

## Pitfalls

- **No embedded database on Fargate.** Its disk is gone when a task stops, and a rolling deploy can't start
  ([Database → The embedded database](/self-hosting/database#the-embedded-database)).
- **The ALB on `/readyz`** can make ECS replace every task during a database outage.
- **Every stream reconnects** on each deploy and scale-in. That is expected: providers reconnect or poll.
- **Access logs hold secrets.** ALB and CloudFront logs record CDN file paths, which carry each entity's link secret.
  Treat those buckets as secret.
- **Cost:** NAT hours and data, log groups that never expire, Multi-AZ (twice the RDS cost), invalidations doubled by
  the second purge, Aurora that never pauses.

## Go live

Go through the [Production Checklist](/self-hosting/production).
