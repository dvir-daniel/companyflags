// Values documents: what CompanyFlags takes in from another config system and gives out to one, during a
// migration (docs/guide/migration.md). One shape in the middle, read and written in a few formats:
//
//   values   CompanyFlags' own:  { "flags": { "max_upload_mb": { "value": 50, "on": true,
//                                     "variants": { … }, "entities": { "acme": 100, "globex": null } } } }
//   kv       plain key-value JSON:  { "max_upload_mb": 50, "new_checkout": true }
//   flagd    OpenFeature's flag file (https://flagd.dev/reference/flag-definitions/): each flag's default and on/off
//   jsonata  any other shape, through a JSONata expression (transform.ts) that makes a values document of it
//
// An import sets, in one environment, each flag's default for everyone, whether it's on, and entities' own defaults
// (null: remove that entity's own settings). Rules and % stay as they are: an old system has none to bring. Nothing
// it leaves out changes. It goes through the same saves as the console (layers.ts applyItems): checked the same way,
// one new version, and a request for review where the environment needs approval. A flag the document names that
// doesn't exist is created if asked, as a config flag in the services chosen (none by default: apps keep reading it
// from the old system until it's in their service, the way a flag moves over).
//
// An export gives each flag's default, on/off, variants and entities' own defaults in one environment: the same
// document, so an export imports back unchanged.

import { all, HttpError, one, type Db } from './db.ts';
import { CODE_DEFAULT, HIDDEN_PREFIX, hiddenKey, sortedFlagKeys, type FlagDef, type Layer, type Snapshot } from './evaluator.ts';
import { applyItems, canonical, createChangeSet, type Actor, type Item, type LayerDoc, type RuleDoc } from './layers.ts';
import { createFlag, upsertVariations, type NewFlag } from './control.ts';
import { needsReview } from './policy.ts';
import { buildSnapshot } from './snapshot.ts';
import { buildFlagdDoc } from './flagd.ts';
import { runJsonata } from './transform.ts';

export type FlagValues = {
  value?: unknown;                              // everyone's default
  on?: boolean;
  variants?: Record<string, unknown>;           // named variants (a new flag's, or ones to add)
  entities?: Record<string, unknown>;           // entities' own defaults; null removes the entity's own settings
  name?: string;                                // a new flag's readable name and description
  description?: string;
};
export type ValuesDoc = { flags: Record<string, FlagValues> };

export const FORMATS_IN = ['values', 'kv', 'flagd', 'jsonata'] as const;
export const FORMATS_OUT = ['values', 'kv', 'flagd', 'jsonata'] as const;
export type FormatIn = (typeof FORMATS_IN)[number];
export type FormatOut = (typeof FORMATS_OUT)[number];
export const FORMAT_NAMES: Record<FormatIn, string> = {
  values: 'CompanyFlags values', kv: 'Key-value JSON', flagd: 'flagd (OpenFeature)', jsonata: 'Any JSON, with JSONata',
};

const FLAG_KEY = /^[a-z][a-z0-9_]*$/;
const VARIANT_KEY = /^[a-z0-9][a-z0-9_-]*$/;
const FIELDS = new Set(['value', 'on', 'variants', 'entities', 'name', 'description']);
export const MAX_FLAGS = 5000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A value in a line of words: short JSON. */
export const show = (v: unknown) => { const s = JSON.stringify(v) ?? String(v); return s.length > 48 ? `${s.slice(0, 45)}…` : s; };

export type Read = { doc: ValuesDoc; problems: string[]; warnings: string[] };

