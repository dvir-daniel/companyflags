// flagd JSON for backends (GET /sdk/v1/flagd/<dimension>/<entity>): one entity's flags as a flagd flag set
// (https://flagd.dev/reference/flag-definitions/), for flagd itself or an OpenFeature flagd provider evaluating in-process.
//
// It is built the way an app's file is (clientFile.ts): forEntity settles everything the server knows for every
// request of this backend (the environment, the app, the entity and those above it), and what's left depends on the
// request. Each of those lines becomes one branch of a flat JsonLogic "if"; the entity's answer is the last branch:
//
//   { "if": [ <line 1's checks>, "<variant>", <line 2's checks>, "<variant>", …, <the answer when none applies> ] }
//
// What carries over exactly (test/flagd.test.ts evaluates the JSON and compares it with our evaluator):
// - The order: overrides, the entity's rules, those of each entity above it, rules for everyone, then the most
//   specific default.
// - Checks on missing values: a missing value never matches a rule, except an override's ("fails closed", M4).
// - % of devices: flagd's `fractional` with the bucketing value {"cat": ["<salt>/", <device ID>]} and weights out of
//   10000 is our hash version 2 (hash.ts), so a device is in the same group here as on the server and in the apps.
// - "Use the default in the app's code": a branch returns null with no defaultVariant, so the SDK uses its own default.
//   A flag switched off is flagd's DISABLED, which does the same.
//
// What doesn't:
// - Reasons: flagd says TARGETING_MATCH for any branch (a % too, not SPLIT), DEFAULT for no branch, STATIC with no
//   rules. A flag whose rules can serve the app's default has its own default as the last branch (TARGETING_MATCH).
// - Group names of a % (metadata.group in our answers): flagd has nowhere to put them.
// - For an override, a value that is there but can't be read (a version like "abc") matches on our server and not in
//   flagd. Versions compare the same when written in full (6.0.0).
//
// The request's attributes are nested, as JsonLogic reads "app.version": { "app": { "version": "6.0.0" } }.

import { BUCKETS, HASH_VERSION } from './hash.ts';
import { CODE_DEFAULT, HIDDEN_PREFIX, forEntity, sortedFlagKeys, type AnswerException, type Condition, type EntityInfo, type FlagDef, type Op, type Snapshot, type Where } from './evaluator.ts';

export const FLAGD_SCHEMA = 'https://flagd.dev/schema/v0/flags.json';

type Logic = unknown;
export type FlagdFlag = { state: 'ENABLED' | 'DISABLED'; variants: Record<string, unknown>; defaultVariant: string | null; targeting?: Logic };
export type FlagdDoc = {
  $schema: string;
  metadata: { flagSetId: string; environment: string; revision: number };
  flags: Record<string, FlagdFlag>;
};

/** The flag set id of one entity's flags in one environment: `<environment>/<entity>` (flagd's `selector` picks it). */
export const flagSetId = (environment: string, entity: string | null) => (entity ? `${environment}/${entity}` : environment);

/** One backend's flags for one entity (`entity` null: what it gets with no entity), as flagd JSON. */
export function buildFlagdDoc(snap: Snapshot, project: string, entity: EntityInfo | null): FlagdDoc {
  const flags: Record<string, FlagdFlag> = {};
  for (const key of sortedFlagKeys(snap)) {
    const f = compileFlag(snap.flags[key], snap, project, entity);
    if (f) flags[key] = f;
  }
  return { $schema: FLAGD_SCHEMA, metadata: { flagSetId: flagSetId(snap.environment, entity?.key ?? null), environment: snap.environment, revision: snap.revision }, flags };
}

function compileFlag(flag: FlagDef, where: Where, project: string, entity: EntityInfo | null): FlagdFlag | null {
  if (!flag.delivery.includes(project)) return null;                 // not sent to this backend: FLAG_NOT_FOUND
  const a = forEntity(flag, where, entity, { project });
  if (a.gets.section === 'not_sent') return null;
  const variants: Record<string, unknown> = {};
  // a variant's name in the JSON (and its value in `variants`); null: the app's own default
  const name = (v: string): string | null => {
    if (v === CODE_DEFAULT) return null;
    variants[v] = flag.variations[v];
    return v;
  };
  if (a.gets.section === 'off') return { state: 'DISABLED', variants: anyVariant(flag), defaultVariant: null };

  const lines = a.exceptions.map((e) => [lineCheck(e), name(e.variant)] as const);
  const fallback = name(a.gets.variant);
  // targeting null means "use defaultVariant": with a branch that serves the app's default, that has to be null,
  // so the entity's answer becomes the last branch instead
  const codeDefaultBranch = lines.some(([, v]) => v === null);
  const flagd: FlagdFlag = {
    state: 'ENABLED',
    variants,
    defaultVariant: codeDefaultBranch ? null : fallback,
    ...(lines.length ? { targeting: { if: [...lines.flat(), codeDefaultBranch ? fallback : null] } } : {}),
  };
  if (!Object.keys(variants).length) flagd.variants = anyVariant(flag);   // flagd needs one: every answer is the app's default
  return flagd;
}

