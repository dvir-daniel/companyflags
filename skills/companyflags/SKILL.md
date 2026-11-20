---
name: companyflags
description: Use when adding, reading or cleaning up feature flags or remote config in a project that uses CompanyFlags (a self-hosted flag server read with OpenFeature), when putting new or AI-written code behind a flag, or when editing flags.json.
---

# CompanyFlags

CompanyFlags is a self-hosted feature flag and remote config server. Code reads it with **OpenFeature** (no SDK of
its own). Docs: https://dvir-daniel.github.io/companyflags/ (every page also as Markdown: add `.md`; all of them in
`/llms-full.txt`).

## Rules

1. **New or AI-written code goes behind a flag.** Wrap the new path in a check of an on/off flag, with the old path
   as the code's default. If no person read the change line by line, it gets a flag.
2. **The code's default is the safe value.** The default you pass to OpenFeature is what runs when the flag is off,
   missing or unreachable: the old behaviour, never the new one.
3. **Add the flag to `flags.json` in the same change** (if the project has one), then run `companyflags flags plan`.
   Never run `flags push` against production yourself: CI or a person does.
4. **Never turn a flag on in production yourself.** Production changes are requests a person approves in the console.
   Development is fine.
5. **Never put a backend key in an app or a browser.** Apps use their app service's public key; backends keep their
   key secret.

## With the MCP server

If a `companyflags` MCP server is connected, use it instead of guessing: `explain` and `evaluate` before you change
anything, `get_flag` for a flag's rules and services, `compare` for two entities or environments, `stale_flags` for
cleanup. Change tools show a plan first; call them with `apply: true` only after the person agreed. In production they
open a request; tell the person its number, and check it with `request_status`.

## Reading a flag

```ts
// a backend (Node): OpenFeature's OFREP provider, with the backend service's secret key
import { OpenFeature } from '@openfeature/server-sdk';
import { OFREPProvider } from '@openfeature/ofrep-provider';
await OpenFeature.setProviderAndWait(new OFREPProvider({ baseUrl: process.env.FLAGS_URL, headers: [['Authorization', `Bearer ${process.env.FLAGS_KEY}`]] }));
const on = await OpenFeature.getClient().getBooleanValue('new_checkout', false, { targetingKey: userId, company: 'acme' });
```

```ts
// an app (web): the web OFREP provider, with the app service's public key
import { OpenFeature } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
await OpenFeature.setContext({ targetingKey: installId, app: { version: '6.0.0' } });
await OpenFeature.setProviderAndWait(new OFREPWebProvider({ baseUrl: FLAGS_URL, headers: [['Authorization', `Bearer ${APP_KEY}`]] }));
OpenFeature.getClient().getBooleanValue('new_checkout', false);
```

The context: `targetingKey` (the device's ID, used for % rollouts), `app.version`, `app.build`, `device.platform`
(`ios`, `android`, `web`), `locale.language`, `geo.country`, and the installation's dimensions by their key
(`company: 'acme'`, `store: 'sf-01'`). The full list: https://dvir-daniel.github.io/companyflags/reference/attributes.
Ask the project which dimensions it has.

## Adding a flag to flags.json

```json
{
  "flags": {
    "new_checkout": {
      "name": "New checkout",
      "kind": "release",
      "type": "bool",
      "owner": "payments",
      "removeBy": "2027-02-17",
      "services": { "dev": ["web", "ios", "android"], "prod": ["web", "ios", "android"] }
    }
  }
}
```

- **Keys:** lowercase letters, digits and `_`, starting with a letter. They never change.
- **`kind`:** `release` (roll out, then remove), `experiment`, `kill_switch`, `ops`, `config`, `permission`.
  `release` and `experiment` need `removeBy` (YYYY-MM-DD).
- **`type`:** `bool`, `string`, `number` or `json`. An on/off flag gets `on`/`off` variants by itself. Others list
  `variants` (name → value) and a `default`.
- **`services`:** per environment, the services (apps and backends) that read it. A service not listed never sees it.
- **A new flag starts off where changes need approval.** Rules (who gets what) are set in the console, not the file.

Then: `companyflags flags plan` shows what a push would change.

## Models and prompts

Put an AI feature's model, prompt and parameters in a `json` flag (`kind: config` or `experiment`) and read them
with `getObjectValue`. Then a model can be rolled out by % or per company, and rolled back without a deploy.

## Cleaning up

When a release is at everyone and stable, remove the flag from the code (keep the new path), ship it, then archive the
flag in the console. Flags past their `removeBy` date are listed on the Releases page.
