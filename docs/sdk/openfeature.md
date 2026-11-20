# OpenFeature

CompanyFlags has no SDK of its own. Apps and backends use [OpenFeature](https://openfeature.dev), the open standard
API for feature flags, with OpenFeature's own providers:

| Who | Provider | What CompanyFlags serves |
|---|---|---|
| Web apps, React | `@openfeature/ofrep-web-provider` | OFREP: every flag for the app's context, in one request |
| Android, iOS | OpenFeature's OFREP providers for Kotlin and Swift | OFREP, the same way |
| Backends (Node, Go, Java, Python, .NET…) | OpenFeature's OFREP provider, or the flagd provider | OFREP per request, or [flagd JSON](/guide/backends) evaluated in-process |

[OFREP](https://github.com/open-feature/protocol) is OpenFeature's remote evaluation protocol. The server implements
version 0.4: `POST /ofrep/v1/evaluate/flags` (every flag, for client providers) and
`POST /ofrep/v1/evaluate/flags/{key}` (one flag, for server providers).

OFREP is the `ofrep()` plugin. It runs unless your config file lists plugins without it. See
[Plugins](/reference/plugins).

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

## Web apps

```bash
npm install @openfeature/web-sdk @openfeature/ofrep-web-provider
```

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' } });
await OpenFeature.setProviderAndWait(new OFREPWebProvider({
  baseUrl: 'https://flags.example.com',
  headers: [['Authorization', 'Bearer ff_prod_web_…']],   // the web service's key: public
  pollInterval: 60_000,
}));

const client = OpenFeature.getClient();
client.getBooleanValue('new_checkout', false);
client.getObjectDetails('theme', { accent: '#000', radius: 0 });   // value, reason, variant, flagMetadata.group
```

The provider asks for every flag once and keeps the answers. The answer also lists a stream of change events
(server-sent events): the provider listens to it, and when a publish changes the environment it asks again, with the
last answer's `ETag` (a `304` when nothing changed for this app). So changes reach devices within a second or two.
If the stream can't stay open, it polls every `pollInterval` instead. Changing the context (`OpenFeature.setContext`)
asks again. When answers change it emits `ConfigurationChanged`.

Before sign-in, leave the entity out of the context: a key that asks about any entity then gets what everyone gets.
Once someone signs in, add their entity to the context, and the provider asks again:
`OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' }, company: 'acme' })`. If the app must
not be able to claim another entity, use a signed app link's token instead of the key.

### React

```bash
npm install @openfeature/react-sdk @openfeature/ofrep-web-provider
```

```tsx
import { OpenFeature, OpenFeatureProvider, useBooleanFlagValue } from '@openfeature/react-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' } });
OpenFeature.setProvider(new OFREPWebProvider({
  baseUrl: 'https://flags.example.com',
  headers: [['Authorization', 'Bearer ff_prod_web_…']],
}));

export function App() {
  return <OpenFeatureProvider><Checkout /></OpenFeatureProvider>;
}

function Checkout() {
  return useBooleanFlagValue('new_checkout', false) ? <NewCheckout /> : <OldCheckout />;
}
```

## Android and iOS

Use OpenFeature's Kotlin or Swift SDK with its OFREP provider (find them on the
[OpenFeature ecosystem page](https://openfeature.dev/ecosystem)). Configure it the same way: the base URL of
CompanyFlags, and the `Authorization: Bearer <key>` header with the `android` or `ios` service's key (or the token
your backend gave the app).

## Backends

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
const limit = await client.getNumberValue('max_upload_mb', 100, { company: 'acme', targetingKey: userId });
```

`FLAGS_API_KEY` is the backend service's key. Keep it on the server. Each evaluation is one request. For many
evaluations per second, use [flagd](/guide/backends): it downloads the entity's rules and answers in memory.

## What comes back

| CompanyFlags | OFREP answer |
|---|---|
| A rule decided | `reason: TARGETING_MATCH`, the value and its variant |
| A % of devices decided | `reason: SPLIT`; the % group's name, when it has one, in `metadata.group` |
| The flag's default | `reason: DEFAULT` or `STATIC` |
| The flag is off | `reason: DISABLED`, no value: the app's own default |
| The flag uses the code default | no value: the provider returns the default written in your app |
| The flag isn't in this service | `FLAG_NOT_FOUND` (404 for one flag; left out of the bulk answer) |
| A chain that doesn't match, or an entity that doesn't exist (with an `all` key) | `400 INVALID_CONTEXT` |
| An entity outside the credential's reach, or one that doesn't exist (an app token, or a key for some entities) | `403` |
| A backend's key sent from a browser (with an `Origin` header) | `403` |
| No credential, or a wrong or replaced one | `401` |

The answers are the server's own evaluator's, the same as the flag's **Debug** tab in the console and the backends'
flagd JSON. The server's tests check this with OpenFeature's own web and server OFREP providers
([test/ofrep.test.ts](https://github.com/dvir-daniel/companyflags/blob/main/test/ofrep.test.ts)).

## Cost

OFREP answers come from the server, one request per context and refresh, not from the CDN's cache: the server
evaluates every flag for the request in memory (microseconds per flag). For very large fleets, the
[app file](/sdk/app-file) is the CDN-cached alternative: one file per entity, read on the device by code of your own.
