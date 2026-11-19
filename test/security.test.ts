// What one entity, one role or one request can't do: an entity's backend sees nothing about other entities, a key
// asks only about the entities its scope allows,
// viewers only look, names the console's addresses use can't be keys, prototype names are just unknown keys, and
// errors say what was wrong with the request without giving away the server's insides.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { boot } from './helpers.ts';
import { errorHandler } from '../server/index.ts';
import { LruCache } from '../server/auth.ts';
import { flagdEvaluate, nest, ours, same } from './flagdReference.ts';

const logs: string[] = [];
let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot({ log: (m) => logs.push(m) }); });
after(async () => { await t.stop(); });

const OTHERS = ['microsoft', 'google', 'netflix', 'sap', 'spotify', 'globex', 'initech', 'newco'];
const keyFor = async (body: Record<string, string>) => {
  const r = await t.as('dana').post('/api-keys', { environment: 'dev', project: 'server-wupserver', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.key as string;
};
// flagd JSON for one entity: named in the path by its dimension, or (no path) the key's own
const download = (key: string, path = '', headers: Record<string, string> = {}) => t.call('GET', `/sdk/v1/flagd${path}`, undefined,
  { authorization: `Bearer ${key}`, ...headers });

test('an entity’s backend gets its own settings: no other entity’s key or typed-in value, and the same answers', async () => {
  // typed-in values of their own (hidden "val-" variants) for netflix and microsoft
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'val-nf1', value: 777 }, { key: 'val-ms1', value: 555 }] })).status, 200);
  for (const [entity, value] of [['netflix', 'val-nf1'], ['microsoft', 'val-ms1']]) {
    const flag = (await t.as('alice').get('/flags/max_upload_mb')).json;
    const own = flag.layers.dev.entities.find((c: any) => c.entity === entity);
    const r = await t.as('alice').put(`/flags/max_upload_mb/layers/dev/${entity}`, { layer: { inherit: 'customer_only', defaultVariation: value, rules: [] }, expectedVersion: own?.layer.version ?? null });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  await t.settle();
  const snap = t.plane.get('dev');

  for (const entity of ['acme', 'netflix', 'spotify']) {
    const res = await download(await keyFor({ scope: 'entity', entity }));
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.json);
    for (const other of OTHERS.filter((o) => o !== entity)) assert.ok(!text.includes(`"${other}"`), `${entity}’s download names ${other}`);
    if (entity !== 'netflix') assert.ok(!text.includes('val-nf1') && !text.includes('777'), `${entity} sees netflix’s own value`);
    assert.ok(!text.includes('val-ms1'), `${entity} sees microsoft’s own value`);
    // what the backend works out in-process with flagd is what the server would answer
    for (const flag of Object.keys(res.json.flags)) {
      for (const attrs of [{}, { 'device.id': 'd-1', 'app.version': '6.0.0' }, { 'device.id': 'd-2', 'locale.language': 'de' }]) {
        assert.equal(same(flagdEvaluate(res.json, flag, nest(attrs))), same(ours(snap, flag, 'server-wupserver', entity, attrs)), `${entity} ${flag} ${JSON.stringify(attrs)}`);
      }
    }
  }
  const netflix = JSON.stringify((await download(await keyFor({ scope: 'entity', entity: 'netflix' }))).json);
  assert.ok(netflix.includes('val-nf1'), 'its own typed-in value is there');
  assert.equal((await download(await keyFor({ scope: 'all' }))).status, 400, 'a shared key gets one entity at a time');
});

test('a shared backend asking for an entity that doesn’t exist, or in the wrong dimension, gets a 404', async () => {
  const key = await keyFor({ scope: 'all' });
  for (const entity of ['nobody', '*', 'constructor', '__proto__', 'hasOwnProperty']) {
    const r = await download(key, `/company/${encodeURIComponent(entity)}`);
    assert.equal(r.status, 404, entity);
    assert.match(r.json.error, /no company/);
  }
  assert.equal((await download(key, '/company/acme')).status, 200);
  assert.equal((await download(key, '/brand/acme')).status, 404, 'Acme is a company');
  assert.equal((await download(key, '/constructor/acme')).status, 404, 'a prototype name is no dimension');
});

