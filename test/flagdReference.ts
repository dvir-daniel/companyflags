// flagd, as a reference for tests: evaluates our flagd JSON (server/flagd.ts) the way flagd does. The JsonLogic follows
// json-logic-js and flagd's own operators (fractional, sem_ver, starts_with, ends_with), written from their documented
// behaviour, not from our evaluator, so comparing its answers with server/evaluator.ts means something. flagdCore runs
// the real thing, OpenFeature's flagd-core (the evaluator in flagd's JavaScript providers), on the same JSON.
import assert from 'node:assert/strict';
import { FlagdCore } from '@openfeature/flagd-core';
import type { FlagdDoc } from '../server/flagd.ts';
import { murmur3Cbor } from '../server/hash.ts';
import { contextFor, evaluate, type Snapshot } from '../server/evaluator.ts';

type Data = unknown;
const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : !!v);
function getVar(data: Data, path: unknown, fallback: unknown = null): unknown {
  if (path === '' || path === null || path === undefined) return data;
  let cur: unknown = data;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? fallback : cur;
}
// flagd's sem_ver: semver, with a v or V in front or not; "6" and "6.1" read as 6.0.0 and 6.1.0; the build ignored
function semver(s: unknown) {
  if (typeof s !== 'string') return null;
  const m = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
    ?? /^[vV]?(\d+)(?:\.(\d+))?()$/.exec(s);
  return m ? { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] ? m[4].split('.') : [] } : null;
}
function semverCompare(a: NonNullable<ReturnType<typeof semver>>, b: NonNullable<ReturnType<typeof semver>>): number {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const [x, y] = [a.pre[i], b.pre[i]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const [xn, yn] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
export function run(logic: unknown, data: Data): unknown {
  if (Array.isArray(logic)) return logic.map((l) => run(l, data));
  if (logic === null || typeof logic !== 'object') return logic;
  const op = Object.keys(logic)[0];
  let args = (logic as Record<string, unknown>)[op];
  if (!Array.isArray(args)) args = [args];
  const a = args as unknown[];
  const v = (i: number) => run(a[i], data);
  switch (op) {
    case 'var': return getVar(data, v(0), a.length > 1 ? v(1) : null);
    case 'missing': return (Array.isArray(v(0)) ? (v(0) as unknown[]) : a.map((_, i) => v(i))).filter((k) => { const x = getVar(data, k); return x === null || x === ''; });
    case 'if': {
      let i = 0;
      for (; i < a.length - 1; i += 2) if (truthy(v(i))) return v(i + 1);
      return i === a.length - 1 ? v(i) : null;
    }
    case 'and': { let r: unknown; for (let i = 0; i < a.length; i++) { r = v(i); if (!truthy(r)) return r; } return r; }
    case 'or': { let r: unknown; for (let i = 0; i < a.length; i++) { r = v(i); if (truthy(r)) return r; } return r; }
    case '!': return !truthy(v(0));
    // eslint-disable-next-line eqeqeq
    case '==': return v(0) == v(1);
    case 'in': { const b = v(1) as { indexOf?: (x: unknown) => number } | null; return !!b && typeof b.indexOf === 'function' && b.indexOf(v(0)) !== -1; }
    case 'cat': return a.map((_, i) => v(i)).map((x) => (x === null || x === undefined ? '' : String(x))).join('');
    case '<': return (v(0) as number) < (v(1) as number);
    case '<=': return (v(0) as number) <= (v(1) as number);
    case '>': return (v(0) as number) > (v(1) as number);
    case '>=': return (v(0) as number) >= (v(1) as number);
    case 'some': case 'none': {
      const list = v(0);
      const any = Array.isArray(list) && list.length > 0 && list.some((item) => truthy(run(a[1], item)));
      return op === 'some' ? any : !any;
    }
    case 'starts_with': case 'ends_with': {
      const [s, p] = [v(0), v(1)];
      if (typeof s !== 'string' || typeof p !== 'string') return false;
      return op === 'starts_with' ? s.startsWith(p) : s.endsWith(p);
    }
    case 'sem_ver': {
      const [x, cmp, y] = [semver(v(0)), v(1), semver(v(2))];
      if (!x || !y) return false;
      const c = semverCompare(x, y);
      return ({ '=': c === 0, '!=': c !== 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 } as Record<string, boolean>)[String(cmp)];
    }
    case 'fractional': {
      const vals = a.map((_, i) => v(i));
      assert.ok(!Array.isArray(vals[0]), 'our JSON always gives the bucketing value');
      assert.equal(typeof vals[0], 'string');
      const entries = vals.slice(1) as [string, number][];
      const total = entries.reduce((s, [, w]) => s + w, 0);
      const bucket = Math.floor((murmur3Cbor(vals[0] as string) * total) / 4294967296);
      let end = 0;
      for (const [name, w] of entries) if (bucket < (end += w)) return name;
      return null;
    }
  }
  throw new Error(`no such operator in this reference: ${op}`);
}

export type Answer = { value?: unknown; codeDefault?: true; notFound?: true; reason?: string };

/** The targeting with each {"$ref": "<name>"} replaced by the document's shared evaluator of that name (flagd's
 *  $evaluators). An unknown name is an error, as in flagd. */
function withEvaluators(doc: FlagdDoc, logic: unknown): unknown {
  if (Array.isArray(logic)) return logic.map((l) => withEvaluators(doc, l));
  if (logic === null || typeof logic !== 'object') return logic;
  const o = logic as Record<string, unknown>;
  if (Object.keys(o).length === 1 && typeof o.$ref === 'string') {
    assert.ok(doc.$evaluators && Object.hasOwn(doc.$evaluators, o.$ref), `no shared evaluator "${o.$ref}"`);
    return doc.$evaluators[o.$ref];
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, withEvaluators(doc, v)]));
}
/** flagd's evaluation of one flag (flag definitions reference): DISABLED and a null variant give the code default. */
export function flagdEvaluate(doc: FlagdDoc, key: string, context: Data): Answer {
  const f = Object.hasOwn(doc.flags, key) ? doc.flags[key] : undefined;
  if (!f) return { notFound: true };
  if (f.state === 'DISABLED') return { codeDefault: true, reason: 'DISABLED' };
  let variant = f.defaultVariant;
  let reason = variant === null ? 'DEFAULT' : 'STATIC';    // no default variant: the code's default, as flagd-core says
  if (f.targeting !== undefined) {
    const r = run(withEvaluators(doc, f.targeting), context);
    if (r === null || r === undefined) reason = 'DEFAULT';
    else {
      assert.ok(typeof r === 'string' && Object.hasOwn(f.variants, r), `targeting returned ${JSON.stringify(r)}, not a variant`);
      variant = r;
      reason = 'TARGETING_MATCH';
    }
  }
  return variant === null ? { codeDefault: true, reason } : { value: f.variants[variant], reason };
}

