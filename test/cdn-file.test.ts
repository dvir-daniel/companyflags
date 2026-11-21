// What apps read: the CDN file, one per environment, app and entity, as flagd JSON (server/flagd.ts), at the
// entity's secret link (server/delivery.ts). What an OpenFeature flagd provider on the device answers from the file
// (OpenFeature's flagd-core, and our reference of flagd) must always equal what the server's evaluator answers for that
// device, and what OFREP answers it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { boot, cdnAnswer } from './helpers.ts';
import { entityTag, fileTags, linkTag } from '../server/purge.ts';
import { flagdCore, nest, ours, same } from './flagdReference.ts';
import { buildFlagdDoc } from '../server/flagd.ts';
import { lastModified } from '../server/delivery.ts';
import { DIMENSION_GROUP, FIELDS, groupFields, type FieldInfo } from '../server/fields.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

// No version that can't be read ("not-a-version"): an override matches it on the server and not in flagd (server/flagd.ts).
// Short ones (6, 6.2) both read. Some devices send only OpenFeature's targetingKey as their ID, some neither.
const DEVICES: Record<string, unknown>[] = Array.from({ length: 70 }, (_, i) => ({
  'device.id': i % 7 && i % 4 ? `d-${i}` : undefined, targetingKey: i % 4 === 0 ? `tk-${i}` : i % 11 === 0 ? `other-${i}` : undefined,
  'app.version': ['4.9.0', '5.0.0', '6.2.0', '7.1.3', undefined, '6', '4.9', 'v5.0.0'][i % 8], 'app.build': 100 + i,
  'device.platform': ['android', 'ios', 'web'][i % 3], 'device.os_version': ['13', '17.4', '10.15.7'][i % 3],
  'device.browser': i % 5 ? 'chrome' : undefined, 'geo.country': ['US', 'CA', 'DE'][i % 3], 'session.id': i % 2 ? `s-${i}` : undefined,
}));

function parity() {
  let checked = 0;
  for (const env of ['dev', 'prod']) {
    const snap = t.plane.get(env);
    for (const project of ['android', 'ios', 'web']) {
      for (const entity of [...Object.keys(snap.entities), null]) {
        const file = buildFlagdDoc(snap, project, entity ? snap.entities[entity] : null);
        for (const key of Object.keys(snap.flags)) {
          for (const attrs of DEVICES) {
            const sent = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined));
            const want = same(ours(snap, key, project, entity, sent));
            const where = `${env}/${project}/${entity}/${key} ${JSON.stringify(sent)}`;
            const got = cdnAnswer(file, key, sent);
            assert.equal(got.notFound ? 'not found' : same(got), want, where);
            const core = flagdCore(file, key, nest(sent));
            assert.equal(core.notFound ? 'not found' : same(core), want, `flagd-core: ${where}`);
            // no group: flagd JSON has nowhere to put a % group's name (the app reads it over OFREP, metadata.group)
            checked++;
          }
        }
      }
    }
  }
  return checked;
}

test('the device’s answer from the file equals the evaluator, every flag, entity, app and device', () => {
  assert.ok(parity() > 10_000);
});

test('still equal with named % groups, inside and outside, by device and by entity (the names stay on the server)', async () => {
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

test('a device that sends only targetingKey: the same % group from the file (flagd-core) as over OFREP', async () => {
  const key = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'web', scope: 'all' })).json.key;
  const file = (await t.cdnFile('dev', 'web', 'acme')).json;
  const snap = t.plane.get('dev');
  const split = Object.keys(file.flags).filter((k) => JSON.stringify(file.flags[k].targeting ?? null).includes('fractional'));
  assert.ok(split.length > 0, 'a % rule in the web file');
  const groups = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const ofrep = await t.call('POST', '/ofrep/v1/evaluate/flags', { context: { targetingKey: `tk-${i}`, company: 'acme' } }, { authorization: `Bearer ${key}` });
    assert.equal(ofrep.status, 200, JSON.stringify(ofrep.json));
    for (const k of split) {
      const remote = ofrep.json.flags.find((f: { key: string }) => f.key === k);
      const local = flagdCore(file, k, { targetingKey: `tk-${i}` });
      assert.equal(local.codeDefault ? 'code default' : JSON.stringify(local.value), 'value' in remote ? JSON.stringify(remote.value) : 'code default', `${k}, tk-${i}`);
      assert.equal(same(local), same(ours(snap, k, 'web', 'acme', { 'device.id': `tk-${i}` })));
      groups.add(`${k}:${remote.reason}`);
    }
  }
  assert.ok([...groups].some((g) => g.endsWith(':SPLIT')), 'some devices inside a %');
});

