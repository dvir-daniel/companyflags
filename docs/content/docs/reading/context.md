---
title: "Evaluation context"
description: "Who is asking, what the request knows about itself, and what comes back. The same for every way of reading."
---

## Who is asking

Each request carries a credential in `Authorization: Bearer …` (or OFREP's `X-API-Key` header). Every key is for one
[service](/guide/services) in one environment, and reads only that service's flags:

- **An app** sends its **app service's key** (console: **Developers → API Keys**), such as `ff_prod_web_…`. It is public: it goes
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

- **Nest attributes.** `{"app": {"version": "6.0.0"}}` is the attribute `app.version`. Written dotted,
  `{"app.version": "6.0.0"}`, it is `400 INVALID_CONTEXT` over OFREP. flagd JSON (backends and CDN files) reads only
  nested attributes and would quietly miss a dotted one, so OFREP refuses it: an attribute reads the same everywhere.
- **`targetingKey` is the device or user being decided for:** the ID a % of devices is decided by (`device.id`),
  unless the context has `device.id`. It is never the entity: the entity is always named by its dimension (below).
  Use an ID kept for the install, or the signed-in user's ID, and send the same one from the app and from your backend
  for the same person, so both put them in the same group.
- `geo.country` isn't known to the server per request behind a CDN: set it in the context if your rules use it.

## Which entity asks

Name the entity in the context by its dimension key. The server fills in the levels above it:

```json
{ "context": { "targetingKey": "d-1", "brand": "lumen", "app": { "version": "6.0.0" } } }
```

- **Which entity asks.** If the context names several dimensions (`"company": "globex", "brand": "lumen"`), the
  lowest asks, and the others must be the ones above it. One that isn't under the one named above it is
  `400 INVALID_CONTEXT`. An entity outside the key's scope and one that doesn't exist get the same
  `400 INVALID_CONTEXT`, with the same words, so a key can't tell which entities exist. (A `401` or `403` stops
  OpenFeature's web provider for good, so those are for a wrong key only.)
- **The key as text or a number.** `{ "brand": 12 }` is the entity `12`, the same as `{ "brand": "12" }`, here and
  in the backends' flagd JSON.
- **Naming none.** A key for one entity (or `below` one) asks as its own entity. An `all` key asks as no entity: what
  every device gets before sign-in. Leave the dimension out to name none: one that is there but empty
  (`{ "company": "" }`, `{ "company": null }`), or isn't text or a number, is `400 INVALID_CONTEXT`. A missing join
  would otherwise ask as no entity, and overrides for an entity ("Company is Globex → off") match no entity too.
- **A dimension written another way.** A key that is a dimension in another case, plural or with separators
  (`"Company"`, `"COMPANY"`, `"companies"`, `"company_"`), or `"entity"`, is `400 INVALID_CONTEXT`, naming the
  dimensions: `"companies" isn’t a dimension: name the entity by its dimension: "company", "brand"`. Without that,
  the request would quietly ask as no entity. The answer names dimensions only, never an entity. Every other key
  nothing reads is left alone, even one that looks like a dimension: `email`, `plan`, `state` next to a `store`
  dimension, `branch` next to `brand`, `company_id`, or a misspelling such as `compnay`. Check the spelling of your
  dimensions: a misspelled one asks as no entity.

### When the server refuses a context

A refused context leaves the app where it was. OpenFeature's web provider reports the error (a provider `Error`
event; `Stale` after a change event) and **keeps the values it had for the previous context**: after a sign-in that
names an entity it can't ask about, the app goes on showing what it showed before sign-in, or for the entity signed
in before. It asks again at the next change of context, the next change event of its old stream, or its next poll.
A server provider (one flag per request) returns the default in your code for that request.

So name only entities the server knows: add one from your backend before the app asks as it (below), and handle the
provider's `Error` event if a wrong entity must not keep the old values:

```ts
import { OpenFeature, ProviderEvents } from '@openfeature/web-sdk';

OpenFeature.addHandler(ProviderEvents.Error, ({ message }) => {
  // the context was refused: say so, or sign the user out, or set the context again once the entity is added
  console.warn('flags: context refused', message);
});
```
- **The rest of the context** is what the request knows about itself, nested (`{"app": {"version": "6.0.0"}}`).
  `targetingKey` is the device or user a % of devices is decided for, unless the context has `device.id`. Anything it
  says about the service or the environment is ignored: those come from the key.

## Entities the server doesn't know yet

