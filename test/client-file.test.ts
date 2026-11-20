// What apps read: one file per environment, app and entity, values only (server/clientFile.ts), at the
// entity's secret link (server/delivery.ts). The device's own pick from the file must always equal what
// the server's evaluator answers for that device, including the % group name it reports.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { boot } from './helpers.ts';
import { buildClientFile, readClientFile } from '../server/clientFile.ts';
import { contextFor, evaluate } from '../server/evaluator.ts';
import { DIMENSION_GROUP, FIELDS, groupFields, type FieldInfo } from '../server/fields.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const DEVICES: Record<string, unknown>[] = Array.from({ length: 60 }, (_, i) => ({
  'device.id': i % 7 ? `d-${i}` : undefined, 'app.version': ['4.9.0', '5.0.0', '6.2.0', '7.1.3', 'not-a-version'][i % 5], 'app.build': 100 + i,
  'device.platform': ['android', 'ios', 'web'][i % 3], 'device.os_version': ['13', '17.4', '10.15.7'][i % 3],
  'device.browser': i % 5 ? 'chrome' : undefined, 'geo.country': ['US', 'CA', 'DE'][i % 3], 'session.id': i % 2 ? `s-${i}` : undefined,
}));

function parity() {
  let checked = 0;
  for (const env of ['dev', 'prod']) {
    const snap = t.plane.get(env);
    for (const project of ['android', 'ios', 'web']) {
      for (const entity of [...Object.keys(snap.entities), null]) {
        const file = buildClientFile(snap, project, entity ? snap.entities[entity] : null);
        for (const key of Object.keys(snap.flags)) {
          for (const attrs of DEVICES) {
            const sent = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined));
            const want = evaluate(snap, key, contextFor(snap, { project, entity }, sent, { trust: 'app' }), false);
            const got = readClientFile(file, key, sent);
            const where = `${env}/${project}/${entity}/${key} ${JSON.stringify(sent)}`;
            if (want.codeDefault || want.errorCode) assert.ok(got.codeDefault, `${where}: expected the in-app default`);
            else assert.deepEqual(got.value, want.value, where);
            assert.equal(got.group, want.errorCode ? undefined : want.group, `${where}: group`);
            checked++;
          }
        }
      }
    }
  }
  return checked;
}

test('the device’s pick from the file equals the evaluator: value and group, every flag, entity, app and device', () => {
  assert.ok(parity() > 10_000);
});

