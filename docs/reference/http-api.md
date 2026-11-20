# HTTP API

These are the public endpoints of a CompanyFlags server: the app files, the backends' endpoints, OpenFeature
remote evaluation and the health checks. All of them answer JSON. The examples use `https://flags.example.com`.

| Endpoint | Who calls it | Auth |
|---|---|---|
| `GET /client/v1/flags/<env>/<flag set>` | apps, before sign-in | none |
| `GET /client/v1/flags/<env>/<flag set>/<entity>/<secret>` | apps | the secret link |
| `GET /sdk/v1/flagd/<dimension>/<entity>`, `GET /sdk/v1/flagd` | backends, flagd | API key |
| `GET /sdk/v1/links/<dimension>/<entity>?flagSet=<key>` | backends | API key |
| `POST /ofrep/v1/evaluate/flags`, `POST /ofrep/v1/evaluate/flags/<key>` | OpenFeature OFREP providers | an app's token, or a backend's API key |
| `GET /ofrep/v1/events/<env>/<signature>` | OpenFeature OFREP providers (change events) | the signature from an answer |
| `GET /healthz`, `GET /readyz` | load balancers, orchestrators | none |

## Errors

An error is JSON with a status code:

```json
{ "error": "no file at this link" }
```

An address the server doesn't know under `/api`, `/client`, `/sdk` or `/ofrep` is a `404` with
`{"error":"no such endpoint: GET /client/v1/nope"}`, never the console's page. (Under `/api`, a request that isn't
signed in gets `401` first.) An unexpected error is `500 {"error":"internal error"}`. OFREP endpoints answer their
own errors the OFREP way (below).

## App files

```http
GET /client/v1/flags/<env>/<flag set>
GET /client/v1/flags/<env>/<flag set>/<entity>/<secret>
```

`<flag set>` is the key of a flag set for apps, such as `web`. The first is what every device reading it gets before
sign-in. The second is one entity's file, at its secret link; the console shows it on the entity's page, and backends
get it from `/sdk/v1/links` (below). `HEAD` works too.

```json
{
  "environment": "prod",
  "revision": 42,
  "flags": {
    "api_base_url": { "value": "https://api.example.com" },
    "new_checkout": { "value": false, "when": [ … ] }
  }
}
```

`revision` is the environment's publish number. The flags hold values only; the format of each flag, its `when`
lines and how an app reads them are in [The app file](/sdk/app-file).

Headers:

| Header | Value |
|---|---|
| `Cache-Control` | `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400` |
| `ETag` | weak, over the flags' values (not the revision) |
| `Cache-Tag` | `env-<env>` |
| `Vary` | `Accept-Encoding` |
| `Content-Encoding` | `gzip` when the request accepts it |
| `Access-Control-Allow-Origin` | `*`, with `Access-Control-Expose-Headers: ETag, CF-IPCountry` |

`If-None-Match` with the current ETag → `304`. `OPTIONS` (a CORS preflight) → `204`, allowing `GET` and `HEAD`,
kept for a day. See [CDN](/self-hosting/cdn) for caching them.

| Status | When |
|---|---|
| `404 {"error":"no file at this link"}` | the entity doesn't exist or the secret is wrong: the same answer for every wrong link |
| `404 {"error":"environment \"<env>\" not found"}` | no such environment |
| `404 {"error":"flag set \"<key>\" not found"}` | no such flag set, or it is for backends (they have no file) |

## Backends

All backend endpoints take an API key: `Authorization: Bearer <key>`. A key belongs to one environment and one
flag set for backends, and its scope (`entity`, `below` or `all`) says which entities it may ask about. See
[Backends](/guide/backends).

### flagd JSON

```http
GET /sdk/v1/flagd/<dimension>/<entity>
GET /sdk/v1/flagd
```

The key's flag set for one entity, as one flagd flag set: `flagSetId` is `<env>/<flag set>/<entity>`, such as
`prod/api/acme`. The path-less form is for a key scoped to one entity (or `below` one, for its own).
`Cache-Control: private, no-cache`; `ETag` and `If-None-Match` → `304`.

| Status | When |
|---|---|
| `200` | the flagd JSON: `{ "$schema", "metadata": { "flagSetId", "environment", "revision" }, "flags" }` |
| `400` | `GET /sdk/v1/flagd` with an `all` key: name the entity in the path |
| `401` | no key, or an unknown or revoked one |
| `403` | the entity is outside the key's scope |
| `404` | no such dimension, or no such entity in it |

### An entity's app link

```http
GET /sdk/v1/links/<dimension>/<entity>?flagSet=<key>
```

```json
{
  "environment": "prod",
  "flagSet": "web",
  "entity": "acme",
  "path": "/client/v1/flags/prod/web/acme/<secret>",
  "token": "ffl_prod.web.acme.<secret>"
}
```

`path` is the entity's app file; `token` is the same link as an app's credential for OFREP (below). Both are for the
key's environment. `Cache-Control: no-store`.

