# Releases

A **release** turns a new feature on step by step, then goes away. In CompanyFlags a release is an ordinary flag
with the purpose **Release**: the same rules, evaluator, approvals and history as any other flag. It also gets its own
page under **Releases**, built around three questions: where is it, what's next, and when can the flag go?

Nothing extra is stored. Where a release is in an environment is read from the flag's defaults there, and each step
writes the next defaults, saved like any other change to them
([`server/release.ts`](https://github.com/dvir-daniel/companyflags/blob/main/server/release.ts)).

There are two kinds:

- an **on/off release**: true is the new feature, false the old one. It is removed once everyone has it;
- a **version release**: its values are versions, like `1.0.0` → `1.0.1`, and it stays for the next one.


![A release at 10% of devices, with its steps: 1%, 5%, 10%, 25%, 50%, everyone](/screenshots/console-release.png)

## Create one

**Releases → + New release** asks **What does it release?**: **A feature, on or off** or **Versions**. Then a name, a
key, an owner, tags and the flag sets it is in. An on/off release needs a remove-by date (90 days ahead by default); a
version release asks for its **First version** instead and has none.

A new release starts at the first step in every environment, and switched off in every protected environment. Its first
step there turns it on.

## The steps of an on/off release

| Step | Who has the feature | How the defaults look |
|---|---|---|
| **Not started** | Nobody | The default is false (or the code default). None of the release's rules exist. |
| **Early access** | These entities, on every device, whatever the % | A rule for everyone, "Company or brand is one of …", serving true |
| **% of devices** | Early access, plus N% of devices | A rule serving true to one range from 0 to N%, by device ID. It may be limited to some flag sets. |
| **Everyone** | Every device, with a device ID or without | The default is true, and the release's rules are gone |
| **Paused** | Nobody new | The release's rules are kept but paused, so resuming brings back the same devices |
| **Off** | Nobody gets a value | The flag's switch: apps use the default in their code |
| **Custom** | Depends on the rules | Anything else, such as two % rules or a % that doesn't start at 0. Edit it on the flag page. |

The release page's card shows the step, who has it, the stages **1% · 5% · 25% · 50% · Everyone**, and the buttons for
the next step: **Start at 1%**, **Increase to 25%**, **Roll back to 5%**, **Pause** or **Resume**, and **Release to
everyone**. Early access is added from the same card (**Give early access…**), and the flag's full rules editor sits
right under it.

- **The ladder** is 1% → 5% → 25% → 50% → everyone. A % set on the flag page (10%, say) shows where it falls, and the
  next step goes to the next one up.
- **Widening keeps everyone in.** Only the end of the range moves, so every device inside stays inside. Going back
  shrinks the same range: the devices that keep the feature are the ones that had it longest.
- **Everyone sets the default, not a 100% rule.** A device without an ID never matches a % rule, but the default reaches
  it.
- **Back from everyone goes to 50%**, the same half of devices as before. A % limited to some flag sets isn't brought
  back.
- **Rules are recognised by their shape, not their names.** Overrides and any other rules stay where they are; every step
  leaves them alone.

### How the release meets the rest of the flag

The release's own rules are rules for everyone, so the chain applies as usual
([Dimensions → Evaluation order](/guide/dimensions#evaluation-order)). Overrides come before them: the sample's
`new_checkout` keeps Android builds below 5.0 on the old checkout whatever the step. An entity's own rules come before
them too: Acme's rule "Acme gets it everywhere" gives Acme and Acme Kids the new checkout on every device the override
allows. An entity that uses "Own settings only" is never reached by the release.

### How a step is saved

Every step is one save of the flag's defaults, made against the version the page loaded.

- **Where nothing is reviewed**, it applies at once, with **Undo**.
- **In a protected environment** each button reads **Request: …** and sends a request whose reason names the step
  ("new_checkout in Production: 10% → 25% of devices"). Until it is applied or withdrawn, the card shows the request
  instead of the buttons.
- Steps are never drafted. If you have unpublished edits of the flag in that environment, they are discarded first,
  after a question.
- Turning a release off in a protected environment is a reviewed request, for on call too.

## Clean up

Once everyone has it in every environment where it is in a flag set, the list marks it **Ready to clean up** and the
page shows **Clean up**:

1. **Remove the flag from your code** and ship it. On mobile, keep sending it until old app versions are gone.
2. **Stop sending it.** In each protected environment, one request turns it off and takes it out of every flag set.
3. **Archive it.** It leaves every environment and the list; its history stays.

The Releases list filters by **Rolling out**, **Not started**, **Ready to clean up** and **Overdue** (past its
remove-by date), and by owner.

## Version releases

A version release's value is a version, which your app reads and loads: a web bundle, an over-the-air bundle, a model.
It moves devices from the version they're on to the next one with the same steps, then stays, ready for the next.

It is a release flag with text values where **every value is a version**. Versions are strict:

- `MAJOR.MINOR.PATCH`, three whole numbers without leading zeros, with an optional lowercase prerelease: `1.0.1`,
  `2.0.0-rc.1`;
- no `v` in front, no `+build` part, no uppercase, at most 64 characters;
- **each new version is higher than every version the release has**, so versions only go up;
- a version never changes once added.

**+ New version** on the release page suggests the next patch, with **Patch · Minor · Major** chips. Adding it isn't
reviewed and writes no history, because nobody gets it yet. The step that serves it is the reviewed change.

### Its steps

| Step | Who has what |
|---|---|
| **Everyone on 1.0.0** | Every device. No higher version exists yet. |
| **1.0.1 ready** | Everyone is still on 1.0.0; 1.0.1 exists and nobody has it. |
| **Early access** | Those entities on 1.0.1 on every device; everyone else on 1.0.0. |
| **% of devices** | Early access, plus N% of devices, on 1.0.1. |
| **Rolled back** | Everyone on 1.0.0 again; the release's rules are kept, paused, for **Resume**. |
| **Off** | Nobody gets a value: apps use the version built into them. |
| **Custom** | Anything else, such as two versions moving at once. |

- **Each version reaches new devices first.** Its % is salted with the version (`web_bundle/1.0.1`), so 1.0.2's first 1%
  isn't 1.0.1's. Early access is the way to choose a fixed early group.
- **Release to everyone** is offered at any step, in one save.
- **Replace with 1.0.2** points the moving % at a higher version, on the same devices.
- **Older builds that can't run a version** are held back by an ordinary rule placed first, such as "App version is
  below 5.2.0 → 1.0.0". It isn't one of the release's rules, so every step leaves it alone, and the card names it.
- Entities with their own settings keep them. One with its own default of 1.0.0 stays on 1.0.0 when everyone else
  moves (and outside the % before that). The card names entities with their own settings, with their own default.

### Rollbacks

| When | Button | What happens |
|---|---|---|
| 1.0.1 is moving and is bad | **Roll back to 1.0.0** | Its rules are paused: every device is back on 1.0.0. **Resume**, or **Resume with 1.0.2**, puts the same devices on it. |
| One step too far | **Back to 5%** | The range shrinks: the devices that moved last go back. |
| Everyone is on 1.0.1 and it's bad | **Roll back to 1.0.0** | Everyone goes back to the version this environment was on before, read from its history. **Another version…** offers the other lower ones. |

Rolling back never removes a version; the fix is always a new, higher one.

**On call rolls back at once.** In a protected environment, on call and admins see **Roll back to …** without
"Request". The dialog asks for a reason (required) and offers **Roll back now** or **Request review**. Rolling back now
is break-glass: it applies at once and History marks it as an emergency. It is allowed in two shapes only: every device
back on the version everyone else is on (the % kept), or everyone on an older version this environment served while the
flag was on. Anything else, including **Resume**, is a request. See [Approvals and history](/guide/approvals#break-glass).

## Not built yet

- Steps on a timer, and rollback on metrics: the server doesn't see evaluations.
- Releases of values other than on/off and versions, and a % of entities instead of devices.
- Copying a step from one environment to another.
- Removing a version added by mistake, and adding versions from CI with an API key.
- A "prerelease" mark on versions.