test('the file is settled for its entity: no entity lists, nothing about other entities or apps', async () => {
  const snap = t.plane.get('dev');
  const others = Object.keys(snap.entities).filter((k) => k !== 'acme' && !snap.entities.acme.path.includes(k));
  assert.ok(others.length > 3);
  for (const file of [JSON.stringify(buildFlagdDoc(snap, 'web', snap.entities.acme)), JSON.stringify((await t.cdnFile('dev', 'web', 'acme')).json)]) {
    for (const field of ['entity', 'company', 'brand', 'project', 'environment']) assert.ok(!file.includes(`{"var":"${field}"}`), `checks on ${field} are settled on the server`);
    for (const other of others) assert.ok(!file.includes(other), `nothing about ${other}`);
  }
  const anon = JSON.stringify((await t.cdnFile('dev', 'web', null)).json);
  for (const key of Object.keys(snap.entities)) assert.ok(!anon.includes(key), `the file for everyone names no entity (${key})`);
});

test('country rules stay in the file; the device checks them with the CDN’s country header', async () => {
  const flag = Object.keys(t.plane.get('dev').flags).find((k) => t.plane.get('dev').flags[k].delivery.includes('web'))!;
  const serve = (await t.as('alice').get(`/flags/${flag}`)).json.variations.find((v: any) => v.key !== 'code_default');
  const rule = { ruleKey: crypto.randomUUID(), name: 'Canada', locked: false, disabled: false,
    conditions: [{ field: 'geo.country', op: 'in', values: ['CA'] }], serveVariation: serve.key, split: null };
  const r = await t.editBase(flag, 'dev', (layer) => ({ ...layer, rules: [rule, ...layer.rules] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const file = (await t.cdnFile('dev', 'web', 'acme')).json;
  assert.ok(JSON.stringify(file.flags[flag].targeting).includes('{"var":"geo.country"}'));
  assert.deepEqual(cdnAnswer(file, flag, { 'geo.country': 'CA' }).value, serve.value);
});

test('the link: cacheable for a CDN (browsers ask every time), tagged with its environment, entities and link, 304 on the same ETag, gzipped', async () => {
  const ok = await t.cdnFile('dev', 'web', 'acme');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(ok.headers.get('cache-control')!, /^public, max-age=0, s-maxage=60/, 'browsers revalidate each time; the CDN keeps it a minute');
  assert.match(ok.headers.get('cache-control')!, /stale-if-error=86400/);
  assert.ok(!/stale-while-revalidate/.test(ok.headers.get('cache-control')!), 'no stale copy in browsers');
  assert.equal(ok.headers.get('cdn-cache-control'), 'public, max-age=60, stale-while-revalidate=600, stale-if-error=86400');
  assert.equal(ok.headers.get('cache-tag'), `env-dev,${entityTag('dev', 'acme')},${linkTag('dev', 'acme')}`);
  assert.ok(!ok.headers.get('cache-tag')!.includes('acme'), 'the tags name no entity: some CDNs pass them on to the device');
  assert.deepEqual(fileTags('dev', ['lumen', 'globex']), ['env-dev', entityTag('dev', 'lumen'), entityTag('dev', 'globex'), linkTag('dev', 'lumen')], 'an entity’s file carries the tags of those above it');
  const anon = await t.app.request('/cdn/v1/flags/dev/web');
  assert.equal(anon.headers.get('cache-tag'), 'env-dev', 'the file for everyone: its environment only');
  const wrong = await t.app.request('/cdn/v1/flags/dev/web/acme/not-the-secret');
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.get('cache-control'), 'no-store', 'no file: nothing keeps that answer');
  assert.equal(ok.json.$schema, 'https://flagd.dev/schema/v0/flags.json', 'flagd JSON');
  assert.deepEqual(ok.json.metadata, { flagSetId: 'dev/web/acme', environment: 'dev', revision: t.plane.get('dev').revision });
  const etag = ok.headers.get('etag')!;
  assert.match(etag, /^W\/"/, 'weak: the gzipped and plain responses are the same content');
  const notModified = await t.cdnFile('dev', 'web', 'acme', { 'if-none-match': etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('etag'), etag);
  assert.match(notModified.headers.get('cache-control')!, /^public, max-age=0, s-maxage=60/, 'a 304 keeps the caching headers');
  assert.ok(notModified.headers.get('cdn-cache-control'), 'and the CDN’s own');
  // what a CDN or a browser may send back: the ETag without W/ (a strong copy), or a list with ours in it
  assert.equal((await t.cdnFile('dev', 'web', 'acme', { 'if-none-match': etag.slice(2) })).status, 304);
  assert.equal((await t.cdnFile('dev', 'web', 'acme', { 'if-none-match': `W/"other", ${etag}` })).status, 304);
  assert.equal((await t.cdnFile('dev', 'web', 'acme', { 'if-none-match': 'W/"other"' })).status, 200);
  const gz = await t.app.request(await t.link('dev', 'web', 'acme'), { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()), ok.json);
});

test('a link is only good for its own entity and environment; wrong links all look the same', async () => {
  const acme = await t.link('dev', 'web', 'acme');
  const secret = acme.split('/').pop()!;
  const wonka = await t.link('dev', 'web', 'wonka');
  assert.notEqual(wonka.split('/').pop(), secret, 'each entity has its own secret');
  assert.notEqual((await t.link('prod', 'web', 'acme')).split('/').pop(), secret, 'and each environment');
  const get = (p: string) => t.call('GET', p);
  assert.equal((await get(`/cdn/v1/flags/dev/web/wonka/${secret}`)).status, 404, 'acme’s secret on wonka’s path');
  assert.equal((await get(`/cdn/v1/flags/prod/web/acme/${secret}`)).status, 404, 'a dev secret in prod');
  assert.equal((await get(`/cdn/v1/flags/dev/web/nobody/${secret}`)).json.error, (await get(`/cdn/v1/flags/dev/web/acme/wrong`)).json.error);
  assert.equal((await get(`/cdn/v1/flags/dev/server-ds/acme/${secret}`)).status, 404, 'backends don’t get CDN files');
  assert.equal((await get(`/cdn/v1/flags/staging/web`)).status, 404);
  const anon = await get('/cdn/v1/flags/dev/web');
  assert.equal(anon.status, 200, 'before login: what everyone gets');
  assert.equal(anon.json.metadata.flagSetId, 'dev/web', 'no entity');
});

test('replacing an entity’s link stops the old one at once and is in History', async () => {
  const old = await t.link('dev', 'ios', 'globex');
  assert.equal((await t.call('GET', old)).status, 200);
  const r = await t.as('dana').post('/dimensions/company/globex/link/rotate?environment=dev');
  assert.equal(r.status, 200);
  assert.equal((await t.call('GET', old)).status, 404);
  assert.equal((await t.call('GET', r.json.path.replace(':service', 'ios'))).status, 200);
  const h = (await t.as('alice').get('/history?entity=globex')).json;
  assert.ok(h.some((x: any) => x.changeType === 'entity.link_replaced'));
});

test('a publish that changes values changes the file and its ETag', async () => {
  const before_ = await t.cdnFile('dev', 'android', 'wonka');
  assert.ok('android_quick_share' in before_.json.flags);
  const base = (await t.as('alice').get('/flags/android_quick_share')).json.layers.dev.base;
  assert.equal((await t.as('alice').put('/flags/android_quick_share/layers/dev/base', { layer: { ...base, enabled: false }, expectedVersion: base.version })).status, 200);
  await t.settle();
  const after_ = await t.cdnFile('dev', 'android', 'wonka', { 'if-none-match': before_.headers.get('etag')! });
  assert.equal(after_.status, 200);
  assert.equal(after_.headers.get('etag') === before_.headers.get('etag'), false);
  assert.equal(after_.json.flags.android_quick_share.state, 'DISABLED', 'off → flagd’s DISABLED');
  assert.ok(cdnAnswer(after_.json, 'android_quick_share', {}).codeDefault, 'the default in the app’s code');
});

test('Last-Modified beside the ETag, for CDNs that revalidate only with If-Modified-Since (Azure Front Door)', async () => {
  // whole seconds: the date is the second after the change, sent once a second more has passed, so two changes in one
  // second never share a date
  assert.equal(lastModified(1_500, 2_400), null, 'changed at 1.5 s: no date yet at 2.4 s');
  assert.equal(lastModified(1_500, 2_999), null);
  assert.equal(lastModified(1_500, 3_000), 2_000);
  assert.equal(lastModified(2_000, 3_000), 2_000);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const settled = () => wait(Math.ceil(Date.parse(t.plane.get('dev').builtAt) / 1000) * 1000 + 1000 - Date.now() + 20);
  await settled();
  const ok = await t.cdnFile('dev', 'ios', 'wonka');
  const date = ok.headers.get('last-modified')!;
  assert.ok(date && Date.parse(date) <= Date.now(), `a date in the past: ${date}`);
  const since = (d: string, headers: Record<string, string> = {}) => t.cdnFile('dev', 'ios', 'wonka', { 'if-modified-since': d, ...headers });
  const notModified = await since(date);
  assert.equal(notModified.status, 304);
  for (const h of ['etag', 'last-modified', 'cache-control', 'cdn-cache-control', 'cache-tag']) assert.equal(notModified.headers.get(h), ok.headers.get(h), `a 304 keeps ${h}`);
  assert.equal((await since(date, { origin: 'https://app.example.com' })).headers.get('access-control-allow-origin'), '*', 'and CORS, for a browser');
  assert.equal((await since(new Date(Date.parse(date) - 1000).toUTCString())).status, 200, 'an older copy');
  assert.equal((await since('not a date')).status, 200);
  assert.equal((await since(date, { 'if-none-match': 'W/"other"' })).status, 200, 'the ETag wins when both are sent');
  assert.equal((await t.cdnFile('dev', 'ios', 'wonka', { 'if-none-match': ok.headers.get('etag')! })).headers.get('last-modified'), date, 'the ETag’s 304 keeps it too');

  // a publish that leaves the file as it was keeps its date; one that changes it moves the date later
  const snap = t.plane.get('dev');
  const notIos = Object.keys(snap.flags).find((k) => !snap.flags[k].delivery.includes('ios'))!;
  const ios = Object.keys(snap.flags).find((k) => snap.flags[k].delivery.includes('ios') && ok.json.flags[k]?.state === 'ENABLED')!;
  assert.equal((await t.editBase(notIos, 'dev', (l) => ({ ...l, enabled: !l.enabled }))).status, 200);
  const same = await t.cdnFile('dev', 'ios', 'wonka');
  assert.equal(t.plane.get('dev').revision, snap.revision + 1);
  assert.deepEqual([same.headers.get('etag'), same.headers.get('last-modified')], [ok.headers.get('etag'), date]);
  assert.equal((await since(date)).status, 304);
  assert.equal((await t.editBase(ios, 'dev', (l) => ({ ...l, enabled: false }))).status, 200);
  const changed = await since(date);
  assert.equal(changed.status, 200, 'changed: the copy from before is old');
  assert.equal(changed.headers.get('last-modified'), null, 'no date until it is settled');
  await settled();
  const later = await t.cdnFile('dev', 'ios', 'wonka');
  assert.ok(Date.parse(later.headers.get('last-modified')!) > Date.parse(date), 'a later date');
  assert.equal((await since(date)).status, 200);
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
