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

const OTHERS = ['vandelay', 'wonka', 'soylent', 'cyberdyne', 'oscorp', 'globex', 'initech', 'newco'];
const keyFor = async (body: Record<string, string>) => {
  const r = await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-wupserver', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.key as string;
};
// flagd JSON for one entity: named in the path by its dimension, or (no path) the key's own
const download = (key: string, path = '', headers: Record<string, string> = {}) => t.call('GET', `/sdk/v1/flagd${path}`, undefined,
  { authorization: `Bearer ${key}`, ...headers });

test('an entity’s backend gets its own settings: no other entity’s key or typed-in value, and the same answers', async () => {
  // typed-in values of their own (hidden "val-" variants) for soylent and vandelay
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'val-nf1', value: 777 }, { key: 'val-ms1', value: 555 }] })).status, 200);
  for (const [entity, value] of [['soylent', 'val-nf1'], ['vandelay', 'val-ms1']]) {
    const flag = (await t.as('alice').get('/flags/max_upload_mb')).json;
    const own = flag.layers.dev.entities.find((c: any) => c.entity === entity);
    const r = await t.as('alice').put(`/flags/max_upload_mb/layers/dev/${entity}`, { layer: { inherit: 'customer_only', defaultVariation: value, rules: [] }, expectedVersion: own?.layer.version ?? null });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  await t.settle();
  const snap = t.plane.get('dev');

  for (const entity of ['acme', 'soylent', 'oscorp']) {
    const res = await download(await keyFor({ scope: 'entity', entity }));
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.json);
    for (const other of OTHERS.filter((o) => o !== entity)) assert.ok(!text.includes(`"${other}"`), `${entity}’s download names ${other}`);
    if (entity !== 'soylent') assert.ok(!text.includes('val-nf1') && !text.includes('777'), `${entity} sees soylent’s own value`);
    assert.ok(!text.includes('val-ms1'), `${entity} sees vandelay’s own value`);
    // what the backend works out in-process with flagd is what the server would answer
    for (const flag of Object.keys(res.json.flags)) {
      for (const attrs of [{}, { 'device.id': 'd-1', 'app.version': '6.0.0' }, { 'device.id': 'd-2', 'locale.language': 'de' }]) {
        assert.equal(same(flagdEvaluate(res.json, flag, nest(attrs))), same(ours(snap, flag, 'server-wupserver', entity, attrs)), `${entity} ${flag} ${JSON.stringify(attrs)}`);
      }
    }
  }
  const soylent = JSON.stringify((await download(await keyFor({ scope: 'entity', entity: 'soylent' }))).json);
  assert.ok(soylent.includes('val-nf1'), 'its own typed-in value is there');
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
  assert.equal((await dana.post('/dimensions/brand', { key: 'sl-kids', name: 'Soylent Kids', parent: 'soylent' })).status, 201);
  assert.equal((await dana.post('/dimensions/brand', { key: 'vd-latex', name: 'Vandelay Latex', parent: 'vandelay' })).status, 201);
  await t.settle();
  const own = await keyFor({ scope: 'entity', entity: 'soylent' });
  const below = await keyFor({ scope: 'below', entity: 'soylent' });
  const any = await keyFor({ scope: 'all' });
  const id = async (key: string, path = '', headers: Record<string, string> = {}) => {
    const r = await download(key, path, headers);
    return r.status === 200 ? r.json.metadata.flagSetId : r.status;
  };
  // an entity's key: only its entity, with the path or without
  assert.deepEqual([await id(own), await id(own, '/company/soylent'), await id(own, '/brand/sl-kids'), await id(own, '/company/acme')],
    ['dev/server-wupserver/soylent', 'dev/server-wupserver/soylent', 403, 403]);
  // below: its entity and every entity under it, not its parent's others or other companies'
  assert.deepEqual([await id(below), await id(below, '/company/soylent'), await id(below, '/brand/sl-kids'), await id(below, '/brand/vd-latex'), await id(below, '/company/acme')],
    ['dev/server-wupserver/soylent', 'dev/server-wupserver/soylent', 'dev/server-wupserver/sl-kids', 403, 403]);
  // all: any, named in the path
  assert.deepEqual([await id(any, '/brand/sl-kids'), await id(any, '/brand/vd-latex'), await id(any)], ['dev/server-wupserver/sl-kids', 'dev/server-wupserver/vd-latex', 400]);
  // a header never names the entity: only the path or the key does
  assert.equal(await id(any, '', { 'x-customer-id': 'sl-kids' }), 400);
  assert.equal(await id(own, '', { 'x-customer-id': 'acme' }), 'dev/server-wupserver/soylent');
  // moving Soylent Kids out from under Soylent takes it out of the `below` key's reach at once (the key cache is untouched)
  assert.equal((await dana.put('/dimensions/brand/sl-kids', { name: 'Soylent Kids', parent: 'vandelay' })).status, 200);
  await t.settle();
  assert.deepEqual([await id(below, '/brand/sl-kids'), await id(any, '/brand/sl-kids')], [403, 'dev/server-wupserver/sl-kids']);
  assert.equal((await dana.put('/dimensions/brand/sl-kids', { name: 'Soylent Kids', parent: 'soylent' })).status, 200);
  await t.settle();
  assert.equal(await id(below, '/brand/sl-kids'), 'dev/server-wupserver/sl-kids', 'and back in at once');
  // what's refused when a key is made
  const bad = async (body: Record<string, string>) => (await dana.post('/api-keys', { environment: 'dev', service: 'server-ds', ...body })).status;
  assert.deepEqual([await bad({ scope: 'below' }), await bad({ scope: 'entity', entity: 'nobody' }), await bad({ scope: 'customer', entity: 'acme' }),
    await bad({ scope: 'all_customers' })], [422, 422, 422, 422]);
  const listed = (await t.as('alice').get('/api-keys')).json.find((k: any) => k.scope === 'below' && k.entity === 'soylent');
  assert.deepEqual([listed.dimension, listed.serviceKind], ['company', 'server']);
});

