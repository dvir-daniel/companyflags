// Builds one immutable compiled snapshot per environment revision (published from the outbox, workers.ts). The data
// plane holds it in memory; evaluation never touches Postgres, so it keeps working if the control plane is down.

import { all, one, type Db, type Queryable } from './db.ts';
import { entitiesFrom, type EntityInfo, type FlagDef, type Layer, type Rule, type Snapshot, type Split } from './evaluator.ts';
import { chainOrder } from './dimensions.ts';

type LayerRow = {
  id: string; environment_id: number; flag_key: string; entity_key: string | null; enabled: boolean | null;
  off_key: string | null; default_key: string | null; inherit: Layer['inherit']; version: string;
  updated_at: string; updated_by: string;
};
type RuleRow = {
  id: string; layer_id: string; rule_key: string; position: number; name: string | null; locked: boolean;
  disabled: boolean; conditions: Rule['conditions']; serve_key: string | null; split_by: string | null;
  split_fallback_by: string | null; split_salt: string | null; split_hash_version: number | null;
  split_outside_group: string | null;
};
type SplitRow = { rule_id: string; variation_key: string; lo: number; hi: number; group_name: string | null };

// One environment's layers (envId), or every environment's (null: then give the flags). `environmentId` says whose.
export async function loadLayers(q: Queryable, envId: number | null, flagIds?: string[]) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (envId !== null) { params.push(envId); where.push(`l.environment_id = $${params.length}`); }
  if (flagIds) { params.push(flagIds); where.push(`l.flag_id = any($${params.length}::bigint[])`); }
  const layers = await all<LayerRow>(q, `
    select l.id, l.environment_id, f.key as flag_key, c.key as entity_key, l.enabled, vo.key as off_key, vd.key as default_key,
           l.inherit, l.version, l.updated_at, l.updated_by
    from flag_layer l join flag f on f.id = l.flag_id
    left join entity c on c.id = l.entity_id
    left join flag_variation vo on vo.id = l.variation_when_off_id
    left join flag_variation vd on vd.id = l.default_variation_id
    ${where.length ? `where ${where.join(' and ')}` : ''}`, params);
  const ids = layers.map((l) => l.id);
  const rules = ids.length ? await all<RuleRow>(q, `
    select r.id, r.layer_id, r.rule_key, r.position, r.name, r.locked, r.disabled, r.conditions,
           v.key as serve_key, r.split_by, r.split_fallback_by, r.split_salt, r.split_hash_version, r.split_outside_group
    from flag_rule r left join flag_variation v on v.id = r.serve_variation_id
    where r.layer_id = any($1::bigint[]) order by r.layer_id, r.position`, [ids]) : [];
  const ruleIds = rules.map((r) => r.id);
  const splits = ruleIds.length ? await all<SplitRow>(q, `
    select s.rule_id, v.key as variation_key, lower(s.bucket) as lo, upper(s.bucket) as hi, s.group_name
    from flag_rule_split s join flag_variation v on v.id = s.variation_id
    where s.rule_id = any($1::bigint[]) order by s.rule_id, lower(s.bucket)`, [ruleIds]) : [];

  const splitsByRule = new Map<string, SplitRow[]>();
  for (const s of splits) {
    const list = splitsByRule.get(s.rule_id);
    if (list) list.push(s); else splitsByRule.set(s.rule_id, [s]);
  }
  const rulesByLayer = new Map<string, Rule[]>();
  for (const r of rules) {
    const split: Split | null = r.split_by ? {
      by: r.split_by, fallbackBy: r.split_fallback_by, salt: r.split_salt!, hashVersion: r.split_hash_version!,
      ranges: (splitsByRule.get(r.id) ?? []).map((s) => ({ variation: s.variation_key, from: s.lo, to: s.hi, ...(s.group_name ? { group: s.group_name } : {}) })),
      ...(r.split_outside_group ? { outsideGroup: r.split_outside_group } : {}),
    } : null;
    const rule: Rule = {
      ruleKey: r.rule_key, name: r.name, locked: r.locked, disabled: r.disabled,
      conditions: r.conditions, serveVariation: r.serve_key, split,
    };
    const list = rulesByLayer.get(r.layer_id);
    if (list) list.push(rule); else rulesByLayer.set(r.layer_id, [rule]);
  }
  return layers.map((l) => ({
    environmentId: Number(l.environment_id),
    flagKey: l.flag_key,
    entityKey: l.entity_key,
    layer: {
      version: Number(l.version), enabled: l.enabled, variationWhenOff: l.off_key, defaultVariation: l.default_key,
      inherit: l.inherit, rules: rulesByLayer.get(l.id) ?? [], updatedAt: l.updated_at, updatedBy: l.updated_by,
    } satisfies Layer,
  }));
}

