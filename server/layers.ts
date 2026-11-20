// Layer saves, change sets and break-glass (the save flow from the design, with S1/M3/M6/M7 applied).

import { createHash } from 'node:crypto';
import { all, HttpError, one, type Db, type Queryable, type Tx } from './db.ts';
import type { Layer, Rule } from './evaluator.ts';
import { checkFlagSetup, checkLayer, type FieldFacts, type LayerDoc, type PlacedLayer } from './checks.ts';
import {
  approvalsNeeded, needsReview, reviewRefusal, roleInfo, scheduleRefusal, switchPath, type Decision, type EnvFacts, type ReviewFacts,
} from './policy.ts';
import { loadLayers } from './snapshot.ts';
import { isVersionFlag } from './checks.ts';
import { applyChange, releaseState, type Change } from './release.ts';
import { compareVersions } from './semver.ts';
import { audit, change, notRolledBack, RESTORABLE, type Entry, type NotRolledBack } from './journal.ts';

export type { LayerDoc, RuleDoc } from './checks.ts';
export type Actor = { name: string; type: 'user' | 'service_token' | 'scheduler' | 'bypass' | 'system' | 'agent' };
export type Item = {
  kind?: 'layer' | 'delivery';             // what it changes: a layer (the default), or the services the flag is in
  flag: string;
  entity: string | null;                   // whose own settings (null: the defaults)
  expectedLayerVersion: number | null;     // null = layer must not exist yet
  expectedBaseVersion?: number | null;     // an entity's items only
  proposed: LayerDoc | null;               // null = remove the entity's own settings
  allowReshuffle?: boolean;
  delivery?: { before: string[]; projects: string[] };   // delivery items: the services it is in now, and after
  // a request's layer items: the value of every variant the proposal uses, as they were when it was made (and reviewed)
  values?: Record<string, unknown>;
};

type FlagRow = { id: string; key: string; kind: string; value_type: string; archived_at: string | null };

async function flagRow(q: Queryable, key: string): Promise<FlagRow> {
  const f = await one<FlagRow>(q, `select id, key, kind, value_type, archived_at from flag where key = $1`, [key]);
  if (!f) throw new HttpError(404, `flag ${key} not found`);
  if (f.archived_at) throw new HttpError(409, `flag ${key} is archived`);
  return f;
}

async function currentLayer(q: Queryable, envId: number, flagId: string, entityKey: string | null) {
  const layers = await loadLayers(q, envId, [flagId]);
  return layers.find((l) => l.entityKey === entityKey)?.layer ?? null;
}

// What the checks and the writes need, read once per transaction instead of once per item: the attributes, and
// each flag's variants (key → id). Only for transactions that don't change variants.
export type TxFacts = { fields?: FieldFacts; variations: Map<string, Map<string, string>> };
export const newTxFacts = (): TxFacts => ({ variations: new Map() });

async function variationIds(q: Queryable, flagId: string, facts?: TxFacts): Promise<Map<string, string>> {
  const known = facts?.variations.get(flagId);
  if (known) return known;
  const vmap = new Map((await all<{ id: string; key: string }>(q, `select id, key from flag_variation where flag_id = $1`, [flagId])).map((v) => [v.key, v.id]));
  facts?.variations.set(flagId, vmap);
  return vmap;
}

// Loads what the checks need (the flag's variants, the attributes), then runs the shared checks
// in checks.ts. Throws 422 with every problem found.
export async function normalizeLayer(
  q: Queryable, flag: FlagRow, isBase: boolean, doc: LayerDoc, current: Layer | null, allowReshuffle = false, facts?: TxFacts,
): Promise<Layer> {
  const variants = new Set((await variationIds(q, flag.id, facts)).keys());
  const fields = facts ? (facts.fields ??= await fieldFacts(q)) : await fieldFacts(q);
  const { layer, errors, reshuffles } = checkLayer({ key: flag.key, kind: flag.kind, variants }, fields, isBase, doc, current, allowReshuffle);
  if (errors.length) throw new HttpError(422, 'These rules can’t be saved', { errors }, reshuffles ? 'needs_reshuffle' : undefined);
  return layer;
}

const variantsOf = async (q: Queryable, flagId: string) =>
  new Set((await all<{ key: string }>(q, `select key from flag_variation where flag_id = $1`, [flagId])).map((v) => v.key));

// The flag setup check (checks.ts) for a flag as it would be with `kind`: every stored layer, in every environment.
export async function flagSetupProblems(q: Queryable, flag: { id: string; key: string }, kind: string): Promise<string[]> {
  const envs = await all<{ id: number; key: string }>(q, `select id, key from environment order by id`);
  const placed: PlacedLayer[] = [];
  for (const e of envs) for (const l of await loadLayers(q, e.id, [flag.id])) placed.push({ environment: e.key, entity: l.entityKey, layer: l.layer });
  return checkFlagSetup({ key: flag.key, kind, variants: await variantsOf(q, flag.id) }, await fieldFacts(q), placed);
}

export async function fieldFacts(q: Queryable): Promise<FieldFacts> {
  const rows = await all<{ name: string; value_type: string; can_split_by: boolean }>(q, `select name, value_type, can_split_by from condition_field`);
  return Object.fromEntries(rows.map((f) => [f.name, { valueType: f.value_type, canSplitBy: f.can_split_by }]));
}