test('still equal with named % groups, inside and outside, by device and by entity', async () => {
  // name the groups on new_checkout's % rule, and add a % by company with an outside name in front of it
  const variant = (await t.as('alice').get('/flags/new_checkout')).json.variations.find((v: any) => v.key !== 'code_default').key;
  const byCustomer = { ruleKey: crypto.randomUUID(), name: 'Half the companies', locked: false, disabled: false, conditions: [], serveVariation: null,
    split: { by: 'company', fallbackBy: null, outsideGroup: 'company_control', ranges: [{ variation: variant, from: 0, to: 5000, group: 'company_test' }] } };
  const r = await t.editBase('new_checkout', 'dev', (layer) => {
    const rules = layer.rules.map((x: any) => (x.split ? { ...x, split: { ...x.split, outsideGroup: 'control', ranges: x.split.ranges.map((g: any, i: number) => ({ ...g, group: `test_${i}` })) } } : x));
    return { ...layer, rules: [...rules.filter((x: any) => x.locked), byCustomer, ...rules.filter((x: any) => !x.locked)] };
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(parity() > 10_000);
});

test('the file has values only: no entity lists, nothing about other entities or apps', () => {
  const snap = t.plane.get('dev');
  const file = JSON.stringify(buildClientFile(snap, 'web', snap.entities.acme));
  for (const field of ['entity', 'company', 'brand']) assert.ok(!file.includes(`"field":"${field}"`), `checks on ${field} are settled on the server`);
  for (const other of ['microsoft', 'netflix', 'spotify']) assert.ok(!file.includes(`"${other}"`), `nothing about ${other}`);
  assert.ok(!file.includes('"project"'), 'checks on the app are settled on the server');
});

test('country rules stay in the file; the device checks them with the CDN’s country header', async () => {
  const flag = Object.keys(t.plane.get('dev').flags).find((k) => t.plane.get('dev').flags[k].delivery.includes('web'))!;
  const serve = (await t.as('alice').get(`/flags/${flag}`)).json.variations.find((v: any) => v.key !== 'code_default');
  const rule = { ruleKey: crypto.randomUUID(), name: 'Canada', locked: false, disabled: false,
    conditions: [{ field: 'geo.country', op: 'in', values: ['CA'] }], serveVariation: serve.key, split: null };
  const r = await t.editBase(flag, 'dev', (layer) => ({ ...layer, rules: [rule, ...layer.rules] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const file = (await t.appFile('dev', 'web', 'acme')).json;
  assert.ok(file.flags[flag].when.some((l: any) => l.if.some((c: any) => c.field === 'geo.country')));
  assert.deepEqual(readClientFile(file, flag, { 'geo.country': 'CA' }).value, serve.value);
});

test('the link: cacheable for a CDN, tagged with its environment, 304 on the same ETag, gzipped', async () => {
  const ok = await t.appFile('dev', 'web', 'acme');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(ok.headers.get('cache-control')!, /^public, max-age=60/);
  assert.match(ok.headers.get('cache-control')!, /stale-if-error=86400/);
  assert.equal(ok.headers.get('cache-tag'), 'env-dev');
  assert.equal(ok.json.environment, 'dev');
  const etag = ok.headers.get('etag')!;
  assert.match(etag, /^W\/"/, 'weak: the gzipped and plain responses are the same content');
  const notModified = await t.appFile('dev', 'web', 'acme', { 'if-none-match': etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('etag'), etag);
  assert.match(notModified.headers.get('cache-control')!, /^public, max-age=60/, 'a 304 keeps the caching headers');
  // what a CDN or a browser may send back: the ETag without W/ (a strong copy), or a list with ours in it
  assert.equal((await t.appFile('dev', 'web', 'acme', { 'if-none-match': etag.slice(2) })).status, 304);
  assert.equal((await t.appFile('dev', 'web', 'acme', { 'if-none-match': `W/"other", ${etag}` })).status, 304);
  assert.equal((await t.appFile('dev', 'web', 'acme', { 'if-none-match': 'W/"other"' })).status, 200);
  const gz = await t.app.request(await t.link('dev', 'web', 'acme'), { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.equal(JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).environment, 'dev');
});

test('a link is only good for its own entity and environment; wrong links all look the same', async () => {
  const acme = await t.link('dev', 'web', 'acme');
  const secret = acme.split('/').pop()!;
  const google = await t.link('dev', 'web', 'google');
  assert.notEqual(google.split('/').pop(), secret, 'each entity has its own secret');
  assert.notEqual((await t.link('prod', 'web', 'acme')).split('/').pop(), secret, 'and each environment');
  const get = (p: string) => t.call('GET', p);
  assert.equal((await get(`/client/v1/flags/dev/web/google/${secret}`)).status, 404, 'acme’s secret on google’s path');
  assert.equal((await get(`/client/v1/flags/prod/web/acme/${secret}`)).status, 404, 'a dev secret in prod');
  assert.equal((await get(`/client/v1/flags/dev/web/nobody/${secret}`)).json.error, (await get(`/client/v1/flags/dev/web/acme/wrong`)).json.error);
  assert.equal((await get(`/client/v1/flags/dev/server-ds/acme/${secret}`)).status, 404, 'backends don’t get app files');
  assert.equal((await get(`/client/v1/flags/staging/web`)).status, 404);
  const anon = await get('/client/v1/flags/dev/web');
  assert.equal(anon.status, 200, 'before login: what everyone gets');
});

test('replacing an entity’s link stops the old one at once and is in History', async () => {
  const old = await t.link('dev', 'ios', 'globex');
  assert.equal((await t.call('GET', old)).status, 200);
  const r = await t.as('dana').post('/dimensions/company/globex/link/rotate?environment=dev');
  assert.equal(r.status, 200);
  assert.equal((await t.call('GET', old)).status, 404);
  assert.equal((await t.call('GET', r.json.path.replace(':flagSet', 'ios'))).status, 200);
  const h = (await t.as('alice').get('/history?entity=globex')).json;
  assert.ok(h.some((x: any) => x.changeType === 'entity.link_replaced'));
});

test('a publish that changes values changes the file and its ETag', async () => {
  const before_ = await t.appFile('dev', 'android', 'google');
  assert.ok('android_quick_share' in before_.json.flags);
  const base = (await t.as('alice').get('/flags/android_quick_share')).json.layers.dev.base;
  assert.equal((await t.as('alice').put('/flags/android_quick_share/layers/dev/base', { layer: { ...base, enabled: false }, expectedVersion: base.version })).status, 200);
  await t.settle();
  const after_ = await t.appFile('dev', 'android', 'google', { 'if-none-match': before_.headers.get('etag')! });
  assert.equal(after_.status, 200);
  assert.ok(!('android_quick_share' in after_.json.flags), 'off → in-app default → left out');
});

test('the console gets every attribute in fields.ts and one per dimension, with its group, label and known values', async () => {
  const meta = (await t.as('alice').get('/meta')).json;
  const fields: FieldInfo[] = meta.fields;
  const said = (f: Partial<FieldInfo>) => JSON.stringify([f.name, f.group, f.label, f.knownValues ?? null, f.comesFrom, f.valueType]);
  const fromDims = ['company', 'brand', 'entity'];
  assert.deepEqual(fields.filter((f) => !fromDims.includes(f.name)).map(said).sort(), FIELDS.map(said).sort(), 'the entries of fields.ts (no SDK version, no app id)');
  assert.deepEqual(fields.filter((f) => fromDims.includes(f.name)).map(said).sort(), [
    ['brand', DIMENSION_GROUP, 'Brand', { dimension: 'brand' }, 'token', 'string'],
    ['company', DIMENSION_GROUP, 'Company', { dimension: 'company' }, 'token', 'string'],
    ['entity', DIMENSION_GROUP, 'Company or brand', 'entities', 'token', 'string'],
  ].map((x) => JSON.stringify(x)), 'one attribute per dimension, named by its key, and `entity`, labelled with their names');
  assert.deepEqual(groupFields(fields, meta.dimensions).flatMap(([, fs]) => fs.map((f) => f.name)),
    [...groupFields(FIELDS).flatMap(([, fs]) => fs.map((f) => f.name)), 'company', 'brand', 'entity'], 'the dimensions come last, top first, then `entity`');
});
