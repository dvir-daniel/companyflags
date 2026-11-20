# Glossary

The words CompanyFlags uses, and the ones it avoids. CompanyFlags is feature flags and remote config: one set of rules for everyone, optional settings per entity of the installation's own dimensions, reviewed changes in protected environments, and answers read with OpenFeature (OFREP, flagd) or from a values-only file per entity and service.

## Dimensions

**Dimension**:
One level of what an installation serves config per, such as region, chain or store; the dimensions form one chain, top to bottom, at most four. Each has a key (a rule attribute) and the words people read.
_Avoid_: tenant type, level (a level is a step of the entity chain)

**Entity**:
One entry of a dimension, such as the store acme-12; it can have its own settings on any flag, its own app link, and keys that ask about it. Console users never read this word: they read the dimension's ("Store").
_Avoid_: member, tenant, customer (as the general word)

**Parent**:
The entity right above another, in the dimension above; an entity follows its parent's settings unless it has its own.
_Avoid_: company (as the general word), owner

## Deciding a value

**Entity chain**:
The ordered levels that decide what an entity gets for a flag: overrides for everyone, the entity's own settings, those of each entity above it up to the top, rules for everyone, then the most specific default.
_Avoid_: inheritance chain, fallback chain, customer chain

**Level**:
One step of the entity chain; a level can decide, pass to the next, or be skipped.
_Avoid_: tier, stage

**Override for everyone**:
A rule that applies before any entity's own settings and that no entity can override (a locked rule).
_Avoid_: global override

**Rules for everyone**:
The rules that apply after the own settings of an entity and those above it have not decided.
_Avoid_: base rules, global rules

**Follow what's above**:
The choice where an entity's rules come first and, if none match, it gets what it would have got without settings of its own: what its parent gets.
_Avoid_: Rules only, base_rules_then_base_default

**Own default last**:
The choice where an entity's rules come first, then the rules of the levels above it and for everyone, then its own default. On the flag page: a default "after the rules for everyone".
_Avoid_: Rules + own default, base_rules_then_customer_default

**Skip what's above**:
The choice where only the entity's own rules and default count; every level above it and the rules for everyone are skipped, but overrides for everyone still apply. On the flag page: a default "instead of the rules for everyone".
_Avoid_: Own settings only, Customer only, customer_only

**Code default**:
The value written in an app's own code, which it uses whenever a flag sends nothing.
_Avoid_: fallback, local default

**Trace**:
The explanation of one decision: each level, what it decided, and why any level was skipped.
_Avoid_: debug log

**CDN file**:
The flagd JSON file one entity's devices read for one app service in one environment, cached by a CDN: its values, and only the checks the device makes.
_Avoid_: app file, config file, client snapshot

## Reading flags

**Service**:
What reads your flags: one of your apps or backends, such as `web`, `ios` or `api`. Its API key picks which flags it reads; the evaluation context picks whose values it gets. It has a key that never changes and a kind, **App** or **Backend**. Each flag says which services it is in, per environment. It is `project` in the database, the API's JSON and the rule attribute; the console, the public addresses (`?service=`) and the flags file (`services`) say service.
_Avoid_: flag set (flagd's word: a flagd flag set is one entity's flags in one service), app (for the service itself), project (in the console), a service per customer (per-entity values are dimensions)

**App** (kind of service):
A service for apps on your users' devices: web, iOS, Android. It gets values only, never the rules. Its kind is `client` in the API.
_Avoid_: client (in the console), frontend

**Backend** (kind of service):
A service for your own servers. It gets values over OFREP or the rules as flagd JSON, and hands out app links. Its kind is `server` in the API.
_Avoid_: server (in the console), API (as the kind)

**API key**:
A key for one service in one environment, made by an admin on the API keys page; it may ask about its own entity, those below it, or any. Either an app key or a backend key, by the service's kind. Only its hash is kept.
_Avoid_: SDK key, token (for a key)

**App key**:
An app service's API key (`ff_<environment>_<service>_…`). It is public: it goes in the app's OFREP provider, and reads that service's values only, for the context the app sends. It can't download flagd JSON or hand out app links (`403`).
_Avoid_: client key, publishable key

**Backend key**:
A backend service's API key. It is secret: it stays on your servers, and reads values over OFREP, the rules as flagd JSON, and app links. A request with a backend key and an `Origin` header (a browser) is refused (`403`).
_Avoid_: server key, secret key

**App link**:
An entity's signed link in one environment: the optional way to give an app a signed context, so it reads as that entity and no other. A backend hands it to the app at sign-in, as an app token or a CDN file address; replacing it stops the old one at once. With an app key alone, the entity in the context is targeting, not proof.
_Avoid_: client key, SDK key

**App token**:
An app's signed credential for OFREP, `ffl_<environment>.<service>.<entity>.<secret>`, made from its entity's app link for one service, used in place of the app key: replacing the link replaces it.

**OFREP**:
OpenFeature's remote evaluation protocol: the server answers every flag for a credential and an evaluation context. How apps read flags, with their app key or app token, and how backends can.

**flagd JSON**:
One entity's rules in one backend service, as a flagd document: a flagd flag set, with `flagSetId` `<environment>/<service>/<entity>`, for a backend that evaluates them in-process. Only a backend key downloads it.

## Changing flags