test('key scopes: one entity, an entity and those under it, or any; the key is the only header', async () => {
  const dana = t.as('dana');
  assert.equal((await dana.post('/dimensions/brand', { key: 'nf-kids', name: 'Netflix Kids', parent: 'netflix' })).status, 201);
  assert.equal((await dana.post('/dimensions/brand', { key: 'ms-xbox', name: 'Xbox', parent: 'microsoft' })).status, 201);
  await t.settle();
  const own = await keyFor({ scope: 'entity', entity: 'netflix' });
  const below = await keyFor({ scope: 'below', entity: 'netflix' });
  const any = await keyFor({ scope: 'all' });
  const id = async (key: string, path = '', headers: Record<string, string> = {}) => {
    const r = await download(key, path, headers);
    return r.status === 200 ? r.json.metadata.flagSetId : r.status;
  };
  // an entity's key: only its entity, with the path or without
  assert.deepEqual([await id(own), await id(own, '/company/netflix'), await id(own, '/brand/nf-kids'), await id(own, '/company/acme')],
    ['dev/netflix', 'dev/netflix', 403, 403]);
  // below: its entity and every entity under it, not its parent's others or other companies'
  assert.deepEqual([await id(below), await id(below, '/company/netflix'), await id(below, '/brand/nf-kids'), await id(below, '/brand/ms-xbox'), await id(below, '/company/acme')],
    ['dev/netflix', 'dev/netflix', 'dev/nf-kids', 403, 403]);
  // all: any, named in the path
  assert.deepEqual([await id(any, '/brand/nf-kids'), await id(any, '/brand/ms-xbox'), await id(any)], ['dev/nf-kids', 'dev/ms-xbox', 400]);
  // X-Customer-Id, from before dimensions, still names the entity for an `all` key; it never widens a narrower key
  assert.equal(await id(any, '', { 'x-customer-id': 'nf-kids' }), 'dev/nf-kids');
  assert.equal(await id(own, '', { 'x-customer-id': 'acme' }), 'dev/netflix', 'an entity’s key ignores it');
  assert.equal(await id(below, '', { 'x-customer-id': 'acme' }), 'dev/netflix');
  // moving Netflix Kids out from under Netflix takes it out of the `below` key's reach at once (the key cache is untouched)
  assert.equal((await dana.put('/dimensions/brand/nf-kids', { name: 'Netflix Kids', parent: 'microsoft' })).status, 200);
  await t.settle();
  assert.deepEqual([await id(below, '/brand/nf-kids'), await id(any, '/brand/nf-kids')], [403, 'dev/nf-kids']);
  assert.equal((await dana.put('/dimensions/brand/nf-kids', { name: 'Netflix Kids', parent: 'netflix' })).status, 200);
  await t.settle();
  assert.equal(await id(below, '/brand/nf-kids'), 'dev/nf-kids', 'and back in at once');
  // what's refused when a key is made
  const bad = async (body: Record<string, string>) => (await dana.post('/api-keys', { environment: 'dev', project: 'server-ds', ...body })).status;
  assert.deepEqual([await bad({ scope: 'below' }), await bad({ scope: 'entity', entity: 'nobody' }), await bad({ scope: 'customer', entity: 'acme' }),
    await bad({ scope: 'all_customers' })], [422, 422, 422, 422]);
  const listed = (await t.as('alice').get('/api-keys')).json.find((k: any) => k.scope === 'below' && k.entity === 'netflix');
  assert.deepEqual([listed.dimension, listed.projectKind], ['company', 'server']);
});

