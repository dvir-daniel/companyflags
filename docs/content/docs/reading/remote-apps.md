---
title: "Remote evaluation in apps"
description: "Web, React, React Native, Android and iOS apps ask the server with OpenFeature’s OFREP providers and their app service’s public key."
---

[OFREP](https://github.com/open-feature/protocol) is OpenFeature's remote evaluation protocol. An app's provider asks
for every flag at once (`POST /ofrep/v1/evaluate/flags`), keeps the answers, and asks again when a publish changes
them. It sends its **app service's key**, which is public, or a [signed app link's token](/reading/context#signed-app-links).
OFREP is an [integration](/integrations/ofrep), on by default.

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
  // the entity's dimensions in the cache key: see "The answers kept on the device" below
  cacheKeyGenerator: ({ url, auth, domain, targetingKey, context }) =>
    JSON.stringify([url, auth ?? '', domain ?? '', targetingKey ?? '', context.company ?? '', context.brand ?? '']),
}));

const client = OpenFeature.getClient();
client.getBooleanValue('new_checkout', false);
client.getObjectDetails('theme', { accent: '#000', radius: 0 });   // value, reason, variant, flagMetadata
```

The provider asks for every flag once and keeps the answers. The answer also lists a stream of change events
(server-sent events): the provider listens to it, and when a publish may change its answers it asks again, with the
last answer's `ETag` (a `304` when nothing changed for this app) and the publish's revision. So changes reach devices
within a second or two. Each answer's stream is for its service and entity, so a publish wakes only the apps whose
answers it may change: a change to Acme's own settings wakes Acme's apps, not Globex's. With several servers, the one
it asks may not have caught up with that publish yet: it does first, so the answer is never the old one. If the
stream can't stay open, it polls every `pollInterval` instead. **Always set `pollInterval`**: without it (its default
is 0) the provider never polls, and retries a stream it can't open about once a second. Each server keeps so many
streams open at once, per environment and per client address (see [Configuration](/reference/configuration#server)).
At a limit the answer lists no stream, so the provider polls; a stream asked for anyway gets `429`. Behind a load
balancer, set `FF_TRUSTED_PROXIES`, or every device counts as the load balancer's one address
([Configuration → Client addresses](/reference/configuration#client-addresses)).
Changing the context (`OpenFeature.setContext`) asks again. When answers change it emits `ConfigurationChanged`.

Before sign-in, leave the entity out of the context: a key that asks about any entity then gets what everyone gets.
Once someone signs in, add their entity to the context, and the provider asks again:
`OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' }, company: 'acme' })`. If the app must
not be able to claim another entity, use a signed app link's token instead of the key.

`targetingKey` is the device (or the signed-in user) a % of devices is decided for, never the entity: the entity is
always named by its dimension key. See [The evaluation context](/reading/context#the-evaluation-context).

### The answers kept on the device

The web provider keeps its last answers in `localStorage` for 30 days (`cacheMode: 'local-cache-first'`, its default)
and shows them first on the next start, before it asks the server. Its cache key is the address, the
`Authorization` header, the OpenFeature domain and `targetingKey`: **not the entity**. Without more, after a sign-in,
a sign-out or a switch to another entity on the same device, the app first shows the previous entity's values, until
the answer comes.

Pick one:

- **Put the dimensions in the cache key** (`cacheKeyGenerator`, as above), with your installation's dimension keys.
  Each entity on the device then has its own cached answers.
- **Ask first:** `cacheMode: 'network-first'`. The provider waits for the server at start, and uses the cache only
  when the server can't be reached.
- **No cache:** `cacheMode: 'disabled'`. The code defaults until the first answer.

A signed app link's token is in the `Authorization` header, so its cache is already per entity.

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
  pollInterval: 60_000,
  cacheKeyGenerator: ({ url, auth, domain, targetingKey, context }) =>
    JSON.stringify([url, auth ?? '', domain ?? '', targetingKey ?? '', context.company ?? '', context.brand ?? '']),
}));

export function App() {
  return <OpenFeatureProvider><Checkout /></OpenFeatureProvider>;
}

