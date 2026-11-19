// Lists are searched and paged on the server, so the console downloads one page, not everything.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

test('flags list: pages, total and search run on the server', async () => {
  const all = (await t.as('alice').get('/flags?environment=dev&page=0&size=200')).json.rows;   // every flag: one page of 200
  assert.ok(all.length > 8);
  assert.deepEqual((await t.as('alice').get('/flags?environment=dev')).json.rows.map((f: any) => f.key), all.map((f: any) => f.key).slice(0, 50),
    'no ?page: the first page');
  const p0 = (await t.as('alice').get('/flags?environment=dev&page=0&size=4')).json;
  assert.equal(p0.matched, all.length);
  assert.equal(p0.all, all.length);
  assert.equal(p0.rows.length, 4);
  assert.deepEqual(p0.rows.map((f: any) => f.key), all.map((f: any) => f.key).slice(0, 4));
  const p1 = (await t.as('alice').get('/flags?environment=dev&page=1&size=4')).json;
  assert.deepEqual(p1.rows.map((f: any) => f.key), all.map((f: any) => f.key).slice(4, 8));
  const api = p0.rows.concat(p1.rows).find((f: any) => f.key === 'api_base_url');
  assert.ok(api.envs.dev.entityLayers >= 2 && api.delivery.dev.length > 0 && api.envs.prod);   // every environment's state (a column each)
  const s = (await t.as('alice').get('/flags?environment=prod&page=0&q=REGION')).json;                  // case-insensitive, key or description
  assert.deepEqual(s.rows.map((f: any) => f.key), ['data_region_host']);
  assert.equal(s.matched, 1);
  assert.equal(s.all, all.length);                                                   // the count before searching
  const none = (await t.as('alice').get('/flags?environment=dev&page=0&q=r%25e')).json;                // "%" is a literal character, not a wildcard
  assert.equal(none.matched, 0);
});

test('flags list: filters and sorting run on the server', async () => {
  const base = (await t.as('alice').get('/flags?environment=dev&page=0&size=200')).json;
  assert.ok(Array.isArray(base.owners) && base.owners.length > 0);                       // for the Owner filter
  assert.ok(base.rows.every((f: any) => 'changedAt' in f));                              // when its settings last changed here
  const on = (await t.as('alice').get('/flags?environment=dev&page=0&size=200&status=on')).json;
  const off = (await t.as('alice').get('/flags?environment=dev&page=0&size=200&status=off')).json;
  assert.equal(on.matched + off.matched, base.matched);
  assert.ok(on.rows.every((f: any) => f.envs.dev?.enabled === true));
  assert.ok(off.rows.every((f: any) => f.envs.dev?.enabled !== true));
  const owner = base.owners[0];
  const mine = (await t.as('alice').get(`/flags?environment=dev&page=0&size=200&owner=${encodeURIComponent(owner)}`)).json;
  assert.ok(mine.matched > 0 && mine.rows.every((f: any) => f.owner === owner));
  const kind = base.rows[0].kind;
  const ofKind = (await t.as('alice').get(`/flags?environment=dev&page=0&size=200&kind=${kind}`)).json;
  assert.ok(ofKind.matched > 0 && ofKind.rows.every((f: any) => f.kind === kind));
  const desc = (await t.as('alice').get('/flags?environment=dev&page=0&size=200&sort=key&dir=desc')).json;
  assert.deepEqual(desc.rows.map((f: any) => f.key), [...base.rows.map((f: any) => f.key)].reverse());
  const changed = (await t.as('alice').get('/flags?environment=dev&page=0&size=200&sort=changed&dir=desc')).json;
  const times = changed.rows.map((f: any) => f.changedAt).filter(Boolean).map((x: string) => new Date(x).getTime());
  assert.equal(times.length, changed.rows.length, 'every flag has defaults, so a last change');
  assert.ok(times.length > 1);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));                             // newest change first
  const junk = (await t.as('alice').get('/flags?environment=dev&page=0&size=5&sort=drop table&dir=sideways')).json;
  assert.equal(junk.rows.length, 5);                                                     // unknown sort falls back to the key, A to Z
  assert.deepEqual(junk.rows.map((f: any) => f.key), base.rows.map((f: any) => f.key).slice(0, 5));
});

test('customers list: paged and searched on the server', async () => {
  const r = (await t.as('alice').get('/dimensions/company?page=0&size=3&q=o')).json;
  assert.equal(r.rows.length, 3);
  assert.ok(r.all > r.matched && r.matched > 3, JSON.stringify([r.all, r.matched]));
  assert.ok(r.rows.every((c: any) => c.name.toLowerCase().includes('o') || c.key.includes('o')));
  const names = r.rows.map((c: any) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'by name, A to Z');
  const next = (await t.as('alice').get('/dimensions/company?page=1&size=3&q=o')).json.rows.map((c: any) => c.name);
  assert.ok(next.length > 0 && next[0].localeCompare(names.at(-1)) > 0, 'the next page carries on where this one stopped');
  assert.deepEqual((await t.as('alice').get('/dimensions/company?page=0&q=netflix')).json.rows.map((c: any) => c.key), ['netflix']);
});

test('entity page: one page, with counts for the whole list', async () => {
  const r = (await t.as('alice').get('/dimensions/company/netflix/flags?environment=dev&page=0&size=2')).json;
  assert.equal(r.rows.length, 2);
  assert.ok(r.matched === r.all && r.all > 2);
  const own = (await t.as('alice').get('/dimensions/company/netflix/flags?environment=dev&page=0&own=1')).json;
  assert.equal(own.matched, r.withOwn);
  assert.ok(own.rows.every((f: any) => f.hasOwn));
  const q = (await t.as('alice').get('/dimensions/company/netflix/flags?environment=dev&page=0&q=backend')).json;
  assert.deepEqual(q.rows.map((f: any) => f.key), ['ds_backend_config']);
});

test('compare: counts cover every flag, rows are one filtered page', async () => {
  const body = { a: { environment: 'dev', project: 'android', entity: 'microsoft' }, b: { environment: 'dev', project: 'android', entity: 'google' }, attrs: { 'app.version': '6.2.0' } };
  const full = (await t.as('alice').post('/compare', body)).json;
  const paged = (await t.as('alice').post('/compare', { ...body, onlyDiff: true, page: 0, size: 1 })).json;
  assert.equal(paged.all, full.all);                       // same meaning as every other list: all = before filters
  assert.equal(paged.different, full.different);
  assert.equal(paged.matched, full.different);
  assert.equal(paged.rows.length, 1);
  assert.equal(paged.rows[0].same, false);
  const q = (await t.as('alice').post('/compare', { ...body, q: 'api_base', page: 0 })).json;
  assert.deepEqual(q.rows.map((r: any) => r.key), ['api_base_url']);
});
