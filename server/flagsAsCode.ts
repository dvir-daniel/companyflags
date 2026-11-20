// Flags as code (the CLI's `flags pull`, `flags plan` and `flags push`, cli.ts): the flags a codebase uses, written in
// a JSON file next to it, and kept in step with CompanyFlags.
//
//   {
//     "$schema": "https://dvir-daniel.github.io/companyflags/flags.schema.json",
//     "source": "acme/web",
//     "owns": ["name", "description", "owner", "variants", "default"],
//     "scope": { "prefix": "checkout_" },
//     "flags": {
//       "checkout_new": {
//         "name": "New checkout", "kind": "release", "type": "bool", "removeBy": "2027-02-17",
//         "variants": { "on": true, "off": false }, "default": "off"
//       }
//     }
//   }
//
// The file says what flags exist and what they are. Their rules stay in the console, where each change is reviewed
// where it must be. What the file owns:
// - `owns`: the fields it decides, for every flag in it. Each flag's key, kind and type always. Without `owns`, the
//   flag's definition (DEFINITION: its details, variants and default); `services` only when listed. A field the file
//   doesn't own can't be in it, so a reader of the file never takes a field for what's served when it isn't.
// - `scope`: the flags it may touch, for a server shared by several repositories. `prefix`: keys that start with it.
//   `services`: flags in these services only. A push refuses a flag outside it, and only lists the flags in it.
// - `source`: a name for the file ("acme/web"). A flag one file manages can't be pushed by a file with another name.
//
// Each push records what the file last applied to each flag (flag_managed, migration 0020). The console shows
// "Managed in repo" on those flags, with the fields the file owns: an edit there to one of them is undone by the next
// push. The plan says so on each step that undoes one ("changed outside this file since its last push").
//
// A push goes through the same functions the console does (control.ts, layers.ts), so every check holds; in an
// environment that needs approval, a change of services or of the default becomes a request there, as in the
// console. A request already open for the same change is reused, never filed again: the plan shows it as waiting. A
// flag that is only in CompanyFlags is listed and left as it is: archiving one is done in the console.

import { all, HttpError, one, type Db } from './db.ts';
import { CODE_DEFAULT, HIDDEN_PREFIX } from './evaluator.ts';
import { createFlag, setDelivery, updateFlagMeta, upsertVariations, type NewFlag } from './control.ts';
import { applyItems, canonical, createChangeSet, type Actor, type Item, type LayerDoc } from './layers.ts';
import { audit } from './journal.ts';
import { loadLayers } from './snapshot.ts';
import { needsReview } from './policy.ts';
import { schemaProblem, type JsonSchema } from './jsonSchema.ts';

export type ValueType = 'bool' | 'string' | 'number' | 'json';
export const FLAG_KINDS = ['release', 'kill_switch', 'ops', 'experiment', 'config', 'permission'] as const;
export const VALUE_TYPES: readonly ValueType[] = ['bool', 'string', 'number', 'json'];
/** Where the file's JSON Schema is published (docs/public/flags.schema.json; each server also serves its own at
 *  /flags.schema.json). `flags pull` writes it as the file's `$schema`. */
export const FLAGS_SCHEMA_URL = 'https://dvir-daniel.github.io/companyflags/flags.schema.json';

/** The fields a file can own. A flag's key, kind and type are always the file's. */
export const OWNABLE = ['name', 'description', 'owner', 'tags', 'removeBy', 'variants', 'freeValues', 'jsonSchema', 'default', 'services'] as const;
export type Owned = (typeof OWNABLE)[number];
/** What a file owns when it has no `owns`: what each flag is. Its services and rules stay in the console. */
export const DEFINITION: readonly Owned[] = OWNABLE.filter((f) => f !== 'services');
const SPEC_FIELDS = ['kind', 'type', ...OWNABLE] as const;
const FILE_FIELDS = ['$schema', 'source', 'owns', 'scope', 'flags'] as const;
const KEY = /^[a-z][a-z0-9_]*$/;

export type FlagSpec = {
  name?: string | null;
  description?: string | null;
  owner?: string | null;
  kind: string;
  type: ValueType;
  tags?: string[];
  /** YYYY-MM-DD: release and experiment flags need one */
  removeBy?: string | null;
  /** variant → value. An on/off flag has on: true and off: false when left out. */
  variants?: Record<string, unknown>;
  /** values typed into the rules instead of named variants (not for on/off flags) */
  freeValues?: boolean;
  /** a JSON flag's JSON Schema (jsonSchema.ts): every variant must match it. null removes it. */
  jsonSchema?: JsonSchema | null;
  /** the variant everyone gets when no rule decides, in every environment */
  default?: string;
  /** environment → the services it is in */
  services?: Record<string, string[]>;
};
export type Scope = { prefix?: string; services?: string[] };
export type FlagsFile = { $schema?: string; source?: string; owns?: Owned[]; scope?: Scope; flags: Record<string, FlagSpec> };

