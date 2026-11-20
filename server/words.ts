import type { DecidedBy, Inherit, LevelName, Section } from './evaluator.ts';
import { dimensionField, fieldOf, namesEntities } from './fields.ts';
import type { Dimensions } from './dimensions.ts';

// A condition as people type it: the comparison may not be a known one yet.
export type ConditionLike = { field: string; op: string; values?: (string | number)[] };

/** What a sentence needs from the installation: its dimensions (the attribute names "Store", "Company or brand"), and
 *  how to name an entity from its key. */
export type Vocab = { dimensions: Dimensions; nameOf?: (key: string) => string | undefined };

// ---- attributes and comparisons -------------------------------------------------------------

/** An attribute's name in the console: a dimension's ("Store"), its label in fields.ts ("App version"), or the name
 *  itself for one taken off the list. */
export const fieldLabel = (f: string, dims: Dimensions = []) => dimensionField(f, dims)?.label ?? fieldOf(f)?.label ?? f;
// Which comparisons each attribute type allows, in the order the editor offers them.
export const OPS_BY_TYPE: Record<string, { op: string; label: string }[]> = {
  string: [{ op: 'in', label: 'is' }, { op: 'not_in', label: 'is not' }, { op: 'starts_with', label: 'starts with' },
    { op: 'ends_with', label: 'ends with' }, { op: 'exists', label: 'is set' }, { op: 'missing', label: 'is not set' }],
  string_set: [{ op: 'contains_any', label: 'include' }, { op: 'contains_none', label: 'don’t include' },
    { op: 'exists', label: 'is set' }, { op: 'missing', label: 'is not set' }],
  semver: [{ op: 'semver_lt', label: 'is below' }, { op: 'semver_lte', label: 'is at most' }, { op: 'semver_gt', label: 'is above' },
    { op: 'semver_gte', label: 'is at least' }, { op: 'semver_eq', label: 'is exactly' }, { op: 'exists', label: 'is set' }, { op: 'missing', label: 'is not set' }],
  int: [{ op: 'lt', label: 'is below' }, { op: 'lte', label: 'is at most' }, { op: 'gt', label: 'is above' }, { op: 'gte', label: 'is at least' },
    { op: 'in', label: 'is' }, { op: 'not_in', label: 'is not' }, { op: 'exists', label: 'is set' }, { op: 'missing', label: 'is not set' }],
};
export const opLabel = (op: string) => Object.values(OPS_BY_TYPE).flat().find((o) => o.op === op)?.label ?? op;
export const noValueOp = (op: string) => op === 'exists' || op === 'missing';

// "App version is below 5.0.0", "Store is Acme 12 or Acme 14". `vocab.nameOf` turns entity keys into names.
export function conditionText(c: ConditionLike, vocab?: Vocab): string {
  const dims = vocab?.dimensions ?? [];
  const label = fieldLabel(c.field, dims);
  if (noValueOp(c.op)) return `${label} ${opLabel(c.op)}`;
  const names = vocab?.nameOf && namesEntities(c.field, dims.map((d) => d.key));
  const vals = (c.values ?? []).map((v) => (names ? vocab!.nameOf!(String(v)) ?? String(v) : String(v)));
  return `${label} ${opLabel(c.op)} ${vals.join(' or ') || '…'}`;
}

/** What a % is a share of, from the attribute it splits by: "devices" (device ID), "sessions" (session ID), a
 *  dimension's plural ("stores"), else "<attribute> values". */
export function splitUnit(by: string | null | undefined, dims: Dimensions = []): string {
  if (!by || by === 'device.id') return 'devices';
  if (by === 'session.id') return 'sessions';
  const d = dims.find((x) => x.key === by);
  return d ? d.plural.toLocaleLowerCase() : `${fieldLabel(by, dims)} values`;
}

// A whole "when": every check, plus the % (of devices, or of what `by` names). Empty means every request.
export function whenText(cs: ConditionLike[], opts: { percent?: number | null; by?: string | null; vocab?: Vocab; empty?: string } = {}): string {
  const parts = cs.map((c) => conditionText(c, opts.vocab));
  if (opts.percent != null) parts.push(`${+opts.percent.toFixed(2)}% of ${splitUnit(opts.by, opts.vocab?.dimensions)}`);
  return parts.join(' and ') || (opts.empty ?? 'every request');
}

// ---- who the words are about ----------------------------------------------------------------

/** An entity, as the sentences below name it: its name, and the entities above it, its parent first. */
export type EntityWords = { key: string; name: string; above: { key: string; name: string }[] };
/** `lookup` gives an entity's name and parent by key (the server's snapshot, the console's list). */
export function entityWords(key: string, lookup: (key: string) => { name: string; parent?: string | null } | undefined): EntityWords | null {
  const me = lookup(key);
  if (!me) return null;
  const above: { key: string; name: string }[] = [];
  for (let p = me.parent ?? null; p && above.length < 3 && p !== key && !above.some((a) => a.key === p);) {
    const x = lookup(p);
    above.push({ key: p, name: x?.name ?? p });
    p = x?.parent ?? null;
  }
  return { key, name: me.name, above };
}
/** The name of whoever's settings these are: the entity itself or one above it. */
export const ownerName = (who: EntityWords | null | undefined, owner: string | null | undefined) =>
  !owner ? undefined : who?.key === owner ? who.name : who?.above.find((a) => a.key === owner)?.name;
