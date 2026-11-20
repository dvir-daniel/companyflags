# Dimensions

A **dimension** is what your installation serves config per. You define them, in your own words: one installation
serves per `customer`, another per `company` › `brand`, another per `region` › `chain` › `store`. CompanyFlags has
no fixed business word of its own. The generic thing is an **entity** of a dimension, and the console always shows
your words instead ("Brands", "Add store", "Company is Globex").

## The chain

Your dimensions form **one chain**, top to bottom, of at most 4. Each dimension has:

| Field | Example | Rules |
|---|---|---|
| Key | `brand` | Lowercase letters, digits and `_`, starting with a letter, up to 30 characters. It is the attribute rules check, so it can't change once saved. |
| Singular | brand | 1–30 letters, spaces, hyphens or apostrophes. No two dimensions share one. Change it any time. |
| Plural | brands | The same rules. Never made by adding "s" for you. |

Some keys are reserved: `entity`, and the names that built-in attributes start with (`project`, `environment`,
`app`, `device`, `session`, `geo`, `locale`).

### Set them up

**Settings → Dimensions** (admins only). Pick a preset or write your own:

| Preset | Chain |
|---|---|
| Customers | `customer` |
| Companies › Brands | `company` › `brand` |
| Accounts › Sub-accounts | `account` › `sub_account` |
| Regions › Chains › Stores | `region` › `chain` › `store` |
| Organizations › Workspaces | `organization` › `workspace` |

Saving needs no approval. History records it as "Changed the dimensions", with the chain before and after. Until you
set up dimensions there are no entities, and every app gets what everyone gets.

### Change the chain later

- **Add one at the top or at the bottom**: always possible. Entities that were at the top have no parent until you move
  them under one.
- **Add one in the middle**: refused while entities of the dimension below it have parents (each would need a new
  one). Add it at the top or bottom, or move those entities first.
- **Remove one**: only while it has no entities (archived ones included) and no rule checks it.
- The dimensions you keep stay in their order.

## Entities and parents

Each dimension gets a page in the sidebar, named by its plural. There you add entities with a **key**, a **name** and,
below the top, a parent (**In**), which must be an entity of the dimension right above. The parent is optional.

- Entity keys use lowercase letters, digits and dashes, and start with a letter or digit. They are **unique across the
  installation**, not per dimension, because they appear in app links, flagd flag set ids and rules. `base`, `trace` and
  `compare` are reserved.
- **Moving** an entity under another parent changes what it, and every entity under it, gets in every environment at
  once. While any environment is protected, only admins can move one.
- Every entity, at any level, has everything: its own settings on any flag, an app link per environment, API keys, its
  own page, History and Compare.

## Following the parent

On a flag where an entity has no settings of its own, it gets what its parent gets. Its parent follows its own parent,
and so on up; the top follows everyone's settings. The entity's page says, for each flag, **Own settings** or
**From Globex** (the nearest entity above whose settings it gets). **Use Globex's again** removes its own.
Saving an entity's settings tells you how many entities under it follow them.

Once an entity has settings of its own on a flag, they combine with the rest in one of three ways:

| Choice | What the entity gets |
|---|---|
| **Rules only** | Its rules first. If none match, whatever its parent gets (at the top: what everyone gets). It has no default of its own. |
| **Rules + own default** | Its rules, then the rules of each level above it and everyone's, then its own default. |
| **Own settings only** | Only its rules and its default. Every level above it and the rules for everyone are skipped. Overrides still apply. |

## Evaluation order

