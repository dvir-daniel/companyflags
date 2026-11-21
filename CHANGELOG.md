# Changelog

Every release of the server and console. The Docker image's tags follow these versions.

## Unreleased

- **The console's sidebar works like better-auth.com's.** Every item is a short noun in Title Case, and it is the
  page's title and its tab's title, word for word. The groups: Flags, Releases, Approvals, History and Compare; then
  **Audience** (your dimensions); then **Developers** (Services, API Keys, Webhooks); then Settings. Migration is in
  Settings (`#/migration` opens it there). Two-factor sign-in and access tokens are on **Account**, from the menu under
  your name. "Set up dimensions" is gone: Settings → Dimensions. Pages no longer repeat their title as a heading, a
  release opened from Releases leads back there, and the sidebar doesn't move while the console loads.
- **The examples' seed works with a token.** A token is On call at most and never changes settings, so the seed
  asks for an Editor's token. An admin makes the environment, the dimension and the services in the console first; the
  seed checks them, says what is missing, and adds the companies and flags. It ends by saying which API keys to make.
- **Every `docker run` line pins `0.9`.** The README, the quickstart, the examples, the MCP setup and the landing page
  run `ghcr.io/dvir-daniel/companyflags:0.9`, as Compose does, so a later pull never moves the schema on its own.
- **The CDN file, said plainly.** Web and React Native apps read it with OpenFeature's flagd evaluator (`flagd-core`)
  and a short fetch loop: it isn't an OpenFeature provider. Native Android and iOS apps use OFREP.
- **A hard stop no longer locks the embedded database.** After a kill or an out-of-memory, the lock file stayed, and in
  Docker the next start (PID 1 again) refused it forever. A lock that names this process, or a process ID that now
  runs another program, is taken over. Backups and `copy-to-postgres` work after a hard stop too.
- **`/readyz` says whether this instance can serve.** It answers `503` only when the database doesn't answer or no
  snapshot is loaded. An environment whose publish fails is listed in `failing`, with a `200`: one failed publish no
  longer takes every instance out of rotation. Alert on `failing`.

- **Pause says who keeps the new value.** Pausing a release switches off its own rules only, so an entity whose own
  rule or default serves the new value keeps it. The Pause dialog and the rollout card now name those entities, and
  the dialog offers **Turn off now** (on call, in a protected environment) or **Turn off**, which stops it for everyone.
- **The Releases page says on call turns a release off at once.** It used to say that is a reviewed request.
- **A flag's purpose no longer drops its safe value quietly.** Changing a kill switch or ops flag to a purpose without
  a safe value is refused (422) unless an admin does it in the console, and History records the dropped value.
  `flags push` gets the same refusal.
- **The safe value's value is kept like a served one.** While any environment needs approval, an Editor or
  `flags push` can't change it in place (409): add a new value and make that the safe value.
- **A new flag is in every service, backends too.** The New flag and New release dialogs tick every service at first.
  A new environment copies each flag's services from your first environment, so a Production added later gets the
  flags once they are turned on there.
- **The quickstart starts Production at 0 approvals.** Raise it once a second person can review. Saving an
  environment with more approvals than its reviewers can meet now asks first.
- **Approvals are promised only where an environment requires them**, in the README and on the landing page.

