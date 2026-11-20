# Backends

A backend gets its flags with its backend service's key, for the entity it is serving at the moment. It has two ways
to evaluate them:

- **flagd.** It downloads one entity's flags as [flagd](https://flagd.dev) JSON and evaluates them itself, in-process,
  with OpenFeature's flagd provider. No request per evaluation.
- **OFREP.** It asks the server for each evaluation with one of OpenFeature's OFREP providers (OpenFeature Remote
  Evaluation Protocol). No flagd to run, one request per evaluation (or per bulk evaluation).

A backend can also hand each signed-in user's app a signed link and token for their entity (see
[below](#hand-links-to-apps)). Its key is secret: it never goes in an app or a web page.

## Create a service and an API key

1. **Settings → Services → + Add service** (admins): a key such as `api`, and the kind **Backend**. Then put
   flags in it, on each flag's **Settings** tab (see [Services](/guide/services)).
2. **API keys → + New key** (admins): the environment, the service, what it **asks about**, and a label.

| Scope | Asks about |
|---|---|
| `entity` | one entity only, e.g. Acme (`acme`) |
| `below` | one entity and every entity under it, e.g. Globex and its brands Lumen and Bolt |
| `all` | any entity, for a backend shared by all of them |

The key is shown once. It looks like `ff_prod_api_…`: one environment, one service. Send it as
`Authorization: Bearer <key>`. A request about an entity outside the key's scope gets `403`.

A backend service's key is secret. A request that carries one and an `Origin` header, which browsers send, gets
`403`: a backend's key in a web page doesn't work. Apps use their app service's own key, which is public
and reads values only. See [Security model](/guide/security#api-keys).

## flagd JSON

flagd JSON is the `flagd()` plugin, and OFREP (below) the `ofrep()` plugin. Each runs unless your config file lists
plugins without it. See [Plugins](/reference/plugins).

```http
GET /sdk/v1/flagd/<dimension>/<entity>
Authorization: Bearer ff_prod_api_…
```

The entity is named in the path by its dimension, as rules name it: `/sdk/v1/flagd/company/acme`,
`/sdk/v1/flagd/brand/lumen`. A key scoped to one entity (or `below` one, asking about its own) may leave the path off:
`GET /sdk/v1/flagd`.

The answer is the key's service for that entity, as one flagd flag set, with `flagSetId`
`<environment>/<service>/<entity>`:

```json
{
  "$schema": "https://flagd.dev/schema/v0/flags.json",
  "metadata": { "flagSetId": "prod/api/acme", "environment": "prod", "revision": 42 },
  "flags": {
    "new_checkout": {
      "state": "ENABLED",
      "variants": { "on": true, "off": false },
      "defaultVariant": "off",
      "targeting": { "if": [
        { "and": [ { "!": { "missing": ["app.version"] } }, { "sem_ver": [ { "var": "app.version" }, ">=", "6.0.0" ] } ] },
        "on",
        null
      ] }
    }
  }
}
```

The server settles everything it knows for this backend (the environment, the service, the entity and the entities
above it). What depends on the request stays as a flat JsonLogic `if`, one branch per rule, in the order the server
evaluates them. It holds that entity's values only.

- `ETag` and `If-None-Match` → `304`. `Cache-Control: private, no-cache`.
- A flag that isn't in the key's service isn't in the JSON (`FLAG_NOT_FOUND`). A flag switched off is `DISABLED`, and
  "use the code default" is a `null` variant: in both cases the provider returns the default in your code.
- `401` without a key or with an unknown or revoked one, `403` outside the key's scope, `404` for an entity or
  dimension that doesn't exist, `400` for an `all` key with no entity in the path.
- `403` for an app service's key: it reads values only, over OFREP. The rules are for a backend's key. A backend's
  key sent from a browser (with an `Origin` header) gets `403` too.

## Run flagd as a sidecar

Run flagd next to your backend with an `http` source pointing at the entity's address, and the key in `authHeader`:

```bash
flagd start --sources='[{
  "uri": "https://flags.example.com/sdk/v1/flagd/company/acme",
  "provider": "http",
  "authHeader": "Bearer ff_prod_api_…",
  "interval": 30
}]'
```

flagd asks again every `interval` seconds, with the last ETag, and usually gets a `304`.

Then evaluate in-process with OpenFeature's flagd provider, syncing from flagd. In Node.js, with
`@openfeature/server-sdk` and `@openfeature/flagd-provider`:

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { FlagdProvider } from '@openfeature/flagd-provider';

await OpenFeature.setProviderAndWait(new FlagdProvider({ resolverType: 'in-process', host: 'localhost', port: 8015 }));

const client = OpenFeature.getClient();
const on = await client.getBooleanValue('new_checkout', false, {
  app: { version: '6.0.0' },
  device: { id: 'device-5' },
});
```

The flagd provider evaluates in-process in Go, Java, Node.js, .NET, Python and Rust, or asks flagd over RPC.

### One flagd for many entities

A backend shared by many entities can run one flagd with one source per entity, each at its own address
(`/sdk/v1/flagd/company/acme`, `/sdk/v1/flagd/company/globex`, …), using an `all` or `below` key. Pick the entity on
each request with flagd's selector, the `Flagd-Selector` header: `Flagd-Selector: flagSetId=prod/api/acme`.
Check that the flagd version you run supports flag set selectors.

### The evaluation context

The request's attributes are **nested**, as JsonLogic reads `app.version`:

```json
{ "app": { "version": "6.0.0" }, "device": { "id": "d-5" } }
```

See [Attributes](/reference/attributes) for the names.

### The same answers as the server

The test suite evaluates the flagd JSON the way flagd does (a reference written from flagd's documented behaviour) for
random flags, every entity at every level and many requests, and compares each answer with the server's own
evaluator. A % of devices is flagd's `fractional`, with the same hash as the server and the app files, so a device
is in the same group everywhere.

flagd has changed its `fractional` hash before. Pin the flagd version you run, and treat an upgrade that changes
`fractional` as a migration: devices may move between groups.

### What differs from the server

- **Reasons are coarser.** flagd says `TARGETING_MATCH` for any rule (a % too, not `SPLIT`), `DEFAULT` when no rule
  applies, and `STATIC` for a flag with no rules.
- **No group names.** A % rule's group names have nowhere to go in flagd's answer.
- **Unreadable values in an override.** A value that is there but can't be read, such as the version `abc`, matches
  an override on the server and not in flagd. Write versions in full: `6.0.0`.

## OFREP

OpenFeature's OFREP providers ask the server to evaluate. Point the provider at your server's address, e.g.
`https://flags.example.com`, and give it the key as `Authorization: Bearer <key>` (OFREP's `X-API-Key` header works
too).

Name the entity in the evaluation context by its dimension key. The server fills in the levels above it:

```json
{ "context": { "targetingKey": "d-1", "brand": "lumen", "app": { "version": "6.0.0" } } }
```

- **Which entity asks.** If the context names several dimensions (`"company": "globex", "brand": "lumen"`), the
  lowest asks, and the others must be the ones above it. One that isn't under the one named above it is
  `400 INVALID_CONTEXT`. Outside the key's scope, `403`. An entity that doesn't exist is `400 INVALID_CONTEXT` for an
  `all` key, and the same `403` for a key scoped to `entity` or `below`, so it can't tell which entities exist.
- **Naming none.** A key for one entity (or `below` one) asks as its own entity. An `all` key asks as no entity: what
  every device gets before sign-in.
- **The rest of the context** is what the request knows about itself, nested or dotted (`{"app": {"version":
  "6.0.0"}}` or `{"app.version": "6.0.0"}`). `targetingKey` is the device ID a % of devices is decided by, unless the
  context has `device.id`. Anything it says about the service or the environment is ignored: those come from the key.
- **Code defaults.** A flag that uses the code default answers with a reason and no `value`, so the provider returns
  the default in your code.
- **Group names** of a % rule come back in the answer's `metadata.group`.
- The bulk evaluation (every flag in the key's service) answers with a weak `ETag`; asking again with
  `If-None-Match` gets `304` while nothing changed.

The endpoints are in the [HTTP API reference](/reference/http-api#openfeature-remote-evaluation-ofrep). OFREP
requests go to the server on every evaluation: a CDN doesn't cache them.

## Hand links to apps

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
  "path": "/client/v1/flags/prod/ios/lumen/k3J9xW2mQ7vR1tY5uP8sLa",
  "token": "ffl_prod.ios.lumen.Hc4nT8bZ1qW6eY0rS3vJ5d"
}
```

- The link is for the key's environment. `service` is the key of an app service (`web`, `ios`, `android`); a
  backend service has no file. (`?flagSet=` from 0.2 still works until 0.4.)
- For the app file, the app reads `path` from the address apps use, usually the CDN in front of your server:
  `https://flags.example.com/client/v1/flags/prod/ios/lumen/…`. `path` is there only when the `appFiles()` plugin
  runs.
- For OFREP, the app's provider sends `Authorization: Bearer <token>`. The token asks as that entity only.
- The answer has `Cache-Control: no-store`: both are secrets. See [Security model](/guide/security#app-tokens).
- `401` without a valid key, `403` for an entity outside the key's scope or for an app service's key (only a
  backend's key hands out links), `400` without `?service=`, `404` for an entity, dimension or app service that
  doesn't exist.

When an entity's link is replaced, the old link and token stop working; the backend gets the new ones the next time
it asks.