type Flagged = { flag: string; environment: string; before: string; after: string; reviewed: boolean };
export type Step = (
  | { do: 'create'; flag: string; spec: FlagSpec }
  | { do: 'details'; flag: string; fields: string[]; spec: FlagSpec }
  | { do: 'variants'; flag: string; variants: { key: string; value: unknown }[]; added: string[]; changed: string[] }
  | { do: 'services'; flag: string; environment: string; before: string[]; after: string[]; reviewed: boolean }
  | ({ do: 'default' } & Flagged)
) & {
  /** an open request that already makes this change: the push reuses it */
  request?: number;
  /** the server's value changed outside this file since its last push: the push undoes that change */
  overwrites?: boolean;
};
/** An open request (in review, approved or scheduled) on one of the file's flags. */
export type Waiting = { request: number; environment: string; flag: string; reason: string | null };
export type Plan = {
  steps: Step[];
  unchanged: string[];
  /** flags in CompanyFlags (in the file's scope) that the file doesn't have: left as they are */
  onlyHere: string[];
  /** what's wrong with the file: nothing is pushed while there is any */
  problems: string[];
  /** the open requests on the file's flags that no step reuses */
  waiting: Waiting[];
  /** the file's name and, per flag, the fields it owns (recorded by the push) */
  source: string | null;
  managed: Record<string, string[]>;
};
/** A plan has changes when a step does something new (a step waiting in its request doesn't). */
export const hasChanges = (plan: Plan) => plan.steps.some((s) => !s.request);

type Here = {
  key: string; name: string | null; description: string | null; owner: string | null; kind: string; type: ValueType;
  tags: string[]; removeBy: string | null; freeValues: boolean; jsonSchema: JsonSchema | null; variants: Record<string, unknown>;
  services: Record<string, string[]>;
  /** environment → the variant its defaults serve when no rule decides */
  defaults: Record<string, string | null>;
};

/** Every flag that isn't archived, as the file writes it. */
export async function readFlags(db: Db): Promise<Here[]> {
  const flags = await all<{ id: string; key: string; name: string | null; description: string | null; owner: string | null; kind: string;
    value_type: ValueType; tags: string[]; remove_by: string | null; free_values: boolean; json_schema: JsonSchema | null }>(db,
    `select id, key, name, description, owner, kind, value_type, tags, remove_by::text as remove_by, free_values, json_schema
       from flag where archived_at is null order by key`);
  const variants = await all<{ flag_id: string; key: string; value: unknown }>(db,
    `select flag_id, key, value from flag_variation where not is_code_default order by id`);
  const delivery = await all<{ flag_id: string; env: string; set: string }>(db,
    `select d.flag_id, e.key as env, p.key as set from flag_delivery d join environment e on e.id = d.environment_id
       join project p on p.id = d.project_id order by e.id, p.id`);
  const defaults = await all<{ flag_id: string; env: string; variant: string | null }>(db,
    `select l.flag_id, e.key as env, v.key as variant from flag_layer l join environment e on e.id = l.environment_id
       left join flag_variation v on v.id = l.default_variation_id where l.entity_id is null`);
  const envs = (await all<{ key: string }>(db, `select key from environment order by id`)).map((e) => e.key);
  return flags.map((f) => ({
    key: f.key, name: f.name, description: f.description, owner: f.owner, kind: f.kind, type: f.value_type,
    tags: f.tags ?? [], removeBy: f.remove_by, freeValues: f.free_values, jsonSchema: f.json_schema ?? null,
    variants: Object.fromEntries(variants.filter((v) => v.flag_id === f.id && !v.key.startsWith(HIDDEN_PREFIX)).map((v) => [v.key, v.value])),
    services: Object.fromEntries(envs.map((e) => [e, delivery.filter((d) => d.flag_id === f.id && d.env === e).map((d) => d.set)])),
    defaults: Object.fromEntries(defaults.filter((d) => d.flag_id === f.id).map((d) => [d.env, d.variant])),
  }));
}

/** The one default every environment serves, or undefined: when they differ, or it is a typed value or the app's own
 *  default (the file names variants). A release's default is left out: the console moves it as the release goes on. */
const oneDefault = (h: Here) => {
  const values = [...new Set(Object.values(h.defaults))];
  return h.kind !== 'release' && values.length === 1 && values[0] && values[0] !== CODE_DEFAULT && !values[0].startsWith(HIDDEN_PREFIX) ? values[0] : undefined;
};