- **A switched-off flag puts none of its values in any file.** Its flagd JSON (CDN files, backends' downloads) has a
  placeholder variant, `{"unused": …}`, instead of one of its values, which could be one entity's. The same for a flag
  whose every answer is the app's code default.
- **The console checks with what you give it.** Debug, Compare and "who gets what" no longer add a platform for an app
  service named `web`, `ios` or `android`: real requests don't send one unless the app does. Set it under **Device
  details**.
- **A number names an entity in the flagd document for many entities too.** `{"brand": 12}` is the brand `12` there,
  as over OFREP, not "no brand".
- **OFREP no longer refuses ordinary keys that look like a dimension.** Only a dimension in another case, plural or
  with separators (`Store`, `stores`, `store_`) is refused; `state`, `stage`, `branch`, `amount`, `store_id` and
  misspellings are left alone, like every key nothing reads.
- **An empty dimension is refused, not read as no entity.** `{"company": ""}` or `null` over OFREP is
  `400 INVALID_CONTEXT`, so a missing join can't get the answers of no entity, which every override for an entity
  matches. In the flagd document for many entities, what OFREP refuses (an entity it doesn't hold, a chain that
  doesn't match, an empty dimension) gets the code's defaults, instead of what the entity above or no entity gets.
- **An entity added a moment ago on another server is answered at once.** Before refusing an entity it doesn't know,
  or an app token for one, an OFREP server looks in the database. The docs now say what the web provider shows after a
  refused context: the previous context's values.

- **Two-factor for admins covers tokens and OAuth.** While an admin must set up two-factor sign-in, their access
  tokens (made before too) are refused, and their MCP clients can't sign in over OAuth or renew a sign-in.
- **An OAuth sign-in lasts 90 days at most.** Refreshing renews it up to 90 days after its person allowed it, never
  past; then the client asks again.
- **The break-glass admin must have a password, and a password link gets anyone back in.** People → Reset password
  now also gives a first password to someone who signed in only with single sign-on, for when the connection was
  removed or the identity provider is down. The link says when single sign-on still blocks it.
- **Nobody approves a change they sent through their own incoming webhook.** A request from an incoming webhook is
  the request of whoever last changed it (its settings or its address), or made it (migration 0025).
- **OIDC sign-ins reach only public addresses.** The token, keys and user info addresses an issuer's settings give
  must be `https` in production and not private, and each sign-in reaches them through the same checked connection
  as the settings.
- **A new app key asks about one entity and works for a year.** Those are the defaults for an app service's key,
  which is public; a backend's key still starts at any entity, until revoked.
- **Editing a required SSO connection can't lock everyone out.** A change to the identity provider's details turns
  the requirement off until a new Test sign-in, and the drawer says so. A new domain signs out only its own people.
- **Group roles never demote by mistake.** A sign-in without the groups claim leaves the role as it is.
- **More security events.** Environment settings (approvals), webhooks out and in, and replaced app links go to
  webhooks with security events, and are in the docs' table.

- **A publish purges and wakes only what changed.** A new entity (also one a backend adds with PUT), a rename or a
  flag's description purges no CDN file and wakes no event stream. An entity's own settings purge only its files and
  those under it, and a replaced app link purges and wakes only that entity's. CDN files carry new tags for this:
  `env-<env>/<entity>` for the entity and each one above it, and `link-<env>/<entity>`.
- **A new entity is served by every server from its first request.** A server that hasn't caught up with the publish
  yet looks at the database before it answers that an entity isn't there (CDN files, app links, flagd JSON).
- **Browsers ask for CDN files every time.** `Cache-Control: public, max-age=0, s-maxage=60`, with
  `CDN-Cache-Control` for the CDN, so a kill switch reaches devices as soon as it reaches the CDN, not up to 11 minutes
  later. A wrong link's `404` says `no-store`.
- **A failed CDN purge shows in `/readyz` and the metrics.** `/readyz` lists `warnings` (still `200`) and each
  environment's `purgeFailing`; the metrics have `companyflags_purge_failing` and `companyflags_warnings`. A token in
  Settings → CDN that can't be read after `BETTER_AUTH_SECRET` changed is a failure now, not a quiet "off".
- **Event stream limits don't make load worse.** A client at its stream limit gets answers with no stream, so its
  provider polls instead of retrying about once a second. A refused stream's `Retry-After` is 60 to 120 seconds.
  The docs say streams count per client address and need `FF_TRUSTED_PROXIES` behind a load balancer, and every web
  snippet sets `pollInterval`.
- **The docs give OFREP's real status for an entity out of scope:** `400 INVALID_CONTEXT`, not `403` (flagd JSON and
  app links answer `403`).

## 0.9.0 (2026-11-20)

What a panel of 10 UX and 10 developer-experience reviewers found, fixed.

**Upgrading from 0.8.0:** stop every instance and start them all on 0.9.0 together (0.8.0 can't read the secrets 0.9.0
seals, and has no `--no-migrate`); from now on, [rolling upgrades](docs/content/docs/self-hosting/upgrading.md) work.
Breaking: the console API says `service` (not `project`) and never picks an environment for you; OFREP refuses dotted
attributes (nest them); a flags file that lists `services` needs `"owns"` to include them; an admin's access token is
On call at most; Compose and the docs pin `0.9`.

### Docs site and README

- **No npm install yet.** The `companyflags` package isn't published on npm, so the docs, the landing page and the
  README no longer show `npx companyflags`. Run it with Docker or from a clone; the CLI runs as `pnpm cli` there.
- **The quickstart keeps its secret.** `BETTER_AUTH_SECRET` goes in `.env` first, so starting the container again
  with the same file keeps everyone signed in and the setup link the same.
- **Old addresses work again.** `/guide/apps`, `/guide/flag-sets`, `/guide/backends`, `/sdk/openfeature`,
  `/sdk/app-file` and `/sdk/cdn-file` send you to the page that has their content now (`docs/scripts/redirects.ts`).
- **Links in `llms.txt`, `llms-full.txt` and each page's `.md` have the site's full address,** so an agent following
  one under `/companyflags/` finds the page.
- **A Testing page** under Reading flags: OpenFeature's in-memory provider in unit tests, a local CompanyFlags in
  integration tests, the same % group every time, and flagd JSON in a file for offline tests.
- **The sidebar leads from the quickstart to reading flags.** Getting started and Reading flags are open; Examples
  and Testing follow the reading pages; moving from another system, the comparison and Enterprise are last. The four
  reading pages have one kind of name everywhere ("Remote evaluation in apps" and so on), and every page has a
  description, which the build checks.
- **Landing page:** a plain headline instead of a superlative, OFREP shown as the `POST` the server takes, with
  OFREP's own reasons, and only the platforms the docs give a way to read flags in.
- **Below 1024px** the docs' sidebar lists the site's links and Resources, and the landing page's menu has light and
  dark. The Resources menu says "GitHub releases" and "Security model", so no name goes to two places.
- **Contrast:** muted text and the green and amber in drawings meet WCAG AA (4.5:1) in both themes. "On this page"
  uses Fumadocs' own block style instead of CSS on its class names.

### Reading flags

- **One flagd for a backend shared by many entities.** `GET /sdk/v1/flagd/service` is one flagd document for every
  entity a backend's secret key may ask about, with the entity picked inside it by the request's dimension keys
  (`{"company": "acme"}`). One document per entity still works.
- **Add entities from your backend as they sign up.** `PUT /sdk/v1/entities/<dimension>/<entity>`, with a backend's
  key for every entity, adds one (or leaves it as it is), so its first request already asks as it.
- **Answers say where they came from.** Each OFREP answer's `flagMetadata` has `revision` and `entity`; a backend's
  secret key also gets `ruleKey`, the rule that decided. A publish that changes nothing for a context is still a `304`.
- **Mistakes in the context are errors, not quiet defaults.** A key that looks like a misspelled dimension
  (`"compnay"`), `"entity"`, and an attribute written dotted (`{"app.version": …}`: flagd JSON reads only nested ones)
  are `400 INVALID_CONTEXT`, saying which. **Change:** dotted attributes worked over OFREP before; nest them.
- **`FLAG_NOT_FOUND` says why** to a backend's key: the flag isn't in this service, or there is no such flag.
- **Change events only for the apps whose answers changed.** Each answer's event stream is for its service and entity;
  a change to one entity's settings no longer wakes every app in the environment.
- **Docs:** the web provider's cache and the entity (a `cacheKeyGenerator` with the dimensions), one meaning for
  `targetingKey`, React Native with polling, mobile attributes per platform, recovering after an app link is replaced,
  server-side rendering, and how soon a flagd backend sees a change.

### Safety

- **On call can turn any flag off in a protected environment, and pause a release,** with a reason and without a
  review. Before, a release mid-rollout (the default purpose) needed an approver.
- **Kill switches and ops flags can name a safe value.** The emergency dialog offers "Serve the safe value" (every
  device gets it, entities' own settings included) and "Stop sending" (no value: each app's code default), and says
  what each does. Only admins name a safe value while an environment needs approval.
- **Any reviewer can stop a scheduled request:** unschedule it (back to approved) or reject it, with a reason. A
  scheduled request that can't apply, a withdrawal and an unschedule are now in History and on the reviews webhook.
- **Archived flags can be restored,** with their key, settings and services as they were (off and in no service where
  an environment needs approval now).
- **Scheduling shows your time zone and refuses a time that has passed** (422), and asks you to confirm.
- The environment drawer warns when its approvals can't be met (one admin and 1 approval), and lowering approvals asks
  first. A flag's page says when a request waits to change it there, and a review says how many % points of devices a
  change moves.

### Flags as code

- **The file says what it owns.** `owns` lists the fields it decides; without it, each flag's definition (details,
  variants, default), and its services only when listed. Rules stay in the console. A field the file doesn't own
  can't be in it. Breaking: a file with `services` and no `owns` needs `"owns"` to list `services` (`flags pull`
  writes it).
