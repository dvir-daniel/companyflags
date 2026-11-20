// Save flow, approvals, schema invariants, the outbox, and what apps and backends read (files and snapshots).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, cdnAnswer } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

describe('save flow', () => {
  test('If-Match: a stale version gets 409', async () => {
    const base = (await t.as('alice').get('/flags/max_upload_mb')).json.layers.dev.base;
    const ok = await t.as('alice').put('/flags/max_upload_mb/layers/dev/base', { layer: base }, { 'if-match': `"${base.version}"` });
    assert.equal(ok.status, 200);
    const stale = await t.as('bob').put('/flags/max_upload_mb/layers/dev/base', { layer: base }, { 'if-match': `"${base.version}"` });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'conflict');
    assert.equal(stale.json.currentVersion, base.version + 1);
  });

  test('rule keys survive saves, so traces and diffs stay stable', async () => {
    const before_ = (await t.as('alice').get('/flags/dark_mode_v2')).json.layers.dev.base;
    before_.rules[0].name = 'Beta customers (renamed)';
    const saved = await t.as('alice').put('/flags/dark_mode_v2/layers/dev/base', { layer: before_, expectedVersion: before_.version });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const after_ = (await t.as('alice').get('/flags/dark_mode_v2')).json.layers.dev.base;
    assert.equal(after_.rules[0].name, 'Beta customers (renamed)');
    assert.deepEqual(after_.rules.map((r: any) => r.ruleKey), before_.rules.map((r: any) => r.ruleKey));
  });

  test('layer invariants are enforced', async () => {
    const put = (body: unknown) => t.as('alice').put('/flags/new_checkout/layers/dev/acme', body);
    const locked = await put({ layer: { inherit: 'base_rules_then_base_default', rules: [{ locked: true, conditions: [], serveVariation: 'on' }] }, expectedVersion: null });
    assert.equal(locked.status, 422);
    assert.match(locked.json.errors.join(), /overrides are only for everyone/);
    const badDefault = await put({ layer: { inherit: 'customer_only', rules: [] }, expectedVersion: null });
    assert.equal(badDefault.status, 422);
    const badVar = await put({ layer: { inherit: 'base_rules_then_base_default', rules: [{ conditions: [], serveVariation: 'nope' }] }, expectedVersion: null });
    assert.equal(badVar.status, 422);
    const badOp = await put({ layer: { inherit: 'base_rules_then_base_default', rules: [{ conditions: [{ field: 'app.version', op: 'in', values: ['5'] }], serveVariation: 'on' }] }, expectedVersion: null });
    assert.equal(badOp.status, 422);
    const fallbackOnConfig = await t.as('alice').put('/flags/api_base_url/layers/dev/acme', { layer: { inherit: 'base_rules_then_base_default',
      rules: [{ conditions: [], split: { by: 'device.id', fallbackBy: 'session.id', ranges: [{ variation: 'wonka', from: 0, to: 100 }] } }] }, expectedVersion: null });
    assert.equal(fallbackOnConfig.status, 422);
    assert.match(fallbackOnConfig.json.errors.join(), /sticky/);
  });

  test('the database rejects what the API might miss', async () => {
    await assert.rejects(t.db.query(`update flag_rule set locked = true where layer_is_base = false`), /violates check constraint/);
    await assert.rejects(t.db.query(`update change_history set comment = 'tampered'`), /append-only/);
    await assert.rejects(t.db.query(`delete from change_history`), /append-only/);
    await assert.rejects(t.db.query(`delete from flag where key = 'max_upload_mb'`), /foreign key/);
  });
});

