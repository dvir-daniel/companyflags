---
title: "HTTP API"
---

These are the public endpoints of a CompanyFlags server: the app files, the backends' endpoints, OpenFeature
remote evaluation and the health checks. All of them answer JSON. The examples use `https://flags.example.com`.

| Endpoint | Who calls it | Auth |
|---|---|---|
| `GET /client/v1/flags/<env>/<service>` | apps, before sign-in | none |
| `GET /client/v1/flags/<env>/<service>/<entity>/<secret>` | apps | the secret link |
| `GET /sdk/v1/flagd/<dimension>/<entity>`, `GET /sdk/v1/flagd` | backends, flagd | a backend service's key |
| `GET /sdk/v1/links/<dimension>/<entity>?service=<key>` | backends | a backend service's key |
| `POST /ofrep/v1/evaluate/flags`, `POST /ofrep/v1/evaluate/flags/<key>` | OpenFeature OFREP providers | an app service's key, an app token, or a backend service's key |
| `GET /ofrep/v1/events/<env>/<signature>` | OpenFeature OFREP providers (change events) | the signature from an answer |
| [`POST /hooks/v1/<token>`](/guide/webhooks#in) | another system (webhook in) | the address itself |
| `GET /healthz`, `GET /readyz` | load balancers, orchestrators | none |

## Credentials

Every key is for one service in one environment, and reads only that service's flags. Admins make keys on the
console's **API keys** page. Send a credential as `Authorization: Bearer <credential>` (OFREP also takes
`X-API-Key: <credential>`).

| Credential | Looks like | Kept | What it may do |
|---|---|---|---|
| An app service's key | `ff_prod_web_…` | In the app: it is public | OFREP: that service's values, for the context the app sends. Not flagd JSON, not app links |
| A backend service's key | `ff_prod_api_…` | On your servers: it is secret | OFREP, flagd JSON, and app links to hand to apps |
| An app token | `ffl_prod.web.acme.…` | In the app, from your backend at sign-in (optional) | OFREP: one app service's values, as one entity only |

- **A backend's key from a browser is refused.** A request with an `Origin` header and a backend service's key gets
  `403 {"error":"a backend’s key can’t be used from a browser: give the app its app service’s key instead"}`.
- **An app's key reads values only.** flagd JSON gets
  `403 {"error":"an app’s key reads values only (OFREP): the rules as flagd JSON are for a backend’s key"}`, and app
  links get `403 {"error":"an app’s key can’t hand out app links: ask with a backend’s key"}`.
- **A key's scope** (`entity`, `below` or `all`) says which entities it may ask about. Outside it, `403`.

## Errors

An error is JSON with a status code:

```json
{ "error": "no file at this link" }
```

An address the server doesn't know under `/api`, `/client`, `/sdk`, `/ofrep` or `/hooks` is a `404` with
`{"error":"no such endpoint: GET /client/v1/nope"}`, never the console's page. (Under `/api`, a request that isn't
signed in gets `401` first.) An unexpected error is `500 {"error":"internal error"}`. OFREP endpoints answer their
own errors the OFREP way (below).

### Request size

Each request body has a limit, by address. A larger one gets `413 {"error":"the request body is larger than …"}`
as it arrives, also when it's sent in chunks with no `Content-Length`.

| Address | Most it takes |
|---|---|
| `/ofrep/` | 64 KB |
| `/api/auth/` (sign-in) | 256 KB |
| `/hooks/` (webhooks in) | 1 MB |
| `/api/migration/` (imports) | 4 MB |
| everything else | 1 MB |

## App files

```http
GET /client/v1/flags/<env>/<service>
GET /client/v1/flags/<env>/<service>/<entity>/<secret>
```

`<service>` is the key of an app service, such as `web`. The first is what every device reading it gets before
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
| `404 {"error":"no file at this link"}` | an entity's file: a wrong environment, service, entity or secret, the same answer for every wrong link |
| `404 {"error":"environment \"<env>\" not found"}` | the file before sign-in: no such environment |
| `404 {"error":"service \"<key>\" not found"}` | the file before sign-in: no such service, or it is a backend (backends have no file) |

## Backends

