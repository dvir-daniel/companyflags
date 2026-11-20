---
title: "Local evaluation in backends"
description: "A backend downloads its entity’s rules as flagd JSON and evaluates them in memory, with OpenFeature’s flagd provider."
---

A backend that evaluates many flags per second downloads its flags as [flagd](https://flagd.dev) JSON, for one
entity or for every entity it serves, and evaluates them itself, in-process, with OpenFeature's flagd provider: no request per evaluation. It uses its
backend service's secret key: see [Create a service and an API key](/reading/remote-backends#create-a-service-and-an-api-key).

## Get the flagd JSON

flagd JSON is the `flagd()` plugin. It runs unless your config file lists plugins without it. See [Plugins](/reference/plugins).

```http
GET /sdk/v1/flagd/<dimension>/<entity>
Authorization: Bearer ff_prod_api_…
```

The entity is named in the path by its dimension, as rules name it: `/sdk/v1/flagd/company/acme`,
`/sdk/v1/flagd/brand/lumen`. A key scoped to one entity (or `below` one, asking about its own) may leave the path off:
`GET /sdk/v1/flagd`. A backend shared by many entities reads them all in one document instead:
`GET /sdk/v1/flagd/service` (see [One flagd for many entities](#one-flagd-for-many-entities)).

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
        { "and": [
          { "!": { "in": [ { "var": "app.version" }, [null, ""] ] } },
          { "sem_ver": [ { "var": "app.version" }, ">=", "6.0.0" ] }
        ] },
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

A value that is absent, `null` or `""` is missing, as on the server: the JSON checks `{"in": [{"var": …}, [null, ""]]}`
rather than JsonLogic's `missing`, which flagd's languages read differently. Versions in rules are always written in
full (`6.0.0`), so strict semver readers take them.

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

### How soon a change arrives

flagd's `http` source polls: there is no change stream for it. A backend sees a publish within `interval` seconds,
plus about a second for the publish itself. Each poll is one small request the server answers from memory, usually a
`304`, so the cost is how many flagd sources poll how often: 200 backends at `interval: 10` are 20 requests a second.

- `30` (seconds) is a good default. Go down to `5` for flags that must change fast, such as kill switches.
- Below a few seconds buys little: the publish itself takes about a second to reach every server.
- If the server can't be reached, flagd keeps the last document it got and keeps answering from it.

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

A backend shared by many entities reads **one document for its service**, with every entity it may ask about in it,
with an `all` key (or a `below` key: its entity and those under it):

```http
GET /sdk/v1/flagd/service
Authorization: Bearer ff_prod_api_…
```

Its `flagSetId` is `<environment>/<service>`, such as `prod/api`. Give flagd that one source, and make one flagd
provider. Each request names its entity by its dimension key in the evaluation context, as the rules name it, and the
document picks that entity's rules:

```bash
flagd start --sources='[{
  "uri": "https://flags.example.com/sdk/v1/flagd/service",
  "provider": "http",
  "authHeader": "Bearer ff_prod_api_…",
  "interval": 30
}]'
```

```ts
await OpenFeature.setProviderAndWait(new FlagdProvider({ resolverType: 'in-process', host: 'localhost', port: 8015 }));

const client = OpenFeature.getClient();
const on = await client.getBooleanValue('new_checkout', false, { company: 'acme', app: { version: '6.0.0' } });
const forLumen = await client.getBooleanValue('new_checkout', false, { brand: 'lumen', device: { id: 'd-5' } });
```

Each flag's targeting starts with one branch per group of entities that get the same answer, the lowest dimension
first, then what a request naming no entity gets:

```json
{ "if": [
  { "in": [ { "var": "brand" }, ["bolt", "lumen"] ] }, "on",
  { "in": [ { "var": "company" }, ["acme"] ] }, { "if": [ <Acme's rules>, … ] },
  "off"
] }
```

- **Naming the entity.** The lowest dimension the context names decides, as over OFREP. Naming the ones above it
  too (`{ "company": "globex", "brand": "lumen" }`) is fine.
- **Naming none.** With an `all` key, what no entity gets (before sign-in). With a `below` key, what its own entity
  gets.
- **An entity the document doesn't have yet** (one that signed up since the last poll): flagd can't refuse the
  request as OFREP does. It gets what the next entity up that the context names gets (its company, for a new brand),
  and with none, what no entity gets. Add entities as they sign up (see
  [Entities the server doesn't know yet](/reading/context#entities-the-server-doesnt-know-yet)); the next poll brings
  them.
- **Size.** The document holds every entity the key may ask about. Entities that get the same answer for a flag
  share one branch, and those that get what everyone gets have none, so it grows with the entities that have their
  own settings, or are named in rules.

**One document per entity** still works: `GET /sdk/v1/flagd/<dimension>/<entity>`, each with its own `flagSetId`,
`<environment>/<service>/<entity>`. Use it when a backend serves one entity, or when one entity's rules must stay
apart from the others'. For several, give flagd one source per entity, and make one flagd provider per entity under
an OpenFeature domain named after it, with flagd's selector for its flag set:

```ts
for (const entity of ['acme', 'globex']) {
  OpenFeature.setProvider(entity, new FlagdProvider({
    resolverType: 'in-process', host: 'localhost', port: 8015, selector: `flagSetId=prod/api/${entity}`,
  }));
}

const on = await OpenFeature.getClient('acme').getBooleanValue('new_checkout', false, { app: { version: '6.0.0' } });
```

Check that the flagd version you run supports selecting by `flagSetId`. There is no header that picks the entity per
request: the context, or the provider, does.

### The evaluation context

The request's attributes are **nested**, as JsonLogic reads `app.version`:

```json
{ "app": { "version": "6.0.0" }, "device": { "id": "d-5" } }
```

See [Attributes](/reference/attributes) for the names. A dotted key (`{"app.version": …}`) isn't read: flagd
looks for `app`, then `version` in it. OFREP refuses one, so a mistake shows up there.

- The device ID for a % of devices is `device.id`, or OpenFeature's `targetingKey` when there's no `device.id`, as
  over OFREP: the device or user the request is for, never the entity. Then the rule's backup ID (`session.id`), if it
  has one.
- Send versions in full, as text: `6.0.0`, not `6.0` or `6`. flagd's JavaScript evaluator reads short ones as the
  server does, but strict semver readers in other languages may not, and then no check on the version matches.

### The same answers as the server

The test suite evaluates the flagd JSON with OpenFeature's own flagd evaluator (`@openfeature/flagd-core`, what
flagd's JavaScript providers run) and with a reference written from flagd's documented behaviour, for random flags,
every entity at every level, one document per entity and one for the whole service, and many requests (with and without `device.id` and `targetingKey`, versions short and
long), and compares each answer with the server's own evaluator. A % of devices is flagd's `fractional`, with the same hash as the server and the CDN files, so a device
is in the same group everywhere.

flagd has changed its `fractional` hash before. Pin the flagd version you run, and treat an upgrade that changes
`fractional` as a migration: devices may move between groups.

### What differs from the server

- **Reasons are coarser.** flagd says `TARGETING_MATCH` for any rule (a % too, not `SPLIT`), `DEFAULT` when no rule
  applies, and `STATIC` for a flag with no rules.
- **No group names.** A % rule's group names have nowhere to go in flagd's answer.
- **Unreadable values in an override.** A value that is there but can't be read, such as the version `abc`, matches
  an override on the server and not in flagd.
- **A few version spellings.** The server reads `6.1-beta` and `01.0.0` (as 6.1.0-beta and 1.0.0); flagd can't, so no
  check on them matches there, an override's included. flagd reads a number (`6`) and a capital `V` (`V6.0.0`); the
  server doesn't, so to it they are unreadable. Full versions, as text, read the same everywhere: `6.0.0`.