- **"Managed in repo".** Each push records what it applied to each flag. The console shows it on those flags, with
  the fields the file owns, and says a change there is undone by the next push. The plan marks each step that undoes
  a console change.
- **`default` applies to existing flags,** as a request where changes need approval.
- **A push again files no second request.** An open request for the same change is reused, and `plan` shows it as
  waiting, with the other open requests on the file's flags.
- **Several repositories on one server:** `scope` (a key prefix, or services) and `source`. A push refuses flags
  outside its scope, or managed by another file.
- **`--reason` and `--link` on `flags push`,** on its requests and in History. In GitHub Actions and GitLab CI the
  link defaults to the pull request.
- **`--json` and `--exit-code`** on `flags plan` and `flags push`.
- **A JSON Schema for flags.json,** on the docs site and at each server's `/flags.schema.json`; `flags pull` writes
  `$schema`.
- **`flags export --flagd`** writes one service's flags as flagd JSON from the database, for tests and offline flagd.
- **`flags unused` reads every OpenFeature SDK's calls:** the `…Details` forms, React hooks, Go, Python, Ruby, .NET
  and Rust. It skips more build folders and flagd JSON files.
- **CI fails on a missing secret.** An empty `--url` or `--token` is an error, and in CI the `flags` commands never
  open an embedded database. The CI recipe uses a Viewer's token to plan and an Editor's to push, with a pinned image.