/** "Acme", "Acme and EU", "Acme, EU and Europe". */
const listed = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// ---- an entity's three choices --------------------------------------------------------------
// How an entity's own settings combine with the rest (flag_layer.inherit; the order is server/evaluator.ts entityChain).
// Each name says what happens once the entity's own rules don't match. The identifiers are stored and sent (webhooks,
// the API, flags as code), so they stay; only the names people read changed.

export const CHOICES: Inherit[] = ['base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only'];
export const CHOICE_NAME: Record<Inherit, string> = {
  base_rules_then_base_default: 'Follow what’s above',
  base_rules_then_customer_default: 'Own default last',
  customer_only: 'Skip what’s above',
};

/** What a choice does. With the entity, the text names those above it ("everything Acme gets"); without, the general text. */
export function choiceText(choice: Inherit, who?: EntityWords | null): string {
  const parent = who?.above[0]?.name;
  const above = who ? listed(who.above.map((a) => `${a.name}’s`)) : '';
  const own = who ? `${who.name}’s` : 'Its';
  const owns = who ? `${who.name}’s` : 'its';
  switch (choice) {
    case 'base_rules_then_base_default':
      return `${own} rules come first. If none match, ${!who ? 'it gets what it would get with no settings of its own: what the level above it gets, or at the top the same as everyone'
        : parent ? `it gets what ${parent} gets` : 'it gets the same as everyone'}.`;
    case 'base_rules_then_customer_default':
      return `${own} rules come first, then ${!who ? 'the rules of the levels above it and ' : above ? `${above} rules and ` : ''}the rules for everyone, then ${owns} own default.`;
    case 'customer_only':
      return `Only ${owns} rules and default count. ${!who ? 'The settings of the levels above it and the rules' : above ? `${above} settings and the rules` : 'The rules'} for everyone are skipped; overrides for everyone still apply.`;
  }
}

// ---- with nothing of its own ----------------------------------------------------------------
// An entity with no settings on a flag follows the next level of its chain: its parent, or at the top everyone.

/** What it gets then: "what Acme gets" for an entity under Acme, "the same as everyone" at the top. */
export const withoutOwn = (who?: EntityWords | null) => (who?.above[0] ? `what ${who.above[0].name} gets` : 'the same as everyone');
/** The sentence: "gets what Acme gets", "gets the same as everyone". */
export const getsWithoutOwn = (who?: EntityWords | null) => `gets ${withoutOwn(who)}`;
/** The short form, for a cell or a button: "Same as Acme", "Same as everyone". */
export const sameAs = (who?: EntityWords | null) => `Same as ${who?.above[0]?.name ?? 'everyone'}`;

// ---- what decided the answer ----------------------------------------------------------------

/** Which level of the entity chain a section belongs to (null: nothing in the chain decided). */
export const LEVEL_OF: Record<Section, LevelName | null> = {
  not_sent: null, off: null, override: 'override',
  entity_rule: 'entity', entity_default: 'entity',
  everyone_rule: 'everyone', default: 'everyone',
};
export const levelOf = (s: Section) => LEVEL_OF[s];

export const SECTION_LABEL: Record<Section, string> = {
  not_sent: 'Not sent',
  off: 'Flag is off',
  override: 'Override',
  entity_rule: 'Own rule',
  entity_default: 'Own default',
  everyone_rule: 'Rule for everyone',
  default: 'Default',
};

// The trace's steps, named like the sections above.
export const STAGE_LABEL: Record<string, string> = {
  delivery: 'In this service?', enabled: 'Flag on?', locked: SECTION_LABEL.override, entity: SECTION_LABEL.entity_rule,
  entity_default: SECTION_LABEL.entity_default, base: SECTION_LABEL.everyone_rule, default: SECTION_LABEL.default,
};

// "Own rule · % of devices", or with the entity: "Acme 12’s rule", "Rule naming Acme 12", and for settings it
// follows from above: "Acme’s rule". `nameOf` names an owner the entity words don't know.
export function sourceText(d: DecidedBy, opts: { entity?: EntityWords | null; nameOf?: (key: string) => string | undefined; project?: string; byDevice?: boolean } = {}): string {
  const who = opts.entity?.name;
  const owner = d.owner ? ownerName(opts.entity, d.owner) ?? opts.nameOf?.(d.owner) ?? d.owner : undefined;
  let s: string;
  switch (d.section) {
    case 'not_sent': s = opts.project ? `Not in ${opts.project}` : SECTION_LABEL.not_sent; break;
    case 'entity_rule': s = owner ? `${owner}’s rule` : SECTION_LABEL.entity_rule; break;
    case 'entity_default': s = owner ? `${owner}’s default` : SECTION_LABEL.entity_default; break;
    case 'everyone_rule': s = who && d.namesEntity ? `Rule naming ${who}` : SECTION_LABEL.everyone_rule; break;
    default: s = SECTION_LABEL[d.section];
  }
  return opts.byDevice ? `${s} · % of devices` : s;
}