/** The file for what CompanyFlags has now (`flags pull`): every flag, every field (narrowFile keeps a file's own). */
export async function pullFlags(db: Db): Promise<FlagsFile> {
  const flags: Record<string, FlagSpec> = {};
  for (const f of await readFlags(db)) {
    const def = oneDefault(f);
    flags[f.key] = {
      ...(f.name ? { name: f.name } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.owner ? { owner: f.owner } : {}),
      kind: f.kind,
      type: f.type,
      ...(f.tags.length ? { tags: f.tags } : {}),
      ...(f.removeBy ? { removeBy: f.removeBy } : {}),
      ...(f.freeValues ? { freeValues: true } : {}),
      ...(f.jsonSchema ? { jsonSchema: f.jsonSchema } : {}),
      ...(Object.keys(f.variants).length && !(f.type === 'bool' && isOnOff(f.variants)) ? { variants: f.variants } : {}),
      ...(def ? { default: def } : {}),
      services: f.services,
    };
  }
  return { $schema: FLAGS_SCHEMA_URL, owns: [...OWNABLE], flags };
}

/** A pulled file as a file with this name, these fields and this scope keeps it: the flags in its scope, and only the
 *  fields it owns. `owns` left out: every field (a first pull, which then lists them all). */
export function narrowFile(file: FlagsFile, to: { source?: string; owns?: Owned[]; scope?: Scope }): FlagsFile {
  const owns = to.owns ?? [...OWNABLE];
  const flags: Record<string, FlagSpec> = {};
  for (const [key, s] of Object.entries(file.flags)) {
    if (!belongs(to.scope, key, s.services ?? {})) continue;
    flags[key] = Object.fromEntries(Object.entries(s).filter(([f]) => f === 'kind' || f === 'type' || owns.includes(f as Owned))) as FlagSpec;
  }
  return { $schema: FLAGS_SCHEMA_URL, ...(to.source ? { source: to.source } : {}), owns, ...(to.scope ? { scope: to.scope } : {}), flags };
}

/** The services, in any environment, that a flag is in outside the scope. */
const outsideServices = (scope: Scope | undefined, services: Record<string, string[]>) =>
  scope?.services ? [...new Set(Object.values(services).flat())].filter((s) => !scope.services!.includes(s)).sort() : [];
/** Whether a flag is the scope's own: its key has the prefix, and it is in the scope's services and no others. */
export function belongs(scope: Scope | undefined, key: string, services: Record<string, string[]>): boolean {
  if (!scope) return true;
  if (scope.prefix && !key.startsWith(scope.prefix)) return false;
  if (!scope.services) return true;
  return Object.values(services).flat().length > 0 && !outsideServices(scope, services).length;
}

const isOnOff = (v: Record<string, unknown>) => Object.keys(v).length === 2 && v.on === true && v.off === false;
const variantsOf = (s: FlagSpec): Record<string, unknown> => s.variants ?? (s.type === 'bool' && !s.freeValues ? { on: true, off: false } : {});
const sameList = (a: string[], b: string[]) => canonical([...a].sort()) === canonical([...b].sort());

/** What the file owns of a flag, as the server has it: what the push records, and what the next plan compares. */
function ownedState(h: Here, fields: readonly string[]): Record<string, unknown> {
  const all: Record<string, unknown> = {
    name: h.name, description: h.description, owner: h.owner, kind: h.kind, tags: [...h.tags].sort(), removeBy: h.removeBy,
    variants: h.variants, freeValues: h.freeValues, jsonSchema: h.jsonSchema, default: h.defaults,
    services: Object.fromEntries(Object.entries(h.services).map(([e, l]) => [e, [...l].sort()])),
  };
  return Object.fromEntries(['kind', ...fields].map((f) => [f, all[f]]));
}

/** Each managed flag's last-applied record: the file's name, and what it owned of the flag as the server had it. */
const managedRecords = async (db: Db) => new Map((await all<{ key: string; source: string | null; applied: Record<string, unknown> }>(db,
  `select f.key, m.source, m.applied from flag_managed m join flag f on f.id = m.flag_id`)).map((m) => [m.key, { source: m.source, applied: m.applied }]));

