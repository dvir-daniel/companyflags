# Dimensions: what config is served per

Planned and built Nov 19, 2026 (phases 1–4 and 6; phase 5, large installations, is not built). Today CompanyFeatures serves config per **customer**, and a customer can belong to
a **company**, which makes it a **brand**. Those words and the two levels are fixed in the code, the database and the
console. With this change each installation defines its own **dimensions**: what it serves config per, with its own
names and up to four levels. One installation has `company` › `brand`, another `region` › `chain` › `store`, another
just `customer`. No domain word is fixed anywhere a console user or rule author reads.

This replaced an earlier idea: fixed identifiers with configurable words. That idea's words module, writing rules
and "no word left behind" test still apply (see "Words").

## What was built differently from this plan

- **Migration `0013_dimensions.sql`**, not 0012 (`0012_free_values.sql` came first).
- **"Early access"** names a release's first step (was "Targeted customers"): a rule on `entity` serving the new value.
  Rules from before on `customer.id` are still recognised.
- **The management API** nests entities under their dimension (`/api/dimensions/store/acme-12/flags`), and so do the
  console's addresses (`#/dimensions/store/acme-12/dev`).
- **Removing a dimension** is also refused while it has archived entities (they'd otherwise block it in the database).
- **Not built:** phase 5 (`/api/meta` still sends every entity, and pickers list them all; the tree's top level loads
  at once).

## The model

- **A dimension** is one level. It has a key (`store`), the words people read (store / stores), and the dimension above
  it, its parent. An installation's dimensions form one chain, top to bottom, at most 4: `region` › `chain` › `store`.
- **An entity** is an entry of a dimension: the region `eu`, the chain `acme`, the store `acme-12`. It has a key, a name
  and, optionally, a parent, which is an entity of the dimension right above (`acme-12`'s parent is `acme`).
- **Every entity is served, at any level.** It has everything a brand has today: its own settings on every flag, its
  own app link and file per environment and flag set, API keys, its own page, Compare, approvals and History.
- **An entity follows its parent** on a flag until it has its own settings there. Its parent follows its own parent, and
  so on up to the top, then everyone's settings. Today's brand is the two-level case.

| Installation | Dimensions | A file is served for |
|---|---|---|
| Today's, migrated | `company` › `brand` | each company and each brand |
| A retailer | `region` › `chain` › `store` | each region, chain and store (usually stores) |
| A simple SaaS | `customer` | each customer |
| Not set up yet | none | only everyone's file (what apps get before login today) |

### Why one chain, not independent dimensions

Two dimensions with settings of their own side by side, say `customer` and `region`, don't work:

- **Which wins?** A device of Acme in the EU gets both Acme's settings and the EU's, so one has to come first on every
  flag. That order makes them a chain anyway.
- **A file per combination.** Each customer × region pair needs its own file. The files multiply and the CDN's hit
  rate drops, and that cache is why delivery is cheap at billions of devices.
- **"Why it gets this"** becomes a grid of combinations instead of a list of levels.

Anything else you target by stays a rule attribute: country, flag set, app version, and the attributes you define.
See open decision 1.

## The order a request is decided in

```
1. Flag off                               → the app's in-app default
2. Overrides for everyone                 (locked rules)
3. The entity's own rules                 ┐ "Own settings only" stops here, with the entity's own default
4. Its parent's rules                     │ an entity above that uses "Own settings only" stops there
5. … each entity above it, to the top     ┘
6. Rules for everyone
7. Default: the most specific own default of a level that isn't skipped (the entity's, then its parent's, …),
   else everyone's
```

A level is skipped when an entity below it in the chain uses "Own settings only". The three choices are today's, now at
any level:

| Choice (identifier, unchanged) | What the entity gets |
|---|---|
| **Rules only** (`base_rules_then_base_default`) | Its rules first. If none match, everything its parent gets (for an entity at the top, everyone's). |
| **Rules + own default** (`base_rules_then_customer_default`) | Its rules, then the rules of each level above it and everyone's (up to one that uses "Own settings only"), then its own default. |
| **Own settings only** (`customer_only`, today "Customer only") | Only its rules and default. Every level above it and the rules for everyone are skipped. Overrides still apply. |

Example: the store `acme-12`, in the chain `acme`, in the region `eu`.

| Store | Chain `acme` | Region `eu` | `acme-12` gets |
|---|---|---|---|
| no settings | no settings | Rules only | EU's rules, everyone's, then everyone's default |
| Rules only | Own settings only | anything | its rules, Acme's, then Acme's default; EU and everyone are skipped |
| Rules + own default | Rules only | Rules + own default | its rules, Acme's, EU's, everyone's, then its own default |
| no settings | Rules + own default | Rules + own default | Acme's rules, EU's, everyone's, then Acme's default (the nearest) |

**Written once.** `customerChain()` in `server/evaluator.ts` becomes `entityChain()`: the same walk, along the entity's
path (itself, its parent, and so on to the top) instead of "the customer, then a brand's company". `evaluate()`,
`forEntity()` (was `forCustomer()`), the entity page's "why it gets this", the impact warning and Compare read it as
they do today. A chain has at most 4 entity levels plus overrides and everyone's, so the work per flag stays bounded.

## Rule attributes: the installation's own keys

- **One attribute per dimension, named by its key:** `store`, `chain`, `region`. The console reads "Store is one of
  Acme 12, Acme 14" or "Region is one of EU".
- **A dimension's value is the asker's entity at that level.** For `acme-12`: `store` is `acme-12`, `chain` is `acme`
  and `region` is `eu`. So "Region is EU" covers EU, its chains and all their stores, as "Company is Globex" covers
  Globex and its brands today.
- **One structural attribute for exactly one entity:** `entity`, the asker itself at whatever level. "Chain is Acme"
  covers Acme and its stores; `entity` Acme is only Acme's own file. The console labels it with the dimension names:
  "Company or brand is one of …", "Region, chain or store is one of …". With one dimension it's the same as that
  dimension's attribute, so the editor doesn't offer it. See open decision 4.
- **Settled on the server**, as `customer.id` and `customer.company` are today. The value comes from the app's link, or
  from the entity a backend names within its key's scope (`comes_from = 'token'`), never from what an app sends. A check on it is settled in the app's file and in flagd
  JSON, so no entity list ever reaches a device or a backend's flag set.
- **Below the asker's own level, the value is "none", not missing.** For the chain `acme`, "Store is acme-12" is false,
  even in an override, and "Store isn't set" is true. Today a missing value makes an override match (it fails closed,
  M4). That's right when the app didn't send something, and wrong here, where the server knows there's no store. With
  no entity at all (before login), values are missing, as today. See open decision 5.
- **% of devices by a dimension** is allowed, as by customer or company today. A split by `chain` puts all stores of a
  chain in the same group.
- **Stored like any attribute.** Each dimension, and `entity`, gets a `condition_field` row (`split_by` references that
  table). The row is written when the dimension is added, not by `syncFields`.
- **Reserved keys.** No dimension may be called `entity`, the name or first part of a built-in attribute (`project`,
  `environment`, `app`, `device`, `session`, `geo`, `locale`), or a word used in the console's addresses. Attributes you
  define later can't take a dimension's key.
- **The rule editor's group** for them is labelled with the dimension names ("Company and brand"), not "Customer".

## Secret links and API keys per entity

**App links.** Every entity, at any level, has its own link per environment, as each customer has today:

```
/client/v1/flags/<env>/<flag set>/<entity>/<secret>     secret = HMAC(environment secret, "client-link/<entity>/<link version>")
```

- **Entity keys are unique across the installation**, not per dimension (open decision 2). So the link needs no
  dimension and the HMAC's input doesn't change: every link given out today keeps working after the migration, with the
  same secret.
- **Replacing a link** is per entity, as today. Replacing one entity's link doesn't touch those under it.
- Every kind of wrong link still answers "no file at this link".

**API keys: what a backend may ask about.** Today a key is for one customer (`customer`) or for any
(`all_customers`), and a shared backend names the customer in an `X-Customer-Id` header. The key stays in
`Authorization`, the only header, and says which part of the tree the backend may ask about:

| Scope | Which entities it may ask about | For example |
|---|---|---|
| `entity` | Only the key's entity | A store's own backend |
| `below` (new) | The key's entity and every entity under it | A chain's backend serving all its stores |
| `all` | Any entity | A shared backend |

**Naming the entity: by its dimension, never in a header.** OpenFeature and Flagsmith keep headers for the key alone
and say who is asking in the request itself (see "How others do it" below). So:

- **flagd JSON:** the entity is in the path, as `<dimension>/<entity>`:

  ```
  GET /sdk/v1/flagd/store/acme-12          Authorization: Bearer <key>
  ```

  - flagd's HTTP sync reads one URL per source, so a shared backend adds one source per entity it serves. The
    document's `flagSetId` (`<environment>/<flag set>/<entity>`, such as `prod/api/acme`) names it, and that's what
    flagd's `selector` (`flagSetId=…`) filters on. It was `<environment>/<entity>` until apps were renamed flag sets.
  - An `entity` key may leave the path off: `GET /sdk/v1/flagd` is its own entity, as today.
  - The dimension must be the entity's, else 404. Keys are unique across the installation, so the server doesn't need
    it, but the address reads like the rules ("Store is acme-12") and a wrong one fails clearly.
- **Remote evaluation** (OFREP, not built): the entity is an attribute of
  OpenFeature's evaluation context, named by its dimension, the same key the rules read:

  ```
  POST /ofrep/v1/evaluate/flags/new_checkout    Authorization: Bearer <key>
  { "context": { "targetingKey": "user-123", "store": "acme-12" } }
  ```

  - The server fills in the levels above from its own data (`chain`, `region`) and ignores what it was sent for them,
    so a caller can't place a store in another chain.
  - If the context names more than one dimension, the lowest decides and the others must agree with its path, else 400.
- **The key is the limit.** A request naming an entity outside the key's scope gets a 403. The check reads the
  snapshot's paths on every request, so moving a store out of a chain takes it out of that chain's `below` key at once,
  whatever the key cache holds.
- **`X-Customer-Id`**, built today, keeps working with existing `all` keys so backends already set up don't break. It
  isn't documented any more and goes in a later version.
- Existing keys migrate: `customer` becomes `entity`, `all_customers` becomes `all`.
- **App links don't change.** They already name the entity in the path, and the link is the credential. Putting the
  dimension in them would break every link already given out.

### How others do it

| | What headers carry | Where "who is asking" goes |
|---|---|---|
| OpenFeature | — | The evaluation context: a `targetingKey` and any attributes, set for the app, a client, one call, or a request (transaction context) |
| OFREP | The key: `Authorization: Bearer` or `X-API-Key` | The body: `{ "context": { … } }` |
| flagd | The key (`authHeader`); custom `headers` are possible | Nowhere: a sync source is a URL; `selector` picks a flag set by `flagSetId` |
| Flagsmith | The environment key: `X-Environment-Key` | The body: `POST /api/v1/identities/` with `identifier` and `traits`. In-process, each call passes them after the SDK downloads the environment document |

flagd could send today's `X-Customer-Id` through `headers`, but nothing else in OpenFeature expects a header for the
subject. Flagsmith has no tree: a tenant there is a trait that segments match.

## Migrating today's data to `company` › `brand`

Migration `0012_dimensions.sql` (the next free number: `0011` is the version releases'), in one transaction:

1. **Two dimensions:** `company` (company / companies) at the top and `brand` (brand / brands) under it.
2. **The `customer` table becomes `entity`**, with a `dimension_id`. A customer with a company (`parent_id`) is a
   `brand`. Every other customer, with brands or without, is a `company`: standalone customers sit at the top level.
   Keys, names, `parent_id`, link versions and archived customers stay as they are.
3. **Columns follow:** `customer_id` becomes `entity_id` in `flag_layer`, `api_key` and `change_set_item`, and
   `change_history.customer` becomes `entity`. Renaming a column leaves History's rows untouched, and it stays
   append-only. Indexes and constraints are renamed with them.
4. **0003's one-level trigger goes.** A new trigger checks that an entity's parent is in the dimension right above its
   own, and that the dimensions form one chain of at most 4.
5. **Rule attributes are rewritten in live rules** (`flag_rule.conditions`, `split_by`, `split_fallback_by`):
   `customer.company` becomes `company` and `customer.id` becomes `entity`. Each keeps exactly its meaning:
   - `customer.company` was a brand's company, else the customer itself: that's the entity at the `company` level.
   - `customer.id` was the customer itself, at whatever level: that's `entity`.
   - A % by either hashes the same key with the same salt, so every device stays in its group.
6. **The old names stay readable** as aliases of the new ones (`fields.ts`). History entries and change sets in review
   keep `customer.id` and `customer.company` in their JSON. They aren't rewritten (History is append-only, and a review
   is bound to its content's hash), and they still read and apply exactly as before.
7. **API keys:** `customer` becomes `entity`, `all_customers` becomes `all`.
8. **History kinds:** new entries say `entity.create`, `entity.update` and `entity.link_replaced`. Old entries' kinds are
   read as those.

**Nothing served changes.** After the migration, every entity's file and flagd JSON are byte for byte what they were
before, for every environment and flag set (the migration test checks this), and every link and key still works.

**What people read does change.** "Customers" in the sidebar becomes "Companies" and "Brands". A rule "Customer is Lumen"
reads "Company or brand is Lumen". "Company is Globex" reads as before. An admin who wants other words changes them in
Settings → Dimensions (open decision 6).

## Changes, part by part

### Data model

```sql
create table dimension (
  id smallint generated always as identity primary key,
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{0,29}$'),   -- fixed once entities or rules use it
  singular text not null,                                             -- the words people read
  plural text not null,
  parent_id smallint unique references dimension on delete restrict  -- the dimension above; unique: one chain
);
create unique index dimension_one_top on dimension ((true)) where parent_id is null;

-- entity (was customer) gains: dimension_id smallint not null references dimension
```

- A unique `parent_id` and a single top make one chain. "At most 4" and "a parent in the dimension right above" are a
  trigger, like 0003's, since a check can't read other rows.
- Entity keys stay unique across the installation (`entity.key unique`, as `customer.key` is).

### Evaluator (`server/evaluator.ts`)

| Today | After |
|---|---|
| `CustomerInfo { key, name, company? }` | `EntityInfo { key, name, dimension, parent?, path }`. `path` is the entity and those above it, each with its dimension, worked out once when the snapshot is built |
| `Snapshot.customers`, `FlagDef.customers` | `Snapshot.entities`, `FlagDef.entities`, plus `Snapshot.dimensions`: the keys, top to bottom |
| `customerChain(flag, customer)` | `entityChain(flag, entity)`: one level per entity in `path` |
| `LevelName` `'customer' \| 'company'`; `Section` `'customer_rule' \| 'company_rule' \| …` | `'entity'`; `'entity_rule' \| 'entity_default'`, with `owner` (whose settings decided) on `DecidedBy`. The console says "own" when the owner is the asker |
| `skippedBy: 'customer' \| 'company'` | `skippedBy`: the key of the entity whose "Own settings only" skips the level |
| metadata `customerLayerVersion`, `companyLayerVersion` | `layerVersions: { <entity>: version }` |
| `forCustomer`, `UnknownCustomerError`, `namesCustomer` | `forEntity`, `UnknownEntityError`, `namesEntity` |
| 11 trace texts ("customer default", "the brand’s own default", …) | Trace steps carry the owner, and `words.ts` writes the sentence (from the terminology plan) |

- `forEntity` gets the snapshot's dimension keys, so a check on any dimension is settled for every entity at every
  level, and for no entity. That keeps "no entity key in a file" true for an entity above a dimension too.
- The `Inherit` identifiers don't change: layers, change sets and History store them.

### App files and flagd JSON

- `buildClientFile(snap, app, entity)` and `buildFlagdDoc(snap, app, entity)` work as today and call `forEntity`.
- **One file per environment, flag set and entity, at any level.** The CDN caches by path, a publish purges the
  environment's tag, and a file is built only when a device first asks for it. More levels don't mean more files per
  device, only more entities that could have one.
- flagd's `flagSetId` stays `<environment>/<entity>`, the same string as today's `<environment>/<customer>`. (Later,
  when apps were renamed flag sets, it became `<environment>/<flag set>/<entity>`, such as `prod/api/acme`.)
- **Running on Cloudflare (not built):** the KV entry `v1/<env>/customer/<customer>` ("its own
  layers, plus its company's") becomes `v1/<env>/entity/<entity>`, holding the entity's own layers only. The edge reads
  the entries of its path (up to 4) at once. One entry per entity with its whole chain would mean rewriting every
  store's entry whenever its region changes. OFREP takes the entity from the evaluation context, named by its
  dimension (see "Naming the entity").

### Server

- **`server/dimensions.ts`**, pure and shared with the console like `policy.ts`: the `Dimension` type,
  `checkDimensions()` (keys, words, at most 4, one chain) and the word helpers (see "Words").
- **`server/control.ts`:** `upsertCustomer` becomes `upsertEntity`; the parent must be in the dimension above. Moving an
  entity is for admins only while an environment is protected (`mayMoveCustomers` becomes `mayMoveEntities`).
  `saveDimensions` is new. `createApiKey` takes the three scopes; `rotateClientLink` works per entity.
- **`server/snapshot.ts`:** loads the dimensions, and the entities with their paths.
- **`server/auth.ts`:** `Principal.scope` is `'entity' | 'below' | 'all'`, with `entity`. `authenticate()` no longer
  reads the entity from a header (bar the old `X-Customer-Id` fallback); the caller passes the entity it named, and
  the scope check runs against the snapshot's paths.
- **`server/delivery.ts`:** `GET /sdk/v1/flagd/:dimension/:entity`, and `GET /sdk/v1/flagd` for an `entity` key.
- **`server/checks.ts`:** `entityKeyProblem` with today's key rules, the dimension key rules, and messages without
  "customer" ("Overrides are for everyone" in place of "customers can’t have overrides").
- **`server/fields.ts`:** the dimension attributes and `entity` come from the dimensions, not the fixed list.
  `customer.id` and `customer.company` become aliases. `KnownValues` `'customers' | 'companies'` becomes `'entities'` and
  `{ dimension: <key> }`.
- **`server/release.ts`** (the version-releases work is changing it, so this waits for that to land): "Targeted
  customers" becomes a rule on `entity`, still reading the alias `customer.id`. Its rule name and step words come from
  the dimension words.
- **`server/journal.ts`:** the `entity.*` kinds, and `dimensions.update` ("Changed the dimensions", with before and
  after). It serves nothing, so it doesn't publish.

### API

The management API is used only by the console today, so `/api/customers` gets no aliases.

| Method and path | What |
|---|---|
| `GET /api/dimensions`, `PUT /api/dimensions` | The chain, top to bottom. A PUT saves the whole list (admins) |
| `GET /api/dimensions/:dimension?q=&parent=&page=` | One dimension's entities, searched and paged |
| `POST /api/dimensions/:dimension` | Adds an entity: `{ key, name, parent }` |
| `GET /api/dimensions/:dimension/:key`, `PUT …` | One entity; `{ name, parent }` |
| `GET /api/dimensions/:dimension/:key/flags` | What it gets on every flag, with the `levels` of its chain (was `/customers/:key/flags`) |
| `GET /api/dimensions/:dimension/:key/children` | It and the entities right under it, side by side (was `/customers/:key/brands`) |
| `GET /api/dimensions/:dimension/:key/link`, `POST …/link/rotate` | Its app link. With `?flagSet=web`, that flag set's path and token; without it, the path has `:flagSet` in place of the key |
| `GET /api/meta` | Adds `dimensions`; `entities` replaces `customers` (see Limits) |
| `POST /api/api-keys` | `{ scope: 'entity' \| 'below' \| 'all', entity }` |
| `PUT /api/flags/:key/layers/:env/:entity` | The same path, for any entity |

Every address names an entity by its dimension, like the rules do: `store/acme-12`. Apps' links
(`/client/v1/flags/…`) don't change. flagd JSON moves the entity from the header into the path:
`/sdk/v1/flagd/<dimension>/<entity>`.

## Console

### Settings → Dimensions

Admins only, like the rest of Settings. No approval; recorded in History as "Changed the dimensions".

- **The chain, top to bottom:** one row per dimension with its singular, plural and key, and how many entities it has.
  The top row has **Add above** and the bottom row **Add below**, up to 4. **Remove** shows on a dimension with no
  entities that no rule checks.
- **Presets** for a new installation: Customers; Companies › Brands; Accounts › Sub-accounts; Regions › Chains ›
  Stores; Organizations › Workspaces. Then **Custom**.
- **The key** is suggested from the singular ("Sub-account" gives `sub_account`). It's fixed once entities or rules use
  it. The words can change any time.
- **A live preview** under the form: "Acme 12 follows Acme, then Europe", "3 stores", "Store is one of Acme 12,
  Acme 14", "Region, chain or store is one of …".
- **Changing the chain later:**
  - adding one at the top: the entities that were at the top have no parent until moved under one;
  - adding one at the bottom: always possible;
  - adding one in the middle: refused while the dimension below it has entities with parents, since each would need a
    new parent; add it at the top or bottom, or move those entities first;
  - removing one: only while it has no entities and no rule uses it.
- **Setup:** a new installation starts with no dimensions, as it starts with no flag sets. Settings → Dimensions comes
  before the first entity in the setup steps. Until then every app gets everyone's file.

### A page per dimension

- **The sidebar has one item per dimension**, top to bottom, named by its plural: "Regions", "Chains", "Stores".
- **A dimension's page** lists its entities: name, key, parent (linked), how many entities are under it, and flags with
  their own settings per environment. Search covers names, keys and the parent's name. **Add store** (the dimension's
  word) asks for the key, the name and **In**: the parent, searched in the dimension above.
- **An entity's page** is today's customer page, at any level:
  - a breadcrumb up the chain, each linked: Europe › Acme › Acme 12;
  - every flag says **Own settings** or **From Acme**, naming the nearest entity above whose settings it gets.
    **Use Acme’s again** removes its own;
  - saving an entity's settings says how many entities under it follow them: "This also changes what 240 stores get";
  - "Why it gets this" lists every level of its chain: which is set, which decided, which are skipped and by whom;
  - a tab for the dimension below ("Stores"; today's Brands tab): the entity and its children side by side, shaded
    where a child differs, paged;
  - App link, keys, History, Compare and Try it, as today.
- **The tree:** the top dimension's page has a **Tree** view. Each row is an entity with its dimension, how many flags
  it has its own settings on, and a link to its page. Entities under it load one level at a time when it's expanded.
  **Move** on an entity's page picks a new parent in the dimension above; only admins can move one while an environment
  is protected.
- **Elsewhere,** on flags, in Compare and in Approvals, an entity shows as its name with its parent's, "Acme 12 (Acme)",
  as "Lumen (Globex)" today. A flag's list of entity settings can be filtered by dimension.
- **Keys page:** the scope reads with names, not "customer": "Only Acme", "Acme and everything under it", "Any". A key's
  drawer shows the flagd address for its entity (`/sdk/v1/flagd/store/acme-12`), or one to fill in for `below` and
  `all` keys.
- **Addresses:** `#/dimensions/<dimension>` and `#/dimensions/<dimension>/<key>/<env>/<view>`, like the API.
  `#/customers` and `#/customer/<key>/…` keep working and open the same pages, for bookmarks and shared links.

## Words

What's left of the configurable-words idea applies here, with dimensions in place of its three fixed
levels:

- **Helpers in `server/dimensions.ts`:** `one(d)` gives "store", `many(d)` "stores", `title(d)` "Stores", `count(d, 3)`
  "3 stores", `own(name)` "Acme’s", `joined(dims, 'or')` "Region, chain or store". The console reaches them through a
  hook in a `.ts` file (`useDimensions()`), because `.tsx` files export only components.
- **Word rules:** 1–30 characters; letters (any alphabet), spaces, hyphens and apostrophes. Singular and plural may be
  the same. No two dimensions share a singular, or a plural. Words are written as in the middle of a sentence and the
  console capitalizes them for titles; "OEM" stays as typed.
- **Writing rules:** no "a" or "an" before a dimension's word ("Add store"). Never build a plural by adding "s". Never
  paste a word into a longer one.
- **Sentences take the dimensions as an argument:** in `words.ts` (`customerWords` becomes `entityWords`, plus
  `choiceText`, `sameAs` and `SECTION_LABEL`), `journal.ts`, `checks.ts`, `release.ts` and the attribute labels in
  `/api/meta`. The evaluator's trace texts move to `words.ts`.
- **Old History entries** read with today's words, since History stores only kinds, before, after and comments.
- **"Company" meaning your organization** (9 strings in sign-in and single sign-on) becomes "your organization", once
  the sign-in work lands. It matters more now: an installation may have no `company` dimension, or one that means
  something else.

Superseded parts of that plan: the fixed identifiers (the `customer` table, `/api/customers`, `customer.id`), the three
fixed levels, the single-row names table (`0011_names.sql`), and the brand switch, since an installation without
parents simply has one dimension.

## Limits

| What | Limit | Why |
|---|---|---|
| Dimensions | 4 | Bounds the chain (at most 4 entity levels per flag), the trace and the tree |
| Dimension key | 1–30 characters, `^[a-z][a-z0-9_]*$`, not reserved | It's a rule attribute, stored in rules |
| Dimension words | 1–30 characters each | They fit titles, buttons and sentences |
| Entity key | Today's customer key rules, unique across the installation | It's in links, flagd ids and rules |
| Entities | No fixed limit. Each snapshot keeps every entity in memory, about 150 bytes each: 100,000 is about 15 MB per environment | |
| Entities in `/api/meta` | All of them up to 5,000, as today. Above that, pickers search, and pages send the names they show (phase 5) | /meta loads with every page |
| Children on an entity's page | Paged | As the brands grid today |

## Tests

The equivalence tests matter most, and they must hold for 1 to 4 levels.

- **The chain (`test/evaluator.test.ts`):** for chains of 1, 2, 3 and 4 dimensions, every combination of the four
  states per level (no settings, Rules only, Rules + own default, Own settings only; 4⁴ = 256 at 4 levels) gives the
  documented levels, skips and default. The expected answers come from a small model in the test, written from the
  order above, not from `entityChain()`.
- **`evaluate()` and `forEntity()` with `answerFor()` agree** for every flag, every entity at every level (top, middle,
  bottom, with no parent) and no entity, over many requests.
- **App files (`test/client-file.test.ts`):** the device's pick from the file equals `evaluate()`, value and group, for
  every flag, entity at every level, flag set and device, at 1–4 levels.
- **flagd (`test/flagd.test.ts`):** flagd's answer from the JSON equals ours, for the same cases.
- **Nothing private reaches a file or flagd JSON:** no dimension attribute, `entity` or alias in either, for any entity.
  That includes a chain under rules on "Store is …", and no entity at all.
- **"None" below the asker's level:** "Store is acme-12", in an override too, doesn't match the chain `acme`; "Store
  isn't set" does. With no entity, overrides fail closed as today.
- **Migration (`test/migrate.test.ts`):** a database at 0011 with companies, brands and standalone customers, layers on
  each, rules and %s on `customer.id` and `customer.company`, keys of both scopes, a change set in review, and History.
  After 0012, every entity's file and flagd JSON are byte for byte the same (same ETag), links have the same secrets,
  keys answer the same, the change set applies, and History reads.
- **Dimensions (`test/dimensions.test.ts`):** `checkDimensions()`; adding at the top and the bottom; the middle refused
  while it has entities; removing only when empty and unused; keys fixed once used; admins only; History.
- **Entities (`test/brands.test.ts` becomes `test/entities.test.ts`):** today's brand tests on `company` › `brand`, plus
  a 3-level installation: parents only in the dimension above, moving, the tree order, the children grid, "Use Acme’s
  again".
- **Keys (`test/security.test.ts`):** the three scopes; the entity taken from the flagd path, with the wrong
  dimension a 404; no header but `Authorization` needed; `X-Customer-Id` still working with existing `all` keys; a
  `below` key refused outside its part of the tree, at once after a move.
- **No word left behind** (from the terminology plan): with odd dimensions (Widget › Gadget › Gizmo), and also with 1
  and with 4 dimensions, no sentence from `words.ts`, `journal.ts`, `checks.ts`, `release.ts`, the trace or
  `/api/meta` contains "customer", "company" or "brand". A source check fails on those words in console strings
  outside the presets and the alias list.
- **Existing tests** keep passing after the migration, with their expected sentences moved to the Company and Brand
  words.

## Phases

| # | Phase | Done when |
|---|---|---|
| 1 | Engine: `entityChain()`, `forEntity()`, app files and flagd over N levels, on snapshots built from today's tables as `company` › `brand` | The equivalence tests pass at 1–4 levels (their fixtures build snapshots directly), and every existing test passes |
| 2 | Data and API: migration 0012, `dimensions.ts`, snapshot, key scopes and the flagd path, `control.ts`, `/api/dimensions`, History kinds | The migration test passes: the same files, flagd JSON, links and keys |
| 3 | Words: sentences from the dimensions, trace texts out of the evaluator | The no-word test passes for every server sentence |
| 4 | Console: Settings → Dimensions, a page per dimension, entity page, tree, rule editor, Keys, addresses | The source check passes, and a 3-level installation is set up and used end to end in the console |
| 5 | Large installations: `/api/meta` without every entity past 5,000, and pickers that search | With 100,000 stores the console stays fast, and files build as fast as today |
| 6 | After other work lands: "your organization" (sign-in), the targeted step in `release.ts` (version releases). Then README (evaluation order) and GLOSSARY | — |

## Open decisions

1. **One chain, or independent dimensions?** Recommended: one chain. Independent dimensions with settings of their own
   need an order between them, which is a chain, and a file per combination, which breaks the CDN cache. Other axes
   stay rule attributes.
2. **Entity keys unique across the installation, or per dimension?** Recommended: across the installation. Links
   (`…/<entity>/<secret>`), flagd ids and History stay as they are, and no link given out today changes. Per dimension
   would put the dimension into every link and break the ones already given out.
3. **Must an entity below the top have a parent, and can it skip a level?** Recommended: the parent is optional, and
   when set it's in the dimension right above. Optional lets a dimension be added at the top without picking a parent
   for every entity. Not skipping keeps "Chain is …" known for every store that has a parent.
4. **An attribute for exactly one entity (`entity`)?** Recommended: yes, labelled with the dimension names. It's what
   `customer.id` means today, so the migration is exact. It's also how a chain's own file is targeted without its
   stores, and what a release's targeted step uses.
5. **Below the asker's level: "none", or missing?** Recommended: none. The server knows a chain has no store, so an
   override must not match it the way it does when an app didn't send something.
6. **Migrate to `company` › `brand`, or to one `customer` dimension where there are no brands?** Recommended: always
   `company` › `brand`. It's one migration, tested once, and "Company is Globex" keeps its meaning. An installation
   without brands can remove the empty `brand` dimension and call `company` "customer" in Settings.
7. **Rename the database's `customer` table and columns?** Recommended: yes, in 0012. A `customer` table holding regions
   and stores misleads every developer, and every query that touches it changes anyway.
8. **Which entities can have app links?** Recommended: every entity at every level, as every customer and brand can
   today. A link costs nothing until a device uses it, so there's no switch per dimension.
9. **Add the `below` key scope (an entity and those under it)?** Recommended: yes. A chain's backend serving its stores
   shouldn't need an `all` key that can read every other chain.
10. **How does a backend say which entity it's asking for?** Recommended: by its dimension, in the request, never in a
    header. flagd JSON takes it in the path (`/sdk/v1/flagd/store/acme-12`), and remote evaluation in the evaluation
    context (`"store": "acme-12"`), as OpenFeature, OFREP and Flagsmith do. Headers carry only the key. Today's
    `X-Customer-Id` keeps working for existing backends, undocumented, until a later version.
11. **Who changes dimensions, and with approval?** Recommended: admins, no approval, recorded in History. Words and
    empty dimensions change nothing that's served.
12. **Does a change above an entity re-open its pending changes?** Recommended: no, as for brands today. Only a change
    to everyone's settings re-opens a review (`expected_base_version`).

## Not built (later, if needed)

- **Overrides per entity:** a chain locking a rule so its stores can't change it ([brands.md](brands.md)'s "customer
  overrides").
- **Replacing the links of an entity and everything under it** at once.
- **Inserting a dimension in the middle** with entities already in place, picking a parent for each.
- **More than 4 levels.**
- **Translations** of the dimension words.
- **An entity with two parents** (a store in two chains). That's two dimensions side by side, ruled out above.
