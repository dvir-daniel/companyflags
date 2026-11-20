// Control-plane operations other than layer saves. Every one is recorded through the change journal (journal.ts):
// those that change what's served are a new version and a publish (entities, delivery and variations change the
// answers too), the rest are history only.

import { randomBytes } from 'node:crypto';
import { all, HttpError, one, type Db, type Tx } from './db.ts';
import { KEY_SCOPES, newApiKey, type KeyScope } from './auth.ts';
import { canonical, createChangeSet, deliveredTo, flagSetupProblems, normalizeLayer, projectIds, writeLayer, type Actor, type LayerDoc } from './layers.ts';
import { audit, change, changeEverywhere, type Env } from './journal.ts';
import { CODE_DEFAULT, HIDDEN_PREFIX, hiddenKey } from './evaluator.ts';
import { needsRemoveBy, cleanTags, flagNameProblem, isVersionFlag, reservedKeyProblem } from './checks.ts';
import { newVersionProblem, releaseVersionProblem } from './semver.ts';
import { mayMoveEntities, needsReview, type EnvFacts } from './policy.ts';
import { capital, chainOrder, checkDimensions, cleanDimension, count, type Dimension } from './dimensions.ts';
import { firstMismatch, schemaProblem, type JsonSchema } from './jsonSchema.ts';

type EnvRow = { id: number; key: string };
const envs = (q: Db | Tx) => all<EnvRow>(q, `select id, key from environment order by id`);
const envFacts = (q: Db | Tx) => all<EnvRow & EnvFacts>(q, `select id, key, min_approvals as "minApprovals" from environment order by id`);
// A protected environment (policy.ts needsReview): changes that alter what it serves go through a reviewed request there.
const protectedEnvs = async (q: Db | Tx) => (await envFacts(q)).filter(needsReview);
const projects = (q: Db | Tx) => all<{ id: number; key: string; kind: string }>(q, `select id, key, kind from project order by id`);

// ---------------------------------------------------------------- a JSON flag's JSON Schema (jsonSchema.ts)

/** A value as a 422 names it: a variant by its key, a typed (free) value by the value itself. */
const valueName = (v: { key: string; value: unknown }) => {
  if (!v.key.startsWith(HIDDEN_PREFIX)) return v.key;
  const text = JSON.stringify(v.value);
  return `the value ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
};
/** The schema as given (undefined: not given, null: none), checked: only JSON flags have one, and it must be valid. */
function cleanSchema(schema: unknown, valueType: string): JsonSchema | null | undefined {
  if (schema === undefined) return undefined;
  if (schema === null) return null;
  if (valueType !== 'json') throw new HttpError(422, 'Only JSON flags have a JSON Schema');
  const problem = schemaProblem(schema);
  if (problem) throw new HttpError(422, `JSON Schema: ${problem}`);
  return schema as JsonSchema;
}
/** Refuses (422) the first value that doesn't match the schema: "fast: model is required". */
function mustMatch(schema: JsonSchema | null | undefined, values: readonly { key: string; value: unknown }[]) {
  if (!schema) return;
  const problem = firstMismatch(schema, values, valueName);
  if (problem) throw new HttpError(422, problem, { schema: true });
}
/** A flag's values that can be served: its named variants, and the typed values a default or rule uses anywhere. */
const servableValues = (q: Tx, flagId: string) => all<{ key: string; value: unknown }>(q, `select v.key, v.value from flag_variation v
  where v.flag_id = $1 and not v.is_code_default and (v.key not like '${HIDDEN_PREFIX}%'
    or exists (select 1 from flag_layer l where l.flag_id = v.flag_id and (l.default_variation_id = v.id or l.variation_when_off_id = v.id))
    or exists (select 1 from flag_rule r where r.flag_id = v.flag_id and r.serve_variation_id = v.id)
    or exists (select 1 from flag_rule_split s where s.flag_id = v.flag_id and s.variation_id = v.id))
  order by v.id`, [flagId]);

export type NewFlag = {
  key: string;
  name?: string | null;
  tags?: string[];
  valueType: 'bool' | 'string' | 'number' | 'json';
  kind: string;
  description?: string;
  owner?: string;
  removeBy?: string | null;
  variations: { key: string; value: unknown }[];
  /** free values: any value typed into the rules and the default, each a hidden variant (evaluator.ts hiddenKey), and
   *  no named variants. Not for on/off flags; always for a version release. */
  freeValues?: boolean;
  /** a JSON flag's JSON Schema (jsonSchema.ts): every value it serves must match it. null or missing: none. */
  jsonSchema?: JsonSchema | null;
  delivery: Record<string, string[]>;               // env -> project keys
  base: Record<string, LayerDoc> | LayerDoc;        // per env, or one doc for all envs
};

// In a protected environment, a new flag starts switched off whatever the request says: turning it on there is a
// reviewed change like any other.
export async function createFlag(db: Db, f: NewFlag, actor: Actor) {
  const name = f.name?.trim() || null;
  const tags = cleanTags(f.tags);
  if (name && flagNameProblem(name)) throw new HttpError(422, flagNameProblem(name)!);
  if (tags.problem) throw new HttpError(422, tags.problem);
  const facts = { valueType: f.valueType, variants: f.variations ?? [] };
  if (needsRemoveBy(f.kind, facts) && !f.removeBy) throw new HttpError(422, 'Release and experiment flags need a remove-by date');
  // a version release takes free values: each version is the value it is, with no variant list to grow
  const free = !!f.freeValues || (f.kind === 'release' && isVersionFlag(facts));
  if (free) {
    if (f.valueType === 'bool') throw new HttpError(422, 'An on/off flag has two values, true and false: it always uses variants');
    const named = (f.variations ?? []).find((v) => !v.key.startsWith(HIDDEN_PREFIX));
    if (named) throw new HttpError(422, `${named.key}: a flag with free values has no named variants (its values are typed in)`);
  }
  const schema = cleanSchema(f.jsonSchema, f.valueType) ?? null;
  mustMatch(schema, f.variations ?? []);
  return db.transaction(async (tx) => {
    if (!(await envs(tx)).length) throw new HttpError(422, 'add an environment in Settings before creating flags');
    const reviewed = new Set((await protectedEnvs(tx)).map((e) => e.id));
    const row = await one<{ id: string }>(tx, `insert into flag (key, name, tags, value_type, kind, description, owner, remove_by, free_values, json_schema)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [f.key, name, tags.tags, f.valueType, f.kind, f.description ?? null, f.owner ?? null, f.removeBy ?? null, free, schema === null ? null : JSON.stringify(schema)]);
    const flagId = row!.id;
    if (f.variations.length < 1) throw new HttpError(422, free ? 'a flag needs at least one value' : 'a flag needs at least one variant');
    for (const v of f.variations) {
      await tx.query(`insert into flag_variation (flag_id, key, value) values ($1,$2,$3)`, [flagId, v.key, JSON.stringify(v.value)]);
    }
    await tx.query(`insert into flag_variation (flag_id, key, value, is_code_default) values ($1, $2, null, true)`, [flagId, CODE_DEFAULT]);
    const flag = { id: flagId, key: f.key, kind: f.kind, value_type: f.valueType, archived_at: null };
    const projs = await projects(tx);
    for (const env of await envs(tx)) {
      const doc = (f.base as Record<string, LayerDoc>)[env.key] ?? (('rules' in f.base || 'enabled' in f.base) ? f.base as LayerDoc : null);
      if (!doc) throw new HttpError(422, `missing defaults for ${env.key}`);
      const layer = await normalizeLayer(tx, flag, true, reviewed.has(env.id) ? { ...doc, enabled: false } : doc, null);
      await writeLayer(tx, env.id, flag, null, layer, undefined, actor);
      const delivered = f.delivery[env.key] ?? [];
      for (const pk of delivered) {
        const p = projs.find((x) => x.key === pk);
        if (!p) throw new HttpError(422, `unknown service ${pk}`);
        await tx.query(`insert into flag_delivery (flag_id, project_id, environment_id) values ($1,$2,$3)`, [flagId, p.id, env.id]);
      }
      await change(tx, env, actor, { kind: 'flag.create', flag: f.key, after: { ...f, freeValues: free, jsonSchema: schema, base: undefined, layer } });
    }
    return { key: f.key };
  });
}