type Open = Waiting & { kind: 'layer' | 'delivery'; items: number; base: boolean; projects?: string[]; defaultVariation?: string | null };
/** The open requests on these flags. */
async function openRequests(db: Db, flags: string[]): Promise<Open[]> {
  if (!flags.length) return [];
  const rows = await all<{ id: number; environment: string; flag: string; reason: string | null; kind: 'layer' | 'delivery'; items: number;
    base: boolean; proposed: { projects?: string[]; doc?: LayerDoc | null } | null }>(db,
    `select cs.id::int as id, e.key as environment, f.key as flag, cs.reason, i.kind, i.entity_id is null as base, i.proposed,
       (select count(*) from change_set_item j where j.change_set_id = cs.id)::int as items
     from change_set cs join change_set_item i on i.change_set_id = cs.id join flag f on f.id = i.flag_id
       join environment e on e.id = cs.environment_id
     where cs.status in ('in_review', 'approved', 'scheduled') and f.key = any($1::text[])
     order by cs.id, i.seq`, [flags]);
  return rows.map((r) => ({ request: r.id, environment: r.environment, flag: r.flag, reason: r.reason, kind: r.kind, items: r.items, base: r.base,
    projects: r.proposed?.projects, defaultVariation: r.proposed?.doc?.defaultVariation }));
}

/** What a push would do (`flags plan`), and what's wrong with the file, against what CompanyFlags has now. */
export async function planFlags(db: Db, file: unknown): Promise<Plan> {
  const problems: string[] = [];
  const f = readFile(file, problems);
  const spec = f.flags;
  const here = new Map((await readFlags(db)).map((h) => [h.key, h]));
  const records = await managedRecords(db);
  const open = await openRequests(db, Object.keys(spec).filter((k) => here.has(k)));
  const envs = await all<{ key: string; minApprovals: number }>(db, `select key, min_approvals as "minApprovals" from environment order by id`);
  const sets = new Set((await all<{ key: string }>(db, `select key from project`)).map((p) => p.key));
  const reviewed = new Set(envs.filter(needsReview).map((e) => e.key));
  const steps: Step[] = [];
  const unchanged: string[] = [];
  const managed: Record<string, string[]> = {};
  const used = new Set<number>();
  /** the open request that makes exactly this change, if any */
  const reuse = (match: (o: Open) => boolean) => {
    const o = open.find((r) => r.items === 1 && match(r));
    if (o) used.add(o.request);
    return o ? { request: o.request } : {};
  };

  for (const [key, s] of Object.entries(spec)) {
    for (const [env, list] of Object.entries(s.services ?? {})) {
      if (!envs.some((e) => e.key === env)) problems.push(`${key}: no environment "${env}" (services)`);
      for (const k of list) if (!sets.has(k)) problems.push(`${key}: no service "${k}" (services.${env})`);
    }
    if (f.scope?.prefix && !key.startsWith(f.scope.prefix)) problems.push(`${key}: outside this file’s scope: its keys start with "${f.scope.prefix}"`);
    const outside = outsideServices(f.scope, s.services ?? {});
    if (outside.length) problems.push(`${key}: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside this file’s scope (services: ${f.scope!.services!.join(', ')})`);
    managed[key] = f.owns.filter((o) => s[o] !== undefined);
    const h = here.get(key);
    if (!h) {
      if (s.freeValues) problems.push(`${key}: a flag with free values is made in the console (its first value is typed in there)`);
      else if (!Object.keys(variantsOf(s)).length) problems.push(`${key}: a new flag needs its variants`);
      if (s.default !== undefined && !(s.default in variantsOf(s))) problems.push(`${key}: default "${s.default}" isn’t one of its variants`);
      steps.push({ do: 'create', flag: key, spec: s });
      continue;
    }
    const rec = records.get(key);
    if (rec?.source && rec.source !== (f.source ?? null)) problems.push(`${key}: the file "${rec.source}" manages it: a flag is managed by one file`);
    const theirs = outsideServices(f.scope, h.services);
    if (theirs.length) problems.push(`${key}: it is also in ${theirs.join(', ')}, outside this file’s scope: another file or the console owns it`);
    const now = ownedState(h, OWNABLE);
    /** whether the server's value of a field (in one environment) moved since the file last applied it */
    const moved = (field: string, env?: string) => {
      const was = rec?.applied;
      if (!was || !(field in was)) return false;
      const pick = (v: unknown) => (env ? (v as Record<string, unknown> | null)?.[env] ?? null : v);
      return canonical(pick(was[field])) !== canonical(pick(now[field]));
    };
    const overwrites = (yes: boolean) => (yes ? { overwrites: true } : {});
    const before = steps.length;
    if (h.type !== s.type) problems.push(`${key}: its type is ${h.type} here; a flag’s type can’t change (make a new flag)`);
    const fields = (['name', 'description', 'owner', 'kind', 'removeBy', 'freeValues'] as const)
      .filter((k) => s[k] !== undefined && (s[k] ?? null) !== (k === 'freeValues' ? h.freeValues : h[k] ?? null)) as string[];
    if (s.tags !== undefined && !sameList(s.tags, h.tags)) fields.push('tags');
    if (s.jsonSchema !== undefined && canonical(s.jsonSchema ?? null) !== canonical(h.jsonSchema)) fields.push('jsonSchema');
    if (fields.length) steps.push({ do: 'details', flag: key, fields, spec: s, ...overwrites(fields.some((k) => moved(k))) });
    const want = variantsOf(s);
    const gone = Object.keys(h.variants).filter((v) => !(v in want));
    if (s.variants && gone.length) problems.push(`${key}: ${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} here but not in the file; removing variants is done in the console`);
    const added = Object.keys(want).filter((v) => !(v in h.variants));
    const changed = Object.keys(want).filter((v) => v in h.variants && canonical(h.variants[v]) !== canonical(want[v]));
    if (added.length || changed.length) {
      steps.push({ do: 'variants', flag: key, variants: [...added, ...changed].map((v) => ({ key: v, value: want[v] })), added, changed,
        ...overwrites(moved('variants')) });
    }
    for (const [env, list] of Object.entries(s.services ?? {})) {
      const was = h.services[env] ?? [];
      if (!sameList(was, list)) {
        const r = reviewed.has(env);
        steps.push({ do: 'services', flag: key, environment: env, before: was, after: list, reviewed: r, ...overwrites(moved('services', env)),
          ...(r ? reuse((o) => o.kind === 'delivery' && o.flag === key && o.environment === env && sameList(o.projects ?? [], list)) : {}) });
      }
    }
    if (s.default !== undefined) {
      if (h.freeValues) problems.push(`${key}: a flag with free values has its default typed in the console`);
      else if (!(s.default in { ...h.variants, ...want })) problems.push(`${key}: default "${s.default}" isn’t one of its variants`);
      else {
        for (const e of envs) {
          const was = h.defaults[e.key];
          if (was === undefined || was === s.default) continue;
          const r = reviewed.has(e.key);
          steps.push({ do: 'default', flag: key, environment: e.key, before: was ?? '', after: s.default, reviewed: r, ...overwrites(moved('default', e.key)),
            ...(r ? reuse((o) => o.kind === 'layer' && o.base && o.flag === key && o.environment === e.key && o.defaultVariation === s.default) : {}) });
        }
      }
    }
    if (steps.length === before) unchanged.push(key);
  }
  const onlyHere = [...here.values()].filter((h) => !(h.key in spec) && belongs(f.scope, h.key, h.services)).map((h) => h.key);
  const waiting = open.filter((o) => !used.has(o.request)).filter((o, i, l) => l.findIndex((x) => x.request === o.request) === i)
    .map(({ request, environment, flag, reason }) => ({ request, environment, flag, reason }));
  return { steps, unchanged, onlyHere, problems, waiting, source: f.source ?? null, managed };
}

