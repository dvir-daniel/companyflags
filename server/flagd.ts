// flagd JSON: one entity's flags in one service as a flagd flag set (https://flagd.dev/reference/flag-definitions/), for
// flagd itself or an OpenFeature flagd provider evaluating in-process. Backends get it with an API key
// (GET /sdk/v1/flagd/<dimension>/<entity>); apps get the same document as their CDN file, at their app link
// (GET /cdn/v1/flags/<env>/<service>/<entity>/<secret>, or /cdn/v1/flags/<env>/<service> before sign-in: no entity).
// A backend shared by many entities can read one document for all of them instead (buildServiceDoc, below:
// GET /sdk/v1/flagd/service). All are served by delivery.ts.
//
// forEntity settles everything the server knows for every request of this service (the environment, the service, the
// entity and those above it), so no other entity is named and none of their values is in it; what's left depends on the
// request. Each of those lines becomes one branch of a flat JsonLogic "if"; the entity's answer is the last branch:
//
//   { "if": [ <line 1's checks>, "<variant>", <line 2's checks>, "<variant>", …, <the answer when none applies> ] }
//
// What carries over exactly (test/flagd.test.ts evaluates the JSON and compares it with our evaluator):
// - The order: overrides, the entity's rules, those of each entity above it, rules for everyone, then the most
//   specific default.
// - Checks on missing values: a missing value never matches a rule, except an override's ("fails closed"). Missing is
//   absent, null or "", as on the server, written {"in": [{"var": …}, [null, ""]]}: JsonLogic's own `missing` differs
//   between flagd's languages (json-logic-engine, which flagd's JavaScript uses, counts "" and null as there).
// - % of devices: flagd's `fractional` with the bucketing value {"cat": ["<salt>/", <device ID>]} and weights out of
//   10000 is our hash version 2 (hash.ts), so a device is in the same group here as on the server and in the apps.
//   The device ID is `device.id`, else OpenFeature's `targetingKey` (at the root of flagd's context), as OFREP reads
//   it (ofrep.ts); then the backup ID, if the rule has one.
// - Versions in rules are written in full (6 → 6.0.0, fullVersion): strict semver readers refuse short ones.
// - "Use the default in the app's code": a branch returns null with no defaultVariant, so the SDK uses its own default.
//   A flag switched off is flagd's DISABLED, which does the same. Its one variant (flagd needs one) is a placeholder,
//   {"unused": <a value of its type>}, never one of the flag's values: those may be meant for one entity only.
//
// What doesn't:
// - Reasons: flagd says TARGETING_MATCH for any branch (a % too, not SPLIT), DEFAULT for no branch, STATIC with no
//   rules. A flag whose rules can serve the app's default has its own default as the last branch (TARGETING_MATCH).
// - Group names of a % (metadata.group in our answers): flagd has nowhere to put them.
// - For an override, a value that is there but can't be read (a version like "abc") matches on our server and not in
//   flagd. The server reads a few versions flagd doesn't (6-beta, 01.0.0, V6.0.0 in some languages) and flagd reads a
//   number (6) the server doesn't: devices report full versions (6.0.0) as text.
//
// The request's attributes are nested, as JsonLogic reads "app.version": { "app": { "version": "6.0.0" } }.

import { BUCKETS, HASH_VERSION } from './hash.ts';
import { fullVersion } from './semver.ts';
import { CODE_DEFAULT, forEntity, sortedFlagKeys, type AnswerException, type Condition, type EntityInfo, type FlagDef, type Op, type Snapshot, type Where } from './evaluator.ts';

export const FLAGD_SCHEMA = 'https://flagd.dev/schema/v0/flags.json';

type Logic = unknown;
export type FlagdFlag = { state: 'ENABLED' | 'DISABLED'; variants: Record<string, unknown>; defaultVariant: string | null; targeting?: Logic };
export type FlagdDoc = {
  $schema: string;
  metadata: { flagSetId: string; environment: string; revision: number };
  /** flagd's shared evaluators, which a flag's targeting names by {"$ref": "<name>"}: only the document for many
   *  entities has one, UNKNOWN_ENTITY (buildServiceDoc). */
  $evaluators?: Record<string, Logic>;
  flags: Record<string, FlagdFlag>;
};

/** flagd's id for one entity's flags in one environment and service: `<environment>/<service>/<entity>`, or
 *  `<environment>/<service>` with no entity (flagd's `selector` picks it). */
export const flagSetId = (environment: string, service: string, entity: string | null) =>
  (entity ? `${environment}/${service}/${entity}` : `${environment}/${service}`);

