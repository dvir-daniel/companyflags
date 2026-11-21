// What the server accepts, in one pure module. The server runs it before saving (422 on problems);
// the rule editor runs the same checks, so "incomplete" in the console and a rejected save can't disagree.

import { CODE_DEFAULT, type Condition, type Inherit, type Layer, type Op, type Rule, type SplitRange } from './evaluator.ts';
import { HASH_VERSION } from './hash.ts';
import { isVersionRelease } from './release.ts';
import { fullVersion, parseSemver } from './semver.ts';
import { CHOICE_NAME, CHOICES, fieldLabel, opLabel, OPS_BY_TYPE, type ConditionLike } from './words.ts';

export type RuleDoc = Partial<Omit<Rule, 'split' | 'conditions'>> & {
  conditions?: ConditionLike[];
  split?: { by: string; fallbackBy?: string | null; salt?: string; hashVersion?: number; ranges: SplitRange[]; outsideGroup?: string | null } | null;
};
export type LayerDoc = {
  enabled?: boolean | null;
  variationWhenOff?: string | null;
  defaultVariation?: string | null;
  inherit?: Inherit | null;
  rules?: RuleDoc[];
};

// What the checks need to know about the flag and the attributes; loaded from the database by the server,
// taken from the page's data by the console.
export type FlagFacts = { key: string; kind: string; variants: ReadonlySet<string> };
export type FieldFacts = Record<string, { valueType: string; canSplitBy: boolean }>;

// ---- flag purpose rules ------------------------------------------------------------------------

// Releases and experiments are temporary: they need a remove-by date. A version release (a release whose values are
// versions, docs/content/docs/guide/releases.md) stays, so it has none. `flag`: its value type and variants, where known.
export const needsRemoveBy = (kind: string, flag?: { valueType: string; variants: readonly { key: string; value: unknown }[] }) =>
  kind === 'experiment' || (kind === 'release' && !(flag && isVersionFlag(flag)));
/** A version release's values: a string flag whose every value is a release version (semver.ts). */
export const isVersionFlag = (flag: { valueType: string; variants: readonly { key: string; value: unknown }[] }) =>
  flag.valueType === 'string' && isVersionRelease(flag.variants);
// device IDs come from the app and can be faked, so permission flags can't hand out values by %
export const canUsePercent = (kind: string) => kind !== 'permission';
// a backup ID changes who is inside the %, so only short-lived flags may use one
export const canUseBackupId = (kind: string) => kind === 'release' || kind === 'experiment';
// Which flags on call may switch off without a review (break-glass) is in policy.ts, with who may do it.

export const ENTITY_KEY = /^[a-z0-9][a-z0-9-]*$/;
// Words the console's addresses use in the place of an entity or environment key ("/layers/prod/base" is the
// defaults, "/api/trace" and "/api/compare" are simulations), so no entity or environment may be called that.
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['base', 'trace', 'compare']);
export const reservedKeyProblem = (what: string, key: string) => (RESERVED_KEYS.has(key) ? `“${key}” is a reserved word: pick another ${what} key` : null);
export const entityKeyProblem = (key: string) => (!ENTITY_KEY.test(key) ? 'Keys use lowercase letters, digits and dashes, and start with a letter or digit'
  : RESERVED_KEYS.has(key) ? `“${key}” is a reserved word: pick another key` : null);

// A flag's readable name ("New checkout flow") and its tags ("checkout", "web"): the key stays what code reads.
export const FLAG_NAME_MAX = 80;
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_TAGS = 10;
/** "Web Checkout" → "web-checkout": tags are compared as written, so they're kept in one form. */
export const normalizeTag = (t: string) => t.trim().toLowerCase().replace(/[\s_]+/g, '-');
export const tagProblem = (t: string) => (TAG.test(t) ? null : `Tag “${t}” can use lowercase letters, digits and dashes, up to 32 characters`);
export const flagNameProblem = (n: string) => (n.trim().length > FLAG_NAME_MAX ? `Names are up to ${FLAG_NAME_MAX} characters` : null);
/** Cleans a list of tags (normalized, no repeats) or says what's wrong with it. */
export function cleanTags(tags: unknown): { tags: string[]; problem: string | null } {
  if (tags === undefined || tags === null) return { tags: [], problem: null };
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) return { tags: [], problem: 'Tags must be a list of words' };
  const out = [...new Set((tags as string[]).map(normalizeTag).filter(Boolean))];
  if (out.length > MAX_TAGS) return { tags: out, problem: `Up to ${MAX_TAGS} tags` };
  return { tags: out, problem: out.map(tagProblem).find(Boolean) ?? null };
}
/** "New checkout flow" → "new_checkout_flow": the key suggested for a name (keys use a-z, 0-9 and _). */
export const keyFromName = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '').slice(0, 64);

// Group names for % of devices go to the app as metadata.group and on into the app's own analytics,
// so they stay plain: letters, digits, _ - . and at most 64 characters.
export const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const groupNameProblem = (name: string) => (GROUP_NAME.test(name) ? null : 'Group names use letters, digits, _ - and . (up to 64 characters, no spaces)');
const groupName = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const UUID = /^[0-9a-f-]{36}$/i;

