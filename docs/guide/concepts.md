# How it fits together

CompanyFeatures has a few parts that build on each other. You set up **environments**, **flag sets** and your
**dimensions** once. Then you create **flags**, give them **values** and **rules**, and let any **entity** (a customer,
a company and its brands, a store) have settings of its own. Every answer, whether over OFREP, in a backend's flagd
JSON or in the console's trace, comes from the same evaluator.

This page walks through each part. The pages linked at the end go into detail.

<IllusChain />

One flag, in one environment, asked by a device of Acme Kids, is decided in this order:

<IllusOrder />

## Environments

An environment is a separate copy of every flag's settings: Development, Staging, Production. You add them in
**Settings → Environments**. Each one has:

- its own settings on every flag (on or off, rules, defaults), and its own list of the flag sets each flag is in;
- **Approvals needed**, from 0 to 5. With 1 or more it is a protected environment: every change there is reviewed by
  someone other than its author before it applies. See [Approvals and history](/guide/approvals);
- numbered **versions**. Every change that alters what the environment serves makes a new one, and you can restore an
  earlier one;
- its own secret app links and API keys.

A flag exists in every environment. A new flag starts off in every protected environment, and every flag starts off in
an environment you add later: turning it on there is a change like any other.

## Flag sets

A **flag set** is a group of flags sent together. In **Settings → Flag sets** you add one for each app that runs on
your users' devices (`web`, `ios`, `android`: a flag set **for apps**) and each backend (`api`: a flag set **for
backends**). Its key never changes. On each flag you choose which flag sets it is in, per environment. A flag that
isn't in a flag set doesn't exist for the app or backend that reads it.

Both get their flags through [OpenFeature](https://openfeature.dev), with OpenFeature's own providers:

| Who | How |
|---|---|
| Apps | OFREP (OpenFeature Remote Evaluation Protocol), with their app token (made from their entity's app link, for their flag set): the server evaluates the flags for that entity and the device's context. |
| Backends | OFREP with an API key, naming the entity in the evaluation context; or flagd JSON (one entity's flags, evaluated in-process by flagd or OpenFeature's flagd provider). |

The credential decides the environment, the flag set, and which entities a request may be about: an app's token is
its own entity only; a backend's API key is its entity, the ones below it, or any. Apps never hold an API key. See
[Flag sets](/guide/flag-sets), [Backends](/guide/backends) and [OpenFeature](/sdk/openfeature).

## Dimensions and entities

A **dimension** is one level of what your installation serves config per. You define one chain of up to four in
**Settings → Dimensions**, in your own words: `customer`, or `company` › `brand`, or `region` › `chain` › `store`.

An **entity** is one entry of a dimension: the company `globex`, the brand `lumen`, the store `acme-12`. An entity can
have a **parent** in the dimension right above it (Lumen's parent is Globex). Every entity, at any level, can have its
own settings on any flag, its own app link and its own API keys. See [Dimensions](/guide/dimensions).

## Flags and values

A flag has a key your code reads (`new_checkout`), a value type (on/off, text, number or JSON) and a purpose (release,
kill switch, ops, experiment, config or permission). The purpose sets a few limits, such as "permission flags can't use
a % of devices".

A flag's values are either **named variants** (`standard` = 100, `enterprise` = 1000 for `max_upload_mb`) or **free
values** you type straight into the rules and defaults. See [Flags and rules](/guide/flags-and-rules).

## Rules and attributes

A rule is a list of checks and what to serve when they all pass: one value, or a % of devices. A check reads an
**attribute**:

- what the server works out from who is asking: the flag set (from the link or API key), and one attribute per dimension
  ("Company is Globex" covers Globex, Lumen and Bolt), plus `entity` for exactly the one asking;
- what the app reports about itself: `app.version`, `device.id`, `device.os`, `locale.language`, `geo.country` and so on.

The first rule that matches decides. If none does, a default does. See the full list in
[Attributes](/reference/attributes).

## Each entity's own settings

On a flag where an entity has no settings of its own, it gets what its parent gets. Its parent follows its own parent,
up to the top, and the top follows everyone's settings. Once an entity has settings of its own, they come first, in one
of three ways:

| Choice | What the entity gets |
|---|---|
| **Rules only** | Its rules first. If none match, whatever its parent gets (at the top: what everyone gets). |
| **Rules + own default** | Its rules, then the rules of each level above it and everyone's, then its own default. |
| **Own settings only** | Only its rules and its default. Every level above it and the rules for everyone are skipped. |

For example, Globex has its own `api_base_url` (Rules + own default, serving `https://globex.api.example.com`),
so Lumen and Bolt get that address too, with no settings of their own.

## Overrides: locked rules that fail closed

An **override** is a rule for everyone that is checked before any entity's own settings, and no entity can change it.
Use it for what must hold everywhere, like the sample's "Android below 5.0 can't run it" on `new_checkout`.

Overrides **fail closed**. When a check can't be decided because the app didn't send the attribute, or sent a value that
can't be read (a version like `abc`), an ordinary rule doesn't match, but an override does. So if an Android build
doesn't report its version, the override still keeps the new checkout off.

## The code default

Anywhere a value is served (a rule, a part of a %, a default, an entity's own default) you can choose **Use code
default (in-app)**. The flag then sends no value, and the app keeps the default written in its own code. When a flag is
switched off, it sends nothing at all, so every app uses its code default. Make that the safe value.

## A % of devices, and group names

A rule can serve a value to a % of devices instead of to everyone it matches. Each device lands in one of 10,000
buckets, from a hash of the rule's salt and the device's `device.id`, so the same device stays in the same group on
every request, on the server and in flagd. A device that sends no `device.id` is not inside the % (unless the rule
names a backup ID), and the next rule decides.

A % rule can name its groups, for example `new-checkout` inside and `old-checkout` outside. The evaluator's answer then
carries the device's group in its metadata (`group`), so you can add it to the analytics events you already send.
flagd JSON has no place for group names.

## One evaluator

[`server/evaluator.ts`](https://github.com/dvir-daniel/companyfeatures/blob/main/server/evaluator.ts) is the only
place the order above is written. It is behind:

- **OFREP answers.** The server evaluates each flag for the entity and the attributes in the request.
- **flagd JSON for backends.** For one entity, the server settles everything it knows (the flag set, the environment,
  every dimension) and writes the rest as flagd's JsonLogic, so flagd or OpenFeature's flagd provider gives the same
  answers in your backend. No list of entities and no other entity's value is in it.
- **App files.** The same settling, as a values-only file per environment, flag set and entity, built on publish and
  cached by a CDN. What only the device knows stays as short `when` lines.
- **The trace.** The flag page's **Debug** tab runs the evaluator for an entity, a flag set and the attributes you type,
  and shows each step: which levels were checked, each check with the value it read, the device's bucket, what was
  skipped and why.

The server's tests check that flagd's answer from the JSON, and a pick from an app file, always equal the evaluator's.

## Where to next

- [Dimensions](/guide/dimensions): define your chain, and the exact evaluation order.
- [Flags and rules](/guide/flags-and-rules): purposes, values, operators, % of devices and the trace.
- [Releases](/guide/releases): turn a feature on step by step, or move devices from one version to the next.
- [Approvals and history](/guide/approvals): protected environments, break-glass, versions and restore.
- [Attributes](/reference/attributes): every attribute a rule can check.
