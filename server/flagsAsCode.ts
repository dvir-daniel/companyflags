// Flags as code (the CLI's `flags pull`, `flags plan` and `flags push`, cli.ts): the flags a codebase uses, written in
// a JSON file next to it, and kept in step with CompanyFeatures.
//
//   {
//     "flags": {
//       "new_checkout": {
//         "name": "New checkout", "kind": "release", "type": "bool", "removeBy": "2027-02-17",
//         "variants": { "on": true, "off": false }, "default": "off",
//         "flagSets": { "dev": ["web", "ios"], "prod": ["web"] }
//       }
//     }
//   }
//
// The file says what flags exist and what they are: their details, their variants and the flag sets they are in.
// Their rules stay in the console, where each change is reviewed where it must be. A push goes through the same
// functions the console does (control.ts), so every check holds; in an environment that needs approval, a change of
// flag sets becomes a request there, as in the console. A flag that is only in CompanyFeatures is listed and left as
// it is: archiving one is done in the console.

import { all, type Db } from './db.ts';
import { HIDDEN_PREFIX } from './evaluator.ts';
import { createFlag, setDelivery, updateFlagMeta, upsertVariations, type NewFlag } from './control.ts';
import { canonical, type Actor } from './layers.ts';
import { needsReview } from './policy.ts';

export type ValueType = 'bool' | 'string' | 'number' | 'json';
export const FLAG_KINDS = ['release', 'kill_switch', 'ops', 'experiment', 'config', 'permission'] as const;
const TYPES: readonly ValueType[] = ['bool', 'string', 'number', 'json'];

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
  /** the variant everyone gets when the flag is made (later, the console's rules decide) */
  default?: string;
  /** environment → the flag sets it is in */
  flagSets?: Record<string, string[]>;
};
export type FlagsFile = { $schema?: string; flags: Record<string, FlagSpec> };

export type Step =
  | { do: 'create'; flag: string; spec: FlagSpec }
  | { do: 'details'; flag: string; fields: string[]; spec: FlagSpec }
  | { do: 'variants'; flag: string; variants: { key: string; value: unknown }[]; added: string[]; changed: string[] }
  | { do: 'flagSets'; flag: string; environment: string; before: string[]; after: string[]; reviewed: boolean };
export type Plan = {
  steps: Step[];
  unchanged: string[];
  /** flags in CompanyFeatures that the file doesn't have: left as they are */
  onlyHere: string[];
  /** what's wrong with the file: nothing is pushed while there is any */
  problems: string[];
};

type Here = {
  key: string; name: string | null; description: string | null; owner: string | null; kind: string; type: ValueType;
  tags: string[]; removeBy: string | null; freeValues: boolean; variants: Record<string, unknown>; flagSets: Record<string, string[]>;
};

/** Every flag that isn't archived, as the file writes it. */
export async function readFlags(db: Db): Promise<Here[]> {
  const flags = await all<{ id: string; key: string; name: string | null; description: string | null; owner: string | null; kind: string;
    value_type: ValueType; tags: string[]; remove_by: string | null; free_values: boolean }>(db,
    `select id, key, name, description, owner, kind, value_type, tags, remove_by::text as remove_by, free_values
       from flag where archived_at is null order by key`);
  const variants = await all<{ flag_id: string; key: string; value: unknown }>(db,
    `select flag_id, key, value from flag_variation where not is_code_default order by id`);
  const delivery = await all<{ flag_id: string; env: string; set: string }>(db,
    `select d.flag_id, e.key as env, p.key as set from flag_delivery d join environment e on e.id = d.environment_id
       join project p on p.id = d.project_id order by e.id, p.id`);
  const envs = (await all<{ key: string }>(db, `select key from environment order by id`)).map((e) => e.key);
  return flags.map((f) => ({
    key: f.key, name: f.name, description: f.description, owner: f.owner, kind: f.kind, type: f.value_type,
    tags: f.tags ?? [], removeBy: f.remove_by, freeValues: f.free_values,
    variants: Object.fromEntries(variants.filter((v) => v.flag_id === f.id && !v.key.startsWith(HIDDEN_PREFIX)).map((v) => [v.key, v.value])),
    flagSets: Object.fromEntries(envs.map((e) => [e, delivery.filter((d) => d.flag_id === f.id && d.env === e).map((d) => d.set)])),
  }));
}

