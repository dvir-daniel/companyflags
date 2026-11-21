---
title: "Local evaluation in apps"
description: "An app downloads its entity's flags as flagd JSON, cached by a CDN, and decides each flag on the device."
---

Most apps read flags [remotely, with OpenFeature](/reading/remote-apps). The **CDN file** is the other way: an app
downloads its entity's flags once, as [flagd](https://flagd.dev) JSON, and decides each flag itself. The file is the
same for every device of that entity, so a CDN caches it and no request reaches your server.

It's for web and React Native apps. They read it with OpenFeature's flagd evaluator, `@openfeature/flagd-core`, and a
short fetch loop of their own. That evaluator isn't an OpenFeature provider: your code calls it directly, not through
an OpenFeature client. Native Android and iOS apps read with [OFREP](/reading/remote-apps) instead.

It's the same format a backend's [flagd JSON](/reading/local-backends) uses. The difference is what the server puts
in it:

- **For an app service and one entity:** the server settles everything it already knows (the environment, the
  service, the entity and the levels above it) and leaves in only what the device must check itself: its app
  version, its platform, its ID for a % of devices. Rules about other entities are never in it, nor their values: a
  flag switched off is flagd's `DISABLED` with a placeholder variant, `{ "unused": false }`, never one of its values.
- **Safe to share:** it's read at a secret link, not with a key, and a CDN may cache it.

The CDN file is an [integration](/integrations/cdn-files), on by default.

## Getting it

```http
GET /cdn/v1/flags/<environment>/<service>/<entity>/<secret>
If-None-Match: W/"…"            (the ETag of the file you have, if any)
```

- `200` with the file and an `ETag` (weak); `304` when your copy is current.
- `404` with `{ "error": "…" }` for any wrong link, environment or service.
- Before sign-in, read `GET /cdn/v1/flags/<environment>/<service>`: what every device gets. **Settings →
  Services → Link** on an app service shows that address for each environment.
- To give each signed-in user's app its entity's link, your backend asks for it: see
  [Signed app links](/reading/context#signed-app-links).
- Ask again every minute or so, and when the app comes to the foreground. Keep the last file on the device and start
  from it next time.

## What's in it

Shortened: the real file also checks that `app.version` is there, and falls back to `session.id` for a device
with no ID.

```json
{
  "$schema": "https://flagd.dev/schema/v0/flags.json",
  "metadata": { "flagSetId": "prod/web/acme", "environment": "prod", "revision": 42 },
  "flags": {
    "dark_mode_v2": {
      "state": "ENABLED",
      "variants": { "off": false, "on": true },
      "defaultVariant": "off",
      "targeting": { "if": [
        { "sem_ver": [{ "var": "app.version" }, "<", "6.0.0"] }, "off",
        { "==": [{ "fractional": [{ "cat": ["dark_mode_v2/", { "var": "device.id" }] }, ["in", 3000], ["out", 7000]] }, "in"] }, "on",
        null
      ] }
    }
  }
}
```

The rules for this flag were "below 6.0 → off, beta entities → on, else 30% of devices → on". Acme isn't a beta
entity, and the server knew that, so the beta rule isn't in Acme's file. See [flagd JSON](/reading/local-backends#get-the-flagd-json)
for how each part reads.

## Web apps and React Native

OpenFeature's flagd evaluator, `@openfeature/flagd-core`, reads the file in the browser or in React Native. Your code
fetches the file, hands it over, and asks it for each flag:

```bash
npm install @openfeature/flagd-core
```

```ts
import { FlagdCore } from '@openfeature/flagd-core';

const core = new FlagdCore();
let etag = '';

async function refresh(link: string) {
  const res = await fetch(link, { headers: etag ? { 'If-None-Match': etag } : {} });
  if (res.status === 304) return;
  etag = res.headers.get('ETag') ?? '';
  core.setConfigurations(await res.text());
}

const link = 'https://flags.example.com/cdn/v1/flags/prod/web/acme/k3J9xW2mQ7vR1tY5uP8sLa';
await refresh(link);
setInterval(() => refresh(link), 60_000);

const context = { targetingKey: installId, app: { version: '6.2.0' } };
core.resolveBooleanEvaluation('dark_mode_v2', false, context).value;
```

## The country

Rules can check `geo.country`, a two-letter country code. The file never varies by country: the server doesn't know
where a device is. The CDN adds a `CF-IPCountry` response header next to the file, and the app reads it and puts it in
the context as `geo.country`. The file's country lines are then checked on the device. Each CDN sets the header its
own way: see [CDN Files → The country header](/integrations/cdn-files#the-country-header).

- Browsers may read the header from another origin: the server lists it in `Access-Control-Expose-Headers`.
- Without the header, `geo.country` is unknown: a rule that checks it doesn't match, except a locked rule, which
  applies when the value is missing (it fails closed).
- OpenFeature remote evaluation doesn't read the country from a CDN: if your rules check `geo.country`, send it in
  the evaluation context.

## From another origin

Every answer under `/cdn/v1/` has `Access-Control-Allow-Origin: *`, allows `GET` and `HEAD`, exposes `ETag` and
`CF-IPCountry`, and caches the preflight for a day. A file is public to whoever has its link and needs no cookie, so
a web app on any origin may read it.

## Android and iOS

OpenFeature has no provider or evaluator that reads flagd JSON on an Android or iOS device. Native apps read
remotely, with OpenFeature's OFREP providers for Kotlin and Swift: see
[Remote evaluation in apps](/reading/remote-apps#mobile-apps).

## Attributes to report

Report what your platform knows, by these names, nested as JsonLogic reads them (`{ "app": { "version": "6.2.0" } }`):
`app.version`, `app.build`, `app.channel`, `device.id` (a random ID kept for the install), `session.id`,
`device.platform`, `device.type`, `device.manufacturer`, `device.model`, `device.memory_class`, `device.os`,
`device.os_version`, `device.api_level`, `device.browser`, `device.browser_version`, `device.browser_engine`,
`geo.country`, `locale.language`, `locale.timezone`. The full list, with their known values, is in
[Attributes](/reference/attributes); where each comes from on iOS and Android is in
[Attributes from each platform](/reading/remote-apps#attributes-from-each-platform).

- The device ID for a % of devices is `device.id`, or OpenFeature's `targetingKey` when there's no `device.id`, as
  over OFREP. A device in a % group is in the same group from the file and from the server.
- Report versions in full, as text: `6.2.0`, not `6.2` or `6`. Rules always hold full versions, but the device's own
  is read by whichever flagd evaluator the app runs, and not all of them read short ones.

## The same answers as the server

The file is evaluated the way flagd evaluates, so it gives the server's answers, with flagd's few differences: reasons
are coarser, and a % rule's group names aren't in the answer. See
[What differs from the server](/reading/local-backends#what-differs-from-the-server). A device lands in the same %
group everywhere: `fractional` uses the server's own hash.