test('viewers run the evaluator and nothing else: only POST /api/trace and POST /api/compare', async () => {
  const vic = t.as('vic@example.com');                     // someone new: a viewer
  assert.equal((await vic.get('/meta')).json.me.role, 'viewer');
  assert.equal((await vic.post('/trace', { environment: 'dev', project: 'web', entity: 'acme', attrs: {} })).status, 200);
  const side = { environment: 'dev', project: 'web', entity: 'acme' };
  assert.equal((await vic.post('/compare', { a: side, b: { ...side, entity: null } })).status, 200);
  for (const [method, path] of [['PUT', '/dimensions/company/trace'], ['PUT', '/dimensions'], ['PUT', '/flags/new_checkout/layers/prod/compare'], ['DELETE', '/flags/new_checkout/layers/dev/trace'],
    ['POST', '/flags/new_checkout/publish/trace'], ['POST', '/dimensions/company/acme/link/rotate?x=/trace'], ['PUT', '/flags/new_checkout/delivery']] as const) {
    const r = method === 'PUT' ? await vic.put(path, {}) : method === 'DELETE' ? await vic.del(path) : await vic.post(path);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.json.error, /viewers can look but not change anything/);
  }
  // an entity's app link is a secret: anyone with it reads the entity's file
  assert.equal((await vic.get('/dimensions/company/acme/link?environment=dev')).status, 403);
  assert.equal((await t.as('alice').get('/dimensions/company/acme/link?environment=dev')).status, 200, 'editors and above');
});

test('“base”, “trace” and “compare” can’t be entity or environment keys', async () => {
  for (const key of ['base', 'trace', 'compare']) {
    const c = await t.as('alice').post('/dimensions/company', { key, name: key });
    assert.equal(c.status, 422, key);
    assert.match(c.json.error, /reserved word/);
    assert.equal((await t.as('dana').post('/environments', { key, name: key })).status, 422, key);
  }
});

test('prototype names are unknown keys like any other', async () => {
  for (const key of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
    assert.equal((await t.as('alice').get(`/dimensions/company/${key}/flags?environment=dev`)).status, 404, `entity ${key}`);
    assert.equal((await t.as('alice').get(`/dimensions/company/${key}/children?environment=dev`)).status, 404, `children of ${key}`);
    assert.equal((await t.as('alice').get(`/dimensions/${key}`)).status, 404, `dimension ${key}`);
    assert.equal((await t.as('alice').post('/trace', { environment: 'dev', project: 'web', entity: key, attrs: {} })).status, 404, `trace as ${key}`);
    const flag = await t.as('alice').post('/trace', { environment: 'dev', project: 'web', entity: null, attrs: { [key]: 'x' }, flag: key });
    assert.equal(flag.json.result.errorCode, 'FLAG_NOT_FOUND', `flag ${key}`);
    assert.equal((await t.call('GET', `/client/v1/flags/dev/web/${key}/secret`)).status, 404, `file of ${key}`);
  }
  assert.equal((await t.as('alice').get('/dimensions/company/constructor/flags')).status, 404);
  assert.equal((await t.as('alice').get('/dimensions/company/acme/flags?environment=constructor')).status, 404, 'an environment too');
});

test('one entity: the same row as in its dimension’s list, or 404', async () => {
  const rows = async (dim: string) => (await t.as('alice').get(`/dimensions/${dim}`)).json;
  const lists = { company: await rows('company'), brand: await rows('brand') };
  for (const [dim, key] of [['company', 'netflix'], ['brand', 'nf-kids'], ['company', 'acme']] as const) {
    const one = await t.as('vic@example.com').get(`/dimensions/${dim}/${key}`);
    assert.equal(one.status, 200, key);
    assert.deepEqual(one.json, lists[dim].find((c: any) => c.key === key), key);
  }
  const netflix = (await t.as('alice').get('/dimensions/company/netflix')).json;
  assert.deepEqual([netflix.children, netflix.parent, typeof netflix.createdAt, netflix.flagsWithSettings.dev > 0], [1, null, 'string', true]);
  assert.equal((await t.as('alice').get('/dimensions/brand/nf-kids')).json.parentName, 'Netflix');
  assert.equal((await t.as('alice').get('/dimensions/company/nf-kids')).status, 404, 'in its own dimension only');
  assert.equal((await t.as('alice').get('/dimensions/company/nobody')).status, 404);
  await t.db.query(`update entity set archived_at = now() where key = 'newco'`);
  assert.equal((await t.as('alice').get('/dimensions/company/newco')).status, 404, 'an archived entity isn’t listed');
});

