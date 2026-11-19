// Group names on a % of devices: the app is told which group it is in (its file says, clientFile.ts), so its own
// analytics can compare devices inside the % with devices outside it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_DEFAULT, evaluate, type FlagDef, type Rule, type Snapshot } from '../server/evaluator.ts';
import { checkRule } from '../server/checks.ts';
import { boot, deviceIn as firstDevice } from './helpers.ts';
import { readClientFile } from '../server/clientFile.ts';

const K = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// device ids inside / outside the first 20% for a salt
const deviceIn = (salt: string, pct = 2000) => firstDevice(salt, 0, pct, { prefix: 'd' });
const deviceOut = (salt: string, pct = 2000) => firstDevice(salt, pct, 10000, { prefix: 'd' });

const rollout = (r: Partial<Rule> & { split: Rule['split'] }): Rule => ({ ruleKey: K(1), name: null, locked: false, disabled: false, conditions: [], serveVariation: null, ...r });
const snapOf = (rules: Rule[], defaultVariation = 'off'): Snapshot => {
  const f: FlagDef = {
    key: 'f', valueType: 'bool', kind: 'release', delivery: ['android', 'ios'],
    variations: { on: true, off: false, [CODE_DEFAULT]: null },
    base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation, inherit: null, rules },
    entities: {},
  };
  return { environment: 'dev', revision: 1, builtAt: '', flags: { f }, entities: {}, dimensions: [], fields: {} };
};
const ask = (snap: Snapshot, attrs: Record<string, unknown>, project = 'android') =>
  evaluate(snap, 'f', { environment: 'dev', project, entity: null, attrs }, false);

const androidTest = rollout({
  conditions: [{ field: 'project', op: 'in', values: ['android'] }],
  split: { by: 'device.id', fallbackBy: null, salt: 'f', hashVersion: 2, ranges: [{ variation: 'on', from: 0, to: 2000, group: 'checkout_test' }], outsideGroup: 'checkout_control' },
});

test('devices inside the % get its group name, devices outside get the outside name', () => {
  const snap = snapOf([androidTest]);
  const inside = ask(snap, { 'device.id': deviceIn('f') });
  assert.deepEqual([inside.variant, inside.group], ['on', 'checkout_test']);
  const outside = ask(snap, { 'device.id': deviceOut('f') });
  assert.deepEqual([outside.variant, outside.group], ['off', 'checkout_control']);
  // the rule doesn't apply (ios), or the device can't be placed (no id): no group
  assert.equal(ask(snap, { 'device.id': deviceIn('f') }, 'ios').group, undefined);
  assert.equal(ask(snap, {}).group, undefined);
  // the explained path (Debug tab, single-flag call) says the same, in its metadata too
  const full = evaluate(snap, 'f', { environment: 'dev', project: 'android', entity: null, attrs: { 'device.id': deviceOut('f') } });
  assert.deepEqual([full.group, full.metadata.group], ['checkout_control', 'checkout_control']);
});

test('a device outside one % keeps that group when a later rule decides its value', () => {
  const later = rollout({ ruleKey: K(2), split: null, serveVariation: 'on', conditions: [{ field: 'app.version', op: 'semver_gte', values: ['9.0.0'] }] });
  const snap = snapOf([androidTest, later]);
  assert.deepEqual(Object.values(pick(ask(snap, { 'device.id': deviceOut('f'), 'app.version': '9.1.0' }))), ['on', 'checkout_control']);
  // a part of the % without a name sends no name, even after falling outside an earlier named %
  const unnamed = rollout({ ruleKey: K(3), split: { by: 'device.id', fallbackBy: null, salt: 'g', hashVersion: 2, ranges: [{ variation: 'on', from: 0, to: 10000 }] } });
  assert.equal(ask(snapOf([androidTest, unnamed]), { 'device.id': deviceOut('f') }).group, undefined);
});
const pick = (r: ReturnType<typeof ask>) => ({ variant: r.variant, group: r.group });

test('group names are checked: plain names, each one different', () => {
  const facts = { key: 'f', kind: 'release', variants: new Set(['on', 'off']) };
  const fields = { 'device.id': { valueType: 'string', canSplitBy: true }, project: { valueType: 'string', canSplitBy: false } };
  const withNames = (inside: string, outside: string) => checkRule({
    split: { by: 'device.id', ranges: [{ variation: 'on', from: 0, to: 2000, group: inside }], outsideGroup: outside },
  }, facts, fields, { isBase: true });
  assert.deepEqual(withNames('checkout_test', 'checkout_control').problems, []);
  assert.deepEqual(withNames('checkout test', '').problems, ['Group names use letters, digits, _ - and . (up to 64 characters, no spaces)']);
  assert.deepEqual(withNames('same', 'same').problems, ['Each group needs its own name']);
  // empty names are left out, so a rule without names looks exactly as before
  const plain = withNames('  ', '');
  assert.deepEqual([plain.rule.split!.ranges[0], 'outsideGroup' in plain.rule.split!], [{ variation: 'on', from: 0, to: 2000 }, false]);
});

// ---- end to end: saved in the console, sent to the app

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

/** Names new_checkout's % groups in development (inside: checkout_test, outside: checkout_control). */
async function nameGroups() {
  const saved = await t.editBase('new_checkout', 'dev', (layer) => ({ ...layer, rules: layer.rules.map((r: Rule) => (r.split
    ? { ...r, split: { ...r.split, outsideGroup: 'checkout_control', ranges: r.split.ranges.map((x, i) => (i === 0 ? { ...x, group: 'checkout_test' } : x)) } }
    : r)) }));
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
}

test('names saved in the console reach the app with each flag', async () => {
  await nameGroups();
  const stored = (await t.as('alice').get('/flags/new_checkout')).json.layers.dev.base.rules.find((r: Rule) => r.split).split;
  assert.deepEqual([stored.ranges[0].group, stored.outsideGroup], ['checkout_test', 'checkout_control']);

  const file = (await t.appFile('dev', 'android', 'acme')).json;
  const fetchFlag = (device: string) => readClientFile(file, 'new_checkout', { 'device.id': device, 'app.version': '6.0.0' });
  const salt = stored.salt;
  assert.equal(fetchFlag(deviceIn(salt, stored.ranges[0].to)).group, 'checkout_test');
  assert.equal(fetchFlag(deviceOut(salt, stored.ranges[0].to)).group, 'checkout_control');
  // other flags carry no group at all
  for (const k of Object.keys(file.flags)) if (k !== 'new_checkout') assert.equal(readClientFile(file, k, { 'device.id': 'x' }).group, undefined, k);
});

test('a device in a named group that keeps its in-app default still hears its group name', async () => {
  await nameGroups();
  const saved = await t.editBase('new_checkout', 'dev', (layer) => ({ ...layer, defaultVariation: CODE_DEFAULT }));
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const stored = (await t.baseOf('new_checkout', 'dev')).layer.rules.find((r: Rule) => r.split).split;
  const file = (await t.appFile('dev', 'android', 'acme')).json;
  assert.ok(file.flags.new_checkout, 'kept in the file for its group name');
  assert.deepEqual(readClientFile(file, 'new_checkout', { 'device.id': deviceOut(stored.salt, stored.ranges[0].to), 'app.version': '6.0.0' }),
    { codeDefault: true, group: 'checkout_control' });
});
