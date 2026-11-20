// Releases (server/release.ts, docs/design/releases.md): where a release is, read from its defaults; each step's
// defaults pass the server's own checks without a reshuffle; the devices that had it keep it as it grows; and end to
// end, the steps through the real API in an environment without review and in one with it, then cleaning up.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLayer, type FieldFacts } from '../server/checks.ts';
import type { Layer } from '../server/evaluator.ts';
import {
  applyChange, backChange, changeText, holdBacks, isRollback, isVersionRelease, nextChange, ownRules, readyToCleanUp, releaseState, stepText, type Change, type LayerLike, type Variant,
} from '../server/release.ts';
import { buildFlagdDoc } from '../server/flagd.ts';
import { bucketFor, HASH_VERSION } from '../server/hash.ts';
import { hiddenKey } from '../server/evaluator.ts';
import { cdnAnswer, flagdEvaluate, nest, ours, same } from './flagdReference.ts';
import { boot, deviceIn } from './helpers.ts';

const fields: FieldFacts = {
  project: { valueType: 'string', canSplitBy: false }, 'app.version': { valueType: 'semver', canSplitBy: false },
  'device.id': { valueType: 'string', canSplitBy: true }, 'session.id': { valueType: 'string', canSplitBy: true },
  entity: { valueType: 'string', canSplitBy: true },
};
const variants = [{ key: 'on', value: true }, { key: 'off', value: false }];
const flag = { key: 'rel', kind: 'release', variants: new Set(['on', 'off']) };
const LOCKED = { ruleKey: '00000000-0000-4000-8000-000000000001', name: 'Old android off', locked: true, disabled: false,
  conditions: [{ field: 'app.version', op: 'semver_lt', values: ['5.0.0'] }], serveVariation: 'off', split: null };
const OTHER = { ruleKey: '00000000-0000-4000-8000-000000000002', name: 'Web 6+', locked: false, disabled: false,
  conditions: [{ field: 'app.version', op: 'semver_gte', values: ['6.0.0'] }], serveVariation: 'off', split: null };
const start: LayerLike = { enabled: true, defaultVariation: 'off', rules: [LOCKED, OTHER] };

/** The step's defaults as the server would store them: checked against what was there before, no reshuffle confirmed. */
function step(prev: Layer, change: Change): Layer {
  const { layer, errors, reshuffles } = checkLayer(flag, fields, true, applyChange(variants, prev, change), prev);
  assert.deepEqual(errors, [], `${JSON.stringify(change)} is accepted`);
  assert.equal(reshuffles, false);
  return layer;
}
const stored = (doc: LayerLike) => checkLayer(flag, fields, true, doc, null).layer;

