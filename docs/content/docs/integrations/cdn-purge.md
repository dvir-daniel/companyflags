---
title: "CDN Purge"
description: "Drop the CDN files a publish changed, so apps get it in seconds: Cloudflare, CloudFront and Cloud CDN. Front Door has none."
---

**What it does.** After each publish, it tells your CDN to drop the [CDN files](/integrations/cdn-files) the publish
changed, by cache tag. Apps then get the change in seconds instead of within the CDN's minute.

**When you need it.** Only if apps read CDN files through a CDN, and a minute is too long for a change to reach them.
Without a purge, a change reaches apps once the CDN's copy is a minute old and it asks the server again (usually a
`304`).

| CDN | Id | Turn it on | Credentials |
|---|---|---|---|
| [Cloudflare](#cloudflare) | `cloudflare` | On by default; it purges once it has a zone and a token: `CF_ZONE_ID` and `CF_API_TOKEN`, or **Settings → CDN** | An API token with **Cache Purge** |
| [CloudFront](#cloudfront) | `cloudfront` | `FF_CLOUDFRONT_DISTRIBUTION_ID` | The platform's own AWS identity: `cloudfront:CreateInvalidation` |
| [Cloud CDN](#cloud-cdn) | `cloud-cdn` | `FF_CLOUD_CDN_PROJECT` and `FF_CLOUD_CDN_URL_MAP` (`FF_CLOUD_CDN_HOST` optional) | The service account: a custom role with `compute.urlMaps.invalidateCache` |
| [Azure Front Door](#azure-front-door) | none | No purge | — |

## How a purge runs

It purges only what changed:

| The change | What is purged |
|---|---|
| a flag's defaults, variants or services; an environment's links replaced | the environment's tag |
| one entity's own settings, or the entity moved | its tag: its files and those of the entities under it |
| an entity's app link replaced | its link's tag: its own files |
| a new entity, a rename, a flag's name or description | nothing: nobody's answers changed |

More than 30 tags in one purge purges the environment instead.

With every CDN:

- it runs after a publish is done, without holding up the next one. Whichever instance publishes purges once, and
  again about 11 seconds later, in case an instance a round behind refilled the CDN with the old file;
- it gives up after 5 seconds. A failure is recorded on that publish, and the change still reaches apps within the
  cache's minute;
- a purge that fails shows in `/readyz` under `warnings` (it still answers `200`) and in the metrics as
  `companyflags_purge_failing` and `companyflags_warnings` ([Monitoring → Alerts](/operate/monitoring#alerts));
- replacing an entity's app link publishes every environment again, so the old link's file is purged too; replacing
  every link in an environment publishes that environment again;
- while a purge can run, the files tell the CDN it may serve a stale copy for a day while it asks again
  (`stale-while-revalidate=86400`), since a purge drops every copy a publish replaced.

**Settings → CDN** lists the last publishes and whether each purge went through, and has **Purge now** for one
environment.

## Cloudflare

1. Make a token in **My Profile → API Tokens → Create Token** with only **Zone → Cache Purge → Purge**, on this zone
   only. It needs nothing else. Your Cloudflare plan must offer purge by cache tag.
2. Give the server the zone and the token, in one of two ways:
   - **Settings → CDN** (admins): the domain's Zone ID (on its Overview page in Cloudflare, under API) and the token.
     Saving checks both with Cloudflare first by purging a tag no file carries (`companyflags-check`). The token stays
     on the server, sealed with a key from `FF_SECRET`; the console and History show only its last 4 characters.
   - **Environment variables**: `CF_ZONE_ID` and `CF_API_TOKEN`. Both are needed. They win over the console, which
     then shows them read-only.

It is one API request per publish:

```http
POST https://api.cloudflare.com/client/v4/zones/<zone id>/purge_cache
Authorization: Bearer <token>
Content-Type: application/json

{"tags":["<the tags the publish changed>"]}
```

A token saved in the console can't be read after `FF_SECRET` changes: `/readyz` says so under `warnings` until an
admin saves it again.

The purge has not been tested against a real Cloudflare zone by the project. Check it on yours: publish a change,
then see that **Settings → CDN** shows the purge went through and that the next request is a cache miss
(`cf-cache-status: MISS` or `EXPIRED`).

Setting up the cache itself: [Docker Compose → A CDN with Cloudflare](/deploy/docker-compose#a-cdn-with-cloudflare).
In a config file that lists integrations, it is `cloudflare()`, or `cloudflare({ zoneId, token })`, which win over the
variables.

## CloudFront

```bash
FF_CLOUDFRONT_DISTRIBUTION_ID=E2EXAMPLE123
```

After each publish, it sends one `CreateInvalidation` to the distribution, with the publish's cache tags as `#tag`
paths. More than 100 tags invalidate the environment's tag instead.

- **The distribution** needs cache tags turned on when you create it: `CacheTagConfig` with the header `Cache-Tag`.
  Files cached before that carry no tags.
- **No key is stored.** The server finds AWS credentials as AWS's SDKs do: `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY` (with `AWS_SESSION_TOKEN`), then a web identity token (EKS IRSA:
  `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`), then the container's credentials (an ECS task role, EKS Pod
  Identity), then the instance's profile (EC2, IMDSv2). Credentials that expire are fetched again shortly before they
  do.
- **The permission:** `cloudfront:CreateInvalidation` on the distribution, and nothing else:

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

- **A purge that fails** (`TooManyInvalidationsInProgress`, a missing permission) is kept on the publish, and
  `/readyz` warns of it. The second purge, about 11 seconds later, tries again.
- Tag invalidations count against the same monthly free paths as path ones, and each publish purges twice.
- Invalidations usually take effect in seconds, but AWS promises "under two minutes".

The whole setup, distribution included: [AWS → CDN](/deploy/aws#cdn). In a config file that lists integrations, it
is `cloudfront()`, or `cloudfront({ distributionId })`; without either, `/readyz` warns and nothing is purged.

## Cloud CDN

```bash
FF_CLOUD_CDN_PROJECT=acme-flags
FF_CLOUD_CDN_URL_MAP=flags-map
FF_CLOUD_CDN_HOST=flags.example.com        # optional: only this host's files
```

After each publish, it calls `invalidateCache` on the load balancer's URL map with the publish's cache tags. Cloud CDN
takes 10 tags a call, so it sends up to 3 calls; more tags than that invalidate the environment's tag instead. An
invalidation takes effect in about 10 seconds, which the second purge covers. Setting one of the two required
variables without the other stops the start.

- **No key is stored.** The token is the service account's, from the metadata server (Cloud Run, GKE, Compute
  Engine), kept until shortly before it expires. To try it from your own machine, set `GOOGLE_OAUTH_ACCESS_TOKEN`
  (`gcloud auth print-access-token`).
- **The permission:** give the service account a custom role with only `compute.urlMaps.invalidateCache`, not
  Compute Network Admin:

  ```bash
  gcloud iam roles create cdnInvalidator --project=acme-flags \
    --title="CDN invalidator" --permissions=compute.urlMaps.invalidateCache
  gcloud projects add-iam-policy-binding acme-flags \
    --member=serviceAccount:companyflags@acme-flags.iam.gserviceaccount.com --role=projects/acme-flags/roles/cdnInvalidator
  ```

- **A purge that fails** (a missing permission, too many invalidations a minute) is kept on the publish, and `/readyz`
  warns of it. The second purge tries again.

The whole setup, load balancer included: [Google Cloud → CDN](/deploy/google-cloud#cdn). In a config file that lists
integrations, it is `cloudCdn()`, or `cloudCdn({ project, urlMap, host })`.

## Azure Front Door

There is no purge for Front Door, and one wouldn't help:

- it purges by path only, with no tags;
- a purge takes up to 10 minutes, longer than the minute a file is kept;
- a purge sent while another runs may be refused, so the second purge after a publish would fail.

A change reaches apps within about a minute. For an incident, purge one environment by hand:
[Azure → No purge on publish](/deploy/azure#no-purge-on-publish).

The CloudFront and Cloud CDN purges use the platform's own identity, so no token is stored and `FF_SECRET` plays no
part in them.
