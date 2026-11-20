---
title: "Services"
---

A **service** is what reads your flags: each of your apps, and each backend. The web app reads `web`, the iOS app
`ios`, your backend `api`. A flag that isn't in a service doesn't exist for whoever reads it, and OpenFeature returns
the default written in their code.

A service's API key picks which flags it reads; the evaluation context picks whose values it gets. In OpenFeature
terms, that's the provider's key versus the evaluation context.

Each service has a key, such as `web`, which never changes, and a kind:

| Kind | Read by | Gets | Its API key |
|---|---|---|---|
| **App** | Android, iOS and web apps, on your users' devices | Values only, for the context the app sends | Public: it goes in the app |
| **Backend** | Your servers | Values over OFREP, or the rules as flagd JSON. It also hands out app links | Secret: it stays on your servers. See [Backends](/reading/overview) |

## A service isn't a customer

Make one service per app or backend, never one per customer. Per-company values are
[dimensions](/guide/dimensions): one flag, with one set of rules, and each company's own settings on top. Acme and
Globex both read `web`. The context says which one is asking, and Globex gets its own `api_base_url` from its
settings on that one flag. A service per company would copy every flag, and every rule, once per company.

## Add a service

**Settings → Services → + Add service** (admins): a key (`web`, `ios`, `android`, `api`) and the kind, **App** or
**Backend**. The key never changes. The kind can change only while no flag is in the service, no key for it still
works, and no request waiting to go out would put a flag in it.

Then put flags in it. A flag's **Settings** tab lists the services, with a switch per environment: a flag can be in
several, and each environment has its own list. In a protected environment, putting a flag in a service or taking it
out is reviewed, like any other change. Releases show it per environment: "In services: web, ios", or "In no
service".

## Make its key

Every service gets API keys, each for one service in one environment. **API keys → + New key** (admins): the
environment, the service, what the key **asks about**, and a label. The key is shown once; only its hash is kept.

- **An app service's key is public.** It looks like `ff_prod_web_…`. Put it in the app, in OpenFeature's OFREP
  provider. It reads that service's values only, for the context the app sends. It can't download the rules (flagd
  JSON) or hand out app links: both are `403`.
- **A backend service's key is secret.** It looks like `ff_prod_api_…`. It reads values over OFREP or the rules as
  flagd JSON, and hands out app links. A request with a backend's key and an `Origin` header (what a browser sends)
  is refused with `403`, so a backend's key put in a web page by mistake doesn't work.

What a key asks about is its scope: one entity (`entity`), one entity and every one under it (`below`), or any
(`all`). An app built for Acme alone can have a key for Acme only. See
[Backends](/reading/remote-backends#create-a-service-and-an-api-key).

## Read flags with OpenFeature

Apps read their flags with [OpenFeature](/reading/overview): OpenFeature's SDK for the platform, with its OFREP
provider pointed at CompanyFlags and the app service's key. There is no SDK of ours to install.

```ts
import { OpenFeature } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' } });
await OpenFeature.setProviderAndWait(new OFREPWebProvider({
  baseUrl: 'https://flags.example.com',
  headers: [['Authorization', 'Bearer ff_prod_web_…']],   // the web service's key: public
}));

OpenFeature.getClient().getBooleanValue('new_checkout', false);
```

Android and iOS work the same way with OpenFeature's Kotlin and Swift SDKs and their OFREP providers. The context
says what the device knows about itself: its app version, platform, OS, language, and an install ID for a % of
devices (`targetingKey`). Once someone signs in, the context can name their entity by its dimension, as rules do:
`company: 'acme'`. See [OpenFeature](/reading/overview) for React, backends and every answer's meaning.

## Signed app links

With a public key, the entity in the context is targeting, not proof. With a key that asks about any entity, anyone
who has the app can send `company: 'globex'` and get Globex's values (values only, never the rules). When an app must
read as its own entity and no other, your backend hands it a signed **app link** at sign-in. This is optional.

Each entity has a secret app link per environment. An app uses it in one of two forms:

| Form | Looks like | Used by |
|---|---|---|
| OpenFeature token | `ffl_prod.web.acme.Vx8…` | OpenFeature's OFREP providers: `Authorization: Bearer <token>`, in place of the app's key. One per service: a `web` token can't read `ios` |
| CDN file address | `/cdn/v1/flags/prod/web/acme/Q2k…` | Code that reads the [CDN file](/reading/local-apps) from your CDN. The service is in the path, not in the secret: the same secret reads the entity's other app services |

Your backend knows which entity someone belongs to. When they sign in, it asks CompanyFlags for the entity's link
with its backend service's key, naming the app's service, and returns the token with the session:

```ts
// your backend, at sign-in, with its backend service's key (secret)
const res = await fetch(`https://flags.example.com/sdk/v1/links/company/${user.companyKey}?service=web`, {
  headers: { Authorization: `Bearer ${process.env.FLAGS_API_KEY}` },
});
const { token } = await res.json();     // ffl_prod.web.acme.Vx8…   (and `path`, the CDN file's address)
session.flagsToken = token;
```

The app then sends `Bearer ${session.flagsToken}` instead of its key. The token asks as that entity only: naming
another in the context gets `403`.

The link only changes when someone replaces it (the entity's page → **App link → Replace link**), which stops the old
token and address at once. So your backend can keep it with the entity. A key with scope **entity** or **below** can
only ask about its own entity (and those under it); a key with scope **all**, about any. For a handful of entities you
can also copy each token from the console.

## What a device sends, and what it gets

- **It sends** its key or token, and its context. The key or token says the environment and the service; a token also
  says the entity. The server ignores anything the context says about them.
- **It gets** a value for each flag in its service, the reason, and the % group name when the rule has one. Rules,
  lists of entities and other entities' settings never leave the server.
- **A flag that uses the code default** comes back without a value, and OpenFeature returns the default in your code.
  So does every flag while the app can't reach the server. Make the code default the safe one.

## How updates reach devices

1. Someone changes a flag (after approval, where needed), and the server publishes it at once.
2. Every app listening hears it at once: the OFREP web provider keeps a server-sent events stream open (the answer
   lists it), and a publish there says `refetchEvaluation`.
3. The provider asks for its flags again with the last answer's `ETag`. Nothing changed for it: a `304 Not
   Modified`, a few bytes. Something changed: the new answers, and a `ConfigurationChanged` event with the flags that
   changed. Where the stream can't stay open, the provider polls instead (`pollInterval`).

## Very large fleets: the CDN file

OFREP answers come from the server: one small request per device and check, evaluated in memory. For fleets of
millions of devices you may prefer that no request reaches the server at all. The **CDN file** is that: one file per
environment, service and entity, built once per publish and cached by your [CDN](/self-hosting/cdn), with the
entity's values and the few checks only the device can make. Nothing runs per request; the CDN answers.

The CDN file is flagd JSON: web apps and React Native read it with OpenFeature's flagd evaluator. See
[The CDN file](/reading/local-apps).

## Next

- [OpenFeature](/reading/overview): web, React, Android, iOS and backends, and what each answer means.
- [Backends](/reading/overview): backend services, their keys, OFREP per request, or flagd in-process.
- [Attributes](/reference/attributes): every name a context can use.