/** A variant for a flag that never serves one: the first that isn't a typed-in value (one entity's may be private).
 *  A flag with free values may have none: a placeholder of its type, never served. */
const UNUSED: Record<FlagDef['valueType'], unknown> = { bool: false, string: '', number: 0, json: {} };
function anyVariant(flag: FlagDef): Record<string, unknown> {
  const k = Object.keys(flag.variations).filter((v) => v !== CODE_DEFAULT && !v.startsWith(HIDDEN_PREFIX)).sort()[0];
  return k ? { [k]: flag.variations[k] } : { unused: UNUSED[flag.valueType] };
}

const and = (parts: Logic[]): Logic => (parts.length === 0 ? true : parts.length === 1 ? parts[0] : { and: parts });
const or = (parts: Logic[]): Logic => (parts.length === 1 ? parts[0] : { or: parts });
const missing = (field: string): Logic => ({ missing: [field] });
const present = (field: string): Logic => ({ '!': missing(field) });

/** When one line applies: its checks, and for a % of devices, the device inside its part. */
function lineCheck(e: AnswerException): Logic {
  const parts = e.when.map((c) => check(c, e.locked));
  if (e.split) {
    const s = e.split;
    if (s.hashVersion !== HASH_VERSION) throw new Error(`a % of devices with hash_version ${s.hashVersion} can’t be written as flagd JSON (only ${HASH_VERSION})`);
    // the device ID, or the backup ID when there's none (answerFor)
    const unit = s.fallbackBy ? { if: [present(s.by), { var: s.by }, { var: s.fallbackBy }] } : { var: s.by };
    parts.push(s.fallbackBy ? or([present(s.by), present(s.fallbackBy)]) : present(s.by));
    const { from, to } = s.range;
    const entries = [...(from > 0 ? [['out', from]] : []), ['in', to - from], ...(to < BUCKETS ? [['out', BUCKETS - to]] : [])];
    parts.push({ '==': [{ fractional: [{ cat: [`${s.salt}/`, unit] }, ...entries] }, 'in'] });
  }
  return and(parts);
}

const SEMVER: Partial<Record<Op, string>> = { semver_lt: '<', semver_lte: '<=', semver_gt: '>', semver_gte: '>=', semver_eq: '=' };
const NUMBER: Partial<Record<Op, string>> = { lt: '<', lte: '<=', gt: '>', gte: '>=' };

/** One check as JsonLogic. A missing value never matches (testCondition's null), except in an override (M4). */
function check(c: Condition, locked: boolean): Logic {
  if (c.op === 'exists') return present(c.field);
  if (c.op === 'missing') return missing(c.field);
  const value = { var: c.field };
  const text = { cat: [value] };                       // "is one of" compares as text, as testCondition does
  const values = c.values ?? [];
  let test: Logic;
  switch (c.op) {
    case 'in': test = { in: [text, values.map(String)] }; break;
    case 'not_in': test = { '!': { in: [text, values.map(String)] } }; break;
    case 'contains_any': test = { some: [value, { in: [{ var: '' }, values] }] }; break;
    case 'contains_none': test = { none: [value, { in: [{ var: '' }, values] }] }; break;
    case 'starts_with': case 'ends_with': test = or(values.map((v) => ({ [c.op]: [text, String(v)] }))); break;
    default:
      if (SEMVER[c.op]) test = { sem_ver: [value, SEMVER[c.op], String(values[0])] };
      else if (NUMBER[c.op]) test = { [NUMBER[c.op]!]: [value, Number(values[0])] };
      else throw new Error(`no flagd JSON for the check "${c.op}"`);
  }
  return locked ? { or: [missing(c.field), test] } : { and: [present(c.field), test] };
}