/** A values document, checked: every problem found, not only the first. */
export function readValuesDoc(input: unknown): Read {
  const problems: string[] = [];
  if (!isObject(input) || !isObject(input.flags)) {
    return { doc: { flags: {} }, warnings: [], problems: ['A values document is { "flags": { "<flag key>": { "value": … } } }.'] };
  }
  const flags: Record<string, FlagValues> = {};
  const keys = Object.keys(input.flags);
  if (keys.length > MAX_FLAGS) problems.push(`It has ${keys.length} flags: at most ${MAX_FLAGS} at a time.`);
  for (const key of keys) {
    const f = input.flags[key];
    if (!FLAG_KEY.test(key)) { problems.push(`${key}: a flag key has lowercase letters, digits and underscores, and starts with a letter.`); continue; }
    if (!isObject(f)) { problems.push(`${key}: an object, e.g. { "value": true }.`); continue; }
    const unknown = Object.keys(f).filter((k) => !FIELDS.has(k));
    if (unknown.length) problems.push(`${key}: no field ${unknown.map((u) => `“${u}”`).join(', ')} (there are value, on, variants, entities, name and description).`);
    if ('value' in f && (f.value === null || f.value === undefined)) problems.push(`${key}: the value can’t be null.`);
    if ('on' in f && typeof f.on !== 'boolean') problems.push(`${key}: “on” is true or false.`);
    if ('variants' in f) {
      if (!isObject(f.variants)) problems.push(`${key}: variants are { "<variant key>": <value> }.`);
      else for (const [v, val] of Object.entries(f.variants)) {
        if (!VARIANT_KEY.test(v) || v === CODE_DEFAULT || v.startsWith(HIDDEN_PREFIX)) problems.push(`${key}: “${v}” can’t be a variant key (lowercase letters, digits, - and _).`);
        if (val === null || val === undefined) problems.push(`${key}: variant ${v} has no value.`);
      }
    }
    if ('entities' in f && !isObject(f.entities)) problems.push(`${key}: entities are { "<entity key>": <value or null> }.`);
    if ('name' in f && (typeof f.name !== 'string' || f.name.length > 80)) problems.push(`${key}: the name is text, up to 80 characters.`);
    if ('description' in f && typeof f.description !== 'string') problems.push(`${key}: the description is text.`);
    flags[key] = f as FlagValues;
  }
  return { doc: { flags }, problems, warnings: [] };
}

/** flagd's flag file: each flag's default variant's value, on/off and variants. Targeting isn't brought over. */
function fromFlagd(input: unknown): Read {
  if (!isObject(input) || !isObject(input.flags)) return { doc: { flags: {} }, warnings: [], problems: ['A flagd file is { "flags": { "<flag key>": { "state", "variants", "defaultVariant" } } }.'] };
  const flags: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [key, f] of Object.entries(input.flags)) {
    if (!isObject(f) || !isObject(f.variants)) { flags[key] = {}; continue; }
    const out: FlagValues = {};
    if (f.state === 'ENABLED' || f.state === 'DISABLED') out.on = f.state === 'ENABLED';
    // flagd's variant names can be anything; ours are lowercase. Renamed only when that keeps them apart.
    const named = Object.keys(f.variants).map((v) => [v, v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '')] as const);
    if (new Set(named.map(([, n]) => n)).size === named.length && named.every(([, n]) => VARIANT_KEY.test(n) && n !== CODE_DEFAULT)) {
      out.variants = Object.fromEntries(named.map(([v, n]) => [n, (f.variants as Record<string, unknown>)[v]]));
    }
    if (typeof f.defaultVariant === 'string' && Object.hasOwn(f.variants, f.defaultVariant)) out.value = f.variants[f.defaultVariant];
    if (f.targeting !== undefined && !(isObject(f.targeting) && !Object.keys(f.targeting).length)) {
      warnings.push(`${key}: its targeting isn’t brought over, only its default and on/off. Add rules in the console.`);
    }
    flags[key] = out;
  }
  const read = readValuesDoc({ flags });
  return { ...read, warnings: [...warnings, ...read.warnings] };
}

/** Reads `input` (parsed JSON) in one of the import formats. */
export async function toValues(format: unknown, input: unknown, expression?: string | null): Promise<Read> {
  switch (format) {
    case 'values': return readValuesDoc(input);
    case 'kv': {
      if (!isObject(input)) return { doc: { flags: {} }, warnings: [], problems: ['Key-value JSON is { "<flag key>": <value> }.'] };
      return readValuesDoc({ flags: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, { value: v }])) });
    }
    case 'flagd': return fromFlagd(input);
    case 'jsonata': return readValuesDoc(await runJsonata(expression, input));
    default: throw new HttpError(422, `The format is one of ${FORMATS_IN.join(', ')}.`);
  }
}

// ---------------------------------------------------------------- out

const valueAt = (f: FlagDef, variant: string | null) =>
  variant && variant !== CODE_DEFAULT && Object.hasOwn(f.variations, variant) ? { value: f.variations[variant] } : null;
/** An entity's own default, when its settings give one (not when they follow the defaults above). */
const ownDefault = (f: FlagDef, l: Layer) => (l.inherit === 'base_rules_then_base_default' ? null : valueAt(f, l.defaultVariation));