function Checkout() {
  return useBooleanFlagValue('new_checkout', false) ? <NewCheckout /> : <OldCheckout />;
}
```

## Server-side rendering and Next.js

A page rendered on the server needs its flags before the browser has a provider. Decide them on the server for the
first paint, then let the browser's provider take over with the same context, so the values don't change after
hydration:

1. **On the server** (a Server Component, a route handler, `getServerSideProps`), read with OpenFeature's server SDK
   and the OFREP provider (see [Remote evaluation in backends](/reading/remote-backends)), set up once per server
   process. Use a **backend service's key**, from a server-only variable (never `NEXT_PUBLIC_…`): it is secret, and a
   browser's request with it gets `403`.
2. **The same context on both sides.** Name the signed-in entity by its dimension from your session, and use one
   `targetingKey` for the device on both sides: an ID kept in a cookie, set on the first visit, that the server reads
   and the browser reads too. Different IDs would put the device in different % groups on each side.
3. **Pass the values down** as props to the components that render them, and start the web provider in a client
   component with the app service's key (or the entity's app token, which your server can get with
   `GET /sdk/v1/links/…` and pass down). Its hooks give the code default until the provider is ready, so render the
   server's values until then.
4. **Don't share the rendered page.** It holds one entity's values: `Cache-Control: private`, or `no-store`, never a
   shared CDN cache.

Static pages (built ahead of time) have no request to decide for: read their flags in the browser only.

## React Native

React Native has `fetch` but no `EventSource` and no `localStorage`. OpenFeature's OFREP web provider still works,
but it skips the change stream without `EventSource`, and its default poll interval is `0`: it would never ask again.
Poll, and turn off its cache:

```ts
import { OpenFeature } from '@openfeature/react-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setContext({ targetingKey: installId, app: { version: '6.2.0' }, device: { platform: 'ios' } });
OpenFeature.setProvider(new OFREPWebProvider({
  baseUrl: 'https://flags.example.com',
  headers: [['Authorization', `Bearer ${token}`]],   // the app service's key, or the entity's app token
  changeDetection: 'polling',
  pollInterval: 30_000,                              // ask again every 30 seconds: usually a 304
  cacheMode: 'disabled',                             // no localStorage in React Native
}));
```

- Each poll sends the last `ETag`, so an unchanged answer is a small `304`.
- While the app is in the background, JavaScript is paused and so is polling. The next poll after it comes back
  brings any change.
- To start offline from the last answers, keep them yourself (AsyncStorage), or read the
  [CDN file](/reading/local-apps#web-apps-and-react-native) and keep the file.

## Mobile apps

Use OpenFeature's Kotlin or Swift SDK with its OFREP provider (find them on the
[OpenFeature ecosystem page](https://openfeature.dev/ecosystem)). Configure it the same way: the base URL of
CompanyFlags, and the `Authorization: Bearer <key>` header with the `android` or `ios` service's key (or the token
your backend gave the app). Nest the attributes, as the rules name them: `app` → `version`, not `"app.version"`.

### Attributes from each platform

Report what the device knows, by these names (the full list is in [Attributes](/reference/attributes)). Send versions
in full, as text: `17.4` becomes `17.4.0`.

| Attribute | iOS (Swift) | Android (Kotlin) |
|---|---|---|
| `targetingKey` (`device.id`) | a UUID you make on first launch and keep (Keychain) | a UUID you make on first launch and keep (`SharedPreferences`), not `ANDROID_ID` |
| `session.id` | a UUID per app session | a UUID per app session |
| `app.version` | `Bundle.main.infoDictionary["CFBundleShortVersionString"]` | `packageManager.getPackageInfo(packageName, 0).versionName` |
| `app.build` | `CFBundleVersion`, as a number | `PackageInfo.longVersionCode` |
| `app.channel` | `testflight` when `Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"`, `dev` for debug builds, else `store` | `store` when `getInstallSourceInfo(packageName).installingPackageName` is `com.android.vending`, `dev` for debug builds, else `beta` or your own |
| `device.platform` | `ios` | `android` |
| `device.type` | `UIDevice.current.userInterfaceIdiom`: `.phone` → `phone`, `.pad` → `tablet`, `.tv` → `tv` | `tablet` when `resources.configuration.smallestScreenWidthDp >= 600`, `tv` for `UI_MODE_TYPE_TELEVISION`, else `phone` |
| `device.manufacturer` | `Apple` | `Build.MANUFACTURER` |
| `device.model` | `utsname().machine` (`iPhone16,2`), not `UIDevice.current.model` | `Build.MODEL` |
| `device.memory_class` | (leave out) | `low` when `ActivityManager.isLowRamDevice`, else `normal` |
| `device.os` | `ios`, or `ipados` on an iPad | `android` |
| `device.os_version` | `UIDevice.current.systemVersion`, in full | `Build.VERSION.RELEASE`, in full (`14` → `14.0.0`) |
| `device.api_level` | (leave out) | `Build.VERSION.SDK_INT` |
| `locale.language` | `Locale.current.language.languageCode?.identifier` | `Locale.getDefault().language` |
| `locale.timezone` | `TimeZone.current.identifier` | `TimeZone.getDefault().id` |
| `geo.country` | `Locale.current.region?.identifier` (the device's setting, not where it is), or your backend's | `Locale.getDefault().country`, or your backend's |

The signed-in entity goes in the context by its dimension key (`company: "acme"`), next to these.

### When an app link is replaced

Replacing an entity's app link (console: the entity's **App link → Replace link**) stops its old token at once: the next
request with it gets `401`. The publish that replaces it wakes every app in the environment, so the apps find out
within seconds, not at their next poll. Each app then needs the new token from your backend, which gets it with
`GET /sdk/v1/links/<dimension>/<entity>?service=<key>` (see [Signed app links](/reading/context#signed-app-links)).

On the web, the provider reports the refused request as an error (`Error`, or `Stale` after a change event) and keeps
its last answers. When it does, ask your backend for the current token, and start a new provider if it changed:

```ts
import { OpenFeature, ProviderEvents } from '@openfeature/web-sdk';

let current = token;
async function checkToken() {
  const { token: latest } = await fetch('/api/flags-token').then((r) => r.json());   // your backend: GET /sdk/v1/links/…
  if (latest === current) return;
  current = latest;
  await OpenFeature.setProviderAndWait(providerFor(latest));                          // the same options, the new token
}
OpenFeature.addHandler(ProviderEvents.Error, checkToken);
OpenFeature.addHandler(ProviderEvents.Stale, checkToken);
```

`Stale` also comes when the change stream drops for a moment, so ask your backend at most once a minute or so. The
Kotlin and Swift providers report a `401` as an error too: do the same there. An app that reads its
[CDN file](/reading/local-apps) gets `404` at the old link; it asks its backend for the new link the same way.

## Cost

OFREP answers come from the server, one request per context and refresh, not from the CDN's cache: the server
evaluates every flag for the request in memory (microseconds per flag). For very large fleets, the
[CDN file](/reading/local-apps) is the alternative: one flagd JSON file per entity, cached by a CDN and evaluated on the device.