// Which apps a flag is sent to in an environment. In a protected environment (policy.ts needsReview) this is a
// request (kind 'delivery', layers.ts: applied through applyItems once approved) and nothing changes yet; elsewhere it
// applies now. `before`: the apps the console saw; if they changed in the meantime the change is refused (409)
// instead of undoing someone else's.
export type DeliveryChange = { before?: string[]; reason?: string | null };
export async function setDelivery(db: Db, flagKey: string, envKey: string, projectKeys: string[], actor: Actor, opts: DeliveryChange = {}):
  Promise<{ applied: true; revision: number } | { applied: false; changeSetId: number }> {
  const env = await one<EnvRow & EnvFacts>(db, `select id, key, min_approvals as "minApprovals" from environment where key = $1`, [envKey]);
  const flag = await one<{ id: string }>(db, `select id from flag where key = $1`, [flagKey]);
  if (!flag || !env) throw new HttpError(404, 'flag or environment not found');
  const changed = (now: string[]) => {
    if (opts.before && canonical([...opts.before].sort()) !== canonical(now)) {
      throw new HttpError(409, `the services ${flagKey} is in, in ${envKey}, were changed by someone else — reload to see them`, { delivery: now }, 'conflict');
    }
  };
  if (needsReview(env)) {
    const now = await deliveredTo(db, flag.id, env.id);
    changed(now);
    const projects = (await projectIds(db, projectKeys)).map((p) => p.key);
    if (canonical(projects) === canonical(now)) throw new HttpError(422, `${flagKey} is already in exactly these services in ${envKey}`);
    const sets = (l: string[]) => (l.length ? `services ${l.join(', ')}` : 'no service');
    const reason = opts.reason?.trim() || `Put ${flagKey} in ${sets(projects)} (now: ${sets(now)})`;
    const cs = await createChangeSet(db, envKey, [{ kind: 'delivery', flag: flagKey, entity: null, expectedLayerVersion: null, proposed: null,
      delivery: { before: now, projects } }], actor, reason);
    return { applied: false, changeSetId: cs.id };
  }
  return db.transaction(async (tx) => {
    await tx.query(`select 1 from environment where id = $1 for update`, [env.id]);
    const before = await deliveredTo(tx, flag.id, env.id);
    changed(before);
    const projects = await projectIds(tx, projectKeys);
    await tx.query(`delete from flag_delivery where flag_id = $1 and environment_id = $2`, [flag.id, env.id]);
    for (const p of projects) {
      await tx.query(`insert into flag_delivery (flag_id, project_id, environment_id) values ($1,$2,$3)`, [flag.id, p.id, env.id]);
    }
    const revision = await change(tx, env, actor, { kind: 'delivery.update', flag: flagKey, before, after: projects.map((p) => p.key) });
    return { applied: true, revision };
  });
}