describe('where a release is', () => {
  test('each step read back from the defaults, with the others left where they were', () => {
    let l = stored(start);
    assert.equal(releaseState(variants, l).step, 'not_started');
    assert.deepEqual(nextChange(releaseState(variants, l)), { kind: 'percent', percent: 1 });
    l = step(l, { kind: 'entities', entities: ['acme', 'globex'] });
    let s = releaseState(variants, l);
    assert.deepEqual([s.step, s.entities, s.others], ['early', ['acme', 'globex'], 2]);
    assert.equal(stepText(s), '2 in early access');
    l = step(l, { kind: 'percent', percent: 5 });
    s = releaseState(variants, l);
    assert.deepEqual([s.step, s.percent, s.apps], ['percent', 5, null]);
    // overrides first, the other rule where it was, the early access before the %
    assert.deepEqual(l.rules.map((r) => r.name), ['Old android off', 'Web 6+', 'Early access', '5% of devices']);
    assert.deepEqual(ownRules(variants, l), [2, 3]);
    const salt = l.rules[3].split!.salt;
    assert.equal(salt, 'rel', 'the salt is the flag key');

    // the ladder, then everyone; each % moves only the range's end, on the same rule
    const key = l.rules[3].ruleKey;
    for (const p of [25, 50]) {
      assert.deepEqual(nextChange(releaseState(variants, l)), { kind: 'percent', percent: p });
      l = step(l, nextChange(releaseState(variants, l))!);
      assert.deepEqual([l.rules[3].ruleKey, l.rules[3].split!.ranges], [key, [{ variation: 'on', from: 0, to: p * 100 }]]);
    }
    assert.deepEqual(nextChange(releaseState(variants, l)), { kind: 'everyone' });
    l = step(l, { kind: 'everyone' });
    s = releaseState(variants, l);
    assert.equal(s.step, 'everyone');
    assert.equal(l.defaultVariation, 'on', 'the default reaches devices without an ID too');
    assert.deepEqual(l.rules.map((r) => r.name), ['Old android off', 'Web 6+'], 'the release’s rules are gone, the rest stay');
    assert.equal(nextChange(s), null);

    // back from everyone: 50% again, on the flag key's salt, so the same devices as before
    assert.deepEqual(backChange(s), { kind: 'percent', percent: 50 });
    l = step(l, { kind: 'percent', percent: 50 });
    assert.deepEqual([releaseState(variants, l).step, l.defaultVariation, l.rules[2].split!.salt], ['percent', 'off', salt]);
    // and down the ladder to none
    for (const p of [25, 5, 1, 0]) {
      l = step(l, backChange(releaseState(variants, l))!);
      assert.equal(releaseState(variants, l).percent, p || null);
    }
    assert.equal(releaseState(variants, l).step, 'not_started');
  });

  test('pause keeps the rules (and so the devices) for resume; a flag that is off is turned on only by the first step', () => {
    let l = stored({ ...start, enabled: false });
    l = step(l, { kind: 'percent', percent: 5 });
    assert.equal(l.enabled, true, 'starting a release that hadn’t started turns it on');
    const paused = step(l, { kind: 'pause' });
    assert.deepEqual([releaseState(variants, paused).paused, paused.rules.find((r) => r.split)!.disabled], [true, true]);
    assert.equal(nextChange(releaseState(variants, paused)), null, 'paused: resume first');
    assert.equal(stepText(releaseState(variants, paused)), 'Paused · 5% of devices');
    assert.deepEqual(step(paused, { kind: 'resume' }).rules, l.rules);
    // turned off mid-way: a step keeps it off
    const off = step({ ...l, enabled: false }, { kind: 'percent', percent: 25 });
    assert.equal(off.enabled, false);
    assert.equal(stepText(releaseState(variants, off)), 'Off · 25% of devices');
  });

  test('rules made on the flag page are read by their shape: a % on some apps, its own name, a backup ID', () => {
    const l = stored({ enabled: true, defaultVariation: 'off', rules: [
      { name: 'Beta customers', locked: false, disabled: false, conditions: [{ field: 'entity', op: 'in', values: ['wonka'] }], serveVariation: 'on', split: null },
      { name: '20% of android devices', locked: false, disabled: false, conditions: [{ field: 'project', op: 'in', values: ['android'] }], serveVariation: null,
        split: { by: 'device.id', fallbackBy: 'session.id', ranges: [{ variation: 'on', from: 0, to: 2000 }] } },
    ] });
    const s = releaseState(variants, l);
    assert.deepEqual([s.step, s.percent, s.apps, s.entities], ['percent', 20, ['android'], ['wonka']]);
    assert.equal(stepText(s), '20% of devices on android');
    assert.deepEqual(nextChange(s), { kind: 'percent', percent: 25 }, 'a % off the ladder goes to the next one on it');
    assert.deepEqual(backChange(s), { kind: 'percent', percent: 5 });
    const next = step(l, { kind: 'percent', percent: 25 });
    assert.deepEqual([next.rules[1].name, next.rules[1].split!.fallbackBy, next.rules[1].conditions], ['25% of android devices', 'session.id', l.rules[1].conditions]);
    assert.equal(changeText(s, releaseState(variants, next)), '20% → 25% of devices');
  });

  test('anything else is custom, and isn’t changed here', () => {
    const custom = (doc: Partial<LayerLike>, v: Variant[] = variants) => releaseState(v, { enabled: true, defaultVariation: 'off', rules: [], ...doc }).step;
    const split = (from: number, to: number) => ({ name: null, locked: false, disabled: false, conditions: [], serveVariation: null,
      split: { by: 'device.id', fallbackBy: null, ranges: [{ variation: 'on', from, to }] } });
    assert.equal(custom({ rules: [split(5000, 10000)] }), 'custom', 'a % that doesn’t start at 0');
    assert.equal(custom({ rules: [split(0, 1000), split(0, 2000)] }), 'custom', 'two % rules');
    assert.equal(custom({ defaultVariation: 'something' }), 'custom');
    assert.equal(custom({}, [{ key: 'a', value: 'x' }, { key: 'b', value: 'y' }]), 'custom', 'not an on/off release');
    assert.equal(custom({ defaultVariation: 'code_default' }), 'not_started', 'the in-app default counts as the old value');
    assert.throws(() => applyChange([{ key: 'a', value: 'x' }], start, { kind: 'everyone' }), /flag page/);
  });

  test('the words, and when a release is ready to clean up', () => {
    const at = (doc: Partial<LayerLike>) => releaseState(variants, { enabled: true, defaultVariation: 'off', rules: [], ...doc });
    const everyone = at({ defaultVariation: 'on' });
    assert.equal(changeText(null, everyone), 'Created · Everyone');
    assert.equal(changeText(at({}), at({ enabled: false })), 'Turned off');
    assert.equal(changeText(at({}), at({})), null);
    assert.equal(readyToCleanUp([{ state: everyone, sent: true }, { state: at({}), sent: false }]), true);
    assert.equal(readyToCleanUp([{ state: everyone, sent: true }, { state: at({}), sent: true }]), false);
    assert.equal(readyToCleanUp([{ state: { ...everyone, on: false }, sent: true }]), false);
    assert.equal(readyToCleanUp([{ state: everyone, sent: false }]), false, 'sent nowhere: nothing to clean up but archiving');
  });
});

