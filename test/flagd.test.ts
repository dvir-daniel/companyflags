// flagd JSON for backends (server/flagd.ts, GET /sdk/v1/flagd): evaluated the way flagd evaluates it
// (flagdReference.ts), it gives every request the same answer as our evaluator.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlagdDoc, FLAGD_SCHEMA, type FlagdDoc } from '../server/flagd.ts';
import { bucketFor } from '../server/hash.ts';
import {
  CODE_DEFAULT, type Condition, type FlagDef, type Inherit, type Layer, type Op, type Rule, type Snapshot,
} from '../server/evaluator.ts';
import { flagdEvaluate, nest, ours, same } from './flagdReference.ts';
import { boot } from './helpers.ts';
import { entities, fieldsFor } from './kit.ts';

// ---------------------------------------------------------------- random flags, every entity, random requests
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  return { next, pick, chance: (p: number) => next() < p, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

const DIMS = ['company', 'brand'];
const ENTITIES = entities([['microsoft', 'Microsoft', 'company'], ['google', 'Google', 'company'], ['unilever', 'Unilever', 'company'],
  ['dove', 'Dove', 'brand', 'unilever'], ['axe', 'Axe', 'brand', 'unilever']]);
const FIELDS: Snapshot['fields'] = fieldsFor(DIMS);
const snapOf = (flags: Record<string, FlagDef>, o: { environment?: string; revision?: number } = {}): Snapshot =>
  ({ environment: o.environment ?? 'dev', revision: o.revision ?? 1, builtAt: '', flags, entities: ENTITIES, dimensions: DIMS, fields: FIELDS });
const VERSIONS = ['4.9.1', '5.0.0', '5.0.0-beta.1', '5.0.0-beta.10', '6.0.0', '10.2.0'];
const TEXT: Record<string, string[]> = {
  'device.platform': ['android', 'ios', 'web'], 'locale.language': ['en', 'es', 'de', 'en-GB'],
  entity: Object.keys(ENTITIES), company: ['microsoft', 'google', 'unilever'], brand: ['dove', 'axe'],
  'customer.id': Object.keys(ENTITIES), 'customer.company': ['microsoft', 'google', 'unilever'],
  project: ['server-ds', 'web'], environment: ['dev', 'prod'],
};
const ROLES = ['admin', 'beta', 'staff'];

function randomCondition(r: ReturnType<typeof random>): Condition {
  const field = r.pick(Object.keys(FIELDS).filter((f) => f !== 'device.id' && f !== 'session.id'));
  if (r.chance(0.1)) return { field, op: r.pick(['exists', 'missing'] as const), values: [] };
  if (field === 'app.version') return { field, op: r.pick(['semver_lt', 'semver_lte', 'semver_gt', 'semver_gte', 'semver_eq'] as const), values: [r.pick(['5.0.0', '6.0.0', '5.0.0-beta.1'])] };
  if (field === 'app.build') return { field, op: r.pick(['lt', 'lte', 'gt', 'gte'] as const), values: [r.pick([100, 250, 1000])] };
  if (field === 'user.roles') return { field, op: r.pick(['contains_any', 'contains_none'] as const), values: [r.pick(ROLES), ...(r.chance(0.5) ? [r.pick(ROLES)] : [])] };
  const op: Op = r.pick(['in', 'in', 'not_in', 'starts_with', 'ends_with'] as const);
  const pool = TEXT[field];
  const values = op === 'starts_with' || op === 'ends_with' ? [r.pick(pool).slice(0, r.int(1, 3)), ...(r.chance(0.3) ? [r.pick(pool).slice(-2)] : [])]
    : [r.pick(pool), ...(r.chance(0.4) ? [r.pick(pool)] : [])];
  return { field, op, values };
}

function randomFlag(r: ReturnType<typeof random>, n: number): FlagDef {
  let k = 0;
  const variant = (own: boolean) => r.pick(own ? ['a', 'b', 'c', CODE_DEFAULT, 'val-own'] : ['a', 'b', 'c', CODE_DEFAULT]);
  const split = (): Rule['split'] => {
    const cuts = [r.int(0, 10000), r.int(0, 10000), r.int(0, 10000), r.int(0, 10000)].sort((x, y) => x - y);
    const ranges = [{ variation: variant(false), from: cuts[0], to: cuts[1] }, { variation: variant(false), from: cuts[2], to: cuts[3] }]
      .filter((g) => g.to > g.from).slice(0, r.chance(0.5) ? 1 : 2);
    if (!ranges.length) ranges.push({ variation: 'b', from: 0, to: 2000 });
    const by = r.pick(['device.id', 'device.id', 'session.id', 'entity', 'company', 'brand']);
    return { by, fallbackBy: by === 'device.id' && r.chance(0.4) ? 'session.id' : null, salt: r.pick(['f', 'checkout', 'x/y']), hashVersion: 2, ranges };
  };
  const rules = (own: boolean, base: boolean): Rule[] => Array.from({ length: r.int(0, 4) }, (): Rule => {
    const pct = r.chance(0.3);
    return {
      ruleKey: `r${n}-${++k}`, name: null, locked: base && r.chance(0.25), disabled: r.chance(0.1),
      conditions: Array.from({ length: r.int(0, 2) }, () => randomCondition(r)),
      serveVariation: pct ? null : variant(own), split: pct ? split() : null,
    };
  });
  const layer = (own: boolean): Layer => {
    const inherit = own ? r.pick<Inherit | null>([null, 'base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only']) : null;
    return { version: 1, enabled: own ? null : !r.chance(0.08), variationWhenOff: own ? null : CODE_DEFAULT, defaultVariation: !own || inherit === 'base_rules_then_customer_default' || inherit === 'customer_only' ? variant(own) : null, inherit, rules: rules(own, !own) };
  };
  return {
    key: 'f', valueType: 'string', kind: 'release', delivery: r.chance(0.9) ? ['server-ds', 'web'] : ['web'],
    variations: { a: 'A', b: 'B', c: 'C', 'val-own': 'typed for one entity', [CODE_DEFAULT]: null },
    base: layer(false),
    entities: Object.fromEntries(Object.keys(ENTITIES).filter(() => r.chance(0.4)).map((c) => [c, layer(true)])),
  };
}

function randomAttrs(r: ReturnType<typeof random>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const maybe = (k: string, v: () => unknown) => { if (r.chance(0.75)) attrs[k] = r.chance(0.05) ? '' : v(); };
  maybe('app.version', () => r.pick(VERSIONS));
  maybe('app.build', () => r.pick([50, 100, 250, 999, 1000, 4000]));
  maybe('device.platform', () => r.pick(TEXT['device.platform']));
  maybe('locale.language', () => r.pick(TEXT['locale.language']));
  maybe('device.id', () => `device-${r.int(0, 100000)}`);
  maybe('session.id', () => `session-${r.int(0, 100000)}`);
  maybe('user.roles', () => ROLES.filter(() => r.chance(0.4)));
  return attrs;
}

test('every random flag, entity and request: flagd’s answer from the JSON is ours', () => {
  const r = random(20261118);
  let compared = 0;
  const reasons = new Set<string>();
  for (let n = 0; n < 400; n++) {
    const f = randomFlag(r, n);
    const snap = snapOf({ f }, { revision: n });
    for (const entity of [null, ...Object.keys(ENTITIES)]) {
      const doc = buildFlagdDoc(snap, 'server-ds', entity ? ENTITIES[entity] : null);
      for (const fl of Object.values(doc.flags)) {
        assert.ok(Object.keys(fl.variants).length > 0, 'flagd needs a variant');
        for (const total of fractionalWeights(fl.targeting)) assert.equal(total, 10000);
      }
      for (let i = 0; i < 30; i++) {
        const attrs = randomAttrs(r);
        const theirs = flagdEvaluate(doc, 'f', nest(attrs));
        if (theirs.reason) reasons.add(theirs.reason);
        const want = ours(snap, 'f', 'server-ds', entity, attrs);
        assert.equal(same(theirs), same(want), `flag ${n}, entity ${entity}, ${JSON.stringify(attrs)}\n${JSON.stringify(f)}\n${JSON.stringify(doc.flags.f)}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 50_000);
  assert.deepEqual([...reasons].sort(), ['DEFAULT', 'DISABLED', 'STATIC', 'TARGETING_MATCH'], 'every kind of flagd answer came up');
});

test('the JSON for new_checkout: the override, the 20% as flagd’s fractional, the default', () => {
  const rule = (r: Partial<Rule>): Rule => ({ ruleKey: 'k', name: null, locked: false, disabled: false, conditions: [], serveVariation: null, split: null, ...r });
  const f: FlagDef = {
    key: 'new_checkout', valueType: 'bool', kind: 'release', delivery: ['server-ds'], variations: { on: true, off: false },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'off', inherit: null, rules: [
      rule({ locked: true, conditions: [{ field: 'app.version', op: 'semver_lt', values: ['5.0.0'] }], serveVariation: 'off' }),
      rule({ split: { by: 'device.id', fallbackBy: null, salt: 'new_checkout', hashVersion: 2, ranges: [{ variation: 'on', from: 0, to: 2000 }] } }),
    ] },
    entities: { google: { version: 1, enabled: null, variationWhenOff: null, defaultVariation: null, inherit: null, rules: [rule({ serveVariation: 'on' })] } },
  };
  const snap = snapOf({ new_checkout: f }, { environment: 'prod', revision: 15 });
  assert.deepEqual(buildFlagdDoc(snap, 'server-ds', ENTITIES.microsoft), {
    $schema: FLAGD_SCHEMA,
    metadata: { flagSetId: 'prod/server-ds/microsoft', environment: 'prod', revision: 15 },
    flags: { new_checkout: {
      state: 'ENABLED', variants: { off: false, on: true }, defaultVariant: 'off',
      targeting: { if: [
        { or: [{ missing: ['app.version'] }, { sem_ver: [{ var: 'app.version' }, '<', '5.0.0'] }] }, 'off',
        { and: [{ '!': { missing: ['device.id'] } }, { '==': [{ fractional: [{ cat: ['new_checkout/', { var: 'device.id' }] }, ['in', 2000], ['out', 8000]] }, 'in'] }] }, 'on',
        null,
      ] },
    } },
  });
  // Google's own rule comes right after the override, and always applies
  assert.deepEqual(buildFlagdDoc(snap, 'server-ds', ENTITIES.google).flags.new_checkout.targeting,
    { if: [{ or: [{ missing: ['app.version'] }, { sem_ver: [{ var: 'app.version' }, '<', '5.0.0'] }] }, 'off', null] });
  assert.equal(buildFlagdDoc(snap, 'server-ds', ENTITIES.google).flags.new_checkout.defaultVariant, 'on');
});

test('devices on the edges of a %: the first bucket inside and the first outside, at both ends', () => {
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'release', delivery: ['server-ds'], variations: { a: 'A', b: 'B' },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [
      { ruleKey: 'k', name: null, locked: false, disabled: false, conditions: [], serveVariation: null,
        split: { by: 'device.id', fallbackBy: null, salt: 'edge', hashVersion: 2, ranges: [{ variation: 'b', from: 2000, to: 5000 }] } },
    ] },
    entities: {},
  };
  const snap = snapOf({ f });
  const doc = buildFlagdDoc(snap, 'server-ds', ENTITIES.google);
  // several devices per edge bucket: within one bucket, devices sit at different points of it
  const want = new Map([[1999, 'A'], [2000, 'B'], [4999, 'B'], [5000, 'A']]);
  const found = new Map([...want.keys()].map((b) => [b, 0]));
  for (let i = 0; [...found.values()].some((n) => n < 8) && i < 5_000_000; i++) {
    const id = `edge-${i}`;
    const bucket = bucketFor('edge', id, 2);
    if (!want.has(bucket) || found.get(bucket)! >= 8) continue;
    found.set(bucket, found.get(bucket)! + 1);
    const attrs = { 'device.id': id };
    assert.equal(flagdEvaluate(doc, 'f', nest(attrs)).value, want.get(bucket), `bucket ${bucket}`);
    assert.equal(ours(snap, 'f', 'server-ds', 'google', attrs).value, want.get(bucket), `bucket ${bucket}`);
  }
  assert.deepEqual([...found.values()], [8, 8, 8, 8], 'found devices for every edge');
});

/** Every `fractional` in a flagd flag: its weights add up to 10000, as our buckets do. */
function fractionalWeights(logic: unknown, out: number[] = []): number[] {
  if (Array.isArray(logic)) for (const l of logic) fractionalWeights(l, out);
  else if (logic && typeof logic === 'object') {
    for (const [op, args] of Object.entries(logic)) {
      if (op === 'fractional') out.push((args as unknown[]).slice(1).reduce((s: number, e) => s + (e as [string, number])[1], 0));
      fractionalWeights(args, out);
    }
  }
  return out;
}

test('a % rule of an older hash version is refused, not written with the wrong hash', () => {
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'release', delivery: ['server-ds'], variations: { a: 'A', b: 'B' },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [
      { ruleKey: 'k', name: null, locked: false, disabled: false, conditions: [], serveVariation: null,
        split: { by: 'device.id', fallbackBy: null, salt: 'f', hashVersion: 1, ranges: [{ variation: 'b', from: 0, to: 5000 }] } },
    ] },
    entities: {},
  };
  const snap = snapOf({ f });
  assert.throws(() => buildFlagdDoc(snap, 'server-ds', ENTITIES.google), /hash_version 1 can’t be written as flagd JSON/);
});

// ---------------------------------------------------------------- the endpoint, on the test data
let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const flagdFor = (key: string, path = '', headers: Record<string, string> = {}) =>
  t.call('GET', `/sdk/v1/flagd${path}`, undefined, { authorization: `Bearer ${key}`, ...headers });

test('GET /sdk/v1/flagd: an entity’s key gets its flag set; a shared key names the entity in the path, by its dimension', async () => {
  const dana = t.as('dana');
  const own = (await dana.post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'entity', entity: 'netflix' })).json.key;
  const shared = (await dana.post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'all' })).json.key;

  const res = await flagdFor(own);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.$schema, FLAGD_SCHEMA);
  assert.deepEqual(res.json.metadata, { flagSetId: 'dev/server-ds/netflix', environment: 'dev', revision: t.plane.get('dev').revision });
  const snap = t.plane.get('dev');
  assert.deepEqual(Object.keys(res.json.flags), Object.keys(snap.flags).filter((k) => snap.flags[k].delivery.includes('server-ds')).sort(),
    'the flags sent to this backend, and only those');
  assert.ok(!/"(entity|company|brand|customer\.id|customer\.company)"/.test(JSON.stringify(res.json.flags)), 'checks on entities are settled: no other entity is named');
  assert.deepEqual((await flagdFor(own, '/company/netflix')).json, res.json, 'the key’s own entity, named in the path');

  assert.equal((await flagdFor(shared)).status, 400, 'a shared key that names no entity');
  assert.match((await flagdFor(shared)).json.error, /\/sdk\/v1\/flagd\/<dimension>\/<entity>/);
  assert.equal((await flagdFor(shared, '/company/nobody')).status, 404);
  assert.equal((await flagdFor(shared, '/brand/netflix')).status, 404, 'the dimension must be the entity’s');
  assert.deepEqual((await flagdFor(shared, '/company/netflix')).json, res.json, 'a shared key asking for Netflix gets what Netflix’s key gets');
  assert.equal((await flagdFor('ff_dev_nope', '/company/netflix')).status, 401);

  const etag = res.headers.get('etag')!;
  assert.equal((await flagdFor(own, '', { 'if-none-match': etag })).status, 304);
  assert.equal((await flagdFor(shared, '/company/netflix', { 'if-none-match': etag })).status, 304);
});

test('the test data: for every entity and many requests, flagd’s answer from the endpoint is ours', async () => {
  const shared = (await t.as('dana').post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'all' })).json.key;
  const snap = t.plane.get('dev');
  const r = random(7);
  let compared = 0;
  for (const entity of Object.values(snap.entities)) {
    const doc = (await flagdFor(shared, `/${entity.dimension}/${entity.key}`)).json as FlagdDoc;
    for (const key of Object.keys(snap.flags)) {
      for (let i = 0; i < 25; i++) {
        const attrs = randomAttrs(r);
        assert.equal(same(flagdEvaluate(doc, key, nest(attrs))), same(ours(snap, key, 'server-ds', entity.key, attrs)), `${key} for ${entity.key}, ${JSON.stringify(attrs)}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 1000, `${compared}`);
});