// Adds variants, or changes the value of existing ones. A value served in a protected environment (as a default, by a
// rule or by a % of devices) can't be changed here, since that would change what the environment serves without a
// review: add a new value and point the rules at it (that change is reviewed). A flag with free values only takes typed
// values (hidden variants). A new typed value changes nothing anyone gets until a rule serves it, so it makes no new
// version and no history entry: the save that serves it does (each publish builds its snapshot from the database).
export async function upsertVariations(db: Db, flagKey: string, variations: { key: string; value: unknown }[], actor: Actor) {
  if (!Array.isArray(variations)) throw new HttpError(422, 'variations: a list of { key, value }');
  return db.transaction(async (tx) => {
    const f = await one<{ id: string; kind: string; value_type: string; free_values: boolean; json_schema: JsonSchema | null }>(tx,
      `select id, kind, value_type, free_values, json_schema from flag where key = $1`, [flagKey]);
    if (!f) throw new HttpError(404, 'flag not found');
    mustMatch(f.json_schema, variations);
    const before = await all<{ key: string; value: unknown }>(tx, `select key, value from flag_variation where flag_id = $1 and not is_code_default order by id for update`, [f.id]);
    const was = new Map(before.map((v) => [v.key, canonical(v.value)]));
    const named = f.free_values && variations.find((v) => !v.key.startsWith(HIDDEN_PREFIX) && !was.has(v.key));
    if (named) throw new HttpError(422, `${flagKey} takes free values: type them into its rules, or turn variants on in its settings (${named.key})`);
    if (f.kind === 'release' && isVersionFlag({ valueType: f.value_type, variants: before })) versionsProblem(before, variations);
    const changing = variations.filter((v) => was.has(v.key) && was.get(v.key) !== canonical(v.value)).map((v) => v.key);
    const reviewed = (await protectedEnvs(tx)).map((e) => e.id);
    if (changing.length && reviewed.length) {
      const served = await one<{ variant: string; env: string }>(tx, `select v.key as variant, e.key as env
        from flag_variation v join environment e on e.id = any($3::int[])
        where v.flag_id = $1 and v.key = any($2::text[]) and (
          exists (select 1 from flag_layer l where l.flag_id = v.flag_id and l.environment_id = e.id and l.default_variation_id = v.id)
          or exists (select 1 from flag_rule r join flag_layer l on l.id = r.layer_id
            where r.flag_id = v.flag_id and l.environment_id = e.id and r.serve_variation_id = v.id)
          or exists (select 1 from flag_rule_split s join flag_rule r on r.id = s.rule_id join flag_layer l on l.id = r.layer_id
            where s.flag_id = v.flag_id and l.environment_id = e.id and s.variation_id = v.id))
        order by e.id, v.key limit 1`, [f.id, changing, reviewed]);
      if (served) {
        throw new HttpError(409, `${served.variant} is served in ${served.env}, which needs approval: add a new value and point the rules at it`,
          { variant: served.variant, environment: served.env });
      }
    }
    for (const v of variations) {
      await tx.query(`insert into flag_variation (flag_id, key, value) values ($1,$2,$3)
        on conflict (flag_id, key) do update set value = excluded.value`, [f.id, v.key, JSON.stringify(v.value)]);
    }
    if (variations.every((v) => v.key.startsWith(HIDDEN_PREFIX) && !was.has(v.key))) return;
    const after = await all(tx, `select key, value from flag_variation where flag_id = $1 and not is_code_default order by id`, [f.id]);
    await changeEverywhere(tx, actor, { kind: 'variations.update', flag: flagKey, before, after });
  });
}

// A version release's values are its versions (docs/design/release-versions.md), typed in like any free value: each is a
// release version (semver.ts) and never changes. The next version, added with + New version, is also higher than every
// one before it (addVersion); a version typed into a rule (an entity kept on 0.9.0) needn't be.
function versionsProblem(before: { key: string; value: unknown }[], variations: { key: string; value: unknown }[]) {
  const had = new Map(before.map((v) => [v.key, v.value]));
  for (const v of variations) {
    if (had.has(v.key)) {
      if (had.get(v.key) !== v.value) throw new HttpError(422, `${had.get(v.key)} is a version: it can’t change (add a new one)`);
      continue;
    }
    const problem = releaseVersionProblem(v.value);
    if (problem) throw new HttpError(422, `${String(v.value)}: ${problem}`, { version: v.value });
  }
}

/** A version release's next version: added in every environment, and nobody gets it until a step serves it (that
 *  save is reviewed where the environment needs it). Adding it isn't: it changes nothing anyone gets. */
export async function addVersion(db: Db, flagKey: string, version: unknown, actor: Actor) {
  const f = await one<{ id: string; kind: string; value_type: string; archived_at: string | null }>(db,
    `select id, kind, value_type, archived_at from flag where key = $1`, [flagKey]);
  if (!f || f.archived_at) throw new HttpError(404, 'flag not found');
  const variants = await all<{ key: string; value: unknown }>(db, `select key, value from flag_variation where flag_id = $1 and not is_code_default order by id`, [f.id]);
  if (f.kind !== 'release' || !isVersionFlag({ valueType: f.value_type, variants })) throw new HttpError(422, `${flagKey} isn’t a version release: only those have versions`);
  const problem = newVersionProblem(version, variants.map((v) => String(v.value)));
  if (problem) throw new HttpError(422, problem, { version });
  await upsertVariations(db, flagKey, [{ key: hiddenKey(version), value: version }], actor);
  return { version: version as string, key: hiddenKey(version) };
}

