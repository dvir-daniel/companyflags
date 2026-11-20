// The ten use cases from the design doc, end to end against the seeded data.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, deviceIn } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

describe('use cases', () => {
  test('UC1: android-only key does not exist for ios', async () => {
    assert.equal((await t.trace({ project: 'android', entity: 'acme', flag: 'android_quick_share' })).value, true);
    const ios = await t.trace({ project: 'ios', entity: 'acme', flag: 'android_quick_share' });
    assert.equal(ios.errorCode, 'FLAG_NOT_FOUND');
  });

  test('UC2 + UC3: per-customer URL, Vandelay android differs from Vandelay iOS', async () => {
    const msAndroid = await t.trace({ project: 'android', entity: 'vandelay', flag: 'api_base_url' });
    const msIos = await t.trace({ project: 'ios', entity: 'vandelay', flag: 'api_base_url' });
    const wonka = await t.trace({ project: 'web', entity: 'wonka', flag: 'api_base_url' });
    const acme = await t.trace({ project: 'web', entity: 'acme', flag: 'api_base_url' });
    assert.equal(msAndroid.value, 'https://android.vandelay.api.example.com');
    assert.equal(msIos.value, 'https://vandelay.api.example.com');
    assert.equal(wonka.value, 'https://wonka.api.example.com');
    assert.equal(acme.value, 'https://api.example.com');
  });

  test('UC4: 20% of android devices, sticky; widening to 50% moves nobody out', async () => {
    const attrs = (id: string) => ({ 'device.id': id, 'app.version': '6.1.0' });
    const ids = Array.from({ length: 400 }, (_, i) => `device-${i}`);
    const before20 = await Promise.all(ids.map((id) => t.trace({ project: 'android', entity: 'acme', attrs: attrs(id), flag: 'new_checkout' })));
    const on20 = before20.filter((r) => r.value === true).length;
    assert.ok(on20 > 50 && on20 < 110, `~20% expected, got ${on20}/400`);

    const flag = (await t.as('alice').get('/flags/new_checkout')).json;
    const base = flag.layers.dev.base;
    base.rules[1].split.ranges = [{ variation: 'on', from: 0, to: 5000 }];
    const save = await t.as('alice').put('/flags/new_checkout/layers/dev/base', { layer: base, expectedVersion: base.version });
    assert.equal(save.status, 200, JSON.stringify(save.json));
    await t.settle();

    const after50 = await Promise.all(ids.map((id) => t.trace({ project: 'android', entity: 'acme', attrs: attrs(id), flag: 'new_checkout' })));
    before20.forEach((r, i) => { if (r.value === true) assert.equal(after50[i].value, true, `${ids[i]} was moved out`); });
    assert.ok(after50.filter((r) => r.value === true).length > on20);

    // moving a range start is rejected unless a reshuffle is confirmed (M6)
    const cur = (await t.as('alice').get('/flags/new_checkout')).json.layers.dev.base;
    cur.rules[1].split.ranges = [{ variation: 'on', from: 5000, to: 10000 }];
    const bad = await t.as('alice').put('/flags/new_checkout/layers/dev/base', { layer: cur, expectedVersion: cur.version });
    assert.equal(bad.status, 422);
    assert.match(bad.json.errors.join(), /reshuffle/);
    assert.equal(bad.json.code, 'needs_reshuffle');                    // the console offers the confirmation on the code
  });

  test('UC4 edge: no device id → no match (never bucket 0); unallocated bucket → continue', async () => {
    const r = await t.trace({ project: 'android', entity: 'acme', attrs: { 'app.version': '6.0.0' }, flag: 'new_checkout' });
    assert.equal(r.value, false);
    assert.equal(r.reason, 'DEFAULT');
    assert.ok(r.trace.some((s: any) => /missing → no match/.test(s.detail)));
  });

  test('UC5: kill switch in prod — approval needed, but on-call can break-glass OFF', async () => {
    const flag = (await t.as('carol').get('/flags/payments_enabled')).json;
    const base = { ...flag.layers.prod.base, enabled: false };
    const normal = await t.as('alice').put('/flags/payments_enabled/layers/prod/base', { layer: base, expectedVersion: base.version, reason: 'incident' });
    assert.equal(normal.status, 202);                       // became a change set
    const notOncall = await t.as('alice').put('/flags/payments_enabled/layers/prod/base', { layer: base, expectedVersion: base.version, bypassReason: 'incident' });
    assert.equal(notOncall.status, 403);
    const turnOnViaBypass = await t.as('carol').put('/flags/payments_enabled/layers/prod/base',
      { layer: { ...flag.layers.prod.base, rules: [{ conditions: [], serveVariation: 'off' }] }, expectedVersion: base.version, bypassReason: 'sneaky' });
    assert.equal(turnOnViaBypass.status, 403);              // bypass can only flip enabled → false
    const bypass = await t.as('carol').put('/flags/payments_enabled/layers/prod/base', { layer: base, expectedVersion: base.version, bypassReason: 'INC-123 payments outage' });
    assert.equal(bypass.status, 200, JSON.stringify(bypass.json));
    await t.settle();
    for (const project of ['android', 'web', 'server-ds']) {
      const r = await t.trace({ environment: 'prod', project, entity: 'vandelay', flag: 'payments_enabled' });
      assert.equal(r.codeDefault, true);                    // OFF: nothing is sent, the app uses its code default
      assert.equal(r.reason, 'DISABLED');
    }
    const hist = (await t.as('dana').get('/history?flag=payments_enabled&environment=prod')).json;
    assert.equal(hist[0].actorType, 'bypass');
  });

  test('UC6: locked off for android < 5.0, Wonka cannot override; missing version fails closed', async () => {
    const old = await t.trace({ project: 'android', entity: 'wonka', attrs: { 'app.version': '4.9.3', 'device.id': 'x' }, flag: 'new_checkout' });
    assert.equal(old.value, false);
    assert.equal(old.metadata.layer, 'base');
    const v510 = await t.trace({ project: 'android', entity: 'wonka', attrs: { 'app.version': '5.10.0', 'device.id': 'x' }, flag: 'new_checkout' });
    assert.equal(v510.value, true);                         // 5.10 > 5.0 (semver, not string compare); Wonka rule applies
    const missing = await t.trace({ project: 'android', entity: 'wonka', attrs: { 'device.id': 'x' }, flag: 'new_checkout' });
    assert.equal(missing.value, false);
    assert.ok(missing.trace[2].conditions.some((c: any) => /fails closed/.test(c.note ?? '')));
    const garbage = await t.trace({ project: 'android', entity: 'wonka', attrs: { 'app.version': 'banana', 'device.id': 'x' }, flag: 'new_checkout' });
    assert.equal(garbage.value, false);
    const ios = await t.trace({ project: 'ios', entity: 'wonka', attrs: { 'app.version': '1.0.0' }, flag: 'new_checkout' });
    assert.equal(ios.value, true);                          // the lock only targets android
  });

  test('UC7: EU host via one rule for everyone; an “Own settings only” layer is explicit and visible in the trace', async () => {
    assert.equal((await t.trace({ project: 'web', entity: 'soylent', flag: 'data_region_host' })).value, 'https://eu.data.example.com');
    assert.equal((await t.trace({ project: 'web', entity: 'oscorp', flag: 'data_region_host' })).value, 'https://eu.data.example.com');
    assert.equal((await t.trace({ project: 'web', entity: 'acme', flag: 'data_region_host' })).value, 'https://us.data.example.com');
    const cyberdyne = await t.trace({ project: 'web', entity: 'cyberdyne', flag: 'data_region_host' });
    assert.equal(cyberdyne.value, 'https://us.data.example.com');
    assert.ok(cyberdyne.trace.some((s: any) => s.outcome === 'skipped' && /uses only its own settings/.test(s.detail)));
    const impact = (await t.as('alice').get('/flags/data_region_host/impact/dev')).json;
    assert.deepEqual(impact.ownOnly, ['cyberdyne']);

    // an entity's own default no longer masks base rules (the original design's STOP bug)
    const netflixLayer = { inherit: 'base_rules_then_customer_default', defaultVariation: 'us', rules: [] };
    const s = await t.as('alice').put('/flags/data_region_host/layers/dev/soylent', { layer: netflixLayer, expectedVersion: null });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    await t.settle();
    assert.equal((await t.trace({ project: 'web', entity: 'soylent', flag: 'data_region_host' })).value, 'https://eu.data.example.com');
  });

  test('entities have a key, a name, a dimension and, below the top, a parent; renames are audited', async () => {
    const r = await t.as('alice').put('/dimensions/company/acme', { name: 'Acme Corporation' });
    assert.deepEqual(r.json, { key: 'acme', name: 'Acme Corporation', dimension: 'company', parent: null });
    const h = (await t.as('alice').get('/history?entity=acme')).json;
    assert.equal(h[0].changeType, 'entity.update');
    await t.as('alice').put('/dimensions/company/acme', { name: 'Acme Corp' });
    await t.settle();
  });

  test('entity page: every flag with all its variants, the defaults, and this entity’s own settings', async () => {
    const list = (await t.as('alice').get('/dimensions/company')).json;
    const ms = list.find((c: any) => c.key === 'vandelay');
    assert.ok(ms.flagsWithSettings.dev >= 1);
    const view = (await t.as('alice').get('/dimensions/company/soylent/flags?environment=dev')).json;
    assert.equal(view.entity.name, 'Soylent');
    const ds = view.rows.find((f: any) => f.key === 'ds_backend_config');
    assert.deepEqual([ds.answer.gets.variant, ds.answer.gets.section], ['soylent', 'entity_default']);
    assert.deepEqual(ds.variations.map((v: any) => v.key), ['default', 'soylent']);
    const plain = view.rows.find((f: any) => f.key === 'new_checkout');
    assert.equal(plain.hasOwn, false);                        // no own settings: gets the defaults
    assert.ok(plain.variations.length >= 2);
    assert.equal(view.rows.length, (await t.as('alice').get('/flags?environment=dev&page=0&size=200')).json.matched);
    // other entities' typed-in values never show up on this entity's page
    assert.ok(view.rows.every((f: any) => f.variations.every((v: any) => !v.own || f.hasOwn)));
    assert.equal((await t.as('alice').get('/dimensions/company/nope/flags')).status, 404);
  });

  test('UC8: a flag sent only to server-ds never reaches a phone; Soylent gets its own value', async () => {
    const phone = await t.trace({ project: 'android', entity: 'soylent', flag: 'ds_backend_config' });
    assert.equal(phone.errorCode, 'FLAG_NOT_FOUND');
    const ds = await t.trace({ project: 'server-ds', entity: 'soylent', flag: 'ds_backend_config' });
    assert.deepEqual(ds.value, { host: 'ds-soylent.internal', poolSize: 40 });
  });

  test('UC9: a brand-new entity gets the base with zero configuration', async () => {
    const c = await t.as('alice').post('/dimensions/company', { key: 'brand-new', name: 'Brand New Inc' });
    assert.equal(c.status, 201);
    await t.settle();
    const r = await t.trace({ project: 'web', entity: 'brand-new', flag: 'api_base_url' });
    assert.equal(r.value, 'https://api.example.com');
    assert.equal(r.metadata.layer, 'base');
  });

  test('UC10: trace explains every layer and the bucket', async () => {
    const id = deviceIn('new_checkout', 0, 2000);
    const r = await t.trace({ project: 'android', entity: 'vandelay', attrs: { 'device.id': id, 'app.version': '6.0.0' }, flag: 'new_checkout' });
    assert.equal(r.value, true);
    assert.equal(r.reason, 'SPLIT');
    const split = r.trace.find((s: any) => s.split?.bucket !== undefined);
    assert.equal(split.split.unit, 'device.id');
    assert.equal(split.split.salt, 'new_checkout');
    assert.ok(r.metadata.ruleKey && r.metadata.revision && r.metadata.baseVersion);
    assert.deepEqual(r.trace.map((s: any) => s.stage).slice(0, 3), ['delivery', 'enabled', 'locked']);
  });
});