describe('releases end to end', () => {
  let t: Awaited<ReturnType<typeof boot>>;
  before(async () => { t = await boot(); });
  after(async () => { await t.stop(); });

  /** Saves one step of a release in an environment, as the release page does. */
  const save = async (key: string, env: string, change: Change, as = 'alice') => {
    const f = (await t.as(as).get(`/flags/${key}`)).json;
    const base = f.layers[env].base;
    const r = await t.as(as).put(`/flags/${key}/layers/${env}/base`, { layer: applyChange(f.variations, base, change), expectedVersion: base.version, reason: 'step' });
    await t.settle();
    return r;
  };
  const has = async (env: string, entity: string, id: string | null) => (await t.trace({ environment: env, project: 'android', entity, flag: 'new_checkout',
    attrs: { 'app.version': '6.1.0', ...(id ? { 'device.id': id } : {}) } })).value;

  test('GET /releases: every release, where it is in each environment, and the filters', async () => {
    const list = (await t.as('alice').get('/releases?page=0')).json;
    const row = (key: string) => list.rows.find((r: any) => r.key === key);
    assert.deepEqual(list.environments, ['dev', 'prod']);
    assert.deepEqual(list.rows.map((r: any) => r.key).sort(), ['android_quick_share', 'dark_mode_v2', 'new_checkout']);
    assert.deepEqual([row('new_checkout').envs.dev.step, row('new_checkout').envs.dev.percent, row('new_checkout').envs.dev.text], ['percent', 20, '20% of devices on android']);
    assert.deepEqual(row('dark_mode_v2').envs.prod.entities, ['wonka', 'oscorp', 'globex']);
    assert.equal(row('android_quick_share').ready, true);
    const keys = async (q: string) => (await t.as('alice').get(`/releases?page=0&${q}`)).json.rows.map((r: any) => r.key).sort();
    assert.deepEqual(await keys('show=rolling'), ['dark_mode_v2', 'new_checkout']);
    assert.deepEqual(await keys('show=done'), ['android_quick_share']);
    assert.deepEqual(await keys('owner=design-team'), ['dark_mode_v2']);
    assert.deepEqual(await keys('q=checkout'), ['new_checkout']);
    assert.deepEqual(await keys('show=overdue'), []);
    assert.equal((await t.as('alice').put('/flags/dark_mode_v2/meta', { removeBy: '2020-01-31' })).status, 200);
    assert.deepEqual(await keys('show=overdue'), ['dark_mode_v2']);
    await t.as('alice').put('/flags/dark_mode_v2/meta', { removeBy: '2027-02-28' });
    await t.settle();
  });

  test('steps where nothing is reviewed: the devices that had it keep it, and everyone reaches devices without an ID', async () => {
    const at = (lo: number, hi: number) => deviceIn('new_checkout', lo, hi);
    const early = at(0, 500);       // inside 5%
    const later = at(2000, 2500);   // inside 25%, not 20%
    assert.equal(await has('dev', 'acme', early), true);
    assert.equal(await has('dev', 'acme', later), false);
    assert.equal((await save('new_checkout', 'dev', { kind: 'percent', percent: 25 })).status, 200);
    assert.deepEqual([await has('dev', 'acme', early), await has('dev', 'acme', later)], [true, true]);
    assert.equal((await save('new_checkout', 'dev', { kind: 'percent', percent: 5 })).status, 200);
    assert.deepEqual([await has('dev', 'acme', early), await has('dev', 'acme', later)], [true, false], 'back keeps the lowest buckets');
    await save('new_checkout', 'dev', { kind: 'pause' });
    assert.equal(await has('dev', 'acme', early), false);
    await save('new_checkout', 'dev', { kind: 'resume' });
    assert.equal(await has('dev', 'acme', early), true, 'resume brings back the same devices');
    assert.equal(await has('dev', 'acme', null), false, 'no device ID: not in the %');
    await save('new_checkout', 'dev', { kind: 'everyone' });
    assert.equal(await has('dev', 'acme', null), true, 'everyone: devices without an ID too');
    const old = await t.trace({ environment: 'dev', project: 'android', entity: 'acme', flag: 'new_checkout', attrs: { 'app.version': '4.0.0', 'device.id': early } });
    assert.equal(old.value, false, 'the override for old android builds still wins');
    await save('new_checkout', 'dev', { kind: 'percent', percent: 50 });
    assert.deepEqual([await has('dev', 'acme', at(0, 5000)), await has('dev', 'acme', at(5000, 10000))], [true, false], 'back from everyone: the same half');
    // the timeline reads the history in release words
    const h = (await t.as('alice').get('/history?flag=new_checkout&environment=dev')).json.filter((r: any) => r.changeType === 'layer.update' && !r.entity);
    const v = [{ key: 'on', value: true }, { key: 'off', value: false }];
    // (back from everyone is 50% of every app's devices: a % made on the flag page for some apps went at everyone)
    assert.deepEqual(h.slice(0, 3).map((r: any) => changeText(releaseState(v, r.before), releaseState(v, r.after))),
      ['Everyone → 50% of devices', '5% of devices on android → Everyone', 'Resumed']);
  });

  test('steps where changes are reviewed: each is a request; a second one on the same version conflicts', async () => {
    assert.equal((await t.as('alice').get('/change-sets?flag=new_checkout')).json.length, 0);
    const first = await save('new_checkout', 'prod', { kind: 'percent', percent: 25 });
    assert.equal(first.status, 202);
    const second = await save('new_checkout', 'prod', { kind: 'everyone' });
    assert.equal(second.status, 202);
    const mine = (await t.as('alice').get('/change-sets?flag=new_checkout')).json;
    assert.deepEqual(mine.map((r: any) => r.id).sort(), [first.json.changeSetId, second.json.changeSetId].sort());
    assert.equal((await t.as('alice').get('/change-sets?flag=dark_mode_v2')).json.length, 0);
    const row = (await t.as('alice').get('/releases?page=0&q=new_checkout')).json.rows[0];
    assert.equal(row.envs.prod.waiting.id, second.json.changeSetId, 'the list shows the newest open request');
    for (const id of [first.json.changeSetId, second.json.changeSetId]) {
      assert.equal((await t.as('bob').post(`/change-sets/${id}/review`, { decision: 'approve' })).status, 200);
    }
    assert.equal((await t.as('alice').post(`/change-sets/${first.json.changeSetId}/apply`)).status, 200);
    await t.settle();
    assert.equal((await t.as('alice').post(`/change-sets/${second.json.changeSetId}/apply`)).status, 409, 'made against the version before');
    const f = (await t.as('alice').get('/flags/new_checkout')).json;
    assert.equal(releaseState(f.variations, f.layers.prod.base).percent, 25);
  });

  test('cleaning up: one request stops sending it where changes are reviewed, then archive', async () => {
    const f = (await t.as('alice').get('/flags/android_quick_share')).json;
    const base = f.layers.prod.base;
    assert.equal((await t.as('alice').post('/flags/android_quick_share/archive')).status, 409, 'still on and sent in prod');
    const cs = await t.as('alice').post('/change-sets', { environment: 'prod', reason: 'clean up', items: [
      { flag: 'android_quick_share', entity: null, expectedLayerVersion: base.version, proposed: { ...base, enabled: false } },
      { kind: 'delivery', flag: 'android_quick_share', entity: null, expectedLayerVersion: null, proposed: null, delivery: { before: f.delivery.prod, projects: [] } },
    ] });
    assert.equal(cs.status, 201, JSON.stringify(cs.json));
    await t.as('bob').post(`/change-sets/${cs.json.id}/review`, { decision: 'approve' });
    const applied = await t.as('alice').post(`/change-sets/${cs.json.id}/apply`);
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    await t.settle();
    const after = (await t.as('alice').get('/flags/android_quick_share')).json;
    assert.deepEqual([after.layers.prod.base.enabled, after.delivery.prod], [false, []], 'both in one version');
    assert.equal((await t.as('alice').post('/flags/android_quick_share/archive')).status, 200);
    await t.settle();
    assert.ok(!(await t.as('alice').get('/releases?page=0')).json.rows.some((r: any) => r.key === 'android_quick_share'));
  });

  test('a new release from the form starts not started everywhere, off where changes are reviewed', async () => {
    const r = await t.as('alice').post('/flags', {
      key: 'new_search', name: 'New search', tags: [], owner: 'search-team', description: '', kind: 'release', valueType: 'bool', removeBy: '2027-03-01',
      variations: [{ key: 'on', value: true }, { key: 'off', value: false }], delivery: { dev: ['web'], prod: ['web'] },
      base: { enabled: true, defaultVariation: 'off', rules: [] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    await t.settle();
    const row = (await t.as('alice').get('/releases?page=0&q=new_search')).json.rows[0];
    assert.deepEqual([row.envs.dev.step, row.envs.dev.on, row.envs.prod.step, row.envs.prod.on], ['not_started', true, 'not_started', false]);
    assert.equal((await save('new_search', 'dev', { kind: 'entities', entities: ['acme'] })).status, 200);
    assert.equal((await t.trace({ project: 'web', entity: 'acme', flag: 'new_search' })).value, true);
    assert.equal((await t.trace({ project: 'web', entity: 'globex', flag: 'new_search' })).value, false);
    // the list in one environment: rolling out in dev, not started in prod
    const keys = async (q: string) => (await t.as('alice').get(`/releases?page=0&q=new_search&${q}`)).json.rows.map((r: any) => r.key);
    assert.deepEqual(await keys('show=rolling&environment=dev'), ['new_search']);
    assert.deepEqual(await keys('show=rolling&environment=prod'), []);
    assert.deepEqual(await keys('show=not_started&environment=prod'), ['new_search']);
    assert.deepEqual(await keys('show=not_started'), [], 'without an environment: not started in every one');
  });
});

// ---- version releases (docs/design/release-versions.md) ------------------------------------------------------------
// a version release's values are free values: each version is a hidden, content-addressed variant (evaluator.ts hiddenKey)
const k = (version: string) => hiddenKey(version);
const versionsOf = (...list: string[]): Variant[] => list.map((v) => ({ key: k(v), value: v }));
const HOLD = { ruleKey: '00000000-0000-4000-8000-000000000003', name: 'Older apps', locked: false, disabled: false,
  conditions: [{ field: 'app.version', op: 'semver_lt', values: ['5.2.0'] }], serveVariation: k('1.0.0'), split: null };

/** A version release's step, as the server would store it: no errors, no reshuffle. */
function vstep(vs: Variant[], prev: Layer, change: Change): Layer {
  const facts = { key: 'web_bundle', kind: 'release', variants: new Set(vs.map((v) => v.key)) };
  const { layer, errors, reshuffles } = checkLayer(facts, fields, true, applyChange(vs, prev, change, 'web_bundle'), prev);
  assert.deepEqual(errors, [], `${JSON.stringify(change)} is accepted`);
  assert.equal(reshuffles, false);
  return layer;
}
const vstored = (vs: Variant[], doc: LayerLike) => checkLayer({ key: 'web_bundle', kind: 'release', variants: new Set(vs.map((v) => v.key)) }, fields, true, doc, null).layer;

describe('where a version release is', () => {
  const one = versionsOf('1.0.0');
  const two = versionsOf('1.0.0', '1.0.1');
  const three = versionsOf('1.0.0', '1.0.1', '1.0.2');

  test('its default is the version everyone is on; a higher one is ready; the % is salted with the version', () => {
    let l = vstored(one, { enabled: true, defaultVariation: k('1.0.0'), rules: [HOLD] });
    let s = releaseState(one, l);
    assert.deepEqual([s.step, s.versions], ['everyone', { current: '1.0.0', target: null, all: ['1.0.0'] }]);
    assert.equal(stepText(s), 'Everyone on 1.0.0');
    assert.deepEqual([nextChange(s), backChange(s)], [null, null]);
    assert.throws(() => applyChange(one, l, { kind: 'percent', percent: 1 }, 'web_bundle'), /add one first/);
    assert.equal(isVersionRelease(one), true);
    assert.equal(isVersionRelease(variants), false);

    s = releaseState(two, l);
    assert.deepEqual([s.step, s.versions?.target, stepText(s)], ['not_started', '1.0.1', '1.0.0 · 1.0.1 ready']);
    assert.deepEqual(nextChange(s), { kind: 'percent', percent: 1 });
    const before = s;
    l = vstep(two, l, { kind: 'percent', percent: 1 });
    s = releaseState(two, l);
    assert.deepEqual(l.rules.map((r) => r.name), ['Older apps', '1% of devices'], 'the hold-back stays first');
    assert.deepEqual([l.rules[1].split!.salt, l.rules[1].split!.ranges], ['web_bundle/1.0.1', [{ variation: k('1.0.1'), from: 0, to: 100 }]]);
    assert.deepEqual([s.step, s.percent, stepText(s)], ['percent', 1, '1.0.0 → 1.0.1 · 1% of devices']);
    assert.equal(changeText(before, s), 'Started 1.0.1 at 1% of devices');
    assert.deepEqual(holdBacks(two, l), ['Apps below 5.2.0 stay on 1.0.0']);

    l = vstep(two, l, { kind: 'entities', entities: ['acme'] });
    assert.deepEqual(l.rules.map((r) => r.name), ['Older apps', 'Early access', '1% of devices']);
    assert.equal(l.rules[1].serveVariation, k('1.0.1'));
    const key = l.rules[2].ruleKey;
    for (const p of [5, 25, 50]) {
      const was = releaseState(two, l);
      l = vstep(two, l, nextChange(was)!);
      assert.deepEqual([l.rules[2].ruleKey, l.rules[2].split!.salt, l.rules[2].split!.ranges[0].to], [key, 'web_bundle/1.0.1', p * 100]);
      if (p === 25) assert.equal(changeText(was, releaseState(two, l)), '1.0.1: 5% → 25% of devices');
    }
    assert.deepEqual(nextChange(releaseState(two, l)), { kind: 'everyone' });
    const at50 = releaseState(two, l);
    l = vstep(two, l, { kind: 'everyone' });
    s = releaseState(two, l);
    assert.deepEqual([l.defaultVariation, l.rules.map((r) => r.name), s.step, stepText(s)], [k('1.0.1'), ['Older apps'], 'everyone', 'Everyone on 1.0.1']);
    assert.equal(changeText(at50, s), 'Released 1.0.1 to everyone');
    assert.equal(backChange(s), null, 'no back to 50%: a version rolls back to the one before');

    // the next version starts on its own salt: new devices first
    s = releaseState(three, l);
    assert.deepEqual([s.step, s.versions?.current, s.versions?.target], ['not_started', '1.0.1', '1.0.2']);
    l = vstep(three, l, { kind: 'percent', percent: 1 });
    assert.equal(l.rules[1].split!.salt, 'web_bundle/1.0.2');
    // released to everyone in one step, from wherever it is
    l = vstep(three, l, { kind: 'everyone' });
    assert.equal(l.defaultVariation, k('1.0.2'));
    assert.throws(() => applyChange(three, l, { kind: 'everyone', version: '1.0.2' }), /already/);
    assert.throws(() => applyChange(three, l, { kind: 'everyone', version: '9.9.9' }), /isn’t one of this release’s versions/);
  });

  test('rolled back keeps the devices for resume; resume with a higher version moves those same devices', () => {
    let l = vstored(three, { enabled: true, defaultVariation: k('1.0.0'), rules: [] });
    l = vstep(three, l, { kind: 'percent', percent: 25 });
    // the newest is the one ready, so 1.0.2 moves; swap to 1.0.1 to walk the hotfix
    assert.equal(releaseState(three, l).versions?.target, '1.0.2');
    l = vstored(three, { enabled: true, defaultVariation: k('1.0.0'), rules: [
      { name: '25% of devices', locked: false, disabled: false, conditions: [], serveVariation: null,
        split: { by: 'device.id', fallbackBy: null, salt: 'web_bundle/1.0.1', ranges: [{ variation: k('1.0.1'), from: 0, to: 2500 }] } }] });
    const moving = releaseState(three, l);
    assert.deepEqual([moving.step, moving.versions?.target], ['percent', '1.0.1'], 'what the rules serve is what moves, not the newest');
    const paused = vstep(three, l, { kind: 'pause' });
    const ps = releaseState(three, paused);
    assert.deepEqual([ps.paused, ps.versions?.target], [true, '1.0.1']);
    assert.equal(stepText(ps), 'Rolled back to 1.0.0 · 1.0.1 paused at 25% of devices');
    assert.equal(changeText(moving, ps), 'Rolled back to 1.0.0 (1.0.1 paused at 25% of devices)');
    const resumed = vstep(three, paused, { kind: 'resume', version: '1.0.2' });
    const rule = resumed.rules[0];
    assert.deepEqual([rule.ruleKey, rule.disabled, rule.split!.salt, rule.split!.ranges], [l.rules[0].ruleKey, false, 'web_bundle/1.0.1', [{ variation: k('1.0.2'), from: 0, to: 2500 }]]);
    assert.equal(changeText(ps, releaseState(three, resumed)), 'Resumed with 1.0.2 at 25% of devices');
    assert.equal(changeText(ps, releaseState(three, vstep(three, paused, { kind: 'resume' }))), 'Resumed 1.0.1 at 25% of devices');
    const replaced = vstep(three, l, { kind: 'replace', version: '1.0.2' });
    assert.equal(changeText(moving, releaseState(three, replaced)), 'Replaced 1.0.1 with 1.0.2');
    assert.throws(() => applyChange(three, l, { kind: 'replace', version: '1.0.0' }), /isn’t higher than 1\.0\.0/);
    assert.throws(() => applyChange(three, l, { kind: 'resume', version: '1.0.2' }), /rolled-back/);
    // rolled back from everyone: everyone on the version before, and the newest is ready again
    const out = vstep(three, l, { kind: 'everyone' });
    const back = vstep(three, out, { kind: 'everyone', version: '1.0.0' });
    assert.equal(changeText(releaseState(three, out), releaseState(three, back)), 'Rolled back to 1.0.0');
    assert.deepEqual([releaseState(three, back).step, releaseState(three, back).versions?.target], ['not_started', '1.0.2']);
  });

  test('anything else is custom; off and the built-in version in words; never ready to clean up', () => {
    const at = (doc: Partial<LayerLike>, vs = three) => releaseState(vs, { enabled: true, defaultVariation: k('1.0.0'), rules: [], ...doc });
    const pct = (variation: string, to = 1000) => ({ name: null, locked: false, disabled: false, conditions: [], serveVariation: null,
      split: { by: 'device.id', fallbackBy: null, ranges: [{ variation, from: 0, to }] } });
    const early = (variation: string) => ({ name: null, locked: false, disabled: false, conditions: [{ field: 'entity', op: 'in', values: ['acme'] }], serveVariation: variation, split: null });
    assert.equal(at({ rules: [early(k('1.0.2')), pct(k('1.0.1'))] }).step, 'custom', 'two versions moving');
    assert.equal(at({ defaultVariation: k('1.0.1'), rules: [pct(k('1.0.0'))] }).step, 'not_started', 'a % of an older version is another rule');
    assert.equal(at({ rules: [{ ...HOLD, serveVariation: k('1.0.2') }] }).step, 'custom', 'another rule hands out a higher version');
    assert.equal(at({ defaultVariation: 'something' }).step, 'custom', 'a default that isn’t one of its versions');
    const typed = at({ defaultVariation: k('0.9.0') }, [...three, { key: k('0.9.0'), value: '0.9.0' }]);
    assert.deepEqual([typed.step, typed.versions?.current], ['not_started', '0.9.0'], 'a version typed in is a version like any other');
    const builtIn = at({ defaultVariation: 'code_default' });
    assert.deepEqual([builtIn.step, builtIn.versions?.current, stepText(builtIn)], ['not_started', null, 'Built-in version · 1.0.2 ready']);
    assert.equal(stepText(at({ enabled: false }, one)), 'Off · Everyone on 1.0.0');
    // a new flag starts off where changes are reviewed: the first step turns it on, and says both
    const dark = vstored(two, { enabled: false, defaultVariation: k('1.0.0'), rules: [] });
    assert.equal(changeText(releaseState(two, dark), releaseState(two, vstep(two, dark, { kind: 'percent', percent: 1 }))), 'Started 1.0.1 at 1% of devices, and turned on');
    const offOn = stored({ enabled: false, defaultVariation: 'off', rules: [] });
    assert.equal(changeText(releaseState(variants, offOn), releaseState(variants, step(offOn, { kind: 'percent', percent: 1 }))), 'Not started → 1% of devices, and turned on');
    assert.equal(readyToCleanUp([{ state: at({}, one), sent: true }]), false, 'a version release stays');
    assert.equal(isVersionRelease([...three, { key: 'val-abc', value: 'not a version' }]), false, 'every value of a version release is a version, typed ones too');
  });

  test('a rollback: everyone back on the version they’re on mid-way, or on an older version served here before', () => {
    const moving = releaseState(three, vstored(three, { enabled: true, defaultVariation: k('1.0.1'), rules: [
      { name: '5% of devices', locked: false, disabled: false, conditions: [], serveVariation: null,
        split: { by: 'device.id', fallbackBy: null, salt: 'web_bundle/1.0.2', ranges: [{ variation: k('1.0.2'), from: 0, to: 500 }] } }] }));
    const everyone = releaseState(three, { enabled: true, defaultVariation: k('1.0.1'), rules: [] });
    assert.equal(isRollback(moving, { kind: 'pause' }, []), true);
    assert.equal(isRollback({ ...moving, paused: true }, { kind: 'pause' }, []), false, 'already rolled back');
    assert.equal(isRollback({ ...moving, on: false }, { kind: 'pause' }, []), false, 'off: nothing to roll back');
    assert.equal(isRollback(moving, { kind: 'percent', percent: 1 }, ['1.0.0']), false, 'a smaller % moves some devices only');
    assert.equal(isRollback(everyone, { kind: 'everyone', version: '1.0.0' }, ['1.0.0', '1.0.1']), true);
    assert.equal(isRollback(everyone, { kind: 'everyone', version: '1.0.0' }, ['1.0.1']), false, 'never served here');
    assert.equal(isRollback(everyone, { kind: 'everyone', version: '1.0.2' }, ['1.0.2']), false, 'forward isn’t back');
    assert.equal(isRollback(releaseState(variants, start), { kind: 'pause' }, []), false, 'on/off releases: the switch is their way back');
  });
});

describe('version releases end to end', () => {
  let t: Awaited<ReturnType<typeof boot>>;
  before(async () => { t = await boot(); });
  after(async () => { await t.stop(); });

  /** One step, as the release page saves it. */
  const save = async (env: string, change: Change) => {
    const f = (await t.as('alice').get('/flags/web_bundle')).json;
    const base = f.layers[env].base;
    const r = await t.as('alice').put(`/flags/web_bundle/layers/${env}/base`, { layer: applyChange(f.variations, base, change, 'web_bundle'), expectedVersion: base.version, reason: 'step' });
    await t.settle();
    return r;
  };
  const add = async (version: unknown) => { const r = await t.as('alice').post('/flags/web_bundle/versions', { version }); await t.settle(); return r; };
  const attrsOf = (id: string | null) => ({ 'app.version': '6.0.0', ...(id ? { 'device.id': id } : {}) });
  const on = async (id: string | null, env = 'dev') => (await t.trace({ environment: env, project: 'web', entity: 'acme', flag: 'web_bundle', attrs: attrsOf(id) })).value;
  const release = (body: Record<string, unknown> = {}) => t.as('alice').post('/flags', {
    key: 'web_bundle', name: 'Web bundle', tags: [], owner: 'web-team', description: '', kind: 'release', valueType: 'string',
    variations: [{ key: k('1.0.0'), value: '1.0.0' }], delivery: { dev: ['web'], prod: ['web'] }, base: { enabled: true, defaultVariation: k('1.0.0'), rules: [] }, ...body,
  });

  test('a version release has no remove-by date; its versions are strict, higher each time, and never change', async () => {
    assert.equal((await release({ key: 'bad_bool', valueType: 'bool', variations: [{ key: 'on', value: true }, { key: 'off', value: false }], base: { enabled: true, defaultVariation: 'off', rules: [] } })).status, 422, 'an on/off release still needs one');
    assert.equal((await release({ key: 'bad_key', variations: [{ key: 'first', value: '1.0.0' }], base: { enabled: true, defaultVariation: 'first', rules: [] } })).status, 422, 'a version release has no named variants: its values are typed in');
    const r = await release();
    assert.equal(r.status, 201, JSON.stringify(r.json));
    await t.settle();
    const row = (await t.as('alice').get('/releases?page=0&q=web_bundle')).json.rows[0];
    assert.deepEqual([row.removeBy, row.overdue, row.ready], [null, false, false]);
    assert.deepEqual([row.envs.dev.step, row.envs.dev.text, row.envs.dev.versions.current], ['everyone', 'Everyone on 1.0.0', '1.0.0']);
    assert.deepEqual([row.envs.prod.on, row.envs.prod.text], [false, 'Off · Everyone on 1.0.0'], 'off where changes are reviewed, like any new flag');

    for (const v of ['1.0.0', '0.9.0', '1.0', 'v1.0.1', '1.0.1+5', '1.0.1-RC.1', 7]) assert.equal((await add(v)).status, 422, String(v));
    assert.deepEqual((await add('1.0.1-beta.1')).json, { version: '1.0.1-beta.1', key: k('1.0.1-beta.1') });
    assert.equal((await add('1.0.1')).status, 201);
    assert.equal((await add('1.0.1-beta.2')).status, 422, 'lower than 1.0.1');
    assert.equal((await t.as('alice').post('/flags/new_checkout/versions', { version: '1.0.0' })).status, 422, 'only a version release has versions');
    assert.equal((await t.as('alice').put('/flags/web_bundle/variations', { variations: [{ key: k('1.0.0'), value: '1.0.5' }] })).status, 422, 'a version never changes');
    assert.equal((await t.as('alice').put('/flags/web_bundle/variations', { variations: [{ key: 'two', value: '2.0.0' }] })).status, 422, 'no named variants: it takes free values');
    assert.equal((await t.as('alice').put('/flags/web_bundle/meta', { removeBy: null })).status, 200, 'its settings save without a remove-by date');
    const h = (await t.as('alice').get('/history?flag=web_bundle&environment=dev')).json.filter((e: any) => e.changeType === 'variations.update');
    assert.equal(h.length, 0, 'adding a version writes no history: nothing changed for anyone (the step that serves it does)');
    const f = (await t.as('alice').get('/flags/web_bundle')).json;
    assert.equal(f.freeValues, true, 'a version release takes free values');
    assert.ok(f.variations.every((v: any) => v.key === k(v.value)), 'each version is the value it is: no variant names');
    assert.equal((await t.as('alice').put('/flags/web_bundle/meta', { freeValues: false })).status, 422, 'it can’t switch to a variant list');
    const ready = (await t.as('alice').get('/releases?page=0&q=web_bundle&show=not_started&environment=dev')).json.rows;
    assert.deepEqual(ready.map((x: any) => [x.key, x.envs.dev.text]), [['web_bundle', '1.0.0 · 1.0.1 ready']]);
  });

  test('in dev: devices on 1.0.1 keep it as it grows; roll back and resume; resume with 1.0.2 moves the same devices', async () => {
    const early = deviceIn('web_bundle/1.0.1', 0, 500);       // inside 5%
    const later = deviceIn('web_bundle/1.0.1', 2000, 2500);   // inside 25%, not 5%
    assert.deepEqual([await on(early), await on(later)], ['1.0.0', '1.0.0']);
    assert.equal((await save('dev', { kind: 'percent', percent: 5 })).status, 200);
    assert.deepEqual([await on(early), await on(later)], ['1.0.1', '1.0.0']);
    await save('dev', { kind: 'percent', percent: 25 });
    assert.deepEqual([await on(early), await on(later)], ['1.0.1', '1.0.1']);
    await save('dev', { kind: 'percent', percent: 5 });
    assert.deepEqual([await on(early), await on(later)], ['1.0.1', '1.0.0'], 'back: the devices that moved last go back first');
    await save('dev', { kind: 'pause' });
    assert.equal(await on(early), '1.0.0', 'rolled back: everyone on 1.0.0');
    await save('dev', { kind: 'resume' });
    assert.equal(await on(early), '1.0.1', 'resume: the same devices');
    await save('dev', { kind: 'pause' });
    assert.equal((await add('1.0.2')).status, 201);
    assert.equal((await save('dev', { kind: 'resume', version: '1.0.2' })).status, 200);
    assert.deepEqual([await on(early), await on(later)], ['1.0.2', '1.0.0'], 'the hotfix reaches the same 5%');
    assert.equal(await on(null), '1.0.0', 'no device ID: not in the %');

    // what the app reads: its entity's CDN file, and the same flagd JSON as built, agree with the server for every device
    const snap = t.plane.get('dev');
    const file = (await t.cdnFile('dev', 'web', 'acme')).json;
    const doc = buildFlagdDoc(snap, 'web', snap.entities.acme);
    assert.deepEqual(file.flags, doc.flags);
    for (const id of [early, later, null, deviceIn('web_bundle/1.0.1', 9000, 10000)]) {
      const want = await on(id);
      assert.equal(cdnAnswer(file, 'web_bundle', attrsOf(id)).value, want, `the CDN file, ${id}`);
      assert.equal(same(flagdEvaluate(doc, 'web_bundle', nest(attrsOf(id)))), same(ours(snap, 'web_bundle', 'web', 'acme', attrsOf(id))), `flagd, ${id}`);
    }
    // one branch: the first 5% by the salt of 1.0.1 get 1.0.2, everyone else the default
    const branches = file.flags.web_bundle.targeting.if;
    assert.equal(branches.length, 3);
    assert.equal(file.flags.web_bundle.variants[branches[1]], '1.0.2');
    // the device ID: device.id, else OpenFeature's targetingKey (flagd.ts)
    const deviceId = { if: [{ '!': { in: [{ var: 'device.id' }, [null, '']] } }, { var: 'device.id' }, { var: 'targetingKey' }] };
    assert.deepEqual(branches[0].and[1]['=='][0].fractional, [{ cat: ['web_bundle/1.0.1/', deviceId] }, ['in', 500], ['out', 9500]]);

    await save('dev', { kind: 'everyone' });
    assert.equal(await on(null), '1.0.2', 'everyone: devices without an ID too');
    // the next version reaches new devices first: one inside 1.0.2's first 5% isn't inside 1.0.3's
    assert.equal((await add('1.0.3')).status, 201);
    await save('dev', { kind: 'percent', percent: 5 });
    let other = '';
    for (let i = 0; !other; i++) {
      const id = `dev-${i}`;
      if (bucketFor('web_bundle/1.0.2', id, HASH_VERSION) < 500 && bucketFor('web_bundle/1.0.3', id, HASH_VERSION) >= 500) other = id;
    }
    assert.equal(await on(other), '1.0.2');
    const steps = (await t.as('alice').get('/history?flag=web_bundle&environment=dev')).json.filter((r: any) => r.changeType === 'layer.update' && !r.entity);
    const vs = (await t.as('alice').get('/flags/web_bundle')).json.variations;
    assert.deepEqual(steps.slice(0, 3).map((r: any) => changeText(releaseState(vs, r.before), releaseState(vs, r.after))),
      ['Started 1.0.3 at 5% of devices', 'Released 1.0.2 to everyone', 'Resumed with 1.0.2 at 5% of devices']);
  });

  test('in prod each step is a request; rolling back from everyone goes to the version prod had before', async () => {
    const step = async (change: Change) => {
      const r = await save('prod', change);
      assert.equal(r.status, 202, JSON.stringify(r.json));
      assert.equal((await t.as('bob').post(`/change-sets/${r.json.changeSetId}/review`, { decision: 'approve' })).status, 200);
      assert.equal((await t.as('alice').post(`/change-sets/${r.json.changeSetId}/apply`)).status, 200);
      await t.settle();
    };
    // prod skips 1.0.1 and 1.0.2: straight to the newest, for everyone, in one request (it turns the flag on)
    await step({ kind: 'everyone' });
    let f = (await t.as('alice').get('/flags/web_bundle')).json;
    assert.deepEqual([f.layers.prod.base.enabled, f.layers.prod.base.defaultVariation], [true, k('1.0.3')]);
    assert.equal(f.versions.prod.previous, '1.0.0', 'the version prod had before, not the next lower one');
    assert.ok(f.versions.prod.since);
    assert.equal(f.versions.dev.previous, '1.0.0', 'dev’s default went from 1.0.0 to 1.0.2 (1.0.1 was only ever in its %)');
    await step({ kind: 'everyone', version: f.versions.prod.previous });
    f = (await t.as('alice').get('/flags/web_bundle')).json;
    const s = releaseState(f.variations, f.layers.prod.base);
    assert.deepEqual([f.layers.prod.base.defaultVariation, s.step, stepText(s)], [k('1.0.0'), 'not_started', '1.0.0 · 1.0.3 ready']);
    assert.equal(f.versions.prod.previous, '1.0.3');
    assert.equal((await t.as('alice').get('/flags/new_checkout')).json.versions, undefined, 'only version releases');
  });

  test('in prod, on call rolls back without review (logged); nothing else goes through break-glass', async () => {
    const approved = async (change: Change) => {
      const r = await save('prod', change);
      assert.equal(r.status, 202, JSON.stringify(r.json));
      await t.as('bob').post(`/change-sets/${r.json.changeSetId}/review`, { decision: 'approve' });
      assert.equal((await t.as('alice').post(`/change-sets/${r.json.changeSetId}/apply`)).status, 200);
      await t.settle();
    };
    const breakGlass = async (as: string, change: Change) => {
      const f = (await t.as(as).get('/flags/web_bundle')).json;
      const base = f.layers.prod.base;
      const r = await t.as(as).put('/flags/web_bundle/layers/prod/base', {
        layer: applyChange(f.variations, base, change, 'web_bundle'), expectedVersion: base.version, reason: 'INC-9', bypassReason: 'INC-9: 1.0.3 crashes on start' });
      await t.settle();
      return r;
    };
    const inside = deviceIn('web_bundle/1.0.3', 0, 500);
    await approved({ kind: 'percent', percent: 5 });                      // prod: 1.0.0 → 1.0.3 at 5%
    assert.equal(await on(inside, 'prod'), '1.0.3');
    assert.equal((await breakGlass('carol', { kind: 'percent', percent: 25 })).status, 403, 'growing isn’t rolling back');
    assert.equal((await breakGlass('alice', { kind: 'pause' })).status, 403, 'an editor can’t break glass');
    const now = await breakGlass('carol', { kind: 'pause' });
    assert.deepEqual([now.status, now.json.bypass], [200, true], JSON.stringify(now.json));
    assert.equal(await on(inside, 'prod'), '1.0.0', 'every device back on 1.0.0 at once');
    const h = (await t.as('alice').get('/history?flag=web_bundle&environment=prod')).json[0];
    assert.deepEqual([h.actorType, h.changedBy, h.comment], ['bypass', 'carol', 'BREAK-GLASS: INC-9: 1.0.3 crashes on start']);

    await approved({ kind: 'resume' });
    assert.equal(await on(inside, 'prod'), '1.0.3', 'resume: the same devices');
    await approved({ kind: 'everyone' });
    let f = (await t.as('alice').get('/flags/web_bundle')).json;
    assert.deepEqual(f.versions.prod.served.sort(), ['1.0.0', '1.0.3'], 'what prod has served while on');
    const never = await breakGlass('carol', { kind: 'everyone', version: '1.0.2' });
    assert.equal(never.status, 403);
    assert.match(never.json.error, /never was/);
    assert.equal((await breakGlass('carol', { kind: 'everyone', version: '1.0.0' })).status, 200, 'back to a version prod served');
    f = (await t.as('alice').get('/flags/web_bundle')).json;
    assert.equal(f.layers.prod.base.defaultVariation, k('1.0.0'));
    assert.equal((await breakGlass('carol', { kind: 'everyone', version: '1.0.3' })).status, 403, 'forward is a request');
    // an on/off release has the switch for this (kill switches and ops flags only)
    const nc = (await t.as('carol').get('/flags/new_checkout')).json.layers.prod.base;
    const r = await t.as('carol').put('/flags/new_checkout/layers/prod/base', { layer: { ...nc, rules: [] }, expectedVersion: nc.version, bypassReason: 'sneaky' });
    assert.equal(r.status, 403);
  });
});
