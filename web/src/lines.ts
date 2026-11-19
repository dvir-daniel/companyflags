// The "who gets what" model. The UI shows one ordered list of lines; storage keeps the
// base layer + one layer per entity. This module converts between the two and builds a
// preview snapshot so "Try it" runs the real evaluator on unsaved changes.
import { contextFor, entitiesFrom, evaluate, HIDDEN_PREFIX, hiddenKey, type EntityInfo, type EvalResult, type FlagDef, type Layer as EvalLayer, type Snapshot } from '../../server/evaluator.ts';
import { checkRule, type FieldFacts } from '../../server/checks.ts';
import {
  CODE_DEFAULT, conditionText, count, entityIndex, entityLabel, entityWordsOf, fmtValue, uuid, vocabOf, withoutOwn,
  type Condition, type Entity, type FlagDetail, type Layer, type Meta, type Split,
} from './api.ts';

export type Line = {
  id: string;
  entity: string | null;            // whose own settings; null = applies to everyone
  locked: boolean;
  paused: boolean;
  name: string | null;
  conditions: Condition[];
  serveVariation: string | null;
  split: Split | null;
  // The entity's own default under "Own settings only": it shows as the entity's last condition-free line, but the
  // entity stops there (the rules for everyone and the settings of those above it are skipped), so it's saved as the
  // layer's default, not as a rule. Given a condition, a % split or a pause, or no longer last in its group, it is
  // an ordinary rule again (ownOnlyDefault).
  ownOnly?: boolean;
};
// newValues: values typed straight into the entity table, saved as hidden variations on publish.
// afterEveryone: entities whose own default comes after the rules for everyone (entity → variant).
// Their default can't be a line: lines for an entity always run before the rules for everyone.
export type Draft = { fallback: string; lines: Line[]; newValues: Record<string, unknown>; afterEveryone: Record<string, string> };

// ---- per-entity values ---------------------------------------------------------------
// A value typed for one entity is stored as a hidden, content-addressed variation ("val-<hash>"):
// creating it changes nothing until a published line points at it, so approvals still apply.
export { HIDDEN_PREFIX, hiddenKey };
export const isHidden = (key: string) => key.startsWith(HIDDEN_PREFIX);

// An entity's "own value" is its catch-all line: no conditions, no split, not paused.
export const isCatchAll = (l: Line) => !!l.entity && l.conditions.length === 0 && !l.split && !l.paused;

// The line that is this entity's "Own settings only" default, if it still is one: marked, condition-free and
// the last line of the entity's group. Anything else in the group is a rule.
export const ownOnlyDefault = (draft: Draft, entity: string): Line | null => stopsAt(draft.lines.filter((l) => l.entity === entity));
const stopsAt = (group: Line[]): Line | null => {
  const last = group[group.length - 1];
  return last && last.ownOnly && isCatchAll(last) && last.serveVariation ? last : null;
};

// Set (or clear, with null) the own value of many entities at once. It replaces a default that came
// after the rules for everyone: the new value wins over them. An "Own settings only" default keeps its choice.
export function setOwnValues(draft: Draft, entities: string[], variation: string | null, newValue?: { key: string; value: unknown }): Draft {
  const set = new Set(entities);
  const afterEveryone = Object.fromEntries(Object.entries(draft.afterEveryone).filter(([c]) => !set.has(c)));
  let lines = draft.lines.filter((l) => !(l.entity && set.has(l.entity) && isCatchAll(l)));
  if (variation) {
    const keep = new Map(draft.lines.filter((l) => l.entity && set.has(l.entity) && isCatchAll(l)).map((l) => [l.entity!, l]));
    lines = [...lines, ...entities.map((c): Line => ({ id: keep.get(c)?.id ?? uuid(), entity: c, locked: false, paused: false, name: null, conditions: [], serveVariation: variation, split: null,
      ...(keep.get(c)?.ownOnly ? { ownOnly: true } : {}) }))];
  }
  const newValues = newValue ? { ...draft.newValues, [newValue.key]: newValue.value } : draft.newValues;
  return { ...draft, lines: sortLines(lines), newValues, afterEveryone };
}

