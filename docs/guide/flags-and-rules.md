# Flags and rules

A flag is a key your code reads, with values and the rules that pick one. This page covers what a flag is made of,
every operator a rule can use, a % of devices, and how to see why a device got its value.

## What a flag has

| Part | Rules |
|---|---|
| Key | What your code reads: `new_checkout`. Lowercase letters, digits and `_`, starting with a letter. It never changes. |
| Name | Optional, up to 80 characters: "New checkout". |
| Value type | On/off, text, number or JSON. Every value must be of that type. |
| Purpose | One of the six below. |
| Owner, description, tags | Optional. Up to 10 tags of lowercase letters, digits and dashes (up to 32 characters each). |
| Remove by | A date. Required for releases and experiments. |

### Purposes

The purpose says what the flag is for, and sets a few limits:

| Purpose | For | Limits |
|---|---|---|
| Release | Turning a new feature on step by step, then removing the flag. It has its own page in **Releases**. | Needs a remove-by date, unless it is a [version release](/guide/releases#version-releases). |
| Experiment | Comparing variants. | Needs a remove-by date. |
| Kill switch | Turning something off fast. | On call and admins can turn it off in a protected environment without a review ([break-glass](/guide/approvals#break-glass)). |
| Ops | A long-lived operational toggle. | Same break-glass as a kill switch. |
| Config | Remote settings, like an API address or a limit. | None. |
| Permission | Who may use a feature. | No % of devices: device IDs come from the app and can be faked. |

Only releases and experiments may give a % rule a backup ID (see below). Changing a flag's purpose re-checks its
settings in every environment, and is refused if any would no longer save, for example a % rule on a flag becoming a
permission flag.

## Values: named variants or free values

Each flag has a **Variants** setting, in its Settings tab. It is on by default.

- **Variants on.** Rules and defaults pick from named values, listed in the Variants tab: `max_upload_mb` has
  `standard` = 100 and `enterprise` = 1000. Keys use lowercase letters, digits, `_` and `-`.
- **Variants off (free values).** You type any value straight into a rule or a default. Each distinct value is stored
  once, as a hidden variant. Typing a new one changes nothing anyone gets, so it writes no history; the save that serves
  it is the change.

On/off flags always have `true` and `false`. Version releases always use free values.

In a protected environment, a value that environment serves can't be changed in place. Add a new value and point the
rules at it: that change is reviewed.

## Rules

A rule has a list of checks and what to serve when they **all** pass: one value, or a % of devices. A rule with no
checks applies to every request. Rules are tried in order, and the first one that matches decides. Where rules sit in
the chain (overrides, each entity's own rules, the rules for everyone) is in
[Dimensions → Evaluation order](/guide/dimensions#evaluation-order).

From the sample data, on `max_upload_mb`:

```text
Rule "Enterprise companies"   Company is Acme Corp or Globex   → enterprise (1000)
Default                                                         → standard (100)
```

Acme Kids and Lumen get 1000 too: "Company is …" covers each company's brands.

### Operators

Each attribute has a type, and the type decides which comparisons the rule editor offers. The checks are in
[`server/evaluator.ts`](https://github.com/dvir-daniel/companyfeatures/blob/main/server/evaluator.ts) (`testCondition`).

| Type | Editor wording | Operator | Passes when |
|---|---|---|---|
| Text | is / is not | `in` / `not_in` | The value is (or isn't) one of the listed values, compared as text. |
| Text | starts with / ends with | `starts_with` / `ends_with` | It starts (ends) with any listed value. |
| Version | is below / is at most / is above / is at least / is exactly | `semver_lt` `semver_lte` `semver_gt` `semver_gte` `semver_eq` | Compared as versions, against the first value. |
| Whole number | is below / is at most / is above / is at least | `lt` `lte` `gt` `gte` | Compared as numbers, against the first value. |
| Whole number | is / is not | `in` / `not_in` | One of the listed values (or not). |
| List | include / don't include | `contains_any` / `contains_none` | The list holds any (none) of the values. No built-in attribute is a list today. |
| Any | is set / is not set | `exists` / `missing` | There is a value (there isn't). |

Versions are read leniently, as devices report them: `5.10` is above `5.9`, `5` equals `5.0.0`, a leading `v` is
allowed, `+build` is ignored, and a prerelease (`6.0.0-beta.1`) sorts below its release. A version in a rule must look
like one (`5.0.0`), and a whole number must be whole.

### Missing values

"Is set" and "is not set" always decide. Every other check needs a value. When the attribute is missing (not sent,
`null` or an empty string) or can't be read (a version like `abc`), the check can't be decided:

- an **ordinary rule doesn't match**, and the next rule is tried. That goes for "is not" too: "Country is not US" doesn't
  match a request with no country;
- an **override matches**: it fails closed (see below).

A dimension below the one asking is "none", which is different: only "is not", "is not set" and "don't include" pass,
in overrides too. See [Dimensions](/guide/dimensions#rules-on-dimensions).

## A % of devices

Instead of one value, a rule can serve values to a % of the devices it matches:

- **Buckets.** Each device lands in one of 10,000 buckets. A part of the % is a range of buckets, `[from, to)`, so
  1000–2500 is 15%. One rule can have several parts, each serving its own value. Buckets in no part don't match, and the
  next rule decides.
- **By device ID.** The bucket is worked out from `device.id`. A device that sends none never matches the %. The API also
  accepts `session.id` (not sticky across sessions), a dimension or `entity` (all devices of an entity together); the
  console's rule editor splits by device ID only.
- **Backup ID.** Release and experiment flags may name a second ID to use when the first is missing. It changes who is
  inside, so other purposes can't use one. The console doesn't offer it.
- **Sticky.** The hash takes the rule's salt (the flag key, unless set) and the ID, so a device stays in its group on
  every request. Growing or shrinking the % moves only a part's end, so devices inside stay inside. Changing a part's
  value keeps its devices. A save that would move devices between groups (a new salt, another ID, a part that starts
  elsewhere) is refused unless you confirm the reshuffle.
- **Hash version 2.** MurmurHash3 (x86, 32-bit) of `<salt>/<ID>`, encoded as a CBOR text string, mapped to 0–9999. That is
  flagd's `fractional` with the bucketing value `{"cat": ["<salt>/", <device ID>]}` and weights out of 10,000, so a device
  is in the same group on the server and in flagd. Pin the flagd version you run, and treat a flagd upgrade that changes
  `fractional` as a migration.

### Group names

A % rule can name its groups: one name per part, and one for devices the rule applies to that land **outside** the %.
Names use letters, digits, `_`, `-` and `.`, up to 64 characters, each different.

The answer then carries the device's group in its metadata (`group`), for your own analytics. Devices the rule doesn't
apply to (another app, an older version, no device ID) get no group. A device outside a named % keeps the outside name
even when a later rule decides its value. flagd JSON has no place for group names.

The sample's `new_checkout` serves `on` to 10% of devices, named `new-checkout`, and names the devices outside it
`old-checkout`.

## Overrides

An override is a **locked** rule for everyone. Overrides come first in the flag's rules, are checked before any
entity's own settings, and no entity can change them. Entities can't have overrides of their own.

Overrides **fail closed**: a check that can't be decided counts as a match. The sample's override on `new_checkout`,
"App is android and App version is below 5.0.0 → off", keeps the new checkout off for an Android build that doesn't
report its version.

::: warning
An override on a dimension attribute matches every request that names no entity, since the value is missing there.
:::

## Paused rules

A rule can be paused: it stays in place, with its % and its devices, and is passed over until you resume it. The trace
shows it as "rule is paused". Releases use this for **Pause** and for rolling a version back.

## The code default

Anywhere a value is served (a rule, a part of a %, a default, an entity's own default) you can choose **Use code
default (in-app)**. The flag then sends no value, and your app keeps the default written in its code. In the trace the
answer is marked `codeDefault: true`; in flagd JSON it is a `null` variant, so the provider returns your code's default.

The sample's `welcome_message` uses the code default for everyone, and a rule "Language is he" serves the Hebrew text.

## What "off" sends

Each flag has an On/Off switch per environment, on its defaults. Entities' own settings can't turn a flag on or off.

**Off sends nothing.** Every app and backend uses the default in its own code: the answer's reason is `DISABLED`, and
in flagd JSON the flag's state is `DISABLED`. Write your code defaults so that "off" is the safe value. A flag that
isn't sent to an app at all is `FLAG_NOT_FOUND` for it.

## Why a device gets its value

Each answer has a reason:

| Reason | What decided |
|---|---|
| `TARGETING_MATCH` | A rule that serves one value |
| `SPLIT` | A % of devices |
| `DEFAULT` | A default, after rules that didn't match |
| `STATIC` | Everyone's default, with no rules in play |
| `DISABLED` | The flag is off |
| `ERROR` | `FLAG_NOT_FOUND` (not sent to this app) or `TYPE_MISMATCH` |

### The Debug tab

On a flag's page, the **Debug** tab answers "why does this device get this value?". Under **Test a device** you pick
the entity, the app, an app version, a device ID (or a random one) and any other attribute an app reports. It runs the
same evaluator in your browser, on the rules on the page, unpublished edits included.

It shows the value and what decided it ("Globex's rule", "Rule for everyone · % of devices"), the group sent to the
app, and **How it was decided**, step by step:

- whether the flag is sent to that app, and whether it is on;
- each level of the chain: overrides, the entity's own rules, those of each entity above it, the rules for everyone,
  the default;
- each check with the value it read and whether it passed, with a note when a missing value counted as a match;
- for a %, the ID used, the salt, the bucket and the part it fell in;
- rules skipped because an entity uses "Own settings only", and whose choice it was.

`POST /api/trace` gives the same answer from the API. To see two sides at once (two entities, environments or apps,
flag by flag), use **Compare** in the sidebar.