/** The file for what CompanyFeatures has now (`flags pull`). */
export async function pullFlags(db: Db): Promise<FlagsFile> {
  const flags: Record<string, FlagSpec> = {};
  for (const f of await readFlags(db)) {
    flags[f.key] = {
      ...(f.name ? { name: f.name } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.owner ? { owner: f.owner } : {}),
      kind: f.kind,
      type: f.type,
      ...(f.tags.length ? { tags: f.tags } : {}),
      ...(f.removeBy ? { removeBy: f.removeBy } : {}),
      ...(f.freeValues ? { freeValues: true } : {}),
      ...(Object.keys(f.variants).length && !(f.type === 'bool' && isOnOff(f.variants)) ? { variants: f.variants } : {}),
      flagSets: f.flagSets,
    };
  }
  return { flags };
}

const isOnOff = (v: Record<string, unknown>) => Object.keys(v).length === 2 && v.on === true && v.off === false;
const variantsOf = (s: FlagSpec): Record<string, unknown> => s.variants ?? (s.type === 'bool' && !s.freeValues ? { on: true, off: false } : {});

/** What a push would do (`flags plan`), and what's wrong with the file, against what CompanyFeatures has now. */
export async function planFlags(db: Db, file: unknown): Promise<Plan> {
  const problems: string[] = [];
  const spec = readFile(file, problems);
  const here = new Map((await readFlags(db)).map((f) => [f.key, f]));
  const envs = await all<{ key: string; minApprovals: number }>(db, `select key, min_approvals as "minApprovals" from environment order by id`);
  const sets = new Set((await all<{ key: string }>(db, `select key from project`)).map((p) => p.key));
  const reviewed = new Set(envs.filter(needsReview).map((e) => e.key));
  const steps: Step[] = [];
  const unchanged: string[] = [];

  for (const [key, s] of Object.entries(spec)) {
    for (const [env, list] of Object.entries(s.flagSets ?? {})) {
      if (!envs.some((e) => e.key === env)) problems.push(`${key}: no environment "${env}" (flagSets)`);
      for (const k of list) if (!sets.has(k)) problems.push(`${key}: no flag set "${k}" (flagSets.${env})`);
    }
    const h = here.get(key);
    if (!h) {
      if (s.freeValues) problems.push(`${key}: a flag with free values is made in the console (its first value is typed in there)`);
      else if (!Object.keys(variantsOf(s)).length) problems.push(`${key}: a new flag needs its variants`);
      steps.push({ do: 'create', flag: key, spec: s });
      continue;
    }
    const before = steps.length;
    if (h.type !== s.type) problems.push(`${key}: its type is ${h.type} here; a flag’s type can’t change (make a new flag)`);
    const fields = (['name', 'description', 'owner', 'kind', 'removeBy', 'freeValues'] as const)
      .filter((f) => s[f] !== undefined && (s[f] ?? null) !== (f === 'freeValues' ? h.freeValues : h[f] ?? null));
    if (s.tags !== undefined && canonical([...s.tags].sort()) !== canonical([...h.tags].sort())) fields.push('tags' as never);
    if (fields.length) steps.push({ do: 'details', flag: key, fields, spec: s });
    const want = variantsOf(s);
    const gone = Object.keys(h.variants).filter((v) => !(v in want));
    if (s.variants && gone.length) problems.push(`${key}: ${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} here but not in the file; removing variants is done in the console`);
    const added = Object.keys(want).filter((v) => !(v in h.variants));
    const changed = Object.keys(want).filter((v) => v in h.variants && canonical(h.variants[v]) !== canonical(want[v]));
    if (added.length || changed.length) {
      steps.push({ do: 'variants', flag: key, variants: [...added, ...changed].map((v) => ({ key: v, value: want[v] })), added, changed });
    }
    for (const [env, list] of Object.entries(s.flagSets ?? {})) {
      const was = h.flagSets[env] ?? [];
      if (canonical([...was].sort()) !== canonical([...list].sort())) {
        steps.push({ do: 'flagSets', flag: key, environment: env, before: was, after: list, reviewed: reviewed.has(env) });
      }
    }
    if (steps.length === before) unchanged.push(key);
  }
  const onlyHere = [...here.keys()].filter((k) => !(k in spec));
  return { steps, unchanged, onlyHere, problems };
}