/** The variants a layer uses: its default, its value when off, and what its rules and their %s serve. A to Z. */
export function variantsUsed(l: LayerDoc | Layer | null | undefined): string[] {
  const keys = new Set<string>();
  const add = (k: unknown) => { if (typeof k === 'string') keys.add(k); };
  add(l?.defaultVariation);
  add(l?.variationWhenOff);
  for (const r of l?.rules ?? []) {
    add(r.serveVariation);
    for (const rg of r.split?.ranges ?? []) add(rg.variation);
  }
  return [...keys].sort();
}

/** The values of these variants of a flag now, by key. `lock`: kept from changing until the transaction ends. */
async function variantValues(q: Queryable, flagId: string, keys: string[], lock = false): Promise<Record<string, unknown>> {
  if (!keys.length) return {};
  const rows = await all<{ key: string; value: unknown }>(q, `select key, value from flag_variation where flag_id = $1 and key = any($2::text[])
    order by key ${lock ? 'for share' : ''}`, [flagId, keys]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------------------------------------------------------------- storage
// The one place that writes a layer and its rules (saves, approved requests and new flags).

export async function writeLayer(tx: Tx, envId: number, flag: Pick<FlagRow, 'id'>, entityId: string | null, layer: Layer, existing: { id: string } | undefined, actor: Actor,
  facts?: TxFacts) {
  const vmap = await variationIds(tx, flag.id, facts);
  const vid = (k: string | null) => (k ? vmap.get(k)! : null);
  let layerId: string;
  if (existing) {
    await tx.query(`update flag_layer set enabled = $2, variation_when_off_id = $3, default_variation_id = $4, inherit = $5,
      version = version + 1, updated_at = now(), updated_by = $6 where id = $1`,
      [existing.id, layer.enabled, vid(layer.variationWhenOff), vid(layer.defaultVariation), layer.inherit, actor.name]);
    layerId = existing.id;
    await tx.query(`delete from flag_rule where layer_id = $1`, [layerId]);
  } else {
    const r = await one<{ id: string }>(tx, `insert into flag_layer (flag_id, environment_id, entity_id, enabled, variation_when_off_id,
      default_variation_id, inherit, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [flag.id, envId, entityId, layer.enabled, vid(layer.variationWhenOff), vid(layer.defaultVariation), layer.inherit, actor.name]);
    layerId = r!.id;
  }
  // every rule in one statement, then every range of every % in one more (a column per field, one row per rule)
  const isBase = entityId === null;
  const rules = layer.rules;
  if (!rules.length) return;
  const col = <T,>(f: (r: Rule) => T) => rules.map(f);
  const inserted = await all<{ id: string; position: number }>(tx, `insert into flag_rule (layer_id, flag_id, layer_is_base, rule_key, position,
      name, locked, disabled, conditions, serve_variation_id, split_by, split_fallback_by, split_salt, split_hash_version, split_outside_group)
    select $1::bigint, $2::bigint, $3::bool, r.rule_key, r.position, r.name, r.locked, r.disabled, r.conditions::jsonb, r.serve, r.split_by,
      r.fallback_by, r.salt, r.hash_version, r.outside_group
    from unnest($4::uuid[], $5::int[], $6::text[], $7::bool[], $8::bool[], $9::text[], $10::bigint[], $11::text[], $12::text[], $13::text[],
      $14::smallint[], $15::text[]) as r(rule_key, position, name, locked, disabled, conditions, serve, split_by, fallback_by, salt, hash_version, outside_group)
    returning id, position`,
  [layerId, flag.id, isBase, col((r) => r.ruleKey), rules.map((_, pos) => pos), col((r) => r.name), col((r) => r.locked), col((r) => r.disabled),
    col((r) => JSON.stringify(r.conditions)), col((r) => vid(r.serveVariation)), col((r) => r.split?.by ?? null), col((r) => r.split?.fallbackBy ?? null),
    col((r) => r.split?.salt ?? null), col((r) => r.split?.hashVersion ?? null), col((r) => r.split?.outsideGroup ?? null)]);
  const ruleId = new Map(inserted.map((r) => [Number(r.position), r.id]));
  const ranges = rules.flatMap((r, pos) => (r.split?.ranges ?? []).map((rg) => ({ rule: ruleId.get(pos)!, variationId: vid(rg.variation), ...rg })));
  if (!ranges.length) return;
  await tx.query(`insert into flag_rule_split (rule_id, flag_id, variation_id, bucket, group_name)
    select s.rule_id, $1::bigint, s.variation_id, int4range(s.lo, s.hi), s.group_name
    from unnest($2::bigint[], $3::bigint[], $4::int[], $5::int[], $6::text[]) as s(rule_id, variation_id, lo, hi, group_name)`,
  [flag.id, ranges.map((x) => x.rule), ranges.map((x) => x.variationId), ranges.map((x) => x.from), ranges.map((x) => x.to), ranges.map((x) => x.group ?? null)]);
}

// Key-order-independent JSON (jsonb does not preserve key order).
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const stripVersion = (l: Layer | null) => (l ? { ...l, version: undefined, updatedAt: undefined, updatedBy: undefined } : null);

// The services a flag is sent to in an environment, A to Z.
export async function deliveredTo(q: Queryable, flagId: string, envId: number): Promise<string[]> {
  return (await all<{ key: string }>(q, `select p.key from flag_delivery d join project p on p.id = d.project_id
    where d.flag_id = $1 and d.environment_id = $2 order by p.key`, [flagId, envId])).map((r) => r.key);
}

/** The ids of these services (each once, A to Z); 422 for one that doesn't exist. */
export async function projectIds(q: Queryable, keys: string[]): Promise<{ id: number; key: string }[]> {
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) throw new HttpError(422, 'projects: a list of service keys');
  const wanted = [...new Set(keys)].sort();
  const found = await all<{ id: number; key: string }>(q, `select id, key from project where key = any($1::text[]) order by key`, [wanted]);
  const missing = wanted.find((k) => !found.some((p) => p.key === k));
  if (missing) throw new HttpError(422, `no service "${missing}"`);
  return found;
}

export const sameApps = (a: string[], b: string[]) => canonical([...a].sort()) === canonical([...b].sort());

// The one transaction every flag-settings change goes through: direct saves, approved change sets, scheduled
// applies, break-glass, restores. All its items are one new version (journal.ts change). An approved change set can
// also carry delivery changes (kind 'delivery': the apps the flag is sent to), applied in the same version.
export async function applyItems(db: Db, envKey: string, items: Item[], actor: Actor, opts: { changeSetId?: string; comment?: string } = {}) {
  return db.transaction((tx) => applyItemsIn(tx, envKey, items, actor, opts));
}

async function applyItemsIn(tx: Tx, envKey: string, items: Item[], actor: Actor, opts: { changeSetId?: string; comment?: string }) {
  const env = await one<{ id: number }>(tx, `select id from environment where key = $1 for update`, [envKey]);
  if (!env) throw new HttpError(404, `environment ${envKey} not found`);
  const sorted = [...items].sort((a, b) => a.flag.localeCompare(b.flag) || (a.entity ?? '').localeCompare(b.entity ?? ''));
  const versions: Record<string, number | null> = {};
  const entries: Entry[] = [];
  const said = { comment: opts.comment ?? null, changeSetId: opts.changeSetId ?? null };
  const facts = newTxFacts();
  const flags = new Map<string, FlagRow>();

  for (const it of sorted) {
    const flag = flags.get(it.flag) ?? await flagRow(tx, it.flag);
    flags.set(it.flag, flag);
    if (it.kind === 'delivery') {
      entries.push({ ...(await applyDelivery(tx, { id: env.id, key: envKey }, flag, it)), ...said });
      continue;
    }
    const cust = it.entity ? await one<{ id: string }>(tx, `select id from entity where key = $1 and archived_at is null`, [it.entity]) : null;
    if (it.entity && !cust) throw new HttpError(404, `"${it.entity}" not found`);
    const existing = await one<{ id: string; version: string }>(tx, `select id, version from flag_layer
      where flag_id = $1 and environment_id = $2 and entity_id is not distinct from $3 for update`, [flag.id, env.id, cust?.id ?? null]);
    const curVersion = existing ? Number(existing.version) : null;
    if (curVersion !== it.expectedLayerVersion) {
      throw new HttpError(409, `${it.flag} (${it.entity ?? 'defaults'}) was changed by someone else — reload to see it`, { flag: it.flag, entity: it.entity, currentVersion: curVersion }, 'conflict');
    }
    if (it.entity && it.expectedBaseVersion !== undefined) {
      const base = await one<{ version: string }>(tx, `select version from flag_layer where flag_id = $1 and environment_id = $2 and entity_id is null for update`, [flag.id, env.id]);
      if ((base ? Number(base.version) : null) !== it.expectedBaseVersion) {
        throw new HttpError(409, `The defaults of ${it.flag} changed after this request was approved`, { flag: it.flag, baseChanged: true }, 'conflict');
      }
    }
    // an approved request serves the values its reviewers saw: a variant whose value changed since is a conflict
    if (it.values) {
      const keys = Object.keys(it.values).sort();
      const now = await variantValues(tx, flag.id, keys, true);
      const changed = keys.find((k) => !Object.hasOwn(now, k) || canonical(now[k]) !== canonical(it.values![k]));
      if (changed) {
        throw new HttpError(409, `The value of ${it.flag}’s variant ${changed} changed after this request was made: send a new request`,
          { flag: it.flag, variant: changed }, 'conflict');
      }
    }
    const before = await currentLayer(tx, env.id, flag.id, it.entity);
    let after: Layer | null = null;
    if (it.proposed === null) {
      if (!it.entity) throw new HttpError(422, 'The defaults can’t be removed');
      if (existing) await tx.query(`delete from flag_layer where id = $1`, [existing.id]);
      versions[`${it.flag}/${it.entity}`] = null;
    } else {
      after = await normalizeLayer(tx, flag, !it.entity, it.proposed, before, it.allowReshuffle, facts);
      await writeLayer(tx, env.id, flag, cust?.id ?? null, after, existing, actor, facts);
      versions[`${it.flag}/${it.entity ?? 'base'}`] = (curVersion ?? 0) + 1;
    }
    entries.push({ kind: it.proposed === null ? 'layer.delete' : before ? 'layer.update' : 'layer.create', flag: it.flag, entity: it.entity,
      before: stripVersion(before), after: stripVersion(after), ...said });
  }
  const revision = await change(tx, { id: env.id, key: envKey }, actor, entries);
  return { revision, versions };
}

// A delivery item: the flag is sent to exactly these apps from now on, if what it was sent to hasn't changed since.
async function applyDelivery(tx: Tx, env: { id: number; key: string }, flag: FlagRow, it: Item): Promise<Entry> {
  if (!it.delivery) throw new HttpError(422, `${it.flag}: a delivery change needs the services it is in before and after`);
  const before = await deliveredTo(tx, flag.id, env.id);
  if (!sameApps(before, it.delivery.before)) {
    throw new HttpError(409, `the services ${it.flag} is in, in ${env.key}, changed after this request was made — reload to see them`, { flag: it.flag, delivery: before }, 'conflict');
  }
  const projects = await projectIds(tx, it.delivery.projects);
  await tx.query(`delete from flag_delivery where flag_id = $1 and environment_id = $2`, [flag.id, env.id]);
  if (projects.length) {
    await tx.query(`insert into flag_delivery (flag_id, project_id, environment_id) select $1::bigint, p, $3::smallint from unnest($2::smallint[]) as p`,
      [flag.id, projects.map((p) => p.id), env.id]);
  }
  return { kind: 'delivery.update', flag: it.flag, before, after: projects.map((p) => p.key) };
}

// ---------------------------------------------------------------- change sets (requests for review)

const hashItems = (items: unknown[]) => createHash('sha256').update(canonical(items)).digest('hex').slice(0, 16);

/** `author`: a person's key (or a webhook's name), or the Actor, so an agent's request says it's an agent's. */
export async function createChangeSet(db: Db, envKey: string, items: Item[], author: string | Actor, reason: string | null) {
  const by: Actor = typeof author === 'string' ? { name: author, type: 'user' } : author;
  if (!Array.isArray(items) || !items.length) throw new HttpError(422, 'a request needs at least one change');
  return db.transaction(async (tx) => {
    const env = await one<{ id: number }>(tx, `select id from environment where key = $1`, [envKey]);
    if (!env) throw new HttpError(404, `environment ${envKey} not found`);
    const facts = newTxFacts();
    type Prepared = { it: Item; flag: FlagRow; entityId: string | null; before: unknown; proposed: unknown; hashed: unknown };
    const prepared: Prepared[] = [];
    for (const it of items) {
      const flag = await flagRow(tx, it.flag);
      if (it.kind === 'delivery') {
        if (!it.delivery) throw new HttpError(422, `${it.flag}: a delivery change needs the services it is in before and after`);
        const now = await deliveredTo(tx, flag.id, env.id);
        if (!sameApps(now, it.delivery.before)) {
          throw new HttpError(409, `the services ${it.flag} is in, in ${envKey}, were changed by someone else — reload to see them`, { flag: it.flag, delivery: now }, 'conflict');
        }
        const projects = (await projectIds(tx, it.delivery.projects)).map((p) => p.key);
        const delivery = { before: now, projects };
        prepared.push({ it: { ...it, delivery }, flag, entityId: null, before: { projects: now }, proposed: { projects }, hashed: { kind: 'delivery', flag: it.flag, delivery } });
        continue;
      }
      // an entity that doesn't exist (or was archived) would otherwise be saved as a change to the defaults
      const cust = it.entity ? await one<{ id: string }>(tx, `select id from entity where key = $1 and archived_at is null`, [it.entity]) : null;
      if (it.entity && !cust) throw new HttpError(404, `"${it.entity}" not found`);
      const before = await currentLayer(tx, env.id, flag.id, it.entity);
      const curVersion = before ? before.version : null;
      if (curVersion !== it.expectedLayerVersion) {
        throw new HttpError(409, `${it.flag} (${it.entity ?? 'defaults'}) was changed by someone else — reload to see it`, { flag: it.flag, entity: it.entity, currentVersion: curVersion }, 'conflict');
      }
      const normalized = it.proposed ? await normalizeLayer(tx, flag, !it.entity, it.proposed, before, it.allowReshuffle, facts) : null;
      let expectedBaseVersion: number | null | undefined;
      if (it.entity) expectedBaseVersion = (await currentLayer(tx, env.id, flag.id, null))?.version ?? null;
      // the values it serves are part of what is reviewed: they are in the hash, and checked again when it is applied
      const values = await variantValues(tx, flag.id, variantsUsed(normalized), true);
      const { kind: _kind, delivery: _delivery, values: _values, ...layerItem } = it;
      const hashed = { ...layerItem, expectedBaseVersion, values };
      prepared.push({ it: hashed, flag, entityId: cust?.id ?? null, before: stripVersion(before),
        proposed: { doc: it.proposed, allowReshuffle: !!it.allowReshuffle, values }, hashed });
    }
    const hash = hashItems(prepared.map((p) => p.hashed));
    const cs = await one<{ id: string }>(tx, `insert into change_set (environment_id, author, reason, content_hash, by_agent) values ($1,$2,$3,$4,$5) returning id`,
      [env.id, by.name, reason, hash, by.type === 'agent']);
    for (const [seq, p] of prepared.entries()) {
      await tx.query(`insert into change_set_item (change_set_id, seq, kind, flag_id, entity_id, expected_layer_version, expected_base_version, before, proposed)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [cs!.id, seq, p.it.kind === 'delivery' ? 'delivery' : 'layer', p.flag.id, p.entityId, p.it.kind === 'delivery' ? null : p.it.expectedLayerVersion,
          p.it.expectedBaseVersion ?? null, JSON.stringify(p.before), JSON.stringify(p.proposed)]);
    }
    await audit(tx, { name: by.name, type: by.type === 'agent' ? 'agent' : 'user' }, { kind: 'change_set.create', environment: env.id, comment: reason, changeSetId: cs!.id });
    return { id: Number(cs!.id) };
  });
}

