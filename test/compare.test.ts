// The Compare page: two customers, two environments or two apps, flag by flag.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const compare = async (a: object, b: object, attrs: object = { 'app.version': '6.2.0', 'device.id': 'd-1' }) => {
  const r = await t.as('alice').post('/compare', { a, b, attrs });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as { total: number; different: number; rows: any[] };
};

test('two entities: their own settings show up as differences, with the reason named after the entity', async () => {
  const r = await compare({ environment: 'dev', project: 'android', entity: 'microsoft' }, { environment: 'dev', project: 'android', entity: 'google' });
  const api = r.rows.find((x) => x.key === 'api_base_url');
  assert.equal(api.same, false);
  assert.equal(api.a.value, 'https://android.microsoft.api.example.com');
  assert.equal(api.a.source, 'Microsoft’s rule');
  assert.equal(api.b.value, 'https://google.api.example.com');
  assert.equal(api.b.source, 'Google’s default');
  assert.equal(r.different, r.rows.filter((x) => !x.same).length);
  assert.ok(r.rows.some((x) => x.same));
});

test('two apps: a flag sent to only one app is a difference', async () => {
  const r = await compare({ environment: 'dev', project: 'android', entity: 'microsoft' }, { environment: 'dev', project: 'ios', entity: 'microsoft' });
  const quick = r.rows.find((x) => x.key === 'android_quick_share');
  assert.equal(quick.same, false);
  assert.equal(quick.a.sent, true);
  assert.equal(quick.b.sent, false);
  assert.match(quick.b.source, /Not in ios/);
});

test('two environments: a change in one environment only is the difference', async () => {
  const same = await compare({ environment: 'dev', project: 'web', entity: 'acme' }, { environment: 'prod', project: 'web', entity: 'acme' });
  assert.equal(same.different, 0);                         // seeded the same in both
  const s = await t.editBase('max_upload_mb', 'dev', (layer) => ({ ...layer, defaultVariation: 'huge' }));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const r = await compare({ environment: 'dev', project: 'web', entity: 'acme' }, { environment: 'prod', project: 'web', entity: 'acme' });
  assert.deepEqual(r.rows.filter((x) => !x.same).map((x) => x.key), ['max_upload_mb']);
  const row = r.rows.find((x) => x.key === 'max_upload_mb');
  assert.deepEqual([row.a.value, row.b.value], [5000, 100]);
  // put it back, so the environments are the same again for whatever runs next
  assert.equal((await t.editBase('max_upload_mb', 'dev', (layer) => ({ ...layer, defaultVariation: 'standard' }))).status, 200);
});

test('an unknown entity is a clear error', async () => {
  const r = await t.as('alice').post('/compare', { a: { environment: 'dev', project: 'web', entity: 'nope' }, b: { environment: 'dev', project: 'web', entity: null } });
  assert.equal(r.status, 404);
});
