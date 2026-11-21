// The change journal: the one module that writes history. Every write goes through it, in the writer's own
// transaction, and every entry has the same shape (who, what kind, flag, entity, before, after, comment, change set):
//
//   change(tx, env, actor, entries)      changes what one environment serves: one new version of it (revision + 1)
//                                        holding every entry, and one publish in the outbox
//   changeEverywhere(tx, actor, entry)   changes what every environment serves (an entity, a flag's details or
//                                        variants): the same, once per environment
//   audit(q, actor, entry)               changes nothing that is served (a change set made, reviewed, scheduled,
//                                        withdrawn or refused when applied; people, single sign-on, API keys, an
//                                        unused app, an environment's name): history only, no version
//
// What a committed change asks of the app's memory (wake the publisher, forget cached app links or API keys, build a
// new environment's snapshot) is the journal's too. journaled(db, effects) is the app's database: a transaction on it
// runs the effects of what it recorded once each, after it commits, and a rolled-back one runs none. Callers don't
// order any of these steps; they say what changed.
//
// Every kind of change is declared in KINDS: what it changes, its after-commit effects, and whether a restore undoes
// it. Restore undoes flag settings only (docs/design/adr/0001-restore-undoes-flag-settings-only.md). A kind that
// serves also says whose answers it may change (its `scope`, events.ts PublishScope): the publisher reads it from
// History, so a publish purges only those files from the CDN and wakes only those devices' event streams (scopeOf).

import { all, one, type Db, type Queryable, type Tx } from './db.ts';
import { joinScopes, NOBODY, type PublishScope } from './events.ts';
import type { Actor } from './layers.ts';
import { isReleaseVersion } from './semver.ts';

/** What a committed change can ask of the app's memory. createApp wires each to that app's own parts. */
export type Effects = {
  forgetClientLinks: () => void;                      // the app-link secrets changed (delivery.ts LinkCache)
  forgetClientApps: () => void;                       // a service was added, changed kind or deleted (delivery.ts AppCache)
  forgetApiKeys: () => void;                          // a key was revoked (auth.ts KeyCache)
  refresh: (environment: string) => Promise<unknown>; // build an environment's snapshot now, before answering
  wake: () => void;                                   // the publisher: a version is waiting in the outbox
};
type Effect = keyof Effects;
const ORDER: Effect[] = ['forgetClientLinks', 'forgetClientApps', 'forgetApiKeys', 'refresh', 'wake'];

type Said = { flag: string | null; entity: string | null; before: any; after: any };
type Kind = {
  /** what it changes: what one environment serves, what every environment serves, or nothing served */
  serves: 'environment' | 'everywhere' | null;
  /** whether a restore puts it back as it was */
  restore: boolean;
  /** after it commits, besides waking the publisher (which every kind that serves does) */
  then?: Exclude<Effect, 'wake'>[];
  /** the change in words, for what a restore leaves alone; `name` gives an entity's name */
  says?: (e: Said, name: (entity: string) => string) => string;
  /** whose answers it may change (events.ts PublishScope); left out: anyone's in the environment */
  scope?: (e: Said) => PublishScope;
};

const settingsOf = (e: Said, name: (k: string) => string) => `${e.flag}${e.entity ? ` for ${name(e.entity)}` : ''}`;
// An entity as History keeps it.
type EntityState = { key: string; name: string; dimension?: string; parent?: string | null } | null;
const parentOf = (s: EntityState) => s?.parent ?? null;
const entityAdded = (e: Said, n: (k: string) => string) => {
  const a = e.after as EntityState;
  const parent = parentOf(a);
  return `Added ${a?.name ?? e.entity}${parent ? ` under ${n(parent)}` : ''}`;
};
const entityChanged = (e: Said, n: (k: string) => string) => {
  const b = e.before as EntityState;
  const a = e.after as EntityState;
  const who = a?.name ?? e.entity;
  const [from, to] = [parentOf(b), parentOf(a)];
  if (from && !to) return `${who} moved out of ${n(from)}`;
  if (!from && to) return `${who} moved under ${n(to)}`;
  if (from && to && from !== to) return `${who} moved from ${n(from)} to ${n(to)}`;
  if (b && a && b.name !== a.name) return `${b.name} renamed ${a.name}`;
  return `Changed ${who}`;
};
const linkReplaced = (e: Said, n: (k: string) => string) => `Replaced the app link of ${n(e.entity ?? '')}`;
// An entity's own settings change what it and the entities under it get; the defaults (no entity), everyone's.
const settingsScope = (e: Said): PublishScope => (e.entity ? { entities: [e.entity], links: [] } : null);
// Only a flag's kind is in what's served (evaluator.ts FlagDef): its name, description, tags, owner, remove-by date,
// free values, JSON schema and safe value aren't, so changing those changes nobody's answers.
const flagDetailsScope = (e: Said): PublishScope =>
  ((e.before as { kind?: string } | null)?.kind === (e.after as { kind?: string } | null)?.kind ? NOBODY : null);