type ItemRow = {
  kind: 'layer' | 'delivery'; flag: string; entity: string | null; expected_layer_version: string | null; expected_base_version: string | null;
  before: { projects?: string[] } | null; proposed: { doc?: LayerDoc | null; allowReshuffle?: boolean; projects?: string[]; values?: Record<string, unknown> };
};
export async function loadChangeSetItems(q: Queryable, id: string | number): Promise<Item[]> {
  const rows = await all<ItemRow>(q, `
    select i.kind, f.key as flag, c.key as entity, i.expected_layer_version, i.expected_base_version, i.before, i.proposed
    from change_set_item i join flag f on f.id = i.flag_id left join entity c on c.id = i.entity_id
    where i.change_set_id = $1 order by i.seq`, [id]);
  return rows.map((r): Item => (r.kind === 'delivery' ? {
    kind: 'delivery', flag: r.flag, entity: null, expectedLayerVersion: null, proposed: null,
    delivery: { before: r.before?.projects ?? [], projects: r.proposed.projects ?? [] },
  } : {
    flag: r.flag, entity: r.entity,
    expectedLayerVersion: r.expected_layer_version === null ? null : Number(r.expected_layer_version),
    expectedBaseVersion: r.entity ? (r.expected_base_version === null ? null : Number(r.expected_base_version)) : undefined,
    proposed: r.proposed.doc ?? null, allowReshuffle: !!r.proposed.allowReshuffle,
    ...(r.proposed.values ? { values: r.proposed.values } : {}),   // requests made before values were kept have none
  }));
}

