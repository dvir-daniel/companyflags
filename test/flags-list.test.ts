// What the Flags list and the first-run checklist need from the server: /meta says when a key last read flags (the
// checklist's "Connect an app"), the list filters flags past their remove-by date, and the bulk switch goes through
// the one publish (web/src/pages/flagsKit.ts switchItems): one version where nothing is reviewed, one request where it is.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { switchItems } from '../web/src/pages/flagsKit.ts';
import type { FlagDetail } from '../web/src/api.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const detail = async (key: string) => (await t.as('alice').get(`/flags/${key}`)).json as FlagDetail;

test('/meta says when any key in use last read flags: never, then once an app reads with one', async () => {
  await t.db.query(`update api_key set last_used_at = null`);
  assert.equal((await t.as('alice').get('/meta')).json.keyLastUsedAt, null);
  const made = await t.as('dana').post('/api-keys', { environment: 'dev', service: 'web', scope: 'all' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal((await t.as('alice').get('/meta')).json.keyLastUsedAt, null, 'a key that was only made hasn’t read anything');
  const read = await t.call('POST', '/ofrep/v1/evaluate/flags', { context: { targetingKey: 'device-1' } }, { authorization: `Bearer ${made.json.key}` });
  assert.equal(read.status, 200);
  // the key's last use is written beside the answer, not before it: wait for it
  let at: string | null = null;
  for (let i = 0; i < 50 && !at; i++) { at = (await t.as('alice').get('/meta')).json.keyLastUsedAt; if (!at) await new Promise((r) => setTimeout(r, 20)); }
  assert.ok(at && Date.parse(at) > Date.now() - 60_000, `a recent time, got ${at}`);
  // a revoked key's reads don't count
  await t.as('dana').post(`/api-keys/${made.json.id}/revoke`);
  await t.db.query(`update api_key set last_used_at = null where revoked_at is null`);
  assert.equal((await t.as('alice').get('/meta')).json.keyLastUsedAt, null);
});

test('the flags list filters flags past their remove-by date, and sorts by it', async () => {
  await t.db.query(`update flag set remove_by = '2020-01-01' where key = 'dark_mode_v2'`);
  const late = (await t.as('alice').get('/flags?environment=dev&page=0&size=200&stale=overdue')).json;
  assert.deepEqual(late.rows.map((f: any) => f.key), ['dark_mode_v2']);
  assert.equal(late.matched, 1);
  assert.equal(late.rows[0].removeBy, '2020-01-01');
  const every = (await t.as('alice').get('/flags?environment=dev&page=0&size=200&stale=whatever')).json;
  assert.ok(every.matched > 1, 'an unknown value filters nothing');
  const byDate = (await t.as('alice').get('/flags?environment=dev&page=0&size=200&sort=removeBy')).json.rows.map((f: any) => f.removeBy).filter(Boolean);
  assert.deepEqual(byDate, [...byDate].sort());
  assert.equal(byDate[0], '2020-01-01');
});

test('the bulk switch is one version where nothing is reviewed, and one request where it is', async () => {
  const flags = ['new_checkout', 'dark_mode_v2'];
  // development: both at once, in one version
  const dev = await Promise.all(flags.map(detail));
  const before = (await t.as('alice').get('/meta')).json.environments.find((e: any) => e.key === 'dev').revision;
  const on = switchItems(dev, 'dev', !dev[0].layers.dev.base.enabled);
  const r = await t.as('alice').post('/environments/dev/publish', { items: on });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.revision, before + 1, 'one version for every flag');
  // now all of them are that way: nothing is left to send
  assert.deepEqual(switchItems(await Promise.all(flags.map(detail)), 'dev', !dev[0].layers.dev.base.enabled), []);
  // production (protected): one request covering both, nothing live yet
  await t.db.query(`update environment set min_approvals = 1 where key = 'prod'`);
  const prod = await Promise.all(flags.map(detail));
  const want = !prod[0].layers.prod.base.enabled;
  const items = switchItems(prod, 'prod', want);
  const asked = await t.as('alice').post('/environments/prod/publish', { items, reason: 'INC-1: checkout errors' });
  assert.equal(asked.status, 202, JSON.stringify(asked.json));
  const cs = (await t.as('alice').get(`/change-sets/${asked.json.changeSetId}`)).json;
  assert.deepEqual(cs.items.map((i: any) => i.flag).sort(), items.map((i) => i.flag).sort());
  assert.equal(!!(await detail(items[0].flag)).layers.prod.base.enabled, !want, 'nothing live before the review');
});