// Archiving takes a flag out of every environment at once, so in a protected environment the flag must already be
// off and sent to no app there (both reviewed changes).
export async function archiveFlag(db: Db, flagKey: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const f = await one<{ id: string }>(tx, `update flag set archived_at = now() where key = $1 and archived_at is null returning id`, [flagKey]);
    if (!f) throw new HttpError(404, 'flag not found or already archived');
    const reviewed = (await protectedEnvs(tx)).map((e) => e.id);
    const live = reviewed.length ? await one<{ env: string; enabled: boolean }>(tx, `select e.key as env, coalesce(l.enabled, false) as enabled
      from environment e left join flag_layer l on l.flag_id = $1 and l.environment_id = e.id and l.entity_id is null
      where e.id = any($2::int[]) and (coalesce(l.enabled, false) or exists (select 1 from flag_delivery d where d.flag_id = $1 and d.environment_id = e.id))
      order by e.id limit 1`, [f.id, reviewed]) : undefined;
    if (live?.enabled) throw new HttpError(409, `turn ${flagKey} off in ${live.env} first (that change is reviewed)`, { environment: live.env });
    if (live) throw new HttpError(409, `take ${flagKey} out of its services in ${live.env} first (that change is reviewed)`, { environment: live.env });
    await changeEverywhere(tx, actor, { kind: 'flag.archive', flag: flagKey });
  });
}

export type FlagMeta = {
  name?: string | null; tags?: string[]; description?: string | null; owner?: string | null; kind?: string; removeBy?: string | null; freeValues?: boolean;
  /** a JSON flag's JSON Schema; null removes it. Every value it can serve is checked against a new one. */
  jsonSchema?: JsonSchema | null;
};

// Edit a flag's details. Audited.
export async function updateFlagMeta(db: Db, flagKey: string, m: FlagMeta, actor: Actor) {
  return db.transaction(async (tx) => {
    const before = await one<{ id: string; name: string | null; tags: string[]; description: string | null; owner: string | null; kind: string; remove_by: string | null;
      free_values: boolean; json_schema: JsonSchema | null }>(tx,
      `select id, name, tags, description, owner, kind, remove_by::text as remove_by, free_values, json_schema from flag where key = $1 and archived_at is null for update`, [flagKey]);
    if (!before) throw new HttpError(404, 'flag not found');
    const tags = m.tags !== undefined ? cleanTags(m.tags) : { tags: before.tags, problem: null };
    if (tags.problem) throw new HttpError(422, tags.problem);
    const name = m.name !== undefined ? (m.name?.trim() || null) : before.name;
    if (name && flagNameProblem(name)) throw new HttpError(422, flagNameProblem(name)!);
    const next = {
      name,
      tags: tags.tags,
      description: m.description !== undefined ? (m.description?.trim() || null) : before.description,
      owner: m.owner !== undefined ? (m.owner?.trim() || null) : before.owner,
      kind: m.kind ?? before.kind,
      remove_by: m.removeBy !== undefined ? (m.removeBy || null) : before.remove_by,
      free_values: m.freeValues !== undefined ? !!m.freeValues : before.free_values,
      json_schema: before.json_schema,
    };
    const facts = await one<{ value_type: string }>(tx, `select value_type from flag where id = $1`, [before.id]);
    const schema = cleanSchema(m.jsonSchema, facts!.value_type);
    if (schema !== undefined && canonical(schema) !== canonical(before.json_schema)) {
      mustMatch(schema, await servableValues(tx, before.id));
      next.json_schema = schema;
    }
    const variants = await all<{ key: string; value: unknown }>(tx, `select key, value from flag_variation where flag_id = $1 and not is_code_default`, [before.id]);
    if (needsRemoveBy(next.kind, { valueType: facts!.value_type, variants }) && !next.remove_by) throw new HttpError(422, 'Release and experiment flags need a remove-by date');
    // free values: any value typed into the rules (its named variants, if it has some, still work)
    if (next.free_values && facts!.value_type === 'bool') throw new HttpError(422, 'An on/off flag has two values, true and false: it always uses variants');
    if (!next.free_values && next.kind === 'release' && isVersionFlag({ valueType: facts!.value_type, variants })) {
      throw new HttpError(422, 'A version release’s values are its versions: it always takes free values');
    }
    if (next.kind !== before.kind) {
      const errors = await flagSetupProblems(tx, { id: before.id, key: flagKey }, next.kind);
      if (errors.length) throw new HttpError(422, `These rules don’t fit a ${next.kind.replace('_', ' ')} flag — change them first`, { errors });
    }
    await tx.query(`update flag set name = $2, tags = $3, description = $4, owner = $5, kind = $6, remove_by = $7, free_values = $8, json_schema = $9 where id = $1`,
      [before.id, next.name, next.tags, next.description, next.owner, next.kind, next.remove_by, next.free_values,
        next.json_schema === null ? null : JSON.stringify(next.json_schema)]);
    await changeEverywhere(tx, actor, { kind: 'flag.update', flag: flagKey, before: { ...before, id: undefined }, after: next });
    return next;
  });
}

// ---------------------------------------------------------------- dimensions and entities
// The installation's dimensions (dimensions.ts), top to bottom. Saved as a whole: words change any time; a dimension is
// added at the top or the bottom (in between only while the one below has no entity with a parent: each would need a
// new one), and removed only while it has no entities and no rule checks it. Its key is a rule attribute, so it's
// fixed: changing one is removing it and adding another. Nothing served changes (journal.ts dimensions.update).