type CsRow = { id: string; status: string; author: string; content_hash: string; env_id: number; env_key: string; minApprovals: number };
async function csRow(q: Queryable, id: string | number, lock = false): Promise<CsRow> {
  const r = await one<CsRow>(q, `select cs.id, cs.status, cs.author, cs.content_hash, e.id as env_id, e.key as env_key, e.min_approvals as "minApprovals"
    from change_set cs join environment e on e.id = cs.environment_id where cs.id = $1 ${lock ? 'for update of cs' : ''}`, [id]);
  if (!r) throw new HttpError(404, 'request not found');
  return r;
}
const statusText = (status: string) => status.replace('_', ' ');

// Who may review is policy.ts reviewRefusal, the same answer the console enables its Approve and Reject buttons with.
// The request is locked while it is reviewed, so two approvals at the same time are counted together (with two
// approvals needed, the second sees the first) and a review can't land on a request that was just decided.
export async function reviewChangeSet(db: Db, id: number, reviewer: { key: string; role: string }, decision: Decision, comment: string | null) {
  if (decision !== 'approve' && decision !== 'reject') throw new HttpError(422, 'decision: "approve" or "reject"');
  await db.transaction(async (tx) => {
    const cs = await csRow(tx, id, true);
    const reviews = await all<ReviewFacts>(tx, `select reviewer, decision, for_content_hash = $2 as current from change_set_review
      where change_set_id = $1`, [id, cs.content_hash]);
    const refused = reviewRefusal(reviewer, { author: cs.author, status: cs.status, reviews }, decision);
    if (refused) throw new HttpError(refused.why === 'closed' || refused.why === 'done' ? 409 : 403, refused.message);
    await tx.query(`insert into change_set_review (change_set_id, reviewer, decision, for_content_hash, comment) values ($1,$2,$3,$4,$5)
      on conflict (change_set_id, reviewer) do update set decision = excluded.decision, for_content_hash = excluded.for_content_hash,
      comment = excluded.comment, created_at = now()`, [id, reviewer.key, decision, cs.content_hash, comment]);
    if (decision === 'reject') {
      await tx.query(`update change_set set status = 'rejected', decided_at = now() where id = $1`, [id]);
    } else {
      const n = await one<{ n: number }>(tx, `select count(*)::int as n from change_set_review where change_set_id = $1 and decision = 'approve' and for_content_hash = $2`, [id, cs.content_hash]);
      if (n!.n >= approvalsNeeded(cs)) await tx.query(`update change_set set status = 'approved', decided_at = now() where id = $1`, [id]);
    }
    await audit(tx, { name: reviewer.key, type: 'user' }, { kind: decision === 'approve' ? 'change_set.approve' : 'change_set.reject', comment, changeSetId: id });
  });
  return csRow(db, id);
}