type Read = { flags: Record<string, FlagSpec>; owns: Owned[]; scope?: Scope; source?: string };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The file, checked for its form; what's wrong goes in `problems`. */
function readFile(file: unknown, problems: string[]): Read {
  const flags = (file as FlagsFile | null)?.flags;
  if (!isObject(file) || !isObject(flags)) {
    problems.push('the file needs a "flags" object: { "flags": { "<key>": { "kind": …, "type": … } } }');
    return { flags: {}, owns: [...DEFINITION] };
  }
  for (const k of Object.keys(file)) if (!(FILE_FIELDS as readonly string[]).includes(k)) problems.push(`"${k}" isn’t a field of the file: ${FILE_FIELDS.join(', ')}`);
  const f = file as FlagsFile;
  let owns: Owned[] = [...DEFINITION];
  if (f.owns !== undefined) {
    if (!Array.isArray(f.owns) || f.owns.some((o) => !OWNABLE.includes(o))) problems.push(`owns is a list of fields: ${OWNABLE.join(', ')}`);
    else owns = [...new Set(f.owns)];
  }
  if (f.source !== undefined && (typeof f.source !== 'string' || !f.source.trim() || f.source.length > 200)) problems.push('source is a name for the file, e.g. "acme/web" (up to 200 characters)');
  let scope: Scope | undefined;
  if (f.scope !== undefined) {
    const sc = f.scope as Scope;
    if (!isObject(sc) || Object.keys(sc).some((k) => k !== 'prefix' && k !== 'services') || (sc.prefix === undefined && sc.services === undefined)) {
      problems.push('scope is { "prefix": "<the start of its keys>" } or { "services": ["<service>", …] }, or both');
    } else {
      if (sc.prefix !== undefined && (typeof sc.prefix !== 'string' || !KEY.test(sc.prefix))) problems.push('scope.prefix is the start of a flag key, e.g. "checkout_"');
      if (sc.services !== undefined && (!Array.isArray(sc.services) || !sc.services.length || sc.services.some((x) => typeof x !== 'string'))) {
        problems.push('scope.services is a list of service keys');
      }
      scope = sc;
    }
  }
  for (const [key, s] of Object.entries(flags as Record<string, FlagSpec>)) {
    if (!KEY.test(key)) problems.push(`${key}: flag keys use lowercase letters, digits and _, starting with a letter`);
    if (!isObject(s)) { problems.push(`${key}: not an object`); continue; }
    for (const k of Object.keys(s)) {
      if (!(SPEC_FIELDS as readonly string[]).includes(k)) problems.push(`${key}: "${k}" isn’t a field of a flag: ${SPEC_FIELDS.join(', ')}`);
      else if (k !== 'kind' && k !== 'type' && !owns.includes(k as Owned)) problems.push(`${key}: ${k} is in the file, but the file doesn’t own it: add "${k}" to "owns", or take it out`);
    }
    if (!FLAG_KINDS.includes(s.kind as never)) problems.push(`${key}: kind is one of ${FLAG_KINDS.join(', ')}`);
    if (!VALUE_TYPES.includes(s.type)) problems.push(`${key}: type is one of ${VALUE_TYPES.join(', ')}`);
    if (s.variants !== undefined && !isObject(s.variants)) problems.push(`${key}: variants is an object, variant → value`);
    if (s.services !== undefined && (!isObject(s.services)
      || Object.values(s.services).some((l) => !Array.isArray(l) || l.some((x) => typeof x !== 'string')))) {
      problems.push(`${key}: services is an object, environment → a list of service keys`);
    }
    if (s.default !== undefined && typeof s.default !== 'string') problems.push(`${key}: default is the key of a variant`);
    if (s.jsonSchema !== undefined && s.jsonSchema !== null) {
      if (s.type !== 'json') problems.push(`${key}: only JSON flags have a jsonSchema`);
      else {
        const p = schemaProblem(s.jsonSchema);
        if (p) problems.push(`${key}: jsonSchema: ${p}`);
      }
    }
  }
  return { flags: flags as Record<string, FlagSpec>, owns, scope, source: typeof f.source === 'string' ? f.source.trim() : undefined };
}