An entity that signed up a minute ago isn't in CompanyFlags yet, so a request naming it gets `400 INVALID_CONTEXT`
and the code's defaults. Add it from your backend as it signs up, with a backend service's key for every entity
(scope `all`):

```http
PUT /sdk/v1/entities/<dimension>/<entity>
Authorization: Bearer ff_prod_api_…
Content-Type: application/json

{ "name": "Stark Industries" }
```

```json
{ "key": "stark", "name": "Stark Industries", "dimension": "company", "parent": null, "created": true }
```

- **Idempotent, by key.** `201` when it adds the entity, `200` when it is there already: the same request again
  changes nothing. A different `name` renames it. Leave `name` out and a new entity is named by its key.
- **`parent`** is the key of the entity above it, in the dimension above (leave it out for the top dimension). A new
  entity follows its parent's settings, or everyone's, until it has its own. An entity that is there already keeps its
  parent: a different one is `409`, because moving an entity changes what it gets. Move it in the console.
- **At once.** The key's environment answers for the new entity as soon as the answer comes back; the other
  environments, and other servers on the same database, within about a second. Before that, an OFREP request (or an
  app token) naming it on another server is not refused: a server looks in the database for an entity it doesn't
  know before it refuses it. The backends' flagd JSON has it at its next poll; until then it gives the code's
  defaults there.
- Entity keys are unique across every dimension: a key in another dimension is `409`. A key that isn't lowercase
  letters, digits and dashes is `422`, a parent that isn't there `422`, a dimension that isn't there `404`.
- `403` for a key with any other scope, an app service's key, or a request from a browser. History shows the key that
  added it (its prefix).

The same works by hand in the console, and with `POST /api/dimensions/<dimension>` (see the
[HTTP API reference](/reference/http-api)).

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
  `https://flags.example.com/cdn/v1/flags/prod/ios/lumen/…`. `path` is there only when the
  [CDN Files](/integrations/cdn-files) integration is on.
- For OFREP, the app's provider sends `Authorization: Bearer <token>`. The token asks as that entity only.
- The answer has `Cache-Control: no-store`: both are secrets. See [Security model](/reference/security#app-tokens).
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
| The flag isn't in this service, or there is no such flag | `FLAG_NOT_FOUND` (404 for one flag; left out of the bulk answer) |
| A chain that doesn't match | `400 INVALID_CONTEXT` |
| An entity outside the credential's reach, or one that doesn't exist: the same answer for both | `400 INVALID_CONTEXT` |
| A dimension written another way, `entity`, or an attribute written dotted | `400 INVALID_CONTEXT`, saying which |
| A dimension that is `""` or `null` | `400 INVALID_CONTEXT` |
| A backend's key sent from a browser (with an `Origin` header) | `403` |
| No credential, or a wrong or replaced one | `401` |

### What each answer says about itself

Each answer's `metadata` (OpenFeature's `flagMetadata`) says where it came from, so a value that looks wrong can be
traced:

| Key | For | What it is |
|---|---|---|
| `revision` | every credential | The publish that answered: the environment's revision, as History shows it |
| `entity` | every credential | The entity that asked; left out when the request asked as no entity |
| `ruleKey` | a backend service's key only | The key of the rule that decided; left out when a default decided |
| `group` | every credential | The % group's name, when a % rule with named groups decided |

```ts
const d = await client.getNumberDetails('max_upload_mb', 100, { company: 'acme', targetingKey: userId });
d.flagMetadata;   // { revision: 42, entity: 'acme', ruleKey: '7c1e…' }
```

An app's key never gets `ruleKey`: the rules are for backends. The bulk answer's `ETag` leaves `revision` out, so a
publish that changes nothing for this context is still a `304`, and the provider keeps the answer it has, with the
revision it came with.

**`FLAG_NOT_FOUND` in words.** For a backend service's key, `errorDetails` says which: `the flag "theme" isn’t sent
to service "api": add the service on the flag’s Settings tab`, or `no flag "thme" in environment "prod"`. An app's
key may see its own service's flags only, so it gets one answer for both: `no flag "thme" in service "web": check its
key, and that the flag is sent to this service`.

The answers are the server's own evaluator's, the same as the flag's **Debug** tab in the console and the backends'
flagd JSON. The server's tests check this with OpenFeature's own web and server OFREP providers
([test/ofrep.test.ts](https://github.com/dvir-daniel/companyflags/blob/main/test/ofrep.test.ts)).
