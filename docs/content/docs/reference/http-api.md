---
title: "HTTP API"
description: "The public endpoints: CDN files, the backends' flagd JSON, OFREP remote evaluation and the health checks."
---

These are the public endpoints of a CompanyFlags server: the CDN files, the backends' endpoints, OpenFeature
remote evaluation, the health checks and the stable API for scripts and integrations (`/api/v1`). All of them answer
JSON. The examples use `https://flags.example.com`.

| Endpoint | Who calls it | Auth |
|---|---|---|
| `GET /cdn/v1/flags/<env>/<service>` | apps, before sign-in | none |
| `GET /cdn/v1/flags/<env>/<service>/<entity>/<secret>` | apps | the secret link |
| `GET /sdk/v1/flagd/<dimension>/<entity>`, `GET /sdk/v1/flagd`, `GET /sdk/v1/flagd/service` | backends, flagd | a backend service's key |
| `PUT /sdk/v1/entities/<dimension>/<entity>` | backends, as an entity signs up | a backend service's key for every entity |
| `GET /sdk/v1/links/<dimension>/<entity>?service=<key>` | backends | a backend service's key |
| `POST /ofrep/v1/evaluate/flags`, `POST /ofrep/v1/evaluate/flags/<key>` | OpenFeature OFREP providers | an app service's key, an app token, or a backend service's key |
| `GET /ofrep/v1/events/<env>/<service>[/<entity>]/<signature>` | OpenFeature OFREP providers (change events) | the signature from an answer |
| [`POST /hooks/v1/<token>`](/guide/webhooks#in) | another system (webhook in) | the address itself |
| `GET /healthz`, `GET /readyz` | load balancers, orchestrators | none |
| [`GET /metrics`](/self-hosting/production#metrics) | Prometheus, with the `metrics()` plugin | none, or its token |
| [`/api/v1/…`](#the-stable-api-apiv1) | scripts, CI, integrations | an access token |

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
- **A key's scope** (`entity`, `below` or `all`) says which entities it may ask about. Outside it, `403`. A key
  scoped to `entity` or `below` gets that same `403` for an entity that doesn't exist, so it can't learn which
  entities there are; an `all` key gets `404`.

## Errors

An error is JSON with a status code: a sentence for people in `error`, and a stable `code` for code to act on.

```json
{ "error": "“new_checkout” is taken already", "code": "already_exists" }
```

The sentence may change in any release; the codes don't. Some errors say more in other fields (`errors`, a list of
problems; `currentVersion`, …).

| Code | Status | When |
|---|---|---|
| `bad_request` | 400 | a value is missing or of the wrong form, in the address, the query or the body |
| `bad_json` | 400 | the body is empty where one is needed, isn't JSON, or isn't a JSON object |
| `unauthorized` | 401 | not signed in, or an unknown, expired or revoked token |
| `forbidden` | 403 | the person's role, or the token, may not do this |
| `not_found` | 404 | no such flag, environment, entity, … or no such endpoint |
| `already_exists` | 409 | the key is taken already (an archived flag keeps its key) |
| `conflict` | 409 | someone else changed it since you read it: read it again |
| `blocked` | 409 | not now: something else has to change first (it's in use, turn it off first, …) |
| `too_large` | 413 | the body is larger than this address takes |
| `invalid` | 422 | understood, but what it asks for breaks a rule; the sentence says which |
| `needs_reshuffle` | 422 | a % change moves devices to other values: send it again with `allowReshuffle` |
| `too_many_requests` | 429 | too many requests: wait and try again |
| `internal` | 500 | a bug: the server logs it, and the answer says nothing more |
| `unavailable` | 503 | the database isn't answering, or publishing fails (`/readyz`) |

The database's own words never reach an answer: a key that is taken is `409 already_exists`, a value its rules
refuse is `422 invalid`, and the server's log has the database's message.

An address the server doesn't know under `/api`, `/sdk`, `/cdn`, `/ofrep`, `/hooks` or `/mcp` (and a plugin's
own prefixes) is a `404` with `{"error":"no such endpoint: GET /cdn/v1/nope","code":"not_found"}`, never the
console's page. (Under `/api`, a request that isn't signed in gets `401` first.) OFREP endpoints answer their own
errors the OFREP way (below), and `/api/auth/*` (Better Auth) and `/mcp` (JSON-RPC) theirs.

### Request size

Each request body has a limit, by address. A larger one gets `413 {"error":"the request body is larger than …"}`
as it arrives, also when it's sent in chunks with no `Content-Length` (`code`: `too_large`).

| Address | Most it takes |
|---|---|
| `/ofrep/` | 64 KB |
| `/api/auth/` (sign-in) | 256 KB |
| `/hooks/` (webhooks in) | 1 MB |
| `/api/migration/` (imports) | 4 MB |
| everything else | 1 MB |

## CDN files

```http
GET /cdn/v1/flags/<env>/<service>
GET /cdn/v1/flags/<env>/<service>/<entity>/<secret>
```

`<service>` is the key of an app service, such as `web`. The first is what every device reading it gets before
sign-in. The second is one entity's file, at its secret link; the console shows it on the entity's page, and backends
get it from `/sdk/v1/links` (below). `HEAD` works too.

The answer is [flagd](https://flagd.dev) JSON, as a backend's flagd JSON is, made for the app service and the
entity (or for no entity, before sign-in):

```json
{
  "$schema": "https://flagd.dev/schema/v0/flags.json",
  "metadata": { "flagSetId": "prod/web/acme", "environment": "prod", "revision": 42 },
  "flags": {
    "api_base_url": { "state": "ENABLED", "variants": { "default": "https://api.example.com" }, "defaultVariant": "default" },
    "new_checkout": { "state": "ENABLED", "variants": { "on": true, "off": false }, "defaultVariant": "off", "targeting": { … } }
  }
}
```

`metadata.revision` is the environment's publish number. What's in it, and how an app reads it, are in
[The CDN file](/reading/local-apps).

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
[Backends](/reading/overview).

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
| `403` | the entity is outside the key's scope (with a key scoped to `entity` or `below`, also one that doesn't exist); an app service's key; a backend's key from a browser |
| `404` | an `all` key: no such dimension, or no such entity in it |

```http
GET /sdk/v1/flagd/service
```

The key's service for every entity it may ask about, as one flagd flag set, so one flagd serves a backend shared by
many entities: `flagSetId` is `<env>/<service>`. Each flag's targeting picks the entity by the dimension keys in the
request's context (`{"company": "acme"}`), the lowest named first, then runs that entity's rules. A request that
names none gets what no entity gets (an `all` key) or what the key's own entity gets (a `below` key). See
[One flagd for many entities](/reading/local-backends#one-flagd-for-many-entities). `400` for a key scoped to one
entity (it reads `GET /sdk/v1/flagd`); otherwise as above.

### A new entity

```http
PUT /sdk/v1/entities/<dimension>/<entity>
{ "name": "Stark Industries", "parent": "<key of the entity above>" }
```

Adds an entity as it signs up, so its first request already asks as it. Idempotent by key: `201` with
`{ "key", "name", "dimension", "parent", "created": true }` when it adds one, `200` with `"created": false` when it is
there already (a different `name` renames it). The key's environment knows it at once; the others within about a
second. Only a backend service's key with scope `all`. See
[Entities the server doesn't know yet](/reading/context#entities-the-server-doesnt-know-yet).

| Status | When |
|---|---|
| `201`, `200` | added, or there already |
| `400` | the body isn't a JSON object |
| `401` | no key, or an unknown or revoked one |
| `403` | a key with another scope, an app service's key, or a backend's key from a browser |
| `404` | no such dimension |
| `409` | the entity is there under another parent (move it in the console), or its key is in another dimension |
| `422` | the key isn't lowercase letters, digits and dashes; the parent isn't there or isn't in the dimension above |

### An entity's app link

```http
GET /sdk/v1/links/<dimension>/<entity>?service=<key>
```

```json
{
  "environment": "prod",
  "service": "web",
  "entity": "acme",
  "path": "/cdn/v1/flags/prod/web/acme/<secret>",
  "token": "ffl_prod.web.acme.<secret>"
}
```

`service` names the app service the link is for. `path` is the
entity's CDN file, only when the `cdnFiles()` plugin runs. `token` is made from the same link, with a secret of its
own for this service: an app's signed credential for OFREP (below). Both are for the key's environment.
`Cache-Control: no-store`.

| Status | When |
|---|---|
| `400` | no `?service=`: `{"error":"name the service the link is for: ?service=<key>, e.g. ?service=web"}` |
| `401` | no key, or an unknown or revoked one |
| `403` | the entity is outside the key's scope (with a key scoped to `entity` or `below`, also one that doesn't exist); an app service's key; a backend's key from a browser |
| `404` | an `all` key: no such dimension or entity; any key: no such service, or the service is a backend |

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
- The rest is what the device or request knows about itself, nested (`{"app": {"version": "6.0.0"}}` is
  `app.version`). An attribute written dotted (`{"app.version": …}`), a key that looks like a misspelled dimension,
  and `entity` are `400 INVALID_CONTEXT`. `targetingKey` is the device or user a % of devices is decided for, unless
  the context has `device.id`; never the entity. What it says about the service or environment is ignored.

**Answers:**

- One flag: `{ "key", "reason", "variant", "value", "metadata" }`. `metadata` has `revision` (the publish that
  answered), `entity` (the entity that asked, left out for none), `ruleKey` (the rule that decided, for a backend
  service's key only) and `group` (a % rule's group name, when it has one). `Cache-Control: no-store`.
- Every flag: `{ "flags": [ … ], "metadata": { "environment": "prod", "revision": 42, "entity": "acme" } }`, one
  answer per flag in the service, with a weak `ETag` and `Cache-Control: private, no-cache`. `If-None-Match` with the
  ETag → `304` while nothing changed for this context. The ETag leaves the revision out.
- A flag that uses the app's code default answers with a `reason` and no `value`, so the provider returns the default
  in the app's code.
- An error for a flag or a request is `{ "key", "errorCode", "errorDetails" }` (`key` only for one flag).

| Status | When |
|---|---|
| `200` | the answer |
| `304` | every flag: nothing changed since that ETag |
| `400` | `PARSE_ERROR`: the body isn't JSON; `INVALID_CONTEXT`: no `context`, an entity that doesn't exist (with an `all` key), or one not under the entity named above it; for one flag, `GENERAL` when it can't be evaluated |
| `401` | `{"error":"unknown or replaced app link"}` for a wrong token, `{"error":"unknown, expired or revoked API key"}` for a wrong key, `{"error":"missing API key (Authorization: Bearer <key>)"}` without one |
| `403` | `GENERAL`: the entity is outside the credential's scope. An app token, or a key scoped to `entity` or `below`, gets this same answer for an entity that doesn't exist. `{"error":"a backend’s key can’t be used from a browser: …"}` for a backend's key with an `Origin` header |
| `404` | one flag: `FLAG_NOT_FOUND`, the flag doesn't exist or isn't in this service. A backend's key is told which; an app's key gets one answer for both |

**Change events.** The answer for every flag also has `eventStreams`: one server-sent events stream for its service
and entity, `GET /ofrep/v1/events/<env>/<service>/<entity>/<signature>` (without `<entity>` for no entity). It sends
`{"type":"refetchEvaluation","etag":"<revision>"}` after a publish that may change those answers (and a comment every
25 seconds to keep the connection open); the provider then asks for its flags again. A change to one entity's own
settings reaches that entity and those under it; one to everyone's settings, a flag's variants or its services reaches
every entity of those services; a new entity reaches nobody. A publish that changes nothing the server can compare
(a replaced app link, a flag's description) reaches every stream in the environment. The signature is made with the
environment's secret, so only someone given it in an answer can listen, and an event says only that answers may have
changed. A wrong signature is a `404`. `GET /ofrep/v1/events/<env>/<signature>`, from answers before streams had a
scope, still works and hears every publish in the environment.

**CORS** is open on `/ofrep/*`: any origin may `POST` with `Authorization`, `Content-Type`, `If-None-Match` and
`X-API-Key`, and read `ETag`, with an app service's key or an app token. A backend's key is refused from a browser.
See [Security model](/guide/security#api-keys).

## Health

| Endpoint | Answer |
|---|---|
| `GET /healthz` | `200 {"ok":true,"version":"0.9.0"}` while the process runs |
| `GET /readyz` | `200` while the database answers and every environment publishes; `503` when the database doesn't answer, or a new snapshot can't be built in some environment (it keeps serving the one before) |

`/readyz` says, per environment, the version in the database (`revision`), the one this process serves
(`serving`), how long the oldest publish still waiting has waited (`lagSeconds`) and whether publishing fails:

```json
{ "ok": true, "version": "0.9.0", "environments": { "prod": { "revision": 42, "serving": 42, "lagSeconds": 0, "failing": false } } }
```

A failing one answers `503` with `"ok": false`, `"code": "unavailable"` and the environments that fail in `error`;
the server's log says why. See [Production](/self-hosting/production#health-checks).

## The stable API (`/api/v1`)

For scripts, CI and other systems. **What is here is stable**: within `/api/v1` an address, a field or an error
code is never removed or renamed, and a change that would break a caller comes as `/api/v2`. New fields and new
endpoints may be added. Everything else under `/api` is the console's own (below) and may change in any release.

Send an [access token](/guide/security#access-tokens): `Authorization: Bearer cfp_…`. It acts as its person, with
their role: viewers read, editors and above change flags, and where an environment needs approvals a change is a
request for review, as in the console. Every change is in History. The signed-in console's session works too (with
`X-Requested-With: companyflags` on changes).

The same rules hold throughout:

- **Errors** are `{ "error", "code" }` with the codes [above](#errors).
- **Lists** take `?limit=` (1 to 200, default 50) and `?cursor=`, and answer `{ "items": [ … ], "next": "…" }`.
  Send `next` back as `?cursor=` for the next page; it is `null` on the last one. A cursor is opaque: don't build
  one.
- **The environment** is in the address. Nothing picks one for you.
- **A service** is called a service, and its kind is `app` or `backend`.

| Endpoint | What it does |
|---|---|
| `GET /api/v1/environments` | The environments: `{ key, name, approvals }` (how many approvals a change needs there) |
| `GET /api/v1/services` | The services: `{ key, kind }` |
| `GET /api/v1/environments/<env>/flags` | The flags there, by key, without archived ones. `?q=`: part of a key or name, or a tag |
| `GET /api/v1/environments/<env>/flags/<key>` | One flag there, with its `variants` and its defaults (`layer`, with its `version`) |
| `PUT /api/v1/environments/<env>/flags/<key>/enabled` | On or off there: `{ "enabled": false, "reason": "…" }` |
| `POST /api/v1/environments/<env>/publish` | Several changes there in one version: `{ "items": [ … ], "reason": "…" }` |
| `GET /api/v1/history` | History, newest first. `?environment=`, `?flag=`, `?entity=`, `?by=`, `?type=`, `?from=`, `?to=` narrow it |
| `GET /api/v1/dimensions/<dimension>/entities` | A dimension's entities: `{ key, name, parent }` |
| `PUT /api/v1/dimensions/<dimension>/entities/<key>` | Adds the entity (`201`), or changes its name or parent (`200`): `{ "name": "Acme Corp", "parent": null }` |

A flag in a list is `{ key, name, description, kind, valueType, tags, owner, removeBy, enabled, services }`, where
`enabled` and `services` are for that environment.

**A change** (on or off, or a publish) answers `200 { "applied": true, "revision": 43 }` when it went live, or
`202 { "applied": false, "request": 17 }` when it waits for review (the environment needs approvals); then
`reason` is required and goes to the reviewers. An On call person's break-glass is in the console only.

**A publish's items** are `{ "flag", "entity", "version", "layer" }`: `entity` is `null` for the flag's defaults
or an entity's key for its own settings, `layer` is the layer as `GET …/flags/<key>` answers it (changed), and
`version` the version it had when you read it (`null` for an entity that has no settings yet). A `layer` of `null`
removes an entity's own settings. Someone else's change in between is `409 conflict`: read it again.

**A History entry** is `{ id, environment, revision, changedAt, changedBy, actor, changeType, flag, entity, before,
after, comment, request }`. `before` and `after` are the change as it was recorded.

```bash
curl -s https://flags.example.com/api/v1/environments/prod/flags?limit=100 -H "Authorization: Bearer $COMPANYFLAGS_TOKEN"
curl -s -X PUT https://flags.example.com/api/v1/environments/dev/flags/new_checkout/enabled \
  -H "Authorization: Bearer $COMPANYFLAGS_TOKEN" -H 'Content-Type: application/json' -d '{"enabled": true}'
```

## The console's API

The console talks to the server under `/api`: `/api/auth/*` is the sign-in (Better Auth), `/api/v1` is the
stable API (above), and the rest is the console's own API. **The console's own API isn't stable**: its addresses and
answers may change in any release, so a script uses `/api/v1` where it can. It keeps the same error shape and codes,
says "service" too, and never picks an environment: a request about one environment names it (`?environment=prod`,
or in the address), or gets `400 bad_request`. The flags-as-code endpoints the CLI calls (`/api/flags-as-code`)
and the alert endpoint (`POST /api/alerts/kill`, [Alerts](/guide/ai)) are the console's own too, and are kept in step
with the CLI and the docs.

Some of it needs no session: the sign-in (`/api/auth/*` and `GET /api/sign-in`), the console's
[appearance](/self-hosting/appearance) (`GET /api/appearance` and its images), and these two.

- `GET /api/setup/<secret>` is the [setup link](/self-hosting/sign-in#the-first-account) a new server prints. It
  keeps the secret in a cookie and redirects to the console. A wrong secret, or a server that has accounts, gets
  `404`. A script can send the secret in an `X-Setup` header with its sign-up request instead.
- `POST /api/invites` with `{"token": "…"}` says who an invite link is for. The token goes in the body, so it stays
  out of access logs.

Admins add, change and delete services at `/api/services` (`POST`, then `PUT` and `DELETE /api/services/<key>`),
with `{ "key": "web", "kind": "client" }`: the kind is `client` for an App and `server` for a Backend. Keys are made
at `POST /api/api-keys` with `{ "environment", "service", "scope", "entity" }`.

Scripts, the CLI and MCP clients send an [access token](/guide/security#access-tokens) instead of the cookie:
`Authorization: Bearer cfp_…`. A token needs no `X-Requested-With` header, and is refused from a browser (`403` with
an `Origin` header). `401` means it is unknown, expired or revoked. Tokens are listed at `GET /api/tokens` (an admin
adds `?all=1` for everyone's), made at `POST /api/tokens` with `{ "name": "CI", "role": "editor", "agent": false,
"days": 90 }` (or `"alertsOnly": true` for an alert tool's token) and revoked at `DELETE /api/tokens/<id>`, all from
the signed-in console only. A token is On call at most, and gets `403` on people (`/api/people…`), single sign-on
(`/api/sso…`), the sign-in rules (`/api/sign-in-rules`), the appearance, and lowering an environment's
`minApprovals`: a person does those, signed in. A request an agent made says so in `/api/change-sets`
(`"byAgent": true`).

The rest needs a signed-in session (the cookie). Every change (any method but `GET`, `HEAD` and `OPTIONS`) also
needs the header `X-Requested-With: companyflags`, and a body, when it sends one, must be a JSON object
(`400 bad_json` otherwise). A request without the header, or one the browser
marks `Sec-Fetch-Site: cross-site`, gets `403`. See [Security model](/guide/security#changes-from-the-console).