### Getting started and the flags list

- **The setup checklist goes away when it's done.** It shows above the flags list only while a step is left, and
  dimensions are optional everywhere it speaks. "Connect an app" is done once an app reads flags with a key (`/meta`
  now has `keyLastUsedAt`), and "Add a service" opens Settings → Services.
- **The first flag answers with a value.** New flag starts On / off with the Default `off` (a named value, not the
  in-app default), and says where the flag starts on and where it waits to be turned on.
- **A new key comes with code.** The key drawer shows a curl and OpenFeature's OFREP provider, with the key and the
  server's address filled in (and the flagd JSON download for a backend's key that names one entity).
- **Bulk on/off is one change.** Where nothing is reviewed, the flags switch together in one version; in a protected
  environment they go to approvers as one request.
- **The flags list lives in the address.** The search, filters, sort and environments shown are in the link
  (`#/flags/prod?owner=payments-team`), and saved views keep the search. Selection stays while you page, "Select all
  matching" and Export cover every page, and there's an Overdue filter (past the remove-by date), an "All
  environments" view, a compact density and 50, 100 or 200 rows a page. An environment's versions are in History.

### The flag page and the rule editor

- **"Check who gets what" says when it can't be sure.** Add device details (an app version, a device ID…) to the
  check. When a row on the way reads a detail the check doesn't have, the answer says **Depends on the device** instead
  of naming a row that decides: an override that matches only because a value isn't sent no longer looks certain.
