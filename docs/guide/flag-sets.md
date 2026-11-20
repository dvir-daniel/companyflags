# Flag sets

A **flag set** is a group of flags sent together. Each of your apps and backends reads one: the web app reads `web`,
the iOS app `ios`, your backend `api`. A flag that isn't in a flag set doesn't exist for whoever reads it, and
OpenFeature returns the default written in their code. The name is OpenFeature's: flagd and GO Feature Flag group
flags into flag sets too.

A flag set has a key, which never changes, and a kind:

| Kind | Read by | How |
|---|---|---|
| **For apps** | Android, iOS and web apps, on your users' devices | With OFREP, or as a values-only [app file](/sdk/app-file), at the entity's secret app link |
| **For backends** | Your servers | With an API key, as flagd JSON or with OFREP. See [Backends](/guide/backends) |

The rest of this page is about flag sets for apps. Apps read their flags with [OpenFeature](/sdk/openfeature):
OpenFeature's SDK for the platform, with its OFREP provider pointed at CompanyFlags. There is no SDK of ours to
install.

Each app reads as **one entity** (a region, a store, a team), with a credential your backend hands it at sign-in. It
gets that entity's answers only: never the rules, never another entity's values.

## Add a flag set

**Settings → Flag sets → + Add flag set** (admins): a key (`web`, `ios`, `android`) and the kind **For apps**. The key
never changes.

Then put flags in it. A flag's **Settings** tab lists the flag sets, with a switch per environment: a flag can be in
several, and each environment has its own list. In a protected environment, putting a flag in a flag set or taking it
out is reviewed, like any other change. Releases show it per environment: "In flag sets: web, ios", or "In no flag
set".

## Give the app its credential at sign-in

Each entity has a secret **app link** per environment. An app uses it in one of two forms:

| Form | Looks like | Used by |
|---|---|---|
| OpenFeature token | `ffl_prod.web.acme.Vx8…` | OpenFeature's OFREP providers: `Authorization: Bearer <token>`. One per flag set: a `web` token can't read `ios` |
| App file address | `/client/v1/flags/prod/web/acme/Q2k…` | Code that reads the [app file](/sdk/app-file) from your CDN |

Your backend knows which entity someone belongs to. When they sign in, it asks CompanyFlags for the entity's link
with its API key, naming the app's flag set, and returns the token with the session:

```ts
// your backend, at sign-in (a server API key from the console's API keys page)
const res = await fetch(`https://flags.example.com/sdk/v1/links/company/${user.companyKey}?flagSet=web`, {
  headers: { Authorization: `Bearer ${process.env.FLAGS_API_KEY}` },
});
const { token } = await res.json();     // ffl_prod.web.acme.Q2k…   (and `path`, the app file's address)
session.flagsToken = token;
```

The link only changes when someone replaces it (the entity's page → **App link → Replace link**), which stops the old
token and address at once. So your backend can keep it with the entity. A key with scope **entity** or **below** can
only ask about its own entity (and those under it); a key with scope **all**, about any. For a handful of entities you
can also copy each token from the console.

## Read flags with OpenFeature

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' } });
await OpenFeature.setProviderAndWait(new OFREPWebProvider({
  baseUrl: 'https://flags.example.com',
  headers: [['Authorization', `Bearer ${session.flagsToken}`]],
}));

OpenFeature.getClient().getBooleanValue('new_checkout', false);
```

Android and iOS work the same way with OpenFeature's Kotlin and Swift SDKs and their OFREP providers. The context
says what the device knows about itself: its app version, platform, OS, language, and an install ID for a % of
devices (`targetingKey`). See [OpenFeature](/sdk/openfeature) for React, backends and every answer's meaning.

## What a device sends, and what it gets

- **It sends** its token and its context. The token says the environment, the flag set and the entity; the server
  ignores anything the context says about them, so a device can't ask as another entity.
- **It gets** a value for each flag in its flag set, the reason, and the % group name when the rule has one. Rules
  about dimensions, lists of entities and other entities' values never leave the server.
- **A flag that uses the code default** comes back without a value, and OpenFeature returns the default in your code.
  So does every flag while the app can't reach the server. Make the code default the safe one.

## How updates reach devices

1. Someone changes a flag (after approval, where needed), and the server publishes it at once.
2. Every app listening hears it at once: the OFREP web provider keeps a server-sent events stream open (the answer
   lists it), and a publish there says `refetchEvaluation`.
3. The provider asks for its flags again with the last answer's `ETag`. Nothing changed for it: a `304 Not
   Modified`, a few bytes. Something changed: the new answers, and a `ConfigurationChanged` event with the flags that
   changed. Where the stream can't stay open, the provider polls instead (`pollInterval`).

## Very large fleets: the app file

OFREP answers come from the server: one small request per device and check, evaluated in memory. For fleets of
millions of devices you may prefer that no request reaches the server at all. The **app file** is that: one file per
environment, flag set and entity, built once per publish and cached by your [CDN](/self-hosting/cdn), with the
entity's values and the few checks only the device can make. Nothing runs per request; the CDN answers.

There is no OpenFeature provider for the app file. Reading it is about a hundred lines of code, described completely
in [The app file](/sdk/app-file).

## Next

- [OpenFeature](/sdk/openfeature): web, React, Android, iOS and backends, and what each answer means.
- [Backends](/guide/backends): flag sets for backends, API keys, OFREP per request, or flagd in-process.
- [Attributes](/reference/attributes): every name a context can use.
