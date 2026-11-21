---
title: "Remote evaluation in backends"
description: "Backends ask the server for each evaluation with OpenFeature’s OFREP provider and their backend service’s secret key."
---

## Create a service and an API key

1. **Developers → Services → + Add service** (admins): a key such as `api`, and the kind **Backend**. Then put
   flags in it, on each flag's **Settings** tab (see [Services](/guide/services)).
2. **API keys → + New key** (admins): the environment, the service, what it **asks about**, and a label.

| Scope | Asks about |
|---|---|
| `entity` | one entity only, e.g. Acme (`acme`) |
| `below` | one entity and every entity under it, e.g. Globex and its brands Lumen and Bolt |
| `all` | any entity, for a backend shared by all of them |

The key is shown once. It looks like `ff_prod_api_…`: one environment, one service. Send it as
`Authorization: Bearer <key>`. A request about an entity outside the key's scope gets `400 INVALID_CONTEXT`, the
same answer as for an entity that doesn't exist.

A backend service's key is secret. A request that carries one and an `Origin` header, which browsers send, gets
`403`: a backend's key in a web page doesn't work. Apps use their app service's own key, which is public
and reads values only. See [Security model](/reference/security#api-keys).

## Ask with OFREP

```bash
npm install @openfeature/server-sdk @openfeature/ofrep-provider
```

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { OFREPProvider } from '@openfeature/ofrep-provider';

await OpenFeature.setProviderAndWait(new OFREPProvider({
  baseUrl: 'https://flags.example.com',
  headers: [['Authorization', `Bearer ${process.env.FLAGS_API_KEY}`]],
}));

const client = OpenFeature.getClient();
// the entity by its dimension; targetingKey: the device or user this request is for
const limit = await client.getNumberValue('max_upload_mb', 100, { company: 'acme', targetingKey: installId });
```

`FLAGS_API_KEY` is the backend service's key. Keep it on the server. Each evaluation is one request. For many
evaluations per second, use [flagd](/reading/local-backends): it downloads the entity's rules and answers in memory.

## The context

- **The entity** is always named by its dimension key: `{ company: 'acme' }`, `{ brand: 'lumen' }`. Never put it in
  `targetingKey`.
- **`targetingKey`** is the device or user the request is for: the ID a % of devices is decided by. Use the same one
  the app uses, so a person gets the same answer from the app and from your backend. If the app decides by its
  install ID, have the app send that ID with its requests to your backend, and pass it on. If you decide by the
  signed-in user's ID, both send that. A request with no such ID leaves `targetingKey` out: a % rule then doesn't
  apply to it, and it gets the next rule or the default. Never use one fixed ID (such as `"anonymous"`) for every
  request: they would all land in the same group.
- **Nested attributes**, as the rules name them: `{ app: { version: '6.0.0' } }`. Dotted ones are refused.

OpenFeature's OFREP providers ask the server to evaluate. Point the provider at your server's address, e.g.
`https://flags.example.com`, and give it the key as `Authorization: Bearer <key>` (OFREP's `X-API-Key` header works
too).

The server fills in the levels above the entity it names:

```json
{ "context": { "targetingKey": "d-1", "brand": "lumen", "app": { "version": "6.0.0" } } }
```

See [Which entity asks](/reading/context#which-entity-asks). An entity that just signed up isn't known yet: add it
as it signs up, with `PUT /sdk/v1/entities/<dimension>/<entity>` (see
[Entities the server doesn't know yet](/reading/context#entities-the-server-doesnt-know-yet)).

- **Where an answer came from.** Each answer's `flagMetadata` has `revision` (the publish that answered), `entity`
  (who asked) and, for a backend's key, `ruleKey` (the rule that decided). Log them with a value that looks wrong.
- **`FLAG_NOT_FOUND`** says which: the flag isn't in this service, or there is no such flag in the environment.
- **Code defaults.** A flag that uses the code default answers with a reason and no `value`, so the provider returns
  the default in your code.
- **Group names** of a % rule come back in the answer's `metadata.group`.
- The bulk evaluation (every flag in the key's service) answers with a weak `ETag`; asking again with
  `If-None-Match` gets `304` while nothing changed.

The endpoints are in the [HTTP API reference](/reference/http-api#openfeature-remote-evaluation-ofrep). OFREP
requests go to the server on every evaluation: a CDN doesn't cache them.