/** One environment's values document: every flag, or only these. */
export function valuesOf(snap: Snapshot, only?: Iterable<string>): ValuesDoc {
  const want = only ? new Set(only) : null;
  const flags: Record<string, FlagValues> = {};
  for (const key of sortedFlagKeys(snap)) {
    if (want && !want.has(key)) continue;
    const f = snap.flags[key];
    const out: FlagValues = {};
    const v = valueAt(f, f.base.defaultVariation);
    if (v) out.value = v.value;
    out.on = f.base.enabled !== false;
    const named = Object.entries(f.variations).filter(([k]) => k !== CODE_DEFAULT && !k.startsWith(HIDDEN_PREFIX));
    if (named.length) out.variants = Object.fromEntries(named);
    const entities = Object.entries(f.entities).map(([e, l]) => [e, ownDefault(f, l)] as const).filter(([, d]) => d);
    if (entities.length) out.entities = Object.fromEntries(entities.map(([e, d]) => [e, d!.value]));
    flags[key] = out;
  }
  return { flags };
}

/** An environment in one of the export formats. flagd is one service's file (what a backend reading it gets). */
export async function fromValues(snap: Snapshot, format: unknown, o: { service?: string | null; expression?: string | null } = {}): Promise<unknown> {
  switch (format) {
    case 'values': return valuesOf(snap);
    case 'kv': return Object.fromEntries(Object.entries(valuesOf(snap).flags).filter(([, f]) => 'value' in f).map(([k, f]) => [k, f.value]));
    case 'flagd': {
      if (!o.service) throw new HttpError(422, 'A flagd file is one service’s: pick the service.');
      return buildFlagdDoc(snap, o.service, null);
    }
    case 'jsonata': return runJsonata(o.expression, valuesOf(snap));
    default: throw new HttpError(422, `The format is one of ${FORMATS_OUT.join(', ')}.`);
  }
}

// ---------------------------------------------------------------- import: the plan, then the saves

export type ImportOptions = {
  environment: string;
  createFlags?: boolean;                        // create the flags it names that don't exist
  services?: string[];                          // …in these services, in this environment
  reason?: string | null;                       // the comment in History, and the reviewer's reason
};
export type Line = { flag: string; entity: string | null; text: string };
export type Plan = {
  environment: string;
  review: boolean;                              // the environment needs approval: the changes become one request
  create: Line[];                               // new flags
  changes: Line[];
  unchanged: number;                            // flags it names that are already as it says
  problems: string[];                           // nothing is imported while there are any
  warnings: string[];
};
type Work = { newFlags: NewFlag[]; variants: Map<string, { key: string; value: unknown }[]>; items: Item[] };

type FlagRow = { key: string; valueType: FlagDef['valueType']; free: boolean; archived: boolean };
const typeOf = (v: unknown): FlagDef['valueType'] =>
  typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : 'json';
const fits = (t: FlagDef['valueType'], v: unknown) =>
  t === 'json' ? v !== null && v !== undefined : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t;
const TYPE_WORDS: Record<FlagDef['valueType'], string> = { bool: 'true or false', number: 'a number', string: 'text', json: 'JSON' };

const docOf = (l: Layer): LayerDoc => ({
  enabled: l.enabled, variationWhenOff: l.variationWhenOff, defaultVariation: l.defaultVariation, inherit: l.inherit, rules: l.rules as RuleDoc[],
});