| Status | When |
|---|---|
| `400` | no `?flagSet=`: `{"error":"name the flag set the link is for: ?flagSet=<key>, e.g. ?flagSet=web"}` |
| `401` | no key, or an unknown or revoked one |
| `403` | the entity is outside the key's scope |
| `404` | no such dimension, entity or flag set, or the flag set is for backends |

## OpenFeature remote evaluation (OFREP)

For OpenFeature's OFREP providers, in apps (web, Android, iOS) and on servers. Requests and answers follow the
[OFREP specification](https://github.com/open-feature/protocol) (0.4).

```http
POST /ofrep/v1/evaluate/flags            every flag in the flag set, at once
POST /ofrep/v1/evaluate/flags/<key>      one flag
Authorization: Bearer <credential>       or OFREP's X-API-Key: <credential>
Content-Type: application/json

{ "context": { "targetingKey": "d-1", "company": "acme", "app": { "version": "6.0.0" } } }
```

**The credential** says the environment, the flag set and which entities it may ask about:

- an **app** sends its app token, `ffl_<env>.<flag set>.<entity>.<secret>`, made from its entity's link for its flag set
  (from `/sdk/v1/links` or the entity's **App link** in the console). It asks as that entity only. Apps never hold an
  API key;
- a **backend** sends its API key, within its scope (`entity`, `below` or `all`).

**The context:**

- The entity is named by its dimension key (`"company": "acme"`, `"brand": "lumen"`). If several dimensions are
  named, the lowest asks and the others must be the ones above it. The server fills in the levels above.
- Naming none: a token, or a key for one entity (or `below` one), asks as its own entity; an `all` key asks as no
  entity, which is what every device gets before sign-in.
- The rest is what the device or request knows about itself, nested or dotted (`{"app": {"version": "6.0.0"}}` is
  `app.version`). `targetingKey` is the device ID a % of devices is decided by, unless the context has `device.id`.
  What it says about the flag set or environment is ignored.

**Answers:**

- One flag: `{ "key", "reason", "variant", "value", "metadata" }`. `metadata.group` is a % rule's group name, when it
  has one. `Cache-Control: no-store`.
- Every flag: `{ "flags": [ … ], "metadata": { "environment": "prod" } }`, one answer per flag in the flag set, with
  a weak `ETag` and `Cache-Control: private, no-cache`. `If-None-Match` with the ETag → `304` while nothing changed.
- A flag that uses the app's code default answers with a `reason` and no `value`, so the provider returns the default
  in the app's code.
- An error for a flag or a request is `{ "key", "errorCode", "errorDetails" }` (`key` only for one flag).

| Status | When |
|---|---|
| `200` | the answer |
| `304` | every flag: nothing changed since that ETag |
| `400` | `PARSE_ERROR`: the body isn't JSON; `INVALID_CONTEXT`: no `context`, an entity that doesn't exist, or one not under the entity named above it; for one flag, `GENERAL` when it can't be evaluated |
| `401` | `{"error":"unknown or replaced app link"}` for a wrong token, `{"error":"unknown or revoked API key"}` for a wrong key, `{"error":"missing API key (Authorization: Bearer <key>)"}` without one |
| `403` | `GENERAL`: the entity is outside the credential's scope |
| `404` | one flag: `FLAG_NOT_FOUND`, the flag doesn't exist or isn't in this flag set |

**Change events.** The answer for every flag also has `eventStreams`: one server-sent events stream,
`GET /ofrep/v1/events/<env>/<signature>`, for the whole environment. It sends `{"type":"refetchEvaluation","etag":"<revision>"}`
on every publish there (and a comment every 25 seconds to keep the connection open); the provider then asks for its
flags again. The signature is made with the environment's secret, so only someone given it in an answer can listen,
and an event says only that the environment published. A wrong signature is a `404`.

**CORS** is open on `/ofrep/*`: any origin may `POST` with `Authorization`, `Content-Type`, `If-None-Match` and
`X-API-Key`, and read `ETag`. See [Security model](/guide/security#app-tokens).

## Health

| Endpoint | Answer |
|---|---|
| `GET /healthz` | `200 {"ok":true}` while the process runs |
| `GET /readyz` | `200 {"ok":true,"environments":2}` when the database answers, `503 {"ok":false,"error":"the database isn’t answering"}` otherwise |

## The console's API

The console talks to the server under `/api`: `/api/auth/*` is the sign-in (Better Auth), and the rest is the
console's own API. It is for the console, not a stable public API yet: its addresses and answers may change in any
release.

It needs a signed-in session (the cookie) and, for every change (any method but `GET`, `HEAD` and `OPTIONS`), the
header `X-Requested-With: companyflags` and a JSON body. A request without the header, or one the browser marks
`Sec-Fetch-Site: cross-site`, gets `403`. See [Security model](/guide/security#changes-from-the-console).
