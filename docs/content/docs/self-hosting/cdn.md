---
title: "CDN (Cloudflare)"
---

Apps read one file per environment, service and entity. Every device of an entity reads the same file, so a CDN in
front of CompanyFlags can answer almost all of those requests. This page sets up Cloudflare; another CDN works the
same way if it honours `Cache-Control` and can purge by tag.

## What a CDN can cache

Only the CDN files at `/client/v1/flags/…`:

| Address | What it is |
|---|---|
| `GET /client/v1/flags/<env>/<service>` | what every device gets before sign-in |
| `GET /client/v1/flags/<env>/<service>/<entity>/<secret>` | one entity's file, at its secret link |

A file is the same for every device that has the link, and carries values only. It never varies by cookie, user or
country. Each answer has these headers:

| Header | Value |
|---|---|
| `Cache-Control` | `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400` |
| `ETag` | a weak ETag of the file's values, e.g. `W/"ndXGg1FVFC0UYASWys_Wj4"` |
| `Cache-Tag` | `env-<env>`, e.g. `env-prod` |
| `Vary` | `Accept-Encoding` (gzip when the request accepts it) |
| `Access-Control-Allow-Origin` | `*` |

A request with `If-None-Match` and the current ETag gets a `304`. The ETag covers the values only, so a publish that
doesn't change a file still answers `304` for it.

Everything else is not for a CDN: `/sdk/v1/…` answers are `private, no-cache` or `no-store`, OpenFeature remote
evaluation (`POST /ofrep/v1/…`) is answered by the server on every request, and the console's `/api` needs a session.

## Cache the CDN files

Cloudflare doesn't cache JSON at an address without a file extension by default. Add a **Cache Rule** for the app
files:

1. In the zone, open **Caching → Cache Rules** and create a rule.
2. When: **URI Path** starts with `/client/v1/flags/`.
3. Then: **Eligible for cache**.
4. Edge TTL: **Use cache-control header if present, bypass cache if not**. The files say how long to keep them, and
   error answers (a `404` for a wrong link) carry no `Cache-Control`, so they aren't kept. A publish purges by tag, and
   error answers carry no tag.
5. Browser TTL: respect the origin's headers.

Match only that path. Don't use "Cache Everything" on the whole host: the console's API must never be cached.

## Purge on publish

Without a purge, a change reaches apps once the CDN's copy is a minute old and the CDN asks again (usually a `304`).
With a purge, CompanyFlags drops the environment's files from Cloudflare right after each publish, so apps get the
change in seconds.

The purge is the [`cloudflare()` plugin](/reference/plugins#cloudflare-options). It runs unless your config file
lists plugins without it, and its zone and token can be set there too: `cloudflare({ zoneId, token })`.

The purge is one API request per publish:

```http
POST https://api.cloudflare.com/client/v4/zones/<zone id>/purge_cache
Authorization: Bearer <token>
Content-Type: application/json

{"tags":["env-prod"]}
```

Set it up in one of two ways:

- **Settings → CDN** (admins): the domain's Zone ID (on its Overview page in Cloudflare, under API) and an API token.
  Saving checks both with Cloudflare first by purging a tag no file carries (`companyflags-check`). The token stays
  on the server; the console and History show only its last 4 characters.
- **On the server**: `CF_ZONE_ID` and `CF_API_TOKEN`, or `cloudflare({ zoneId, token })` in the config file. These
  win over the console, which shows them read-only.

Make the token in **My Profile → API Tokens → Create Token** with only **Zone → Cache Purge → Purge**, on this zone
only. It needs nothing else. Your Cloudflare plan must offer purge by cache tag.

How the purge runs:

- after a publish is done, without holding up the next one; whichever instance publishes purges once;
- it gives up after 5 seconds. A failure is recorded on that publish, and the change still reaches apps within the
  cache's minute;
- **Settings → CDN** lists the last publishes and whether each purge went through, and has **Purge now** for one
  environment;
- replacing an entity's app link publishes every environment again, so the old link's file is purged too; replacing
  every link in an environment publishes that environment again.

The purge has not been tested against a real Cloudflare zone by the project. Check it on yours: publish a change,
then see that **Settings → CDN** shows the purge went through and that the next request is a cache miss
(`cf-cache-status: MISS` or `EXPIRED`).

## The country

Rules can check `geo.country`, a two-letter country code. The file never varies by country: the server doesn't know
where a device is. The app reads the country from a `CF-IPCountry` response header next to the file, and checks the
file's country lines itself (see [The CDN file](/sdk/cdn-file)).

Cloudflare sends `CF-IPCountry` to your server, not to the device. To give it to apps, add a **Transform Rule**:

1. **Rules → Transform Rules → Modify Response Header**, create a rule.
2. When: **URI Path** starts with `/client/v1/flags/`.
3. Then: **Set dynamic** header `CF-IPCountry` to `ip.src.country`.

Browsers may read the header from another origin: the server lists it in `Access-Control-Expose-Headers`. Without the
header, `geo.country` is unknown: a rule that checks it doesn't match, except a locked rule, which applies when the
value is missing (it fails closed).

OpenFeature remote evaluation doesn't read the country from Cloudflare: if your rules check `geo.country`, send it in
the evaluation context.

## Web apps on another origin

Every answer under `/client/v1/` has `Access-Control-Allow-Origin: *`, allows `GET` and `HEAD`, exposes `ETag` and
`CF-IPCountry`, and caches the preflight for a day. A file is public to whoever has its link and needs no cookie, so
any origin may read it. Keep these headers when Cloudflare caches the answers.

## When the server is down

- The CDN may keep serving the last file it has for up to a day (`stale-if-error=86400`) when your server answers
  with an error or can't be reached.
- An app that keeps its last file (for example in local storage) can start with it while neither answers.
- OpenFeature remote evaluation goes to the server itself, so it is down with it; what the provider answers then
  depends on the provider.

## Checking it

```bash
curl -sI https://flags.example.com/client/v1/flags/prod/web | grep -iE 'cache-control|etag|cf-cache-status|cf-ipcountry'
```

Run it twice: the second answer should say `cf-cache-status: HIT`.