/** The same flag evaluated by OpenFeature's flagd-core, as a flagd provider evaluating in-process does. */
const cores = new WeakMap<FlagdDoc, FlagdCore>();
export function flagdCore(doc: FlagdDoc, key: string, context: Record<string, unknown>): Answer {
  let core = cores.get(doc);
  if (!core) {
    core = new FlagdCore();
    core.setConfigurations(JSON.stringify(doc));
    cores.set(doc, core);
  }
  const f = Object.hasOwn(doc.flags, key) ? doc.flags[key] : undefined;
  if (!f) {
    assert.equal(core.resolveStringEvaluation(key, '', context as never).errorCode, 'FLAG_NOT_FOUND');
    return { notFound: true };
  }
  const sample = Object.values(f.variants)[0];
  const ctx = context as never;
  const r = typeof sample === 'boolean' ? core.resolveBooleanEvaluation(key, false, ctx)
    : typeof sample === 'number' ? core.resolveNumberEvaluation(key, 0, ctx)
      : typeof sample === 'string' ? core.resolveStringEvaluation(key, '', ctx)
        : core.resolveObjectEvaluation(key, {}, ctx);
  assert.equal(r.errorCode, undefined, `flagd-core: ${r.errorCode} ${r.errorMessage}`);
  // no variant: the default the app passed, the one in its code
  return r.variant === undefined ? { codeDefault: true, reason: r.reason } : { value: r.value, reason: r.reason };
}

/** The request's attributes as flagd's evaluation context: "app.version" is { app: { version } }. */
export function nest(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const parts = k.split('.');
    let cur = out;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    cur[parts.at(-1)!] = v;
  }
  return out;
}

/** What an app's OpenFeature flagd provider answers from its CDN file (flagd JSON) for one flag, given what the device
 *  knows about itself, dotted as the rules name it ("app.version"). A flag that isn't in the file: the default in code. */
export function cdnAnswer(file: FlagdDoc, key: string, attrs: Record<string, unknown> = {}): Answer {
  const a = flagdEvaluate(file, key, nest(attrs));
  return a.notFound ? { codeDefault: true, notFound: true } : a;
}

/** The server's answer. `targetingKey` is the device ID when there's no device.id, as OFREP reads it (ofrep.ts). */
export function ours(snap: Snapshot, key: string, project: string, entity: string | null, attrs: Record<string, unknown>): Answer {
  const { targetingKey, ...rest } = attrs;
  const sent = targetingKey !== undefined && targetingKey !== null && targetingKey !== '' && [undefined, null, ''].includes(rest['device.id'] as never)
    ? { ...rest, 'device.id': String(targetingKey) } : rest;
  const r = evaluate(snap, key, contextFor(snap, { project, entity }, sent), false);
  if (r.errorCode === 'FLAG_NOT_FOUND') return { notFound: true };
  return r.codeDefault ? { codeDefault: true } : { value: r.value };
}
export const same = (a: Answer) => (a.notFound ? 'not found' : a.codeDefault ? 'code default' : JSON.stringify(a.value));
