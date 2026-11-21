// The evaluator module, tested through its interface with hand-built snapshots (no server, no database): the entity
// chain on company › brand for every brand choice × company choice, and the two walkers of it (evaluate, forEntity)
// agreeing, also on what the server works out itself (the entity, those above it, the app). Plus one check against the
// seeded data with brands added: the entity page's answer and evaluate() never disagree. Chains of 1–4 dimensions are
// in chain.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlagdDoc } from '../server/flagd.ts';
import { cdnAnswer, ours } from './flagdReference.ts';
import {
  answerFor, CODE_DEFAULT, contextFor, entityChain, evaluate, forEntity, UnknownEntityError,
  type Condition, type FlagDef, type Inherit, type Layer, type Rule, type Snapshot,
} from '../server/evaluator.ts';
import { sourceText } from '../server/words.ts';
import { boot } from './helpers.ts';
import { entities, snapshotOf } from './kit.ts';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const rule = (r: Partial<Rule>): Rule => ({ ruleKey: uuid(), name: null, locked: false, disabled: false, conditions: [], serveVariation: null, split: null, ...r });
const layer = (l: Partial<Layer>): Layer => ({ version: 1, enabled: null, variationWhenOff: null, defaultVariation: null, inherit: null, rules: [], ...l });
const flag = (base: Partial<Layer>, own: Record<string, Partial<Layer>> = {}): FlagDef => ({
  key: 'f', valueType: 'string', kind: 'config', delivery: ['android', 'web'],
  variations: { a: 'A', b: 'B', c: 'C', [CODE_DEFAULT]: null },
  base: layer({ enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', ...base }),
  entities: Object.fromEntries(Object.entries(own).map(([k, l]) => [k, layer(l)])),
});
const DIMS = ['company', 'brand'];
const W = { environment: 'dev', dimensions: DIMS };
const E = entities([['vandelay', 'Vandelay', 'company'], ['wonka', 'Wonka', 'company'], ['tyrell', 'Tyrell', 'company'],
  ['velvet', 'Velvet', 'brand', 'tyrell'], ['acme', 'Acme', 'company']]);
const MS = E.vandelay;
const WONKA = E.wonka;
const TYRELL = E.tyrell;
const VELVET = E.velvet;
const snapOf = (f: FlagDef): Snapshot => snapshotOf([f], E, DIMS);

test('a check on the entity is settled for that entity, whatever the comparison', () => {
  const f = flag({ rules: [rule({ conditions: [{ field: 'entity', op: 'starts_with', values: ['vande'] }], serveVariation: 'b' })] });
  assert.deepEqual(forEntity(f, W, MS), { gets: { variant: 'b', section: 'everyone_rule', owner: null, ruleKey: f.base.rules[0].ruleKey, ruleName: null, namesEntity: false }, exceptions: [] });
  assert.equal(forEntity(f, W, WONKA).gets.variant, 'a');
});

test('a check on the environment is settled too; checks on the request become exceptions', () => {
  const f = flag({ rules: [
    rule({ conditions: [{ field: 'environment', op: 'in', values: ['prod'] }], serveVariation: 'c' }),
    rule({ conditions: [{ field: 'app.version', op: 'semver_lt', values: ['5.0.0'] }], serveVariation: 'b' }),
  ] });
  const r = forEntity(f, W, MS);
  assert.equal(r.gets.variant, 'a');
  assert.deepEqual(r.exceptions.map((e) => [e.variant, e.when.map((c) => c.field)]), [['b', ['app.version']]]);
});

test('every group of a % of devices rule is an exception, not just the first', () => {
  const f = flag({ rules: [rule({ split: { by: 'device.id', fallbackBy: null, salt: 's', hashVersion: 2, ranges: [{ variation: 'b', from: 0, to: 1000 }, { variation: 'c', from: 1000, to: 3000 }] } })] });
  assert.deepEqual(forEntity(f, W, MS).exceptions.map((e) => [e.variant, e.percent]), [['b', 10], ['c', 20]]);
});

test('the choices follow the evaluator: a default after the rules for everyone loses to them', () => {
  const everyoneRule = rule({ conditions: [], serveVariation: 'c' });
  const later = flag({ rules: [everyoneRule] }, { vandelay: { inherit: 'base_rules_then_customer_default', defaultVariation: 'b' } });
  const only = flag({ rules: [everyoneRule] }, { vandelay: { inherit: 'customer_only', defaultVariation: 'b' } });
  assert.deepEqual([forEntity(later, W, MS).gets.variant, forEntity(later, W, MS).gets.section], ['c', 'everyone_rule']);
  assert.deepEqual([forEntity(only, W, MS).gets.variant, forEntity(only, W, MS).gets.section, forEntity(only, W, MS).gets.owner], ['b', 'entity_default', 'vandelay']);
});

test('evaluate() says which section decided, and words.ts names it', () => {
  const ctx = { environment: 'dev', project: 'android', entity: MS, attrs: {} };
  const named = rule({ conditions: [{ field: 'entity', op: 'in', values: ['vandelay'] }], serveVariation: 'b' });
  const f = flag({ rules: [named] });
  const r = evaluate(snapOf(f), 'f', ctx);
  assert.deepEqual(r.decidedBy, { section: 'everyone_rule', owner: null, ruleKey: named.ruleKey, ruleName: null, namesEntity: true });
  assert.equal(sourceText(r.decidedBy, { entity: { key: 'vandelay', name: 'Vandelay', above: [] } }), 'Rule naming Vandelay');
  assert.equal(sourceText(r.decidedBy), 'Rule for everyone');
  assert.equal(evaluate(snapOf(flag({ enabled: false })), 'f', ctx).decidedBy.section, 'off');
  assert.equal(evaluate(snapOf(f), 'f', { ...ctx, project: 'ios' }).decidedBy.section, 'not_sent');
  assert.equal(sourceText(evaluate(snapOf(f), 'f', { ...ctx, project: 'ios' }).decidedBy, { project: 'ios' }), 'Not in ios');
});

test('who is asking: the console simulates exactly what the app would send', () => {
  const snap = snapOf(flag({}));
  const sent = { 'app.version': '6.2.0', project: 'spoofed', entity: 'wonka', company: 'wonka', brand: 'velvet',
    environment: 'prod', unknown: 1, 'device.id': '' };
  const app = contextFor(snap, { project: 'android', entity: 'vandelay' }, sent);
  assert.deepEqual(app.attrs, { 'app.version': '6.2.0' }, 'spoofed fields dropped, nothing filled in');
  assert.deepEqual(contextFor(snap, { project: 'android', entity: 'vandelay' }, { ...sent, 'device.platform': 'android' }).attrs,
    { 'app.version': '6.2.0', 'device.platform': 'android' });
  assert.throws(() => contextFor(snap, { project: 'web', entity: 'nope' }, {}), UnknownEntityError);
});

test('one evaluator: a console simulation of an app named "web" gets no platform the request didn’t send', () => {
  // "Platform is web": a real request from the web app that sends no platform doesn't match it, so the console doesn't
  const f = flag({ rules: [rule({ serveVariation: 'b', conditions: [{ field: 'device.platform', op: 'in', values: ['web'] }] })], defaultVariation: 'a' });
  const snap = snapOf(f);
  const asked = (attrs: Record<string, unknown>) => evaluate(snap, 'f', contextFor(snap, { project: 'web', entity: null }, attrs), false).value;
  assert.equal(asked({}), ours(snap, 'f', 'web', null, {}).value);
  assert.equal(asked({}), 'A', 'not sent: no match, in the console as on a device');
  assert.equal(asked({ 'device.platform': 'web' }), 'B', 'the console’s Device details say it: a match');
  assert.equal(ours(snap, 'f', 'web', null, { 'device.platform': 'web' }).value, 'B');
  // and the web app's CDN file, read by flagd
  const file = buildFlagdDoc(snap, 'web', null);
  assert.equal(cdnAnswer(file, 'f', {}).value, 'A');
  assert.equal(cdnAnswer(file, 'f', { 'device.platform': 'web' }).value, 'B');
});

// ---- the entity chain on company › brand: every brand choice × company choice ------------------

const MODES: (Inherit | null)[] = [null, 'base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only'];
const own = (mode: Inherit, serve: string, rules: Rule[]): Partial<Layer> =>
  ({ inherit: mode, defaultVariation: mode === 'base_rules_then_base_default' ? null : serve, rules });

/** The documented order (docs/design/dimensions.md "The order a request is decided in"), written out plainly for a brand:
 *  each level as [level, owner, set, skipped by], and whose default it ends in. */
function documented(brand: Inherit | null, company: Inherit | null) {
  const brandStops = brand === 'customer_only';
  const companyStops = !brandStops && company === 'customer_only';
  const levels = [
    ['override', null, true, null],
    ['entity', 'velvet', !!brand, null],
    ['entity', 'tyrell', !!company, brandStops ? 'velvet' : null],
    ['everyone', null, true, brandStops ? 'velvet' : companyStops ? 'tyrell' : null],
  ];
  const hasDefault = (m: Inherit | null) => m === 'base_rules_then_customer_default' || m === 'customer_only';
  const def = hasDefault(brand) ? 'velvet' : !brandStops && hasDefault(company) ? 'tyrell' : null;
  return { levels, default: def };
}

test('the entity chain for a brand: every brand choice × company choice gives the documented levels, skips and default', () => {
  for (const company of MODES) for (const brand of MODES) {
    const layers: Record<string, Partial<Layer>> = {};
    if (company) layers.tyrell = own(company, 'c', [rule({ serveVariation: 'c', conditions: [{ field: 'app.version', op: 'semver_lt', values: ['2.0.0'] }] })]);
    if (brand) layers.velvet = own(brand, 'b', [rule({ serveVariation: 'b', conditions: [{ field: 'app.version', op: 'semver_lt', values: ['1.0.0'] }] })]);
    const f = flag({ rules: [rule({ locked: true, serveVariation: 'a', conditions: [{ field: 'device.platform', op: 'in', values: ['tv'] }] }), rule({ serveVariation: 'c' })] }, layers);
    const chain = entityChain(f, VELVET);
    const want = documented(brand, company);
    const where = `brand=${brand} company=${company}`;
    assert.deepEqual(chain.levels.map((l) => [l.level, l.owner, l.set, l.skippedBy]), want.levels, where);
    assert.deepEqual(chain.levels.map((l) => l.distance), [null, 0, 1, null], where);
    assert.deepEqual(chain.levels.map((l) => l.rules.length), [1, brand ? 1 : 0, company ? 1 : 0, 1], `${where}: the override is the overrides' level, the other rule everyone's`);
    assert.equal(chain.default.owner, want.default, where);
    assert.equal(chain.default.level, want.default ? 'entity' : 'everyone', where);
    assert.equal(chain.default.variant, want.default === 'velvet' ? 'b' : want.default === 'tyrell' ? 'c' : 'a', where);
    // a level stops the chain exactly when it uses "Own settings only" and isn't skipped itself
    assert.deepEqual(chain.levels.filter((l) => l.stops).map((l) => l.owner),
      brand === 'customer_only' ? ['velvet'] : company === 'customer_only' ? ['tyrell'] : [], where);
  }
});

test('the entity chain at the top: a company has no level above; no entity, only everyone’s levels', () => {
  const f = flag({}, { vandelay: { inherit: 'customer_only', defaultVariation: 'b' } });
  const ms = entityChain(f, MS);
  assert.deepEqual(ms.levels.map((l) => [l.level, l.skippedBy]), [['override', null], ['entity', null], ['everyone', 'vandelay']]);
  assert.deepEqual([ms.default.level, ms.default.owner, ms.default.variant, ms.default.section], ['entity', 'vandelay', 'b', 'entity_default']);
  const nobody = entityChain(f, null);
  assert.deepEqual(nobody.levels.map((l) => [l.level, l.set]), [['override', false], ['everyone', true]]);
  assert.deepEqual([nobody.default.level, nobody.default.variant, nobody.default.section], ['everyone', 'a', 'default']);
  // a brand's company is just an entity at the top: its own chain has nothing above it
  assert.deepEqual(entityChain(f, TYRELL).levels.map((l) => [l.level, l.owner]), [['override', null], ['entity', 'tyrell'], ['everyone', null]]);
});

test('every brand choice × company choice: evaluate() and the entity page answer agree for every request', () => {
  // rules that depend on the request at every level, including a % of devices, so forEntity has exceptions to keep
  const split = (salt: string, v: string): Rule['split'] => ({ by: 'device.id', fallbackBy: null, salt, hashVersion: 2, ranges: [{ variation: v, from: 0, to: 4000 }] });
  const devices = [{}, { 'app.version': '1.5.0' }, { 'app.version': '0.5.0', 'device.id': 'x' }, { 'device.platform': 'tv' },
    ...Array.from({ length: 24 }, (_, i) => ({ 'device.id': `d-${i}`, 'app.version': `${i % 3}.5.0` }))];
  let checked = 0;
  for (const company of MODES) for (const brand of MODES) {
    const layers: Record<string, Partial<Layer>> = {};
    if (company) layers.tyrell = own(company, 'c', [rule({ serveVariation: 'c', conditions: [{ field: 'app.version', op: 'semver_lt', values: ['2.0.0'] }] }), rule({ split: split('co', 'a') })]);
    if (brand) layers.velvet = own(brand, 'b', [rule({ serveVariation: 'b', conditions: [{ field: 'app.version', op: 'semver_lt', values: ['1.0.0'] }] }), rule({ split: split('br', 'c') })]);
    const f = flag({ rules: [rule({ locked: true, serveVariation: 'a', conditions: [{ field: 'device.platform', op: 'in', values: ['tv'] }] }), rule({ split: split('ev', 'b') })] }, layers);
    const snap = snapOf(f);
    for (const entity of [VELVET, TYRELL, null]) {
      const answer = forEntity(f, W, entity);
      for (const attrs of devices) {
        const ctx = { environment: 'dev', project: 'web', entity, attrs };
        const real = evaluate(snap, 'f', ctx, false);
        const page = answerFor(f, answer, ctx);
        const where = `brand=${brand} company=${company} ${entity?.key} ${JSON.stringify(attrs)}`;
        assert.deepEqual([page.variant, page.section, page.owner], [real.variant, real.decidedBy.section, real.decidedBy.owner], where);
        assert.deepEqual(evaluate(snap, 'f', ctx).decidedBy, real.decidedBy, `explained: ${where}`);
        checked++;
      }
    }
  }
  assert.equal(checked, MODES.length * MODES.length * 3 * devices.length);
});

test('a skipped level is shown as skipped in the trace, and its rules never run', () => {
  const companyRule = rule({ serveVariation: 'c' });
  const f = flag({ rules: [rule({ serveVariation: 'c' })] }, { velvet: { inherit: 'customer_only', defaultVariation: 'b' }, tyrell: { inherit: 'base_rules_then_base_default', rules: [companyRule] } });
  const r = evaluate(snapOf(f), 'f', { environment: 'dev', project: 'web', entity: VELVET, attrs: {} });
  assert.deepEqual([r.variant, r.decidedBy.section, r.decidedBy.owner, r.metadata.layer, r.metadata.owner, r.metadata['layerVersion.tyrell']],
    ['b', 'entity_default', 'velvet', 'entity', 'velvet', undefined]);
  assert.equal(r.metadata['layerVersion.velvet'], 1);
  assert.deepEqual(r.trace.filter((s) => s.outcome === 'skipped').map((s) => [s.stage, s.owner ?? null, s.ruleKey === companyRule.ruleKey]),
    [['entity', 'tyrell', true], ['base', null, false]]);
  assert.ok(r.trace.every((s) => s.outcome !== 'skipped' || /"Velvet" uses only its own settings/.test(s.detail)));
});

// ---- what the server works out: one resolver each (server/fields.ts), in both walks ---------------

test('the entity, its company and its brand, at each level: evaluate() and the CDN file agree', () => {
  const ACME = E.acme;
  const who = [VELVET, TYRELL, ACME, null];
  // what each check finds for [Velvet, Tyrell, Acme, no entity], and whether it matches. Below the asker's own level a
  // dimension is "none" (null in the trace): known, not missing
  const cases: [Condition, unknown[], boolean[]][] = [
    [{ field: 'entity', op: 'in', values: ['velvet'] }, ['velvet', 'tyrell', 'acme', null], [true, false, false, false]],
    [{ field: 'entity', op: 'in', values: ['tyrell'] }, ['velvet', 'tyrell', 'acme', null], [false, true, false, false]],
    [{ field: 'company', op: 'in', values: ['tyrell'] }, ['tyrell', 'tyrell', 'acme', null], [true, true, false, false]],
    [{ field: 'company', op: 'not_in', values: ['tyrell'] }, ['tyrell', 'tyrell', 'acme', null], [false, false, true, false]],
    [{ field: 'company', op: 'starts_with', values: ['tyr'] }, ['tyrell', 'tyrell', 'acme', null], [true, true, false, false]],
    [{ field: 'company', op: 'missing' }, ['tyrell', 'tyrell', 'acme', null], [false, false, false, true]],
    [{ field: 'brand', op: 'in', values: ['velvet'] }, ['velvet', null, null, null], [true, false, false, false]],
    [{ field: 'brand', op: 'not_in', values: ['velvet'] }, ['velvet', null, null, null], [false, true, true, false]],
    [{ field: 'brand', op: 'missing' }, ['velvet', null, null, null], [false, true, true, true]],
    [{ field: 'brand', op: 'exists' }, ['velvet', null, null, null], [true, false, false, false]],
  ];
  for (const [check, found, matches] of cases) {
    const named = rule({ conditions: [check], serveVariation: 'b' });
    const f = flag({ rules: [named] });
    const snap = snapOf(f);
    who.forEach((entity, i) => {
      const where = `${check.field} ${check.op} ${check.values ?? ''} for ${entity?.key ?? 'no entity'}`;
      const full = evaluate(snap, 'f', { environment: 'dev', project: 'web', entity, attrs: {} });
      assert.equal(full.trace.find((s) => s.ruleKey === named.ruleKey)!.conditions![0].actual, found[i], `found: ${where}`);
      assert.equal(full.variant, matches[i] ? 'b' : 'a', where);
      const page = forEntity(f, W, entity);
      assert.deepEqual([page.gets.variant, page.gets.namesEntity, page.exceptions], [full.variant, full.decidedBy.namesEntity, []], `settled on the server: ${where}`);
      assert.deepEqual(buildFlagdDoc(snap, 'web', entity).flags.f, { state: 'ENABLED', variants: matches[i] ? { b: 'B' } : { a: 'A' }, defaultVariant: matches[i] ? 'b' : 'a' },
        `the CDN file, with no check on the entity: ${where}`);
    });
  }
  // a rule naming them: "Company is Tyrell" names Velvet and Tyrell; "Company or brand is Tyrell" only Tyrell
  const naming = (c: Condition) => who.map((x) => forEntity(flag({ rules: [rule({ conditions: [c], serveVariation: 'b' })] }), W, x).gets.namesEntity);
  assert.deepEqual(naming({ field: 'company', op: 'in', values: ['tyrell'] }), [true, true, false, false]);
  assert.deepEqual(naming({ field: 'entity', op: 'in', values: ['tyrell'] }), [false, true, false, false]);
  assert.deepEqual(naming({ field: 'brand', op: 'in', values: ['velvet'] }), [true, false, false, false]);
});

test('below the asker’s level a dimension is none: an override on it doesn’t match; with no entity overrides fail closed', () => {
  const f = flag({ rules: [rule({ locked: true, conditions: [{ field: 'brand', op: 'in', values: ['velvet'] }], serveVariation: 'b' })] });
  const at = (entity: typeof VELVET | null) => evaluate(snapOf(f), 'f', { environment: 'dev', project: 'web', entity, attrs: {} });
  assert.equal(at(VELVET).variant, 'b');
  assert.equal(at(TYRELL).variant, 'a', 'the company’s own file: there is no brand, so “Brand is Velvet” is false even in an override');
  assert.match(at(TYRELL).trace.find((s) => s.stage === 'locked')!.conditions![0].note!, /none/);
  assert.equal(at(null).variant, 'b', 'no entity at all (before login): missing, so the override matches, as it always did');
  for (const entity of [VELVET, TYRELL, null]) {
    assert.equal(cdnAnswer(buildFlagdDoc(snapOf(f), 'web', entity), 'f').value, at(entity).value, `the CDN file agrees for ${entity?.key}`);
  }
  // a % by a dimension the asker has none of: no value to split by, so it doesn't apply
  const byBrand = flag({ rules: [rule({ split: { by: 'brand', fallbackBy: null, salt: 's', hashVersion: 2, ranges: [{ variation: 'c', from: 0, to: 10000 }] } })] });
  assert.equal(evaluate(snapOf(byBrand), 'f', { environment: 'dev', project: 'web', entity: TYRELL, attrs: {} }).variant, 'a');
  assert.equal(evaluate(snapOf(byBrand), 'f', { environment: 'dev', project: 'web', entity: VELVET, attrs: {} }).variant, 'c');
  assert.deepEqual(forEntity(byBrand, W, TYRELL), { gets: { variant: 'a', section: 'default', owner: null, ruleKey: null, ruleName: null, namesEntity: false }, exceptions: [] });
});

test('the app is settled in a CDN file (one app) and waits for the request on the entity page (any app)', () => {
  const f = flag({ rules: [rule({ conditions: [{ field: 'project', op: 'in', values: ['web'] }], serveVariation: 'b' })] });
  const page = forEntity(f, W, VELVET);
  assert.deepEqual([page.gets.variant, page.exceptions.map((e) => [e.variant, e.when.map((c) => c.field)])], ['a', [['b', ['project']]]]);
  assert.deepEqual([forEntity(f, W, VELVET, { project: 'web' }), forEntity(f, W, VELVET, { project: 'android' })].map((a) => [a.gets.variant, a.exceptions.length]), [['b', 0], ['a', 0]]);
  for (const project of ['web', 'android']) {
    assert.equal(answerFor(f, page, { environment: 'dev', project, entity: VELVET, attrs: {} }).variant,
      evaluate(snapOf(f), 'f', { environment: 'dev', project, entity: VELVET, attrs: {} }).variant, project);
  }
});

// ---- against the seeded flags, with brands added ---------------------------------------------

let t: Awaited<ReturnType<typeof boot>>;
before(async () => {
  t = await boot();
  const dana = t.as('dana');
  assert.equal((await dana.post('/dimensions/company', { key: 'tyrell', name: 'Tyrell' })).status, 201);
  for (const c of [{ key: 'velvet', name: 'Velvet', parent: 'tyrell' }, { key: 'onyx', name: 'Onyx', parent: 'tyrell' }]) {
    assert.equal((await dana.post('/dimensions/brand', c)).status, 201);
  }
  // each choice for a company and for a brand somewhere, with rules on what only the request knows
  const r = (conditions: object[], serve: string | null, split?: object) => ({ ruleKey: crypto.randomUUID(), name: null, locked: false, disabled: false, conditions, serveVariation: serve, split: split ?? null });
  const layers: [string, string, object][] = [
    ['new_checkout', 'tyrell', { inherit: 'customer_only', defaultVariation: 'on', rules: [r([{ field: 'app.version', op: 'semver_lt', values: ['6.0.0'] }], 'off')] }],
    ['new_checkout', 'velvet', { inherit: 'base_rules_then_customer_default', defaultVariation: 'off', rules: [r([{ field: 'device.platform', op: 'in', values: ['ios'] }], 'on')] }],
    ['dark_mode_v2', 'tyrell', { inherit: 'base_rules_then_customer_default', defaultVariation: 'on', rules: [] }],
    ['dark_mode_v2', 'velvet', { inherit: 'base_rules_then_base_default', defaultVariation: null, rules: [r([], null, { by: 'device.id', ranges: [{ variation: 'off', from: 0, to: 5000 }] })] }],
    ['data_region_host', 'tyrell', { inherit: 'customer_only', defaultVariation: 'eu', rules: [] }],
    ['data_region_host', 'velvet', { inherit: 'base_rules_then_base_default', defaultVariation: null, rules: [r([{ field: 'project', op: 'in', values: ['web'] }], 'us')] }],
    ['max_upload_mb', 'tyrell', { inherit: 'base_rules_then_base_default', defaultVariation: null, rules: [r([{ field: 'project', op: 'in', values: ['android'] }], 'standard')] }],
    ['max_upload_mb', 'velvet', { inherit: 'customer_only', defaultVariation: 'huge', rules: [] }],
    ['welcome_message', 'tyrell', { inherit: 'base_rules_then_customer_default', defaultVariation: 'holiday', rules: [] }],
    ['welcome_message', 'onyx', { inherit: 'base_rules_then_base_default', defaultVariation: null, rules: [r([{ field: 'app.version', op: 'semver_gte', values: ['7.0.0'] }], 'beta')] }],
  ];
  for (const [flagKey, entity, layer] of layers) {
    const res = await dana.put(`/flags/${flagKey}/layers/dev/${entity}`, { layer, expectedVersion: null });
    assert.equal(res.status, 200, `${flagKey} ${entity}: ${JSON.stringify(res.json)}`);
  }
  await t.settle();
});
after(async () => { await t.stop(); });

test('the entity page answer and evaluate() agree for every flag, entity (brands included) and request', () => {
  const devices = [{}, { 'app.version': '4.9.3' }, { 'app.version': '6.2.0', 'device.id': 'd-1' }, { 'device.id': 'd-2', 'device.platform': 'ios' },
    ...Array.from({ length: 30 }, (_, i) => ({ 'device.id': `bulk-${i}`, 'app.version': `${4 + (i % 4)}.${i % 10}.0`, 'session.id': `s-${i}` }))];
  let checked = 0;
  for (const env of ['dev', 'prod']) {
    const snap = t.plane.get(env);
    assert.equal(snap.entities.velvet?.parent, 'tyrell', 'the brands are in the data');
    assert.deepEqual(snap.dimensions, ['company', 'brand']);
    for (const f of Object.values(snap.flags)) for (const entity of [null, ...Object.values(snap.entities)]) {
      const answer = forEntity(f, snap, entity);
      for (const project of ['android', 'ios', 'web', 'server-ds']) for (const attrs of devices) {
        const ctx = { environment: env, project, entity, attrs };
        const real = evaluate(snap, f.key, ctx, false);
        const page = answerFor(f, answer, ctx);
        assert.equal(page.variant, real.errorCode ? CODE_DEFAULT : real.variant, `${env} ${f.key} ${entity?.key} ${project} ${JSON.stringify(attrs)}`);
        assert.equal(page.section, real.decidedBy.section, `${env} ${f.key} ${entity?.key} ${project}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 5000, `checked ${checked}`);
});
