---
title: "CDN"
description: "Only if apps read CDN files: put a CDN in front so it answers almost every request, and purge it on publish."
---

This page is optional. It is only for installs where apps read CDN files. Apps that read flags with OFREP need no
CDN.

## When you need one

Apps that evaluate flags on the device read one file per environment, service and entity
([Local evaluation in apps](/reading/local-apps)). Every device of an entity reads the same file, so a CDN in front of
CompanyFlags can answer almost all of those requests. This page says what the files ask of a CDN, what Cloudflare,
CloudFront, Cloud CDN and Azure Front Door each do with them, and how each is purged on publish. It sets up
Cloudflare; each cloud guide sets up its own CDN.

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
| `CDN-Cache-Control` | `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400`; `stale-while-revalidate=86400` while a purge plugin can purge |
| `ETag` | a weak ETag of the file's values (not the revision), e.g. `W/"ndXGg1FVFC0UYASWys_Wj4"` |
| `Last-Modified` | when this file last changed, as this server knows it, sent from a second after the change; for a CDN that revalidates by date rather than by ETag (Front Door). `If-Modified-Since` gets a `304` when no `If-None-Match` is sent |
| `Cache-Tag` | `env-<environment>`, and for an entity's file opaque tags for it, each entity above it and its link (`e-…`, `l-…`, keyed hashes made with `BETTER_AUTH_SECRET`). They don't show any entity's key |
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
([Proxies and HTTPS](/self-hosting/proxies#keep-ofrep-and-streams-off-the-cdn)).

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
| Purge plugin | `cloudflare()` | `cloudfront()` | `cloudCdn()` | none |
| Set it up | [below](#set-up-cloudflare) | [AWS → CDN](/self-hosting/aws#cdn) | [Google Cloud → CDN](/self-hosting/google-cloud#cdn) | [Azure → CDN](/self-hosting/azure#cdn) |

## Purge on publish

Without a purge, a change reaches apps once the CDN's copy is a minute old and the CDN asks again (usually a `304`).
With a purge, CompanyFlags drops the files a publish changed right after it, so apps get the change in seconds. It
purges only what changed:

| The change | What is purged |
|---|---|
| a flag's defaults, variants or services; an environment's links replaced | the environment's tag |
| one entity's own settings, or the entity moved | its tag: its files and those of the entities under it |
| an entity's app link replaced | its link's tag: its own files |
| a new entity, a rename, a flag's name or description | nothing: nobody's answers changed |

More than 30 tags in one purge purges the environment instead.

How a purge runs, with every plugin:

- after a publish is done, without holding up the next one; whichever instance publishes purges once, and again
  about 11 seconds later, in case an instance a round behind refilled the CDN with the old file;
- it gives up after 5 seconds. A failure is recorded on that publish, and the change still reaches apps within the
  cache's minute;
- a purge that fails shows in `/readyz` under `warnings` (it still answers `200`) and in the metrics as
  `companyflags_purge_failing` and `companyflags_warnings` ([Monitoring → Alerts](/self-hosting/monitoring#alerts));
- replacing an entity's app link publishes every environment again, so the old link's file is purged too; replacing
  every link in an environment publishes that environment again.

The purge plugins:

| CDN | Plugin | How it runs | Credentials |
|---|---|---|---|
| Cloudflare | [`cloudflare()`](/reference/plugins#cloudflareoptions) | In `defaultPlugins()`: it runs unless a config file lists plugins without it. Set it up in **Settings → CDN**, or with `CF_ZONE_ID` and `CF_API_TOKEN` ([below](#purge-with-cloudflare)) | an API token with **Cache Purge** |
| CloudFront | [`cloudfront({ distributionId })`](/reference/plugins#cloudfrontoptions) | Only when listed in a config file. `FF_CLOUDFRONT_DISTRIBUTION_ID` fills in `distributionId`; it doesn't turn the plugin on | the task's IAM role: `cloudfront:CreateInvalidation` ([AWS → CDN](/self-hosting/aws#cdn)) |
| Cloud CDN | [`cloudCdn({ project, urlMap, host })`](/reference/plugins#cloudcdnoptions) | Only when listed in a config file. `FF_CLOUD_CDN_PROJECT`, `FF_CLOUD_CDN_URL_MAP` and `FF_CLOUD_CDN_HOST` fill in its options; they don't turn the plugin on | the service account: a custom role with `compute.urlMaps.invalidateCache` ([Google Cloud → CDN](/self-hosting/google-cloud#cdn)) |

To list one, keep the default plugins and add it:

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';
import { cloudfront, defaultPlugins } from 'companyflags/plugins';

export default defineConfig({ plugins: [...defaultPlugins(), cloudfront()] });
```

**Front Door gets no purge plugin.** It purges by path only, a purge takes up to 10 minutes (longer than the
minute a file is kept), and a purge sent while another runs may be refused. A change reaches apps within about a
minute; purge by hand for an incident ([Azure → No purge on publish](/self-hosting/azure#no-purge-on-publish)).

The CloudFront and Cloud CDN purges use the platform's own identity, so no token is stored and `BETTER_AUTH_SECRET`
plays no part in them.

## Set up Cloudflare

### Cache the CDN files

Cloudflare doesn't cache JSON at an address without a file extension by default. Add a **Cache Rule** for the app
files:

1. In the zone, open **Caching → Cache Rules** and create a rule.
2. When: **URI Path** starts with `/cdn/v1/flags/`.
3. Then: **Eligible for cache**.
4. Edge TTL: **Use cache-control header if present, bypass cache if not**. The files say how long to keep them, and
   error answers (a `404` for a wrong link) say `no-store`, so they aren't kept.
5. Browser TTL: **Respect origin TTL**. Browsers then ask every time and get the change as soon as the CDN has it.

Match only that path. Don't use "Cache Everything" on the whole host: the console's API must never be cached.

### Purge with `cloudflare()`

The [`cloudflare()` plugin](/reference/plugins#cloudflareoptions) runs unless your config file lists plugins without
it. It is one API request per publish:

```http
POST https://api.cloudflare.com/client/v4/zones/<zone id>/purge_cache
Authorization: Bearer <token>
Content-Type: application/json

{"tags":["<the tags the publish changed>"]}
```

Set it up in one of two ways:

- **Settings → CDN** (admins): the domain's Zone ID (on its Overview page in Cloudflare, under API) and an API token.
  Saving checks both with Cloudflare first by purging a tag no file carries (`companyflags-check`). The token stays
  on the server, sealed with a key from `BETTER_AUTH_SECRET`; the console and History show only its last 4
  characters.
- **On the server**: `CF_ZONE_ID` and `CF_API_TOKEN`, or `cloudflare({ zoneId, token })` in the config file. These
  win over the console, which shows them read-only.

Make the token in **My Profile → API Tokens → Create Token** with only **Zone → Cache Purge → Purge**, on this zone
only. It needs nothing else. Your Cloudflare plan must offer purge by cache tag.

**Settings → CDN** lists the last publishes and whether each purge went through, and has **Purge now** for one
environment. A token saved there can't be read after `BETTER_AUTH_SECRET` changes: `/readyz` says so under
`warnings` until an admin saves it again.

The purge has not been tested against a real Cloudflare zone by the project. Check it on yours: publish a change,
then see that **Settings → CDN** shows the purge went through and that the next request is a cache miss
(`cf-cache-status: MISS` or `EXPIRED`).

### Client addresses behind Cloudflare

If Cloudflare is in front of the whole host, not only the CDN files, set `FF_TRUSTED_PROXIES` to Cloudflare's
published ranges and `FF_CLIENT_IP_HEADER=cf-connecting-ip`
([Proxies and HTTPS → Client addresses](/self-hosting/proxies#client-addresses)).

### The country header

Rules can check `geo.country`. The file never varies by country, so the app reads the country from a `CF-IPCountry`
response header next to the file ([Local evaluation in apps → The country](/reading/local-apps#the-country)). In
Cloudflare, add **Rules → Transform Rules → Modify Response Header**: a rule for **URI Path** starts with
`/cdn/v1/flags/` that sets the dynamic header `CF-IPCountry` to `ip.src.country`. Each cloud guide sets the header on
its own CDN.

The server lists `CF-IPCountry` in `Access-Control-Expose-Headers`, and every answer under `/cdn/v1/` allows any
origin. Keep these headers when the CDN caches the answers, and let it pass `OPTIONS` to the server
([Local evaluation in apps → From another origin](/reading/local-apps#from-another-origin)).

## When the server is down

- Cloudflare and CloudFront may keep serving the last file they have for up to a day (`stale-if-error=86400`) when
  your server answers with an error or can't be reached. Cloud CDN serves it only for the `stale-while-revalidate`
  window: a day while its purge plugin can purge, 10 minutes otherwise. Front Door may not serve it at all.
- An app that keeps its last file (for example in local storage) can start with it while neither answers.
- OpenFeature remote evaluation goes to the server itself, so it is down with it; what the provider answers then
  depends on the provider.

## Checking it

```bash
curl -sI https://<your CDN host>/cdn/v1/flags/prod/web | grep -iE 'cache-control|etag|last-modified|age|cache-status|x-cache|cf-ipcountry'
```

Run it twice: the second answer should come from the cache (`cf-cache-status: HIT` on Cloudflare,
`x-cache: Hit from cloudfront` on CloudFront, an `Age` header on Cloud CDN and Front Door).

## Next

Give the console your own look: [Appearance](/self-hosting/appearance).