type DimensionRow = Dimension & { id: number; parent: string | null; entities: number; withParent: number };
export async function dimensionRows(q: Db | Tx): Promise<DimensionRow[]> {
  return chainOrder(await all<DimensionRow>(q, `select d.id, d.key, d.singular, d.plural, p.key as parent,
      (select count(*)::int from entity e where e.dimension_id = d.id and e.archived_at is null) as entities,
      (select count(*)::int from entity e where e.dimension_id = d.id and e.archived_at is null and e.parent_id is not null) as "withParent"
    from dimension d left join dimension p on p.id = d.parent_id`));
}

/** Whether a rule (any layer, any environment) checks this attribute or splits by it. */
const ruleUses = async (q: Tx, field: string) => !!(await one(q, `select 1 from flag_rule where split_by = $1 or split_fallback_by = $1
  or conditions @> jsonb_build_array(jsonb_build_object('field', $1::text)) limit 1`, [field]));

export async function saveDimensions(db: Db, input: unknown, actor: Actor): Promise<Dimension[]> {
  if (!Array.isArray(input)) throw new HttpError(422, 'dimensions: a list, top to bottom');
  const next = input.map((d) => cleanDimension({ key: String(d?.key ?? ''), singular: String(d?.singular ?? ''), plural: String(d?.plural ?? '') }));
  const errors = checkDimensions(next);
  if (errors.length) throw new HttpError(422, errors[0], { errors });
  return db.transaction(async (tx) => {
    await tx.query(`lock table dimension in exclusive mode`);
    const now = await dimensionRows(tx);
    const nowKeys = now.map((d) => d.key);
    const nextKeys = next.map((d) => d.key);
    const kept = nextKeys.filter((k) => nowKeys.includes(k));
    if (kept.join() !== nowKeys.filter((k) => nextKeys.includes(k)).join()) {
      throw new HttpError(422, 'The dimensions keep their order: add one at the top or the bottom');
    }
    for (const d of now.filter((x) => !nextKeys.includes(x.key))) {
      if (d.entities > 0) throw new HttpError(422, `${capital(d.plural)} can’t go while it has entries (${count(d, d.entities)}): move or remove them first`);
      // archived entities stay in it too (their settings, keys and History point at them)
      if (await one(tx, `select 1 from entity where dimension_id = $1 limit 1`, [d.id])) {
        throw new HttpError(422, `${capital(d.plural)} can’t go: it has archived entries, which stay in it`);
      }
      if (await ruleUses(tx, d.key)) throw new HttpError(422, `${capital(d.plural)} can’t go while rules check “${capital(d.singular)}”: change them first`);
    }
    for (const [i, d] of next.entries()) {
      if (nowKeys.includes(d.key)) continue;
      const above = nextKeys.slice(0, i).reverse().find((k) => nowKeys.includes(k));
      const below = now.find((x) => x.key === nextKeys.slice(i + 1).find((k) => nowKeys.includes(k)));
      if (above && below && below.withParent > 0) {
        throw new HttpError(422, `${capital(d.plural)} can only go between ${above} and ${below.key} while no ${below.plural} have a parent: add it at the top or the bottom, or move them first`);
      }
      if (await one(tx, `select 1 from condition_field where name = $1`, [d.key])) throw new HttpError(422, `An attribute is called “${d.key}” already: pick another key`);
    }
    // one chain again, top to bottom; the checks at commit (0013) see only the result
    await tx.query(`update dimension set parent_id = null`);
    for (const d of now.filter((x) => !nextKeys.includes(x.key))) {
      await tx.query(`delete from dimension where id = $1`, [d.id]);
      await tx.query(`delete from condition_field where name = $1 and comes_from = 'token'`, [d.key]);
    }
    let parent: number | null = null;
    for (const d of next) {
      const had = now.find((x) => x.key === d.key);
      let id: number;
      if (had) {
        await tx.query(`update dimension set singular = $2, plural = $3, parent_id = $4 where id = $1`, [had.id, d.singular, d.plural, parent]);
        id = had.id;
      } else {
        id = Number((await one<{ id: number }>(tx, `insert into dimension (key, singular, plural, parent_id) values ($1,$2,$3,$4) returning id`,
          [d.key, d.singular, d.plural, parent]))!.id);
        await tx.query(`insert into condition_field (name, value_type, comes_from, can_split_by, description) values ($1, 'string', 'token', true, $2)`,
          [d.key, `The asker’s ${d.singular}: from its app link, or named by a backend within its key’s scope`]);
      }
      parent = id;
    }
    const words = (ds: readonly Dimension[]) => ds.map(({ key, singular, plural }) => ({ key, singular, plural }));
    await audit(tx, actor, { kind: 'dimensions.update', before: words(now), after: words(next) });
    return next;
  });
}

// `parent`: the key of the entity above it, in the dimension right above (null or missing: none).
export type EntityDoc = { key?: string; name: string; parent?: string | null };

async function entityState(tx: Tx, id: string) {
  return one(tx, `select c.key, c.name, d.key as dimension, p.key as parent from entity c join dimension d on d.id = c.dimension_id
    left join entity p on p.id = c.parent_id where c.id = $1`, [id]);
}

async function parentId(tx: Tx, key: string, dim: { parent_id: number | null }, parent: string | null | undefined): Promise<string | null | undefined> {
  if (parent === undefined) return undefined;                        // not given: unchanged
  if (parent === null || parent === '') return null;
  if (parent === key) throw new HttpError(422, 'an entity can’t be its own parent');
  const above = dim.parent_id === null ? null : await one<{ plural: string }>(tx, `select plural from dimension where id = $1`, [dim.parent_id]);
  if (!above) throw new HttpError(422, 'the top dimension has nothing above it: no parent');
  const row = await one<{ id: string; dimension_id: number }>(tx, `select id, dimension_id from entity where key = $1 and archived_at is null`, [parent]);
  if (!row || Number(row.dimension_id) !== Number(dim.parent_id)) throw new HttpError(422, `the parent must be one of the ${above.plural}: “${parent}” isn’t`);
  return row.id;
}