- **Setting an entity's default shows where it comes.** Choose **After the rules for everyone** or **Instead of the
  rules for everyone**; a new default starts after them, so rollouts and kill rules still reach it. The three choices
  have names that say what they do: **Follow what's above**, **Own default last**, **Skip what's above** (the stored
  names are unchanged). Rules for everyone say how many entities skip them.
- **Your publish review shows each setting before and after,** as the approver sees it, and its sentences say what a
  rule was and is, moves, pauses, names and overrides.
- **Splits across several values.** A % rule can serve several variants (50% `a`, 25% `b`, 25% `c`), by device ID or
  session ID, and says what's left for the next row.
- **Rules have names and can be paused** from the editor. A new rule starts with an empty check, not "Service is …".
- **A new value for a variant goes into your draft** and out when you publish, like every other change, instead of
  being saved at once. Each variant says how often it's served here.
- **A release has one page.** It's the flag's page, which opens on a **Rollout** tab; `#/release/…` links land there.
  The tab is in the address (`#/flag/<key>/<env>/<tab>`).
- **"Revision" for an environment's numbered states** (the Revisions tab, "published as revision 12"); "version" is kept
  for app versions and version releases.
- Fixed: the Debug tab could fail on a % rule made in the editor and not yet published.

### Console

- **History is the one place for what changed,** in three views with their own addresses: Changes, Revisions
  (`#/history?view=revisions&env=…`, with roll back) and Requests. Its filters are in the address, so a link shows the
  same list. Old `#/flags/<env>/versions` and `?view=versions` links open History's Revisions. Approvals stays the
  reviewer's inbox.
- **Connect holds what talks to the server:** Services (moved from Settings; `#/settings/services` opens it), API keys,
  Access tokens, Webhooks and Migration. The sidebar has no group named after its only item.
- **⌘K opens a command palette:** flags, entities, pages, settings and actions.
- **The keyboard:** list shortcuts work only while focus is in the list, and j, k, x and / can be turned off in the
  account menu. Going to another page puts focus on its title and says its name. Tabs and choices take the arrow
  keys. Disabled buttons say why to the keyboard and screen readers too. The selected option's focus ring shows.
- **Contrast and motion:** the edges of inputs, checkboxes and switches read at 3:1. With reduced motion, drawers,
  toasts and dialogs fade in place. Toasts stack, and Undo stays 20 seconds without being pushed out.
- **Appearance:** the violet, green, orange and rose accents are gone, since those colors mean something here (a saved
  one becomes indigo, teal or none). Switches and focus rings no longer take the accent. Your own color is darkened or
  lightened per theme until it reads at 4.5:1. The name shows as typed, and the theme toggle can go back to Auto.
- Buttons look the same in any container, page titles use three sizes, and detail pages go back with a crumb.

### Sign-in and administration

- **Leaving the identity provider ends console access within 12 hours.** Where single sign-on is required, a session
  lasts `FF_SSO_SESSION_HOURS` (12) at most, then the identity provider is asked again. Access tokens still last
  until they expire: remove people in People when they leave. The console now says exactly this.
- **One break-glass admin, not every admin.** Where single sign-on is required, only the admin chosen in **Settings →
  Single sign-on → Break-glass admin** keeps a password. Requiring single sign-on asks first, and needs a sign-in with
  the connection before (**Test sign-in**).
- **Two-factor sign-in** for password accounts: an authenticator app's code and ten recovery codes (your account menu
  → Access tokens and two-factor sign-in). An admin can require it of admins with a password. A password reset link
  turns it off for that person.
