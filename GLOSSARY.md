# CompanyFeatures

Feature flags and remote config: one set of rules for everyone, optional settings per entity of the installation's own dimensions, reviewed changes in protected environments, and answers read with OpenFeature (OFREP, flagd) or from a values-only file per entity and flag set.

## Dimensions

**Dimension**:
One level of what an installation serves config per, such as region, chain or store; the dimensions form one chain, top to bottom, at most four. Each has a key (a rule attribute) and the words people read.
_Avoid_: tenant type, level (a level is a step of the entity chain)

**Entity**:
One entry of a dimension, such as the store acme-12; it can have its own settings on any flag, its own app link and keys. Console users never read this word: they read the dimension's ("Store").
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
A rule that applies before any entity's own settings and that no entity can override.
_Avoid_: locked rule, global override

**Rules for everyone**:
The rules that apply after the own settings of an entity and those above it have not decided.
_Avoid_: base rules, global rules

**Rules only**:
The choice where an entity's rules come first and, if none match, it gets what it would have got without settings of its own: what its parent gets.
_Avoid_: base_rules_then_base_default

**Rules + own default**:
The choice where an entity's rules come first, then the rules of the levels above it and for everyone, then its own default.
_Avoid_: Rules + default, base_rules_then_customer_default

**Own settings only**:
The choice where only the entity's own rules and default count; every level above it and the rules for everyone are skipped, but overrides for everyone still apply.
_Avoid_: Customer only, customer_only

**Code default**:
The value written in an app's own code, which it uses whenever a flag sends nothing.
_Avoid_: fallback, local default

**Trace**:
The explanation of one decision: each level, what it decided, and why any level was skipped.
_Avoid_: debug log

**App file**:
The values-only file one entity's devices read for one flag set in one environment.
_Avoid_: config file, client snapshot

## Reading flags

**Flag set**:
A group of flags sent together, read by an app or a backend, such as `web`, `ios` or `api`; the name is OpenFeature's (flagd and GO Feature Flag use it too). Each has a key that never changes and a kind: for apps (Android, iOS and web, which read it at an app link) or for backends (which read it with an API key). Each flag says which flag sets it is in, per environment. It is `project` in the database, the rule attribute and the console API's JSON; the public addresses say `flagSet`.
_Avoid_: app (for the flag set itself), project (in the console)

**App link**:
An entity's secret in one environment, which lets an app read that entity's flags and nothing else; replacing it stops the old one at once. It comes as an app token or an app file address.
_Avoid_: client key, SDK key

**App token**:
An app's credential for OFREP, `ffl_<environment>.<flag set>.<entity>.<secret>`, made from its entity's app link for one flag set: replacing the link replaces it.

**API key**:
A backend's key for one flag set for backends in one environment: it may ask about its own entity, those below it, or any. Apps never hold one.
_Avoid_: server key, secret

**OFREP**:
OpenFeature's remote evaluation protocol: the server answers every flag for a credential and an evaluation context. How apps read flags.

**flagd JSON**:
One entity's rules in one flag set, as a flagd document (`flagSetId` `<environment>/<flag set>/<entity>`), for a backend that evaluates them in-process.

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
An on-call person turning a flag off in a protected environment without review, with a stated reason that is recorded.
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
Finishing a release: it is removed from the code, taken out of every flag set, and archived.
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
Whoever makes the first account on a new install, or, on a database that has people but no accounts yet, an existing admin.
_Avoid_: owner, superuser

**Signup domain**:
An email domain whose people may join as viewers when Google, GitHub or Microsoft confirms their email.
_Avoid_: allowed domain, whitelist

**Single sign-on connection**:
Your organization's identity provider, added by an admin for its email domains; people at those domains may join through it as viewers.
_Avoid_: SSO provider (in the console), IdP config

**Require single sign-on**:
A connection's setting that stops password sign-ins and password accounts at its domains, except for admins.
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
`companyfeatures.config.ts`, the optional typed file (`defineConfig`) that says which database, sign-in and plugins a server runs with; what it leaves out comes from environment variables, then the defaults. The server and the CLI read it.
_Avoid_: settings file, .env (CompanyFeatures doesn't read one)

**Plugin**:
A part of the server an installation turns on in its config file: a way to read flags (`ofrep()`, `flagd()`, `appFiles()`) or something that runs after a publish (`cloudflare()`). Made with `definePlugin`; all the built-in ones run when the config doesn't list any.
_Avoid_: extension, add-on, integration

**Core**:
What every server runs, plugins or not: the console and its API, sign-in, the evaluator, approvals, the change journal, publishing and app links.

**CLI**:
The `companyfeatures` command: `start`, `init`, `secret`, `migrate`, and `flags pull`, `plan` and `push`.

**Flags file**:
The JSON file of flags as code (`flags.json`): each flag's details, variants and flag sets per environment, kept in step by `flags push`. Rules stay in the console.
_Avoid_: flag manifest, flags.yaml