// Moving an entity under another parent (or out from under one) changes what it, and every entity under it, gets
// everywhere at once; where an environment is protected, only an admin may do that (policy.ts mayMoveEntities).
export async function upsertEntity(db: Db, dimension: string, key: string, doc: EntityDoc, actor: Actor, create: boolean, who: { role?: string } = {}) {
  return db.transaction(async (tx) => {
    const dim = await one<{ id: number; parent_id: number | null }>(tx, `select id, parent_id from dimension where key = $1`, [dimension]);
    if (!dim) throw new HttpError(404, `no dimension “${dimension}”`);
    if (typeof doc.name !== 'string' || !doc.name.trim()) throw new HttpError(422, 'Add a name');
    const existing = await one<{ id: string; parent_id: string | null; dimension_id: number }>(tx, `select id, parent_id, dimension_id from entity where key = $1`, [key]);
    if (create && existing) throw new HttpError(409, `“${key}” is taken already (keys are unique across every dimension)`);
    if (!create && (!existing || Number(existing.dimension_id) !== Number(dim.id))) throw new HttpError(404, `no ${dimension} “${key}”`);
    const before = existing ? await entityState(tx, existing.id) : null;
    const parent = await parentId(tx, key, dim, doc.parent);
    if (existing && parent !== undefined && String(parent ?? '') !== String(existing.parent_id ?? '')) {
      const envs = await envFacts(tx);
      if (!mayMoveEntities({ role: who.role ?? '' }, envs)) {
        throw new HttpError(403, `only admins can move ${key} under another parent: it changes what it gets in ${envs.find(needsReview)!.key}, which needs approval`);
      }
    }
    let id: string;
    if (existing) {
      await tx.query(`update entity set name = $2 where id = $1`, [existing.id, doc.name.trim()]);
      if (parent !== undefined) await tx.query(`update entity set parent_id = $2 where id = $1`, [existing.id, parent]);
      id = existing.id;
    } else {
      id = (await one<{ id: string }>(tx, `insert into entity (key, name, parent_id, dimension_id) values ($1,$2,$3,$4) returning id`,
        [key, doc.name.trim(), parent ?? null, dim.id]))!.id;
    }
    const after = await entityState(tx, id);
    await changeEverywhere(tx, actor, { kind: create ? 'entity.create' : 'entity.update', entity: key, before, after });
    return after;
  });
}

// A service's key in one environment: an app's is public, a backend's secret (auth.ts). Which entities it may ask about
// is its scope (auth.ts mayAsk); `entity` and `below` keys name their entity.
export async function createApiKey(db: Db, p: { environment: string; project: string; scope: string; entity?: string | null; label?: string }, actor: Actor) {
  return db.transaction(async (tx) => {
    const env = await one<EnvRow>(tx, `select id, key from environment where key = $1`, [p.environment]);
    // shared: the service can't change kind or be deleted until this key is made (updateProject, deleteProject)
    const proj = await one<{ id: number; kind: string }>(tx, `select id, kind from project where key = $1 for share`, [p.project]);
    if (!env || !proj) throw new HttpError(404, 'environment or service not found');
    // an app service's key is public (values only, auth.ts); a backend service's is secret
    if (!KEY_SCOPES.includes(p.scope as KeyScope)) throw new HttpError(422, `scope must be ${KEY_SCOPES.join(', ')}`);
    const ent = p.entity ? await one<{ id: string }>(tx, `select id from entity where key = $1 and archived_at is null`, [p.entity]) : null;
    if (p.scope !== 'all' && !ent) throw new HttpError(422, p.entity ? `“${p.entity}” not found` : 'say whose key it is: the entity it’s for');
    const k = newApiKey(env.key, p.project);
    const row = await one<{ id: string }>(tx, `insert into api_key (key_hash, key_prefix, label, environment_id, project_id, scope, entity_id)
      values ($1,$2,$3,$4,$5,$6,$7) returning id`, [k.hash, k.prefix, p.label ?? null, env.id, proj.id, p.scope, p.scope === 'all' ? null : ent!.id]);
    await audit(tx, actor, { kind: 'api_key.create', environment: env.id, after: { id: row!.id, prefix: k.prefix, project: p.project, scope: p.scope, entity: p.scope === 'all' ? null : p.entity } });
    return { id: Number(row!.id), key: k.raw, prefix: k.prefix };
  });
}

export async function revokeApiKey(db: Db, id: number, actor: Actor) {
  return db.transaction(async (tx) => {
    const r = await one<{ environment_id: number; key_prefix: string }>(tx, `update api_key set revoked_at = now() where id = $1 and revoked_at is null returning environment_id, key_prefix`, [id]);
    if (!r) throw new HttpError(404, 'key not found or already revoked');
    await audit(tx, actor, { kind: 'api_key.revoke', environment: r.environment_id, before: { id, prefix: r.key_prefix } });   // this app stops accepting it at once
  });
}