// Every entity with its own settings in the draft, rules or a default.
export const draftEntities = (draft: Draft) => [...new Set([...draft.lines.filter((l) => l.entity).map((l) => l.entity!), ...Object.keys(draft.afterEveryone)])];

// Remove an entity's own settings: it gets what it would with none again (what its parent gets, or everyone's).
export const removeEntity = (draft: Draft, entity: string): Draft => ({
  ...draft, lines: draft.lines.filter((l) => l.entity !== entity),
  afterEveryone: Object.fromEntries(Object.entries(draft.afterEveryone).filter(([c]) => c !== entity)),
});

// Hidden values that published lines will reference but don't exist yet.
export function valuesToCreate(flag: Pick<FlagDetail, 'variations'>, draft: Draft): { key: string; value: unknown }[] {
  const have = new Set(flag.variations.map((v) => v.key));
  const used = new Set<string>([draft.fallback, ...Object.values(draft.afterEveryone)]);
  for (const l of draft.lines) { if (l.serveVariation) used.add(l.serveVariation); for (const r of l.split?.ranges ?? []) used.add(r.variation); }
  return Object.entries(draft.newValues).filter(([k]) => used.has(k) && !have.has(k)).map(([key, value]) => ({ key, value }));
}
type LayerDoc = { enabled?: boolean | null; defaultVariation: string | null; inherit?: Layer['inherit']; rules: object[] };

// `ownIds`: the line id to give each entity's "Own settings only" default (entity → id), so the same stored layers
// open as the same lines again (a saved draft, a rebase); any other entity's gets a new one.
export function toDraft(flag: Pick<FlagDetail, 'layers'>, env: string, ownIds: Record<string, string> = {}): Draft {
  const { base, entities } = flag.layers[env];
  const fromRule = (entity: string | null) => (r: Layer['rules'][number]): Line => ({
    id: r.ruleKey ?? uuid(), entity, locked: r.locked, paused: r.disabled, name: r.name,
    conditions: r.conditions, serveVariation: r.serveVariation, split: r.split,
  });
  const lines: Line[] = base.rules.filter((r) => r.locked).map(fromRule(null));
  const afterEveryone: Record<string, string> = {};
  for (const { entity, layer } of [...entities].sort((a, b) => a.entity.localeCompare(b.entity))) {
    lines.push(...layer.rules.map(fromRule(entity)));
    if (!layer.defaultVariation) continue;
    // Own settings only: the default comes right after the entity's rules, so it shows as the group's last,
    // condition-free line; it remembers that the entity stops there (toLayers saves it as the default again).
    // Rules + own default: it comes after the rules for everyone, so it stays a default.
    if (layer.inherit === 'customer_only') {
      lines.push({ id: ownIds[entity] ?? uuid(), entity, locked: false, paused: false, name: null, conditions: [], serveVariation: layer.defaultVariation, split: null, ownOnly: true });
    } else if (layer.inherit === 'base_rules_then_customer_default') afterEveryone[entity] = layer.defaultVariation;
  }
  lines.push(...base.rules.filter((r) => !r.locked).map(fromRule(null)));
  return { fallback: base.defaultVariation ?? CODE_DEFAULT, lines, newValues: {}, afterEveryone };
}

// Lines always sit in evaluation order: locked → entity lines (grouped) → lines for everyone.
// One pass: entities keep the order they first appear in, and each entity's lines keep theirs.
export function sortLines(lines: Line[]): Line[] {
  const locked: Line[] = [];
  const everyone: Line[] = [];
  const byEntity = new Map<string, Line[]>();
  for (const l of lines) {
    if (!l.entity) (l.locked ? locked : everyone).push(l);
    else {
      const group = byEntity.get(l.entity);
      if (group) group.push(l); else byEntity.set(l.entity, [l]);
    }
  }
  return [...locked, ...[...byEntity.values()].flat(), ...everyone];
}