test('replacing an entity’s link is a new version in every environment, so its files are published (and purged) again', async () => {
  const before = { dev: t.plane.get('dev').revision, prod: t.plane.get('prod').revision };
  const old = await t.link('prod', 'web', 'globex');
  assert.equal((await t.call('GET', old)).status, 200);
  assert.equal((await t.as('alice').post('/dimensions/company/globex/link/rotate?environment=prod')).status, 200);
  await t.settle();
  for (const env of ['dev', 'prod'] as const) assert.ok(t.plane.get(env).revision > before[env], `${env} has a new version`);
  const h = (await t.as('alice').get('/history?entity=globex')).json.filter((x: any) => x.changeType === 'entity.link_replaced');
  assert.ok(h.length >= 2 && h.every((x: any) => x.revision > 0), 'in History with the version it made');
  assert.equal((await t.call('GET', old)).status, 404);
});

test('API keys: listed without their secret; revoked ones say so', async () => {
  const made = (await t.as('dana').post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'entity', entity: 'acme', label: 'acme backend' })).json;
  await t.as('dana').post(`/api-keys/${made.id}/revoke`);
  const list = await t.as('alice').get('/api-keys');
  assert.equal(list.status, 200);
  const row = list.json.find((k: any) => k.id === made.id);
  assert.deepEqual([row.prefix, row.label, row.environment, row.project, row.projectKind, row.scope, row.entity, row.dimension, !!row.revokedAt],
    [made.prefix, 'acme backend', 'dev', 'server-ds', 'server', 'entity', 'acme', 'company', true]);
  assert.ok(!JSON.stringify(list.json).includes(made.key), 'never the key itself');
  assert.ok(list.json.findIndex((k: any) => k.id === made.id) > list.json.findIndex((k: any) => !k.revokedAt), 'revoked keys come last');
});

test('a key’s prefix is its readable part and 4 characters of the secret, never more', async () => {
  const { newApiKey } = await import('../server/auth.ts');
  for (let i = 0; i < 2000; i++) {                          // the secret is base64url: it has "_" in it now and then
    const k = newApiKey('prod', 'server-ds');
    assert.ok(k.raw.startsWith(k.prefix) && k.prefix.length === 'ff_prod_serverds_'.length + 4, k.prefix);
  }
});

test('the API key cache keeps the keys used most recently, so a spray of made-up keys can’t push out the real ones', () => {
  const lru = new LruCache<string, number>(3);
  lru.set('a', 1); lru.set('b', 2); lru.set('c', 3);
  assert.equal(lru.get('a'), 1);                           // a is used: now the newest
  lru.set('d', 4);                                         // full: the one used longest ago (b) goes
  assert.deepEqual([lru.get('a'), lru.get('b'), lru.get('c'), lru.get('d'), lru.size], [1, undefined, 3, 4, 3]);
  for (let i = 0; i < 100; i++) lru.set(`spray-${i}`, i);
  assert.equal(lru.size, 3, 'never more than its size');
});

test('a client app that doesn’t exist is answered from memory; adding it makes its file appear at once', async () => {
  assert.equal((await t.call('GET', '/client/v1/flags/dev/tvos')).status, 404);
  assert.equal((await t.call('GET', '/client/v1/flags/dev/tvos')).status, 404);
  assert.equal((await t.as('dana').post('/apps', { key: 'tvos', kind: 'client' })).status, 201);
  assert.equal((await t.call('GET', '/client/v1/flags/dev/tvos')).status, 200);
});

