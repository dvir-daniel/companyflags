---
title: "Moving from another system"
description: "Run CompanyFlags next to the system you have now and move flags over one at a time."
---

You don't switch on one day. CompanyFlags runs next to the config system you have now, and flags move over one at
a time. Apps ask CompanyFlags first and the old system for everything not moved yet, so nothing changes for anyone
on the day you start, and any flag can stay behind as long as it needs to.

Import and export are on the console's **Settings → Migration** page (admins import; everyone can export, and admins can also
export with JSONata). The webhooks that keep both systems the same are on the **Webhooks** page.

## How it works

1. **Import** the old system's flags, with **Create missing flags** on. They're created as config flags in no
   [service](/guide/services) yet, so apps still read the old system.
2. **Put OpenFeature's Multi-Provider in each app**: CompanyFlags first, the old system second. A flag
   that isn't in the app's service is "not found", and the old system answers instead.
3. **Move a flag** by adding it to the app's service (the flag's **Settings** tab, **Services**). From then on the
   app reads it here.
4. **Keep both the same** meanwhile: a [webhook out](/integrations/webhooks#out) tells the old system each change made here,
   and a [webhook in](/integrations/webhooks#in) takes the old system's changes.
5. When the last flag has moved, take the old system out of the Multi-Provider.

## The Multi-Provider

OpenFeature's [Multi-Provider](https://openfeature.dev/specification/appendix-a#multi-provider) asks several providers
in turn. With `FirstMatchStrategy`, a provider that answers `FLAG_NOT_FOUND` passes the question to the next one; any
other answer is the app's. CompanyFlags answers `FLAG_NOT_FOUND` for every flag that isn't in the app's service.

```ts
import { OpenFeature, MultiProvider, FirstMatchStrategy } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setProviderAndWait(new MultiProvider([
  { provider: new OFREPWebProvider({
      baseUrl: 'https://flags.example.com',
      headers: [['Authorization', 'Bearer ff_prod_web_…']],   // the app service's key: see OpenFeature
      pollInterval: 60_000,                                    // when it can't keep a change stream open
  }) },
  { provider: oldSystemProvider },   // every flag not in this app's service yet
], new FirstMatchStrategy()));
```

On a server it's the same with `@openfeature/server-sdk` and `OFREPProvider`. If the old system has no OpenFeature
provider, write a small one: a provider is one class with a method per value type, reading whatever the old system
gives.

:::warning[A flag that is in the service but switched off]
A flag in the app's service and switched off answers with the app's own default: the old system isn't asked. Switch a flag
on before adding it to the service, or leave it out until it's ready.
:::

:::tip[Keys]
Flag keys here are lowercase letters, digits and underscores. A flag the old system calls `new-checkout` or
`newCheckout` can't move under that key: rename it in the app's code when you move it, or leave it in the old system.
:::

## Import

**Migration → Import** takes the old system's JSON (pasted, or a file), one environment, and a format:

| Format | Looks like | What comes over |
|---|---|---|
| Key-value JSON | `{ "max_upload_mb": 100, "new_checkout": true }` | each flag's value for everyone |
| flagd (OpenFeature) | [flagd's flag file](https://flagd.dev/reference/flag-definitions/) | each flag's default, on/off and variants; not its targeting |
| CompanyFlags values | see below | value for everyone, on/off, variants, entities' own values |
| Any JSON, with JSONata | anything | what your [JSONata](https://jsonata.org) expression makes of it |

**Preview** shows every change and every problem before anything is saved. Nothing is imported while there's a
problem. Then **Import** saves it all as one version, through the same checks as the console, with your reason in
History. Where the environment needs approval, the changes become one request instead, and go out once it's approved.

An import never touches rules or %: the old system has none to bring. Flags it doesn't name, and entities it doesn't
name, stay as they are.

### CompanyFlags values

The one shape everything is read into and written from:

```json
{
  "flags": {
    "max_upload_mb": {
      "value": 100,
      "on": true,
      "variants": { "standard": 100, "enterprise": 1000 },
      "entities": { "acme": 1000, "globex": null }
    },
    "banner_text": { "value": "Hello", "name": "Banner text", "description": "The home page's banner" }
  }
}
```

- `value`: everyone's default. On a flag with named variants it has to be one of their values (or a variant listed in
  `variants`, which is added).
- `on`: switched on or off.
- `entities`: an entity's own default (it has its own settings from then on). `null` removes the entity's own settings.
- `name`, `description`: for a flag the import creates.

### JSONata

When the old system's JSON is another shape, a JSONata expression makes a values document of it. For an old system
that gives `{ "settings": [{ "name": "max_upload_mb", "value": 100 }] }`:

```
{ "flags": settings{ name: { "value": value } } }
```

An expression can't read files or the network. It runs in a worker apart from the server, so it can't slow down
or stop anything else: it stops after a second, 500 levels deep, or at its memory limit, and reads and makes at
most 4 MB of JSON. One that runs over a limit gets `422` and imports nothing.

## Export

**Migration → Export** gives one environment in the same formats: CompanyFlags values (which imports back
unchanged), key-value JSON, one service's flagd file, or your JSONata expression's shape. It has each flag's value for
everyone, on/off, variants and entities' own values. Rules and % aren't in it: the server decides those for each
device.

Only admins export with a JSONata expression, since it runs on the server as an import's does. Editors and viewers
get `403` for it, and use the other formats.

## From the API

The console uses these, with a session or an admin's sign-in:

| | |
|---|---|
| `POST /api/migration/preview` | `{ environment, format, text \| input, expression?, createFlags?, services? }` → `{ plan }` |
| `POST /api/migration/import` | the same, and `reason` → `{ created, changed, applied, revision?, request?, warnings }` |
| `POST /api/migration/export` | `{ environment, format, service?, expression? }` → `{ output }` |

An import's body can be up to 4 MB. For another system to post changes on its own, use a
[webhook in](/integrations/webhooks#in).
