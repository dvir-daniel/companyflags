// "Use code default" (Firebase Remote Config's "in-app default"): serve no remote value.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, cdnAnswer } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

test('base default = code default: no value is served', async () => {
  const r = await t.trace({ project: 'web', entity: 'acme', flag: 'welcome_message' });
  assert.equal(r.codeDefault, true);
  assert.equal(r.value, undefined);
  assert.equal(r.reason, 'DEFAULT');
});

test('a rule can set a remote value, or explicitly keep the code default', async () => {
  const beta = await t.trace({ project: 'web', entity: 'globex', flag: 'welcome_message' });
  assert.equal(beta.value, 'Welcome to the beta — tell us what you think!');
  const oldAndroid = await t.trace({ project: 'android', entity: 'globex', attrs: { 'app.version': '5.2.0' }, flag: 'welcome_message' });
  assert.equal(oldAndroid.codeDefault, true);
  assert.equal(oldAndroid.reason, 'TARGETING_MATCH');
});

test('in the CDN file, a flag that only uses the code default has no value to give: the app keeps its own', async () => {
  const acme = (await t.appFile('dev', 'web', 'acme')).json;
  assert.deepEqual([acme.flags.welcome_message.defaultVariant, acme.flags.welcome_message.targeting], [null, undefined]);
  assert.ok(cdnAnswer(acme, 'welcome_message').codeDefault);
  const globex = (await t.appFile('dev', 'web', 'globex')).json;
  assert.equal(cdnAnswer(globex, 'welcome_message').value, (await t.trace({ project: 'web', entity: 'globex', flag: 'welcome_message' })).value);
  assert.ok(!cdnAnswer(globex, 'welcome_message').codeDefault);
});

test('OFF sends nothing; code default also works for own defaults and split ranges', async () => {
  const flag = (await t.as('alice').get('/flags/new_checkout')).json;
  const base = flag.layers.dev.base;
  const off = await t.as('alice').put('/flags/new_checkout/layers/dev/base', { layer: { ...base, enabled: false }, expectedVersion: base.version });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  await t.settle();
  const r = await t.trace({ project: 'ios', entity: 'acme', flag: 'new_checkout' });
  assert.equal(r.reason, 'DISABLED');
  assert.equal(r.codeDefault, true);

  const cust = await t.as('alice').put('/flags/api_base_url/layers/dev/acme', { layer: { inherit: 'customer_only', defaultVariation: 'code_default', rules: [] }, expectedVersion: null });
  assert.equal(cust.status, 200, JSON.stringify(cust.json));
  const split = await t.as('alice').put('/flags/api_base_url/layers/dev/initech', { expectedVersion: null, layer: {
    inherit: 'base_rules_then_base_default',
    rules: [{ conditions: [], split: { by: 'entity', ranges: [{ variation: 'code_default', from: 0, to: 10000 }] } }] } });
  assert.equal(split.status, 200, JSON.stringify(split.json));
  await t.settle();
  assert.equal((await t.trace({ project: 'web', entity: 'acme', flag: 'api_base_url' })).codeDefault, true);
  assert.equal((await t.trace({ project: 'web', entity: 'initech', flag: 'api_base_url' })).codeDefault, true);
});

test('"code_default" is reserved and hidden from the variation list', async () => {
  const flag = (await t.as('alice').get('/flags/welcome_message')).json;
  assert.deepEqual(flag.variations.map((v: any) => v.key), ['beta', 'holiday']);
  const clash = await t.as('alice').put('/flags/welcome_message/variations', { variations: [{ key: 'code_default', value: 'x' }] });
  assert.equal(clash.status, 422);
});