// One draft line as the rule the server stores.
export const lineToRule = (l: Line) => ({
  ruleKey: l.id, name: l.name || null, locked: !l.entity && l.locked, disabled: l.paused,
  conditions: l.conditions.map((c) => ({ ...c, values: (c.values ?? []).filter((v) => v !== '') })),
  serveVariation: l.split ? null : l.serveVariation, split: l.split,
});

// The inverse of toDraft: for every stored layer shape, toLayers(toDraft(stored)) is the stored layers apart
// from their versions, so opening and republishing a flag keeps each entity's choice.
export function toLayers(draft: Draft, enabled: boolean): { base: LayerDoc; entities: Map<string, LayerDoc> } {
  const base: LayerDoc = {
    enabled, defaultVariation: draft.fallback,
    rules: [...draft.lines.filter((l) => !l.entity && l.locked), ...draft.lines.filter((l) => !l.entity && !l.locked)].map(lineToRule),
  };
  const entities = new Map<string, LayerDoc>();
  const groups = new Map<string, Line[]>();
  for (const l of draft.lines) if (l.entity) { const g = groups.get(l.entity); if (g) g.push(l); else groups.set(l.entity, [l]); }
  for (const [c, group] of groups) {
    const own = stopsAt(group);
    const rules = (own ? group.slice(0, -1) : group).map(lineToRule);
    // Own settings only: its rules, then its own default; Rules only: its rules, then what it would get without them
    entities.set(c, own ? { inherit: 'customer_only', defaultVariation: own.serveVariation, rules }
      : { inherit: 'base_rules_then_base_default', defaultVariation: null, rules });
  }
  for (const [c, variant] of Object.entries(draft.afterEveryone)) {
    const doc = entities.get(c);
    // an entity that stops at its own "Own settings only" default never reaches a default after the rules for everyone
    if (doc?.inherit === 'customer_only') continue;
    entities.set(c, { rules: doc?.rules ?? [], inherit: 'base_rules_then_customer_default', defaultVariation: variant });
  }
  return { base, entities };
}

const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) : x));

export type PublishItem = { entity: string | null; expectedVersion: number | null; layer: LayerDoc | null };

// The ids toDraft gave the "Own settings only" defaults (entity → line id), to open the same layers as the same lines.
export const ownIdsOf = (draft: Draft): Record<string, string> =>
  Object.fromEntries(draft.lines.filter((l) => l.ownOnly && l.entity).map((l) => [l.entity!, l.id]));

// Only layers whose content actually changed are published.
export function changes(flag: Pick<FlagDetail, 'layers'>, env: string, orig: Draft, next: Draft): PublishItem[] {
  const enabled = !!flag.layers[env].base.enabled;
  const a = toLayers(orig, enabled);
  const b = toLayers(next, enabled);
  const items: PublishItem[] = [];
  if (canon(a.base) !== canon(b.base)) items.push({ entity: null, expectedVersion: flag.layers[env].base.version, layer: b.base });
  const versions = new Map(flag.layers[env].entities.map((c) => [c.entity, c.layer.version]));   // stored layers, by entity
  const names = new Set([...a.entities.keys(), ...b.entities.keys(), ...versions.keys()]);
  for (const c of names) {
    const before = a.entities.get(c) ?? null;
    const after = b.entities.get(c) ?? null;
    if (canon(before) === canon(after)) continue;
    items.push({ entity: c, expectedVersion: versions.get(c) ?? null, layer: after });
  }
  return items;
}

// ---- the shared checks on one line, and the change in sentences ---------------------------------