test('viewers run the evaluator and nothing else: only POST /api/trace and POST /api/compare', async () => {
  const vic = t.as('vic@example.com');                     // someone new: a viewer
  assert.equal((await vic.get('/meta')).json.me.role, 'viewer');
  assert.equal((await vic.post('/trace', { environment: 'dev', service: 'web', entity: 'acme', attrs: {} })).status, 200);
  const side = { environment: 'dev', service: 'web', entity: 'acme' };
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
    assert.equal((await t.as('alice').post('/trace', { environment: 'dev', service: 'web', entity: key, attrs: {} })).status, 404, `trace as ${key}`);
    const flag = await t.as('alice').post('/trace', { environment: 'dev', service: 'web', entity: null, attrs: { [key]: 'x' }, flag: key });
    assert.equal(flag.json.result.errorCode, 'FLAG_NOT_FOUND', `flag ${key}`);
    assert.equal((await t.call('GET', `/cdn/v1/flags/dev/web/${key}/secret`)).status, 404, `file of ${key}`);
  }
  assert.equal((await t.as('alice').get('/dimensions/company/constructor/flags?environment=dev')).status, 404);
  assert.equal((await t.as('alice').get('/dimensions/company/acme/flags?environment=constructor')).status, 404, 'an environment too');
});

test('one entity: the same row as in its dimension’s list, or 404', async () => {
  const rows = async (dim: string) => (await t.as('alice').get(`/dimensions/${dim}`)).json;
  const lists = { company: await rows('company'), brand: await rows('brand') };
  for (const [dim, key] of [['company', 'soylent'], ['brand', 'sl-kids'], ['company', 'acme']] as const) {
    const one = await t.as('vic@example.com').get(`/dimensions/${dim}/${key}`);
    assert.equal(one.status, 200, key);
    assert.deepEqual(one.json, lists[dim].find((c: any) => c.key === key), key);
  }
  const soylent = (await t.as('alice').get('/dimensions/company/soylent')).json;
  assert.deepEqual([soylent.children, soylent.parent, typeof soylent.createdAt, soylent.flagsWithSettings.dev > 0], [1, null, 'string', true]);
  assert.equal((await t.as('alice').get('/dimensions/brand/sl-kids')).json.parentName, 'Soylent');
  assert.equal((await t.as('alice').get('/dimensions/company/sl-kids')).status, 404, 'in its own dimension only');
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

test('every wrong app link gets the same answer, so links can’t be used to find out which entities exist', async () => {
  const fake = 'AAAAAAAAAAAAAAAAAAAAAA';
  const answer = async (path: string) => { const r = await t.call('GET', path); return JSON.stringify([r.status, r.json]); };
  const wrong = await answer(`/cdn/v1/flags/dev/web/no-such-entity/${fake}`);
  assert.equal(wrong, JSON.stringify([404, { error: 'no file at this link', code: 'not_found' }]));
  for (const path of [
    `/cdn/v1/flags/dev/web/vandelay/${fake}`,                          // an entity that exists, a wrong secret
    `/cdn/v1/flags/dev/zz-not-a-flag-set/vandelay/${fake}`,            // and a service that doesn't
    `/cdn/v1/flags/dev/zz-not-a-flag-set/no-such-entity/${fake}`,
    `/cdn/v1/flags/zz-not-an-env/web/vandelay/${fake}`,
    (await t.link('dev', 'web', 'wonka')).replace('/web/', '/zz-not-a-flag-set/'),   // the right secret, a service that doesn't exist
  ]) assert.equal(await answer(path), wrong, path);
});

test('an admin replaces every app link and token in an environment at once; the others go on', async () => {
  const devLink = await t.link('dev', 'web', 'acme');
  const prodLink = await t.link('prod', 'web', 'acme');
  const { appToken } = await import('../server/delivery.ts');
  const token = await appToken(t.db, 'dev', 'acme', 'web');
  const ofrep = (bearer: string) => t.call('POST', '/ofrep/v1/evaluate/flags', { context: {} }, { authorization: `Bearer ${bearer}` });
  assert.equal((await ofrep(token)).status, 200);
  const revision = t.plane.get('dev').revision;
  assert.equal((await t.as('alice').post('/environments/dev/links/rotate')).status, 403, 'admins only');
  assert.equal((await t.as('dana').post('/environments/nope/links/rotate')).status, 404);
  assert.equal((await t.as('dana').post('/environments/dev/links/rotate')).status, 200);
  await t.settle();
  assert.ok(t.plane.get('dev').revision > revision, 'a new version: published, and the CDN purged');
  assert.equal((await t.call('GET', devLink)).status, 404, 'the old link');
  assert.equal((await ofrep(token)).status, 401, 'the old token');
  const newLink = await t.link('dev', 'web', 'acme');
  assert.notEqual(newLink, devLink);
  assert.equal((await t.call('GET', newLink)).status, 200, 'the new link');
  assert.equal((await ofrep(await appToken(t.db, 'dev', 'acme', 'web'))).status, 200, 'the new token');
  assert.equal((await t.call('GET', prodLink)).status, 200, 'another environment’s links go on');
  const h = (await t.as('dana').get('/history?environment=dev')).json as any[];
  assert.ok(h.some((x) => x.changeType === 'environment.links_replaced' && x.changedBy === 'dana'), 'in History');
});

test('a body larger than its address allows is refused as it comes, even sent in chunks with no length', async () => {
  // a body made as it is read: how much of it the server read
  const endless = (chunk = 64 * 1024, total = 64 * 1024 * 1024) => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent >= total) { c.close(); return; } sent += chunk; c.enqueue(new Uint8Array(chunk).fill(97)); },
    });
    return { body, sent: () => sent };
  };
  const post = (path: string, body: ReadableStream<Uint8Array> | string, headers: Record<string, string> = {}) => t.app.request(path,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, duplex: 'half' } as RequestInit);
  for (const [path, limit] of [['/hooks/v1/ffh_1_AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1000 * 1024], ['/api/auth/sign-in/email', 256 * 1024],
    ['/ofrep/v1/evaluate/flags', 64 * 1024], ['/api/flags', 1024 * 1024]] as const) {
    const b = endless();
    const r = await post(path, b.body);
    assert.equal(r.status, 413, path);
    assert.match(((await r.json()) as { error: string }).error, /the request body is larger than/);
    assert.ok(b.sent() <= limit + 2 * 64 * 1024, `${path}: read ${b.sent()} bytes of 64 MB`);
  }
  const said = await post('/ofrep/v1/evaluate/flags', '{}', { 'content-length': String(10 * 1024 * 1024) });
  assert.equal(said.status, 413, 'a length over the limit: refused before reading');
  assert.equal((await post('/ofrep/v1/evaluate/flags', JSON.stringify({ context: {} }))).status, 401, 'a body within it goes on');
});

