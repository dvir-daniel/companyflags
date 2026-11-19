# Compared with others

Feature-flag tools mostly differ in two things: **who decides the answer** (a service per request, the SDK with the
rules, or a file per audience) and **what the model knows about your customers**. Here is where CompanyFeatures sits,
so you can tell quickly whether it fits.

## When CompanyFeatures fits

- **You sell to businesses, and each needs its own settings.** Customers, brands, stores and regions are part of the
  model: each entity has settings of its own on any flag, inherited down your chain, with locked rules on top.
  Elsewhere this is usually a segment or a targeting rule per customer, which gets long at a few thousand customers.
- **You use OpenFeature.** Apps and backends read flags through OpenFeature's own providers (OFREP, flagd); there is
  no SDK of ours to adopt or to leave.
- **You have very many devices.** Besides OFREP, each entity's values are one file your CDN caches, built once per
  publish, so cost need not grow with devices.
- **Apps must not see more than they need.** A device gets its own values, never the rules or other customers'
  values, which matters when the rules themselves name your customers.
- **You want to run it yourself.** One Node.js server and Postgres, your own sign-in (SAML or OIDC), MIT licensed, no
  account to create anywhere.

## When something else fits better

- **Experiments with statistics.** CompanyFeatures splits devices into named % groups and leaves the analysis to your
  own analytics. Tools built for experimentation compute results for you.
- **Targeting by each user's own profile** (their plan, their sign-up date). Rules here check entities and what a
  device reports about itself, from a fixed list of [attributes](/reference/attributes); your own per-user attributes
  aren't in it yet.
- **A hosted service.** CompanyFeatures has no hosted version.

## How the answer is decided

| | Where rules run | What a device receives | Cost grows with |
|---|---|---|---|
| A service evaluating per request | The service | One answer per request | Requests |
| SDKs with the rule set | The device | Every rule, often with the lists in them | Devices × checks (mostly cached) |
| **CompanyFeatures, OFREP** | The server, per request, in memory | Its entity's answers for its context | Requests (small, mostly 304s) |
| **CompanyFeatures, app file** | The server, once per publish; device facts on the device | Its entity's values, plus checks on its own facts | Publishes and cache misses |

## Standards

- **OpenFeature.** OFREP 0.4 for OpenFeature's providers on the web, Android, iOS and servers, and flagd JSON that
  OpenFeature's flagd provider evaluates in Go, Java, Node.js, .NET, Python and Rust.
- **flagd.** A % of devices is flagd's `fractional`, with the same hash, so a backend and an app put each device in the
  same group.

## Moving from another tool

There is no importer yet. A flag maps to a CompanyFeatures flag with variants; a segment of customers usually maps to
a rule on a dimension ("Company is one of …") or to settings on each entity; a percentage rollout maps to a % of
devices.