// An entity's app link (delivery.ts cdnFilePath) is the address of its file: the console shows it, the entity's
// backend gives it to its apps at login, and the apps read their file there.
// Replaces an entity's app links in every environment: each environment gets a new version and a publish
// (journal.ts changeEverywhere), which purges the CDN, so the old link stops being served at once; the entity's
// backend hands its apps the new one at the next login. The links of entities under it stay as they are.
export async function rotateAppLink(db: Db, entityKey: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const c = await one<{ id: string; v: number }>(tx, `update entity set client_link_version = client_link_version + 1
      where key = $1 and archived_at is null returning id, client_link_version as v`, [entityKey]);
    if (!c) throw new HttpError(404, `“${entityKey}” not found`);
    await changeEverywhere(tx, actor, { kind: 'entity.link_replaced', entity: entityKey, after: { linkVersion: c.v } });
  });
}

// Replaces every app link and app token in one environment at once: the environment gets a new secret (each link's
// and token's secret is made from it, auth.ts), and a new version and a publish, which purges the CDN. For when the
// environment's secret may have leaked (a database backup, a copy of the data): every old link and token stops
// working, and each entity's backend hands its apps the new ones at their next sign-in.
export async function rotateEnvironmentLinks(db: Db, envKey: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const env = await one<Env>(tx, `update environment set link_secret = $2 where key = $1 returning id, key`, [envKey, randomSecret()]);
    if (!env) throw new HttpError(404, `environment "${envKey}" not found`);
    await change(tx, env, actor, { kind: 'environment.links_replaced' });
    return { environment: env.key, replaced: true };
  });
}

export const randomSecret = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------- settings (admins)

const KEY = /^[a-z][a-z0-9-]{0,39}$/;
const keyProblem = (what: string, key: string) =>
  KEY.test(key) ? null : `${what} key "${key}": use lowercase letters, digits and dashes, starting with a letter (up to 40)`;