// The status moves to applied in the same transaction as the changes (compare-and-set: only from the status it
// may be applied from), so a request is applied once: a second apply at the same time waits, then finds it applied
// (409), and a crash can't leave it applied but marked appliable. If applying fails, the request is marked
// conflict or failed, unless another apply won in the meantime.
export async function applyChangeSet(db: Db, id: number, actor: Actor) {
  const allowed = actor.type === 'scheduler' ? ['scheduled'] : ['approved'];
  let notAppliable: HttpError | null = null;
  try {
    return await db.transaction(async (tx) => {
      const cs = await one<{ env_key: string }>(tx, `update change_set cs set status = 'applied', applied_at = now(), last_error = null,
          apply_attempts = apply_attempts + 1
        from environment e where cs.id = $1 and cs.status::text = any($2::text[]) and e.id = cs.environment_id returning e.key as env_key`, [id, allowed]);
      if (!cs) {
        const cur = await csRow(tx, id);
        throw (notAppliable = new HttpError(409, `this request is ${statusText(cur.status)}, not ${allowed.join(' or ')}`, { status: cur.status }));
      }
      const items = await loadChangeSetItems(tx, id);
      const res = await applyItemsIn(tx, cs.env_key, items, actor, { changeSetId: String(id), comment: `change set #${id}` });
      await tx.query(`update change_set set applied_revision = $2 where id = $1`, [id, res.revision]);
      return { status: 'applied', revision: res.revision };
    });
  } catch (e) {
    if (e === notAppliable || (e instanceof HttpError && e.status === 404)) throw e;
    const conflict = e instanceof HttpError && e.status === 409;
    await db.query(`update change_set set status = $2, last_error = $3, apply_attempts = apply_attempts + 1 where id = $1 and status::text = any($4::text[])`,
      [id, conflict ? 'conflict' : 'failed', (e as Error).message, allowed]);
    throw e;
  }
}

