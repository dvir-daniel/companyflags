// Drafts and versions (Wonka style): a draft that spans flags is published as one version, every version is
// listed with what it changed, and any earlier version can be restored. Restore undoes flag settings only
// (docs/design/adr/0001-restore-undoes-flag-settings-only.md).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const base = async (flag: string, env: string) => (await t.as('alice').get(`/flags/${flag}`)).json.layers[env].base;
/** A publish item that switches a flag's defaults on or off. */
const flip = async (flag: string, env: string, enabled: boolean) => {
  const { version, updatedAt: _u, updatedBy: _b, ...layer } = await base(flag, env);
  return { flag, entity: null, expectedVersion: version, layer: { ...layer, enabled } };
};

test('a draft that spans flags goes live as one version, listed with what it changed', async () => {
  const items = [await flip('new_checkout', 'dev', false), await flip('dark_mode_v2', 'dev', false)];
  const r = await t.as('alice').post('/environments/dev/publish', { items, reason: 'two at once' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.applied, true);
  assert.equal((await base('new_checkout', 'dev')).enabled, false);
  assert.equal((await base('dark_mode_v2', 'dev')).enabled, false);

  const v = (await t.as('alice').get('/environments/dev/versions?page=0&size=10')).json;
  assert.equal(v.current, r.json.revision);
  assert.equal(v.rows[0].revision, r.json.revision);                         // newest first
  assert.deepEqual([...v.rows[0].flags].sort(), ['dark_mode_v2', 'new_checkout']);
  assert.equal(v.rows[0].changes, 2);
  assert.ok(v.matched >= 1);

  const one = (await t.as('alice').get(`/history?environment=dev&revision=${r.json.revision}`)).json;
  assert.equal(one.length, 2);                                               // one version's changes, with before and after
  assert.ok(one.every((h: any) => h.before && h.after));

  // a draft made against the old settings is refused, not applied over the newer ones
  const stale = await t.as('alice').post('/environments/dev/publish', { items: [{ ...items[0], layer: { ...items[0].layer, enabled: true } }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'conflict');
});

test('rolling back to a version puts every later flag setting back, as a new version', async () => {
  // both flags on, then a version that switches them off, to roll back from
  const on = await t.as('alice').post('/environments/dev/publish', { items: [await flip('new_checkout', 'dev', true), await flip('dark_mode_v2', 'dev', true)] });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  const off = await t.as('alice').post('/environments/dev/publish', { items: [await flip('new_checkout', 'dev', false), await flip('dark_mode_v2', 'dev', false)] });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  const before = off.json.revision;
  assert.equal(before, on.json.revision + 1);
  const preview = await t.as('alice').get(`/environments/dev/versions/${before - 1}/restore-preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(preview.json, { versions: 1, flags: ['dark_mode_v2', 'new_checkout'], notRolledBack: [] }, 'what the rollback would undo, and leave');
  const r = await t.as('alice').post(`/environments/dev/versions/${before - 1}/restore`, { reason: 'checkout broke' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.restored, 2);
  assert.equal((await base('new_checkout', 'dev')).enabled, true);
  assert.equal((await base('dark_mode_v2', 'dev')).enabled, true);
  const v = (await t.as('alice').get('/environments/dev/versions?page=0&size=1')).json.rows[0];
  assert.equal(v.revision, r.json.revision);
  assert.match(v.comment, /^Roll back to version \d+: checkout broke/);

  // nothing left to undo, a version that isn't earlier, and production asks for review instead of applying
  assert.equal((await t.as('alice').post(`/environments/dev/versions/${before - 1}/restore`, {})).status, 422);
  assert.equal((await t.as('alice').post(`/environments/dev/versions/${r.json.revision}/restore`, {})).status, 422);
});

test('the rollback preview counts every later version, not one page of them', async () => {
  const start = (await t.as('alice').get('/environments/dev/versions?page=0&size=1')).json.current;
  for (let i = 0; i < 55; i++) {                                              // more than a page of 50
    assert.equal((await t.as('alice').put('/dimensions/company/acme', { name: `Acme ${i}` })).status, 200);
  }
  const p = await t.as('viewer-vic').get(`/environments/dev/versions/${start}/restore-preview`);
  assert.equal(p.status, 200, 'viewers may look');
  assert.equal(p.json.versions, 55);
  assert.deepEqual(p.json.flags, [], 'entity renames change no flag setting');
  assert.equal(p.json.notRolledBack.length, 55, 'and a restore leaves them as they are (journal.ts KINDS)');
  assert.match(p.json.notRolledBack[0].text, /^Acme .* renamed Acme 0$/);
  assert.equal((await t.as('alice').get(`/environments/dev/versions/${start + 55}/restore-preview`)).status, 422, 'the current version isn’t earlier');
  assert.equal((await t.as('alice').get('/environments/nope/versions/1/restore-preview')).status, 404);
});

test('in a protected environment the draft becomes one request covering every flag', async () => {
  const items = [await flip('new_checkout', 'prod', false), await flip('dark_mode_v2', 'prod', false)];
  assert.equal((await t.as('alice').post('/environments/prod/publish', { items })).status, 422);          // a reason for the reviewer
  const r = await t.as('alice').post('/environments/prod/publish', { items, reason: 'retire both' });
  assert.equal(r.status, 202);
  const cs = (await t.as('alice').get(`/change-sets/${r.json.changeSetId}`)).json;
  assert.deepEqual(cs.items.map((i: any) => i.flag).sort(), ['dark_mode_v2', 'new_checkout']);
  assert.equal((await base('new_checkout', 'prod')).enabled, true);                                       // nothing live yet
});

test('the list shows every environment, rule counts and the last version; conditions are catalogued', async () => {
  const p = (await t.as('alice').get('/flags?environment=dev&page=0&size=200')).json;
  const nc = p.rows.find((f: any) => f.key === 'new_checkout');
  assert.ok(nc.envs.dev && nc.envs.prod);
  assert.equal(typeof nc.envs.dev.rules, 'number');
  assert.ok(nc.lastVersion > 0);
  const conds = (await t.as('alice').get('/environments/dev/conditions')).json;
  assert.ok(conds.length > 0);
  assert.ok(conds.every((c: any) => c.condition && c.flags > 0 && Array.isArray(c.examples)));
});

test('restore undoes flag settings only: a brand moved out of its company stays moved, and the answer says so', async () => {
  const dana = t.as('dana');
  assert.equal((await dana.post('/dimensions/company', { key: 'tyrell', name: 'Tyrell' })).status, 201);
  assert.equal((await dana.post('/dimensions/brand', { key: 'velvet', name: 'Velvet', parent: 'tyrell' })).status, 201);
  const at = (await t.as('alice').get('/environments/dev/versions?page=0&size=1')).json.rows[0].revision;
  assert.equal((await dana.put('/dimensions/brand/velvet', { name: 'Velvet', parent: null })).json.parent, null);

  const v = (await t.as('alice').get('/environments/dev/versions?page=0&size=1')).json;
  assert.equal(v.rows[0].notRolledBack, 1, 'the versions list marks the move as a change restore doesn’t undo');
  assert.deepEqual([...v.restorable].sort(), ['layer.create', 'layer.delete', 'layer.update']);

  // the move is all that changed: a clear 422 that says so, not a bare "nothing to roll back"
  const only = await t.as('alice').post(`/environments/dev/versions/${at}/restore`, {});
  assert.equal(only.status, 422);
  assert.match(only.json.error, /restore undoes flag settings only/);
  assert.match(only.json.error, /Not rolled back: Velvet moved out of Tyrell/);
  assert.deepEqual(only.json.notRolledBack.map((n: any) => [n.kind, n.entity, n.text]), [['entity.update', 'velvet', 'Velvet moved out of Tyrell']]);

  // with a flag setting changed as well, the setting goes back and the move is listed as not rolled back
  assert.equal((await t.as('alice').post('/environments/dev/publish', { items: [await flip('new_checkout', 'dev', false)] })).status, 200);
  const r = await t.as('alice').post(`/environments/dev/versions/${at}/restore`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.restored, 1);
  assert.deepEqual(r.json.notRolledBack.map((n: any) => n.text), ['Velvet moved out of Tyrell']);
  assert.equal((await base('new_checkout', 'dev')).enabled, true);
  const velvet = (await t.as('alice').get('/meta')).json.entities.find((c: any) => c.key === 'velvet');
  assert.equal(velvet.parent, null, 'Velvet is still out of Tyrell');
});
