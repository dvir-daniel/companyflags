# Attributes

An attribute is what a rule's check reads: "App version is below 5.0.0", "Company is Globex". This page lists every
attribute a rule can check, its type, where its value comes from, and whether a % of devices can be split by it.

The built-in list is in [`server/fields.ts`](https://github.com/dvir-daniel/companyfeatures/blob/main/server/fields.ts)
(`FIELDS`). Your dimensions add one attribute each, plus `entity`.

## Where values come from

| Source | Attributes | Who sets them |
|---|---|---|
| **Server** | `project`, `environment`, your dimensions, `entity` | Worked out by the server from the API key (or app link) and the entity the request names. A request can't set them. |
| **App** | everything else | Sent by the app or backend, in the OpenFeature evaluation context. |

Values the app sends for attributes that aren't on this list are dropped. Defining attributes of your own isn't built
yet.

## Built-in attributes

The **Label** is what the rule editor shows. **Split** says whether a % of devices can be split by it.

### App

| Name | Label | Type | Source | Split | Known values |
|---|---|---|---|---|---|
| `project` | App | text | server: the API key or link | no | your apps' keys |
| `environment` | Environment | text | server: the API key or link | no | not offered in the editor (a rule already sits in one environment) |
| `app.version` | App version | version | app | no | the marketing version, such as `6.0.0` |
| `app.build` | App build number | whole number | app | no | |
| `app.channel` | Install channel | text | app | no | `store`, `testflight`, `beta`, `dev` |

### Device

| Name | Label | Type | Source | Split | Known values |
|---|---|---|---|---|---|
| `device.platform` | Platform | text | app | no | `android`, `ios`, `web`, `macos`, `windows` |
| `device.type` | Device type | text | app | no | `phone`, `tablet`, `desktop`, `tv`, `watch` |
| `device.manufacturer` | Manufacturer | text | app | no | Apple, Samsung, Google… (Android's `Build.MANUFACTURER`) |
| `device.model` | Device model | text | app | no | `iPhone16,2`, `SM-S921B`, `Pixel 9` |
| `device.memory_class` | Memory class | text | app | no | `low`, `normal` |
| `device.id` | Device ID | text | app | **yes** | an install ID the app keeps |
| `session.id` | Session ID | text | app | **yes** | a per-session ID, not sticky across sessions |

### OS

| Name | Label | Type | Source | Split | Known values |
|---|---|---|---|---|---|
| `device.os` | OS | text | app | no | `android`, `ios`, `ipados`, `macos`, `windows`, `linux`, `chromeos` |
| `device.os_version` | OS version | version | app | no | |
| `device.api_level` | Android API level | whole number | app | no | such as `35` |

### Browser

| Name | Label | Type | Source | Split | Known values |
|---|---|---|---|---|---|
| `device.browser` | Browser | text | app | no | `chrome`, `safari`, `firefox`, `edge`, `samsung` |
| `device.browser_version` | Browser version | version | app | no | |
| `device.browser_engine` | Browser engine | text | app | no | `blink`, `webkit`, `gecko` |

### Place and language

| Name | Label | Type | Source | Split | Known values |
|---|---|---|---|---|---|
| `geo.country` | Country | text | app | no | two letters, such as `US`, `IL` |
| `locale.language` | Language | text | app | no | such as `he`, `en` |
| `locale.timezone` | Time zone | text | app | no | such as `Asia/Jerusalem` |

Known values are suggestions in the editor. Any value works, and text is compared exactly as written: `US` is not `us`.
Which comparisons each type allows is in [Flags and rules → Operators](/guide/flags-and-rules#operators).

## Your dimensions, and `entity`

| Name | Label | Type | Source | Split |
|---|---|---|---|---|
| each dimension's key: `company`, `brand`, `store`… | the dimension's word: "Company" | text | server | **yes** |
| `entity` | your dimensions' words joined: "Company or brand" | text | server | **yes** |

- A dimension's value is the asking entity's entry at that level. For the brand `lumen`, `company` is `globex` and
  `brand` is `lumen`. So "Company is Globex" covers Globex and its brands.
- `entity` is exactly the one asking, at whatever level. The editor offers it once you have more than one dimension; with
  one, it is the same as that dimension.
- Below the asker's level the value is "none": for Globex itself, "Brand is Lumen" is false and "Brand is not set" is
  true. With no entity named at all, these values are missing, which an override counts as a match.
- A % split by a dimension puts every device of an entity, and of the entities under it, in the same group.
- `customer.id` and `customer.company` are older names for `entity` and the top dimension. Old History entries and
  requests still use them; the editor doesn't offer them.

See [Dimensions](/guide/dimensions#rules-on-dimensions).

## Sending attributes from an app

Apps and backends put their attributes in the OpenFeature evaluation context, by the names above:

```json
{
  "targetingKey": "d-5",
  "company": "acme",
  "app": { "version": "6.0.0", "build": 412 },
  "device": { "platform": "ios", "os_version": "18.1" },
  "locale": { "language": "en" }
}
```

- **Nested objects** are read by their dotted names: `{ "app": { "version": "6.0.0" } }` is `app.version`.
- **`targetingKey`** is used as `device.id` when the context has no `device.id`. flagd JSON reads `device.id` by name,
  so a backend evaluating flagd JSON sets `device.id` itself.
- **The entity** is named by its dimension key (`"company": "acme"`), within the API key's scope. The levels above it
  come from the server's own data.
- **Leave out what you don't know.** A missing value (or `null`, or an empty string) makes an ordinary rule not match,
  and an override match. Don't send placeholders like `"unknown"`: they are values.
- **Versions** may be sent as devices report them (`5.10`, `v5`, `6.0.0-beta.1`). One that can't be read at all, such
  as `abc`, leaves a version check undecided, like a missing value.

See [OpenFeature](/sdk/openfeature) and [Apps](/guide/apps) for setting up the providers.

## The country

`geo.country` is a two-letter code, uppercase. The server doesn't look up a country itself: put it in the evaluation
context. A common source is your CDN, which can tell the country from the IP address (Cloudflare adds a `CF-IPCountry`
header). An app file never varies by country: a check on `geo.country` stays in the file as a line for its reader.