/** What importing `doc` would change, in words, and the saves that would do it. Changes nothing. */
export async function planImport(db: Db, doc: ValuesDoc, o: ImportOptions): Promise<{ plan: Plan; work: Work }> {
  const env = await one<{ id: number; key: string; minApprovals: number }>(db,
    `select id, key, min_approvals as "minApprovals" from environment where key = $1`, [o.environment]);
  if (!env) throw new HttpError(404, `There’s no environment “${o.environment}”.`);
  const plan: Plan = { environment: env.key, review: needsReview(env), create: [], changes: [], unchanged: 0, problems: [], warnings: [] };
  const work: Work = { newFlags: [], variants: new Map(), items: [] };
  const keys = Object.keys(doc.flags);
  const snap = await buildSnapshot(db, env.key);
  const rows = new Map((await all<FlagRow>(db, `select key, value_type as "valueType", free_values as free, archived_at is not null as archived
    from flag where key = any($1::text[])`, [keys])).map((r) => [r.key, r]));
  const entityKeys = [...new Set(keys.flatMap((k) => Object.keys(doc.flags[k].entities ?? {})))];
  const entities = new Set((await all<{ key: string }>(db, `select key from entity where key = any($1::text[]) and archived_at is null`, [entityKeys])).map((e) => e.key));
  const sets = o.services ?? [];
  if (sets.length) {
    const known = new Set((await all<{ key: string }>(db, `select key from project where key = any($1::text[])`, [sets])).map((p) => p.key));
    for (const a of sets.filter((x) => !known.has(x))) plan.problems.push(`There’s no service “${a}”.`);
  }
  const allEnvs = await all<{ key: string }>(db, `select key from environment order by id`);

  for (const key of keys) {
    const want = doc.flags[key];
    const row = rows.get(key);
    const problem = (p: string) => plan.problems.push(`${key}: ${p}`);
    if (row?.archived) { problem('it’s archived. Restore it in the console, or leave it out.'); continue; }
    const f = snap.flags[key];
    if (!row) {
      if (!o.createFlags) { problem('there’s no such flag. Turn on “Create missing flags”, or create it first.'); continue; }
      const made = newFlag(key, want, env.key, allEnvs.map((e) => e.key), sets);
      if (typeof made === 'string') { problem(made); continue; }
      work.newFlags.push(made);
      const own = Object.keys(want.entities ?? {}).length;
      plan.create.push({ flag: key, entity: null, text: `New flag: everyone gets ${show(want.value)}${want.on === false ? ', switched off' : ''}`
        + `${own ? `, ${own} ${own === 1 ? 'entity gets its' : 'entities get their'} own value` : ''}`
        + `${sets.length ? `, in ${sets.join(', ')}` : ', in no service yet'}` });
      continue;
    }
    if (!f) { problem('it isn’t in this environment’s published flags yet: try again in a moment.'); continue; }
    // values of the right type
    const typed = [...('value' in want ? [want.value] : []), ...Object.values(want.variants ?? {}), ...Object.values(want.entities ?? {}).filter((v) => v !== null)];
    const wrong = typed.find((v) => !fits(f.valueType, v));
    if (wrong !== undefined) { problem(`its values are ${TYPE_WORDS[f.valueType]}, not ${show(wrong)}.`); continue; }

    // the variant for a value: one it has with that value, else (a typed-in value) a hidden one, where those are allowed
    const added: { key: string; value: unknown }[] = [];
    const variantFor = (value: unknown, forEntity: boolean): string | null => {
      const c = canonical(value);
      const own = Object.entries(f.variations).find(([k, v]) => k !== CODE_DEFAULT && canonical(v) === c);
      if (own) return own[0];
      const pending = added.find((a) => canonical(a.value) === c);
      if (pending) return pending.key;
      if (!row.free && !forEntity) return null;
      const k = hiddenKey(value);
      added.push({ key: k, value });
      return k;
    };
    const failed = plan.problems.length;
    for (const [v, val] of Object.entries(want.variants ?? {})) {
      if (!Object.hasOwn(f.variations, v)) {
        if (row.free) { problem(`it takes values typed in, not variants (${v}).`); continue; }
        added.push({ key: v, value: val });
        plan.changes.push({ flag: key, entity: null, text: `New variant ${v}: ${show(val)}` });
      } else if (canonical(f.variations[v]) !== canonical(val)) {
        problem(`its variant ${v} is ${show(f.variations[v])} here, not ${show(val)}: give the new value another variant key.`);
      }
    }
    let changed = false;
    // everyone's default and on/off
    const base = f.base;
    const proposed = docOf(base);
    const lines: string[] = [];
    if ('value' in want) {
      const k = variantFor(want.value, false);
      if (!k) problem(`${show(want.value)} isn’t one of its variants (${Object.entries(f.variations).filter(([x]) => x !== CODE_DEFAULT).map(([x, v]) => `${x} = ${show(v)}`).join(', ')}).`);
      else if (k !== base.defaultVariation) {
        lines.push(`everyone gets ${show(want.value)} (was ${show(valueAt(f, base.defaultVariation)?.value ?? null)})`);
        proposed.defaultVariation = k;
      }
    }
    if (want.on !== undefined && want.on !== (base.enabled !== false)) {
      lines.push(want.on ? 'switched on' : 'switched off');
      proposed.enabled = want.on;
    }
    if (lines.length) {
      work.items.push({ flag: key, entity: null, expectedLayerVersion: base.version, proposed });
      plan.changes.push({ flag: key, entity: null, text: capital(lines.join(', ')) });
      changed = true;
    }
    // entities' own defaults
    for (const [e, val] of Object.entries(want.entities ?? {})) {
      if (!entities.has(e)) { problem(`there’s no entity “${e}”.`); continue; }
      const cur = Object.hasOwn(f.entities, e) ? f.entities[e] : null;
      if (val === null) {
        if (!cur) continue;
        work.items.push({ flag: key, entity: e, expectedLayerVersion: cur.version, proposed: null });
        plan.changes.push({ flag: key, entity: e, text: `${e}: its own settings removed` });
        changed = true;
        continue;
      }
      const k = variantFor(val, true)!;
      if (cur && cur.defaultVariation === k && cur.inherit !== 'base_rules_then_base_default') continue;
      const next: LayerDoc = cur
        ? { ...docOf(cur), defaultVariation: k, inherit: cur.inherit === 'base_rules_then_base_default' || !cur.inherit ? 'base_rules_then_customer_default' : cur.inherit }
        : { rules: [], inherit: 'base_rules_then_customer_default', defaultVariation: k };
      work.items.push({ flag: key, entity: e, expectedLayerVersion: cur?.version ?? null, proposed: next });
      const was = cur ? ownDefault(f, cur) : null;
      plan.changes.push({ flag: key, entity: e, text: `${e} gets ${show(val)}${was ? ` (was ${show(was.value)})` : ''}` });
      changed = true;
    }
    if (plan.problems.length > failed) continue;
    if (added.length) work.variants.set(key, added);
    if (!changed && !added.some((a) => !a.key.startsWith(HIDDEN_PREFIX))) plan.unchanged++;
  }
  return { plan, work };
}