- **Single sign-on connections can be edited**: domains, the identity provider's details, and **group roles**, which
  give each person a role from their identity provider groups (an OIDC claim or a SAML attribute) at each sign-in.
- **The join role.** People who join without an invite get Viewer, or the role an admin chose (never Admin).
- **Tokens can't hand out access.** Access tokens are refused on people, invites, password resets, single sign-on, the
  sign-in rules, the appearance and lowering an environment's approvals, and are On call at most: an Admin token acts
  as On call. **Alerts tokens** turn kill switches off from Grafana or Datadog and do nothing else.
- **API keys can expire** (30 days to 2 years, or never), shown in the list; an expired key gets `401`.
- **People shows when each person last signed in**, and sign-ins, failed sign-ins, role changes, tokens, keys and
  single sign-on changes are in History and can go to a SIEM: a webhook's new **Security events**.

### HTTP API and operations

- **A stable API for scripts and integrations, `/api/v1`.** Flags per environment (read, on or off), publish,
  History and entities (add or change), with one contract: errors are `{ error, code }` with stable codes, lists
  page with `?limit` and `?cursor` into `{ items, next }`, the environment is in the address, and a service is a
  service. The HTTP API reference says exactly what is stable; the rest of `/api` is the console's own.
- **Errors say what happened, with a code.** Every error of the HTTP API is `{ error, code }`. A key that is taken is
  `409 already_exists` everywhere (a new flag's too, archived flags included); the database's own words go to the log,
  never into an answer; an empty or broken body is `400 bad_json`, never a 500.
- **The console's API never picks an environment.** A request about one environment that doesn't name it gets `400`
  instead of the first environment's data. It says `service` everywhere: `services` in `/api/meta`, the delivery
  change and change requests, `service` on API keys, trace and compare (breaking for scripts that sent `project`).
- **A key scoped to an entity can't learn which entities exist**: `/sdk/v1/links` and `/sdk/v1/flagd` answer it
  `403` for one that doesn't exist, as for one outside its scope, as OFREP does.
- **Operations.** The server says its version (its first log line, `/healthz`, `/api/meta`, `companyflags --version`).
  A publish whose snapshot can't be built is logged every time, and `/readyz` fails while it does and reports each
  environment's publish lag. A new `metrics()` plugin serves Prometheus metrics at `/metrics` (requests, flag reads,
  publish lag, open event streams), and plugins can add middleware. The publish log keeps 30 days
  (`retention.publishLogDays`); history is kept forever. The Docker health check follows `server.port`.
- **Backups and a way off the embedded database**: `companyflags backup` (pg_dump, or a copy of the embedded folder)
  and `companyflags copy-to-postgres <url>`. PGlite is pinned to one version, and a folder made by another Postgres
  major version isn't opened.
- **Rolling upgrades**: `companyflags start --no-migrate` (`FF_MIGRATE=off`) only checks the schema, so
  `companyflags migrate` can run as its own step and the version before keeps running on the new schema. Upgrading
  from 0.8.0, which has no such switch, upgrade the instances together.
- **Secrets kept for other systems are sealed at rest**: the CDN token and webhooks' headers and signing secrets, with
  a key from `BETTER_AUTH_SECRET`. The first start seals the ones saved before (migration 0020). Changing
  `BETTER_AUTH_SECRET` means setting them again.
- **Plugins**: a route outside the plugin's own prefixes, or a prefix of the core's (`/oauth`, `/.well-known`,
  `/healthz`, …), stops the start. `hono` is a peer dependency of the npm package, and `pluginRoutes()` makes a
  plugin's routes. Plugins get `secrets` and `publishState`, and console routes get `body(c)`.
- **Contributors**: `server/schema.sql` (`pnpm schema`) is the current schema, kept up to date by a test; migration
  numbers are checked for collisions; `pnpm format` runs oxfmt.

## 0.8.0 (2026-11-20)

### Security

