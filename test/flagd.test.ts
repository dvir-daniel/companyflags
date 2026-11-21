// flagd JSON for backends (server/flagd.ts, GET /sdk/v1/flagd): evaluated the way flagd evaluates it
// (flagdReference.ts), and by OpenFeature's own flagd-core, it gives every request the same answer as our evaluator.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlagdDoc, buildServiceDoc, FLAGD_SCHEMA, type FlagdDoc } from '../server/flagd.ts';
import { bucketFor } from '../server/hash.ts';
import {
  CODE_DEFAULT, type Condition, type FlagDef, type Inherit, type Layer, type Op, type Rule, type Snapshot,
} from '../server/evaluator.ts';
import { flagdCore, flagdEvaluate, nest, ours, same } from './flagdReference.ts';
import { withPart } from '../web/src/pages/rolloutKit.ts';
import { boot } from './helpers.ts';
import { askingEntity, contextProblem } from '../server/ofrep.ts';
import { entities, fieldsFor } from './kit.ts';

// ---------------------------------------------------------------- random flags, every entity, random requests
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  return { next, pick, chance: (p: number) => next() < p, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

const DIMS = ['company', 'brand'];
const ENTITIES = entities([['vandelay', 'Vandelay', 'company'], ['wonka', 'Wonka', 'company'], ['tyrell', 'Tyrell', 'company'],
  ['velvet', 'Velvet', 'brand', 'tyrell'], ['onyx', 'Onyx', 'brand', 'tyrell']]);
const FIELDS: Snapshot['fields'] = fieldsFor(DIMS);
const snapOf = (flags: Record<string, FlagDef>, o: { environment?: string; revision?: number } = {}): Snapshot =>
  ({ environment: o.environment ?? 'dev', revision: o.revision ?? 1, builtAt: '', flags, entities: ENTITIES, dimensions: DIMS, fields: FIELDS });
// short and odd spellings too, ones both flagd and the server read (the others: 'versions flagd reads differently')
const VERSIONS = ['4.9.1', '5.0.0', '5.0.0-beta.1', '5.0.0-beta.10', '6.0.0', '10.2.0', '6', '6.0', '5', 'v6.0.0', '6.0.0+build.7', '10.2'];
const TEXT: Record<string, string[]> = {
  'device.platform': ['android', 'ios', 'web'], 'locale.language': ['en', 'es', 'de', 'en-GB'],
  entity: Object.keys(ENTITIES), company: ['vandelay', 'wonka', 'tyrell'], brand: ['velvet', 'onyx'],
  project: ['server-ds', 'web'], environment: ['dev', 'prod'],
};
const ROLES = ['admin', 'beta', 'staff'];

function randomCondition(r: ReturnType<typeof random>): Condition {
  const field = r.pick(Object.keys(FIELDS).filter((f) => f !== 'device.id' && f !== 'session.id'));
  if (r.chance(0.1)) return { field, op: r.pick(['exists', 'missing'] as const), values: [] };
  if (field === 'app.version') return { field, op: r.pick(['semver_lt', 'semver_lte', 'semver_gt', 'semver_gte', 'semver_eq'] as const), values: [r.pick(['5.0.0', '6.0.0', '5.0.0-beta.1', '6', '5.0', 'v6.0.0'])] };
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
    const fallbackBy = by === 'device.id' && r.chance(0.4) ? 'session.id' : by === 'session.id' && r.chance(0.4) ? 'device.id' : null;
    return { by, fallbackBy, salt: r.pick(['f', 'checkout', 'x/y']), hashVersion: 2, ranges };
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
  // OpenFeature's targeting key, at the root of the context: the device ID when there's no device.id
  if (r.chance(0.5)) attrs.targetingKey = r.chance(0.05) ? '' : `tk-${r.int(0, 100000)}`;
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
        const core = flagdCore(doc, 'f', nest(attrs));
        if (core.reason) reasons.add(core.reason);
        const want = ours(snap, 'f', 'server-ds', entity, attrs);
        const where = `flag ${n}, entity ${entity}, ${JSON.stringify(attrs)}\n${JSON.stringify(f)}\n${JSON.stringify(doc.flags.f)}`;
        assert.equal(same(core), same(want), `flagd-core: ${where}`);
        assert.equal(same(theirs), same(want), where);
        assert.equal(theirs.reason, core.reason, `the same reason: ${where}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 50_000);
  assert.deepEqual([...reasons].sort(), ['DEFAULT', 'DISABLED', 'STATIC', 'TARGETING_MATCH'], 'every kind of flagd answer came up');
});

/** flagd's context for a request from `entity`: its attributes nested, and the entity by its dimension key, alone or
 *  with the entities above it (`chain`), as a backend names it. */
function namedContext(entity: string | null, attrs: Record<string, unknown>, chain: boolean): Record<string, unknown> {
  const ctx = nest(attrs);
  if (!entity) return ctx;
  const info = ENTITIES[entity];
  return { ...ctx, ...(chain ? info.at : { [info.dimension]: entity }) };
}

test('one document for every entity of a service (an `all` key’s): flagd’s answer for each entity it names is ours', () => {
  const r = random(20261120);
  let compared = 0;
  let smaller = 0;
  for (let n = 0; n < 300; n++) {
    const f = randomFlag(r, n);
    const snap = snapOf({ f }, { revision: n });
    const doc = buildServiceDoc(snap, 'server-ds', Object.values(ENTITIES), null);
    assert.equal(doc.metadata.flagSetId, 'dev/server-ds');
    for (const fl of Object.values(doc.flags)) {
      assert.ok(Object.keys(fl.variants).length > 0, 'flagd needs a variant');
      for (const total of fractionalWeights(fl.targeting)) assert.equal(total, 10000);
    }
    const branches = JSON.stringify(doc.flags.f?.targeting ?? null).match(/\{"in":\[\{"var":"(company|brand)"\}/g)?.length ?? 0;
    if (branches < Object.keys(ENTITIES).length) smaller++;
    for (const entity of [null, ...Object.keys(ENTITIES)]) {
      for (let i = 0; i < 12; i++) {
        const attrs = randomAttrs(r);
        const want = ours(snap, 'f', 'server-ds', entity, attrs);
        for (const chain of entity && ENTITIES[entity].parent ? [false, true] : [false]) {
          const context = namedContext(entity, attrs, chain);
          const where = `flag ${n}, entity ${entity}${chain ? ' (with its chain)' : ''}, ${JSON.stringify(context)}\n${JSON.stringify(f)}\n${JSON.stringify(doc.flags.f)}`;
          const core = flagdCore(doc, 'f', context);
          assert.equal(same(core), same(want), `flagd-core: ${where}`);
          assert.equal(same(flagdEvaluate(doc, 'f', context)), same(want), where);
          compared++;
        }
      }
    }
  }
  assert.ok(compared > 20_000, `${compared}`);
  assert.ok(smaller > 100, 'entities with the same logic share a branch, or need none');
});

test('one document for an entity and those under it (a `below` key’s): naming none asks as the key’s entity', () => {
  const r = random(42);
  const below = Object.values(ENTITIES).filter((e) => e.path.includes('tyrell'));
  assert.deepEqual(below.map((e) => e.key).sort(), ['onyx', 'tyrell', 'velvet']);
  for (let n = 0; n < 200; n++) {
    const f = randomFlag(r, n);
    const snap = snapOf({ f });
    const doc = buildServiceDoc(snap, 'server-ds', below, ENTITIES.tyrell);
    assert.ok(!/"(vandelay|wonka)"/.test(JSON.stringify(doc)), 'no entity outside the key’s reach is named');
    for (let i = 0; i < 15; i++) {
      const attrs = randomAttrs(r);
      for (const [entity, context] of [['tyrell', nest(attrs)], ['tyrell', namedContext('tyrell', attrs, false)],
        ['velvet', namedContext('velvet', attrs, false)], ['onyx', namedContext('onyx', attrs, true)]] as const) {
        const want = ours(snap, 'f', 'server-ds', entity, attrs);
        assert.equal(same(flagdCore(doc, 'f', context)), same(want), `${entity}: ${JSON.stringify(context)} ${JSON.stringify(doc.flags.f)}`);
      }
    }
  }
});

test('in one document, an entity it doesn’t hold gets the code default, as OFREP refuses it', () => {
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'release', delivery: ['server-ds'], variations: { a: 'A', b: 'B', c: 'C' },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [] },
    entities: {
      tyrell: { version: 1, enabled: null, variationWhenOff: null, defaultVariation: 'b', inherit: 'base_rules_then_customer_default', rules: [] },
      velvet: { version: 1, enabled: null, variationWhenOff: null, defaultVariation: 'c', inherit: 'base_rules_then_customer_default', rules: [] },
    },
  };
  const doc = buildServiceDoc(snapOf({ f }), 'server-ds', Object.values(ENTITIES), null);
  const value = (context: Record<string, unknown>) => flagdCore(doc, 'f', context).value;
  assert.equal(value({ brand: 'velvet' }), 'C');
  assert.equal(value({ company: 'tyrell', brand: 'velvet' }), 'C', 'the lowest dimension named decides');
  assert.equal(value({ brand: 'onyx' }), 'B', 'onyx follows tyrell');
  assert.equal(value({ company: 'wonka' }), 'A');
  assert.equal(value({}), 'A', 'naming none: what no entity gets');
  // what OFREP refuses (400 INVALID_CONTEXT), and so the code's defaults there: the code default here too
  for (const refused of [{ company: 'tyrell', brand: 'signed-up-a-minute-ago' }, { company: 'nobody' }, { company: '' }, { brand: '' },
    { company: 'wonka', brand: 'velvet' }, { company: 'nobody', brand: 'velvet' }]) {
    assert.deepEqual(flagdCore(doc, 'f', refused), { codeDefault: true, reason: 'DEFAULT' }, JSON.stringify(refused));
    assert.equal(same(flagdEvaluate(doc, 'f', refused)), 'code default', JSON.stringify(refused));
  }
  // wonka and vandelay get what everyone gets, with no branch of their own; the check is shared by every flag
  const is = (d: string, keys: string[]) => ({ and: [{ '!': { in: [{ var: d }, [null, '']] } }, { in: [{ cat: [{ var: d }] }, keys] }] });
  assert.deepEqual(doc.flags.f.targeting, { if: [
    { $ref: 'unknown_entity' }, null,
    is('brand', ['onyx']), 'b', is('brand', ['velvet']), 'c',
    is('company', ['tyrell']), 'b',
    'a',
  ] });
  assert.equal(doc.flags.f.defaultVariant, null);
  assert.ok(doc.$evaluators?.unknown_entity);
});

// ---------------------------------------------------------------- the same entity over OFREP and in one document
// A brand with a number for a key, as a backend passing store or account IDs as numbers has: {"brand": 12}.
const NUMBERED = entities([['vandelay', 'Vandelay', 'company'], ['wonka', 'Wonka', 'company'], ['tyrell', 'Tyrell', 'company'],
  ['velvet', 'Velvet', 'brand', 'tyrell'], ['onyx', 'Onyx', 'brand', 'tyrell'], ['12', 'Twelve', 'brand', 'wonka'], ['orphan', 'Orphan', 'brand']]);

/** What OFREP does with a context for a key (ofrep.ts): refuse it (the provider gives the code's defaults), or ask as
 *  an entity (or none). */
function ofrepAsks(snap: Snapshot, key: { scope: 'all' | 'below'; entity: string | null }, context: Record<string, unknown>): { refused: true } | { entity: string | null } {
  if (contextProblem(snap, context)) return { refused: true };
  try { return { entity: askingEntity(snap, key, context) }; } catch { return { refused: true }; }
}

test('every context, over OFREP and in one document: the same entity asks, and what OFREP refuses is the code default', () => {
  const r = random(20261121);
  const snapWith = (f: FlagDef): Snapshot => ({ environment: 'dev', revision: 1, builtAt: '', flags: { f }, entities: NUMBERED, dimensions: DIMS, fields: FIELDS });
  const companies = ['vandelay', 'wonka', 'tyrell', 'nobody', '', 'Wonka'];
  const brands = ['velvet', 'onyx', '12', 12, 'orphan', 'new-brand', '', 13];
  let refused = 0;
  let compared = 0;
  for (let n = 0; n < 150; n++) {
    const f = { ...randomFlag(r, n), delivery: ['server-ds'] };
    // the entities' own settings for the numbered brand and the one with no company too
    if (r.chance(0.5)) f.entities['12'] = { version: 1, enabled: null, variationWhenOff: null, defaultVariation: 'c', inherit: 'customer_only', rules: [] };
    if (r.chance(0.3)) f.entities.orphan = { version: 1, enabled: null, variationWhenOff: null, defaultVariation: 'b', inherit: 'base_rules_then_customer_default', rules: [] };
    const snap = snapWith(f);
    for (const key of [{ scope: 'all' as const, entity: null }, { scope: 'below' as const, entity: 'tyrell' }, { scope: 'below' as const, entity: 'velvet' }]) {
      const held = Object.values(NUMBERED).filter((e) => key.entity === null || e.path.includes(key.entity));
      const doc = buildServiceDoc(snap, 'server-ds', held, key.entity ? NUMBERED[key.entity] : null);
      for (let i = 0; i < 25; i++) {
        const attrs = randomAttrs(r);
        const named: Record<string, unknown> = {};
        if (r.chance(0.6)) named.company = r.pick(companies);
        if (r.chance(0.6)) named.brand = r.pick(brands);
        const asks = ofrepAsks(snap, key, named);
        const want = 'refused' in asks ? { codeDefault: true as const } : ours(snap, 'f', 'server-ds', asks.entity, attrs);
        if ('refused' in asks) refused++;
        const context = { ...nest(attrs), ...named };
        const where = `${JSON.stringify(key)} ${JSON.stringify(named)} → ${JSON.stringify(asks)}\n${JSON.stringify(f)}\n${JSON.stringify(doc)}`;
        assert.equal(same(flagdCore(doc, 'f', context)), same(want), `flagd-core: ${where}`);
        assert.equal(same(flagdEvaluate(doc, 'f', context)), same(want), where);
        compared++;
      }
    }
  }
  assert.ok(refused > 1000 && compared - refused > 2000, `${refused} refused of ${compared}`);
});

test('a number for an entity’s key: OFREP and one document both read {"brand": 12} as the brand "12"', () => {
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'release', delivery: ['server-ds'], variations: { a: 'A', b: 'B' },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [] },
    entities: { 12: { version: 1, enabled: null, variationWhenOff: null, defaultVariation: 'b', inherit: 'base_rules_then_customer_default', rules: [] } },
  };
  const snap: Snapshot = { environment: 'dev', revision: 1, builtAt: '', flags: { f }, entities: NUMBERED, dimensions: DIMS, fields: FIELDS };
  const doc = buildServiceDoc(snap, 'server-ds', Object.values(NUMBERED), null);
  assert.deepEqual(ofrepAsks(snap, { scope: 'all', entity: null }, { brand: 12 }), { entity: '12' });
  assert.equal(ours(snap, 'f', 'server-ds', '12', {}).value, 'B');
  for (const context of [{ brand: 12 }, { brand: '12' }, { company: 'wonka', brand: 12 }]) assert.equal(flagdCore(doc, 'f', context).value, 'B', JSON.stringify(context));
  assert.equal(flagdCore(doc, 'f', { company: 'tyrell', brand: 12 }).codeDefault, true, 'not under tyrell: refused by both');
  assert.deepEqual(ofrepAsks(snap, { scope: 'all', entity: null }, { company: 'tyrell', brand: 12 }), { refused: true });
});

test('a switched-off flag puts none of its values in any document: only a placeholder', () => {
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'permission', delivery: ['server-ds', 'web'],
    variations: { globex: 'only for globex', acme: 'only for acme', 'val-x': 'typed in', [CODE_DEFAULT]: null },
    base: { version: 1, enabled: false, variationWhenOff: CODE_DEFAULT, defaultVariation: 'globex', inherit: null, rules: [] },
    entities: { wonka: { version: 1, enabled: null, variationWhenOff: null, defaultVariation: 'acme', inherit: 'customer_only', rules: [] } },
  };
  // and a flag that is on, but whose every answer is the app's code default
  const g: FlagDef = { ...f, key: 'g', base: { ...f.base, enabled: true, defaultVariation: CODE_DEFAULT }, entities: {} };
  const snap = snapOf({ f, g });
  const docs = [...[null, ...Object.keys(ENTITIES)].map((e) => buildFlagdDoc(snap, 'web', e ? ENTITIES[e] : null)),
    buildServiceDoc(snap, 'server-ds', Object.values(ENTITIES), null), buildServiceDoc(snap, 'server-ds', [ENTITIES.tyrell, ENTITIES.velvet, ENTITIES.onyx], ENTITIES.tyrell)];
  for (const doc of docs) {
    assert.deepEqual(doc.flags.f, { state: 'DISABLED', variants: { unused: '' }, defaultVariant: null }, doc.metadata.flagSetId);
    assert.deepEqual(doc.flags.g.variants, { unused: '' }, doc.metadata.flagSetId);
    assert.doesNotMatch(JSON.stringify(doc), /only for|typed in/, doc.metadata.flagSetId);
    for (const entity of [{}, { company: 'wonka' }]) {
      assert.equal(same(flagdCore(doc, 'f', entity)), 'code default');
      assert.equal(same(flagdCore(doc, 'g', entity)), 'code default');
    }
  }
  assert.equal(same(ours(snap, 'f', 'web', 'wonka', {})), 'code default', 'the server’s answer: the same');
});

// missing is absent, null or "" in every JsonLogic (flagd.ts)
const missing = (field: string) => ({ in: [{ var: field }, [null, '']] });
const present = (field: string) => ({ '!': missing(field) });

test('the JSON for new_checkout: the override, the 20% as flagd’s fractional, the default', () => {
  const rule = (r: Partial<Rule>): Rule => ({ ruleKey: 'k', name: null, locked: false, disabled: false, conditions: [], serveVariation: null, split: null, ...r });
  const f: FlagDef = {
    key: 'new_checkout', valueType: 'bool', kind: 'release', delivery: ['server-ds'], variations: { on: true, off: false },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'off', inherit: null, rules: [
      rule({ locked: true, conditions: [{ field: 'app.version', op: 'semver_lt', values: ['5.0.0'] }], serveVariation: 'off' }),
      rule({ split: { by: 'device.id', fallbackBy: null, salt: 'new_checkout', hashVersion: 2, ranges: [{ variation: 'on', from: 0, to: 2000 }] } }),
    ] },
    entities: { wonka: { version: 1, enabled: null, variationWhenOff: null, defaultVariation: null, inherit: null, rules: [rule({ serveVariation: 'on' })] } },
  };
  const snap = snapOf({ new_checkout: f }, { environment: 'prod', revision: 15 });
  assert.deepEqual(buildFlagdDoc(snap, 'server-ds', ENTITIES.vandelay), {
    $schema: FLAGD_SCHEMA,
    metadata: { flagSetId: 'prod/server-ds/vandelay', environment: 'prod', revision: 15 },
    flags: { new_checkout: {
      state: 'ENABLED', variants: { off: false, on: true }, defaultVariant: 'off',
      targeting: { if: [
        { or: [missing('app.version'), { sem_ver: [{ var: 'app.version' }, '<', '5.0.0'] }] }, 'off',
        { and: [
          { or: [present('device.id'), present('targetingKey')] },
          { '==': [{ fractional: [{ cat: ['new_checkout/', { if: [present('device.id'), { var: 'device.id' }, { var: 'targetingKey' }] }] }, ['in', 2000], ['out', 8000]] }, 'in'] },
        ] }, 'on',
        null,
      ] },
    } },
  });
  // Wonka's own rule comes right after the override, and always applies
  assert.deepEqual(buildFlagdDoc(snap, 'server-ds', ENTITIES.wonka).flags.new_checkout.targeting,
    { if: [{ or: [missing('app.version'), { sem_ver: [{ var: 'app.version' }, '<', '5.0.0'] }] }, 'off', null] });
  assert.equal(buildFlagdDoc(snap, 'server-ds', ENTITIES.wonka).flags.new_checkout.defaultVariant, 'on');
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
  const doc = buildFlagdDoc(snap, 'server-ds', ENTITIES.wonka);
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
    assert.equal(ours(snap, 'f', 'server-ds', 'wonka', attrs).value, want.get(bucket), `bucket ${bucket}`);
  }
  assert.deepEqual([...found.values()], [8, 8, 8, 8], 'found devices for every edge');
});

const simpleRule = (r: Partial<Rule>): Rule => ({ ruleKey: 'k', name: null, locked: false, disabled: false, conditions: [], serveVariation: null, split: null, ...r });

test('a context with only targetingKey: the device ID, in the same group as on the server (OFREP reads it so)', () => {
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'release', delivery: ['server-ds'], variations: { a: 'A', b: 'B' },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [
      simpleRule({ split: { by: 'device.id', fallbackBy: 'session.id', salt: 'tk', hashVersion: 2, ranges: [{ variation: 'b', from: 0, to: 5000 }] } }),
    ] },
    entities: {},
  };
  const snap = snapOf({ f });
  const doc = buildFlagdDoc(snap, 'server-ds', ENTITIES.wonka);
  const seen = new Set<unknown>();
  for (let i = 0; i < 400; i++) {
    const want = bucketFor('tk', `tk-${i}`, 2) < 5000 ? 'B' : 'A';
    for (const context of [{ targetingKey: `tk-${i}` }, { targetingKey: `tk-${i}`, session: { id: `s-${i}` } }, { device: { id: `tk-${i}` }, targetingKey: 'other' }]) {
      assert.equal(flagdCore(doc, 'f', context).value, want, JSON.stringify(context));
      assert.equal(flagdEvaluate(doc, 'f', context).value, want);
    }
    assert.equal(ours(snap, 'f', 'server-ds', 'wonka', { targetingKey: `tk-${i}` }).value, want);
    seen.add(want);
  }
  assert.deepEqual([...seen].sort(), ['A', 'B'], 'both groups came up');
  // no device ID and no targeting key: by the session
  const bySession = bucketFor('tk', 's-1', 2) < 5000 ? 'B' : 'A';
  assert.equal(flagdCore(doc, 'f', { session: { id: 's-1' } }).value, bySession);
  assert.equal(flagdCore(doc, 'f', { targetingKey: '', session: { id: 's-1' } }).value, bySession, 'an empty targeting key is none');
  assert.equal(flagdCore(doc, 'f', {}).value, 'A', 'nothing to bucket on: the % doesn’t apply');
});

test('versions in rules are written in full in the JSON, so strict semver readers take them', () => {
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'release', delivery: ['server-ds'], variations: { a: 'A', b: 'B' },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [
      simpleRule({ conditions: [{ field: 'app.version', op: 'semver_gte', values: ['6'] }, { field: 'app.version', op: 'semver_lt', values: ['v7.1-rc.1'] }], serveVariation: 'b' }),
    ] },
    entities: {},
  };
  const doc = buildFlagdDoc(snapOf({ f }), 'server-ds', ENTITIES.wonka);
  const versions = JSON.stringify(doc.flags.f.targeting).match(/"sem_ver":\[\{"var":"app.version"\},"[<>=]+","[^"]+"\]/g);
  assert.deepEqual(versions, ['"sem_ver":[{"var":"app.version"},">=","6.0.0"]', '"sem_ver":[{"var":"app.version"},"<","7.1.0-rc.1"]']);
});

test('versions flagd reads differently: what local-backends.md says', () => {
  // an override for versions below 5, new for 6 and up, mid otherwise
  const f: FlagDef = {
    key: 'f', valueType: 'string', kind: 'release', delivery: ['server-ds'], variations: { old: 'old', mid: 'mid', new: 'new' },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'mid', inherit: null, rules: [
      simpleRule({ locked: true, conditions: [{ field: 'app.version', op: 'semver_lt', values: ['5.0.0'] }], serveVariation: 'old' }),
      simpleRule({ conditions: [{ field: 'app.version', op: 'semver_gte', values: ['6.0.0'] }], serveVariation: 'new' }),
    ] },
    entities: {},
  };
  const snap = snapOf({ f });
  const doc = buildFlagdDoc(snap, 'server-ds', ENTITIES.wonka);
  const both = (version: unknown) => ({
    server: ours(snap, 'f', 'server-ds', 'wonka', { 'app.version': version }).value,
    flagd: flagdCore(doc, 'f', { app: { version } }).value,
  });
  // read the same: full versions, short ones, v in front, a build part
  for (const [v, want] of [['4.9.1', 'old'], ['5.2.0', 'mid'], ['6.0.0', 'new'], ['6', 'new'], ['4.9', 'old'], ['v6.0.0', 'new'], ['6.0.0+7', 'new'], ['6.0.0-rc.1', 'mid']]) {
    assert.deepEqual(both(v), { server: want, flagd: want }, String(v));
  }
  // flagd can't read them, so no check on them matches there, an override's included; the server reads 6.1-beta
  // and 01.0.0, and an override matches a version it can't read (abc)
  assert.deepEqual(both('6.1-beta'), { server: 'new', flagd: 'mid' });
  assert.deepEqual(both('01.0.0'), { server: 'old', flagd: 'mid' });
  assert.deepEqual(both('abc'), { server: 'old', flagd: 'mid' });
  // flagd reads them, the server doesn't: a number, a capital V
  assert.deepEqual(both(6), { server: 'old', flagd: 'new' });
  assert.deepEqual(both('V6.0.0'), { server: 'old', flagd: 'new' });
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
  assert.throws(() => buildFlagdDoc(snap, 'server-ds', ENTITIES.wonka), /hash_version 1 can’t be written as flagd JSON/);
});

// ---------------------------------------------------------------- the endpoint, on the test data
let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const flagdFor = (key: string, path = '', headers: Record<string, string> = {}) =>
  t.call('GET', `/sdk/v1/flagd${path}`, undefined, { authorization: `Bearer ${key}`, ...headers });

test('GET /sdk/v1/flagd: an entity’s key gets its service; a shared key names the entity in the path, by its dimension', async () => {
  const dana = t.as('dana');
  const own = (await dana.post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'entity', entity: 'soylent' })).json.key;
  const shared = (await dana.post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json.key;

  const res = await flagdFor(own);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.$schema, FLAGD_SCHEMA);
  assert.deepEqual(res.json.metadata, { flagSetId: 'dev/server-ds/soylent', environment: 'dev', revision: t.plane.get('dev').revision });
  const snap = t.plane.get('dev');
  assert.deepEqual(Object.keys(res.json.flags), Object.keys(snap.flags).filter((k) => snap.flags[k].delivery.includes('server-ds')).sort(),
    'the flags sent to this backend, and only those');
  assert.ok(!/"(entity|company|brand|customer\.id|customer\.company)"/.test(JSON.stringify(res.json.flags)), 'checks on entities are settled: no other entity is named');
  assert.deepEqual((await flagdFor(own, '/company/soylent')).json, res.json, 'the key’s own entity, named in the path');

  assert.equal((await flagdFor(shared)).status, 400, 'a shared key that names no entity');
  assert.match((await flagdFor(shared)).json.error, /\/sdk\/v1\/flagd\/<dimension>\/<entity>/);
  assert.equal((await flagdFor(shared, '/company/nobody')).status, 404);
  assert.equal((await flagdFor(shared, '/brand/soylent')).status, 404, 'the dimension must be the entity’s');
  assert.deepEqual((await flagdFor(shared, '/company/soylent')).json, res.json, 'a shared key asking for Soylent gets what Soylent’s key gets');
  assert.equal((await flagdFor('ff_dev_nope', '/company/soylent')).status, 401);

  const etag = res.headers.get('etag')!;
  assert.equal((await flagdFor(own, '', { 'if-none-match': etag })).status, 304);
  assert.equal((await flagdFor(shared, '/company/soylent', { 'if-none-match': etag })).status, 304);
});

test('the test data: for every entity and many requests, flagd’s answer from the endpoint is ours', async () => {
  const shared = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json.key;
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

test('GET /sdk/v1/flagd/service: one document for every entity the key may ask about, for one flagd', async () => {
  const dana = t.as('dana');
  const shared = (await dana.post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json.key;
  const own = (await dana.post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'entity', entity: 'soylent' })).json.key;
  const app = (await dana.post('/api-keys', { environment: 'dev', service: 'web', scope: 'all' })).json.key;
  const snap = t.plane.get('dev');
  const res = await flagdFor(shared, '/service');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const doc = res.json as FlagdDoc;
  assert.deepEqual(doc.metadata, { flagSetId: 'dev/server-ds', environment: 'dev', revision: snap.revision });
  assert.deepEqual(Object.keys(doc.flags), Object.keys(snap.flags).filter((k) => snap.flags[k].delivery.includes('server-ds')).sort());
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  assert.equal((await flagdFor(shared, '/service', { 'if-none-match': res.headers.get('etag')! })).status, 304);
  assert.equal((await flagdFor(own, '/service')).status, 400, 'a key for one entity reads its own document');
  assert.equal((await flagdFor(app, '/service')).status, 403, 'an app’s key reads values only');

  const r = random(11);
  let compared = 0;
  for (const entity of [null, ...Object.values(snap.entities)]) {
    for (const key of Object.keys(doc.flags)) {
      for (let i = 0; i < 10; i++) {
        const attrs = randomAttrs(r);
        const context = { ...nest(attrs), ...(entity ? { [entity.dimension]: entity.key } : {}) };
        assert.equal(same(flagdCore(doc, key, context)), same(ours(snap, key, 'server-ds', entity?.key ?? null, attrs)), `${key} for ${entity?.key}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 300, `${compared}`);
});