// Scheduling an approved request to go live later. Who may is policy.ts scheduleRefusal (README: the author, or
// someone who reviews requests). The request is locked while its status moves (compare-and-set: only from approved).
// In History as change_set.schedule (journal.ts audit: nothing is served until it applies).
export async function scheduleChangeSet(db: Db, id: number, at: string, user: { key: string; role: string }) {
  const when = new Date(at);
  if (typeof at !== 'string' || Number.isNaN(when.getTime())) throw new HttpError(422, 'invalid time');
  await db.transaction(async (tx) => {
    const cs = await csRow(tx, id, true);
    const refused = scheduleRefusal(user, cs);
    if (refused) throw new HttpError(refused.why === 'closed' ? 409 : 403, refused.message);
    const r = await tx.query(`update change_set set status = 'scheduled', scheduled_at = $2 where id = $1 and status = 'approved'`, [id, when.toISOString()]);
    if (!r.affected) throw new HttpError(409, `only approved requests can be scheduled (this one is ${statusText(cs.status)})`);
    await audit(tx, { name: user.key, type: 'user' }, { kind: 'change_set.schedule', environment: cs.env_id, after: { scheduledAt: when.toISOString() }, changeSetId: id });
  });
}

export async function cancelChangeSet(db: Db, id: number, user: string) {
  const cs = await csRow(db, id);
  if (cs.author !== user) throw new HttpError(403, 'only the author can cancel');
  const r = await db.query(`update change_set set status = 'cancelled', decided_at = now()
    where id = $1 and author = $2 and status in ('in_review', 'approved', 'scheduled')`, [id, user]);
  if (!r.affected) throw new HttpError(409, `this request is ${statusText((await csRow(db, id)).status)}`);
}

// M7: break-glass. Only the safe direction (turn a kill switch / ops flag's defaults OFF), by on-call, with a reason.
// Who may, and on which flags, is policy.ts switchPath: the console offers "Turn off now" on the same answer. A version
// release can be rolled back the same way (checkRollback).
async function checkBreakGlass(db: Db, env: EnvFacts & { id: number }, item: Item, user: { key: string; role: string }) {
  if (!roleInfo(user.role).breaksGlass) throw new HttpError(403, 'break-glass requires the on-call role');
  if (item.entity) throw new HttpError(403, 'break-glass only applies to the defaults');
  const flag = await flagRow(db, item.flag);
  if (flag.kind === 'release') return checkRollback(db, env, flag, item);
  if (switchPath(user, flag, env, false) !== 'break-glass') throw new HttpError(403, 'break-glass only applies to kill_switch / ops flags');
  const cur = await currentLayer(db, env.id, flag.id, null);
  if (!cur?.enabled || item.proposed?.enabled !== false) throw new HttpError(403, 'break-glass can only switch a flag OFF');
  const same = canonical({ ...stripVersion(cur), enabled: false }) === canonical(stripVersion(await normalizeLayer(db, flag, true, item.proposed, cur)));
  if (!same) throw new HttpError(403, 'break-glass cannot change anything except enabled → false');
}

/** A version release's versions each environment has served while it was on: its defaults' version in every recorded
 *  change of them (the flag's creation included) that left it on. What a break-glass rollback may go back to. Variant
 *  keys, by environment id. */
