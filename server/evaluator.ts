// Pure evaluator, the one that decides every answer. Runs only on this server: apps get answers (OFREP, ofrep.ts) or
// their entity's CDN file; backends get flagd JSON. Both files are the same flagd JSON (flagd.ts, through forEntity),
// with what the server knows already settled. The same function powers OFREP, the CDN files, flagd JSON and the
// console's trace.

import { ANY_APP, NONE, namesEntities, reportedByApp, resolverFor, type Asker } from './fields.ts';
import { bucketFor } from './hash.ts';
import { compareSemver, parseSemver } from './semver.ts';

/** A snapshot's flag keys, A to Z, sorted once per snapshot (snapshots never change once built). */
const sortedKeys = new WeakMap<Snapshot, string[]>();
export function sortedFlagKeys(snap: Snapshot): string[] {
  let keys = sortedKeys.get(snap);
  if (!keys) sortedKeys.set(snap, (keys = Object.keys(snap.flags).sort()));
  return keys;
}

// Reserved variation: send no remote value, the app uses the default in its own code (Firebase's "in-app default").
export const CODE_DEFAULT = 'code_default';
// A value typed in (for one entity, or anywhere on a flag with free values) is stored as a hidden, content-addressed
// variant: "val-<hash>". The console names it, so the same value gets the same variant (and the server, for versions).
export const HIDDEN_PREFIX = 'val-';
export function hiddenKey(value: unknown): string {
  const str = JSON.stringify(value);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return HIDDEN_PREFIX + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export type Inherit = 'base_rules_then_base_default' | 'base_rules_then_customer_default' | 'customer_only';

export type Op =
  | 'in' | 'not_in'
  | 'contains_any' | 'contains_none'
  | 'starts_with' | 'ends_with'
  | 'semver_lt' | 'semver_lte' | 'semver_gt' | 'semver_gte' | 'semver_eq'
  | 'lt' | 'lte' | 'gt' | 'gte'
  | 'exists' | 'missing';

export type Condition = { field: string; op: Op; values?: (string | number)[] };

// `group` / `outsideGroup`: names sent to the app with the value (metadata.group), so the app's own
// analytics can tell devices inside the % from devices outside it. Left out when not named.
export type SplitRange = { variation: string; from: number; to: number; group?: string };
export type Split = { by: string; fallbackBy: string | null; salt: string; hashVersion: number; ranges: SplitRange[]; outsideGroup?: string };

export type Rule = {
  ruleKey: string;
  name: string | null;
  locked: boolean;
  disabled: boolean;
  conditions: Condition[];
  serveVariation: string | null;
  split: Split | null;
};

export type Layer = {
  version: number;
  enabled: boolean | null;
  variationWhenOff: string | null;
  defaultVariation: string | null;
  inherit: Inherit | null;
  rules: Rule[];
  updatedAt?: string;
  updatedBy?: string;
};

export type FlagDef = {
  key: string;
  valueType: 'bool' | 'string' | 'number' | 'json';
  kind: string;
  variations: Record<string, unknown>;
  delivery: string[];                 // project keys that receive this flag in this environment
  base: Layer;
  entities: Record<string, Layer>;    // entity key -> its own settings on this flag
};

// An entity: one entry of a dimension (dimensions.ts), such as the store "acme-12". It follows its parent's settings
// on a flag until it has its own (entityChain), and its parent follows its own, up to the top.
//   path  itself, then each entity above it, to the top: ["acme-12", "acme", "eu"]
//   at    its entity in each dimension, its own and those above: { store: "acme-12", chain: "acme", region: "eu" }
export type EntityInfo = { key: string; name: string; dimension: string; parent?: string; path: string[]; at: Record<string, string> };

/** EntityInfo for rows that each name their parent (at most 4 levels; an unknown parent ends the path). The snapshot
 *  builds its entities with it, and so does the console's "Try it" (web/src/lines.ts). */
export function entitiesFrom(rows: readonly { key: string; name: string; dimension: string; parent?: string | null }[]): Record<string, EntityInfo> {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return Object.fromEntries(rows.map((r) => {
    const path: string[] = [];
    const at: Record<string, string> = {};
    for (let x: (typeof rows)[number] | undefined = r; x && path.length < 4 && !path.includes(x.key); x = x.parent ? byKey.get(x.parent) : undefined) {
      path.push(x.key);
      at[x.dimension] = x.key;
    }
    return [r.key, { key: r.key, name: r.name, dimension: r.dimension, ...(r.parent && byKey.has(r.parent) ? { parent: r.parent } : {}), path, at }];
  }));
}

export type Snapshot = {
  environment: string;
  revision: number;
  builtAt: string;
  flags: Record<string, FlagDef>;
  entities: Record<string, EntityInfo>;
  dimensions: string[];               // the dimension keys, top to bottom
  fields: Record<string, { valueType: string; comesFrom: string }>;   // the stored attributes (fields.ts, and any taken off it)
};

export type EvalContext = {
  environment: string;
  project: string;
  entity: EntityInfo | null;
  attrs: Record<string, unknown>;     // device.*, app.*, session.id — from the SDK
};
/** What every answer in one environment has in common: its key and the installation's dimensions. A snapshot is one. */
export type Where = { environment: string; dimensions: readonly string[] };

export type Reason = 'STATIC' | 'DEFAULT' | 'TARGETING_MATCH' | 'SPLIT' | 'DISABLED' | 'ERROR';

export type TraceStep = {
  stage: 'delivery' | 'enabled' | 'locked' | 'entity' | 'entity_default' | 'base' | 'default';
  layer: 'base' | 'entity' | null;
  owner?: string;                     // an entity's settings: whose
  ruleKey?: string;
  ruleName?: string | null;
  outcome: 'match' | 'no_match' | 'skipped' | 'disabled' | 'served' | 'not_delivered' | 'info';
  detail: string;
  // `missing`: the value wasn't sent (or couldn't be read), so the result is the rule's choice, not the request's:
  // a rule doesn't match, an override does. The console says such an answer depends on the device.
  conditions?: { field: string; op: Op; values?: unknown[]; actual: unknown; result: boolean; note?: string; missing?: true }[];
  split?: { unit: string | null; unitValue?: string; bucket?: number; range?: SplitRange | null; salt: string; hashVersion: number };
};

// Which part of the flag decided the answer. The console's words for these live in words.ts.
// entity_rule / entity_default: an entity's own settings decided: `owner`'s, the asker's or one above it.
export type Section = 'not_sent' | 'off' | 'override' | 'entity_rule' | 'entity_default' | 'everyone_rule' | 'default';
export type DecidedBy = {
  section: Section;
  owner: string | null;             // entity_rule / entity_default: whose settings (the asker, or an entity above it)
  ruleKey: string | null;
  ruleName: string | null;
  namesEntity: boolean;             // a rule for everyone that lists this entity, or one above it ("Store is …", "Region is …")
};

export type EvalResult = {
  key: string;
  value?: unknown;
  variant?: string;
  codeDefault?: boolean;            // true: no remote value — the app uses its code default
  reason: Reason;
  errorCode?: 'FLAG_NOT_FOUND' | 'TYPE_MISMATCH' | 'GENERAL';
  errorDetails?: string;
  metadata: Record<string, string | number | boolean>;
  decidedBy: DecidedBy;
  // The % group this device is in, when the group has a name: the name of its part of the % when a
  // % rule decided the answer, else the outside name of the first % rule it fell outside of.
  group?: string;
  trace: TraceStep[];
};

// The value a check reads: what the server works out from who is asking (fields.ts `resolverFor`: the app, the
// environment, the entity and those above it), else what the app reported.
type Asking = EvalContext & { dimensions: readonly string[] };
function resolveField(field: string, who: Asking): unknown {
  const resolve = resolverFor(field, who.dimensions);
  return resolve ? resolve(who) : who.attrs[field];
}

const isMissing = (v: unknown) => v === undefined || v === null || v === '';

// Long "is one of" lists (e.g. "Store is acme-1 or acme-2 or … 250 keys") become a set the first time
// they're checked, so each check is one lookup instead of a walk through the list. Kept beside the
// condition (not on it), so snapshots and published files stay plain JSON.
const LIST_SET_MIN = 8;
const listSets = new WeakMap<Condition, Set<string>>();
function inList(c: Condition, values: (string | number)[], a: string): boolean {
  if (values.length < LIST_SET_MIN) return values.some((v) => String(v) === a);
  let set = listSets.get(c);
  if (!set) listSets.set(c, (set = new Set(values.map(String))));
  return set.has(a);
}

// The versions written in rules ("App version is below 5.0.0"), parsed once instead of on every check.
const RULE_VERSIONS_MAX = 10_000;
const ruleVersions = new Map<string, ReturnType<typeof parseSemver>>();
function ruleVersion(v: unknown) {
  const s = String(v);
  if (ruleVersions.has(s)) return ruleVersions.get(s)!;
  const parsed = parseSemver(s);
  if (ruleVersions.size >= RULE_VERSIONS_MAX) ruleVersions.clear();
  ruleVersions.set(s, parsed);
  return parsed;
}

// Returns true / false, or null when the attribute is missing or unparseable.
// NONE (a dimension below the asker's own): known to be no entity, so only "is not", "isn't set" and "doesn't include" pass.
export function testCondition(c: Condition, actual: unknown): boolean | null {
  if (actual === NONE) return c.op === 'missing' || c.op === 'not_in' || c.op === 'contains_none';
  const values = c.values ?? [];
  if (c.op === 'exists') return !isMissing(actual);
  if (c.op === 'missing') return isMissing(actual);
  if (isMissing(actual)) return null;
  switch (c.op) {
    case 'in': return inList(c, values, String(actual));
    case 'not_in': return !inList(c, values, String(actual));
    case 'contains_any': return Array.isArray(actual) && values.some((v) => actual.includes(v));
    case 'contains_none': return Array.isArray(actual) && !values.some((v) => actual.includes(v));
    case 'starts_with': return values.some((v) => String(actual).startsWith(String(v)));
    case 'ends_with': return values.some((v) => String(actual).endsWith(String(v)));
    case 'semver_lt': case 'semver_lte': case 'semver_gt': case 'semver_gte': case 'semver_eq': {
      const a = parseSemver(actual);
      const b = ruleVersion(values[0]);
      if (!a || !b) return null;
      const cmp = compareSemver(a, b);
      return { semver_lt: cmp < 0, semver_lte: cmp <= 0, semver_gt: cmp > 0, semver_gte: cmp >= 0, semver_eq: cmp === 0 }[c.op];
    }
    case 'lt': case 'lte': case 'gt': case 'gte': {
      const a = Number(actual);
      const b = Number(values[0]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { lt: a < b, lte: a <= b, gt: a > b, gte: a >= b }[c.op];
    }
  }
  return false;
}

// `outside`: the device reached this % rule but is not inside the % (it carries on to the next rule).
type RuleOutcome = { matched: boolean; variation?: string; reason?: Reason; group?: string; outside?: boolean; step: TraceStep | null };

// `explain` builds the step-by-step trace (Debug tab). App requests skip it: same result, much less work.
function evalRule(rule: Rule, layer: 'base' | 'entity', stage: TraceStep['stage'], ctx: Asking, explain: boolean, owner?: string): RuleOutcome {
  const step: TraceStep | null = explain
    ? { stage, layer, ...(owner ? { owner } : {}), ruleKey: rule.ruleKey, ruleName: rule.name, outcome: 'no_match', detail: '', conditions: [] }
    : null;
  if (rule.disabled) {
    if (step) { step.outcome = 'disabled'; step.detail = 'rule is paused'; }
    return { matched: false, step };
  }
  for (const c of rule.conditions) {
    const actual = resolveField(c.field, ctx);
    const r = testCondition(c, actual);
    // M4: overrides fail closed. A missing/unparseable attribute counts as a match for them.
    const result = r === null ? rule.locked : r;
    if (step) {
      const note = actual === NONE ? 'none: the one asking is above this dimension'
        : r === null ? (rule.locked ? 'missing or unparseable → treated as match (an override fails closed)' : 'missing or unparseable → no match')
        : undefined;
      step.conditions!.push({ field: c.field, op: c.op, values: c.values, actual: actual === NONE ? null : actual ?? null, result, note, ...(r === null ? { missing: true as const } : {}) });
    }
    if (!result) {
      if (step) step.detail = 'doesn’t match';
      return { matched: false, step };
    }
  }
  if (rule.serveVariation) {
    if (step) { step.outcome = 'match'; step.detail = `matches → serves "${rule.serveVariation}"`; }
    return { matched: true, variation: rule.serveVariation, reason: 'TARGETING_MATCH', step };
  }
  const s = rule.split!;
  let unit: string | null = null;
  const unitOf = (f: string) => { const v = resolveField(f, ctx); return v === NONE ? undefined : v; };
  let unitValue = unitOf(s.by);
  if (!isMissing(unitValue)) unit = s.by;
  else if (s.fallbackBy) {
    unitValue = unitOf(s.fallbackBy);
    if (!isMissing(unitValue)) unit = s.fallbackBy;
  }
  if (step) step.split = { unit, salt: s.salt, hashVersion: s.hashVersion };
  if (!unit) {
    // M6: a missing unit is "no match, continue" — never bucket 0
    if (step) step.detail = `no ${s.by} sent, so the % of devices can’t be decided → missing → no match`;
    return { matched: false, step };
  }
  const bucket = bucketFor(s.salt, String(unitValue), s.hashVersion);
  const range = rangeAt(s.ranges, bucket);
  if (step) step.split = { ...step.split!, unitValue: String(unitValue), bucket, range };
  if (!range) {
    if (step) step.detail = `device is outside the % of devices (bucket ${bucket}) → no match, continue`;
    return { matched: false, outside: true, step };
  }
  if (step) { step.outcome = 'match'; step.detail = `device is inside the ${(range.to - range.from) / 100}% (bucket ${bucket}) → serves "${range.variation}"`; }
  return { matched: true, variation: range.variation, reason: 'SPLIT', group: range.group, step };
}

function typeMatches(valueType: FlagDef['valueType'], v: unknown) {
  if (valueType === 'bool') return typeof v === 'boolean';
  if (valueType === 'string') return typeof v === 'string';
  if (valueType === 'number') return typeof v === 'number';
  return true;
}

const NOT_SENT: DecidedBy = Object.freeze({ section: 'not_sent', owner: null, ruleKey: null, ruleName: null, namesEntity: false }) as DecidedBy;
// "is" on an attribute whose values are entity keys, listing this entity's value: "Store is acme-12", or for acme-12 "Chain is Acme"
const namesEntity = (r: Rule, who: Asker) => !!who.entity && r.conditions.some((c) => {
  if (c.op !== 'in' || !namesEntities(c.field, who.dimensions)) return false;
  const value = resolverFor(c.field, who.dimensions)?.(who);
  return typeof value === 'string' && inList(c, c.values ?? [], value);
});
const decided = (section: Section, rule: Rule | undefined, who: Asker, owner: string | null = null): DecidedBy => ({
  section, owner, ruleKey: rule?.ruleKey ?? null, ruleName: rule?.name ?? null,
  namesEntity: section === 'everyone_rule' && !!rule && namesEntity(rule, who),
});

const NO_METADATA: Record<string, string | number | boolean> = Object.freeze({}) as Record<string, string | number | boolean>;

// ---------------------------------------------------------------- the entity chain
// The order the levels decide in, for one flag and one entity (README "Evaluation order", docs/content/docs/guide/dimensions.mdx):
//
//   1. overrides for everyone (the locked rules)
//   2. the entity's own rules                 its "Own settings only" stops here, with its own default
//   3. its parent's rules, and so on up       an entity above that uses "Own settings only" stops there
//      to the top of its chain
//   4. rules for everyone
//   5. the default: the most specific one that has its own (the entity's, its parent's, …, everyone's)
//
// A level is skipped when an entity below it in the chain (nearer the asker) uses "Own settings only".
// This module is the only place that order is written. evaluate() and forEntity() walk it, checking each level's
// rules against the request (they differ only in how much of the request they know); the entity page ("why it gets
// this") and the impact warning read it as it is. Nothing here depends on the request.

/** One step of the entity chain. */
export type LevelName = 'override' | 'entity' | 'everyone';
export type ChainLevel = {
  level: LevelName;
  owner: string | null;             // whose settings: the asker's key or one above it; null for everyone's
  distance: number | null;          // 0: the asker itself, 1: its parent, …; null for override / everyone
  layer: Layer | null;              // those settings on this flag (null: none); the base layer for override / everyone
  rules: Rule[];                    // what this level tries, in order (override: the locked rules; everyone: the rest)
  section: Section;                 // what decided, when one of these rules matches
  set: boolean;                     // has settings here: overrides exist, the entity has a layer; everyone: always
  skippedBy: string | null;         // passed over: the key of the entity below that uses "Own settings only"
  stops: boolean;                   // uses "Own settings only": when its rules don't match, the default decides
};
/** The default the chain ends in, when no rule decides: the most specific level (not skipped) with a default of its own. */
export type ChainDefault = { level: 'entity' | 'everyone'; owner: string | null; distance: number | null; variant: string | null; section: 'entity_default' | 'default' };
export type EntityChain = { levels: ChainLevel[]; default: ChainDefault };

// "Rules + own default" and "Own settings only" bring a default of their own; "Rules only" doesn't.
const hasOwnDefault = (l: Layer | null) => l?.inherit === 'base_rules_then_customer_default' || l?.inherit === 'customer_only';

/** The entity chain for one flag. `entity` null: no entity is known (before login), so only everyone's levels. */
export function entityChain(flag: FlagDef, entity: EntityInfo | null): EntityChain {
  const base = flag.base;
  const overrides = base.rules.filter((r) => r.locked);
  const levels: ChainLevel[] = [
    { level: 'override', owner: null, distance: null, layer: base, rules: overrides, section: 'override', set: overrides.length > 0, skippedBy: null, stops: false },
  ];
  let stoppedBy: string | null = null;
  (entity?.path ?? []).forEach((key, distance) => {
    const layer = Object.hasOwn(flag.entities, key) ? flag.entities[key] : null;
    const skippedBy = stoppedBy;
    const stops = !skippedBy && layer?.inherit === 'customer_only';
    levels.push({ level: 'entity', owner: key, distance, layer, rules: layer?.rules ?? [], section: 'entity_rule', set: !!layer, skippedBy, stops });
    if (stops) stoppedBy = key;
  });
  levels.push({ level: 'everyone', owner: null, distance: null, layer: base, rules: base.rules.filter((r) => !r.locked), section: 'everyone_rule', set: true, skippedBy: stoppedBy, stops: false });
  const from = levels.find((l) => l.owner && !l.skippedBy && hasOwnDefault(l.layer));
  return {
    levels,
    default: from
      ? { level: 'entity', owner: from.owner, distance: from.distance, variant: from.layer!.defaultVariation, section: 'entity_default' }
      : { level: 'everyone', owner: null, distance: null, variant: base.defaultVariation, section: 'default' },
  };
}

// Whether a device's bucket (0–9999) is inside one range of a % of devices: `from` is in, `to` is not.
// The one place this is decided; in flagd JSON (flagd.ts) the same range is flagd's `fractional`.
const inRange = (bucket: number, r: { from: number; to: number }) => bucket >= r.from && bucket < r.to;
const rangeAt = (ranges: SplitRange[], bucket: number) => ranges.find((r) => inRange(bucket, r)) ?? null;

// The trace's names for each level (TraceStep.stage, TraceStep.layer). null: the flag's own switch (on / off), on the base layer.
const STAGE_OF: Record<LevelName, TraceStep['stage']> = { override: 'locked', entity: 'entity', everyone: 'base' };
const layerName = (l: LevelName | null): 'base' | 'entity' => (l === 'entity' ? 'entity' : 'base');

// explain = false: app requests. Same answer, but no trace and no metadata are built.
// explain = 'metadata': the metadata without the trace (a list of answers that shows no steps).
export function evaluate(snapshot: Snapshot, flagKey: string, ctx: EvalContext, mode: boolean | 'metadata' = true): EvalResult {
  const explain = mode === true;
  const withMeta = mode !== false;
  const trace: TraceStep[] = [];
  const flag = Object.hasOwn(snapshot.flags, flagKey) ? snapshot.flags[flagKey] : undefined;
  const metaBase = { revision: snapshot.revision, environment: snapshot.environment };
  if (!flag || !flag.delivery.includes(ctx.project)) {
    if (explain) trace.push({
      stage: 'delivery', layer: null, outcome: 'not_delivered',
      detail: !flag ? 'flag does not exist in this environment'
        : `flag is not in service "${ctx.project}"`,
    });
    return { key: flagKey, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND', errorDetails: 'flag not found', metadata: metaBase, decidedBy: NOT_SENT, trace };
  }
  if (explain) trace.push({ stage: 'delivery', layer: null, outcome: 'info', detail: `delivered to "${ctx.project}"` });

  const base = flag.base;
  const who: Asking = { ...ctx, dimensions: snapshot.dimensions };
  const chain = entityChain(flag, ctx.entity);
  const nameOf = (k: string) => (Object.hasOwn(snapshot.entities, k) ? snapshot.entities[k].name : k);
  // the version of each entity's own settings that is in play (not skipped): "layerVersion.<entity>"
  const meta: Record<string, string | number | boolean> = !withMeta ? NO_METADATA : {
    ...metaBase,
    baseVersion: base.version,
    ...Object.fromEntries(chain.levels.filter((l) => l.owner && l.layer && !l.skippedBy).map((l) => [`layerVersion.${l.owner}`, l.layer!.version])),
  };

  // the outside-group name of the first % rule this device fell outside of (see EvalResult.group)
  let outsideGroup: string | undefined;
  const sawRule = (r: Rule, o: RuleOutcome) => { if (o.outside) outsideGroup ??= r.split?.outsideGroup; };
  // a % rule names the device's group itself (named or not); anything else keeps the outside name
  const ruleGroup = (o: RuleOutcome) => (o.reason === 'SPLIT' ? o.group : outsideGroup);

  // a rule passes its own group (undefined when its part of the % has no name); defaults keep the outside name
  const finish = (variation: string, reason: Reason, section: Section, level: LevelName | null, owner: string | null, rule?: Rule, group: string | undefined = rule ? undefined : outsideGroup): EvalResult => {
    const layer = layerName(level);
    const ruleKey = rule?.ruleKey;
    const decidedBy = decided(section, rule, who, owner);
    const named: { group?: string } = group ? { group } : {};
    const at = { layer, ...(owner ? { owner } : {}) };
    if (variation === CODE_DEFAULT) {
      return {
        key: flagKey, variant: CODE_DEFAULT, codeDefault: true, reason,
        metadata: withMeta ? { ...meta, ...at, codeDefault: true, ...(ruleKey ? { ruleKey } : {}), ...(group ? { group } : {}) } : NO_METADATA,
        decidedBy, ...named, trace,
      };
    }
    const value = flag.variations[variation];
    if (value === undefined || !typeMatches(flag.valueType, value)) {
      return { key: flagKey, reason: 'ERROR', errorCode: 'TYPE_MISMATCH', errorDetails: `variation ${variation} invalid`, metadata: meta, decidedBy, trace };
    }
    return {
      key: flagKey, value, variant: variation, reason,
      metadata: withMeta ? { ...meta, ...at, ...(ruleKey ? { ruleKey } : {}), ...(group ? { group } : {}) } : NO_METADATA,
      decidedBy, ...named, trace,
    };
  };

  // flag switched OFF: nobody gets a value — every app uses the default in its own code
  if (!base.enabled) {
    if (explain) trace.push({ stage: 'enabled', layer: 'base', outcome: 'served', detail: 'flag is off → nothing is sent; the app uses its in-app default' });
    return finish(CODE_DEFAULT, 'DISABLED', 'off', null, null);
  }
  if (explain) trace.push({ stage: 'enabled', layer: 'base', outcome: 'info', detail: 'flag is on' });

  // the entity chain, level by level: the first rule that matches decides (overrides fail closed: a missing value matches)
  for (const [i, lv] of chain.levels.entries()) {
    const stage = STAGE_OF[lv.level];
    const layer = layerName(lv.level);
    const owner = lv.owner ?? undefined;
    if (lv.skippedBy) {
      // an entity below uses "Own settings only": these rules are shown as skipped, explicitly
      if (explain) for (const r of lv.rules) {
        trace.push({ stage, layer, ...(owner ? { owner } : {}), ruleKey: r.ruleKey, ruleName: r.name, outcome: 'skipped',
          detail: `skipped: "${nameOf(lv.skippedBy)}" uses only its own settings` });
      }
      continue;
    }
    if (explain && lv.owner && !lv.set) {
      // the next level that has settings: an entity above, or everyone's
      const next = chain.levels.slice(i + 1).find((l) => !l.skippedBy && (l.level === 'everyone' || l.set));
      trace.push({ stage: 'entity', layer: null, owner: lv.owner, outcome: 'info',
        detail: `no rules or default for "${nameOf(lv.owner)}" → ${next?.owner ? `the settings of "${nameOf(next.owner)}" apply` : 'the defaults apply'}` });
    }
    for (const r of lv.rules) {
      const o = evalRule(r, layer, stage, who, explain, owner);
      if (explain) trace.push(o.step!);
      sawRule(r, o);
      if (o.matched) return finish(o.variation!, o.reason!, lv.section, lv.level, lv.owner, r, ruleGroup(o));
    }
  }

  // no rule decided: the chain's default (right after the rules of a level that uses "Own settings only")
  const d = chain.default;
  const stopped = chain.levels.some((l) => l.stops);
  if (explain) trace.push({
    stage: stopped ? 'entity_default' : 'default', layer: layerName(d.level), ...(d.owner ? { owner: d.owner } : {}), outcome: 'served',
    detail: `${d.owner ? `the default of "${nameOf(d.owner)}"` : 'default'} → serves "${d.variant}"`,
  });
  const anyRules = chain.levels.some((l) => !l.skippedBy && l.rules.length > 0);
  return finish(d.variant!, d.level !== 'everyone' || anyRules ? 'DEFAULT' : 'STATIC', d.section, d.level, d.owner);
}

// ---------------------------------------------------------------- one entity, any request
// "What does this entity get?" when only the environment and the entity are known (the entity page, its CDN files,
// its flagd JSON). Walks the entity chain, as evaluate() does: checks on the environment and on every dimension are
// settled here (for an entity above a dimension too, and for no entity), so no entity key ever reaches a file; the
// rest depend on the request and become exceptions. The first rule that always applies, or the chain's default, is the answer.

// `group`: set (a name, or null when that part has no name) only when a % of devices decided the answer.
export type AnswerPick = DecidedBy & { variant: string; group?: string | null };
export type AnswerException = AnswerPick & {
  when: Condition[];                // checks that depend on the request (app, version, device…)
  percent: number | null;           // % of devices, for a "% of devices" rule
  locked: boolean;                  // overrides treat a missing attribute as a match (they fail closed)
  split: (Omit<Split, 'ranges'> & { range: SplitRange }) | null;
};
// A % rule with a name for devices outside it: a device that reaches it (`when` passes and it has the ID the
// rule splits by, `unit`; no unit = settled here) without landing inside carries `group` from then on.
// `at`: how many exceptions come before it, so it can be put back in order. (flagd JSON has no place for group names,
// so flagd.ts leaves these out.)
export type OutsideMark = { at: number; when: Condition[]; locked: boolean; unit: { by: string; fallbackBy: string | null } | null; group: string };
export type EntityAnswer = { gets: AnswerPick; exceptions: AnswerException[]; outside?: OutsideMark[] };

// `settled`: more attributes known for every request this answer is for (the app, the country of a cached
// file), so checks on them are settled here too instead of becoming exceptions. Giving the app also checks delivery.
export function forEntity(flag: FlagDef, where: Where, entity: EntityInfo | null, settled: Record<string, unknown> = {}): EntityAnswer {
  const exceptions: AnswerException[] = [];
  const outside: OutsideMark[] = [];
  // who is asking, as far as every request this answer is for has it in common: the app only when `settled` names it
  const who: Asker = { environment: where.environment, project: typeof settled.project === 'string' ? settled.project : ANY_APP, entity, dimensions: where.dimensions };
  const pick = (variant: string, section: Section, rule?: Rule, owner: string | null = null): AnswerPick => ({ variant, ...decided(section, rule, who, owner) });
  if (flag.delivery.length === 0) return { gets: pick(CODE_DEFAULT, 'not_sent'), exceptions };
  if (who.project !== ANY_APP && !flag.delivery.includes(who.project)) return { gets: pick(CODE_DEFAULT, 'not_sent'), exceptions };
  const base = flag.base;
  if (!base.enabled) return { gets: pick(CODE_DEFAULT, 'off'), exceptions };
  // settled here: what the server works out (as evaluate() does, fields.ts `resolve`), and the `settled` attributes
  const known = (field: string): { value: unknown } | null => {
    const resolve = resolverFor(field, who.dimensions);
    if (!resolve) return Object.hasOwn(settled, field) ? { value: settled[field] } : null;
    const value = resolve(who);
    return value === ANY_APP ? null : { value };
  };

  // null: the rule can never apply; otherwise the matched variant (null while it still depends on the request)
  const walk = (rules: Rule[], section: Section, owner: string | null): AnswerPick | null => {
    for (const r of rules) {
      if (r.disabled) continue;
      const when: Condition[] = [];
      let possible = true;
      for (const c of r.conditions) {
        const k = known(c.field);
        if (!k) { when.push(c); continue; }
        const res = testCondition(c, k.value);
        if (!(res === null ? r.locked : res)) { possible = false; break; }
      }
      if (!possible) continue;
      const base_ = { ...decided(section, r, who, owner), locked: r.locked };
      if (r.serveVariation) {
        if (when.length === 0) return { variant: r.serveVariation, ...decided(section, r, who, owner) };
        exceptions.push({ ...base_, variant: r.serveVariation, when, percent: null, split: null });
        continue;
      }
      const s = r.split!;
      // a split by something we know (the entity, one above it) is settled here too; NONE is no value to split by
      const unit = (f: string | null) => { const k = f ? known(f) : null; return k && k.value === NONE ? { value: undefined } : k; };
      const byKnown = unit(s.by);
      const fbKnown = unit(s.fallbackBy);
      let fixed: SplitRange | null | undefined;      // undefined = depends on the request
      let settledOutside = false;                    // the unit is known and lands outside the %
      const settle = (v: unknown) => { const r = rangeAt(s.ranges, bucketFor(s.salt, String(v), s.hashVersion)); settledOutside = !r; return r; };
      if (byKnown && !isMissing(byKnown.value)) fixed = settle(byKnown.value);
      else if (byKnown && (!s.fallbackBy)) fixed = null;
      else if (byKnown && fbKnown) fixed = isMissing(fbKnown.value) ? null : settle(fbKnown.value);
      if (fixed === null) {
        if (settledOutside && s.outsideGroup) outside.push({ at: exceptions.length, when, locked: r.locked, unit: null, group: s.outsideGroup });
        continue;
      }
      if (fixed !== undefined) {
        const group = fixed.group ?? null;
        if (when.length === 0) return { variant: fixed.variation, ...decided(section, r, who, owner), group };
        exceptions.push({ ...base_, variant: fixed.variation, group, when, percent: null, split: null });
        continue;
      }
      // the entity is known but has no value to group by: the backup ID decides
      const unitOf = byKnown ? { by: s.fallbackBy!, fallbackBy: null } : { by: s.by, fallbackBy: s.fallbackBy };
      for (const range of s.ranges) {
        exceptions.push({ ...base_, variant: range.variation, group: range.group ?? null, when, percent: (range.to - range.from) / 100,
          split: { ...unitOf, salt: s.salt, hashVersion: s.hashVersion, range } });
      }
      if (s.outsideGroup) outside.push({ at: exceptions.length, when, locked: r.locked, unit: unitOf, group: s.outsideGroup });
    }
    return null;
  };

  const chain = entityChain(flag, entity);
  const answer = (gets: AnswerPick): EntityAnswer => ({ gets, exceptions, ...(outside.length ? { outside } : {}) });
  for (const lv of chain.levels) {
    if (lv.skippedBy) continue;
    const gets = walk(lv.rules, lv.section, lv.owner);
    if (gets) return answer(gets);
  }
  return answer(pick(chain.default.variant ?? CODE_DEFAULT, chain.default.section, undefined, chain.default.owner));
}

// The other half of forEntity: given a full request, which line of the answer applies. The lines only check what the
// request brings (forEntity settled the rest), so no dimensions are needed here.
// evaluate() and this must always agree (test/evaluator.test.ts checks it).
export function answerFor(flag: FlagDef, answer: EntityAnswer, ctx: EvalContext): AnswerPick {
  const who: Asking = { ...ctx, dimensions: [] };
  if (answer.gets.section !== 'not_sent' && !flag.delivery.includes(ctx.project)) {
    return { variant: CODE_DEFAULT, section: 'not_sent', owner: null, ruleKey: null, ruleName: null, namesEntity: false };
  }
  for (const e of answer.exceptions) {
    const ok = e.when.every((c) => { const r = testCondition(c, resolveField(c.field, who)); return r === null ? e.locked : r; });
    if (!ok) continue;
    if (!e.split) return e;
    let unitValue = resolveField(e.split.by, who);
    if (isMissing(unitValue) && e.split.fallbackBy) unitValue = resolveField(e.split.fallbackBy, who);
    if (isMissing(unitValue)) continue;
    if (inRange(bucketFor(e.split.salt, String(unitValue), e.split.hashVersion), e.split.range)) return e;
  }
  return answer.gets;
}

// ---------------------------------------------------------------- who is asking
// The one way to turn "who is asking" into an EvalContext: tests of what apps get and the
// console's simulations (Debug tab, Compare, trace) all go through here, so they answer the same.

export class UnknownEntityError extends Error {
  entity: string;
  constructor(entity: string) { super(`"${entity}" not found`); this.entity = entity; }
}

// Only attributes the app may report are kept: what the server works out itself (fields.ts: the app, the environment,
// the entity and every dimension) comes from the link or API key, never from what the request says about itself.
// The console's simulations (Debug tab, Compare, who gets what) go through here with exactly what they were given,
// as a real request does: nothing is filled in for them (not even the platform of an app named "web"), so a rule on
// what the device reports matches in the console only when its "Device details" say so.
export function contextFor(snap: Snapshot, who: { project: string; entity: string | null }, sent: Record<string, unknown> | undefined): EvalContext {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sent ?? {})) {
    const f = Object.hasOwn(snap.fields, k) ? snap.fields[k] : undefined;
    if (!f || !reportedByApp(k, f)) continue;
    if (isMissing(v)) continue;
    attrs[k] = v;
  }
  let entity: EntityInfo | null = null;
  if (who.entity) {
    entity = Object.hasOwn(snap.entities, who.entity) ? snap.entities[who.entity] : null;
    if (!entity) throw new UnknownEntityError(who.entity);
  }
  return { environment: snap.environment, project: who.project, entity, attrs };
}