test('a % of devices is saved with hash version 2; a file that failed to build is built again on the next request', async () => {
  const pct = (hashVersion: number) => (layer: any) => ({ ...layer, rules: [...layer.rules, { ruleKey: crypto.randomUUID(), name: 'half the companies',
    conditions: [], split: { by: 'entity', hashVersion, ranges: [{ variation: 'huge', from: 0, to: 5000 }] } }] });
  const bad = await t.editBase('max_upload_mb', 'dev', pct(3));
  assert.equal(bad.status, 422);
  assert.match(bad.json.errors.join(), /hash version 3 doesn’t exist/);
  await assert.rejects(t.db.query(`update flag_rule set split_hash_version = 1 where split_by is not null`), /flag_rule_hash_version_check/);
  assert.equal((await t.editBase('max_upload_mb', 'dev', pct(1))).status, 200, 'sent with 1 (an older version restored): saved with 2');
  const saved = (await t.baseOf('max_upload_mb', 'dev')).layer.rules.find((r: any) => r.split?.by === 'entity');
  assert.equal(saved.split.hashVersion, 2);

  // the published snapshot, broken in memory for a moment (as a rule from before the check would be): the build fails…
  const rule = t.plane.get('dev').flags.max_upload_mb.base.rules.find((r) => r.split?.by === 'entity')!;
  const link = await t.link('dev', 'web', 'initech');
  rule.split!.hashVersion = 3;
  logs.length = 0;
  const failed = await t.call('GET', link);
  assert.deepEqual([failed.status, failed.json], [500, { error: 'internal error' }], 'nothing about the server’s insides');
  assert.ok(logs.some((l) => /unsupported hash_version 3/.test(l) && /at /.test(l)), 'logged, with its stack');
  // …and isn't kept: once the snapshot is right again, the same publish's file is built
  rule.split!.hashVersion = 2;
  assert.equal((await t.call('GET', link)).status, 200);
});

test('errors: bad JSON is a 400, the schema’s rules a 422 with their words, and anything else a logged 500 that says nothing', async () => {
  const raw = await t.app.request('/api/dimensions/company', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'alice', 'x-requested-with': 'companyfeatures' }, body: '{"key": "acme",' });
  assert.equal(raw.status, 400);
  assert.deepEqual(await raw.json(), { error: 'the request body isn’t valid JSON' });

  const flag = (key: string) => ({ key, valueType: 'bool', kind: 'ops', delivery: {}, variations: [{ key: 'on', value: true }], base: { enabled: false, defaultVariation: 'on', rules: [] } });
  const badKey = await t.as('alice').post('/flags', flag('Not A Key'));                       // a check constraint (23514)
  assert.equal(badKey.status, 422);
  assert.match(badKey.json.error, /violates check constraint/);
  const twice = await t.as('alice').post('/flags', flag('new_checkout'));                     // a unique key (23505)
  assert.equal(twice.status, 422);
  assert.match(twice.json.error, /duplicate key/);
  const wrongType = await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'words', value: 'lots' }] });   // a trigger (P0001)
  assert.equal(wrongType.status, 422);
  assert.match(wrongType.json.error, /must be of type number/);

  // a bug is a bug, whatever its message says
  const seen: string[] = [];
  const app = new Hono();
  app.onError(errorHandler((m) => seen.push(m)));
  app.get('/type-error', () => { throw new TypeError('Cannot read properties of undefined (reading "x")'); });
  app.get('/sounds-like-a-rule', () => { throw new Error('value violates nothing: it must exist'); });
  app.get('/pg', () => { throw Object.assign(new Error('null value in column "name" violates not-null constraint'), { code: '23502' }); });
  for (const path of ['/type-error', '/sounds-like-a-rule']) {
    const r = await app.request(path);
    assert.deepEqual([r.status, await r.json()], [500, { error: 'internal error' }], path);
  }
  assert.equal(seen.length, 2);
  assert.ok(seen.every((l) => /at /.test(l)), 'with the stack');
  const pg = await app.request('/pg');
  assert.deepEqual([pg.status, await pg.json()], [422, { error: 'null value in column "name" violates not-null constraint' }]);
});
