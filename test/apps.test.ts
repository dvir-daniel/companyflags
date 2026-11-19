// Settings → Apps: an admin changes an app's kind or deletes it, but only while nothing uses it (no flag sent to it,
// no API key for it that works, no request still to go out that would send it a flag), and its key never changes.
// Every change is in History. Production needs 1 approval in the test data (fixtures.ts).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const admin = () => t.as('dana');
const appsNow = async () => (await admin().get('/meta')).json.projects.map((p: any) => `${p.key}:${p.kind}`) as string[];
const history = async (kind: string) => ((await admin().get('/history')).json as any[]).filter((h) => h.changeType === kind);
const flag = (key: string, delivery: Record<string, string[]>) => ({
  key, valueType: 'bool', kind: 'ops', variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
  delivery, base: { enabled: true, defaultVariation: 'on', variationWhenOff: 'off', rules: [] },
});

test('only admins change or delete an app', async () => {
  assert.equal((await admin().post('/apps', { key: 'kiosk', kind: 'client' })).status, 201);
  const editor = t.as('alice');
  const put = await editor.put('/apps/kiosk', { kind: 'server' });
  assert.equal(put.status, 403);
  assert.equal((await editor.del('/apps/kiosk')).status, 403);
  assert.equal((await t.as('bob').del('/apps/kiosk')).status, 403, 'nor approvers');
  assert.ok((await appsNow()).includes('kiosk:client'), 'nothing changed');
});

test('an unused app changes kind; its key can’t change; both are in History', async () => {
  const r = await admin().put('/apps/kiosk', { kind: 'server' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { key: 'kiosk', kind: 'server' });
  assert.ok((await appsNow()).includes('kiosk:server'));
  const [h] = await history('app.update');
  assert.deepEqual([h.changedBy, h.before, h.after, h.environment], ['dana', { key: 'kiosk', kind: 'client' }, { key: 'kiosk', kind: 'server' }, null]);

  assert.equal((await admin().put('/apps/kiosk', { kind: 'server' })).status, 200, 'the same kind: nothing to do');
  assert.equal((await history('app.update')).length, 1, 'and nothing in History');
  const rename = await admin().put('/apps/kiosk', { key: 'kiosk-2', kind: 'server' });
  assert.equal(rename.status, 422);
  assert.match(rename.json.error, /key can’t change/);
  assert.equal((await admin().put('/apps/kiosk', { kind: 'fridge' })).status, 422);
  assert.equal((await admin().put('/apps/nope', { kind: 'client' })).status, 404);
  assert.equal((await admin().del('/apps/nope')).status, 404);
});

test('an app a flag is sent to can’t change kind or be deleted: the refusal says which flags and what to do', async () => {
  for (const r of [await admin().del('/apps/android'), await admin().put('/apps/android', { kind: 'server' })]) {
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error, /^android can’t (be deleted|change kind) while it’s in use$/);
    assert.match(r.json.errors[0], /flags are still sent to it: .*android_quick_share \(dev, prod\).*Take android out of Sent to on each one first/);
    assert.deepEqual(r.json.inUse.flags.find((f: any) => f.flag === 'android_quick_share'), { flag: 'android_quick_share', environments: ['dev', 'prod'] });
    assert.equal(r.json.inUse.apiKeys, 0);
  }
  assert.ok((await appsNow()).includes('android:client'), 'still there, still an app');
  assert.equal((await history('app.delete')).length, 0);
});