const approvals = (v: unknown) => {
  const n = Number(v ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new HttpError(422, 'approvals needed: a whole number from 0 to 5');
  return n;
};

export type EnvironmentInput = { key?: string; name?: string; minApprovals?: number };

/** A new environment. Every existing flag gets its defaults there, switched off, ready to set up. */
export async function createEnvironment(db: Db, input: EnvironmentInput, actor: Actor) {
  const key = String(input.key ?? '').trim();
  const problem = keyProblem('environment', key) ?? reservedKeyProblem('environment', key);
  if (problem) throw new HttpError(422, problem);
  const name = String(input.name ?? '').trim() || key;
  const minApprovals = approvals(input.minApprovals);
  return db.transaction(async (tx) => {
    if (await one(tx, `select 1 from environment where key = $1`, [key])) throw new HttpError(409, `there is already an environment "${key}"`);
    const env = (await one<{ id: number }>(tx, `insert into environment (key, name, min_approvals, link_secret) values ($1,$2,$3,$4) returning id`,
      [key, name, minApprovals, randomSecret()]))!;
    // the flag's off and default variants, from the oldest other environment
    const flags = await all<{ id: string; key: string; kind: string; value_type: string; archived_at: string | null; off: string | null; def: string | null }>(tx,
      `select f.id, f.key, f.kind, f.value_type, f.archived_at, voff.key as off, vdef.key as def
       from flag f join flag_layer l on l.flag_id = f.id and l.entity_id is null
         and l.environment_id = (select id from environment where id <> $1 order by id limit 1)
       left join flag_variation voff on voff.id = l.variation_when_off_id
       left join flag_variation vdef on vdef.id = l.default_variation_id`, [env.id]);
    for (const f of flags) {
      const layer = await normalizeLayer(tx, f, true, { enabled: false, variationWhenOff: f.off, defaultVariation: f.def, rules: [] } as LayerDoc, null);
      await writeLayer(tx, env.id, f, null, layer, undefined, actor);
    }
    await change(tx, { id: env.id, key }, actor, { kind: 'environment.create', after: { key, name, minApprovals } });   // its CDN files are served at once
    return { key, name, minApprovals };
  });
}

export async function updateEnvironment(db: Db, key: string, input: EnvironmentInput, actor: Actor) {
  return db.transaction(async (tx) => {
    const cur = await one<{ id: number; name: string; minApprovals: number }>(tx,
      `select id, name, min_approvals as "minApprovals" from environment where key = $1 for update`, [key]);
    if (!cur) throw new HttpError(404, `no environment "${key}"`);
    const name = input.name === undefined ? cur.name : String(input.name).trim() || key;
    const minApprovals = input.minApprovals === undefined ? cur.minApprovals : approvals(input.minApprovals);
    await tx.query(`update environment set name = $2, min_approvals = $3 where id = $1`, [cur.id, name, minApprovals]);
    await audit(tx, actor, { kind: 'environment.update', environment: cur.id, before: { name: cur.name, minApprovals: cur.minApprovals }, after: { name, minApprovals } });
    return { key, name, minApprovals };
  });
}

type AppKind = 'client' | 'server';
const isAppKind = (k: unknown): k is AppKind => k === 'client' || k === 'server';
const APP_KIND = 'kind: "client" (an app: android, ios, web) or "server" (a backend)';

/** A new service (a `project` row): a 'client' app, which reads values only, or a 'server' backend, which reads the rules. */
export async function createProject(db: Db, input: { key?: string; kind?: string }, actor: Actor) {
  const key = String(input.key ?? '').trim();
  const problem = keyProblem('service', key);
  if (problem) throw new HttpError(422, problem);
  if (!isAppKind(input.kind)) throw new HttpError(422, APP_KIND);
  return db.transaction(async (tx) => {
    if (await one(tx, `select 1 from project where key = $1`, [key])) throw new HttpError(409, `there is already a service "${key}"`);
    await tx.query(`insert into project (key, kind) values ($1, $2)`, [key, input.kind]);
    await audit(tx, actor, { kind: 'app.create', after: { key, kind: input.kind } });
    return { key, kind: input.kind };
  });
}

// A service's key never changes: it is in every CDN file address (/cdn/v1/flags/<env>/<service>/…), in its API
// keys, in rules that check the service, and in the history. What an admin can change is its kind, and only while
// nothing uses it (appUse): a backend's flags in an app's file would be public, and a service made for backends stops
// being served as files. Deleting a service has the same condition. Neither changes what any environment serves, so both are history only.

/** What still uses a service: the flags in it (archived ones aren't served, so they don't count), its API keys that
 *  still work, and the requests still to go out (in review, approved or scheduled) that would put a flag in it. */
export type AppUse = { flags: { flag: string; environments: string[] }[]; apiKeys: number; requests: { id: number; environment: string }[] };

/** The service, its row locked: a flag put in it or a key made for it meanwhile waits until this transaction ends
 *  (and then fails if the service is gone), so what appUse sees stays true until the change commits. */
async function lockApp(tx: Tx, key: string) {
  const app = await one<{ id: number; key: string; kind: AppKind }>(tx, `select id, key, kind from project where key = $1 for update`, [key]);
  if (!app) throw new HttpError(404, `no service "${key}"`);
  return app;
}

async function appUse(tx: Tx, app: { id: number; key: string }): Promise<AppUse> {
  const flags = await all<{ flag: string; environments: string[] }>(tx, `select f.key as flag, array_agg(e.key order by e.id) as environments
    from flag_delivery d join flag f on f.id = d.flag_id and f.archived_at is null join environment e on e.id = d.environment_id
    where d.project_id = $1 group by f.key order by f.key`, [app.id]);
  const keys = await one<{ n: number }>(tx, `select count(*)::int as n from api_key where project_id = $1 and revoked_at is null`, [app.id]);
  const requests = await all<{ id: number; environment: string }>(tx, `select distinct cs.id::int as id, e.key as environment
    from change_set cs join change_set_item i on i.change_set_id = cs.id join environment e on e.id = cs.environment_id
    where cs.status in ('in_review', 'approved', 'scheduled') and i.kind = 'delivery'
      and i.proposed->'projects' @> jsonb_build_array($1::text) order by id`, [app.key]);
  return { flags, apiKeys: keys?.n ?? 0, requests };
}

/** Refuses (409) while anything uses the service: what does, each with what to do about it. */
function refuseInUse(appKey: string, use: AppUse, what: string) {
  const some = <T,>(list: T[], text: (x: T) => string) =>
    `${list.slice(0, 5).map(text).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}`;
  const { flags, apiKeys, requests } = use;
  const errors = [
    flags.length && `${flags.length === 1 ? 'A flag is' : `${flags.length} flags are`} still in it: ${some(flags, (f) => `${f.flag} (${f.environments.join(', ')})`)}. ` +
      `Take ${flags.length === 1 ? 'that flag' : 'each one'} out of ${appKey} first (the flag’s Settings tab).`,
    apiKeys && `${apiKeys === 1 ? 'An API key for it still works' : `${apiKeys} API keys for it still work`}: revoke ${apiKeys === 1 ? 'it' : 'them'} on the API keys page first.`,
    requests.length && `${requests.length === 1 ? 'A request' : `${requests.length} requests`} waiting to go out would put a flag in it: ` +
      `${some(requests, (r) => `#${r.id} in ${r.environment}`)}. Cancel or reject ${requests.length === 1 ? 'it' : 'them'} in Approvals first.`,
  ].filter((e): e is string => !!e);
  if (errors.length) throw new HttpError(409, `${appKey} ${what} while it’s in use`, { errors, inUse: use });
}

/** Changes a service's kind (its key can't change). Only while nothing uses it; audited. */
export async function updateProject(db: Db, key: string, input: { key?: unknown; kind?: unknown }, actor: Actor) {
  if (input.key !== undefined && input.key !== key) {
    throw new HttpError(422, `a service’s key can’t change: its CDN files and API keys use "${key}". Add a new service instead, and delete this one once nothing uses it.`);
  }
  if (!isAppKind(input.kind)) throw new HttpError(422, APP_KIND);
  const kind = input.kind;
  return db.transaction(async (tx) => {
    const app = await lockApp(tx, key);
    if (app.kind === kind) return { key, kind };
    refuseInUse(key, await appUse(tx, app), 'can’t change kind');
    await tx.query(`update project set kind = $2 where id = $1`, [app.id, kind]);
    await audit(tx, actor, { kind: 'app.update', before: { key, kind: app.kind }, after: { key, kind } });   // its file is served, or not, at once
    return { key, kind };
  });
}

/** Deletes a service nothing uses any more. Its revoked API keys and the archived flags' places in it go with it
 *  (nothing serves them); the history keeps them. Audited. */
export async function deleteProject(db: Db, key: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const app = await lockApp(tx, key);
    refuseInUse(key, await appUse(tx, app), 'can’t be deleted');
    const revokedKeys = (await all<{ prefix: string }>(tx, `delete from api_key where project_id = $1 returning key_prefix as prefix`, [app.id])).map((k) => k.prefix);
    const archivedFlags = (await all<{ flag: string }>(tx, `with gone as (delete from flag_delivery where project_id = $1 returning flag_id)
      select distinct f.key as flag from gone join flag f on f.id = gone.flag_id order by f.key`, [app.id])).map((f) => f.flag);
    await tx.query(`delete from project where id = $1`, [app.id]);
    await audit(tx, actor, { kind: 'app.delete', before: { key, kind: app.kind, revokedKeys, archivedFlags } });   // its file stops being served at once
    return { key };
  });
}