/** One service's flags for one entity (`entity` null: what it gets with no entity), as flagd JSON. */
export function buildFlagdDoc(snap: Snapshot, project: string, entity: EntityInfo | null): FlagdDoc {
  const flags: Record<string, FlagdFlag> = {};
  for (const key of sortedFlagKeys(snap)) {
    const f = compileFlag(snap.flags[key], snap, project, entity);
    if (f) flags[key] = f;
  }
  return { $schema: FLAGD_SCHEMA, metadata: { flagSetId: flagSetId(snap.environment, project, entity?.key ?? null), environment: snap.environment, revision: snap.revision }, flags };
}

/** One entity's answer for a flag: the lines that depend on the request, each with its variant, then the entity's
 *  answer (a variant's name; null: the app's default). The variants it names are added to `variants`. */
type EntityLogic = { lines: (readonly [Logic, string | null])[]; fallback: string | null };
function entityLogic(flag: FlagDef, where: Where, project: string, entity: EntityInfo | null, variants: Record<string, unknown>): EntityLogic | 'not_sent' | 'off' {
  const a = forEntity(flag, where, entity, { project });
  if (a.gets.section === 'not_sent') return 'not_sent';
  if (a.gets.section === 'off') return 'off';
  // a variant's name in the JSON (and its value in `variants`); null: the app's own default
  const name = (v: string): string | null => {
    if (v === CODE_DEFAULT) return null;
    variants[v] = flag.variations[v];
    return v;
  };
  return { lines: a.exceptions.map((e) => [lineCheck(e), name(e.variant)] as const), fallback: name(a.gets.variant) };
}
const servesCodeDefault = (l: EntityLogic) => l.fallback === null || l.lines.some(([, v]) => v === null);

function compileFlag(flag: FlagDef, where: Where, project: string, entity: EntityInfo | null): FlagdFlag | null {
  if (!flag.delivery.includes(project)) return null;                 // not sent to this backend: FLAG_NOT_FOUND
  const variants: Record<string, unknown> = {};
  const l = entityLogic(flag, where, project, entity, variants);
  if (l === 'not_sent') return null;
  if (l === 'off') return switchedOff(flag);
  const { lines, fallback } = l;
  // targeting null means "use defaultVariant": with a branch that serves the app's default, that has to be null,
  // so the entity's answer becomes the last branch instead
  const codeDefaultBranch = lines.some(([, v]) => v === null);
  const flagd: FlagdFlag = {
    state: 'ENABLED',
    variants,
    defaultVariant: codeDefaultBranch ? null : fallback,
    ...(lines.length ? { targeting: { if: [...lines.flat(), codeDefaultBranch ? fallback : null] } } : {}),
  };
  if (!Object.keys(variants).length) flagd.variants = placeholder(flag);   // flagd needs one: every answer is the app's default
  return flagd;
}

// ---------------------------------------------------------------- one document for many entities
// A backend shared by many entities reads one document for its service (GET /sdk/v1/flagd/service, with a secret key
// for `all` entities or `below` one) instead of one per entity, so one flagd serves it. Each flag's targeting first
// refuses what OFREP refuses, then picks the entity by the dimension keys the request names, as rules name them
// ({"brand": "lumen"}), and runs that entity's own logic, the same as in its own document:
//
//   { "if": [ {"$ref": "unknown_entity"}, null,                         what OFREP refuses: the app's code default
//             <brand is "bolt" or "lumen">, <their logic>,              the lowest dimension first
//             <company is "globex">, <its logic>, …,
//             <the logic when the request names none of them> ] }
//
// The last branch is what a request naming no entity gets: no entity for an `all` key, the key's own entity for a
// `below` key, as over OFREP. Entities with the same logic share a branch. One whose logic is the last branch's, as
// is that of every entity above it in the document, has none: a request naming any of them gets the same.
// The lowest dimension the request names decides, as over OFREP.
//
// Where OFREP refuses a request (400 INVALID_CONTEXT, so the provider gives the code's defaults), every flag here gives
// the code default too: an entity the document doesn't hold (outside the key's reach, or added since this document),
// a chain that doesn't match ({"company": "acme", "brand": "lumen"} when Lumen is Globex's), and a dimension that is
// "". That check is one shared evaluator (flagd's $evaluators, unknownEntity below), so the keys are written once per
// document. Keys are compared as text, as OFREP reads them: {"brand": 12} is the entity "12". One difference: flagd
// can't tell a dimension that is null from one that is absent, so {"brand": null} asks as no entity here, where OFREP
// refuses it.

/** The flagSetId of a service's one document for many entities: `<environment>/<service>`. */
export const serviceFlagSetId = (environment: string, service: string) => `${environment}/${service}`;

/** The name of the service document's shared evaluator for what OFREP refuses (flagd's $evaluators). */
export const UNKNOWN_ENTITY = 'unknown_entity';