// What the checks compare a line against (the flag's variants, the typed values, the attributes): built once per
// flag, typed values and attributes (each a new object when it changes), not once per line; and each line's answer
// is kept until the line changes (an edit makes a new line object), so a page re-renders without checking again.
type RuleCheck = { flag: { key: string; kind: string; variants: Set<string> }; facts: FieldFacts; answers: WeakMap<Line, string | null> };
const ruleChecks = new WeakMap<object, WeakMap<object, WeakMap<object, RuleCheck>>>();
function ruleCheckFor(flag: Pick<FlagDetail, 'key' | 'kind' | 'variations'>, newValues: Draft['newValues'], fields: Meta['fields']): RuleCheck {
  let byValues = ruleChecks.get(flag);
  if (!byValues) ruleChecks.set(flag, (byValues = new WeakMap()));
  let byFields = byValues.get(newValues);
  if (!byFields) byValues.set(newValues, (byFields = new WeakMap()));
  let check = byFields.get(fields);
  if (!check) {
    check = {
      flag: { key: flag.key, kind: flag.kind, variants: new Set([...flag.variations.map((v) => v.key), ...Object.keys(newValues)]) },
      facts: Object.fromEntries(fields.map((f) => [f.name, { valueType: f.valueType, canSplitBy: f.canSplitBy }])),
      answers: new WeakMap(),
    };
    byFields.set(fields, check);
  }
  return check;
}

// The server's own checks (server/checks.ts) on one line: null when it can be saved.
export function lineProblem(line: Line, flag: Pick<FlagDetail, 'key' | 'kind' | 'variations'>, draft: Draft, fields: Meta['fields']): string | null {
  const check = ruleCheckFor(flag, draft.newValues, fields);
  let p = check.answers.get(line);
  if (p === undefined) {
    p = checkRule(lineToRule(line), check.flag, check.facts, { isBase: !line.entity }).problems[0] ?? null;
    check.answers.set(line, p);
  }
  return p;
}

/** A variant's value: one typed into this draft, or the flag's. */
export const valueOf = (flag: Pick<FlagDetail, 'variations'>, draft: Draft, k: string) =>
  (k in draft.newValues ? draft.newValues[k] : flag.variations.find((x) => x.key === k)?.value);

/** "3 stores", or by dimension when they're in several: "2 stores, 1 chain". */
export function entityCount(keys: readonly string[], meta: Pick<Meta, 'entities' | 'dimensions'>): string {
  const byKey = entityIndex(meta.entities);
  const per = new Map<string, number>();
  for (const k of keys) { const d = byKey.get(k)?.dimension ?? ''; per.set(d, (per.get(d) ?? 0) + 1); }
  return meta.dimensions.filter((d) => per.has(d.key)).map((d) => count(d, per.get(d.key)!))
    .concat(per.has('') ? [`${per.get('')!.toLocaleString()} more`] : []).join(', ');
}