All backend endpoints take a backend service's key: `Authorization: Bearer <key>`. A key belongs to one environment
and one service, and its scope (`entity`, `below` or `all`) says which entities it may ask about. An app service's
key gets `403` here, and so does a backend's key sent with an `Origin` header (from a browser). See
[Backends](/guide/backends).

### flagd JSON

```http
GET /sdk/v1/flagd/<dimension>/<entity>
GET /sdk/v1/flagd
```

The key's service for one entity, as one flagd flag set: `flagSetId` is `<env>/<service>/<entity>`, such as
`prod/api/acme`. The path-less form is for a key scoped to one entity (or `below` one, for its own).
`Cache-Control: private, no-cache`; `ETag` and `If-None-Match` → `304`.

| Status | When |
|---|---|
| `200` | the flagd JSON: `{ "$schema", "metadata": { "flagSetId", "environment", "revision" }, "flags" }` |
| `400` | `GET /sdk/v1/flagd` with an `all` key: name the entity in the path |
| `401` | no key, or an unknown or revoked one |
| `403` | the entity is outside the key's scope; an app service's key; a backend's key from a browser |
| `404` | no such dimension, or no such entity in it |

### An entity's app link

```http
GET /sdk/v1/links/<dimension>/<entity>?service=<key>
```

```json
{
  "environment": "prod",
  "service": "web",
  "entity": "acme",
  "path": "/client/v1/flags/prod/web/acme/<secret>",
  "token": "ffl_prod.web.acme.<secret>"
}
```

`service` names the app service the link is for (`?flagSet=<key>`, from 0.2, still works until 0.4). `path` is the
entity's app file, only when the `appFiles()` plugin runs. `token` is made from the same link, with a secret of its
own for this service: an app's signed credential for OFREP (below). Both are for the key's environment.
`Cache-Control: no-store`.

| Status | When |
|---|---|
| `400` | no `?service=`: `{"error":"name the service the link is for: ?service=<key>, e.g. ?service=web"}` |
| `401` | no key, or an unknown or revoked one |
| `403` | the entity is outside the key's scope; an app service's key; a backend's key from a browser |
| `404` | no such dimension, entity or service, or the service is a backend |

## OpenFeature remote evaluation (OFREP)

For OpenFeature's OFREP providers, in apps (web, Android, iOS) and on servers. Requests and answers follow the
[OFREP specification](https://github.com/open-feature/protocol) (0.4).

```http
POST /ofrep/v1/evaluate/flags            every flag in the service, at once
POST /ofrep/v1/evaluate/flags/<key>      one flag
Authorization: Bearer <credential>       or OFREP's X-API-Key: <credential>
Content-Type: application/json

{ "context": { "targetingKey": "d-1", "company": "acme", "app": { "version": "6.0.0" } } }
```

**The credential** says the environment, the service and which entities it may ask about:

- an **app** sends its app service's key, within its scope. It is public, so the entity its context names is
  targeting, not proof;
- an **app with a signed app link** sends its app token instead, `ffl_<env>.<service>.<entity>.<secret>`, made from
  its entity's link for its service (from `/sdk/v1/links` or the entity's **App link** in the console). It asks as
  that entity only;
- a **backend** sends its backend service's key, within its scope (`entity`, `below` or `all`). From a browser (with
  an `Origin` header), it gets `403`.

**The context:**

- The entity is named by its dimension key (`"company": "acme"`, `"brand": "lumen"`). If several dimensions are
  named, the lowest asks and the others must be the ones above it. The server fills in the levels above.
- Naming none: a token, or a key for one entity (or `below` one), asks as its own entity; an `all` key asks as no
  entity, which is what every device gets before sign-in.
- The rest is what the device or request knows about itself, nested or dotted (`{"app": {"version": "6.0.0"}}` is
  `app.version`). `targetingKey` is the device ID a % of devices is decided by, unless the context has `device.id`.
  What it says about the service or environment is ignored.

**Answers:**

- One flag: `{ "key", "reason", "variant", "value", "metadata" }`. `metadata.group` is a % rule's group name, when it
  has one. `Cache-Control: no-store`.
- Every flag: `{ "flags": [ … ], "metadata": { "environment": "prod" } }`, one answer per flag in the service, with
  a weak `ETag` and `Cache-Control: private, no-cache`. `If-None-Match` with the ETag → `304` while nothing changed.