// ---- one check ---------------------------------------------------------------------------------

export function conditionProblem(c: ConditionLike, fields: FieldFacts): string | null {
  const f = fields[c.field];
  const label = fieldLabel(c.field);
  if (!f) return `unknown attribute “${c.field}”`;
  if (!OPS_BY_TYPE[f.valueType]?.some((o) => o.op === c.op)) return `“${opLabel(c.op)}” can’t be used with ${label}`;
  if (c.op === 'exists' || c.op === 'missing') return null;
  const vals = (c.values ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (vals.length === 0) return `Add a value for “${label}”`;
  if (f.valueType === 'semver' && vals.some((v) => !parseSemver(v))) return `${label} must look like 5.0.0`;
  if (f.valueType === 'int' && vals.some((v) => !/^-?\d+$/.test(v))) return `${label} must be a whole number`;
  return null;
}

// ---- one rule ----------------------------------------------------------------------------------

export function checkRule(r: RuleDoc, flag: FlagFacts, fields: FieldFacts, opts: { isBase: boolean; prev?: Rule | null; allowReshuffle?: boolean }) {
  const problems: string[] = [];
  let reshuffles = false;
  const knownVariant = (v: unknown) => typeof v === 'string' && (v === CODE_DEFAULT || flag.variants.has(v));
  const ruleKey = r.ruleKey ?? globalThis.crypto.randomUUID();
  if (!UUID.test(ruleKey)) problems.push('ruleKey must be a uuid');
  const locked = !!r.locked;
  if (locked && !opts.isBase) problems.push('overrides are only for everyone: an entity’s own settings can’t have one');

  const conditions: Condition[] = [];
  for (const c of r.conditions ?? []) {
    const p = conditionProblem(c, fields);
    if (p) problems.push(p);
    // versions are saved in full ("6" → "6.0.0"): they compare the same, and strict readers of flagd JSON need it
    const values = c.op === 'exists' || c.op === 'missing' ? [] : (c.values ?? []);
    conditions.push({ field: c.field, op: c.op as Op, values: c.op.startsWith('semver_') ? values.map((v) => fullVersion(String(v)) ?? v) : values });
  }

  if (!!r.split === !!r.serveVariation) problems.push('serve one variant, or a % of devices');
  if (r.serveVariation && !knownVariant(r.serveVariation)) problems.push(`unknown variant “${r.serveVariation}”`);
  let split: Rule['split'] = null;
  if (r.split) {
    if (!canUsePercent(flag.kind)) problems.push('permission flags can’t use % of devices (device IDs come from the app and can be faked)');
    if (!fields[r.split.by]?.canSplitBy) problems.push(`“${r.split.by}” can’t be used for % of devices`);
    const fb = r.split.fallbackBy || null;
    if (fb && !fields[fb]?.canSplitBy) problems.push(`“${fb}” can’t be used as a backup for % of devices`);
    if (fb && !canUseBackupId(flag.kind)) problems.push(`only release flags may use a backup ID for % of devices — ${flag.kind.replace('_', ' ')} values must be sticky`);
    const ranges = [...(r.split.ranges ?? [])].sort((a, b) => a.from - b.from)
      .map(({ group, ...rg }) => ({ ...rg, ...(groupName(group) ? { group: groupName(group) } : {}) }));
    // Every % rule is saved with hash version 2, flagd's (hash.ts), so backends evaluating our flagd JSON (flagd.ts)
    // agree with the server. Any other version would break every file build.
    if (r.split.hashVersion != null && r.split.hashVersion !== HASH_VERSION) {
      problems.push(`% of devices: hash version ${r.split.hashVersion} doesn’t exist (only ${HASH_VERSION})`);
    }
    const outsideGroup = groupName(r.split.outsideGroup);
    const names = [...ranges.map((rg) => rg.group), outsideGroup].filter((n): n is string => !!n);
    for (const n of names) { const p = groupNameProblem(n); if (p) { problems.push(p); break; } }
    if (new Set(names).size < names.length) problems.push('Each group needs its own name');
    if (!ranges.length) problems.push('% of devices needs at least one group');
    ranges.forEach((rg, j) => {
      if (!knownVariant(rg.variation)) problems.push(`group ${j + 1}: unknown variant “${rg.variation}”`);
      const whole = Number.isInteger(rg.from) && Number.isInteger(rg.to) && rg.from >= 0 && rg.to <= 10000;
      if (!whole) problems.push(`group ${j + 1}: [${rg.from}, ${rg.to}) must be whole numbers within 0..10000 (0–100%)`);
      else if (rg.from >= rg.to) problems.push('Set a percentage above 0');
      if (j > 0 && rg.from < ranges[j - 1].to) problems.push(`% groups overlap at ${rg.from / 100}%`);
    });
    split = { by: r.split.by, fallbackBy: fb, salt: r.split.salt || flag.key, hashVersion: HASH_VERSION, ranges, ...(outsideGroup ? { outsideGroup } : {}) };

    // M6: edits must keep existing ranges in place, or nobody stays sticky
    const prev = opts.prev?.split;
    if (prev && !opts.allowReshuffle) {
      const moved = prev.salt !== split.salt || prev.by !== split.by || prev.hashVersion !== split.hashVersion
        || prev.ranges.some((p) => !split!.ranges.some((n) => n.from === p.from)); // changing the value of a group keeps its devices
      if (moved) { reshuffles = true; problems.push('this change would reshuffle which devices are inside the % — only grow or shrink the %, or confirm a reshuffle.'); }
    }
  }
  const rule: Rule = { ruleKey, name: r.name ?? null, locked, disabled: !!r.disabled, conditions, serveVariation: r.serveVariation ?? null, split };
  // reshuffles: one of the problems is that it moves devices in or out of the % (allowReshuffle confirms it)
  return { rule, problems, reshuffles };
}

// ---- a whole layer -----------------------------------------------------------------------------

// Validates and normalizes a proposed layer. `errors` lists every problem, each prefixed with where it is;
// `reshuffles`: one of them is a % change that needs a confirmed reshuffle.
export function checkLayer(flag: FlagFacts, fields: FieldFacts, isBase: boolean, doc: LayerDoc, current: Layer | null, allowReshuffle = false): { layer: Layer; errors: string[]; reshuffles: boolean } {
  const errors: string[] = [];
  let reshuffles = false;
  const needVar = (v: unknown, what: string) => {
    if (typeof v !== 'string' || (v !== CODE_DEFAULT && !flag.variants.has(v))) errors.push(`${what}: unknown variant “${v}”`);
  };
  let layer: Layer;
  if (isBase) {
    if (typeof doc.enabled !== 'boolean') errors.push('Defaults: the On/Off switch is required');
    needVar(doc.defaultVariation, 'Default');
    if (doc.inherit) errors.push('The defaults can’t have a choice of how to follow the levels above');
    // OFF always means "send nothing": the stored when-off variation is always the in-app default
    layer = { version: 0, enabled: !!doc.enabled, variationWhenOff: CODE_DEFAULT, defaultVariation: doc.defaultVariation ?? null, inherit: null, rules: [] };
  } else {
    if (doc.enabled != null || doc.variationWhenOff != null) errors.push('Own settings can’t turn the flag on or off — only the flag’s On/Off switch can');
    const inherit = doc.inherit ?? 'base_rules_then_base_default';
    if (!CHOICES.includes(inherit)) errors.push(`unknown choice “${inherit}”`);
    if (inherit === 'base_rules_then_base_default') {
      if (doc.defaultVariation) errors.push(`“${CHOICE_NAME.base_rules_then_base_default}” has no default of its own — remove the default or change the choice`);
    } else needVar(doc.defaultVariation, 'Own default');
    layer = { version: 0, enabled: null, variationWhenOff: null, inherit, defaultVariation: inherit === 'base_rules_then_base_default' ? null : doc.defaultVariation ?? null, rules: [] };
  }

  const seen = new Set<string>();
  let sawUnlocked = false;
  (doc.rules ?? []).forEach((r, i) => {
    const where = `rule ${i + 1}${r.name ? ` “${r.name}”` : ''}`;
    const prev = r.ruleKey ? current?.rules.find((p) => p.ruleKey === r.ruleKey) : null;
    const { rule, problems, reshuffles: moves } = checkRule(r, flag, fields, { isBase, prev, allowReshuffle });
    reshuffles ||= moves;
    if (seen.has(rule.ruleKey)) problems.push('duplicate ruleKey');
    seen.add(rule.ruleKey);
    if (rule.locked && sawUnlocked) problems.push('overrides must come before other rules');
    if (!rule.locked) sawUnlocked = true;
    for (const p of problems) errors.push(`${where}: ${p}`);
    layer.rules.push(rule);
  });
  return { layer, errors, reshuffles };
}

// ---- a whole flag ------------------------------------------------------------------------------

export type PlacedLayer = { environment: string; entity: string | null; layer: Layer };

// The flag setup check: every stored layer of a flag, checked as if the flag were `flag` (e.g. after a
// kind change). A layer save checks its one layer with checkLayer; a change to the flag itself checks
// them all here, so it can't leave a layer behind that no longer saves unchanged.
export function checkFlagSetup(flag: FlagFacts, fields: FieldFacts, layers: PlacedLayer[]): string[] {
  const errors: string[] = [];
  for (const { environment, entity, layer } of layers) {
    const doc: LayerDoc = { enabled: layer.enabled, variationWhenOff: layer.variationWhenOff, defaultVariation: layer.defaultVariation, inherit: layer.inherit, rules: layer.rules };
    for (const e of checkLayer(flag, fields, entity === null, doc, layer).errors) errors.push(`${environment} · ${entity ?? 'everyone'} · ${e}`);
  }
  return errors;
}