/** What going from `orig` to `draft` changes, one sentence each ("Add rule: Acme 12 · web → on"). */
export function summarize(flag: Pick<FlagDetail, 'valueType' | 'variations'>, orig: Draft, draft: Draft, meta: Pick<Meta, 'entities' | 'dimensions'>): string[] {
  const out: string[] = [];
  const val = (k: string | null) => (!k || k === CODE_DEFAULT ? 'the in-app default' : isHidden(k) || flag.valueType !== 'string' ? fmtValue(valueOf(flag, draft, k) ?? valueOf(flag, orig, k)) : k);
  const nameOf = (c: string) => entityLabel(meta.entities, c);
  const vocab = vocabOf(meta);
  const who = (l: Line) => [l.entity ? nameOf(l.entity) : null, ...l.conditions.map((c) => conditionText(c, vocab))].filter(Boolean).join(' · ') || 'all requests';
  const rulesA = new Map(orig.lines.filter((l) => !isCatchAll(l)).map((l) => [l.id, l]));
  const rulesB = new Map(draft.lines.filter((l) => !isCatchAll(l)).map((l) => [l.id, l]));
  for (const [id, l] of rulesB) {
    const a = rulesA.get(id);
    if (!a) out.push(`Add rule: ${who(l)} → ${l.split ? 'a percentage' : val(l.serveVariation)}`);
    else if (JSON.stringify(a) !== JSON.stringify(l)) out.push(`Change rule: ${who(l)}`);
  }
  for (const [id, l] of rulesA) if (!rulesB.has(id)) out.push(`Remove rule: ${who(l)}`);
  const ownA = new Map(orig.lines.filter(isCatchAll).map((l) => [l.entity!, l.serveVariation]));
  const ownB = new Map(draft.lines.filter(isCatchAll).map((l) => [l.entity!, l.serveVariation]));
  const setTo = new Map<string, string[]>();
  const cleared: string[] = [];
  for (const c of new Set([...ownA.keys(), ...ownB.keys()])) {
    const a = ownA.get(c) ?? null; const b = ownB.get(c) ?? null;
    if (a === b) continue;
    if (!b) { if (!(c in draft.afterEveryone)) cleared.push(c); } else setTo.set(b, [...(setTo.get(b) ?? []), c]);
  }
  const names = (cs: string[]) => (cs.length <= 3 ? cs.map(nameOf).join(', ') : entityCount(cs, meta));
  if (setTo.size > 5) out.push(`Set own defaults for ${entityCount([...setTo.values()].flat(), meta)} (${setTo.size.toLocaleString()} different values)`);
  else for (const [k, cs] of setTo) out.push(`Set ${val(k)} for ${names(cs)}`);
  // defaults that come after the rules for everyone
  for (const c of new Set([...Object.keys(orig.afterEveryone), ...Object.keys(draft.afterEveryone)])) {
    const a = orig.afterEveryone[c]; const b = draft.afterEveryone[c];
    if (a === b) continue;
    if (b) out.push(`Set ${val(b)} for ${nameOf(c)}, after the rules for everyone`);
    else if (!ownB.has(c)) cleared.push(c);
  }
  // back to what they get with nothing of their own: what their parent gets, or everyone's at the top
  const back = new Map<string, string[]>();
  for (const c of cleared) { const to = withoutOwn(entityWordsOf(meta.entities, c)); back.set(to, [...(back.get(to) ?? []), c]); }
  for (const [to, cs] of back) out.push(`${names(cs)} back to ${to}`);
  if (orig.fallback !== draft.fallback) out.push(`Default: ${val(draft.fallback)}`);
  return out.length ? out : ['Reorder rules'];
}

/** Each entity with its path up the chain and its entity per dimension, built as the server's snapshot builds them
 *  (server/evaluator.ts entitiesFrom), so "Try it" follows the chain as the server does. Kept once per list. */
const infos = new WeakMap<Entity[], Record<string, EntityInfo>>();
export function entityInfos(entities: Entity[]): Record<string, EntityInfo> {
  let out = infos.get(entities);
  if (!out) infos.set(entities, (out = entitiesFrom(entities)));
  return out;
}

export function preview(flag: FlagDetail, env: string, draft: Draft, enabled: boolean, meta: Meta,
  ctx: { project: string; entity: string | null; attrs: Record<string, unknown> }): EvalResult {
  const { base, entities } = toLayers(draft, enabled);
  const asLayer = (d: LayerDoc): EvalLayer => ({ version: 0, enabled: d.enabled ?? null, variationWhenOff: d.enabled === undefined ? null : CODE_DEFAULT,
    defaultVariation: d.defaultVariation, inherit: d.inherit ?? null, rules: d.rules as EvalLayer['rules'] });
  const def: FlagDef = {
    key: flag.key, valueType: flag.valueType as FlagDef['valueType'], kind: flag.kind,
    variations: Object.fromEntries([...flag.variations.map((v) => [v.key, v.value]), ...Object.entries(draft.newValues), [CODE_DEFAULT, null]]),
    delivery: flag.delivery[env] ?? [],
    base: asLayer(base),
    entities: Object.fromEntries([...entities].map(([k, d]) => [k, asLayer(d)])),
  };
  const snap: Snapshot = {
    environment: env, revision: 0, builtAt: '', flags: { [flag.key]: def },
    // each entity carries its path, so "Try it" follows the chain as the server does
    entities: entityInfos(meta.entities),
    dimensions: meta.dimensions.map((d) => d.key),
    fields: Object.fromEntries(meta.fields.map((f) => [f.name, { valueType: f.valueType, comesFrom: f.comesFrom }])),
  };
  return evaluate(snap, flag.key, contextFor(snap, { project: ctx.project, entity: ctx.entity }, ctx.attrs, { trust: 'console' }));
}