// The console's split editor (web/src/pages/rolloutKit.ts) lays a split's parts end to end: one rule serving several
// variants. flagd's fractional has one weight per part, and every device lands in the same part as on our server.
test('a split across three variants, as the editor makes it (50/25/25 by device, or by session): flagd’s answer is ours', () => {
  const ranges = withPart(withPart([{ variation: 'a', from: 0, to: 5000 }], 'b', 2500), 'c', 2500);
  assert.deepEqual(ranges.map((x) => [x.from, x.to]), [[0, 5000], [5000, 7500], [7500, 10000]]);
  for (const by of ['device.id', 'session.id']) {
    const f: FlagDef = {
      key: 'checkout_test', valueType: 'string', kind: 'experiment', delivery: ['server-ds'], variations: { a: 'A', b: 'B', c: 'C', [CODE_DEFAULT]: null },
      base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [
        { ruleKey: 'split', name: 'Checkout test', locked: false, disabled: false, conditions: [{ field: 'device.platform', op: 'in', values: ['web'] }], serveVariation: null,
          split: { by, fallbackBy: null, salt: 'checkout_test', hashVersion: 2, ranges } },
      ] },
      entities: { vandelay: { version: 1, enabled: null, variationWhenOff: null, defaultVariation: 'c', inherit: 'base_rules_then_customer_default', rules: [] } },
    };
    const snap = snapOf({ checkout_test: f });
    for (const entity of [null, 'vandelay', 'wonka']) {
      const doc = buildFlagdDoc(snap, 'server-ds', entity ? ENTITIES[entity] : null);
      assert.deepEqual(fractionalWeights(doc.flags.checkout_test.targeting), [10000, 10000, 10000], 'one fractional per part, out of 10000');
      const got: Record<string, number> = {};
      for (let i = 0; i < 3000; i++) {
        const attrs = { 'device.platform': i % 10 === 0 ? 'android' : 'web', [by]: `${by}-${i}` };
        const want = ours(snap, 'checkout_test', 'server-ds', entity, attrs);
        assert.equal(same(flagdCore(doc, 'checkout_test', nest(attrs))), same(want), `flagd-core, ${by}, ${entity}, ${i}`);
        assert.equal(same(flagdEvaluate(doc, 'checkout_test', nest(attrs))), same(want), `${by}, ${entity}, ${i}`);
        if (attrs['device.platform'] === 'web') got[String(want.value)] = (got[String(want.value)] ?? 0) + 1;
      }
      // the shares come out as set: 50%, 25%, 25% of the 2,700 web devices
      for (const [v, share] of [['A', 0.5], ['B', 0.25], ['C', 0.25]] as const) assert.ok(Math.abs((got[v] ?? 0) / 2700 - share) < 0.04, `${v}: ${got[v]} of 2700`);
      // with no ID to split by, the rule doesn't match: the default decides
      const none = { 'device.platform': 'web' };
      assert.equal(same(flagdCore(doc, 'checkout_test', nest(none))), same(ours(snap, 'checkout_test', 'server-ds', entity, none)));
    }
  }
});