// A rename changes nobody's answers; a move changes what the entity and those under it get.
const entityScope = (e: Said): PublishScope =>
  (parentOf(e.before as EntityState) === parentOf(e.after as EntityState) ? NOBODY : { entities: e.entity ? [e.entity] : [], links: [] });
// how someone signed in (access.ts SignInWay): "a password", "single sign-on (okta)"
const wayOf = (after: unknown) => {
  const w = (after ?? {}) as { with?: string; connection?: string; provider?: string };
  return w.with === 'sso' ? `single sign-on${w.connection ? ` (${w.connection})` : ''}`
    : w.with === 'provider' ? (w.provider ?? 'a provider') : w.with === 'two-factor' ? 'a password and an authenticator code'
    : w.with === 'recovery code' ? 'a password and a recovery code' : 'a password';
};

export const KINDS = {
  // flag settings (layers.ts applyItems): the only kinds a restore undoes
  'layer.create': { serves: 'environment', restore: true, scope: settingsScope, says: (e, n) => `Added settings on ${settingsOf(e, n)}` },
  'layer.update': { serves: 'environment', restore: true, scope: settingsScope, says: (e, n) => `Changed settings on ${settingsOf(e, n)}` },
  'layer.delete': { serves: 'environment', restore: true, scope: settingsScope, says: (e, n) => `Removed settings on ${settingsOf(e, n)}` },

  // the rest of what's served, in one environment
  'flag.create': { serves: 'environment', restore: false, says: (e) => `Created ${e.flag}` },
  // directly, or applied from a change set (layers.ts applyItems, a 'delivery' item) where the environment needs review
  'delivery.update': { serves: 'environment', restore: false, says: (e) => `Changed the services ${e.flag} is in` },
  'environment.create': { serves: 'environment', restore: false, then: ['forgetClientLinks', 'refresh'], says: () => 'Added this environment' },
  // a new secret for the environment (control.ts rotateEnvironmentLinks): every old app link and token stops working
  'environment.links_replaced': { serves: 'environment', restore: false, then: ['forgetClientLinks'], says: () => 'Replaced every app link in this environment' },

  // in every environment: a restore of one environment can't undo these cleanly
  'flag.update': { serves: 'everywhere', restore: false, scope: flagDetailsScope, says: (e) => `Changed the details of ${e.flag}` },
  'flag.archive': { serves: 'everywhere', restore: false, says: (e) => `Archived ${e.flag}` },
  // the same flag back from the archive, as it was (control.ts unarchiveFlag)
  'flag.unarchive': { serves: 'everywhere', restore: false, says: (e) => `Restored ${e.flag} from the archive` },
  'variations.update': { serves: 'everywhere', restore: false, says: (e) => {
    // a version release's new version (control.ts addVersion): "Added version 1.0.1 to web_bundle"
    const added = (e.after as { key: string; value: unknown }[] | null ?? []).filter((v) => !(e.before as { key: string }[] | null ?? []).some((b) => b.key === v.key));
    return added.length === 1 && isReleaseVersion(added[0].value) ? `Added version ${added[0].value} to ${e.flag}` : `Changed the variants of ${e.flag}`;
  } },
  // every server learns of it (each environment's new snapshot has it), but nobody's answers change: nobody asks as it
  // yet. No file is purged and no event stream woken.
  'entity.create': { serves: 'everywhere', restore: false, then: ['forgetClientLinks'], scope: () => NOBODY, says: entityAdded },
  // a new parent changes what it (and every entity under it) gets
  'entity.update': { serves: 'everywhere', restore: false, scope: entityScope, says: entityChanged },
  // the old link's file stops being served: every environment publishes, purging that entity's files from the CDN, and
  // its event streams are woken, so its apps ask again with the old token and hear it's replaced
  'entity.link_replaced': { serves: 'everywhere', restore: false, then: ['forgetClientLinks'], scope: (e) => ({ entities: [], links: e.entity ? [e.entity] : [] }), says: linkReplaced },

  // nothing served changes: history only
  'api_key.create': { serves: null, restore: false },
  'token.create': { serves: null, restore: false },
  'token.revoke': { serves: null, restore: false },
  'api_key.revoke': { serves: null, restore: false, then: ['forgetApiKeys'] },
  'environment.update': { serves: null, restore: false },
  'app.create': { serves: null, restore: false, then: ['forgetClientApps'] },
  // only while nothing is sent to the app and none of its keys work (control.ts): its file is empty when it goes
  'app.update': { serves: null, restore: false, then: ['forgetClientApps'] },
  'app.delete': { serves: null, restore: false, then: ['forgetClientApps'] },
  'change_set.create': { serves: null, restore: false },
  // a flags push (flagsAsCode.ts): its reason and link, and its steps (each is a change or a request of its own)
  'flags.push': { serves: null, restore: false },
  // set to go live later: nothing is served until it applies (a version of its own then)
  'change_set.schedule': { serves: null, restore: false },
  'change_set.approve': { serves: null, restore: false },
  'change_set.reject': { serves: null, restore: false },
  // the end of a request that never applied: withdrawn by its author, stopped before its time (back to approved), or
  // refused when it was applied (a conflict or a failure; `comment` says why)
  'change_set.withdraw': { serves: null, restore: false },
  'change_set.unschedule': { serves: null, restore: false },
  'change_set.apply_failed': { serves: null, restore: false },
  'person.add': { serves: null, restore: false },
  'person.role': { serves: null, restore: false },
  'person.invite': { serves: null, restore: false },
  'person.password_reset': { serves: null, restore: false },
  'person.remove': { serves: null, restore: false },
  'sso.add': { serves: null, restore: false },
  'sso.update': { serves: null, restore: false },
  'sso.remove': { serves: null, restore: false },
  // signing in (access.ts): each sign-in, each one that didn't go through, and the organization's sign-in rules
  'sign_in': { serves: null, restore: false, says: (e) => `${(e.after as { person?: string } | null)?.person ?? 'Someone'} signed in with ${wayOf(e.after)}` },
  'sign_in.failed': { serves: null, restore: false, says: (e) => `A sign-in as ${(e.after as { person?: string } | null)?.person ?? 'someone'} with ${wayOf(e.after)} didn’t go through` },
  'sign_in.rules': { serves: null, restore: false, says: () => 'Changed the sign-in rules' },
  // the CDN purge (cdn.ts): set up, removed, or run by hand
  'cdn.update': { serves: null, restore: false },
  'cdn.remove': { serves: null, restore: false },
  'cdn.purge': { serves: null, restore: false },
  // how the console looks (appearanceStore.ts): changed, or back to the default. History keeps a hash for each image
  'appearance.update': { serves: null, restore: false },
  'appearance.reset': { serves: null, restore: false },
  // the dimensions (dimensions.ts): their words, one added at the top or the bottom, an empty one removed. Nothing served
  // changes: an entity added in a new dimension, or moved, is an entity change of its own.
  'dimensions.update': { serves: null, restore: false },
  // webhooks (webhooks.ts): out (sent after each change) and in (another system's values, imported). History names
  // their address's host only, never the address, the headers or the secrets.
  'webhook.create': { serves: null, restore: false },
  'webhook.update': { serves: null, restore: false },
  'webhook.delete': { serves: null, restore: false },
  'webhook.secret': { serves: null, restore: false },
  'webhook_in.create': { serves: null, restore: false },
  'webhook_in.update': { serves: null, restore: false },
  'webhook_in.delete': { serves: null, restore: false },
  'webhook_in.token': { serves: null, restore: false },
} satisfies Record<string, Kind>;

