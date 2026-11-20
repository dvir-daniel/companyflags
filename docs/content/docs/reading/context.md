---
title: "Evaluation context"
description: "Who is asking, what the request knows about itself, and what comes back. The same for every way of reading."
---

## Who is asking

Each request carries a credential in `Authorization: Bearer …` (or OFREP's `X-API-Key` header). Every key is for one
[service](/guide/services) in one environment, and reads only that service's flags:

- **An app** sends its **app service's key** (console: **API keys**), such as `ff_prod_web_…`. It is public: it goes
  in the app. It reads values only, for the context the app sends. The context can name the signed-in entity by its
  dimension (`{ "company": "acme" }`), within the key's scope. That is targeting, not proof.
- **A backend** sends its **backend service's key**, such as `ff_prod_api_…`. It is secret: a request with a
  backend's key and an `Origin` header (a browser) gets `403`. It names the entity in the evaluation context by its
  dimension, as rules name it: `{ "company": "acme" }`, `{ "brand": "lumen" }`.
- **An app with a signed app link** (optional) sends an **app token** in place of its key:
  `ffl_<environment>.<service>.<entity>.<secret>`. Your backend gets it when someone signs in, with its backend
  service's key: `GET /sdk/v1/links/<dimension>/<entity>?service=<key>` returns
  `{ environment, service, entity, path, token }` (see [Services](/guide/services#signed-app-links)). The console
  shows it too, on the entity's page under **App link**. The token reads that entity, in that service, only, so the
  app can't ask as another. Replacing the link replaces it at once.

A key's scope limits whom it may ask about: its own entity, the ones below it, or any. The server works out
everything else about who is asking: the environment and the service come from the credential, and the levels above
an entity come from its own data. What a request says about them is ignored.

## The evaluation context

The context is what the device or the request knows about itself, by the names rules use (see
[attributes](/reference/attributes)):

```json
{
  "targetingKey": "3f9c…",
  "app": { "version": "6.0.0", "build": 412 },
  "device": { "platform": "web", "os": "macos" },
  "locale": { "language": "es" }
}
```

- Nested objects are read by their dotted names: `app.version`, `device.os`.
- `targetingKey` is the device ID that a % of devices is by (`device.id`), unless the context has `device.id`. Use an
  ID kept for the install, so a device stays in its group.
- `geo.country` isn't known to the server per request behind a CDN: set it in the context if your rules use it.

## Which entity asks

Name the entity in the context by its dimension key. The server fills in the levels above it:

```json
{ "context": { "targetingKey": "d-1", "brand": "lumen", "app": { "version": "6.0.0" } } }
```

- **Which entity asks.** If the context names several dimensions (`"company": "globex", "brand": "lumen"`), the
  lowest asks, and the others must be the ones above it. One that isn't under the one named above it is
  `400 INVALID_CONTEXT`. An entity outside the key's scope and one that doesn't exist get the same
  `400 INVALID_CONTEXT`, with the same words, so a key can't tell which entities exist. The context is wrong, not
  the key: the provider reports an error for that context and works again with the next one. (A `401` or `403`
  stops OpenFeature's web provider for good, so those are for a wrong key only.)
- **Naming none.** A key for one entity (or `below` one) asks as its own entity. An `all` key asks as no entity: what
  every device gets before sign-in.
- **The rest of the context** is what the request knows about itself, nested or dotted (`{"app": {"version":
  "6.0.0"}}` or `{"app.version": "6.0.0"}`). `targetingKey` is the device ID a % of devices is decided by, unless the
  context has `device.id`. Anything it says about the service or the environment is ignored: those come from the key.

## Signed app links

An app reads with its app service's key, and says in the context who is signed in. That is targeting, not proof. When
an app must read as its own entity and no other, it uses a signed **app link** instead: its entity's file at a secret
link, or OpenFeature's OFREP provider with a token made from that link for one service (see
[Services](/guide/services#signed-app-links)). This is optional. Your backend knows which entity a user belongs to, so
it asks for both when the user signs in, naming the app's service, and hands them to the app:

```http
GET /sdk/v1/links/<dimension>/<entity>?service=<key>
Authorization: Bearer ff_prod_api_…
```

```json
{
  "environment": "prod",
  "service": "ios",
  "entity": "lumen",
  "path": "/cdn/v1/flags/prod/ios/lumen/k3J9xW2mQ7vR1tY5uP8sLa",
  "token": "ffl_prod.ios.lumen.Hc4nT8bZ1qW6eY0rS3vJ5d"
}
```

- The link is for the key's environment. `service` is the key of an app service (`web`, `ios`, `android`); a
  backend service has no file.
- For the CDN file, the app reads `path` from the address apps use, usually the CDN in front of your server:
  `https://flags.example.com/cdn/v1/flags/prod/ios/lumen/…`. `path` is there only when the `cdnFiles()` plugin
  runs.
- For OFREP, the app's provider sends `Authorization: Bearer <token>`. The token asks as that entity only.
- The answer has `Cache-Control: no-store`: both are secrets. See [Security model](/guide/security#app-tokens).
- `401` without a valid key, `403` for an entity outside the key's scope or for an app service's key (only a
  backend's key hands out links), `400` without `?service=`, `404` for an entity, dimension or app service that
  doesn't exist.

When an entity's link is replaced, the old link and token stop working; the backend gets the new ones the next time
it asks.

## What comes back

| CompanyFlags | OFREP answer |
|---|---|
| A rule decided | `reason: TARGETING_MATCH`, the value and its variant |
| A % of devices decided | `reason: SPLIT`; the % group's name, when it has one, in `metadata.group` |
| The flag's default | `reason: DEFAULT` or `STATIC` |
| The flag is off | `reason: DISABLED`, no value: the app's own default |
| The flag uses the code default | no value: the provider returns the default written in your app |
| The flag isn't in this service | `FLAG_NOT_FOUND` (404 for one flag; left out of the bulk answer) |
| A chain that doesn't match | `400 INVALID_CONTEXT` |
| An entity outside the credential's reach, or one that doesn't exist: the same answer for both | `400 INVALID_CONTEXT` |
| A backend's key sent from a browser (with an `Origin` header) | `403` |
| No credential, or a wrong or replaced one | `401` |

The answers are the server's own evaluator's, the same as the flag's **Debug** tab in the console and the backends'
flagd JSON. The server's tests check this with OpenFeature's own web and server OFREP providers
([test/ofrep.test.ts](https://github.com/dvir-daniel/companyflags/blob/main/test/ofrep.test.ts)).