export async function versionsServed(q: Queryable, flagKey: string): Promise<Map<number, Set<string>>> {
  const rows = await all<{ env: number; v: string | null }>(q, `select distinct h.environment_id as env,
      coalesce(h.after->>'defaultVariation', h.after->'layer'->>'defaultVariation') as v
    from change_history h where h.flag = $1 and h.entity is null and h.environment_id is not null
      and h.change_type in ('flag.create', 'layer.create', 'layer.update')
      and coalesce(h.after->>'enabled', h.after->'layer'->>'enabled') = 'true'`, [flagKey]);
  const served = new Map<number, Set<string>>();
  for (const r of rows) if (r.v) (served.get(Number(r.env)) ?? served.set(Number(r.env), new Set()).get(Number(r.env))!).add(r.v);
  return served;
}

// Break-glass on a version release (docs/design/release-versions.md): only a rollback, the safe direction, where every
// device goes back to a version it had before. Mid-way: the release's own rules switched off (everyone back on the
// version everyone else is on, the % kept for resume). Otherwise: everyone on an older version this environment served
// while it was on. The saved layer must be exactly that step (release.ts applyChange), with nothing else changed.
async function checkRollback(db: Db, env: EnvFacts & { id: number }, flag: FlagRow, item: Item) {
  const variants = await all<{ key: string; value: unknown }>(db, `select key, value from flag_variation where flag_id = $1 and not is_code_default order by id`, [flag.id]);
  if (!isVersionFlag({ valueType: flag.value_type, variants })) throw new HttpError(403, 'break-glass only applies to kill_switch / ops flags, and to rolling a version release back');
  const cur = await currentLayer(db, env.id, flag.id, null);
  if (!cur?.enabled) throw new HttpError(403, 'break-glass only rolls a version release back: it can’t turn one on');
  const now = releaseState(variants, cur);
  const proposed = canonical(stripVersion(await normalizeLayer(db, flag, true, item.proposed as LayerDoc, cur)));
  const same = async (change: Change) => {
    let step: Layer;
    try { step = applyChange(variants, cur, change, flag.key); } catch { return false; }
    return canonical(stripVersion(await normalizeLayer(db, flag, true, step as LayerDoc, cur))) === proposed;
  };
  if ((now.step === 'early' || now.step === 'percent') && !now.paused && await same({ kind: 'pause' })) return;
  const key = (item.proposed as LayerDoc | null)?.defaultVariation ?? null;
  const version = variants.find((v) => v.key === key)?.value;
  const lower = typeof version === 'string' && !!now.versions?.current && compareVersions(version, now.versions.current) < 0;
  if (lower && (await versionsServed(db, flag.key)).get(env.id)?.has(key!) && await same({ kind: 'everyone', version: version as string })) return;
  throw new HttpError(403, lower
    ? `break-glass only rolls back to a version this environment served while it was on: ${version} never was (send a request instead)`
    : 'break-glass only rolls a version release back: everyone on the version they’re on (keeping the %), or on an older version served here before');
}

// ---------------------------------------------------------------- how a change goes live
// Every save from the console comes through here: applied now where the environment needs no review (policy.ts
// needsReview), otherwise a change set (with a reason for the reviewer), or break-glass for an on-call switch-off.
export type Submitted =
  | { applied: true; revision: number; versions: Record<string, number | null>; bypass?: true }
  | { applied: false; changeSetId: number };

export async function submitChange(db: Db, envKey: string, items: Item[], user: { key: string; role: string; token?: { agent: boolean } },
  opts: { reason?: string | null; bypassReason?: string | null } = {}): Promise<Submitted> {
  const by: Actor = { name: user.key, type: user.token?.agent ? 'agent' : 'user' };
  if (!items.length) throw new HttpError(422, 'nothing to save');
  const env = await one<EnvFacts & { id: number }>(db, `select id, min_approvals as "minApprovals" from environment where key = $1`, [envKey]);
  if (!env) throw new HttpError(404, 'environment not found');
  const reason = opts.reason?.trim() || null;
  if (!needsReview(env)) {
    return { applied: true, ...(await applyItems(db, envKey, items, by, { comment: reason ?? undefined })) };
  }
  const bypass = opts.bypassReason?.trim();
  if (bypass) {
    if (items.length !== 1) throw new HttpError(403, 'break-glass applies to one change at a time');
    await checkBreakGlass(db, env, items[0], user);
    const res = await applyItems(db, envKey, items, { name: user.key, type: 'bypass' }, { comment: `BREAK-GLASS: ${bypass}` });
    return { applied: true, bypass: true, ...res };
  }
  if (!reason) throw new HttpError(422, 'add a reason for the reviewer');
  const cs = await createChangeSet(db, envKey, items, by, reason);
  return { applied: false, changeSetId: cs.id };
}