**Draft**:
One person's unpublished edits to one or more flags in one environment.
_Avoid_: pending change

**Change set**:
What a draft becomes in a protected environment: one request covering every flag in it, reviewed before it applies.
_Avoid_: pull request, approval

**Protected environment**:
An environment where a change needs at least one approval, by someone other than its author, before it applies.
_Avoid_: prod (as a synonym)

**Break-glass**:
On call or an admin applying one change at once in a protected environment, with a recorded reason: turning a kill switch or ops flag off, or rolling a version release back.
_Avoid_: emergency override, bypass

**Version**:
One numbered step in an environment's history of changes.
_Avoid_: revision (in the console)

**Restore**:
Putting the flag settings of an environment back as they were at an earlier version; changes of other kinds are listed but not undone.
_Avoid_: rollback of everything, revert

## Releases

**Release**:
A flag whose purpose is to turn a new feature on step by step, then be removed; it has its own page, and is a flag like any other underneath.
_Avoid_: rollout flag, launch

**Step**:
Where a release is in one environment: not started, early access only, a % of devices, everyone, paused or off.
_Avoid_: stage (a level of the entity chain is never called that either)

**Early access**:
The entities a release gives the new feature to on every device, whatever its % is (before dimensions: targeted customers).
_Avoid_: beta, canary, targeted customers

**Clean up**:
Finishing a release: it is removed from the code, taken out of every service, and archived.
_Avoid_: delete, retire

## People and access

**Person**:
Someone who uses the console, known by their email; their role decides what they may do.
_Avoid_: user, member

**Account**:
A way a person signs in: a password, Google, GitHub or Microsoft, or single sign-on, all for their one email.
_Avoid_: login, user

**Invite**:
A link an admin makes for one person's email; it lets them make a password account, once, within 7 days.
_Avoid_: invitation code, magic link

**Admission**:
The decision whether someone may sign in or make an account, made in one place for every way of signing in.
_Avoid_: join policy, sign-up check

**First admin**:
Whoever makes the first account with the setup link: on a new install, whoever opens it; on a database that has people but no accounts yet, an existing admin.
_Avoid_: owner, superuser

**Setup link**:
The link a new server prints at every start while nobody has an account (`/api/setup/<secret>`); only it can make the first account, the admin's. Its secret is made from `BETTER_AUTH_SECRET`, and it stops working once the first account exists.
_Avoid_: bootstrap token, claim link

**Signup domain**:
An email domain whose people may join as viewers when Google, GitHub or Microsoft confirms their email.
_Avoid_: allowed domain, whitelist

**Single sign-on connection**:
Your organization's identity provider, added by an admin for its email domains; people at those domains may join through it as viewers.
_Avoid_: SSO provider (in the console), IdP config

**Require single sign-on**:
A connection's setting that stops password, Google, GitHub and Microsoft sign-ins and password accounts at its domains, except for admins; turning it on signs the others out.
_Avoid_: SSO only, enforce SSO

**Password reset link**:
A link an admin makes in People for someone with a password: it works once, for a day, sets a new password and signs them out everywhere.

**Remove access**:
An admin ending someone's access: they are signed out everywhere at once and their accounts are deleted, but they stay listed and named in History.
_Avoid_: delete user, deactivate, ban

**Invite again**:
A new invite for someone whose access was removed; it gives them back the role they had.
_Avoid_: restore user, reactivate

## Running it

**Config file**:
`companyflags.config.ts`, the optional typed file (`defineConfig`) that says which database, sign-in and plugins a server runs with; what it leaves out comes from environment variables, then the defaults. The server and the CLI read it.
_Avoid_: settings file, .env (CompanyFlags doesn't read one)

**Plugin**:
A part of the server an installation turns on in its config file: a way to read flags (`ofrep()`, `flagd()`, `cdnFiles()`) or something that runs after a publish or a change (`cloudflare()`, `webhooks()`). Made with `definePlugin`; all the built-in ones run when the config doesn't list any.
_Avoid_: extension, add-on, integration

**Core**:
What every server runs, plugins or not: the console and its API, sign-in, the evaluator, approvals, the change journal, publishing, API keys and app links.

**CLI**:
The `companyflags` command: `start`, `init`, `secret`, `migrate`, and `flags pull`, `plan` and `push`.

**Migration (moving over)**:
Moving to CompanyFlags from another config system with both running side by side: its values are imported, apps ask CompanyFlags first and the old system for the rest (OpenFeature's Multi-Provider), and a flag moves when it's added to the app's service. Not to be confused with a database migration (`server/migrations/`, `companyflags migrate`).
_Avoid_: cut-over, big-bang switch

**Import / export**:
One environment's values in or out of CompanyFlags: CompanyFlags values, key-value JSON, flagd, or any JSON through a JSONata expression. An import shows every change first and goes through the console's checks and approvals.

**Webhook**:
Out: a message after each change (signed JSON, a Slack message, or JSONata's shape), in order, once each. In: an address another system posts its values to, which are imported. Both are the `webhooks()` plugin's.
_Avoid_: callback, hook (alone)

**Flags file**:
The JSON file of flags as code (`flags.json`): each flag's details, variants and services per environment, kept in step by `flags push`. Rules stay in the console.
_Avoid_: flag manifest, flags.yaml