export type Done = { step: Step; result: 'done' | 'request'; request?: number; reused?: boolean };
/** Why a push was made, for the requests it files and History: `--reason`, and the pull request or commit (`--link`). */
export type PushNote = { reason?: string | null; link?: string | null };
export const NOTE_MAX = 500;
/** What's wrong with a note, or null. */
export function noteProblem(n: PushNote): string | null {
  if (n.reason != null && (typeof n.reason !== 'string' || n.reason.length > NOTE_MAX)) return `the reason is text, up to ${NOTE_MAX} characters`;
  if (n.link != null && (typeof n.link !== 'string' || n.link.length > NOTE_MAX || !/^https?:\/\/\S+$/.test(n.link))) return 'the link is an http or https address';
  return null;
}

/** Applies a plan (`flags push`), step by step, as `actor`. It stops at the first step CompanyFlags refuses, with
 *  what was done before it (each step is its own change, as in the console). Then it records what the file applied
 *  to each flag it finished, and the push in History, with the note. */
export async function pushFlags(db: Db, plan: Plan, actor: Actor, note: PushNote = {}): Promise<Done[]> {
  if (plan.problems.length) throw new Error(`the file has problems:\n${plan.problems.map((p) => `  ${p}`).join('\n')}`);
  const problem = noteProblem(note);
  if (problem) throw new HttpError(422, problem);
  const envs = (await all<{ key: string }>(db, `select key from environment order by id`)).map((e) => e.key);
  const why = (step: Step) => `${note.reason?.trim() || 'flags push'}: ${what(step)}${note.link ? ` (${note.link})` : ''}`;
  const done: Done[] = [];
  let stopped: { error: Error; left: Set<string> } | null = null;
  for (const [i, step] of plan.steps.entries()) {
    try {
      done.push(await apply(db, step, envs, actor, why(step)));
    } catch (e) {
      const err = new Error(`${describe(step)}: ${(e as Error).message}`, { cause: e }) as Error & { done: Done[] };
      err.done = done;
      stopped = { error: err, left: new Set(plan.steps.slice(i).map((s) => s.flag)) };
      break;
    }
  }
  await remember(db, plan, actor, stopped?.left ?? new Set());
  if (done.length) {
    await audit(db, actor, { kind: 'flags.push', comment: [note.reason?.trim(), note.link].filter(Boolean).join(' · ') || null,
      after: { source: plan.source, link: note.link ?? null, steps: done.map((d) => `${what(d.step)}${d.result === 'request' ? ` (request #${d.request})` : ''}`) } });
  }
  if (stopped) throw stopped.error;
  return done;
}

/** The last-applied record of each flag the push finished: what the file owns of it, as the server has it now. A
 *  flag the file no longer has (in its scope) is no longer managed by it. */
async function remember(db: Db, plan: Plan, actor: Actor, left: Set<string>) {
  const here = new Map((await readFlags(db)).map((h) => [h.key, h]));
  for (const [key, fields] of Object.entries(plan.managed)) {
    const h = here.get(key);
    if (!h || left.has(key)) continue;
    await db.query(`insert into flag_managed (flag_id, source, fields, applied, applied_by)
      select id, $2, $3, $4, $5 from flag where key = $1
      on conflict (flag_id) do update set source = excluded.source, fields = excluded.fields, applied = excluded.applied,
        applied_at = now(), applied_by = excluded.applied_by`,
      [key, plan.source, fields, JSON.stringify(ownedState(h, fields)), actor.name]);
  }
  if (plan.onlyHere.length) {
    await db.query(`delete from flag_managed m using flag f where f.id = m.flag_id and f.key = any($1::text[]) and m.source is not distinct from $2`,
      [plan.onlyHere, plan.source]);
  }
}

/** Whether a flag is managed from a file: its name and the fields the file owns (the console's "Managed in repo"). */
export async function managedFlag(db: Db, flag: string) {
  return (await one<{ source: string | null; fields: string[]; appliedAt: string; appliedBy: string }>(db,
    `select m.source, m.fields, m.applied_at as "appliedAt", m.applied_by as "appliedBy"
       from flag_managed m join flag f on f.id = m.flag_id where f.key = $1`, [flag])) ?? null;
}

async function apply(db: Db, step: Step, envs: string[], actor: Actor, why: string): Promise<Done> {
  switch (step.do) {
    case 'create': {
      const s = step.spec;
      const variants = variantsOf(s);
      const first = s.default ?? (s.type === 'bool' && 'off' in variants ? 'off' : Object.keys(variants)[0]);
      const f: NewFlag = {
        key: step.flag, name: s.name ?? null, description: s.description ?? undefined, owner: s.owner ?? undefined, kind: s.kind,
        valueType: s.type, tags: s.tags ?? [], removeBy: s.removeBy ?? null, jsonSchema: s.jsonSchema ?? null,
        variations: Object.entries(variants).map(([key, value]) => ({ key, value })),
        delivery: Object.fromEntries(envs.map((e) => [e, s.services?.[e] ?? []])),
        // everyone gets the default until the console's rules say otherwise (off where changes need approval: createFlag)
        base: { enabled: true, defaultVariation: first, rules: [] },
      };
      await createFlag(db, f, actor);
      return { step, result: 'done' };
    }
    case 'details': {
      const s = step.spec;
      await updateFlagMeta(db, step.flag, {
        ...(s.name !== undefined ? { name: s.name } : {}), ...(s.description !== undefined ? { description: s.description } : {}),
        ...(s.owner !== undefined ? { owner: s.owner } : {}), ...(s.kind !== undefined ? { kind: s.kind } : {}),
        ...(s.removeBy !== undefined ? { removeBy: s.removeBy } : {}), ...(s.freeValues !== undefined ? { freeValues: s.freeValues } : {}),
        ...(s.tags !== undefined ? { tags: s.tags } : {}),
        ...(step.fields.includes('jsonSchema') ? { jsonSchema: s.jsonSchema ?? null } : {}),
      }, actor);
      return { step, result: 'done' };
    }
    case 'variants':
      await upsertVariations(db, step.flag, step.variants, actor);
      return { step, result: 'done' };
    case 'services': {
      const r = await setDelivery(db, step.flag, step.environment, step.after, actor, { before: step.before, reason: why, reuse: true });
      return r.applied ? { step, result: 'done' } : { step, result: 'request', request: Number(r.changeSetId), ...(r.reused ? { reused: true } : {}) };
    }
    case 'default': {
      if (step.request) return { step, result: 'request', request: step.request, reused: true };
      const env = await one<{ id: number }>(db, `select id from environment where key = $1`, [step.environment]);
      const flag = await one<{ id: string }>(db, `select id from flag where key = $1`, [step.flag]);
      const layer = env && flag ? (await loadLayers(db, env.id, [flag.id])).find((l) => l.entityKey === null)?.layer : undefined;
      if (!layer) throw new HttpError(404, `${step.flag} has no defaults in ${step.environment}`);
      if (layer.defaultVariation !== step.before) {
        throw new HttpError(409, `the default of ${step.flag} in ${step.environment} was changed by someone else: plan again`, undefined, 'conflict');
      }
      const item: Item = { flag: step.flag, entity: null, expectedLayerVersion: layer.version,
        proposed: { enabled: layer.enabled, variationWhenOff: layer.variationWhenOff, defaultVariation: step.after, inherit: layer.inherit, rules: layer.rules } };
      if (step.reviewed) return { step, result: 'request', request: (await createChangeSet(db, step.environment, [item], actor, why)).id };
      await applyItems(db, step.environment, [item], actor, { comment: why });
      return { step, result: 'done' };
    }
  }
}

/** One step's change, in words. */
function what(step: Step): string {
  const list = (l: string[]) => (l.length ? l.join(', ') : 'none');
  switch (step.do) {
    case 'create': return `create ${step.flag} (${step.spec.kind}, ${step.spec.type})`;
    case 'details': return `change ${step.flag}: ${step.fields.join(', ')}`;
    case 'variants': return `variants of ${step.flag}: ${[...step.added.map((v) => `+${v}`), ...step.changed.map((v) => `~${v}`)].join(', ')}`;
    case 'services': return `services of ${step.flag} in ${step.environment}: ${list(step.before)} → ${list(step.after)}`;
    case 'default': return `default of ${step.flag} in ${step.environment}: ${step.before || 'none'} → ${step.after}`;
  }
}

/** One step, as the plan prints it. */
export function describe(step: Step): string {
  const reviewed = (step.do === 'services' || step.do === 'default') && step.reviewed;
  const how = step.request ? ` (waiting in request #${step.request})` : reviewed ? ' (a request: it needs approval there)' : '';
  return `${what(step)}${how}${step.overwrites ? ' (undoes a change made outside this file since its last push)' : ''}`;
}

// ---------------------------------------------------------------- the file's JSON Schema

/** The JSON Schema of the file (draft 2020-12), for editors: published at FLAGS_SCHEMA_URL and served by the server
 *  at /flags.schema.json. test/flags-file-schema.test.ts checks it against readFile's fields and docs/public's copy. */
export function flagsFileSchema() {
  const nullable = (type: string, description: string) => ({ type: [type, 'null'], description });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: FLAGS_SCHEMA_URL,
    title: 'CompanyFlags flags file',
    description: 'The flags a codebase uses, kept in step with CompanyFlags by companyflags flags plan and push.',
    type: 'object',
    required: ['flags'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      source: { type: 'string', minLength: 1, maxLength: 200, description: 'A name for this file, e.g. "acme/web". The console shows it on the flags it manages.' },
      owns: { type: 'array', uniqueItems: true, items: { enum: [...OWNABLE] },
        description: `The fields this file decides, for every flag in it. Without it: ${DEFINITION.join(', ')}. Rules stay in the console.` },
      scope: { type: 'object', additionalProperties: false, minProperties: 1, description: 'The flags this file may touch.',
        properties: {
          prefix: { type: 'string', pattern: KEY.source, description: 'Flag keys that start with it.' },
          services: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Flags in these services only.' },
        } },
      flags: { type: 'object', propertyNames: { pattern: KEY.source }, additionalProperties: { $ref: '#/$defs/flag' } },
    },
    $defs: {
      flag: {
        type: 'object',
        required: ['kind', 'type'],
        additionalProperties: false,
        properties: {
          kind: { enum: [...FLAG_KINDS], description: 'Releases and experiments need removeBy.' },
          type: { enum: [...VALUE_TYPES], description: 'It can’t change once the flag exists.' },
          name: nullable('string', 'Its name in the console.'),
          description: nullable('string', 'What it is for.'),
          owner: nullable('string', 'Who looks after it.'),
          tags: { type: 'array', items: { type: 'string' } },
          removeBy: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD.' },
          variants: { type: 'object', description: 'Variant → value. An on/off flag has on: true and off: false when left out.' },
          freeValues: { type: 'boolean', description: 'Values typed into the rules instead of named variants. Such a flag is made in the console.' },
          jsonSchema: { type: ['object', 'null'], description: 'A JSON flag’s JSON Schema: every variant must match it. null removes it.' },
          default: { type: 'string', description: 'The variant everyone gets when no rule decides, in every environment.' },
          services: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Environment → the services it is in.' },
        },
      },
    },
  };
}
