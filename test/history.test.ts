// History stays findable at any age (server/history.ts): filters by person, kind of change and time, pages that go
// back through all of it with `before`, and exports with no limit as CSV or JSON. The versions list and the flags
// list's "last version" read only what they show, however long the history.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { csvCell, historyCsv } from '../server/history.ts';

let t: Awaited<ReturnType<typeof boot>>;
let devId = 0;
const OLD = 1500;                                  // more than one page of the largest size (1000), to cross pages

before(async () => {
  t = await boot();
  devId = (await t.db.query<{ id: number }>(`select id from environment where key = 'dev'`)).rows[0].id;
  // a long history from long ago: notes by two people in 2024, one a day, oldest first
  await t.db.query(`insert into change_history (environment_id, changed_at, changed_by, actor_type, change_type, flag, comment)
    select $1, timestamptz '2024-01-01T12:00:00Z' + (g - 1) * interval '1 day', case when g % 3 = 0 then 'olga@example.com' else 'pat@example.com' end,
      'user', 'note.added', 'new_checkout', 'note ' || g
    from generate_series(1, $2) g`, [devId, OLD]);
});
after(async () => { await t.stop(); });

const get = (path: string, who = 'alice') => t.as(who).get(path);
const all = async () => (await t.db.query<{ id: number }>(`select id from change_history order by id desc`)).rows.map((r) => Number(r.id));

test('pages go back through all of history with `before`: in order, nothing missed, nothing twice', async () => {
  const everything = await all();
  const seen: number[] = [];
  let cursor = '';
  for (let pages = 0; pages < 20; pages++) {
    const r = await get(`/history?limit=1000${cursor}`);
    assert.equal(r.status, 200);
    seen.push(...r.json.map((h: any) => Number(h.id)));
    if (r.json.length < 1000) break;
    cursor = `&before=${r.json.at(-1).id}`;
  }
  assert.deepEqual(seen, everything, 'every entry, newest first');
  assert.equal((await get('/history')).json.length, 200, 'a page is 200 unless asked otherwise');
  assert.equal((await get('/history?limit=5000')).json.length, 1000, 'never more than 1000');
  const older = (await get(`/history?before=${everything[10]}&limit=3`)).json.map((h: any) => Number(h.id));
  assert.deepEqual(older, everything.slice(11, 14), 'the entries just older than the one given');
});

test('filters: who, kind of change, time, and all of them with the others', async () => {
  const olga = (await get('/history?by=olga@example.com&limit=1000')).json;
  assert.equal(olga.length, OLD / 3);
  assert.ok(olga.every((h: any) => h.changedBy === 'olga@example.com'));

  const notes = (await get('/history?type=note&limit=1000')).json;
  assert.equal(notes.length, 1000, 'a subject: every kind of change about it');
  assert.ok(notes.every((h: any) => h.changeType === 'note.added'));
  assert.equal((await get('/history?type=note.added&before=1&limit=10')).json.length, 0);
  const creates = (await get('/history?type=flag.create,layer')).json;
  assert.ok(creates.length > 0 && creates.every((h: any) => h.changeType === 'flag.create' || h.changeType.startsWith('layer.')), 'several at once');

  const january = (await get('/history?from=2024-01-01&to=2024-02-01&limit=1000')).json;
  assert.equal(january.length, 31, 'from is included, to is not');
  assert.equal(new Date(january[0].changedAt).toISOString(), '2024-01-31T12:00:00.000Z');
  assert.equal(new Date(january.at(-1).changedAt).toISOString(), '2024-01-01T12:00:00.000Z');

  const both = (await get('/history?by=olga@example.com&from=2024-01-01&to=2024-02-01&environment=dev&flag=new_checkout&type=note')).json;
  assert.deepEqual(both.map((h: any) => h.comment), ['note 30', 'note 27', 'note 24', 'note 21', 'note 18', 'note 15', 'note 12', 'note 9', 'note 6', 'note 3']);
  assert.equal((await get('/history?environment=prod&type=note')).json.length, 0, 'another environment');
  const search = (await get('/history?q=CHECK&limit=1000')).json;
  assert.ok(search.length === 1000 && search.every((h: any) => h.flag.includes('check')), 'part of a flag key, any case');
  assert.equal((await get('/history?q=%25&limit=5')).json.length, 0, 'a % in the search is the character, not a wildcard');

  for (const bad of ['before=abc', 'revision=1.5', 'limit=-3', 'from=yesterday', 'to=2024-13-45', 'type=DROP TABLE', 'from=2024-02-01&to=2024-01-01']) {
    assert.equal((await get(`/history?${bad}`)).status, 422, bad);
  }
});