- **An approved request serves only the values it was approved with.** A request records the value of every variant
  it uses; changing one of them while the request is in review, approved or scheduled in a protected environment is
  refused (422, from the console, `flags push` and import), and a value changed any other way stops the request as a
  conflict instead of going out.
- **Single sign-on creates accounts only at its connection's domains.** Someone invited at another domain must use
  their invite link, which expires. Before, any connection could claim an invited person's account and role.
- **The identity provider's address is checked by the connection that fetches it,** so a name can't answer a public
  address to the check and a private one to the request (DNS rebinding). Its errors no longer repeat what the fetched
  document says.

### Reading flags

- **The same % group everywhere.** flagd JSON (for backends and in the CDN file) buckets on `device.id`, then
  `targetingKey`, then `session.id`, as OFREP and the server do.
- **Full versions.** Rule versions like `6` or `6.0` are saved and written as `6.0.0`, so strict semver evaluators
  read them. Devices should report full versions.
- **Tested against OpenFeature's own flagd evaluator** (`@openfeature/flagd-core`), on random documents and contexts.
  It found one difference, now fixed: empty and `null` values count as missing in both.
- **No fatal error in OpenFeature's web provider.** An entity that doesn't exist or is outside the key's scope gets
  `400 INVALID_CONTEXT`, the same answer either way; 401 and 403 are for bad credentials only.
- **No stale answers with several servers.** A request with a newer `flagConfigEtag` makes the server catch up first,
  every change event reaches its listeners, and the CDN is purged again shortly after a publish.
- **Change-event streams have limits:** 10000 per environment and 100 per client address by default
  (`FF_EVENT_STREAMS_PER_ENVIRONMENT`, `FF_EVENT_STREAMS_PER_CLIENT`), then `429`, and the provider falls back to
  polling.

### Console

- **The entity picker picks by key** and shows each entity's parent, so two entities with the same name are told
  apart. It searches by name and key and lists at most 50. The API key and parent pickers use it too.
- **Clearing the % box keeps the rollout** instead of setting it to 0%; a share is saved only when it's valid.

### Releases and running it

- **Releases wait for CI** on the tagged commit; every GitHub Action is pinned to a commit; images come with
  provenance and an SBOM.
- **Docker Compose (breaking for existing setups):** the image is `${COMPANYFLAGS_VERSION:-0.8}` instead of `latest`,
  `POSTGRES_PASSWORD` is required in `.env` (add `POSTGRES_PASSWORD=companyflags` to keep an existing database's
  password), and the port is bound to `127.0.0.1` (`COMPANYFLAGS_BIND` to change it).
- **`pnpm dev` on a fresh clone** prints the setup link at the console's address (:5173).

### The CDN file, the docs site and the console's menus

- **No more compatibility code; one name for each thing.** The CDN file's plugin is `cdnFiles()` (id `cdn-files`), at
  `/cdn/v1/flags/…`. Gone: `?flagSet=`, the `X-Customer-Id` header, the `customer.*` attributes and history kinds,
  the console's `#/customers` addresses, the "people from before accounts" path and hash version 1 on save. Reading
  flags is described the same way in the docs, on the landing page and in the README.

- **The CDN file is flagd JSON (breaking for apps that read it).** The CDN file, now at `/cdn/v1/flags/…`, answers with the same flagd
  JSON backends get, made for the app service and the entity, so web apps and React Native read it with OpenFeature's
  `@openfeature/flagd-core` instead of code of your own. Off and code-default flags are now in it (the app's default
  still answers), % group names aren't (read them over OFREP), and the device's attributes are nested
  (`{"app":{"version":"6.0.0"}}`). Every file's ETag changes once.

- **Docs: "Reading flags" by who decides.** Six pages: an overview with the four ways (an app or a backend, and the
  server or your code deciding), the evaluation context, remote evaluation in apps and in backends (OFREP), and local
  evaluation in apps (the CDN file, formerly the app file) and in backends (flagd).

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

- **Packaged for npm as `companyflags` (not published yet):** `npx companyflags start` runs the server and the console from any folder, and every
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