test('API keys: listed without their secret; revoked ones say so', async () => {
  const made = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'entity', entity: 'acme', label: 'acme backend' })).json;
  await t.as('dana').post(`/api-keys/${made.id}/revoke`);
  const list = await t.as('alice').get('/api-keys');
  assert.equal(list.status, 200);
  const row = list.json.find((k: any) => k.id === made.id);
  assert.deepEqual([row.prefix, row.label, row.environment, row.service, row.serviceKind, row.scope, row.entity, row.dimension, !!row.revokedAt],
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
  assert.equal((await t.call('GET', '/cdn/v1/flags/dev/tvos')).status, 404);
  assert.equal((await t.call('GET', '/cdn/v1/flags/dev/tvos')).status, 404);
  assert.equal((await t.as('dana').post('/services', { key: 'tvos', kind: 'client' })).status, 201);
  assert.equal((await t.call('GET', '/cdn/v1/flags/dev/tvos')).status, 200);
});

test('a % of devices is saved with hash version 2; a file that failed to build is built again on the next request', async () => {
  const pct = (hashVersion: number) => (layer: any) => ({ ...layer, rules: [...layer.rules, { ruleKey: crypto.randomUUID(), name: 'half the companies',
    conditions: [], split: { by: 'entity', hashVersion, ranges: [{ variation: 'huge', from: 0, to: 5000 }] } }] });
  const bad = await t.editBase('max_upload_mb', 'dev', pct(3));
  assert.equal(bad.status, 422);
  assert.match(bad.json.errors.join(), /hash version 3 doesn’t exist/);
  await assert.rejects(t.db.query(`update flag_rule set split_hash_version = 1 where split_by is not null`), /flag_rule_hash_version_check/);
  assert.equal((await t.editBase('max_upload_mb', 'dev', pct(1))).status, 422, 'hash version 1 is gone too');
  assert.equal((await t.editBase('max_upload_mb', 'dev', pct(2))).status, 200);
  const saved = (await t.baseOf('max_upload_mb', 'dev')).layer.rules.find((r: any) => r.split?.by === 'entity');
  assert.equal(saved.split.hashVersion, 2);

  // the published snapshot, broken in memory for a moment (as a rule from before the check would be): the build fails…
  const rule = t.plane.get('dev').flags.max_upload_mb.base.rules.find((r) => r.split?.by === 'entity')!;
  const link = await t.link('dev', 'web', 'initech');
  rule.split!.hashVersion = 3;
  logs.length = 0;
  const failed = await t.call('GET', link);
  assert.deepEqual([failed.status, failed.json], [500, { error: 'internal error', code: 'internal' }], 'nothing about the server’s insides');
  assert.ok(logs.some((l) => /unsupported hash_version 3/.test(l) && /at /.test(l)), 'logged, with its stack');
  const secret = link.split('/').pop()!;
  assert.ok(logs.every((l) => !l.includes(secret)), 'never the link’s secret: the log names the route');
  assert.ok(logs.some((l) => l.includes('GET /cdn/v1/flags/:env/:app/:entity/:secret')));
  // …and isn't kept: once the snapshot is right again, the same publish's file is built
  rule.split!.hashVersion = 2;
  assert.equal((await t.call('GET', link)).status, 200);
});