// An alert turns a kill switch off (POST /api/alerts/kill, docs/guide/ai.md): the console's break-glass "Turn off now",
// sent by Grafana, Datadog or any alert with an On call or Admin token. Only a kill switch, only its defaults' On/Off
// switch, only off. It goes live at once in any environment, and History records it as break-glass ('bypass') under
// the token's person, with the alert's name. A kill switch that's off already changes nothing (alerts fire again).
export type Killed = { applied: true; revision: number; versions: Record<string, number | null>; bypass: true } | { applied: false; alreadyOff: true };
export const ALERT_NAME_MAX = 200;
export async function killFromAlert(db: Db, envKey: string, flagKey: string, user: { key: string; role: string }, alert?: string | null): Promise<Killed> {
  if (!roleInfo(user.role).breaksGlass) throw new HttpError(403, 'only an On call or Admin token can turn a flag off from an alert');
  const env = await one<EnvFacts & { id: number }>(db, `select id, min_approvals as "minApprovals" from environment where key = $1`, [envKey]);
  if (!env) throw new HttpError(404, `environment ${envKey} not found`);
  const flag = await flagRow(db, flagKey);
  if (flag.kind !== 'kill_switch') throw new HttpError(422, `${flagKey} isn’t a kill switch: an alert only turns kill switches off`);
  const cur = await currentLayer(db, env.id, flag.id, null);
  if (!cur?.enabled) return { applied: false, alreadyOff: true };
  const item: Item = { flag: flagKey, entity: null, expectedLayerVersion: cur.version, proposed: { ...stripVersion(cur), enabled: false } as LayerDoc };
  if (needsReview(env)) await checkBreakGlass(db, env, item, user);
  const name = alert?.trim().slice(0, ALERT_NAME_MAX);
  const comment = name ? `Turned off by the alert “${name}”` : 'Turned off by an alert';
  return { applied: true, bypass: true, ...(await applyItems(db, envKey, [item], { name: user.key, type: 'bypass' }, { comment })) };
}

// ---------------------------------------------------------------- summaries for the flags list
// Per flag and environment: on/off, the default, and how many entities have their own settings.
export type LayerSummary = { flag: string; env: string; enabled: boolean; entityLayers: number; defaultVariation: string; defaultValue: unknown; rules: number };

// For these flags only (one page of the list): their rules are counted per base layer, not across the whole table.
export async function summarizeLayers(q: Queryable, where: { flagIds: string[] }): Promise<LayerSummary[]> {
  return all<LayerSummary>(q, `select f.key as flag, e.key as env,
      bool_or(l.enabled) filter (where l.entity_id is null) as enabled,
      count(l.entity_id)::int as "entityLayers",
      max(vd.key) filter (where l.entity_id is null) as "defaultVariation",
      (array_agg(vd.value) filter (where l.entity_id is null))[1] as "defaultValue",
      coalesce(max(rc.n) filter (where l.entity_id is null), 0)::int as rules
    from flag_layer l join flag f on f.id = l.flag_id join environment e on e.id = l.environment_id
    left join flag_variation vd on vd.id = l.default_variation_id
    left join lateral (select count(*)::int as n from flag_rule r where r.layer_id = l.id and l.entity_id is null) rc on true
    where l.flag_id = any($1::bigint[]) group by f.key, e.key`, [where.flagIds]);
}

// ---------------------------------------------------------------- versions: restore
// Restore undoes flag settings only (docs/design/adr/0001-restore-undoes-flag-settings-only.md). Restoring version N
// puts every flag setting changed after N back to how it was at N: the "before" of its first change after N.
// Settings already back in that state, archived flags and entities, and the defaults of flags created after N
// are left alone. Changes of other kinds after N (an entity moved to another parent, delivery, variants: the
// journal's KINDS say which kinds restore undoes) stay as they are, and come back in `notRolledBack`, in words.
// The result goes live like any other change (now, or as a request where the environment needs review).
export async function restoreItems(q: Queryable, envKey: string, toRevision: number): Promise<{ items: Item[]; notRolledBack: NotRolledBack[] }> {
  const env = await one<{ id: number; revision: string }>(q, `select id, revision from environment where key = $1`, [envKey]);
  if (!env) throw new HttpError(404, 'environment not found');
  if (!Number.isInteger(toRevision) || toRevision < 0 || toRevision >= Number(env.revision)) {
    throw new HttpError(422, `version ${toRevision} isn’t an earlier version of ${envKey}`);
  }
  const firsts = await all<{ flag: string; flag_id: string; entity: string | null; before: LayerDoc | null }>(q, `
    select distinct on (h.flag, coalesce(h.entity, '')) h.flag, f.id as flag_id, h.entity, h.before
    from change_history h join flag f on f.key = h.flag and f.archived_at is null
    left join entity cu on cu.key = h.entity
    where h.environment_id = $1 and h.revision > $2 and h.change_type = any($3::text[])
      and (h.entity is null or cu.archived_at is null)
    order by h.flag, coalesce(h.entity, ''), h.id`, [env.id, toRevision, RESTORABLE]);
  const items: Item[] = [];
  for (const r of firsts) {
    if (!r.entity && !r.before) continue;                                  // the flag didn't exist at N
    const now = await currentLayer(q, env.id, r.flag_id, r.entity);
    if (canonical(stripVersion(now)) === canonical(r.before)) continue;        // already as it was
    items.push({ flag: r.flag, entity: r.entity, expectedLayerVersion: now ? now.version : null, proposed: r.before });
  }
  return { items, notRolledBack: await notRolledBack(q, env.id, toRevision) };
}
