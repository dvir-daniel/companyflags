---
title: "Remote evaluation in apps"
description: "Web, React, Android and iOS apps ask the server with OpenFeature’s OFREP providers and their app service’s public key."
---

[OFREP](https://github.com/open-feature/protocol) is OpenFeature's remote evaluation protocol. An app's provider asks
for every flag at once (`POST /ofrep/v1/evaluate/flags`), keeps the answers, and asks again when a publish changes
them. It sends its **app service's key**, which is public, or a [signed app link's token](/reading/context#signed-app-links).
OFREP is the `ofrep()` plugin: it runs unless your config file lists plugins without it.

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
last answer's `ETag` (a `304` when nothing changed for this app) and the publish's revision. So changes reach devices
within a second or two. With several servers, the one it asks may not have caught up with that publish yet: it does
first, so the answer is never the old one. If the stream can't stay open, it polls every `pollInterval` instead. Each
server keeps so many streams open at once (see [Configuration](/self-hosting/configuration#server)); beyond that the
stream gets `429` and the provider polls. Changing the context (`OpenFeature.setContext`)
asks again. When answers change it emits `ConfigurationChanged`.

Before sign-in, leave the entity out of the context: a key that asks about any entity then gets what everyone gets.
Once someone signs in, add their entity to the context, and the provider asks again:
`OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' }, company: 'acme' })`. If the app must
not be able to claim another entity, use a signed app link's token instead of the key.

## React

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

## Cost

OFREP answers come from the server, one request per context and refresh, not from the CDN's cache: the server
evaluates every flag for the request in memory (microseconds per flag). For very large fleets, the
[CDN file](/reading/local-apps) is the alternative: one flagd JSON file per entity, cached by a CDN and evaluated on the device.
