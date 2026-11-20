# Changelog

Every release of the server and console. The Docker image's tags follow these versions.

## Unreleased

- **Docs: "Reading flags" by who decides.** Six pages: an overview with the four ways (an app or a backend, and the
  server or your code deciding), the evaluation context, remote evaluation in apps and in backends (OFREP), and local
  evaluation in apps (the CDN file, formerly the app file) and in backends (flagd). The old pages point to the new ones.

- **The docs site runs on Next.js and Fumadocs,** as better-auth.com's does, instead of VitePress. The pages are the
  same, at the same addresses, in `docs/content/docs/`. You get a sidebar of groups that open and close, a search box,
  "Copy Markdown" and "Open in" on every page, and a progress bar on phones. `/llms.txt`, `/llms-full.txt` and each
  page's `.md` are still there. It's still static files on GitHub Pages.

- **The console's sidebar and Settings:** the sidebar is grouped as Flags (flags, releases, approvals, history),
  Targeting, Connect (API keys, webhooks, migration) and Settings. Settings is one page per subject, with its own menu:
  Environments, Dimensions, Services, People, Single sign-on, Appearance and CDN (`#/settings/<page>`). Webhooks have
  a page of their own (`#/webhooks`) instead of a section of Migration.
- **Docs site:** page transitions, a circle for light and dark, and an animated landing page (the mark builds in, a
  live answer types out, a marquee of OpenFeature's languages, sections that rise in). None of it with reduced motion.
  The landing page's top bar has no search box; every docs page keeps it.

## 0.7.0 (2026-11-20)

- **Appearance:** Settings → Appearance sets the console's name, logo (and one for dark), browser tab icon, an accent
  color (seven of ours or your own), and light or dark for people who haven't chosen. It also sets a notice across
  the top of every page, a note on the sign-in page, a help link and up to four footer links. The server puts the
  name, icon and colors into the page it sends, so nothing flashes. Images are kept in the database and served with
  a policy that runs nothing. `appearance` in `companyflags.config.ts` sets it in Git, read-only in the console.
  Changes are in History. Migration 0019. See [Appearance](docs/self-hosting/appearance.md).

## 0.6.0 (2026-11-20)

- **On npm as `companyflags`:** `npx companyflags start` runs the server and the console from any folder, and every
  other command works the same way (`init`, `migrate`, `flags …`, `mcp`). After `npm i companyflags`, a
  `companyflags.config.ts` in that folder imports `companyflags/config` and `companyflags/plugins`, with types. MCP
  clients that start local servers run `npx -y companyflags mcp`.
- **Examples** in [`examples/`](https://github.com/dvir-daniel/companyflags/tree/main/examples): a Vite + React page
  (OpenFeature's React SDK and OFREP web provider), a Node server (the server SDK and OFREP provider, per company) and
  Docker Compose with flagd syncing a company's flagd JSON. `examples/seed.ts` sets up a server for them with an
  access token. See [Examples](https://dvir-daniel.github.io/companyflags/guide/examples).

### Security

- **Removing a person revokes their access tokens and OAuth sign-ins.** Before, inviting them again brought every old
  token and refresh token back to life, at once and before they accepted.
- **No open redirect through `/oauth/authorize`.** A request it can't use is shown on the page instead of being sent
  to the client's redirect URI, which anyone could register. Signed out or in, nobody is sent anywhere until they
  answer.
- **`/mcp` refuses every `Origin` but the configured address.** It compared the `Origin` with the address asked for,
  which a DNS-rebinding page sets itself.
- **Client registration is bounded:** a client nobody signed in with goes after a day, and at most 1,000 exist at once
  (`429`). A client's name loses invisible formatting characters (right-to-left overrides) as well as control ones.
- MCP tools refuse a key of `.` or `..`, which would have sent the call to another endpoint of the API.
- The [security model](https://dvir-daniel.github.io/companyflags/guide/security#agents-tokens-and-oauth) has a new
  section, "Agents, tokens and OAuth", with what is accepted and why.

## 0.5.0 (2026-11-20)

- **OAuth sign-in for MCP clients:** add `https://<server>/mcp` to Claude, Cursor or VS Code with no token. The client
  opens the browser, you sign in to the console and allow it as an agent (Viewer or Editor), and it gets a token that
  shows on your Access tokens page as "*client* (OAuth)". OAuth 2.1 with PKCE, dynamic client registration, refresh
  and revoke. Migration 0018 adds its tables.
- More MCP tools: `add_rule`, `remove_rule`, `set_entity_value`, `rollout_step`, `request_status`, `compare`.

## 0.4.0 (2026-11-20)

For AI agents and AI features ([plan](https://github.com/dvir-daniel/companyflags/blob/main/docs/design/ai.md)).

- **An MCP server**, the `mcp()` plugin at `/mcp`: tools to read, explain, change and clean up flags through the
  console's API, with an access token; changes where approval is needed are requests. `companyflags mcp` bridges
  clients that start local servers. See [AI resources](https://dvir-daniel.github.io/companyflags/guide/ai-resources).
- **The CLI over HTTP:** `flags pull|plan|push --url --token` (or `COMPANYFLAGS_URL`, `COMPANYFLAGS_TOKEN`), so CI
  needs no database access; `/api/flags-as-code` routes. `companyflags flags unused` finds flags no code reads.
- **Access tokens** in the console (your name → Access tokens): a token for `/api` as `Authorization: Bearer cfp_…`,
  for scripts, the CLI and MCP clients, with a role up to yours and 30, 90 or 365 days. A token for an agent is Viewer
  or Editor; its changes show with an **agent** badge in History, and its requests in Approvals, with a "By an agent"
  filter. See [Access tokens](https://dvir-daniel.github.io/companyflags/guide/security#access-tokens).
- A JSON flag can have a [JSON Schema](https://dvir-daniel.github.io/companyflags/guide/flags-and-rules#a-json-schema):
  every variant and every typed value must match it, or the save is refused with the variant and the field ("fast:
  model is required"). In New flag, the flag's Settings tab and flags as code (`jsonSchema`). Migration 0016.
- New flag has an **AI config** template: a Config JSON flag with `fast` and `strong` variants (model, temperature,
  prompt, tools) and a schema they match.
- [An alert turns a kill switch off](https://dvir-daniel.github.io/companyflags/guide/ai#an-alert-turns-a-kill-switch-off):
  `POST /api/alerts/kill` with an On call or Admin token, at once and recorded as break-glass, with examples for
  Grafana and Datadog.
- Docs for agents: `/llms.txt`, `/llms-full.txt` and a Markdown copy of every page; a skill
  (`skills/companyflags/SKILL.md`); [AI resources](https://dvir-daniel.github.io/companyflags/guide/ai-resources) with
  an `AGENTS.md` note and OpenFeature's MCP server set up for CompanyFlags.
- Docs: [Flags in the age of AI](https://dvir-daniel.github.io/companyflags/guide/ai): AI-written code behind a
  flag, models and prompts as config, agents with flags as code. Settings shows Dimensions above Services.

## 0.3.0 (2026-11-20)

Flag sets are now services, and every service gets keys: an app reads its flags with its own public key, no backend
needed first. Changes marked **Breaking** need something from you when you upgrade.

### Services

- **Breaking: flag sets are now services**, of two kinds: **App** (web, iOS, Android: gets values only) and
  **Backend** (gets the rules). The console's admin routes are `/api/services`. The links endpoint takes
  `?service=<key>` and answers with a `service` field; `?flagSet=` still works until 0.4.
- **Breaking:** the flags file's field is `services`, not `flagSets`. Rename it in `flags.json`, or run `flags pull`
  again: a file that still says `flagSets` leaves each flag's services as they are, and makes new flags in none.
- **Breaking:** the other JSON fields that said flag set say service too: webhooks in (`services`), imports
  (`services`), exports (`service`), and a plugin's `evaluate(environment, { service, entity, attrs })`.
- flagd keeps its own words: `flagSetId` is still `<environment>/<service>/<entity>`.

### Keys

- Every service gets keys: **API keys → + New key** (admins), one service and one environment each.
- An app service's key is public. It goes in the app, in OpenFeature's OFREP provider, and reads that service's values
  only, for the context the app sends. flagd JSON and app links answer it with `403`.
- **Breaking: a backend service's key is refused from a browser.** A request with an `Origin` header and a backend's
  key gets `403`. A web page that held one uses its app service's key instead.
- App links and their OFREP tokens (`ffl_…`) stay, as the optional signed way: a backend hands an app a token for
  one entity, so the app can't ask as another.

### Console

- The setup checklist has four steps: environments, services, your first flag (tick its services), and connecting an
  app with its service's key.
- Dimensions are optional, and no longer a setup step: without them, every app gets what everyone gets.

### Docs

- The Quickstart and the README go from a service to a flag, a key and OpenFeature's OFREP provider.
- Services, OpenFeature, Backends, the Security model and the HTTP API describe app keys, backend keys and signed app
  links. `GLOSSARY.md` has Service, App, Backend, App key and Backend key; "flag set" is flagd's word only.

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