export type ChangeKind = keyof typeof KINDS;
const kindOf = (kind: string): Kind | undefined => (KINDS as Record<string, Kind>)[kind];

/** The kinds of change a restore undoes: flag settings. */
export const RESTORABLE = (Object.keys(KINDS) as ChangeKind[]).filter((k) => kindOf(k)!.restore);

export type Entry = {
  kind: ChangeKind;
  flag?: string | null;
  entity?: string | null;
  before?: unknown;
  after?: unknown;
  comment?: string | null;
  changeSetId?: number | string | null;
};
export type Env = { id: number; key: string };

/** A change to what one environment serves: one new version of it, holding every entry. Returns the version. */
export async function change(tx: Tx, env: Env, actor: Actor, entries: Entry | Entry[]): Promise<number> {
  const list = [entries].flat();
  if (!list.length) throw new Error('a version needs at least one change');
  for (const e of list) expect(e.kind, 'environment');
  return version(tx, env, actor, list);
}

/** A change to what every environment serves: one new version of each, with the entry. */
export async function changeEverywhere(tx: Tx, actor: Actor, entry: Entry): Promise<void> {
  expect(entry.kind, 'everywhere');
  for (const env of await all<Env>(tx, `select id, key from environment order by id`)) await version(tx, env, actor, [entry]);
}

