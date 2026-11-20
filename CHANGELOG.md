# Changelog

Every release of the server and console. The Docker image's tags follow these versions.

## Unreleased

## 0.2.0 (2026-11-20)

A review of the architecture, the console, the docs and security, held to Better Auth's standard. Changes marked **Breaking** need something from you when you upgrade.

### Security

- **Breaking: the first account needs the setup link.** While nobody has an account, the server prints
  `make the admin account at <url>/api/setup/<secret>` at every start. Only that link makes the admin account; until
  then nobody joins, `FF_SIGNUP_DOMAINS` and single sign-on included. A database from before accounts needs it too.
  Scripts send the secret in `X-Setup`. See
  [Sign-in](https://dvir-daniel.github.io/companyflags/self-hosting/sign-in#the-first-account).
- **Breaking: `FF_CLIENT_IP_HEADER` needs `FF_TRUSTED_PROXIES`.** The header and `X-Forwarded-For` are believed only
  from those proxies. The server won't start with the header alone, or with a proxy entry that isn't an address.
- **Breaking: webhooks out reach public addresses only.** Allow origins on your network with
  `FF_WEBHOOK_ALLOWED_ORIGINS` or `webhooks({ allowedOrigins })`. Every unreachable address gets one message.
- **Breaking: only admins export with JSONata.** Others get `403` and use the other formats.
- Sign-in rate limits are on unless `NODE_ENV` is `development` or `test` (before: only in production).
- Request bodies have a limit per address: 64 KB OFREP, 256 KB sign-in, 1 MB webhooks in and the console's API,
  4 MB imports. A larger body gets `413`, also when sent in chunks.
- JSONata runs in worker threads, with a time limit, a memory limit and 4 MB of JSON in and out. One that runs over
  gets `422`; a webhook out's is switched off.
- Require single sign-on also stops Google, GitHub and Microsoft sign-ins for non-admins, and turning it on signs
  everyone at its domains out, admins aside.
- Admins can replace every app link and token in an environment: Settings → the environment's **Edit** → **Replace every link in this environment** (or `POST /api/environments/<env>/links/rotate`).
- One `404` for every wrong app link (environment, flag set, entity or secret). OFREP gives app tokens and keys
  scoped to `entity` or `below` one `403` for an entity that doesn't exist and one out of reach.
- The console looks up an invite with `POST /api/invites`, the token in the body, out of access logs.
  `GET /api/invites/<token>` is gone. A wrong setup link answers with a page, not JSON.
- Error logs name the route, never an address with a secret in it.

### Plugins and config

- `cloudflare()` listed in `companyflags.config.ts` reads `CF_ZONE_ID` and `CF_API_TOKEN` for what it isn't given.
- A failing `onPublish` no longer skips the other plugins'. Failures are logged with the plugin's name. Only
  `'purged'` counts as a CDN purge.
- `companyflags/plugins` exports `HttpError`, `PluginError` and the plugin types (`OnPublish`, `Evaluate`, …).
  Plugins get `evaluate()`, the one evaluator, and `env`.
- Plugin prefixes can't take `/api` or `/sdk` or overlap another plugin's, checked at start. Plugin console routes
  come after the core's.
- **Breaking for plugin authors:** `hub.subscribeOfrep` is now `hub.subscribe`; `plane.snapshots` is read only; the
  `Purger` type is `OnPublish`; `keys`, `links` and `flagSets` are internal. `companyflags/config` exports only
  `defineConfig`, `Config` and `ConfigError` (the loader moved to `server/configFile.ts`).
- **Breaking:** `auth.production` in the config file is ignored: production comes from `NODE_ENV` only.
- The config file must sit in the server's folder. One elsewhere stops the start with a message saying so;
  `companyflags init` warns.
- **Breaking:** the CLI refuses unknown options and arguments (exit `1`), such as `migrate --chek`. `--as` needs a
  value.
- Webhooks in refuse a body over 1 MB as it arrives, chunked bodies too.
- `node server/index.ts` works from a path with a space, or through a link.
- **Breaking:** log lines start with `[companyflags]`, not `[ff]`. The start line is `CompanyFlags on http://…`.

### Console

- A five-step setup checklist that stays until an app can read flags.
- Viewers no longer see **+ New flag**, **+ New release** or **+ Add** buttons, and bulk Archive is off for them.
- **Settings → Flag sets → Link** shows each flag set's file for everyone, per environment.
- Buttons say **+ New key**, **+ Add webhook in** and **+ Add webhook out**.
- With no flag sets yet, New flag and New release say so and link to Settings.
- Readable muted text in dark mode, and a visible focus on filter chips.
- Table heads announce columns and sorting to screen readers; required fields are announced; a skip link.
- Sign-in pages show the CompanyFlags mark; the reset pages have no tabs.
- The start-up error tells a server error from a server that can't be reached.
- The sidebar shows `v18`, linking to Versions, instead of `rev 18`.
- On a phone, People shows each role, and messages stay above the tab bar.

### Docs

- The Quickstart, Docker, Production and Sign-in pages use the setup link; the Quickstart names every field of the
  first flag.
- Configuration has an `auth` table, the proxy settings, rate limits and `FF_WEBHOOK_ALLOWED_ORIGINS`.
- Plugins documents `evaluate`, `env`, `hub.subscribe`, prefix rules, and a new "Errors and types" section.
- The Security model covers the setup link, webhooks, limits and replacing an environment's links.
- The HTTP API lists request size limits, webhooks in, the setup link and invites.
- A new sidebar order; each feature page names its plugin; `GLOSSARY.md` is linked from `CONTRIBUTING.md`.
- "Try it" is now the flag page's **Debug** tab everywhere.

## 0.1.0 (2026-11-20)

The first public release.

- **Dimensions.** Each installation defines what config is served per: one chain of up to four levels, in its own
  words (`customer`; `company` › `brand`; `region` › `chain` › `store`). Each entity has settings of its own on any
  flag, inherited down the chain, under locked rules that apply to everyone.
- **OpenFeature.** OFREP 0.4 (`/ofrep/v1/evaluate/flags`), for OpenFeature's own providers on the web, Android, iOS
  and servers, with change events (server-sent events) so apps hear about a publish at once. Apps use an app token,
  made from their entity's app link for their flag set; backends use an API key and name the entity in the evaluation
  context. flagd JSON for backends evaluating in-process, with `flagSetId` `<environment>/<flag set>/<entity>`.
- **Flag sets.** Flags are sent in flag sets, OpenFeature's term: groups such as `web`, `ios` and `api`, each for apps
  or for backends, with the flags in it chosen per environment.
- **App files.** One values-only file per environment, flag set and entity, cached by a CDN, purged on publish
  (Cloudflare), readable from any origin.
- **Releases.** A % of devices step by step, early access for some entities, clean-up; version releases (1.0.0 →
  1.0.1) with rollbacks by on call.
- **Change control.** Protected environments with approvals, scheduling, break-glass, an append-only history, restore
  and compare.
- **Sign-in.** Better Auth: email and password, Google, GitHub, Microsoft, single sign-on with SAML or OIDC, invites,
  roles, password reset links made by an admin. Only admins manage API keys. Sign-in rate limits read the connection's
  address, or a header you trust behind a proxy (`FF_CLIENT_IP_HEADER`, `FF_TRUSTED_PROXIES`).
- **Plugins and one config file.** A small core, and a plugin for each way flags are read (`ofrep()`, `flagd()`,
  `appFiles()`) and for the Cloudflare purge (`cloudflare()`), listed in a typed `companyflags.config.ts`
  (`defineConfig`), or all on without one. Write your own with `definePlugin`: routes, console routes, after-publish
  hooks.
- **The `companyflags` CLI.** `start`, `init`, `secret`, `migrate [--check]`, and flags as code: `flags pull`,
  `flags plan` and `flags push` keep a `flags.json` and CompanyFlags in step, through the console's own checks
  and approvals.
- **Running it.** A Docker image and a Compose file with Postgres; several instances on one database; `/healthz` and
  `/readyz`; security headers and a strict Content-Security-Policy on the console; a first screen that walks an admin
  through setting up.
- **Migration.** Run CompanyFlags next to the config system you have now and move flags one at a time: import its
  values (key-value JSON, flagd, CompanyFlags values, or any JSON through a JSONata expression), with a preview of
  every change first; export in the same formats. Apps ask CompanyFlags first and the old system for the rest,
  with OpenFeature's Multi-Provider; a flag moves when it's added to their flag set.
- **Webhooks out** (the `webhooks()` plugin). After each change, a signed message (Standard Webhooks), a Slack
  message, or your own JSON made with JSONata, with what the changed flags are set to now. In order, once each,
  retried for two hours.
- **Webhooks in.** Another system posts its values to an address of its own, and they're imported: at once, or as a
  request where the environment needs approval.
