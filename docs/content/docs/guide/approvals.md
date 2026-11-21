---
title: "Approvals and history"
description: "Roles, reviewed changes in protected environments, the emergency path for on call, and the history that undoes them."
---

Every change in CompanyFlags is recorded, and in a protected environment it is reviewed before it applies. This page
covers who may do what, how a change goes through, the emergency path for on call, and how to look back and undo.

## Roles

Each person has one role, set by an admin in **Settings → People**:

| Role | Changes flags and entities | Reviews requests | Break-glass | Changes Settings |
|---|---|---|---|---|
| Viewer | | | | |
| Editor | yes | | | |
| Approver | yes | yes | | |
| On call | yes | yes | yes | |
| Admin | yes | yes | yes | yes |

Viewers can look (app links aside), run the Debug tab and Compare, and change nothing. Settings (environments,
services, dimensions, people, single sign-on, the CDN) are for admins. Beyond that, roles only decide who reviews and
who may use break-glass. The rules live in one module the server and the console share,
[`server/policy.ts`](https://github.com/dvir-daniel/companyflags/blob/main/server/policy.ts).

## Protected environments

In **Settings → Environments**, **Approvals needed** is a number from 0 to 5. With 1 or more, the environment is
protected: a change there becomes a **request** (a change set) and applies only after that many approvals, none of them
by its author. With 0, changes apply at once.

Nobody approves their own request, so a request needs that many reviewers besides its author. The drawer warns when the
people there are can't meet the number: with one admin and 1 approval, the admin's own requests could never go out.
Give a second person a role that reviews first. Lowering an environment's approvals asks you to confirm, and History
records it.

In a protected environment, also:

- putting a flag in a service, or taking it out, is a request too;
- a value the environment serves can't be changed in place: add a new value and point the rules at it (reviewed);
- nor can a value that a request there uses while it is in review, approved or scheduled. That holds in the console,
  for `flags push` and for imports. Change it once the request is applied, rejected or withdrawn;
- nor can the flag's [safe value](#the-safe-value), since break-glass serves it without review;
- a new flag starts off;
- a flag can be archived only once it is off and in no service there;
- only admins can move an entity under another parent, since that changes what it gets in every environment at once.

## How a change goes through

Your edits to flags in one environment collect in a **draft** until you publish them. When you publish:

- **where no review is needed**, every change in the draft applies at once, as one new version;
- **in a protected environment**, the draft becomes **one request** covering every flag in it, with a reason for the
  reviewer (required). The flag's On/Off switch and release steps are never drafted: each is its own request.

### Review

Approvers, on call and admins review requests, in **Approvals**. The sidebar counts the requests waiting that you may
approve.

- You can't approve or reject your own request.
- One rejection ends a request. Its author sends a new one.
- A reviewer can still reject a request once it is approved or scheduled, until it applies. That needs a reason.
- An approval is recorded against the request's exact content (a hash of its items, with the value of every variant
  they use). A request's content can't be edited: to change it, the author withdraws it and sends a new one.

A request is **in review**, **approved**, **scheduled**, **applied**, **rejected**, **withdrawn**, or ended by a
**conflict** or a **failure** when it was applied.

### Conflicts

Each item of a request records the version of the settings it was made against. If someone changes those settings in
the meantime, the request can't apply: it ends as a conflict, and nothing in it changes. The same holds for:

- an entity's own settings, when the flag's defaults changed after the request was made;
- a value the request serves, when it changed after the request was made, so a request never serves a value its
  reviewers didn't see;
- a change to which services a flag is in, when that list changed after the request was made.

Two requests made against the same version can both be approved, but only the first one applied goes through.

### Apply and schedule

Once a request has its approvals:

- anyone who can change flags may **Apply now**;
- its author or a reviewer may **schedule** it for a time. It applies on its own then, with every check run again, so a
  change made in between ends it as a conflict instead of overwriting. The field shows your time zone, and a time that
  has passed is refused. Scheduling asks you to confirm, like **Apply now**;
- its author or any reviewer may **unschedule** it, with a reason. It goes back to approved;
- its author may **withdraw** it while it is in review, approved or scheduled.

While a request waits to change a flag, the flag's page says so: saving a change to the flag first makes the request
end as a conflict.

If a scheduled request can't apply when its time comes, it ends as a conflict (or a failure), and History records why.
So do a withdrawal and an unschedule. All three go out on the **reviews** webhook too.

When a change moves a % rule, the review says how many % points of devices get another value. A change whose author
confirmed that it reassigns which devices are inside the % says so in red.

## Break-glass

Some changes can't wait for a review. In a protected environment, **on call and admins** may apply one change at once,
with a stated reason, in these cases only:

1. **Turning any flag off** (stop sending). The flag's defaults switch off and nothing else changes. That includes a
   release mid-rollout, the most common thing to go wrong. Off sends no value: each app uses the default in its own
   code, which CompanyFlags can't see.
2. **Serving a kill switch's or ops flag's safe value.** Every device gets that value: the rules for everyone are
   switched off and kept, and the default becomes the safe value. Entities' own settings on the flag get the same, so
   nobody is left out. The answer is an ordinary value (`DEFAULT` or `STATIC`), not `DISABLED`.
3. **Pausing a release**: its own rules (early access and the %) are switched off, and the % is kept for **Resume** (a
   request). Everyone is back on the old value except entities whose own settings serve the new value, such as Acme's
   rule "Acme gets it everywhere": pausing doesn't change those. The dialog names them and offers **Turn off now**,
   which stops it for everyone.
4. **Rolling a version release back** to an older version this environment served while the flag was on. See
   [Releases → Rollbacks](/guide/releases#rollbacks).

Turning a flag on, widening a %, or any other edit is a request. Break-glass changes the defaults only (the safe value
aside), never one entity's own settings. The reason is required and is saved with the change. History and the Versions
list mark it as an **emergency**. Sending a request for review instead is always possible.

### The safe value

A kill switch or ops flag can name a **safe value** in its **Settings**: one of its variants. The emergency dialog then
offers both ways off, and says what each does:

- **Serve the safe value**: every device gets it. Use this when you know which value is safe.
- **Stop sending**: no value is sent, and each app falls back to the default in its own code. Use this when each app's
  code default is the safe one.

Without a safe value, only **Stop sending** is offered. Break-glass serves the safe value without a review, so while
any environment is protected, only admins name or change it, and nobody changes its value in place (add a new value
and make that the safe value). A purpose without a safe value drops it, so only an admin changes the purpose of such a
flag, in the console. Anyone else, and `flags push`, gets a refusal: remove the safe value first.

A kill switch such as `payments_enabled` with the safe value `off`: on call serves `false` to every app in Production
without waiting, even an app whose code default is `true`.

## History

**History** lists every change, newest first: who made it, when, what kind it was, the flag and entity, the values before
and after, the comment, and the request it came from. It covers flags, entities, services, environments, dimensions,
API keys, people, single sign-on and the CDN, and requests made, reviewed, scheduled, unscheduled, withdrawn, and
refused when they were applied.

- **Append-only.** The database refuses to update, delete or truncate history entries.
- **Filters**: flag, entity, environment, version, person, kind of change and time. **Export CSV** and **Export JSON**
  give every entry the filters match.
- People whose access was removed stay named in it.

## Revisions and restore

Every change that alters what an environment serves makes a new numbered **revision** of it (the `revision` in every
answer's metadata). "Version" is kept for the versions of apps and of version releases. A change that serves
nothing (a request made, a review, a new API key) is history only.

The Flags page's **Revisions** tab lists an environment's revisions: when, by whom, the note, the request, and every
change in each. **Roll back to this revision** puts every flag setting changed since then back to how it was.

- **Restore undoes flag settings only**: rules, defaults, the On/Off switch and each entity's own settings. Later
  changes of other kinds stay as they are and are marked "not rolled back by restore": an entity moved or renamed, a
  replaced app link, which services a flag is in, variants, a flag's details. Entity changes apply to every environment
  at once, so restoring one environment can't undo them cleanly. Before you confirm, the dialog lists what it leaves
  alone.
- Archived flags and entities are left alone, and so are the defaults of flags created after that revision.
- The restore is itself a change: it applies as a new revision where no review is needed, or becomes a request with the
  reason "Roll back to revision N". So rolling back can be undone too.
- If every flag setting is already as it was, there is nothing to roll back, and it says so.

## Archive and restore

**Archive** takes a flag out of every service in every environment: apps fall back to the default in their code. In a
protected environment, the flag must be off and in no service there first.

An archived flag's page says it is archived and offers **Restore flag**. The same flag comes back, with its key, its
settings, variants and services in every environment as they were. Nothing else can take its key meanwhile. One
exception: in an environment that needs approval now, it comes back off and in no service. Turning it on there is a
request. History records the restore in every environment.

## Compare

**Compare**, in the sidebar, puts two sides next to each other, flag by flag: two entities, two environments or two
services. Each row shows what each side gets and why ("Globex's default", "Rule for everyone"), and you can show only
the flags that differ, or add attributes such as an app version. It runs the same evaluator as the Debug tab.

## Not built yet

- Approval rules per flag purpose or tag: the number of approvals is per environment.
- Promoting changes from one environment to another (Development → Production).
