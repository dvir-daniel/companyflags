// Every attribute a rule can check, in one list: what it is, how the console shows it (its group, label and known
// values) and, for what the server works out itself, how its value is found. The database copy is brought up to date
// at every start (syncFields), so adding an attribute here needs no migration.
// Pure: the evaluator, the server and the console all import it (the console gets the group, label and known values
// through /meta, fieldInfo).
//
// comes_from: 'key' (the link or API key), 'token' (the entity: from the app's link, or named by a backend within its
// key's scope): both worked out on the server; 'sdk' (what the app reports about itself, in OpenFeature's evaluation
// context, or checked on the device against the app file): never read from request headers, so a cached file can't
// vary by User-Agent.
//
// Besides this list, the installation's own attributes come from its dimensions (dimensions.ts): one per dimension,
// named by its key ("store"), whose value is the asker's entity at that level, and `entity`, the asker itself.

import type { Queryable } from './db.ts';
import type { EntityInfo } from './evaluator.ts';
import { ENTITY_FIELD, capital, joined, type Dimensions } from './dimensions.ts';

/** The rule editor's groups of attributes, in its order. DIMENSION_GROUP is labelled with the dimension names. */
export const DIMENSION_GROUP = 'Dimensions';
export const FIELD_GROUPS = ['App', 'Device', 'OS', 'Browser', 'Place and language', DIMENSION_GROUP] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];
/** A group's name in the editor: the dimension names for theirs ("Company and brand"). */
export const groupLabel = (g: FieldGroup, dims: Dimensions) => (g === DIMENSION_GROUP ? joined(dims, 'and') || g : g);

/** The values the editor suggests: a short fixed list apps report, or one of the console's own lists (its apps,
 *  environments, every entity, or one dimension's entities). */
export type KnownValues = readonly string[] | 'apps' | 'environments' | 'entities' | { dimension: string };

/** The app, while an answer is for any app of the entity (the entity page): a check on it waits for the request. */
export const ANY_APP: unique symbol = Symbol('any app');
/** A dimension below the asker's own: the server knows there's no entity there (not "missing": an override doesn't
 *  match it as if the app hadn't sent something). */
export const NONE: unique symbol = Symbol('none');
/** Who is asking, as the server knows it: from the link or API key, and its entity (null: none, before login).
 *  `dimensions`: the installation's dimension keys, top to bottom. */
export type Asker = { environment: string; project: string | typeof ANY_APP; entity: EntityInfo | null; dimensions: readonly string[] };

type About = {
  name: string;
  valueType: 'string' | 'string_set' | 'semver' | 'int';
  canSplitBy: boolean;
  /** where the rule editor offers it; null: not offered (every rule already sits in one environment) */
  group: FieldGroup | null;
  label: string;
  knownValues?: KnownValues;
  description: string;
};
export type FieldDef = About & (
  | { comesFrom: 'sdk' }
  // the server works it out from who is asking (only `project` can find ANY_APP: the app isn't known yet)
  | { comesFrom: 'key' | 'token'; resolve: (who: Asker) => unknown }
);