/** A change to nothing that is served: one history row, no version. `environment`: the one it is about, if any.
 *  On the database itself (no transaction) the statement commits at once, and so its effects run at once. */
export async function audit(q: Pick<Queryable, 'query'>, actor: Actor, entry: Entry & { environment?: number | null }): Promise<void> {
  expect(entry.kind, null);
  await write(q, entry.environment ?? null, null, actor, entry);
  await ask(q, [entry]);
}

/** A restore of an environment to `revision` leaves these alone: the changes in its later versions whose kind
 *  restore doesn't undo, oldest first, each in words ("Acme 12 moved out of Acme"). */
export type NotRolledBack = { revision: number; kind: string; flag: string | null; entity: string | null; text: string };
export async function notRolledBack(q: Queryable, envId: number, revision: number): Promise<NotRolledBack[]> {
  const rows = await all<Said & { revision: number; kind: string }>(q, `select h.revision::int as revision, h.change_type as kind,
      h.flag, h.entity, h.before, h.after
    from change_history h where h.environment_id = $1 and h.revision > $2 and not (h.change_type = any($3::text[]))
    order by h.id`, [envId, revision, RESTORABLE]);
  const keys = [...new Set(rows.flatMap((r) => [r.entity, parentOf(r.before), parentOf(r.after)]).filter((k): k is string => typeof k === 'string'))];
  const names = new Map(keys.length ? (await all<{ key: string; name: string }>(q, `select key, name from entity where key = any($1::text[])`, [keys]))
    .map((c) => [c.key, c.name]) : []);
  const name = (k: string) => names.get(k) ?? k;
  return rows.map((r) => ({
    revision: r.revision, kind: r.kind, flag: r.flag, entity: r.entity,
    text: kindOf(r.kind)?.says?.(r, name) ?? `${r.kind}${r.flag ? ` ${r.flag}` : ''}${r.entity ? ` (${name(r.entity)})` : ''}`,
  }));
}

/** Whose answers these changes may change, together (events.ts PublishScope): null when any of them may change anyone's. */
export function scopeOf(entries: readonly (Pick<Said, 'entity' | 'before' | 'after'> & { kind: string; flag?: string | null })[]): PublishScope {
  let scope: PublishScope = NOBODY;
  for (const e of entries) {
    const k = kindOf(e.kind);
    if (!k?.serves) continue;
    scope = joinScopes(scope, k.scope ? k.scope({ flag: e.flag ?? null, entity: e.entity ?? null, before: e.before ?? null, after: e.after ?? null }) : null);
    if (!scope) return null;
  }
  return scope;
}

/** The most revisions scopeOfRevisions reads at once: a process further behind than that reloads everything. */
const MAX_SCOPE_REVISIONS = 500;
/** Whose answers an environment's versions (`revisions`) may have changed, from what History says each one holds.
 *  null (anyone's) when a version holds nothing (History doesn't say), or there are too many to read. */