test('a backend with an API key that still works can’t go; once the key is revoked it can, and its keys go with it', async () => {
  assert.equal((await admin().post('/apps', { key: 'reports', kind: 'server' })).status, 201);
  assert.equal((await t.as('alice').post('/api-keys', { environment: 'dev', project: 'reports', scope: 'all' })).status, 403, 'only admins make keys');
  const key = await admin().post('/api-keys', { environment: 'dev', project: 'reports', scope: 'all', label: 'nightly' });
  assert.equal(key.status, 201, JSON.stringify(key.json));
  const download = () => t.call('GET', '/sdk/v1/flagd/company/acme', undefined, { authorization: `Bearer ${key.json.key}` });
  assert.equal((await download()).status, 200);

  for (const r of [await admin().del('/apps/reports'), await admin().put('/apps/reports', { kind: 'client' })]) {
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.deepEqual(r.json.errors, ['An API key for it still works: revoke it on the API keys page first.']);
  }
  assert.equal((await download()).status, 200, 'the key still works');

  assert.equal((await t.as('alice').post(`/api-keys/${key.json.id}/revoke`)).status, 403, 'or revoke them');
  assert.equal((await admin().post(`/api-keys/${key.json.id}/revoke`)).status, 200);
  const gone = await admin().del('/apps/reports');
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.ok(!(await appsNow()).some((a) => a.startsWith('reports:')));
  assert.equal((await t.db.query(`select 1 from api_key where id = $1`, [key.json.id])).rows.length, 0, 'its revoked key went with it');
  const [h] = await history('app.delete');
  assert.deepEqual([h.changedBy, h.before], ['dana', { key: 'reports', kind: 'server', revokedKeys: [key.json.prefix], archivedFlags: [] }], 'History keeps them');
  assert.equal((await download()).status, 401);
});

test('a request still to go out that would send a flag to the app keeps it; cancelled, the app can go', async () => {
  assert.equal((await admin().post('/apps', { key: 'tv', kind: 'client' })).status, 201);
  const asked = await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'prod', projects: ['android', 'tv'] });
  assert.equal(asked.status, 202, 'production needs approval: a request');
  const id = asked.json.changeSetId;

  const r = await admin().del('/apps/tv');
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.errors, [`A request waiting to go out would send a flag to it: #${id} in prod. Cancel or reject it in Approvals first.`]);
  assert.deepEqual(r.json.inUse.requests, [{ id, environment: 'prod' }]);

  assert.equal((await t.as('alice').post(`/change-sets/${id}/cancel`)).status, 200);
  assert.equal((await admin().del('/apps/tv')).status, 200);
});

test('a deleted app’s file stops being served at once, and so does an app made a backend', async () => {
  for (const key of ['lobby', 'signage']) assert.equal((await admin().post('/apps', { key, kind: 'client' })).status, 201);
  await t.settle();
  for (const key of ['lobby', 'signage']) {
    const file = await t.appFile('dev', key, null);
    assert.equal(file.status, 200);
    assert.deepEqual(file.json.flags, {}, 'nothing is sent to it');
  }
  assert.equal((await admin().del('/apps/lobby')).status, 200);
  assert.equal((await admin().put('/apps/signage', { kind: 'server' })).status, 200);
  assert.equal((await t.appFile('dev', 'lobby', null)).status, 404);
  assert.equal((await t.appFile('dev', 'signage', null)).status, 404);
  assert.equal((await t.appFile('dev', 'signage', 'acme')).status, 404, 'nor at an entity’s link');
});

test('archived flags don’t keep an app: it leaves their Sent to, which History keeps', async () => {
  assert.equal((await admin().post('/apps', { key: 'watch', kind: 'client' })).status, 201);
  assert.equal((await t.as('alice').post('/flags', flag('watch_faces', { dev: ['watch'] }))).status, 201);
  const kept = await admin().del('/apps/watch');
  assert.equal(kept.status, 409);
  assert.match(kept.json.errors[0], /^A flag is still sent to it: watch_faces \(dev\)\. Take watch out of Sent to on that flag first\.$/);

  assert.equal((await t.as('alice').post('/flags/watch_faces/archive')).status, 200);
  assert.equal((await admin().del('/apps/watch')).status, 200);
  const h = (await history('app.delete')).find((x) => x.before.key === 'watch');
  assert.deepEqual(h.before.archivedFlags, ['watch_faces']);
  assert.equal((await admin().post('/apps', { key: 'watch', kind: 'client' })).status, 201, 'the key is free again');
});
