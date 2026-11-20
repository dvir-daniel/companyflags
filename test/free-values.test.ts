// Free values (docs/design/release-versions.md): a flag picks its values from named variants (the default), or takes any
// value typed into its rules and default, each stored as a hidden, content-addressed variant, like a value typed in for
// one customer. An on/off flag always uses variants; a version release always takes free values.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenKey as k } from '../server/evaluator.ts';
import { buildFlagdDoc } from '../server/flagd.ts';
import { boot, cdnAnswer } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const US = 'https://api.example.com';
const EU = 'https://eu.api.example.com';
const newFlag = (body: Record<string, unknown>) => t.as('alice').post('/flags', {
  key: 'api_host', name: 'API host', tags: [], owner: 'platform-team', description: '', kind: 'config', valueType: 'string', freeValues: true,
  variations: [{ key: k(US), value: US }], delivery: { dev: ['web'], prod: ['web'] }, base: { enabled: true, defaultVariation: k(US), rules: [] }, ...body,
});
const history = async (flag: string) => (await t.as('alice').get(`/history?flag=${flag}&environment=dev`)).json as any[];

test('a flag with free values takes typed values only; a new one writes no history, the rule that serves it does', async () => {
  assert.equal((await newFlag({ variations: [{ key: 'us', value: US }], base: { enabled: true, defaultVariation: 'us', rules: [] } })).status, 422, 'no named variants');
  const r = await newFlag({});
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await t.settle();
  const f = (await t.as('alice').get('/flags/api_host')).json;
  assert.deepEqual([f.freeValues, f.variations], [true, [{ key: k(US), value: US }]]);
  assert.equal((await t.as('alice').get('/flags?environment=dev&page=0&q=api_host')).json.rows[0].freeValues, true);

  const named = await t.as('alice').put('/flags/api_host/variations', { variations: [{ key: 'eu', value: EU }] });
  assert.equal(named.status, 422);
  assert.match(named.json.error, /takes free values/);
  const was = (await history('api_host')).length;
  assert.equal((await t.as('alice').put('/flags/api_host/variations', { variations: [{ key: k(EU), value: EU }] })).status, 200);
  await t.settle();
  assert.equal((await history('api_host')).length, was, 'a typed value nobody gets yet is no change');

  const rule = { ruleKey: crypto.randomUUID(), name: 'EU customers', locked: false, disabled: false,
    conditions: [{ field: 'entity', op: 'in', values: ['acme'] }], serveVariation: k(EU), split: null };
  assert.equal((await t.editBase('api_host', 'dev', (l) => ({ ...l, rules: [rule] }))).status, 200);
  assert.equal((await history('api_host')).length, was + 1, 'the rule that serves it is the change');
  assert.equal((await t.trace({ service: 'web', entity: 'acme', flag: 'api_host' })).value, EU);
  assert.equal((await t.trace({ service: 'web', entity: 'globex', flag: 'api_host' })).value, US);
  const file = (await t.cdnFile('dev', 'web', 'acme')).json;
  assert.equal(cdnAnswer(file, 'api_host').value, EU, 'the CDN file has the value, as for any flag');
});

test('variants are on by default; an on/off flag always uses them; the setting can be turned off and on again', async () => {
  const bool = await newFlag({ key: 'free_bool', valueType: 'bool', variations: [{ key: k(true), value: true }], base: { enabled: true, defaultVariation: k(true), rules: [] } });
  assert.equal(bool.status, 422);
  assert.match(bool.json.error, /always uses variants/);
  assert.equal((await t.as('alice').put('/flags/dark_mode_v2/meta', { freeValues: true })).status, 422);
  assert.equal((await t.as('alice').get('/flags/max_upload_mb')).json.freeValues, false, 'variants by default');

  // a flag with variants turns them off: what it serves stays; new values are typed in
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/meta', { freeValues: true })).status, 200);
  await t.settle();
  const off = (await t.as('alice').get('/flags/max_upload_mb')).json;
  assert.equal(off.freeValues, true);
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'giant', value: 4096 }] })).status, 422);
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: k(4096), value: 4096 }] })).status, 200);
  const h = (await history('max_upload_mb')).find((e) => e.changeType === 'flag.update');
  assert.deepEqual([h.before.free_values, h.after.free_values], [false, true], 'the setting is in the history');
  // and back on: named variants again
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/meta', { freeValues: false })).status, 200);
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [...off.variations, { key: 'giant', value: 4096 }] })).status, 200);
});

test('flagd: a flag with free values that serves nothing gets a placeholder, never a typed value', async () => {
  // prod needs review, so the new flag starts off there: it serves nothing
  const snap = t.plane.get('prod');
  const doc = buildFlagdDoc(snap, 'web', snap.entities.globex);
  assert.deepEqual(doc.flags.api_host, { state: 'DISABLED', variants: { unused: '' }, defaultVariant: null });
});
