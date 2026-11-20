// The stable API, /api/v1 (server/apiV1.ts): its lists page with ?limit and ?cursor into { items, next }, the
// environment is in the address, a service is a service, errors are { error, code }, and every change goes through
// the same roles, approvals and History as the console's.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
let token: string;
before(async () => {
  t = await boot();
  token = (await t.as('alice').post('/tokens', { name: 'ci' })).json.token;
});
after(async () => { await t.stop(); });

/** A script's request: the access token, no console header. */
const v1 = async (method: string, path: string, body?: unknown, who = token) => {
  const res = await t.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

/** Every item of a list, page by page. */
async function everything(path: string, limit: number) {
  const items: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const r = await v1('GET', `${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(Object.keys(r.json).sort(), ['items', 'next']);
    assert.ok(r.json.items.length <= limit);
    items.push(...r.json.items);
    cursor = r.json.next;
    pages++;
  } while (cursor);
  return { items, pages };
}

test('environments and services: { items, next }, and a service is an app or a backend', async () => {
  const envs = await everything('/environments', 1);
  assert.deepEqual(envs.items.map((e) => e.key), ['dev', 'prod']);
  assert.equal(envs.pages, 2);
  assert.deepEqual(envs.items.find((e) => e.key === 'prod'), { key: 'prod', name: 'Production', approvals: 1 });
  const services = (await v1('GET', '/services')).json.items;
  assert.deepEqual(services.find((s: any) => s.key === 'web'), { key: 'web', kind: 'app' });
  assert.deepEqual(services.find((s: any) => s.key === 'server-ds'), { key: 'server-ds', kind: 'backend' });
});

test('the flags of an environment, page by page: every flag once, in key order', async () => {
  const all = (await t.as('alice').get('/flags?environment=dev&page=0&size=200')).json.rows.map((f: any) => f.key);
  const paged = await everything('/environments/dev/flags', 3);
  assert.deepEqual(paged.items.map((f) => f.key), [...all].sort());
  assert.ok(paged.pages > 2);
  const one = paged.items.find((f) => f.key === 'android_quick_share');
  assert.deepEqual(Object.keys(one).sort(), ['description', 'enabled', 'key', 'kind', 'name', 'owner', 'removeBy', 'services', 'tags', 'valueType']);
  assert.ok(one.services.includes('android'));
  const found = (await v1('GET', '/environments/dev/flags?q=quick')).json.items.map((f: any) => f.key);
  assert.deepEqual(found, ['android_quick_share']);
});

test('one flag, then on or off: applied where no approval is needed, a request for review where it is', async () => {
  const f = (await v1('GET', '/environments/dev/flags/max_upload_mb')).json;
  assert.equal(f.key, 'max_upload_mb');
  assert.ok(Number.isInteger(f.layer.version) && Array.isArray(f.variants));
  const off = await v1('PUT', '/environments/dev/flags/max_upload_mb/enabled', { enabled: !f.enabled });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(off.json.applied, true);
  assert.ok(Number.isInteger(off.json.revision));
  assert.equal((await v1('GET', '/environments/dev/flags/max_upload_mb')).json.enabled, !f.enabled);

  const noReason = await v1('PUT', '/environments/prod/flags/max_upload_mb/enabled', { enabled: false });
  assert.deepEqual([noReason.status, noReason.json.code], [422, 'invalid'], 'a request for review needs a reason');
  const asked = await v1('PUT', '/environments/prod/flags/max_upload_mb/enabled', { enabled: false, reason: 'Turning it off for the migration' });
  assert.equal(asked.status, 202, JSON.stringify(asked.json));
  assert.deepEqual([asked.json.applied, Number.isInteger(asked.json.request)], [false, true]);
  const req = (await t.as('alice').get(`/change-sets/${asked.json.request}`)).json;
  assert.equal(req.status, 'in_review');
});

test('publish: several changes in one version, sent with the version each layer had', async () => {
  const a = (await v1('GET', '/environments/dev/flags/new_checkout')).json;
  const b = (await v1('GET', '/environments/dev/flags/dark_mode_v2')).json;
  const r = await v1('POST', '/environments/dev/publish', {
    reason: 'both on', items: [
      { flag: 'new_checkout', entity: null, version: a.layer.version, layer: { ...a.layer, enabled: true } },
      { flag: 'dark_mode_v2', entity: null, version: b.layer.version, layer: { ...b.layer, enabled: true } },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const stale = await v1('POST', '/environments/dev/publish', { items: [{ flag: 'new_checkout', entity: null, version: a.layer.version, layer: a.layer }] });
  assert.deepEqual([stale.status, stale.json.code], [409, 'conflict'], 'someone changed it since: read it again');
  const bad = await v1('POST', '/environments/dev/publish', { items: 'everything' });
  assert.deepEqual([bad.status, bad.json.code], [422, 'invalid']);
});

test('History, newest first, page by page', async () => {
  const page1 = await v1('GET', '/history?environment=dev&limit=2');
  assert.equal(page1.status, 200);
  assert.equal(page1.json.items.length, 2);
  assert.ok(page1.json.next);
  const page2 = await v1('GET', `/history?environment=dev&limit=2&cursor=${page1.json.next}`);
  assert.ok(page2.json.items[0].id < page1.json.items[1].id, 'older entries on the next page');
  const row = page1.json.items[0];
  assert.deepEqual(['actor', 'changeType', 'changedAt', 'changedBy', 'environment', 'id', 'request'].every((k) => k in row), true);
  assert.equal((await v1('GET', '/history?cursor=nonsense')).json.code, 'bad_request');
});

test('entities: put adds one (201) or changes it (200); a key taken in another dimension is a 409', async () => {
  const made = await v1('PUT', '/dimensions/company/entities/hooli', { name: 'Hooli' }, (await t.as('dana').post('/tokens', { name: 'crm' })).json.token);
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const dana = (await t.as('dana').post('/tokens', { name: 'crm 2' })).json.token;
  const renamed = await v1('PUT', '/dimensions/company/entities/hooli', { name: 'Hooli XYZ' }, dana);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  const list = await everything('/dimensions/company/entities', 4);
  assert.deepEqual(list.items.find((e) => e.key === 'hooli'), { key: 'hooli', name: 'Hooli XYZ', parent: null });
  const elsewhere = await v1('PUT', '/dimensions/brand/entities/hooli', { name: 'Hooli', parent: 'acme' }, dana);
  assert.deepEqual([elsewhere.status, elsewhere.json.code], [409, 'already_exists']);
  assert.equal((await v1('PUT', '/dimensions/company/entities/hooli', {}, dana)).json.code, 'invalid');
});

test('errors: { error, code }, a 404 for what doesn’t exist, a 400 for a bad page, a 401 for an unknown token', async () => {
  for (const path of ['/environments/nowhere/flags', '/environments/dev/flags/no_such_flag', '/dimensions/nowhere/entities']) {
    const r = await v1('GET', path);
    assert.deepEqual([r.status, r.json.code, typeof r.json.error], [404, 'not_found', 'string'], path);
  }
  for (const q of ['limit=0', 'limit=500', 'limit=x', 'cursor=%%%']) {
    assert.equal((await v1('GET', `/environments/dev/flags?${q}`)).json.code, 'bad_request', q);
  }
  assert.equal((await v1('GET', '/environments', undefined, 'cfp_madeup')).json.code, 'unauthorized');
  assert.equal((await v1('GET', '/nope')).json.code, 'not_found');
});
