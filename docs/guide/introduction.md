# Introduction

CompanyFeatures is the most comprehensive open-source framework for **feature flags and remote config**. It decides
what every app and backend gets: rules for everyone, % rollouts and releases, settings for any part of your product
(a region, a store, a team, a customer: you define the dimensions), with reviewed changes and a full history. Apps and
backends read it through OpenFeature.

You run it yourself: one Node.js server with a web console, and Postgres for the data.

## Who it's for

- **Teams that want flags they own**, run on their own servers and read with OpenFeature in every app and backend,
  so the code that reads flags stays standard.
- **Products whose config differs by part**: per region, store, team or customer, where a setting should follow a
  chain (a region's stores, a company's brands) unless one of them has its own.
- **Teams that need change control**: approvals in production, scheduled changes, break-glass for on call, an
  append-only history and restore.
- **Products with many devices** that don't want rules or lists of entities sent to every phone, or a bill that
  grows with every request.

## How it works

1. **You describe your business.** In **Settings → Dimensions** you say what config is served per: `customer`, or
   `company` › `brand`, or `region` › `chain` › `store`. Each customer, brand or store is an **entity**.
2. **You set flags.** Each flag has rules for everyone ("10% of devices", "app version below 5.0"), and any entity can
   have settings of its own. An entity follows its parent's settings until it has its own. Locked rules apply to
   everyone, always.
3. **Apps and backends ask with OpenFeature.** Apps use OpenFeature's own OFREP providers (web, Android, iOS) with
   their entity's token; backends use an API key, or download their entity's rules as [flagd](https://flagd.dev) JSON
   and evaluate them in-process. For very large fleets, each entity's values are also one file your CDN caches.

```text
console ──► server (rules, approvals, history) ──► Postgres
              │
              ├── OFREP ──────────────► apps (web, iOS, Android) with OpenFeature's providers
              ├── flagd JSON / OFREP ─► backends with OpenFeature
              └── app files ──► your CDN ──► very large fleets, no request reaches the server
```

![The console: a release flag, with an override for old Android builds, Acme Corp's own setting, and 10% of devices](/screenshots/console-flag.png)

## What makes it different

- **Your words.** Dimensions are yours to name, and rules read in them: "Brand is Lumen", "Company is Globex".
- **Settings that follow the chain.** A brand follows its company's settings until it has its own; a company follows
  the rules for everyone. Each answer can be traced step by step in the console.
- **OpenFeature, no SDK of ours.** Apps and backends use OpenFeature's own providers (OFREP, flagd), so you can switch
  to or from CompanyFeatures without touching the code that reads flags.
- **Privacy by construction.** A device asks as its own entity, with a token it can't change. Checks on dimensions,
  apps and environments are settled on the server, so a device never receives a list of customers, another customer's
  value, or a rule.
- **Change control built in.** Protected environments, approvals by someone other than the author, scheduled
  changes, break-glass for on call, an append-only history, and restore.

## What it doesn't do (yet)

CompanyFeatures is before 1.0. It is tested (about 370 tests, on embedded and real Postgres) but young. Not built yet:

- experiment statistics (name your % groups and send them to your own analytics instead);
- sending email: invite and password reset links are made by an admin and sent by hand; SCIM provisioning;
- secret values: don't put secrets in flag values.

## Next

- [Quickstart](/guide/quickstart): run it with sample data in one command.
- [How it fits together](/guide/concepts): environments, apps, dimensions, flags and rules.
- [Compared with others](/guide/comparison): when CompanyFeatures fits, and when it doesn't.
