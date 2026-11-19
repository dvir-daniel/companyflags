# The app file

Most apps read flags with [OpenFeature](/sdk/openfeature). The **app file** is the other way: everything one entity's
app needs, as one JSON file your CDN caches, so no request reaches the server. There is no OpenFeature provider for it;
this page describes it completely, so you can read it in any language. The server's own reference is about 100 lines:
`readClientFile` in [server/clientFile.ts](https://github.com/dvir-daniel/companyfeatures/blob/main/server/clientFile.ts),
with `testCondition` in [server/evaluator.ts](https://github.com/dvir-daniel/companyfeatures/blob/main/server/evaluator.ts),
[server/semver.ts](https://github.com/dvir-daniel/companyfeatures/blob/main/server/semver.ts) and
[server/hash.ts](https://github.com/dvir-daniel/companyfeatures/blob/main/server/hash.ts).

## Getting it

```http
GET /client/v1/flags/<environment>/<app>/<entity>/<secret>
If-None-Match: W/"…"            (the ETag of the file you have, if any)
```

- `200` with the file and an `ETag` (weak); `304` when your copy is current.
- `404` with `{ "error": "…" }` for any wrong link, environment or app.
- Ask again every minute or so, and when the app comes to the foreground. Keep the last file on the device and start
  from it next time.

## Shape

```ts
type ClientFile = {
  environment: string;
  revision: number;                       // the environment's publish number
  flags: Record<string, FileFlag>;        // by flag key
};

type FileFlag = {
  value?: unknown;                        // the value when no line below decides
  codeDefault?: true;                     // …or: no remote value, the app keeps the default in its code
  group?: string | null;                  // the % group name, when the flag's default comes from a %
  when?: FileLine[];                      // lines tried in order, before `value`
};

type FileLine = {
  if: Condition[];                        // every check must pass
  value?: unknown;
  codeDefault?: true;
  locked?: true;                          // an override: a missing attribute counts as a pass
  split?: { by: string; fallbackBy?: string; salt: string; hashVersion: number; from: number; to: number };
  group?: string | null;                  // set when a % decides: the name of its part (null: no name)
  outside?: string;                       // an outside line: no value, a group name for devices outside a %
  unit?: { by: string; fallbackBy?: string };
};

type Condition = { field: string; op: Op; values?: (string | number)[] };
```

A flag that isn't in the file isn't sent to this app: use the code default.

## Reading one flag

Given the flag `f` and the device's attributes `attrs` (a flat map: `app.version`, `device.id`…):

```text
outside = none
for each line in f.when (in order):
    if any check in line.if fails → next line
        (a check that can't be read — missing value, a version like "abc" — fails, unless line.locked: then it passes)
    if line.outside is set:
        if line.unit is set and the device has no unit ID → next line
        outside = outside ?? line.outside        (remember the first one)
        → next line
    if line.split is set:
        unit = attrs[split.by], or attrs[split.fallbackBy] when that's missing
        if unit is missing → next line
        b = bucket(split.salt, unit, split.hashVersion)
        if b < split.from or b >= split.to → next line
    return answer(line)
return answer(f)

answer(x):
    value = x.codeDefault ? (use the code default) : x.value
    group = x has a `group` key ? x.group : outside      (null means no name)
```

A value is **missing** when it's absent, `null` or the empty string.

## Checks

| `op` | Passes when | Values |
|---|---|---|
| `in` / `not_in` | the value, as text, is / isn't one of `values` | any |
| `contains_any` / `contains_none` | the value is a list holding one / none of `values` | any |
| `starts_with` / `ends_with` | the text starts / ends with one of `values` | text |
| `semver_lt`, `semver_lte`, `semver_gt`, `semver_gte`, `semver_eq` | the value compared as a version with `values[0]` | a version |
| `lt`, `lte`, `gt`, `gte` | the value compared as a number with `values[0]` | a number |
| `exists` / `missing` | the value is there / missing | none |

Every op except `exists` and `missing` **can't be read** (the line fails, or passes if `locked`) when the value is
missing, or when a version or number doesn't parse.

**Versions** parse leniently: an optional `v`, then 1 to 3 numbers (`5`, `5.1`, `5.1.2`), an optional
`-prerelease` and an ignored `+build`. Missing parts are 0, so `5` equals `5.0.0`. Prereleases sort before the release
(`6.0.0-beta.2` < `6.0.0`), compared part by part: numbers as numbers, below text.

## The bucket of a % of devices

```text
bucket(salt, unit, 2) = floor(murmur3_x86_32(cbor_text(salt + "/" + unit), seed 0) × 10000 / 2^32)
```

- `cbor_text(s)` is the deterministic CBOR encoding of the text `s`: a head with major type 3 and the UTF-8 length
  (`0x60 + n` below 24 bytes, `0x78 n` below 256, `0x79 nn` below 65536, else `0x7a nnnn`), then the UTF-8 bytes.
- The result is 0 to 9999; a device is inside a line's split when `from <= bucket < to`.
- This is exactly flagd's `fractional` with the bucketing value `{"cat": [salt, "/", unit]}`, so a backend using flagd
  puts each device in the same group.
- `hashVersion` is 2 in every file today. Treat a line with another version as not matching.

Test vectors:

| salt | unit | MurmurHash3 | bucket |
|---|---|---|---|
| `new_checkout` | `device-1` | 2747386712 | 6396 |
| `new_checkout` | `device-2` | 2657031076 | 6186 |
| `dark_mode` | `d-42` | 1798716484 | 4187 |
| `web_bundle/1.0.1` | `5f0c2a1e` | 3211301130 | 7476 |

## Attributes to report

Report what your platform knows, by these names: `app.version`, `app.build`, `app.channel`, `device.id` (a random ID
kept for the install), `session.id`, `device.platform`, `device.type`, `device.manufacturer`, `device.model`,
`device.memory_class`, `device.os`, `device.os_version`, `device.api_level`, `device.browser`,
`device.browser_version`, `device.browser_engine`, `geo.country`, `locale.language`, `locale.timezone`. The full list,
with their known values, is in [Attributes](/reference/attributes).

## Checking your implementation

Your reader is right when it gives the same answer as the server for every device. The server's tests do this for
the reference reader across thousands of combinations
([test/client-file.test.ts](https://github.com/dvir-daniel/companyfeatures/blob/main/test/client-file.test.ts));
the console's **Try it** panel shows the server's answer for any entity, app and device, to compare by hand.
