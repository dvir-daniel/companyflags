# Release versions

Planned and built Nov 19, 2026 ([What was built](#what-was-built) lists what differs from the plan and what's left). A **version release** is a release whose value is a version, like `"1.0.0"`,
instead of on or off. It moves devices from the version they're on (1.0.0) to the next one (1.0.1) with the same steps
as any release: targeted customers, 1% → 5% → 25% → 50% of devices, then everyone. It then stays, ready for 1.0.2. The
app reads the version and loads it: a web bundle, an over-the-air JS bundle, a model, a schema.

Underneath it's still an ordinary flag. Each version is one of its variants. The version each environment is on, and
the one moving, are read from its defaults (base layer). The evaluator, app files and flagd JSON don't change. There
is one small migration. It changes no table, column or data: it only lets a version release go without a remove-by
date, because it's never removed.

> **How the ask was read.** The ask was: "release version can be only semver; move from release 1.0.0 to 1.0.1". It
> is read here as *the release's value is a version, and devices move to the next one*. It could also be read as "a
> feature tagged with the app build it ships in". That case is covered today by rules on `app.version`, and
> [Store builds](#store-builds) explains how the two fit together.

## What others do

| Product | How a version moves | What we take |
|---|---|---|
| **Apple phased release** ([docs](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/)) | 1, 2, 5, 10, 20, 50, 100% over 7 days, to a random sample of users with automatic updates on. Pause for up to 30 days in total; resume continues from the same day. **Release to all users at any time.** No rollback, and anyone can download the update manually. | The ladder, and **Release to everyone** at any step. Rollback is the one thing stores can't do, and we can. |
| **Google Play staged rollout** ([staged](https://support.google.com/googleplay/android-developer/answer/6346149), [halt](https://support.google.com/googleplay/android-developer/answer/16285429), [versioning](https://developer.android.com/studio/publish/versioning)) | Any %, raised by hand. **Users are chosen at random for each rollout.** Halting keeps the users who already have it, and resuming "affects the same users as before the halt". No rollback: you roll out a fixed build. versionCode only goes up; versionName is free text. | New devices first for each version, the same devices on resume, and versions that only go up. |
| **Expo EAS Update** ([runtime versions](https://docs.expo.dev/eas-update/runtime-versions/), [rollouts](https://docs.expo.dev/eas-update/rollouts/), [rollbacks](https://docs.expo.dev/eas-update/rollbacks/), [downloads](https://docs.expo.dev/eas-update/download-updates/)) | An update only loads on builds with the same `runtimeVersion`. A rollout % is set per update or per branch, and only one rollout is active at a time; you can revert it. "Roll back to embedded" serves the version built into the app. By default a device applies an update at its next cold start. | One version moving at a time. **Off** means the version built into the app. Apply at next launch. Old builds are held back with a rule on app version. |
| **CodePush** ([README](https://raw.githubusercontent.com/microsoft/react-native-code-push/master/README.md), [retired](https://learn.microsoft.com/en-us/appcenter/retirement)) | `--target-binary-version "~1.1.0"` picks the builds a release can reach. `--rollout 25`, then `patch` to raise it, `promote` from Staging to Production, `rollback`, and `-m` for mandatory (install now). App Center was retired on Mar 31, 2025. | Replace a bad version in place, on the same devices (the hotfix). Show what Staging has when you're in Production. |
| **LaunchDarkly** ([pipelines](https://launchdarkly.com/docs/home/releases/release-pipelines), [guarded](https://launchdarkly.com/docs/home/releases/guarded-rollouts), [progressive](https://launchdarkly.com/docs/home/releases/progressive-rollouts), [applications](https://launchdarkly.com/docs/home/releases/applications), [operators](https://launchdarkly.com/docs/home/flags/target-rules)) | Release pipelines take a flag through phases (an environment plus an audience) in order, for boolean flags only (beta). Guarded rollouts roll back on a metric regression. Mobile SDKs register applications and their versions. Its semver operators accept `2.0`. | Show each environment's version, without enforcing an order. Rollback on metrics stays later: our server doesn't see evaluations. |
| **Unleash** ([release templates](https://docs.getunleash.io/concepts/release-templates), [constraints](https://docs.getunleash.io/concepts/activation-strategies), [stickiness](https://docs.getunleash.io/concepts/stickiness)) | Milestones are started by hand, and each holds its own strategies. `SEMVER_*` needs `x.y.z` with an optional prerelease, which sorts lower; invalid input is false. The default groupId is the flag name, and changing it reshuffles users. | Steps by hand, as ours are. A new salt only when a new version starts: that's the one reshuffle we want. |
| **Firebase Remote Config** ([conditions](https://firebase.google.com/docs/remote-config/parameters/client.md.txt), [rollouts](https://firebase.google.com/docs/remote-config/rollouts)) | App version has string and numeric operators. The numeric ones only take plain `x.y.z`, with no prerelease. A % is fixed per seed. Rollouts raise the % gradually and can roll back. | The rollout card's layout, as today. |
| **Statsig, ConfigCat, Flagsmith** ([Statsig](https://docs.statsig.com/feature-flags/conditions), [ConfigCat](https://configcat.com/docs/targeting/targeting-rule/user-condition/), [Flagsmith](https://docs.flagsmith.com/flagsmith-concepts/segments/segment-rule-operators)) | Version operators (>, >=, <, <=, any of). ConfigCat needs valid semver on both sides. | Our `semver_*` operators already do this. Rule values stay lenient (see below). |

None of the flag tools require a new version to be higher than the last one. Android does, for versionCode. We do too.

## What a release version is

[SemVer 2.0.0](https://semver.org/), a little stricter, so each version has one spelling:

- **`MAJOR.MINOR.PATCH`**: three whole numbers, with no leading zeros (`0` alone is fine). Examples: `1.0.1`, `0.9.0`,
  `10.2.3`.
- **An optional prerelease** after a `-`: identifiers separated by dots, made of `0-9 a-z -`, with numbers that have no
  leading zeros. Examples: `1.0.1-beta.2`, `2.0.0-rc.1`. Lowercase only.
- **Refused:**
  - `v1.0.1`: semver.org says "v1.2.3" is not a semantic version.
  - `1.0` and `1`: all three parts are needed.
  - `1.0.1+build.5`: semver ignores build metadata when comparing, so `1.0.1+5` and `1.0.1+6` would be the same
    version.
  - `1.0.1-RC.1`: uppercase.
  - Spaces, more than 64 characters, and numbers above 2^53 − 1.
- **The check:** semver.org's own regular expression, without the build part and in lowercase:
  `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*))?$`
- **Each new version is higher than every version the release has,** by semver precedence:
  `1.0.1-beta.2 < 1.0.1-rc.1 < 1.0.1 < 1.0.2`. So versions only go up. Rolling back serves an older version; it never
  adds one again.
- **A version never changes once it's added.** A typo can be removed while nothing serves it.
- **Versions aren't variants.** A version release takes *free values* (see [Free values](#free-values)): each version is
  the value it is, stored as a hidden, content-addressed variant (`evaluator.ts` `hiddenKey`), so the Variants tab
  doesn't fill up with one row per version.

The console only ever shows versions, never keys. The messages say what to do: "Write it as 1.0.1: three numbers, no
v", "Higher than 1.0.1, the newest version", "Lowercase after the dash: 1.0.1-rc.1", "No + part: semver ignores it".

**Why rule values stay lenient.** Rules compare what devices report, such as "5.10" or "v5". So
`parseSemver` stays forgiving there, and `app.version` rules don't change. A release version is different: we write it,
compare it with the others, and show it everywhere. The strict check is a new function next to `parseSemver`.

## The model: a version release is a flag

- **Which flags:** `kind = 'release'`, `value_type = 'string'`, with at least one value, and every value a release
  version. This is read from the values, and nothing else is stored. On/off releases don't change.
- **What an environment is on:** its default. **What's moving:** the version the release's own rules serve. These are
  the shapes `release.ts` already recognises, a "Customer is one of …" rule and one % range from 0, now serving a
  version.
- **A new version is a new typed value.** Adding one isn't reviewed and writes no history (`control.ts`
  `upsertVariations`): it changes nothing anyone gets. Serving it is reviewed, because every step is a save of the
  defaults, which is reviewed where the environment needs it. The history shows that step.
- **No remove-by date.** A version release is never cleaned up. It's archived from the flag page when whatever it
  versions is retired.

### The steps

| Step | Who has what | The defaults |
|---|---|---|
| **Everyone on 1.0.1** | Every device, with an ID or without | The default is 1.0.1. None of the release's rules exist, and no higher version exists. A new release starts here, on its first version. |
| **Not started: 1.0.2 is ready** | Everyone is still on 1.0.1 | The same defaults, but a higher version exists. If there are several, the newest. |
| **Targeted customers** | These customers on 1.0.2 on every device; everyone else on 1.0.1 | A rule "Customer is one of …" serving 1.0.2 |
| **% of devices** | The targeted customers, plus N% of devices, on 1.0.2 | A rule serving 1.0.2 to one range `[0, N%)` by device ID, salted `<flag key>/<version>` (`web_bundle/1.0.2`). It may be limited to some flag sets. |
| **Rolled back** | Everyone on 1.0.1 again | The release's rules are kept but switched off (what **Pause** does today), so **Resume** puts the same devices back on 1.0.2 |
| **Off** | Nobody gets a value | The flag's switch: apps use the version built into them |
| **Custom** | Depends on the rules | Anything else. For example, two versions moving at once, a % serving a version that isn't higher than the default, or another rule serving the version that's moving. It's edited on the flag page. |

- **Same ladder:** 1% → 5% → 25% → 50% → everyone. Widening moves only the end of the range, so a device on 1.0.2 at
  5% is still on it at 25%. Going back shrinks the range, so the devices that moved last go back first.
- **Everyone sets the default** to the new version, as today. A device without an ID never matches a % rule, so it
  moves at everyone.
- **New devices first for each version:** the salt names the version, so 1.0.2's first 1% isn't 1.0.1's first 1%.
  Apple and Google both pick users at random for each rollout. Targeted customers are the way to choose a fixed early
  group.
- **Replace keeps the devices:** pointing the % at 1.0.3 instead of 1.0.2 only changes the range's variant, which
  `checks.ts` allows without a reshuffle. The rule keeps its salt.

## From 1.0.0 to 1.0.1, in the console

The example is `web_bundle`, in the flag set `web`. Development needs no review; Production does.

1. **Create it.** **+ New release** now asks first: **What does it release?** with two choices, **A feature (on or
   off)** and **Versions**. For Versions the form has a name and key (*Web bundle*, `web_bundle`), a **First version**
   (`1.0.0`, checked as you type), owner, tags and flag sets. There's no remove-by date. The form's note says: "Your
   code reads the version and loads it. Turned off, the flag sends nothing, and apps use the version built into them."
   It starts on 1.0.0 in every environment, and off where changes are reviewed, like any new flag.
2. **Add 1.0.1.** The release page's bar has **+ New version**. It opens a small dialog:
   - The version input is filled with the next patch, `1.0.1`. Three chips, **Patch 1.0.1 · Minor 1.1.0 · Major 2.0.0**,
     set it (bumps follow `npm version`). A prerelease is typed by hand.
   - **Add version** adds it to the release in every environment, and nobody gets it yet. The toast says "Added 1.0.1:
     nobody has it yet".
3. **Development.** The card reads **Everyone on 1.0.0 · 1.0.1 is ready** and offers **Start 1.0.1 at 1%** and
   **Release 1.0.1 to everyone**. One click on everyone applies at once, with Undo. The Environment picker's menu now
   shows "Development · Everyone on 1.0.1".
4. **Production.** The same card, with a line for context from the other environments: "Staging: everyone on 1.0.1
   since Nov 18".
   - **Request: start at 1%** sends a request. Its reason is "web_bundle in Production: 1.0.0 → 1.0.1, start at 1% of
     devices".
   - Customers are targeted first in the rules editor, as today: a rule "Customer is one of …" serving 1.0.1.
5. **Rolling out.** Once the request is approved, the card reads:
   - **Rolling out 1.0.1 in production · 1% of devices**, with "The other 99% stay on 1.0.0. Devices without a device ID
     get 1.0.1 at everyone."
   - The stages: 1% · 5% · 25% · 50% · Everyone.
   - The buttons: **Request: increase to 5%**, **Back to not started**, **Roll back to 1.0.0**.
6. **Increase**, step by step, each step a request: 5%, 25%, 50%, then **Request: release to everyone**. The default
   becomes 1.0.1, the rules go, and the card reads **Everyone on 1.0.1 · since Nov 21 · before: 1.0.0**.
7. **Next time,** **+ New version** suggests 1.0.2, and the same card offers **Start 1.0.2 at 1%**.

**When 1.0.1 is bad at 25% (the hotfix):**

1. **Roll back to 1.0.0.** Every device is back on 1.0.0 at its next fetch. The 25% is kept (paused), and the card
   says "Rolled back to 1.0.0 · Resume puts the same 25% back on 1.0.1".
2. **+ New version 1.0.2.** The card now also offers **Resume with 1.0.2 at 25%**: the same devices move straight to
   1.0.2, in one save.
3. Carry on as before to everyone. 1.0.1 is never served again, but it stays in the list of versions.

The card's buttons, per step:

| Step | Headline · line | Buttons |
|---|---|---|
| Everyone on 1.0.1 | **Everyone on 1.0.1** · since Nov 21, before: 1.0.0 | **+ New version**, **Roll back to 1.0.0** |
| 1.0.2 ready | **Everyone on 1.0.1** · 1.0.2 is ready: nobody has it yet | **Start 1.0.2 at 1%**, **Release 1.0.2 to everyone** |
| Targeted customers | **3 targeted customers** on 1.0.2 · everyone else stays on 1.0.1 | **Start at 1%**, **Roll back to 1.0.1** |
| 25% | **25% of devices** on 1.0.2 · the other 75% stay on 1.0.1 | **Increase to 50%**, **Back to 5%**, **Roll back to 1.0.1**, and **Replace with 1.0.3** when a higher version exists |
| Rolled back | **Rolled back to 1.0.1** · Resume puts the same 25% back on 1.0.2 | **Resume 1.0.2 at 25%**, and **Resume with 1.0.3 at 25%** when a higher version exists |

Where changes are reviewed, every button says **Request: …**, as today.

## What happens to devices on the old version

- **Outside the %**, a device gets the default, 1.0.0, on every fetch. It moves only when the % grows over it, or at
  everyone.
- **Without a device ID**, a device stays on 1.0.0 until everyone.
- **Targeted customers** are on 1.0.1 on every device from their step. Their app file holds no % at all: the customer
  check is settled on the server (`evaluator.ts` `forCustomer`).
- **Customers with their own settings** decide before the release does, as today. A customer whose own settings serve
  1.0.0 stays there: it's pinned. The card names them, for example "acme stays on 1.0.0 (its own settings): 2 versions
  behind". It links to that customer's settings on the flag.
- **Older app builds that can't run 1.0.1** are held back by an ordinary rule placed first, for example "App version is
  below 5.2.0 → 1.0.0". That's the `runtimeVersion` / `targetBinaryVersion` idea from EAS and CodePush. It isn't one of
  the release's own rules, so the steps leave it alone. It keeps working at everyone and for the next version. The card
  explains it: "Apps below 5.2.0 stay on 1.0.0".
- **When the device switches:**
  - A publish purges the CDN. A device's own copy may be up to a minute old (`delivery.ts` `CDN_CACHE`, `max-age=60`),
    and an offline device keeps its last file.
  - The SDK guide says: read the version at launch and apply a new one at the next launch, as EAS does by default. That
    goes for a rollback too, unless the app chooses to reload.
- **Turned off,** the release sends nothing, and apps use the version built into them (EAS's "roll back to embedded").

## Rollback

| When | Button | What happens | Then |
|---|---|---|---|
| Moving, and 1.0.1 is bad | **Roll back to 1.0.0** | The release's rules are switched off: every device is back on 1.0.0 | **Resume** (the same devices), or **Resume with 1.0.2** |
| Moving, one step too far | **Back to 5%** | The range shrinks: the devices that moved last go back | **Increase** again |
| Everyone on 1.0.1, and it's bad | **Roll back to 1.0.0** | The default goes back to the version this environment was on before, read from its history (not "the next lower version": Production may have skipped 1.0.1-rc.1). A menu beside it lists the other lower versions. | 1.0.1 reads as ready again; start it over, or add 1.0.2 |
| A fix is ready | **Replace with 1.0.2** / **Resume with 1.0.2** | The same devices move to 1.0.2 | Carry on |

- Every rollback is one save of the defaults. **Undo** works where nothing is reviewed. Where changes are reviewed it's
  a request, except that on call can roll back at once (decision 6).
- Rolling back never removes a version. Versions only go up, so the fix is always a new, higher version.
- This is where we differ from the stores: Apple and Google can only pause or halt, and devices that updated keep the
  build. Here the value is remote, so going back takes one save.

## Store builds

CompanyFeatures can't move a store build from 1.0.0 to 1.0.1. Apple's phased release and Play's staged rollout do
that. What we do for store builds is what we already do:

- **A feature that ships in 1.0.1** is an on/off release. The builds without it are held back with "App version is
  below 1.0.1 → off", placed first. The steps read it as one of the other rules, so the release stays on its steps. A
  rule "App version is at least 1.0.1 → on" would serve the new value, so the release would read as custom.
- **A version release for something the build loads** (an OTA bundle) uses the same hold-back rule for builds that
  can't run it.
- **No adoption numbers.** LaunchDarkly's application-version adoption comes from SDK traffic. Our devices read cached
  files, so the server doesn't know which builds are out there.

## Changes

### Data model

- **No new table or column.** A version release is a flag; its versions are variants; where each environment is, is its
  defaults.
- **Migration `0011_version_releases.sql`**, which only loosens a check:

  ```sql
  -- A version release stays for good: only on/off releases and experiments need a remove-by date.
  alter table flag drop constraint flag_check;
  alter table flag add constraint flag_remove_by_check check (
    kind not in ('release', 'experiment') or remove_by is not null or (kind = 'release' and value_type = 'string'));
  ```

  Postgres names 0001's unnamed table check `flag_check` (checked on PGlite). The server's check is the exact one:
  `checks.ts` `needsRemoveBy(kind)` becomes `needsRemoveBy(kind, variants)`, which waives the date only when every value
  is a release version.
- **Can it be done without a migration?** Everything except the remove-by date can. Without 0011, every version release
  would need a made-up remove-by date that keeps moving forward, and the list would mark it overdue. See decision 2.

### `server/semver.ts`

- `releaseVersionProblem(v): string | null`, the strict check above. The server and the console's inputs both use it.
- `bumpVersion(v, 'patch' | 'minor' | 'major')`, as `npm version`: `1.1.0-rc.1` → patch `1.1.0`.
- `compareSemver` is reused for ordering. Its plain-text comparison of prerelease parts is right for lowercase.

### `server/release.ts`

- **`ReleaseState`** gains `versions: null | { current: string | null; target: string | null; all: string[] }`:
  - `current` is the default's version; null means the version built into the app (`code_default`);
  - `target` is the version the release's rules serve, or, when they serve none, the newest version above `current`;
  - `all` lists every version, lowest first.

  For a version release, `newValue` / `oldValue` are the keys of `target` / `current`. With those, `isEarly`,
  `isRollout`, `ownRules`, pause and resume work unchanged.
- **The steps:** with no rules of its own, a version release reads as `not_started` if a higher version exists and
  `everyone` if not. `early`, `percent` and `custom` are as today, plus the custom cases in the table above.
- **Changes:**
  - `{ kind: 'everyone', version? }`: everyone on `version`, or on `target` when it's left out. The default becomes it
    and the release's rules go. This one change is both **Release to everyone** and **Roll back** from everyone.
  - `{ kind: 'replace', version }`: the release's rules serve a higher version instead, on the same devices.
  - A new % rule on a version release gets the salt `<key>/<target>`.
- **`nextChange` / `backChange`:** from not started, 1%. Back from 1%, the % is removed. A version release has no
  "back from everyone to 50%": rolling back from everyone is `everyone` with the previous version.
- **The words:** `stepText` gives "1.0.0 → 1.0.1 · 25% of devices", "Everyone on 1.0.1", "Everyone on 1.0.1 · 1.0.2 ready"
  and "Rolled back to 1.0.0 · 1.0.1 was at 25%". `changeText` gives "1.0.0 → 1.0.1: 5% → 25% of devices", "Released
  1.0.1 to everyone", "Rolled back to 1.0.0" and "Replaced 1.0.1 with 1.0.2".
- `readyToCleanUp` is false for a version release. `holdBacks(variants, base)` and `pinned(variants, customers)` give
  the card its lines.

### API

| Endpoint | Change |
|---|---|
| `POST /flags` | `kind: 'release'`, `valueType: 'string'`, `freeValues: true` and one typed value `{ key: hiddenKey('1.0.0'), value: '1.0.0' }` is accepted without `removeBy` |
| `POST /flags/:key/versions` `{ version }` | **New.** Checks the version (strict, and higher than every other) and adds it as a typed value (`upsertVariations`, unreviewed, no history). Refused on anything but a version release. |
| `PUT /flags/:key/variations` | On a version release, refuses values that aren't release versions, keys that don't match their version, and changes to an existing version |
| `GET /flags/:key` | For a version release, adds `versions: { [env]: { previous: string \| null; since: string \| null } }`: the version each environment was on before its current one, and since when. Read in one query from `change_history`: the base layer's newest change whose `after.defaultVariation` is the current one and whose `before` differs. |
| `GET /releases` | Each environment's state carries `versions`. `?show=not_started` includes version releases with a version ready; `?show=done` never includes them. Version releases are never overdue. |
| Steps | Unchanged: `PUT /flags/:key/layers/:env/base`, built by `applyChange`, applied now or sent as a request |

### Evaluator, app files, flagd

- **No change.** A version is a string value, and the % and rules work as for any flag. The JSON below is one
  customer's file at 25%, with a hold-back rule:

  ```json
  "web_bundle": {
    "value": "1.0.0",
    "when": [
      { "if": [{ "field": "app.version", "op": "semver_lt", "values": ["5.2.0"] }], "value": "1.0.0" },
      { "if": [], "split": { "by": "device.id", "salt": "web_bundle/1.0.1", "hashVersion": 2, "from": 0, "to": 2500 }, "value": "1.0.1" }
    ]
  }
  ```

- A targeted customer's file is just `{ "value": "1.0.1" }`. flagd JSON gets string variants
  (`"val-03b6…": "1.0.0"`) and the same `fractional` as any %. The salt is free text (migration 0001 `split_salt`).

### Console

- **`Releases.tsx`:**
  - the create form's first question (**A feature** / **Versions**), with a First version field instead of Remove by;
  - each row's step reads "1.0.0 → 1.0.1 · 25% of devices", with its bar;
  - the Remove by column shows "Stays".
- **`ReleasePage.tsx`:**
  - **+ New version** in the bar;
  - the card's headline, lines and buttons from the table above;
  - the other environments' versions as one line of context;
  - pinned customers and hold-back rules named under the card;
  - **Roll back to …** with its menu of lower versions.
- **`releaseParts.tsx`:** `ReleaseEnv` carries `versions`. `StepBar` is unchanged.
- **`FlagPage.tsx`:** the variants editor of a version release is read-only and points to **+ New version**.

## Free values

Added Nov 19, 2026, after the first build: versions as variants filled the Variants tab with one row per version. Every
flag now has a **Variants** setting, on by default:

- **On:** rules and the default pick from named values (the Variants tab), as before.
- **Off (free values):** any value is typed into the rules and the default. Each is stored as a hidden,
  content-addressed variant (`evaluator.ts` `hiddenKey`), the way a value typed in for one customer always was. Rules,
  the evaluator, app files and flagd don't change.
  - The console makes the hidden value when it's first typed (`flagParts.tsx` `FreeValue`). That writes no history and
    publishes nothing, because nobody gets it yet. The save that serves it is the change, and it's reviewed where the
    environment needs it.
  - In a rule, an empty field is the in-app default. For a default, the "Use in-app default" switch is.
  - Named variants from before still work where rules use them, and the Variants tab lists them as such.
- **Where it's set:** the flag's Settings tab, and the new-flag form, which asks for "Value everyone gets" when variants
  are off. `PUT /flags/:key/meta` and `POST /flags` take `freeValues`. It's recorded in the history.
- **Not for on/off flags:** they always have true and false. **Always for version releases:** their values are their
  versions.
- **Migration `0012_free_values.sql`:** a `free_values` column, false by default, and a check that a bool flag never
  has it.
- **flagd:** a flag that serves nothing gets a variant it needs. That used to be its first named one. A free-values flag
  with none gets a placeholder of its type, never another customer's typed value.
- **The Releases list** reads release values from the database, so a version added since the last publish shows as
  ready.
- **Tests:** `test/free-values.test.ts` (typed values only, no history for a new one, on/off flags, the setting both
  ways, flagd), and version releases now use typed values throughout `release.test.ts`.

## Tests

- **`test/semver.test.ts`**:
  - `releaseVersionProblem` accepts `0.0.0`, `1.0.1`, `10.20.30`, `1.0.1-beta.2` and `1.0.0-0.3.7`, and refuses
    `v1.0.1`, `1.0`, `01.0.0`, `1.0.1+5`, `1.0.1-RC.1`, `1.0.1-01`, ` 1.0.1` and a 65-character version;
  - semver.org's precedence list, in lowercase, sorts the same;
  - `bumpVersion` matches `npm version`, prereleases included.
- **`test/release.test.ts`, where a version release is**:
  - each step's defaults, read back as the step they were;
  - each step's defaults pass the server's checks without a reshuffle;
  - the % salt names the version;
  - **replace** keeps the range and the salt;
  - **roll back** mid-way and **resume** bring back the same devices;
  - **everyone** with a version is a rollback;
  - hold-back rules and customer settings are left alone;
  - two versions moving at once, or a % serving a version that isn't higher, read as custom;
  - every on/off test stays as it is.
- **`test/release.test.ts`, end to end**:
  - a version release is created without a remove-by date, and an on/off release still needs one;
  - `POST /versions` refuses a lower version, an equal one and every refused spelling;
  - in dev, the devices on 1.0.1 at 5% are still on it at 25%;
  - roll back puts every device on 1.0.0, and resume puts the same ones back;
  - **Resume with 1.0.2** moves those same devices to 1.0.2;
  - everyone reaches devices without an ID;
  - 1.0.2's first 5% isn't 1.0.1's;
  - in prod each step is a request worded with both versions;
  - rolling back from everyone goes to the version prod was on before, even when a lower version was skipped there.
- **`test/client-file.test.ts` and `test/flagd.test.ts`**:
  - a version release's file and flagd JSON agree with `evaluate()` for devices inside and outside the %, without an
    ID, on a held-back app version, and for a targeted customer.
- **`test/migrate.test.ts`**: 0011 applies on a database with releases in it, and the new check refuses a bool release
  without a remove-by date.

## What was built

Everything above, with decisions 1–7 and 9 as recommended. Where it differs or stops short:

- **Off where changes are reviewed.** A new version release starts off there, like any new flag. A version that's ready
  can still be started: its first step turns the flag on. While it's off, the card's headline is "Everyone on the
  built-in version", and the request says both, for example "Started 1.0.2 at 1% of devices, and turned on". On/off
  releases now word their first step the same way; before, it said only "Turned on".
- **The words** (`release.ts` `stepText` / `changeText`):
  - "1.0.0 → 1.0.1 · 25% of devices", "Everyone on 1.0.1", "1.0.1 · 1.0.2 ready", "Rolled back to 1.0.0 · 1.0.1 paused
    at 25% of devices";
  - steps: "Started 1.0.1 at 1% of devices", "1.0.1: 5% → 25% of devices", "Released 1.0.1 to everyone", "Rolled back to
    1.0.0", "Replaced 1.0.1 with 1.0.2", "Resumed with 1.0.2 at 25% of devices".
- **+ New version** is in the bar, and on the card at everyone. **Another version…** offers the other lower versions,
  with the version before marked.
- **The flag page:** a version release's Variants tab says it has none and points to its release page. Its Settings
  tab doesn't ask for a remove-by date, and its Variants switch stays off.
- **History:** adding a version writes none (nothing changed for anyone); the step that starts it does.
- **Tests:**
  - `semver.test.ts`: the strict check, semver.org's order, keys, bumps;
  - `release.test.ts`:
    - where a version release is: the steps, salts, hold-backs, rollback, resume with a higher version, custom, words;
    - end to end: creating one, adding versions, the steps in dev, and in prod with rollback to the version prod had
      before;
    - the app file and flagd JSON agree with the server;
  - `migrate.test.ts`: 0011;
  - `checks.test.ts`: remove-by.
- **Break-glass rollbacks (decision 6)**, for on call and admins (`policy.ts` `canBreakGlassRollback`):
  - Where changes are reviewed, **Roll back to …** isn't worded as a request for them. Its dialog asks why (required)
    and offers **Roll back now** (logged as break-glass, marked *Emergency* in History) or **Request review**.
  - It's a rollback only in two shapes (`release.ts` `isRollback` in the console; `layers.ts` `checkRollback` on the
    saved layer):
    - mid-way, every device back on the version everyone else is on, with the % kept;
    - otherwise, everyone on an older version this environment served while it was on (`layers.ts`
      `versionsServed`, from its history; `GET /flags/:key` sends it as `versions[env].served`).
  - Anything else is refused (403): growing, going forward, a version never served there, turning the release on,
    an on/off release. Resuming is a request again.
- **Not built yet:**
  - the "prerelease" mark (decision 8);
  - the other environments' versions in a request's reason: the card's footer shows them.

## Open decisions

1. **What a release version means.** Recommended: **the value is a version**, as above. A tag of the build a feature
   ships in is already possible with a rule on `app.version`, and it can't move anyone from 1.0.0 to 1.0.1.
2. **No remove-by date: migration 0011, or a made-up date?** Recommended: **0011**. It only drops a requirement, it's
   instant, and it touches no data. A made-up date that keeps moving would show up as "overdue" in the list, in exports
   and in the Flags page's Remove by column.
3. **The same first 1% every version, or new devices each time?** Recommended: **new devices** (the salt names the
   version), as Apple and Google pick users at random for each rollout. The same few devices shouldn't take every
   version's risk. A fixed early group is what targeted customers are for.
4. **Release to everyone in one step?** Recommended: **yes, for version releases**, at any step. Apple lets you
   "release it to all users at any time", and in Development you'll do it for every version. Where changes are reviewed
   it's one request, which the reviewer sees as "1.0.0 → 1.0.1 for everyone". On/off releases can follow later.
5. **Rolling back from everyone: everyone at once, or back to 50%?** Recommended: **everyone, to the version this
   environment had before** (from its history), with a menu for the other lower versions. A version found bad after
   it's out needs to go, not halve. Moving forward again is the normal steps.
6. **An emergency rollback where changes are reviewed.** Built (see above). Recommended: **allow break-glass for rollbacks only**, for the
   roles that may break glass on kill switches (`policy.ts` `canBreakGlass`), with a reason. A rollback only goes back
   to a version every device had before. Everything else stays a request.
7. **Enforce Development → Staging → Production?** Recommended: **show it, don't enforce it.** The card names what the
   other environments have, and the request's reason says "Staging: everyone on 1.0.1". LaunchDarkly's pipelines
   enforce an order, but they're boolean only and in beta. Our reviewers already decide what reaches Production.
8. **Prereleases in Production?** Recommended: **allowed and marked** with a small "prerelease" tag. Some teams ship
   `-rc` builds to a targeted customer on purpose. Uppercase is refused because of the keys.
9. **Old versions.** Recommended: **keep them**. They're small, and they're what rollback goes back to. A later
   **Remove unused versions** removes the ones nothing serves that are lower than every environment's current version.

## Not built (later, if needed)

- Steps on a timer (Apple's 7 days), and rollback on metrics (LaunchDarkly's guarded rollouts). The server doesn't see
  evaluations.
- Adding a version from CI with an API key. API keys are for backends that read values today.
- Release notes per version, and a warning for a rollout stuck halfway for weeks.
- **Pin to this version** for a customer, from the card. Today it's done in the customer's settings on the flag.
- A compatibility field on each version ("needs app 5.2.0+"). Hold-back rules do this for now.