- A flag that uses the app's code default answers with a `reason` and no `value`, so the provider returns the default
  in the app's code.
- An error for a flag or a request is `{ "key", "errorCode", "errorDetails" }` (`key` only for one flag).

| Status | When |
|---|---|
| `200` | the answer |
| `304` | every flag: nothing changed since that ETag |
| `400` | `PARSE_ERROR`: the body isn't JSON; `INVALID_CONTEXT`: no `context`, an entity that doesn't exist (with an `all` key), or one not under the entity named above it; for one flag, `GENERAL` when it can't be evaluated |
| `401` | `{"error":"unknown or replaced app link"}` for a wrong token, `{"error":"unknown or revoked API key"}` for a wrong key, `{"error":"missing API key (Authorization: Bearer <key>)"}` without one |
| `403` | `GENERAL`: the entity is outside the credential's scope. An app token, or a key scoped to `entity` or `below`, gets this same answer for an entity that doesn't exist. `{"error":"a backend’s key can’t be used from a browser: …"}` for a backend's key with an `Origin` header |
| `404` | one flag: `FLAG_NOT_FOUND`, the flag doesn't exist or isn't in this service |

**Change events.** The answer for every flag also has `eventStreams`: one server-sent events stream,
`GET /ofrep/v1/events/<env>/<signature>`, for the whole environment. It sends `{"type":"refetchEvaluation","etag":"<revision>"}`
on every publish there (and a comment every 25 seconds to keep the connection open); the provider then asks for its
flags again. The signature is made with the environment's secret, so only someone given it in an answer can listen,
and an event says only that the environment published. A wrong signature is a `404`.

**CORS** is open on `/ofrep/*`: any origin may `POST` with `Authorization`, `Content-Type`, `If-None-Match` and
`X-API-Key`, and read `ETag`, with an app service's key or an app token. A backend's key is refused from a browser.
See [Security model](/guide/security#api-keys).

## Health

| Endpoint | Answer |
|---|---|
| `GET /healthz` | `200 {"ok":true}` while the process runs |
| `GET /readyz` | `200 {"ok":true,"environments":2}` when the database answers, `503 {"ok":false,"error":"the database isn’t answering"}` otherwise |

## The console's API

The console talks to the server under `/api`: `/api/auth/*` is the sign-in (Better Auth), and the rest is the
console's own API. It is for the console, not a stable public API yet: its addresses and answers may change in any
release.

Some of it needs no session: the sign-in (`/api/auth/*` and `GET /api/sign-in`), the console's
[appearance](/self-hosting/appearance) (`GET /api/appearance` and its images), and these two.

- `GET /api/setup/<secret>` is the [setup link](/self-hosting/sign-in#the-first-account) a new server prints. It
  keeps the secret in a cookie and redirects to the console. A wrong secret, or a server that has accounts, gets
  `404`. A script can send the secret in an `X-Setup` header with its sign-up request instead.
- `POST /api/invites` with `{"token": "…"}` says who an invite link is for. The token goes in the body, so it stays
  out of access logs.

Admins add, change and delete services at `/api/services` (`POST`, then `PUT` and `DELETE /api/services/<key>`),
with `{ "key": "web", "kind": "client" }`: the kind is `client` for an App and `server` for a Backend. Keys are made
at `POST /api/api-keys`. In the console's API a service is a `project`, as in the database.

Scripts, the CLI and MCP clients send an [access token](/guide/security#access-tokens) instead of the cookie:
`Authorization: Bearer cfp_…`. A token needs no `X-Requested-With` header, and is refused from a browser (`403` with
an `Origin` header). `401` means it is unknown, expired or revoked. Tokens are listed at `GET /api/tokens` (an admin
adds `?all=1` for everyone's), made at `POST /api/tokens` with `{ "name": "CI", "role": "editor", "agent": false,
"days": 90 }` and revoked at `DELETE /api/tokens/<id>`, all from the signed-in console only. A request an agent made
says so in `/api/change-sets` (`"byAgent": true`).

The rest needs a signed-in session (the cookie). Every change (any method but `GET`, `HEAD` and `OPTIONS`) also
needs the header `X-Requested-With: companyflags` and a JSON body. A request without the header, or one the browser
marks `Sec-Fetch-Site: cross-site`, gets `403`. See [Security model](/guide/security#changes-from-the-console).