export async function scopeOfRevisions(q: Queryable, environment: string, revisions: readonly number[]): Promise<PublishScope> {
  const wanted = [...new Set(revisions)];
  if (!wanted.length) return NOBODY;
  if (wanted.length > MAX_SCOPE_REVISIONS) return null;
  const rows = await all<{ revision: string; kind: string; entity: string | null; before: unknown; after: unknown }>(q,
    `select h.revision, h.change_type as kind, h.entity,
        case when h.change_type in ('flag.update', 'entity.update') then h.before end as before,
        case when h.change_type in ('flag.update', 'entity.update') then h.after end as after
      from change_history h join environment e on e.id = h.environment_id
      where e.key = $1 and h.revision = any($2::bigint[])`, [environment, wanted]);
  const seen = new Set(rows.map((r) => Number(r.revision)));
  if (wanted.some((r) => !seen.has(r))) return null;
  return scopeOf(rows);
}

/** The app's database: a transaction on it runs the after-commit effects of what it recorded, once each, after it
 *  commits (none if it rolls back). An effect that fails is logged, not thrown: the change is committed, and the
 *  outbox and the caches' time limits catch up. A database that isn't journaled (a test's setup, before the app
 *  starts) records the same rows; there is nothing in memory yet to tell. */
export function journaled(db: Db, effects: Effects, log: (m: string) => void = () => {}): Db {
  const run = async (due: Map<string, Due>) => {
    for (const d of [...due.values()].sort((a, b) => ORDER.indexOf(a.effect) - ORDER.indexOf(b.effect))) {
      try {
        if (d.effect === 'refresh') { if (d.env) await effects.refresh(d.env); } else effects[d.effect]();
      } catch (e) {
        log(`after a change: ${d.effect} failed: ${(e as Error).message}`);
      }
    }
  };
  const collect = (due: Map<string, Due>) => (list: Due[]) => { for (const d of list) due.set(`${d.effect} ${d.env ?? ''}`, d); };
  const out: Db & Journaled = {
    query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const due = new Map<string, Due>();
      const result = await db.transaction((tx) => fn({ query: <R>(s: string, p?: unknown[]) => tx.query<R>(s, p), exec: (s: string) => tx.exec(s), [AFTER]: collect(due) } as Tx & Journaled));
      await run(due);
      return result;
    },
    // a statement on its own has committed when it returns
    [AFTER]: async (list) => { const due = new Map<string, Due>(); collect(due)(list); await run(due); },
  };
  return out;
}

// ---------------------------------------------------------------- implementation

const AFTER = Symbol('after commit');
type Due = { effect: Effect; env?: string };
type Journaled = { [AFTER]?: (list: Due[]) => void | Promise<void> };

function expect(kind: ChangeKind, serves: Kind['serves']) {
  const k = kindOf(kind);
  if (!k) throw new Error(`no kind of change "${kind}" (journal.ts KINDS)`);
  const call = (s: Kind['serves']) => (s === 'environment' ? 'change' : s === 'everywhere' ? 'changeEverywhere' : 'audit');
  if (k.serves !== serves) throw new Error(`a ${kind} change is recorded with ${call(k.serves)}, not ${call(serves)}`);
}

async function version(tx: Tx, env: Env, actor: Actor, entries: Entry[]): Promise<number> {
  const r = await one<{ revision: string }>(tx, `update environment set revision = revision + 1 where id = $1 returning revision`, [env.id]);
  if (!r) throw new Error(`no environment ${env.key}`);
  const revision = Number(r.revision);
  for (const e of entries) await write(tx, env.id, revision, actor, e);
  await tx.query(`insert into publish_queue (environment_id, revision) values ($1,$2)`, [env.id, revision]);
  await ask(tx, entries, env.key);
  return revision;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

async function write(q: Pick<Queryable, 'query'>, envId: number | null, revision: number | null, actor: Actor, e: Entry) {
  await q.query(`insert into change_history (environment_id, revision, changed_by, actor_type, change_type, flag, entity, before, after, comment, change_set_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [envId, revision, actor.name, actor.type, e.kind, e.flag ?? null, e.entity ?? null, json(e.before), json(e.after), e.comment ?? null, e.changeSetId ?? null]);
}

/** Hands the entries' effects to the transaction (run after it commits) or, outside one, runs them now. */
async function ask(q: object, entries: Entry[], env?: string) {
  const after = (q as Journaled)[AFTER];
  if (!after) return;
  const due: Due[] = [];
  for (const e of entries) {
    const k = kindOf(e.kind)!;
    for (const effect of k.then ?? []) due.push(effect === 'refresh' ? { effect, env } : { effect });   // only a refresh is per environment
    if (k.serves) due.push({ effect: 'wake' });
  }
  await after(due);
}
