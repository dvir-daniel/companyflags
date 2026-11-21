---
title: "CDN Files"
description: "One flagd JSON file per environment, app service and entity, for your CDN to cache, so it answers almost every request. On by default."
---

**What it does.** It serves one [flagd](https://flagd.dev) JSON file per environment, app service and entity, at
`/cdn/v1/flags/…`. Web and React Native apps read their entity's file and decide each flag on the device with
OpenFeature's flagd evaluator. Every device of an entity reads the same file, so a CDN in front of CompanyFlags can
answer almost all of those requests. The file holds values and the checks the device makes itself, never a list of
entities or another entity's rules.

**When you need it.** For very large fleets of devices, or apps that must start offline. Apps that read flags with
[OFREP](/integrations/ofrep) need no CDN and no CDN files.

## Turn it on

It is on by default. To turn it off, for an install where no app reads CDN files:

```bash
FF_INTEGRATIONS_OFF=cdn-files
```

In a config file that lists integrations, it is `cdnFiles()`. While it is on, an app link's answer carries the CDN
file's `path`; while it is off, the console hides the CDN file's address.

Then put a CDN in front, on a hostname of its own such as `cdn.flags.example.com`, that caches only
`/cdn/v1/flags/*`. Each deploy recipe sets one up: [Docker Compose](/deploy/docker-compose#a-cdn-with-cloudflare)
(Cloudflare), [AWS](/deploy/aws#cdn) (CloudFront), [Google Cloud](/deploy/google-cloud#cdn) (Cloud CDN),
[Azure](/deploy/azure#cdn) (Front Door) and [Kubernetes](/deploy/kubernetes). To drop changed files at once on
publish, add [CDN Purge](/integrations/cdn-purge).

## What a CDN can cache

Only the CDN files at `/cdn/v1/flags/…`:

| Address | What it is |
|---|---|
| `GET /cdn/v1/flags/<env>/<service>` | what every device gets before sign-in |
| `GET /cdn/v1/flags/<env>/<service>/<entity>/<secret>` | one entity's file, at its secret link |

A file is the same for every device that has the link, and carries values only. It never varies by cookie, user or
country. Each answer has these headers:

| Header | Value |
|---|---|
| `Cache-Control` | `public, max-age=0, s-maxage=60, stale-if-error=86400` |
| `CDN-Cache-Control` | `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400`; `stale-while-revalidate=86400` while a [purge](/integrations/cdn-purge) can run |
| `ETag` | a weak ETag of the file's values (not the revision), e.g. `W/"ndXGg1FVFC0UYASWys_Wj4"` |
| `Last-Modified` | when this file last changed, as this server knows it, sent from a second after the change; for a CDN that revalidates by date rather than by ETag (Front Door). `If-Modified-Since` gets a `304` when no `If-None-Match` is sent |
| `Cache-Tag` | `env-<environment>`, and for an entity's file opaque tags for it, each entity above it and its link (`e-…`, `l-…`, keyed hashes made with `FF_SECRET`). They don't show any entity's key |
| `Vary` | `Accept-Encoding` |
| `Content-Encoding` | `gzip` when the request accepts it |
| `Access-Control-Allow-Origin` | `*`, with `Access-Control-Expose-Headers: ETag, CF-IPCountry` |

Browsers ask again every time (`max-age=0`), and the CDN answers them, usually with a `304`. So a change reaches a
device as soon as it reaches the CDN. The CDN keeps a file for a minute (`s-maxage`, or `CDN-Cache-Control` for a CDN
that reads it), then asks the server again. While it asks, it may answer with the copy it has. If the server can't be
reached, it keeps serving that copy for a day. With a purge, a publish drops the copies it changed, so a stale copy is
never one a publish replaced: that is why the window is longer then.

A request with `If-None-Match` and the current ETag gets a `304`. The ETag covers the values only, so a publish that
doesn't change a file still answers `304` for it. A wrong link is a `404` with `Cache-Control: no-store`.

Everything else is not for a CDN: `/sdk/v1/…` answers are `private, no-cache` or `no-store`, OpenFeature remote
evaluation (`POST /ofrep/v1/…`) and its change-event streams are answered by the server on every request, and the
console's `/api` needs a session. Cache only `/cdn/v1/flags/*`, and keep OFREP and its streams off the CDN
([Configuration](/reference/configuration#keep-ofrep-and-streams-off-the-cdn)).

## What each CDN honours

| | Cloudflare | CloudFront | Cloud CDN | Azure Front Door |
|---|---|---|---|---|
| How long it keeps a file | `CDN-Cache-Control`: 60 s | `s-maxage`: 60 s (Max TTL 86400) | `CDN-Cache-Control`: 60 s | `s-maxage`: 60 s |
| `stale-while-revalidate` | yes | no: it's only in `CDN-Cache-Control` | yes | no |
| `stale-if-error` (a day) | yes | yes, up to the Max TTL | no: stale only for the `stale-while-revalidate` window | no |
| Revalidates with | `ETag` | `ETag` | `ETag` | `Last-Modified` only |
| `no-store` on a wrong link | honoured | honoured with Min TTL 0 | honoured with `USE_ORIGIN_HEADERS` | always honoured |
| Purge by tag | yes (plan must offer it) | yes, with a `CacheTagConfig` | yes, 10 tags per request | no: paths only |
| A purge takes | seconds | seconds, "under two minutes" | about 10 s | up to 10 minutes |
| `Cache-Tag` reaches the device | no | check it | yes (opaque) | yes, unless a rule removes it |
| Purge | [Cloudflare](/integrations/cdn-purge#cloudflare) | [CloudFront](/integrations/cdn-purge#cloudfront) | [Cloud CDN](/integrations/cdn-purge#cloud-cdn) | none |
| Set it up | [Docker Compose](/deploy/docker-compose#a-cdn-with-cloudflare) | [AWS → CDN](/deploy/aws#cdn) | [Google Cloud → CDN](/deploy/google-cloud#cdn) | [Azure → CDN](/deploy/azure#cdn) |

## The country header

Rules can check `geo.country`. The file never varies by country, so the app reads the country from a `CF-IPCountry`
response header next to the file ([Local evaluation in apps → The country](/reading/local-apps#the-country)). The CDN
sets it:

| CDN | How |
|---|---|
| Cloudflare | **Rules → Transform Rules → Modify Response Header**: for **URI Path** starts with `/cdn/v1/flags/`, set the dynamic header `CF-IPCountry` to `ip.src.country` |
| CloudFront | A viewer-response CloudFront Function that copies `CloudFront-Viewer-Country` into `CF-IPCountry` ([AWS → CDN](/deploy/aws#cdn)) |
| Cloud CDN | A custom response header `CF-IPCountry: {client_region}` on the CDN backend ([Google Cloud → CDN](/deploy/google-cloud#cdn)) |
| Front Door | A rule set: Modify response header, Overwrite `CF-IPCountry` with `{geo_country}` ([Azure → CDN](/deploy/azure#cdn)) |

Without it, `geo.country` is unknown and locked rules apply.

The server lists `CF-IPCountry` in `Access-Control-Expose-Headers`, and every answer under `/cdn/v1/` allows any
origin. Keep these headers when the CDN caches the answers, and let it pass `OPTIONS` to the server
([Local evaluation in apps → From another origin](/reading/local-apps#from-another-origin)).

## Client addresses

CDN files have no per-client limits, so the CDN's own addresses needn't be in `FF_TRUSTED_PROXIES`. If the CDN is in
front of the whole host, not only the files, it must be: for Cloudflare, its published ranges and
`FF_CLIENT_IP_HEADER=cf-connecting-ip` ([Configuration → Client addresses](/reference/configuration#client-addresses)).
Better, keep OFREP and its streams off the CDN
([Configuration → Keep OFREP and streams off the CDN](/reference/configuration#keep-ofrep-and-streams-off-the-cdn)).

## When the server is down

- Cloudflare and CloudFront may keep serving the last file they have for up to a day (`stale-if-error=86400`) when
  your server answers with an error or can't be reached. Cloud CDN serves it only for the `stale-while-revalidate`
  window: a day while its purge can run, 10 minutes otherwise. Front Door may not serve it at all.
- An app that keeps its last file (for example in local storage) can start with it while neither answers.
- OpenFeature remote evaluation goes to the server itself, so it is down with it; what the provider answers then
  depends on the provider.

## Checking it

```bash
curl -sI https://cdn.flags.example.com/cdn/v1/flags/prod/web | grep -iE 'cache-control|etag|last-modified|age|cache-status|x-cache|cf-ipcountry'
```

Run it twice: the second answer should come from the cache (`cf-cache-status: HIT` on Cloudflare,
`x-cache: Hit from cloudfront` on CloudFront, an `Age` header on Cloud CDN and Front Door).

The files' addresses carry each entity's link secret: treat the CDN's and the load balancer's access logs as secret.
See [Local evaluation in apps](/reading/local-apps) for the app's side, and
[HTTP API → CDN files](/reference/http-api) for the answers in full.