describe('approvals', () => {
  test('prod change → review → apply; authors cannot self-approve', async () => {
    const base = (await t.as('alice').get('/flags/max_upload_mb')).json.layers.prod.base;
    base.defaultVariation = 'enterprise';
    const r = await t.as('alice').put('/flags/max_upload_mb/layers/prod/base', { layer: base, expectedVersion: base.version, reason: 'raise limit' });
    assert.equal(r.status, 202);
    const id = r.json.changeSetId;
    assert.equal((await t.as('alice').post(`/change-sets/${id}/review`, { decision: 'approve' })).status, 403);
    assert.equal((await t.as('alice').post(`/change-sets/${id}/apply`)).status, 409);   // not approved yet
    const rev = await t.as('bob').post(`/change-sets/${id}/review`, { decision: 'approve' });
    assert.equal(rev.json.status, 'approved');
    const applied = await t.as('alice').post(`/change-sets/${id}/apply`);
    assert.equal(applied.status, 200);
    await t.settle();
    const v = await t.trace({ environment: 'prod', service: 'web', entity: 'acme', flag: 'max_upload_mb' });
    assert.equal(v.value, 1000);
  });

  test('an entity’s change goes stale when the base moves underneath it', async () => {
    const flag = (await t.as('alice').get('/flags/api_base_url')).json;
    const ms = flag.layers.prod.entities.find((c: any) => c.entity === 'vandelay').layer;
    const cs = await t.as('alice').put('/flags/api_base_url/layers/prod/vandelay', { layer: { ...ms, rules: [] }, expectedVersion: ms.version, reason: 'drop the android rule' });
    const id = cs.json.changeSetId;
    await t.as('bob').post(`/change-sets/${id}/review`, { decision: 'approve' });
    // someone changes the base in the meantime (via another approved change set)
    const base = flag.layers.prod.base;
    const cs2 = await t.as('dana').put('/flags/api_base_url/layers/prod/base', { layer: base, expectedVersion: base.version, reason: 'touch the defaults' });
    await t.as('bob').post(`/change-sets/${cs2.json.changeSetId}/review`, { decision: 'approve' });
    assert.equal((await t.as('dana').post(`/change-sets/${cs2.json.changeSetId}/apply`)).status, 200);
    const apply = await t.as('alice').post(`/change-sets/${id}/apply`);
    assert.equal(apply.status, 409);
    assert.equal((await t.as('alice').get(`/change-sets/${id}`)).json.status, 'conflict');
  });

  test('multi-item change sets apply atomically under one revision', async () => {
    const r = await t.as('alice').post('/change-sets', {
      environment: 'prod', reason: 'Initech launch',
      items: [
        { flag: 'api_base_url', entity: 'initech', expectedLayerVersion: null, proposed: { inherit: 'base_rules_then_customer_default', defaultVariation: 'wonka', rules: [] } },
        { flag: 'max_upload_mb', entity: 'initech', expectedLayerVersion: null, proposed: { inherit: 'customer_only', defaultVariation: 'huge', rules: [] } },
      ],
    });
    assert.equal(r.status, 201);
    await t.as('bob').post(`/change-sets/${r.json.id}/review`, { decision: 'approve' });
    const applied = await t.as('alice').post(`/change-sets/${r.json.id}/apply`);
    assert.equal(applied.status, 200);
    const h = (await t.as('alice').get('/history?entity=initech&environment=prod')).json.filter((x: any) => x.changeSetId === r.json.id);
    assert.equal(h.length, 2);
    assert.equal(h[0].revision, h[1].revision);
  });

  test('scheduled apply runs from the worker', async () => {
    const base = (await t.as('alice').get('/flags/dark_mode_v2')).json.layers.prod.base;
    const r = await t.as('alice').put('/flags/dark_mode_v2/layers/prod/base', { layer: { ...base, defaultVariation: 'on' }, expectedVersion: base.version, reason: 'turn on for everyone' });
    await t.as('bob').post(`/change-sets/${r.json.changeSetId}/review`, { decision: 'approve' });
    // a time in the past is refused, so it's scheduled for later, then made due (an hour ago, by the database's clock)
    const scheduled = await t.as('alice').post(`/change-sets/${r.json.changeSetId}/schedule`, { at: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.json));
    await t.db.query(`update change_set set scheduled_at = now() - interval '1 hour' where id = $1`, [r.json.changeSetId]);
    await t.settle();
    assert.equal((await t.as('alice').get(`/change-sets/${r.json.changeSetId}`)).json.status, 'applied');
  });
});

describe('data plane', () => {
  test('the entity comes from the link; what an app says about itself can’t change it', async () => {
    const file = (await t.cdnFile('dev', 'android', 'vandelay')).json;
    const read = (key: string, attrs: Record<string, unknown>) => cdnAnswer(file, key, attrs);
    const spoof = { 'device.id': 'dev-1', entity: 'soylent', company: 'soylent', project: 'ios', 'app.version': '6.0.0' };
    assert.equal(read('api_base_url', spoof).value, 'https://android.vandelay.api.example.com');
    assert.equal(read('data_region_host', spoof).value, 'https://us.data.example.com');   // spoofed entity (an EU one) ignored
    assert.ok(!('ds_backend_config' in file.flags));                                     // not sent to apps
    assert.ok(!('dark_mode_v2' in file.flags));                                          // not delivered to android
  });

  test('every service gets keys; an app’s key gets no rules, a backend’s gets its own flags only', async () => {
    const app = await t.as('dana').post('/api-keys', { environment: 'dev', service: 'web', scope: 'entity', entity: 'acme' });
    assert.equal(app.status, 201);
    assert.equal((await t.call('GET', '/sdk/v1/flagd/company/acme', undefined, { authorization: `Bearer ${app.json.key}` })).status, 403);
    const server = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json.key;
    const doc = await t.call('GET', '/sdk/v1/flagd/company/soylent', undefined, { authorization: `Bearer ${server}` });
    assert.equal(doc.status, 200);
    assert.ok(doc.json.flags.ds_backend_config);
    assert.ok(!doc.json.flags.android_quick_share);
  });

  test('a save goes through the outbox and reaches the app’s file', async () => {
    const ms = (await t.as('alice').get('/flags/api_base_url')).json.layers.dev.entities.find((c: any) => c.entity === 'vandelay').layer;
    const before_ = (await t.cdnFile('dev', 'web', 'vandelay')).json.metadata.revision;
    await t.as('alice').put('/flags/api_base_url/layers/dev/vandelay', { layer: ms, expectedVersion: ms.version });
    await t.settle();
    assert.ok((await t.cdnFile('dev', 'web', 'vandelay')).json.metadata.revision > before_);
    const q = (await t.as('alice').get('/publish-queue')).json;
    assert.ok(q.every((row: any) => row.publishedAt));
  });

  test('revoked keys stop working', async () => {
    const k = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'entity', entity: 'soylent' })).json;
    const doc = await t.call('GET', '/sdk/v1/flagd', undefined, { authorization: `Bearer ${k.key}` });
    assert.equal(doc.json.metadata.flagSetId, 'dev/server-ds/soylent');                           // an entity’s key gets only its entity
    await t.as('dana').post(`/api-keys/${k.id}/revoke`);
    assert.equal((await t.call('GET', '/sdk/v1/flagd', undefined, { authorization: `Bearer ${k.key}` })).status, 401);
  });
});
