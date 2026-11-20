# Releases

Built Nov 18, 2026. A **release** is a flag that turns a new feature on step by step, then is removed. In the
console releases have their own place, **Releases**, built around three questions: where is it, what's next, and
when can the flag go? Underneath, a release is an ordinary flag: the same tables, evaluator, customer chain,
approvals, history and app files. There is no migration.

## The model: a release is a flag

- **Which flags are releases:** every flag with `kind = 'release'`. It's the schema's default kind, and the schema
  already requires a remove-by date for it. Changing a flag's purpose in its Settings tab moves it into Releases or
  out of them.
- **Nothing is stored for a release.** Where a release is in one environment is read from the flag's defaults (its
  base layer) by `server/release.ts`. It's a pure module shared with the console, like `checks.ts` and `policy.ts`.
  Each step builds the next defaults, and they are saved like any other change to them.
- **On/off releases.** True is the new feature, false the old one.

## The steps

| Step | Who has it | The defaults |
|---|---|---|
| **Not started** | Nobody | The default is false, or the in-app default. None of the rules below exist. A new flag in a protected environment starts off, and reads as not started too. |
| **Targeted customers** | These customers, on every device, whatever the % | A rule for everyone, "Customer is one of …", serving true |
| **% of devices** | The targeted customers, plus N% of everyone's devices | A rule serving true to one range `[0, N%)`, split by device ID (the salt is the flag key). It may be limited to some flag sets. |
| **Everyone** | Every device, with an ID or without | The default is true; the release's rules are removed |
| **Paused** | Nobody new | The release's rules are kept, switched off, so resuming brings back the same devices |
| **Off** | Nobody gets a value | The flag's switch: apps use the default in their code |
| **Custom** | Depends on the rules | Anything else, for example two % rules, a % that doesn't start at 0, another rule serving true, or a release that isn't on/off. It's edited on the flag page. |

- **The ladder:** 1% → 5% → 25% → 50% → everyone. A % set on the flag page (20%, say) is shown where it falls and
  goes to the next one up.
- **Widening keeps everyone in.** Only the end of the range moves, which the reshuffle check allows. Going back
  shrinks the same range, so the devices that keep the feature are the ones that had it longest.
- **Everyone sets the default, not a 100% rule.** A device without an ID never matches a % rule, so a 100% rule
  would leave it out.
- **Back from everyone goes to 50%** of every device, the same half as before (same salt). A % limited to some flag
  sets on the flag page isn't brought back.
- **Rules are recognised by their shape, not their names.** `dark_mode_v2`'s "Beta customers" rule reads as
  targeted customers. Overrides and other rules stay where they are, and the release page lists them under
  **Not part of the steps**.
- **Customers with their own settings** on the flag decide before the release does. A customer that uses
  **Customer only** is never reached by it. The release page names both.

## In the console

- **Sidebar:** **Releases**, right after Flags. The group is now called **Change** (Flags, Releases, Approvals).
- **`#/releases/<env>`, the list:** one environment at a time, picked in the bar as on Flags (the last one used,
  shared with Flags). One tall row per release, with its step there and a bar, when it last changed there, the
  owner, the remove-by date (red once past), and any request still waiting.
  - **Filters:** search, **Show** (rolling out or not started in that environment, ready to clean up, overdue) and
    owner. `GET /releases?environment=` applies "rolling out" and "not started" to that environment.
  - **+ New release:** name, key, description, owner, remove-by date (90 days ahead by default), tags and flag sets. It
    starts not started everywhere.
- **`#/release/<key>/<env>`, one release,** in two tabs like a flag's page. The bar holds the Environment picker
  (its menu shows the step in each) and the flag's switch.
  - **Rollout**, laid out the way Firebase's rollouts and LaunchDarkly's progressive rollouts are:
    - one card: the status ("Rolling out in production"), the share that has it ("20% of devices"), one sentence on
      who that is, the stages 1% · 5% · 25% · 50% · Everyone, and the next step: **Increase to 25%**
      (**Request: …** where changes are reviewed), **Roll back to 5%**, **Pause** / **Resume**. A request waiting
      for review takes the buttons' place;
    - **Clean up**, once everyone has it;
    - **Rules**, right under the card: the flag page's own rules editor (`FlagPage.tsx` `FlagRules`) with its draft,
      review and publish. The rollout's rules are among them, and targeted customers are added there, as a rule
      "Customer is one of …" serving true.
  - **History**: the flag's history, the same table as on its page.
- **Release flags stay in Flags.** Their Purpose badge links to the release page. A release flag's page says
  "This flag is a release: … Open release →". Creating a flag with purpose Release from Flags opens its release
  page.

## How a step is saved

Every step is one save of the base layer, `PUT /flags/:key/layers/:env/base`, with the version the page loaded:

- **Where nothing is reviewed,** it applies at once, and the toast offers **Undo**.
- **In a protected environment** it becomes a request. Its reason says the step ("new_checkout in Production:
  20% → 25% of devices"), plus an optional note. Until that request is applied or withdrawn, the release page shows
  it instead of the step buttons. A second request on the same version would only conflict when applied.
- **Drafts:** steps are never drafted, like the switch. Unpublished edits of the flag in that environment are
  discarded first, after a question.
- **On call** works as for any flag: turning a release off in a protected environment is a reviewed request.

## Cleanup

Once everyone has it in every environment where it's in a flag set, the release page shows **Clean up** and the list
marks it **Ready to clean up**:

1. **Remove the flag from your code.** On mobile, keep sending it until old app versions are gone.
2. **Stop sending it.** In each protected environment, one request turns it off and takes it out of every flag set:
   `POST /change-sets` with a layer item and a delivery item, applied in one version.
3. **Archive it.** It leaves every environment and the list.

## What's new on the server

| Part | Change |
|---|---|
| `server/release.ts` | `releaseState`, `applyChange`, `nextChange` / `backChange`, `ownRules`, `stepText` / `changeText`, `readyToCleanUp`, `overdue` |
| `GET /releases` | Every release and its step in each environment, read from the snapshots in memory. `?show=rolling\|not_started\|done\|overdue`, `?owner=`, search and paging as on every list. |
| `GET /change-sets?flag=` | The existing list, only the requests that change that flag |

Nothing else changed: no migration, no new way to save, no change to who may do what.

## Tests (`test/release.test.ts`)

- **Each step's defaults:**
  - pass the server's own checks without a reshuffle;
  - keep overrides and other rules in place;
  - read back as the step they were;
  - the ladder up and back down, back from everyone, pause and resume.
- **Rules made on the flag page:** a % on some flag sets, a name of its own, a backup ID; and custom shapes.
- **End to end:**
  - the list and its filters;
  - in dev, the devices in at 5% are still in at 25%, back to 5% keeps them, pause and resume bring them back, and
    everyone reaches devices without an ID;
  - in prod, each step is a request, and a second one on the same version conflicts;
  - cleanup in one request, then archive;
  - a new release from the form.
- `test/web-paths.test.ts`: the two new addresses and what they fetch first.

## Not built (later, if needed)

- Moving to the next step on a timer, and metrics or automatic rollback (the server doesn't see evaluations).
- Releases of values other than on/off, except versions: those are version releases (`docs/design/release-versions.md`).
  "% of customers" instead of devices.
- Copying a step from one environment to another.