/** The dimension keys, top to bottom. */
export async function loadDimensionKeys(q: Queryable): Promise<string[]> {
  const rows = await all<{ key: string; parent: string | null }>(q, `select d.key, p.key as parent from dimension d left join dimension p on p.id = d.parent_id`);
  return chainOrder(rows).map((d) => d.key);
}

// Every entity, with its path up the chain (itself, its parent, … the top) and its entity in each dimension, worked
// out once here so the evaluator only reads them.
export async function loadEntities(q: Queryable): Promise<Record<string, EntityInfo>> {
  const rows = await all<{ key: string; name: string; dimension: string; parent: string | null }>(q, `select c.key, c.name, d.key as dimension, p.key as parent
    from entity c join dimension d on d.id = c.dimension_id left join entity p on p.id = c.parent_id and p.archived_at is null
    where c.archived_at is null`);
  return entitiesFrom(rows);
}

// worked out in the pure evaluator module, so the console (lines.ts "Try it") builds the same paths
export { entitiesFrom } from './evaluator.ts';

// Every read sees the database at one moment (one repeatable-read, read-only transaction), so a change committed
// while the snapshot is being built can't leave it half old, half new (a rule pointing at a variant it didn't load).
// The reads are issued together; both drivers run them one after another on the transaction's one connection.
export async function buildSnapshot(db: Db, envKey: string): Promise<Snapshot> {
  return db.transaction(async (q) => {
    await q.query(`set transaction isolation level repeatable read, read only`);
    return buildFrom(q, envKey);
  });
}

async function buildFrom(q: Queryable, envKey: string): Promise<Snapshot> {
  const env = await one<{ id: number; revision: string }>(q, `select id, revision from environment where key = $1`, [envKey]);
  if (!env) throw new Error(`unknown environment ${envKey}`);
  const [flags, variations, delivery, layers, fields, entities, dimensions] = await Promise.all([
    all<{ id: string; key: string; value_type: FlagDef['valueType']; kind: string }>(
      q, `select id, key, value_type, kind from flag where archived_at is null`),
    all<{ flag_key: string; key: string; value: unknown }>(q, `
      select f.key as flag_key, v.key, v.value from flag_variation v join flag f on f.id = v.flag_id where f.archived_at is null`),
    all<{ flag_key: string; project: string }>(q, `
      select f.key as flag_key, p.key as project from flag_delivery d
      join flag f on f.id = d.flag_id join project p on p.id = d.project_id where d.environment_id = $1`, [env.id]),
    loadLayers(q, env.id),
    all<{ name: string; value_type: string; comes_from: string }>(q, `select * from condition_field`),
    loadEntities(q),
    loadDimensionKeys(q),
  ]);

  const out: Record<string, FlagDef> = {};
  for (const f of flags) {
    out[f.key] = {
      key: f.key, valueType: f.value_type, kind: f.kind,
      variations: {}, delivery: [], base: null as unknown as Layer, entities: {},
    };
  }
  for (const v of variations) if (out[v.flag_key]) out[v.flag_key].variations[v.key] = v.value;
  for (const d of delivery) if (out[d.flag_key]) out[d.flag_key].delivery.push(d.project);
  for (const l of layers) {
    const f = out[l.flagKey];
    if (!f) continue;
    if (l.entityKey === null) f.base = l.layer;
    else f.entities[l.entityKey] = l.layer;
  }
  for (const k of Object.keys(out)) if (!out[k].base) delete out[k];

  return {
    environment: envKey,
    revision: Number(env.revision),
    builtAt: new Date().toISOString(),
    flags: out,
    entities,
    dimensions,
    fields: Object.fromEntries(fields.map((f) => [f.name, { valueType: f.value_type, comesFrom: f.comes_from }])),
  };
}

// The data plane: one in-memory snapshot per environment.
export class DataPlane {
  snapshots = new Map<string, Snapshot>();
  get(env: string): Snapshot {
    const s = this.snapshots.get(env);
    if (!s) throw new Error(`no snapshot for ${env}`);
    return s;
  }
  async refresh(db: Db, env: string) {
    const s = await buildSnapshot(db, env);
    const cur = this.snapshots.get(env);
    if (!cur || s.revision >= cur.revision) this.snapshots.set(env, s);
    return this.snapshots.get(env)!;
  }
}