test('export: every matching entry, no limit, as CSV or JSON, safe to open in a spreadsheet', async () => {
  const csvRes = await t.call('GET', '/api/history/export?flag=new_checkout&type=note', undefined, { 'x-user': 'alice' });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type')!, /^text\/csv/);
  assert.match(csvRes.headers.get('content-disposition')!, /^attachment; filename="history-new_checkout-\d{4}-\d{2}-\d{2}\.csv"$/);
  const lines = (csvRes.json as string).replace(/\r\n$/, '').split('\r\n');
  assert.equal(lines[0], 'id,when,environment,version,who,actor,change,flag,entity,comment,request,before,after');
  const raw = new Uint8Array(await (await t.app.request('/api/history/export?type=nothing.here', { headers: { 'x-user': 'alice' } })).arrayBuffer());
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], 'a UTF-8 byte-order mark first, so spreadsheets read names right');
  assert.equal(lines.length - 1, OLD, 'past the 1000 a page can hold');
  assert.match(lines[1], /^\d+,2028-02-08T12:00:00\.000Z,dev,,olga@example\.com,user,note\.added,new_checkout,,note 1500,,,$/);

  const jsonRes = await t.call('GET', '/api/history/export?format=json&by=olga@example.com', undefined, { 'x-user': 'vic' });
  assert.equal(jsonRes.status, 200, 'a viewer can export what they can see');
  assert.match(jsonRes.headers.get('content-type')!, /^application\/json/);
  const rows = jsonRes.json as any[];
  assert.equal(rows.length, OLD / 3);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['actorType', 'after', 'before', 'changeSetId', 'changeType', 'changedAt', 'changedBy', 'comment', 'entity', 'environment', 'flag', 'id', 'revision']);

  assert.equal((await t.call('GET', '/api/history/export?from=nope', undefined, { 'x-user': 'alice' })).status, 422, 'checked before anything is sent');
  assert.equal((await t.call('GET', '/api/history/export')).status, 401, 'signed in only');
  assert.equal((await t.call('GET', '/api/history/export?type=nothing.here', undefined, { 'x-user': 'alice' })).json, 'id,when,environment,version,who,actor,change,flag,entity,comment,request,before,after\r\n');
  assert.deepEqual((await t.call('GET', '/api/history/export?format=json&type=nothing.here', undefined, { 'x-user': 'alice' })).json, []);
});

test('CSV cells: quotes, commas and line breaks are kept; text a spreadsheet would run stays text', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a, "b"\nc'), '"a, ""b""\nc"');
  for (const formula of ['=HYPERLINK("x")', '+1', '-1', '@SUM(A1)']) assert.ok(csvCell(formula).replace(/^"/, '').startsWith(`'${formula[0]}`), formula);
  assert.equal(csvCell(null), '');
  const line = historyCsv({ id: 7, environment: 'prod', revision: 3, changedAt: '2026-11-18T10:00:00Z', changedBy: 'a@b.c', actorType: 'user',
    changeType: 'layer.update', flag: 'f', entity: null, before: { enabled: false }, after: { enabled: true }, comment: '=1+1', changeSetId: null });
  assert.equal(line, `7,2026-11-18T10:00:00.000Z,prod,3,a@b.c,user,layer.update,f,,'=1+1,,"{""enabled"":false}","{""enabled"":true}"`);
});

test('the versions list counts from the environment and pages without gaps; flags show their last version here', async () => {
  for (let i = 0; i < 7; i++) {
    const b = (await get('/flags/new_checkout')).json.layers.dev.base;
    const { version, updatedAt: _u, updatedBy: _b, ...layer } = b;
    const r = await t.as('alice').post('/environments/dev/publish', { items: [{ flag: 'new_checkout', entity: null, expectedVersion: version, layer: { ...layer, enabled: !b.enabled } }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const revision = Number((await t.db.query<{ revision: number }>(`select revision from environment where id = $1`, [devId])).rows[0].revision);
  const distinct = Number((await t.db.query<{ n: number }>(`select count(distinct revision)::int as n from change_history where environment_id = $1 and revision is not null`, [devId])).rows[0].n);
  assert.equal(distinct, revision, 'every version has history: the counter is the count');
  const p0 = (await get('/environments/dev/versions?page=0&size=4')).json;
  const p1 = (await get('/environments/dev/versions?page=1&size=4')).json;
  assert.equal(p0.matched, revision);
  assert.deepEqual([...p0.rows, ...p1.rows].map((r: any) => r.revision), [0, 1, 2, 3, 4, 5, 6, 7].map((i) => revision - i));
  assert.ok(p0.rows.every((r: any) => r.changes >= 1 && r.by.length >= 1));

  const flags = (await get('/flags?page=0&environment=dev')).json.rows;
  assert.equal(flags.find((f: any) => f.key === 'new_checkout').lastVersion, revision, 'the newest version that changed it here');
});