test('errors: bad JSON is a 400, the schema’s rules a 409 or 422 in plain words, and anything else a logged 500 that says nothing', async () => {
  const raw = await t.app.request('/api/dimensions/company', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'alice', 'x-requested-with': 'companyflags' }, body: '{"key": "acme",' });
  assert.equal(raw.status, 400);
  assert.deepEqual(await raw.json(), { error: 'the request body isn’t valid JSON', code: 'bad_json' });

  const flag = (key: string) => ({ key, valueType: 'bool', kind: 'ops', delivery: {}, variations: [{ key: 'on', value: true }], base: { enabled: false, defaultVariation: 'on', rules: [] } });
  const badKey = await t.as('alice').post('/flags', flag('Not A Key'));
  assert.deepEqual([badKey.status, badKey.json.code], [422, 'invalid']);
  assert.doesNotMatch(badKey.json.error, /constraint/);
  const twice = await t.as('alice').post('/flags', flag('new_checkout'));
  assert.deepEqual([twice.status, twice.json.code], [409, 'already_exists']);
  assert.doesNotMatch(twice.json.error, /duplicate key/);
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
    assert.deepEqual([r.status, await r.json()], [500, { error: 'internal error', code: 'internal' }], path);
  }
  assert.equal(seen.length, 2);
  assert.ok(seen.every((l) => /at /.test(l)), 'with the stack');
  const pg = await app.request('/pg');
  assert.deepEqual([pg.status, await pg.json()], [422, { error: 'a value the request needs is missing', code: 'invalid' }]);
  assert.ok(seen.some((l) => /violates not-null constraint/.test(l)), 'the database’s words go to the log');
});
