# Approvals and history

Every change in CompanyFeatures is recorded, and in a protected environment it is reviewed before it applies. This page
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

Viewers can look (app links aside), run the Debug tab and Compare, and change nothing. Settings (environments, apps,
dimensions, people, single sign-on, the CDN) are for admins. Beyond that, roles only decide who reviews and who may use
break-glass. The rules live in one module the server and the console share,
[`server/policy.ts`](https://github.com/dvir-daniel/companyfeatures/blob/main/server/policy.ts).

## Protected environments

In **Settings → Environments**, **Approvals needed** is a number from 0 to 5. With 1 or more, the environment is
protected: a change there becomes a **request** (a change set) and applies only after that many approvals, none of them
by its author. With 0, changes apply at once.

In a protected environment, also:

- sending a flag to an app, or no longer sending it, is a request too;
- a value the environment serves can't be changed in place: add a new value and point the rules at it (reviewed);
- a new flag starts off;
- a flag can be archived only once it is off and sent to no app there;
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
- An approval is recorded against the request's exact content (a hash of its items). A request's content can't be
  edited: to change it, the author withdraws it and sends a new one.

A request is **in review**, **approved**, **scheduled**, **applied**, **rejected**, **withdrawn**, or ended by a
**conflict** or a **failure** when it was applied.

### Conflicts

Each item of a request records the version of the settings it was made against. If someone changes those settings in
the meantime, the request can't apply: it ends as a conflict, and nothing in it changes. The same holds for:

- an entity's own settings, when the flag's defaults changed after the request was made;
- a change to which apps get a flag, when that list changed after the request was made.

Two requests made against the same version can both be approved, but only the first one applied goes through.

### Apply and schedule

Once a request has its approvals:

- anyone who can change flags may **Apply now**;
- its author or a reviewer may **schedule** it for a time. It applies on its own then, with every check run again, so a
  change made in between ends it as a conflict instead of overwriting;
- its author may **withdraw** it while it is in review, approved or scheduled.

## Break-glass

Some changes can't wait for a review. In a protected environment, **on call and admins** may apply one change at once,
with a stated reason, in two cases only:

1. **Turning a kill switch or ops flag off.** The flag's defaults switch off and nothing else changes. Turning a flag on,
   or any other edit, is a request. A release turned off is a request too.
2. **Rolling a version release back**, either every device back on the version everyone else is on (the % kept for
   resume), or everyone on an older version this environment served while the flag was on. See
   [Releases → Rollbacks](/guide/releases#rollbacks).

Break-glass works on the flag's defaults only, never on an entity's own settings. The reason is required and is saved
with the change. History and the Versions list mark it as an **emergency**. Sending a request for review instead is
always possible.

The sample data's `payments_enabled` is a kill switch: on call can turn payments off in Production without waiting.

## History

**History** lists every change, newest first: who made it, when, what kind it was, the flag and entity, the values before
and after, the comment, and the request it came from. It covers flags, entities, apps, environments, dimensions, API
keys, people, single sign-on and the CDN, and requests made, reviewed and scheduled.

- **Append-only.** The database refuses to update, delete or truncate history entries.
- **Filters**: flag, entity, environment, version, person, kind of change and time. **Export CSV** and **Export JSON**
  give every entry the filters match.
- People whose access was removed stay named in it.

## Versions and restore

Every change that alters what an environment serves makes a new numbered **version** of it. A change that serves
nothing (a request made, a review, a new API key) is history only.

The Flags page's **Versions** tab lists an environment's versions: when, by whom, the note, the request, and every
change in each. **Roll back to this version** puts every flag setting changed since then back to how it was.

- **Restore undoes flag settings only**: rules, defaults, the On/Off switch and each entity's own settings. Later changes
  of other kinds stay as they are and are marked "not rolled back by restore": an entity moved or renamed, a replaced
  app link, which apps get a flag, variants, a flag's details. Entity changes apply to every environment at once, so
  restoring one environment can't undo them cleanly. Before you confirm, the dialog lists what it leaves alone.
- Archived flags and entities are left alone, and so are the defaults of flags created after that version.
- The restore is itself a change: it applies as a new version where no review is needed, or becomes a request with the
  reason "Roll back to version N". So rolling back can be undone too.
- If every flag setting is already as it was, there is nothing to roll back, and it says so.

## Compare

**Compare**, in the sidebar, puts two sides next to each other, flag by flag: two entities, two environments or two
apps. Each row shows what each side gets and why ("Globex's default", "Rule for everyone"), and you can show only the
flags that differ, or add attributes such as an app version. It runs the same evaluator as the Debug tab.

## Not built yet

- Approval rules per flag purpose or tag: the number of approvals is per environment.
- Promoting changes from one environment to another (Development → Production).