const capital = (s: string) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

/** A new flag for an import: a config flag with this default in every environment, in `sets` in this one. */
function newFlag(key: string, want: FlagValues, env: string, envs: string[], sets: string[]): NewFlag | string {
  if (!('value' in want)) return 'a new flag needs a value for everyone.';
  const valueType = typeOf(want.value);
  const variants = Object.entries(want.variants ?? {});
  if (variants.some(([, v]) => typeOf(v) !== valueType)) return `its variants aren’t all ${TYPE_WORDS[valueType]}, like its value.`;
  const entityValues = Object.values(want.entities ?? {}).filter((v) => v !== null);
  if (entityValues.some((v) => typeOf(v) !== valueType)) return `its entities’ values aren’t all ${TYPE_WORDS[valueType]}, like its value.`;
  let variations: { key: string; value: unknown }[];
  let free = false;
  if (variants.length) variations = variants.map(([k, value]) => ({ key: k, value }));
  else if (valueType === 'bool') variations = [{ key: 'on', value: true }, { key: 'off', value: false }];
  else { free = true; variations = [{ key: hiddenKey(want.value), value: want.value }]; }
  const def = variations.find((v) => canonical(v.value) === canonical(want.value));
  if (!def) return `${show(want.value)} isn’t one of the variants it lists.`;
  const base: LayerDoc = { enabled: want.on ?? true, defaultVariation: def.key, rules: [] };
  return {
    key, name: want.name?.trim() || null, description: want.description, valueType, kind: 'config', freeValues: free, variations,
    delivery: Object.fromEntries(envs.map((e) => [e, e === env ? sets : []])),
    base,
  };
}

export type Imported = { created: number; changed: number; applied: boolean; revision?: number; request?: number; warnings: string[] };

/** Imports `doc`: new flags first, then every other change as one version (or one request, where it needs approval).
 *  `author`: who a request is from (a person's key, or a webhook's name). */
export async function applyImport(db: Db, doc: ValuesDoc, o: ImportOptions, actor: Actor, author = actor.name): Promise<Imported> {
  let { plan, work } = await planImport(db, doc, o);
  if (plan.problems.length) throw new HttpError(422, 'Nothing was imported: fix these first.', { errors: plan.problems });
  const created = work.newFlags.length;
  for (const f of work.newFlags) await createFlag(db, f, actor);
  // the new flags exist now: what's left for them (switching one on where it needs approval, entities' values) is planned again
  // (a new flag starts switched off where approval is needed: it's switched on as asked, or on when the document doesn't say)
  if (created) {
    const made = new Set(work.newFlags.map((f) => f.key));
    const again: ValuesDoc = { flags: Object.fromEntries(Object.entries(doc.flags).map(([k, f]) => [k, made.has(k) ? { ...f, on: f.on ?? true } : f])) };
    ({ plan, work } = await planImport(db, again, { ...o, createFlags: false }));
  }
  if (plan.problems.length) throw new HttpError(422, 'Only the new flags were created: fix these, then import again.', { errors: plan.problems });
  for (const [flag, variants] of work.variants) await upsertVariations(db, flag, variants, actor);
  const result: Imported = { created, changed: plan.changes.length, applied: true, warnings: plan.warnings };
  if (!work.items.length) return result;
  const reason = o.reason?.trim() || 'Imported';
  if (plan.review) {
    const cs = await createChangeSet(db, plan.environment, work.items, author, reason);
    return { ...result, applied: false, request: Number(cs.id) };
  }
  const r = await applyItems(db, plan.environment, work.items, actor, { comment: reason });
  return { ...result, revision: r.revision };
}
