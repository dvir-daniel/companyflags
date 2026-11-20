// Rules target the app's version ("App version is at least 2.4.0"), compared as a version, not as text:
// 2.10.0 is newer than 2.4.0. There is no separate SDK version (the SDK ships inside the app) and no app id
// (which app is calling comes from the API key).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

test('App version is an attribute apps send and rules compare as a version', async () => {
  const meta = (await t.as('alice').get('/meta')).json;
  assert.ok(!meta.fields.some((f: any) => f.name === 'sdk.version' || f.name === 'app.id'), 'no SDK version or app id');
  const field = meta.fields.find((f: any) => f.name === 'app.version');
  assert.ok(field, 'app.version is offered');
  assert.equal(field.valueType, 'semver');
  assert.equal(field.comesFrom, 'sdk');

  // put "App version is at least 2.4.0 → on" first on dark_mode_v2 in development (and wait for the publish, as apps would)
  const rule = { ruleKey: crypto.randomUUID(), name: 'App 2.4 and later', locked: false, disabled: false,
    conditions: [{ field: 'app.version', op: 'semver_gte', values: ['2.4.0'] }], serveVariation: 'on', split: null };
  const r = await t.editBase('dark_mode_v2', 'dev', (layer) => ({ ...layer, rules: [rule, ...layer.rules] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const get = (attrs: Record<string, string>) => t.trace({ service: 'web', entity: 'acme', attrs, flag: 'dark_mode_v2' });
  const newer = await get({ 'app.version': '2.10.0' });                 // 2.10.0 ≥ 2.4.0 as a version (not as text)
  assert.equal(newer.value, true);
  assert.equal(newer.reason, 'TARGETING_MATCH');
  const exact = await get({ 'app.version': '2.4.0' });
  assert.equal(exact.value, true);
  const older = await get({ 'app.version': '2.3.1' });                  // older apps fall through to the next rules
  assert.notEqual(older.decidedBy?.ruleKey, rule.ruleKey);
  const none = await get({});                                           // an app that doesn't report its version doesn't match
  assert.notEqual(none.decidedBy?.ruleKey, rule.ruleKey);
});
