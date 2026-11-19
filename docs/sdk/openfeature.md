# OpenFeature

CompanyFeatures has no SDK of its own. Apps and backends use [OpenFeature](https://openfeature.dev), the open standard
API for feature flags, with OpenFeature's own providers:

| Who | Provider | What CompanyFeatures serves |
|---|---|---|
| Web apps, React | `@openfeature/ofrep-web-provider` | OFREP: every flag for the app's context, in one request |
| Android, iOS | OpenFeature's OFREP providers for Kotlin and Swift | OFREP, the same way |
| Backends (Node, Go, Java, Python, .NET…) | OpenFeature's OFREP provider, or the flagd provider | OFREP per request, or [flagd JSON](/guide/backends) evaluated in-process |

[OFREP](https://github.com/open-feature/protocol) is OpenFeature's remote evaluation protocol. The server implements
version 0.4: `POST /ofrep/v1/evaluate/flags` (every flag, for client providers) and
`POST /ofrep/v1/evaluate/flags/{key}` (one flag, for server providers).

## Who is asking

Each request carries a credential in `Authorization: Bearer …` (or OFREP's `X-API-Key` header):

- **An app** sends its **app token**, made from its entity's app link for that app: `ffl_<environment>.<app>.<entity>.<secret>`. Your backend
  gets it when someone signs in, with its API key: `GET /sdk/v1/links/<dimension>/<entity>?app=<app>` returns
  `{ path, token }` (see [Apps](/guide/apps#give-the-app-its-link-at-sign-in)). The console shows it too, on the entity's
  page under **App link**. The token reads that entity, for that app, only, and replacing the link replaces it at once. Apps never hold
  an API key.
- **A backend** sends its **API key** (console: **API keys**). It names the entity in the evaluation context by its
  dimension, as rules name it: `{ "company": "acme" }`, `{ "brand": "lumen" }`. Its key's scope limits whom it may ask
  about: its own entity, the ones below it, or any.

The server works out everything else about who is asking: the environment and the app come from the credential, and
the levels above an entity come from its own data. What a request says about them is ignored.

## The evaluation context

The context is what the device or the request knows about itself, by the names rules use (see
[attributes](/reference/attributes)):

```json
{
  "targetingKey": "3f9c…",
  "app": { "version": "6.0.0", "build": 412 },
  "device": { "platform": "web", "os": "macos" },
  "locale": { "language": "he" }
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
  headers: [['Authorization', `Bearer ${session.flagsToken}`]],   // the token your backend gave the app
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

Before sign-in, the app has no token: use the code defaults, or have your backend hand out a token for an entity that
stands for everyone you haven't identified yet.

### React

```tsx
import { OpenFeature, OpenFeatureProvider, useBooleanFlagValue } from '@openfeature/react-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

OpenFeature.setProvider(new OFREPWebProvider({
  baseUrl: 'https://flags.example.com',
  headers: [['Authorization', `Bearer ${flagsToken}`]],
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
CompanyFeatures, and the `Authorization: Bearer <token>` header with the token your backend gave the app.

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

Each evaluation is one request. For many evaluations per second, use [flagd](/guide/backends): it downloads the
entity's rules and answers in memory.

## What comes back

| CompanyFeatures | OFREP answer |
|---|---|
| A rule decided | `reason: TARGETING_MATCH`, the value and its variant |
| A % of devices decided | `reason: SPLIT`; the % group's name, when it has one, in `metadata.group` |
| The flag's default | `reason: DEFAULT` or `STATIC` |
| The flag is off | `reason: DISABLED`, no value: the app's own default |
| The flag uses the code default | no value: the provider returns the default written in your app |
| The flag isn't sent to this app | `FLAG_NOT_FOUND` (404 for one flag; left out of the bulk answer) |
| An entity that doesn't exist, or a chain that doesn't match | `400 INVALID_CONTEXT` |
| An entity outside the credential's reach | `403` |
| No credential, or a wrong or replaced one | `401` |

The answers are the server's own evaluator's, the same as the console's **Try it** and the backends' flagd JSON. The
server's tests check this with OpenFeature's own web and server OFREP providers
([test/ofrep.test.ts](https://github.com/dvir-daniel/companyfeatures/blob/main/test/ofrep.test.ts)).

## Cost

OFREP answers come from the server, one request per context and refresh, not from the CDN's cache: the server
evaluates every flag for the request in memory (microseconds per flag). For very large fleets, the
[app file](/sdk/app-file) is the CDN-cached alternative: one file per entity, read on the device by code of your own.