/** One service's flags for many entities as one flagd document. `entities`: those it holds (the ones the key may
 *  ask about); `fallback`: who a request that names none of them asks as (null: no entity, for an `all` key). */
export function buildServiceDoc(snap: Snapshot, project: string, entities: readonly EntityInfo[], fallback: EntityInfo | null): FlagdDoc {
  const flags: Record<string, FlagdFlag> = {};
  const held = new Set(entities.map((e) => e.key));
  // the lowest dimension first, each one's entities by key
  const byDimension = [...snap.dimensions].reverse().map((d) => entities.filter((e) => e.dimension === d).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)));
  const asLogic = (l: EntityLogic): Logic => (l.lines.length ? { if: [...l.lines.flat(), l.fallback] } : l.fallback);
  const refuses = snap.dimensions.length > 0;
  for (const key of sortedFlagKeys(snap)) {
    const flag = snap.flags[key];
    if (!flag.delivery.includes(project)) continue;                  // not sent to this backend: FLAG_NOT_FOUND
    const variants: Record<string, unknown> = {};
    const last = entityLogic(flag, snap, project, fallback, variants);
    if (last === 'not_sent') continue;
    if (last === 'off') { flags[key] = switchedOff(flag); continue; }
    const lastJson = JSON.stringify(asLogic(last));
    let codeDefault = servesCodeDefault(last);
    const logic = new Map<string, { json: string; logic: Logic }>();
    for (const e of entities) {
      const l = entityLogic(flag, snap, project, e, variants);
      if (typeof l === 'string') continue;                          // not sent, or off: the same for every entity
      if (servesCodeDefault(l)) codeDefault = true;
      const lg = asLogic(l);
      logic.set(e.key, { json: JSON.stringify(lg), logic: lg });
    }
    const branchOf = new Map<string, boolean>();
    const needsBranch = (e: EntityInfo): boolean => {
      let v = branchOf.get(e.key);
      if (v === undefined) {
        const parent = e.parent && held.has(e.parent) ? snap.entities[e.parent] : undefined;
        v = logic.get(e.key)?.json !== lastJson || (!!parent && needsBranch(parent));
        branchOf.set(e.key, v);
      }
      return v;
    };
    const branches: Logic[] = [];
    for (const [i, list] of byDimension.entries()) {
      const dimension = snap.dimensions[snap.dimensions.length - 1 - i];
      const groups = new Map<string, { logic: Logic; keys: string[] }>();
      for (const e of list) {
        const l = logic.get(e.key);
        if (!l || !needsBranch(e)) continue;
        const g = groups.get(l.json);
        if (g) g.keys.push(e.key); else groups.set(l.json, { logic: l.logic, keys: [e.key] });
      }
      for (const g of groups.values()) branches.push(isOneOf(dimension, g.keys), g.logic);
    }
    if (!branches.length && !refuses) {
      // every entity gets what the last branch says: written as that entity's (or no entity's) own document has it
      flags[key] = compileFlag(flag, snap, project, fallback)!;
      continue;
    }
    // no branch is null unless it serves the app's default or refuses the request: defaultVariant is null then
    flags[key] = {
      state: 'ENABLED', variants, defaultVariant: codeDefault || refuses ? null : Object.keys(variants).sort()[0],
      targeting: { if: [...(refuses ? [{ $ref: UNKNOWN_ENTITY }, null] : []), ...branches, asLogic(last)] },
    };
    if (!Object.keys(variants).length) flags[key].variants = placeholder(flag);
  }
  return {
    $schema: FLAGD_SCHEMA,
    metadata: { flagSetId: serviceFlagSetId(snap.environment, project), environment: snap.environment, revision: snap.revision },
    ...(refuses ? { $evaluators: { [UNKNOWN_ENTITY]: unknownEntity(snap.dimensions, entities) } } : {}),
    flags,
  };
}

/** What OFREP refuses (askingEntity, ofrep.ts) as one check on the dimensions a request names, for a document that
 *  holds `entities`: a dimension that is "", a key it doesn't hold as the lowest one named (an entity above one it holds
 *  may only be named with it), and a chain that isn't the held entity's. */