/** The file's flags, checked for their form; what's wrong goes in `problems`. */
function readFile(file: unknown, problems: string[]): Record<string, FlagSpec> {
  const flags = (file as FlagsFile | null)?.flags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    problems.push('the file needs a "flags" object: { "flags": { "<key>": { "kind": …, "type": … } } }');
    return {};
  }
  for (const [key, s] of Object.entries(flags)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) problems.push(`${key}: flag keys use lowercase letters, digits and _, starting with a letter`);
    if (!s || typeof s !== 'object') { problems.push(`${key}: not an object`); continue; }
    if (!FLAG_KINDS.includes(s.kind as never)) problems.push(`${key}: kind is one of ${FLAG_KINDS.join(', ')}`);
    if (!TYPES.includes(s.type)) problems.push(`${key}: type is one of ${TYPES.join(', ')}`);
    if (s.variants !== undefined && (typeof s.variants !== 'object' || Array.isArray(s.variants) || s.variants === null)) problems.push(`${key}: variants is an object, variant → value`);
    if (s.flagSets !== undefined && (typeof s.flagSets !== 'object' || Array.isArray(s.flagSets)
      || Object.values(s.flagSets).some((l) => !Array.isArray(l) || l.some((x) => typeof x !== 'string')))) {
      problems.push(`${key}: flagSets is an object, environment → a list of flag set keys`);
    }
    if (s.default !== undefined && !(s.default in variantsOf(s))) problems.push(`${key}: default "${s.default}" isn’t one of its variants`);
  }
  return flags;
}

export type Done = { step: Step; result: 'done' | 'request'; request?: number };

/** Applies a plan (`flags push`), step by step, as `actor`. It stops at the first step CompanyFeatures refuses, with
 *  what was done before it (each step is its own change, as in the console). */
export async function pushFlags(db: Db, plan: Plan, actor: Actor): Promise<Done[]> {
  if (plan.problems.length) throw new Error(`the file has problems:\n${plan.problems.map((p) => `  ${p}`).join('\n')}`);
  const envs = (await all<{ key: string }>(db, `select key from environment order by id`)).map((e) => e.key);
  const done: Done[] = [];
  for (const step of plan.steps) {
    try {
      done.push(await apply(db, step, envs, actor));
    } catch (e) {
      const err = new Error(`${describe(step)}: ${(e as Error).message}`) as Error & { done: Done[] };
      err.done = done;
      throw err;
    }
  }
  return done;
}

async function apply(db: Db, step: Step, envs: string[], actor: Actor): Promise<Done> {
  switch (step.do) {
    case 'create': {
      const s = step.spec;
      const variants = variantsOf(s);
      const first = s.default ?? (s.type === 'bool' && 'off' in variants ? 'off' : Object.keys(variants)[0]);
      const f: NewFlag = {
        key: step.flag, name: s.name ?? null, description: s.description ?? undefined, owner: s.owner ?? undefined, kind: s.kind,
        valueType: s.type, tags: s.tags ?? [], removeBy: s.removeBy ?? null,
        variations: Object.entries(variants).map(([key, value]) => ({ key, value })),
        delivery: Object.fromEntries(envs.map((e) => [e, s.flagSets?.[e] ?? []])),
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
      }, actor);
      return { step, result: 'done' };
    }
    case 'variants':
      await upsertVariations(db, step.flag, step.variants, actor);
      return { step, result: 'done' };
    case 'flagSets': {
      const r = await setDelivery(db, step.flag, step.environment, step.after, actor, { before: step.before, reason: `flags push: ${describe(step)}` });
      return r.applied ? { step, result: 'done' } : { step, result: 'request', request: Number(r.changeSetId) };
    }
  }
}

/** One step, as the plan prints it. */
export function describe(step: Step): string {
  const list = (l: string[]) => (l.length ? l.join(', ') : 'none');
  switch (step.do) {
    case 'create': return `create ${step.flag} (${step.spec.kind}, ${step.spec.type})`;
    case 'details': return `change ${step.flag}: ${step.fields.join(', ')}`;
    case 'variants': return `variants of ${step.flag}: ${[...step.added.map((v) => `+${v}`), ...step.changed.map((v) => `~${v}`)].join(', ')}`;
    case 'flagSets': return `flag sets of ${step.flag} in ${step.environment}: ${list(step.before)} → ${list(step.after)}${step.reviewed ? ' (a request: it needs approval there)' : ''}`;
  }
}
