// Editing a flag's details from the Settings tab.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { all } from '../server/db.ts';
import { flagSetupProblems } from '../server/layers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

test('description, owner and kind can be edited and are audited', async () => {
  const r = await t.as('alice').put('/flags/max_upload_mb/meta', { description: 'Upload limit in MB', owner: 'storage-team', kind: 'ops' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const f = (await t.as('alice').get('/flags/max_upload_mb')).json;
  assert.equal(f.description, 'Upload limit in MB');
  assert.equal(f.owner, 'storage-team');
  assert.equal(f.kind, 'ops');
  const h = (await t.as('alice').get('/history?flag=max_upload_mb')).json;
  assert.equal(h[0].changeType, 'flag.update');
});

test('release flags need a remove-by date', async () => {
  const r = await t.as('alice').put('/flags/new_checkout/meta', { removeBy: null });
  assert.equal(r.status, 422);
});

test('a kind the rules don’t fit is refused, naming each rule to fix, and the layers still save', async () => {
  // dark_mode_v2 is a release flag with a % of devices that falls back to session.id
  const toConfig = await t.as('alice').put('/flags/dark_mode_v2/meta', { kind: 'config' });
  assert.equal(toConfig.status, 422, JSON.stringify(toConfig.json));
  assert.ok(toConfig.json.errors.length > 0);
  assert.ok(toConfig.json.errors.every((e: string) => /· everyone · rule 2 “30% of devices”: only release flags may use a backup ID/.test(e)), toConfig.json.errors.join('\n'));

  const toPermission = await t.as('alice').put('/flags/dark_mode_v2/meta', { kind: 'permission' });
  assert.equal(toPermission.status, 422);
  assert.ok(toPermission.json.errors.some((e: string) => /permission flags can’t use % of devices/.test(e)));

  const f = (await t.as('alice').get('/flags/dark_mode_v2')).json;
  assert.equal(f.kind, 'release');
  const base = f.layers.dev.base;
  const resave = await t.as('alice').put('/flags/dark_mode_v2/layers/dev/base', { layer: base, expectedVersion: base.version });
  assert.equal(resave.status, 200, JSON.stringify(resave.json));
});

test('every stored layer passes the setup check for its flag’s kind', async () => {
  const flags = await all<{ id: string; key: string; kind: string }>(t.db, `select id, key, kind from flag where archived_at is null`);
  assert.ok(flags.length > 5);
  for (const f of flags) assert.deepEqual(await flagSetupProblems(t.db, f, f.kind), [], f.key);
});