This is the order the evaluator ([`server/evaluator.ts`](https://github.com/dvir-daniel/companyflags/blob/main/server/evaluator.ts),
`entityChain` and `evaluate`) decides one flag in, for one entity, in one environment. The first match wins.

<IllusOrder />

A paused rule is passed over.

A level is **skipped** when an entity below it, nearer the one asking, uses "Own settings only". The trace shows skipped
rules and says whose choice skipped them. Only "Rules + own default" and "Own settings only" bring a default; "Rules
only" never does.

For the store `umbrella-12`, in the chain `umbrella`, in the region `eu`:

| Store `umbrella-12` | Chain `umbrella` | Region `eu` | `umbrella-12` gets |
|---|---|---|---|
| no settings | no settings | Rules only | EU's rules, everyone's rules, then everyone's default |
| Rules only | Own settings only | anything | its rules, Umbrella's, then Umbrella's default. EU and everyone's rules are skipped |
| Rules + own default | Rules only | Rules + own default | its rules, Umbrella's, EU's, everyone's, then its own default |
| no settings | Rules + own default | Rules + own default | Umbrella's rules, EU's, everyone's, then Umbrella's default (the nearest) |

## Rules on dimensions

Each dimension is a rule attribute, named by its key. Its value is **the asking entity's entry at that level**. For
`lumen`: `brand` is `lumen` and `company` is `globex`. So:

- **"Company is Globex"** matches Globex, Lumen and Bolt.
- **"Brand is Lumen"** matches Lumen only, since it's the bottom level.
- **`entity`** is exactly the one asking, at whatever level. The editor labels it with your words ("Company or brand is
  Globex") and offers it once you have more than one dimension. "Company is Globex" covers Globex's brands;
  "Company or brand is Globex" is only Globex's own file.

The server works these values out itself: from the entity the request names, within its API key's scope (or from an
entity's app link), and from its own data for the levels above. A check on them is settled on the server, so no entity
list ever reaches an app file or a backend's flagd JSON.

**Below the asker's own level, the value is "none", not missing.** For Globex's own file, "Brand is Lumen" is false,
even in an override, and "Brand is not set" is true. Only "is not", "is not set" and "don't include" pass.

::: warning With no entity, values are missing
When a request names no entity (before sign-in, say), every dimension attribute and `entity` is missing. Ordinary rules
on them don't match, but **overrides on them do**, because overrides fail closed. An override "Company is Globex → off"
turns the flag off for everyone who names no entity.
:::

A % of devices can be split by a dimension or by `entity` too, so all stores of a chain land in the same group. The
API accepts it; the console's rule editor splits by device ID only.

## Why one chain

Two dimensions with settings of their own side by side (say `customer` and `region`) don't fit:

- **Which wins?** A device of Acme in the EU would get both, so one must come first on every flag. That order is a chain.
- **A file per combination.** Each customer × region pair would need its own file. Files multiply and the CDN's hit
  rate drops, and that cache is why delivery stays cheap with many devices. With one chain, there is **one file per
  environment, flag set and entity**.
- **"Why it gets this"** stays a list of levels instead of a grid.

Anything else you target by stays an ordinary rule attribute: flag set, app version, country, language.

## Examples

**A company and its brands** (`company` › `brand`). Acme Corp has the brand Acme Kids; Globex has Lumen
and Bolt; Initech, Umbrella Retail and Hooli have no brands. Globex sets its own `api_base_url`, and Lumen and Bolt follow
it. Lumen sets its own `theme`, and Bolt keeps the standard one.

**A retailer** (`region` › `chain` › `store`). The chain Umbrella Retail sits in the region `eu`, with stores
`umbrella-12` and `umbrella-14`. "Region is EU" reaches every chain and store in Europe. Umbrella can set a value for
all its stores, and `umbrella-14` can still use "Own settings only" to keep a value of its own.

**One customer level** (`customer`). Initech, Hooli and Acme Corp are each a customer, with no parents. Each one follows
everyone's settings until it has its own.

## Naming the entity in a request

A request names the entity by its dimension, the same key the rules read, and never in a header:

| Where | How | Example |
|---|---|---|
| flagd JSON | In the path, as `<dimension>/<entity>` | `GET /sdk/v1/flagd/brand/lumen` |
| OFREP | In the evaluation context, under the dimension's key | `{ "targetingKey": "d-1", "brand": "lumen" }` |

An API key limits which entities a request may name: only its own entity (`entity`), its entity and every one under
it (`below`), or any (`all`). Anything outside the key's scope is refused. Moving an entity out from under another
takes it out of that one's `below` keys at once. Every entity also has a secret app link per environment. See
[Flag sets](/guide/flag-sets), [Backends](/guide/backends) and [OpenFeature](/sdk/openfeature).

## Not built yet

- Fast pickers for very large installations: the console loads every entity at once.
- Overrides per entity: a company locking a rule so its brands can't change it. Only overrides for everyone exist.
- More than 4 levels, or an entity with two parents.
- Adding a dimension in the middle with entities already in place, picking a parent for each.
- Replacing the app links of an entity and everything under it at once.