export const FIELDS: FieldDef[] = [
  // the app (which app is calling comes from the API key: `project`)
  { name: 'project', valueType: 'string', comesFrom: 'key', canSplitBy: false, group: 'App', label: 'App', knownValues: 'apps',
    resolve: (who) => who.project, description: 'Which app or backend is asking: from its link or API key' },
  { name: 'environment', valueType: 'string', comesFrom: 'key', canSplitBy: false, group: null, label: 'Environment', knownValues: 'environments',
    resolve: (who) => who.environment, description: 'From the link or API key' },
  { name: 'app.version', valueType: 'semver', comesFrom: 'sdk', canSplitBy: false, group: 'App', label: 'App version', description: 'App marketing version, compared as semver' },
  { name: 'app.build', valueType: 'int', comesFrom: 'sdk', canSplitBy: false, group: 'App', label: 'App build number', description: 'Build number, compared as an integer' },
  { name: 'app.channel', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'App', label: 'Install channel',
    knownValues: ['store', 'testflight', 'beta', 'dev'], description: 'Where the build was installed from' },
  // the device
  { name: 'device.platform', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Device', label: 'Platform',
    knownValues: ['android', 'ios', 'web', 'macos', 'windows'], description: 'What the app runs on' },
  { name: 'device.type', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Device', label: 'Device type',
    knownValues: ['phone', 'tablet', 'desktop', 'tv', 'watch'], description: 'The kind of device' },
  { name: 'device.manufacturer', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Device', label: 'Manufacturer', description: 'Apple, Samsung, Google… (Android Build.MANUFACTURER)' },
  { name: 'device.model', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Device', label: 'Device model', description: 'iPhone16,2 / SM-S921B / Pixel 9, as the app reports it' },
  { name: 'device.memory_class', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Device', label: 'Memory class',
    knownValues: ['low', 'normal'], description: 'Android isLowRamDevice, browser deviceMemory' },
  // who, for % of devices
  { name: 'device.id', valueType: 'string', comesFrom: 'sdk', canSplitBy: true, group: 'Device', label: 'Device ID', description: 'An ID the app keeps for the install (OpenFeature’s targetingKey)' },
  { name: 'session.id', valueType: 'string', comesFrom: 'sdk', canSplitBy: true, group: 'Device', label: 'Session ID', description: 'Per-session id (not sticky across sessions)' },
  // the operating system
  { name: 'device.os', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'OS', label: 'OS',
    knownValues: ['android', 'ios', 'ipados', 'macos', 'windows', 'linux', 'chromeos'], description: 'The operating system' },
  { name: 'device.os_version', valueType: 'semver', comesFrom: 'sdk', canSplitBy: false, group: 'OS', label: 'OS version', description: 'OS version, compared as a version' },
  { name: 'device.api_level', valueType: 'int', comesFrom: 'sdk', canSplitBy: false, group: 'OS', label: 'Android API level', description: 'Android API level (Build.VERSION.SDK_INT), e.g. 35' },
  // the browser (web apps)
  { name: 'device.browser', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Browser', label: 'Browser',
    knownValues: ['chrome', 'safari', 'firefox', 'edge', 'samsung'], description: 'The browser a web app runs in, as the app reports it' },
  { name: 'device.browser_version', valueType: 'semver', comesFrom: 'sdk', canSplitBy: false, group: 'Browser', label: 'Browser version', description: 'Browser version, compared as a version (the major is always reliable)' },
  { name: 'device.browser_engine', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Browser', label: 'Browser engine',
    knownValues: ['blink', 'webkit', 'gecko'], description: 'The browser’s engine' },
  // place and language
  { name: 'geo.country', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Place and language', label: 'Country', description: 'Two-letter country (US, CA), as the app or your backend reports it' },
  { name: 'locale.language', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Place and language', label: 'Language', description: 'Device language, e.g. en, es' },
  { name: 'locale.timezone', valueType: 'string', comesFrom: 'sdk', canSplitBy: false, group: 'Place and language', label: 'Time zone', description: 'Device time zone, e.g. America/Los_Angeles' },
];

const BY_NAME = new Map(FIELDS.map((f) => [f.name, f]));
const RESOLVERS = new Map(FIELDS.flatMap((f) => (f.comesFrom === 'sdk' ? [] : [[f.name, f.resolve] as const])));

// The attributes of the customer model before dimensions (migration 0013 rewrote live rules to `entity` and
// `company`). History and change sets from before keep them, so they still read and apply exactly as they did.
//   customer.id       the customer itself, at whatever level: `entity`
//   customer.company  a brand's company, else the customer itself: the entity at the top of its chain
export const ALIASES: Readonly<Record<string, string>> = { 'customer.id': ENTITY_FIELD, 'customer.company': '<top>' };

type Resolve = (who: Asker) => unknown;
const entityKey: Resolve = (who) => who.entity?.key;
const topKey: Resolve = (who) => (who.entity ? who.entity.path[who.entity.path.length - 1] : undefined);
const dimensionResolvers = new Map<string, Resolve>();
const atDimension = (key: string): Resolve => {
  let r = dimensionResolvers.get(key);
  if (!r) dimensionResolvers.set(key, (r = (who) => (who.entity ? (Object.hasOwn(who.entity.at, key) ? who.entity.at[key] : NONE) : undefined)));
  return r;
};

export const fieldOf = (name: string): FieldDef | undefined => BY_NAME.get(name);
/** How the server finds this attribute's value from who is asking; undefined for what the app reports. `dimensions`:
 *  the installation's dimension keys. */
export function resolverFor(name: string, dimensions: readonly string[]): Resolve | undefined {
  const r = RESOLVERS.get(name);
  if (r) return r;
  if (name === ENTITY_FIELD || name === 'customer.id') return entityKey;
  if (name === 'customer.company') return topKey;
  return dimensions.includes(name) ? atDimension(name) : undefined;
}
/** Whether the app reports this attribute: not what the server works out itself, nor an attribute whose stored copy
 *  says it comes from the link or key (the dimensions, `entity`, the aliases, and any taken off this list). */
export const reportedByApp = (name: string, stored: { comesFrom: string }) => !RESOLVERS.has(name) && stored.comesFrom === 'sdk';
/** Whether the attribute's values are entity keys ("Store is acme-12", "Company is Globex"). */
export const namesEntities = (name: string, dimensions: readonly string[]) =>
  name === ENTITY_FIELD || Object.hasOwn(ALIASES, name) || dimensions.includes(name);

// ---- the console ----------------------------------------------------------------------------

/** What /meta sends about an attribute: its stored row, with the group, label and known values of its entry here.
 *  An attribute taken off this list has no group: the editor doesn't offer it for new checks. */
export type FieldInfo = {
  name: string; valueType: string; comesFrom: string; canSplitBy: boolean; description: string;
  group: FieldGroup | null; label: string; knownValues?: KnownValues;
};
/** The label, group and known values of an attribute from the dimensions: "Store", "Company or brand" (`entity`, offered
 *  only with more than one dimension), and the aliases (never offered: they read as what they stand for). */
export function dimensionField(name: string, dims: Dimensions): Pick<FieldInfo, 'group' | 'label' | 'knownValues'> | null {
  const d = dims.find((x) => x.key === name);
  if (d) return { group: DIMENSION_GROUP, label: capital(d.singular), knownValues: { dimension: d.key } };
  if (name === ENTITY_FIELD || name === 'customer.id') {
    return { group: name === ENTITY_FIELD && dims.length > 1 ? DIMENSION_GROUP : null, label: joined(dims, 'or') || name, knownValues: 'entities' };
  }
  if (name === 'customer.company') {
    const top = dims[0];
    return { group: null, label: top ? capital(top.singular) : name, knownValues: top ? { dimension: top.key } : 'entities' };
  }
  return null;
}
export function fieldInfo(row: Omit<FieldInfo, 'group' | 'label' | 'knownValues'>, dims: Dimensions = []): FieldInfo {
  const fromDims = dimensionField(row.name, dims);
  if (fromDims) return { ...row, ...fromDims };
  const f = BY_NAME.get(row.name);
  return { ...row, group: f?.group ?? null, label: f?.label ?? row.name, ...(f?.knownValues ? { knownValues: f.knownValues } : {}) };
}

/** The rule editor's attribute groups: in FIELD_GROUPS order, each with its attributes in this list's order. */
export function groupFields<F extends { name: string; group: FieldGroup | null }>(fields: readonly F[], dims: Dimensions = []): [FieldGroup, F[]][] {
  // the dimensions' attributes in the chain's order, top first, then `entity`
  const at = (f: F) => {
    const i = FIELDS.indexOf(BY_NAME.get(f.name)!);
    if (i >= 0) return i;
    const d = dims.findIndex((x) => x.key === f.name);
    return FIELDS.length + (d >= 0 ? d : dims.length);
  };
  return FIELD_GROUPS.map((g) => [g, fields.filter((f) => f.group === g).sort((a, b) => at(a) - at(b))] as [FieldGroup, F[]])
    .filter(([, fs]) => fs.length > 0);
}

/** The values the editor suggests for an attribute: its fixed list, or the console's apps, environments, every entity
 *  or one dimension's entities. */
export function suggestedValues(f: { knownValues?: KnownValues } | undefined,
  lists: { apps: string[]; environments: string[]; entities: { key: string; dimension: string }[] }): string[] {
  const v = f?.knownValues;
  if (v === 'apps') return lists.apps;
  if (v === 'environments') return lists.environments;
  if (v === 'entities') return lists.entities.map((c) => c.key);
  if (v && typeof v === 'object' && 'dimension' in v) return lists.entities.filter((c) => c.dimension === v.dimension).map((c) => c.key);
  return v ? [...(v as readonly string[])] : [];
}

// ---- the database copy ----------------------------------------------------------------------

// Fields taken off this list stay in the database: existing rules may still use them.
export async function syncFields(q: Queryable) {
  for (const f of FIELDS) {
    await q.query(`insert into condition_field (name, value_type, comes_from, can_split_by, description) values ($1,$2,$3,$4,$5)
      on conflict (name) do update set value_type = excluded.value_type, comes_from = excluded.comes_from,
        can_split_by = excluded.can_split_by, description = excluded.description`,
      [f.name, f.valueType, f.comesFrom, f.canSplitBy, f.description]);
  }
}
