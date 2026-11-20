---
title: "Compared with others"
---

Feature-flag tools mostly differ in two things: **who decides the answer** (a server per request, the SDK with the
rules, or a file per audience) and **what the model knows about how your product is organized**. Here is where CompanyFlags sits,
so you can tell quickly whether it fits.

## When CompanyFlags fits

- **Parts of your product need their own settings.** Regions, stores, teams or customers are part of the model: each
  entity has settings of its own on any flag, inherited down your chain, with locked rules on top. Elsewhere this is
  usually a segment or a targeting rule per part, which gets long at a few thousand of them.
- **You use OpenFeature.** Apps and backends read flags through OpenFeature's own providers (OFREP, flagd); there is
  no SDK of ours to adopt or to leave.
- **You have very many devices.** Besides OFREP, each entity's values are one file your CDN caches, built once per
  publish, so cost need not grow with devices.
- **Apps must not see more than they need.** A device gets values, never the rules or lists of entities, which
  matters when the rules themselves name them. A signed app link keeps each app to its own entity's values.
- **You want to run it yourself.** One Node.js server and Postgres, your own sign-in (SAML or OIDC), MIT licensed, no
  account to create anywhere.
- **You're moving from something else.** CompanyFlags runs next to the system you have now and takes over one flag at
  a time, so there is no day when everything switches.

## When something else fits better

- **Experiments with statistics.** CompanyFlags splits devices into named % groups and leaves the analysis to your
  own analytics. Tools built for experimentation compute results for you.
- **Targeting by each user's own profile** (their plan, their sign-up date). Rules here check entities and what a
  device reports about itself, from a fixed list of [attributes](/reference/attributes); your own per-user attributes
  aren't in it yet.
- **Someone else running it.** CompanyFlags has no hosted version.

## How the answer is decided

| | Where rules run | What a device receives | Cost grows with |
|---|---|---|---|
| A hosted server evaluating per request | That server | One answer per request | Requests |
| SDKs with the rule set | The device | Every rule, often with the lists in them | Devices × checks (mostly cached) |
| **CompanyFlags, OFREP** | The server, per request, in memory | Its entity's answers for its context | Requests (small, mostly 304s) |
| **CompanyFlags, CDN file** | The server, once per publish; device facts on the device | Its entity's values, plus checks on its own facts | Publishes and cache misses |

## Standards

- **OpenFeature.** OFREP 0.4 for OpenFeature's providers on the web, Android, iOS and servers, and flagd JSON that
  OpenFeature's flagd provider evaluates in Go, Java, Node.js, .NET, Python and Rust.
- **flagd.** A % of devices is flagd's `fractional`, with the same hash, so a backend and an app put each device in the
  same group.

## Moving from another tool

You don't switch on one day. [Moving from another system](/guide/migration) runs CompanyFlags next to the tool you
have now: import its values (key-value JSON, flagd, or any shape through a JSONata expression), and apps read the old
tool, through OpenFeature's Multi-Provider, for every flag not moved yet. Webhooks out and in keep both the same until
the last flag is here.

What comes over as it is: each flag's value for everyone, on/off, variants and entities' own values. What you set
again here: a segment of customers usually becomes a rule on a dimension ("Company is one of …") or settings on each
entity, and a percentage rollout becomes a % of devices.