function unknownEntity(dimensions: readonly string[], entities: readonly EntityInfo[]): Logic {
  const held = new Set(entities.map((e) => e.key));
  const sorted = (keys: Iterable<string>) => [...new Set(keys)].sort();
  const parts: Logic[] = [];
  dimensions.forEach((d, i) => {
    const here = entities.filter((e) => e.dimension === d);
    const lower = dimensions.slice(i + 1);
    const above = sorted(entities.flatMap((e) => (lower.includes(e.dimension) && Object.hasOwn(e.at, d) && !held.has(e.at[d]) ? [e.at[d]] : [])));
    parts.push({ in: [{ var: d }, ['']] });
    parts.push(and([present(d), { '!': { in: [asText(d), sorted([...here.map((e) => e.key), ...above])] } }]));
    if (above.length) parts.push(and([isOneOf(d, above), ...lower.map(missing)]));
    // the chain: each held entity of this dimension, against the one above it in each dimension above ("": none there)
    for (const up of dimensions.slice(0, i)) {
      const byParent = new Map<string, string[]>();
      for (const e of here) {
        const p = Object.hasOwn(e.at, up) ? e.at[up] : '';
        byParent.set(p, [...(byParent.get(p) ?? []), e.key]);
      }
      for (const p of sorted(byParent.keys())) {
        parts.push(and([isOneOf(d, sorted(byParent.get(p)!)), present(up), ...(p ? [{ '!': { in: [asText(up), [p]] } }] : [])]));
      }
    }
  });
  return or(parts);
}

/** A switched-off flag: flagd's DISABLED, so the app uses the default in its code. */
const switchedOff = (flag: FlagDef): FlagdFlag => ({ state: 'DISABLED', variants: placeholder(flag), defaultVariant: null });

/** The variants of a flag that never serves one (switched off, or every answer is the app's default): flagd needs one,
 *  so a placeholder of the flag's type, never served. Never one of the flag's own values: a variant named for one
 *  entity ("globex") may be meant for it alone, and this document may be another entity's, or everyone's. */
const UNUSED: Record<FlagDef['valueType'], unknown> = { bool: false, string: '', number: 0, json: {} };
const placeholder = (flag: FlagDef): Record<string, unknown> => ({ unused: UNUSED[flag.valueType] });

const and = (parts: Logic[]): Logic => (parts.length === 0 ? true : parts.length === 1 ? parts[0] : { and: parts });
const or = (parts: Logic[]): Logic => (parts.length === 1 ? parts[0] : { or: parts });
/** Absent, null or "": the server's missing (evaluator.ts isMissing), the same in every JsonLogic. */
const missing = (field: string): Logic => ({ in: [{ var: field }, [null, '']] });
const present = (field: string): Logic => ({ '!': missing(field) });
/** The value as text, as the server compares it ("is one of", an entity's key): 12 is "12". */
const asText = (field: string): Logic => ({ cat: [{ var: field }] });
/** The value is there and, as text, one of `keys` (JsonLogic's cat writes an absent value differently in each language). */
const isOneOf = (field: string, keys: readonly string[]): Logic => and([present(field), { in: [asText(field), keys] }]);

/** OpenFeature's targeting key: OFREP reads it as the device ID when there's no device.id (ofrep.ts). */
const TARGETING_KEY = 'targetingKey';

/** When one line applies: its checks, and for a % of devices, the device inside its part. */
function lineCheck(e: AnswerException): Logic {
  const parts = e.when.map((c) => check(c, e.locked));
  if (e.split) {
    const s = e.split;
    if (s.hashVersion !== HASH_VERSION) throw new Error(`a % of devices with hash_version ${s.hashVersion} can’t be written as flagd JSON (only ${HASH_VERSION})`);
    // the first of: the ID it is by, the backup ID when there's none (evalRule); the device ID is device.id, else the
    // targeting key
    const ids = [s.by, ...(s.fallbackBy ? [s.fallbackBy] : [])].flatMap((f) => (f === 'device.id' ? [f, TARGETING_KEY] : [f]));
    const last = ids[ids.length - 1];
    const unit = ids.length === 1 ? { var: last } : { if: [...ids.slice(0, -1).flatMap((f) => [present(f), { var: f }]), { var: last }] };
    parts.push(or(ids.map(present)));
    const { from, to } = s.range;
    const entries = [...(from > 0 ? [['out', from]] : []), ['in', to - from], ...(to < BUCKETS ? [['out', BUCKETS - to]] : [])];
    parts.push({ '==': [{ fractional: [{ cat: [`${s.salt}/`, unit] }, ...entries] }, 'in'] });
  }
  return and(parts);
}

const SEMVER: Partial<Record<Op, string>> = { semver_lt: '<', semver_lte: '<=', semver_gt: '>', semver_gte: '>=', semver_eq: '=' };
const NUMBER: Partial<Record<Op, string>> = { lt: '<', lte: '<=', gt: '>', gte: '>=' };

/** One check as JsonLogic. A missing value never matches (testCondition's null), except in an override. */
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
      if (SEMVER[c.op]) test = { sem_ver: [value, SEMVER[c.op], fullVersion(String(values[0])) ?? String(values[0])] };
      else if (NUMBER[c.op]) test = { [NUMBER[c.op]!]: [value, Number(values[0])] };
      else throw new Error(`no flagd JSON for the check "${c.op}"`);
  }
  return locked ? { or: [missing(c.field), test] } : { and: [present(c.field), test] };
}
