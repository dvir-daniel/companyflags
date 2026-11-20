---
title: "Local evaluation in backends"
description: "A backend downloads its entity’s rules as flagd JSON and evaluates them in memory, with OpenFeature’s flagd provider."
---

A backend that evaluates many flags per second downloads one entity's flags as [flagd](https://flagd.dev) JSON and
evaluates them itself, in-process, with OpenFeature's flagd provider: no request per evaluation. It uses its
backend service's secret key: see [Create a service and an API key](/reading/remote-backends#create-a-service-and-an-api-key).

## Get the flagd JSON

flagd JSON is the `flagd()` plugin. It runs unless your config file lists plugins without it. See [Plugins](/reference/plugins).

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
evaluator. A % of devices is flagd's `fractional`, with the same hash as the server and the CDN files, so a device
is in the same group everywhere.

flagd has changed its `fractional` hash before. Pin the flagd version you run, and treat an upgrade that changes
`fractional` as a migration: devices may move between groups.

### What differs from the server

- **Reasons are coarser.** flagd says `TARGETING_MATCH` for any rule (a % too, not `SPLIT`), `DEFAULT` when no rule
  applies, and `STATIC` for a flag with no rules.
- **No group names.** A % rule's group names have nowhere to go in flagd's answer.
- **Unreadable values in an override.** A value that is there but can't be read, such as the version `abc`, matches
  an override on the server and not in flagd. Write versions in full: `6.0.0`.
