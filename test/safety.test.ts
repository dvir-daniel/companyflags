// The incident path and the life of a request (docs/guide/approvals.md): break-glass on any kind of flag, a release
// paused, a kill switch's safe value served to everyone, who may stop a scheduled request, History entries for how a
// request ends, restoring an archived flag, and the approvals an environment's people can't meet.
// Production needs 1 approval in the test data (fixtures.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalsShortfall, maySetSafeValue, mayUnschedule, mayWithdraw, unscheduleRefusal, withdrawRefusal } from '../server/policy.ts';
import { applyChange } from '../server/release.ts';
import { eventOf, sentence } from '../server/webhooks.ts';
import { boot, deviceIn } from './helpers.ts';

describe('policy', () => {
  test('approvals an environment can’t meet: too few reviewers, or exactly as many (a reviewer’s own request)', () => {
    const people = (...roles: string[]) => roles.map((role) => ({ role }));
    assert.equal(approvalsShortfall({ minApprovals: 0 }, people('admin')), null, 'nothing reviewed');
    assert.match(approvalsShortfall({ minApprovals: 1 }, people('admin'))!, /^Only 1 person can review, and nobody approves their own request/);
    assert.match(approvalsShortfall({ minApprovals: 1 }, people('editor'))!, /^Nobody can review, and a request needs 1 approval: nothing here could go out/);
    assert.equal(approvalsShortfall({ minApprovals: 1 }, people('admin', 'approver')), null);
    assert.match(approvalsShortfall({ minApprovals: 2 }, people('admin', 'oncall', 'editor'))!, /^Only 2 people can review/);
    assert.match(approvalsShortfall({ minApprovals: 3 }, people('admin', 'oncall'))!, /needs 3 approvals: nothing here could go out/);
    // people whose access was removed don't review
    assert.match(approvalsShortfall({ minApprovals: 1 }, [{ role: 'admin' }, { role: 'approver', status: 'removed' }])!, /^Only 1 person/);
  });

  test('unschedule: its author or a reviewer, only while scheduled; withdraw: its author, while still open', () => {
    const cs = (status: string) => ({ author: 'alice', status });
    assert.equal(mayUnschedule({ key: 'alice', role: 'editor' }, cs('scheduled')), true, 'the author');
    assert.equal(mayUnschedule({ key: 'bob', role: 'approver' }, cs('scheduled')), true, 'a reviewer');
    assert.equal(unscheduleRefusal({ key: 'erin', role: 'editor' }, cs('scheduled'))?.why, 'role');
    assert.equal(unscheduleRefusal({ key: 'bob', role: 'approver' }, cs('approved'))?.why, 'closed');
    for (const status of ['in_review', 'approved', 'scheduled']) assert.equal(mayWithdraw({ key: 'alice' }, cs(status)), true, status);
    for (const status of ['applied', 'rejected', 'cancelled', 'conflict']) assert.equal(withdrawRefusal({ key: 'alice' }, cs(status))?.why, 'closed', status);
    assert.equal(withdrawRefusal({ key: 'bob' }, cs('scheduled'))?.why, 'own');
  });

  test('the safe value: anyone who changes flags names it, but only admins while an environment is protected', () => {
    const open = [{ minApprovals: 0 }];
    const guarded = [{ minApprovals: 0 }, { minApprovals: 1 }];
    assert.deepEqual(['viewer', 'editor', 'oncall', 'admin'].map((role) => maySetSafeValue({ role }, open)), [false, true, true, true]);
    assert.deepEqual(['viewer', 'editor', 'oncall', 'admin'].map((role) => maySetSafeValue({ role }, guarded)), [false, false, false, true]);
  });

  test('the new endings of a request go out on the reviews webhook, in words', () => {
    const names = { person: new Map(), entity: new Map(), environment: new Map() };
    const row = (kind: string, comment: string | null = null) => ({ id: 1, environment: 'prod', revision: null, changedAt: '', at: '', changedBy: 'bob', actorType: 'user',
      kind, flag: null, entity: null, before: null, after: null, comment, changeSetId: 12 });
    for (const kind of ['change_set.withdraw', 'change_set.unschedule', 'change_set.apply_failed']) assert.equal(eventOf(row(kind)), 'reviews', kind);
    assert.equal(sentence(row('change_set.withdraw'), names), 'Withdrew request #12');
    assert.equal(sentence(row('change_set.unschedule'), names), 'Unscheduled request #12: it won’t go out on its own');
    assert.equal(sentence(row('change_set.apply_failed', 'max_upload_mb was changed'), names), 'Request #12 couldn’t go out: max_upload_mb was changed');
  });
});

describe('through the server', () => {
  let t: Awaited<ReturnType<typeof boot>>;
  before(async () => {
    t = await boot();
    assert.equal((await t.as('dana').post('/people', { email: 'erin@example.com', role: 'editor' })).status, 201);
  });
  after(async () => { await t.stop(); });

  const history = async (q: string) => (await t.as('dana').get(`/history?${q}`)).json as any[];
  /** A request to change max_upload_mb's default in prod, by alice. */
  const request = async (variant = 'enterprise') => {
    const { version, layer } = await t.baseOf('max_upload_mb', 'prod');
    const r = await t.as('alice').put('/flags/max_upload_mb/layers/prod/base', { layer: { ...layer, defaultVariation: variant }, expectedVersion: version, reason: 'bigger uploads' });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    return r.json.changeSetId as number;
  };
  const approve = async (id: number) => assert.equal((await t.as('bob').post(`/change-sets/${id}/review`, { decision: 'approve' })).json.status, 'approved');
  const status = async (id: number) => (await t.as('alice').get(`/change-sets/${id}`)).json.status;
  const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

  test('break-glass pauses an on/off release mid-rollout, or turns it off; it can’t widen it', async () => {
    const created = await t.as('dana').post('/flags', {
      key: 'quick_search', valueType: 'bool', kind: 'release', removeBy: '2027-06-30', variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
      delivery: { dev: ['web'], prod: ['web'] }, base: { enabled: false, defaultVariation: 'off', rules: [] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const variants = [{ key: 'on', value: true }, { key: 'off', value: false }];
    // 20% of devices in prod, reviewed and applied
    let { version, layer } = await t.baseOf('quick_search', 'prod');
    const started = await t.as('alice').put('/flags/quick_search/layers/prod/base', { layer: applyChange(variants, layer, { kind: 'percent', percent: 20 }, 'quick_search'),
      expectedVersion: version, reason: 'start at 20%' });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    await approve(started.json.changeSetId);
    assert.equal((await t.as('alice').post(`/change-sets/${started.json.changeSetId}/apply`)).status, 200);
    await t.settle();
    const inside = deviceIn('quick_search', 0, 2000);
    const value = async () => (await t.trace({ environment: 'prod', service: 'web', entity: 'acme', attrs: { 'device.id': inside }, flag: 'quick_search' })).value;
    assert.equal(await value(), true);

    ({ version, layer } = await t.baseOf('quick_search', 'prod'));
    const step = (change: Parameters<typeof applyChange>[2]) => applyChange(variants, layer, change, 'quick_search');
    const put = (who: string, l: unknown, bypassReason?: string) => t.as(who).put('/flags/quick_search/layers/prod/base', { layer: l, expectedVersion: version, reason: 'INC-5', bypassReason });
    assert.equal((await put('alice', step({ kind: 'pause' }), 'INC-5')).status, 403, 'an editor can’t break glass');
    assert.equal((await put('carol', step({ kind: 'percent', percent: 50 }), 'INC-5')).status, 403, 'widening is a request');
    const paused = await put('carol', step({ kind: 'pause' }), 'INC-5: search times out');
    assert.deepEqual([paused.status, paused.json.bypass], [200, true], JSON.stringify(paused.json));
    await t.settle();
    assert.equal(await value(), false, 'everyone back on the old value');
    const [h] = await history('flag=quick_search&environment=prod');
    assert.deepEqual([h.actorType, h.changedBy, h.comment], ['bypass', 'carol', 'BREAK-GLASS: INC-5: search times out']);
    // the % is kept for resume, and turning it off is break-glass too
    ({ version, layer } = await t.baseOf('quick_search', 'prod'));
    assert.ok(layer.rules.some((r: any) => r.disabled && r.split), 'its % rule is kept, switched off');
    const off = await put('carol', { ...layer, enabled: false }, 'INC-5: still timing out');
    assert.deepEqual([off.status, off.json.bypass], [200, true]);
  });

  test('a kill switch’s safe value: who names it, and serving it to everyone, entity settings included', async () => {
    // named by an admin only, while prod needs approval; a kill switch or ops flag only; one of its own variants
    assert.equal((await t.as('alice').put('/flags/payments_enabled/safe-variant', { variant: 'off' })).status, 403);
    assert.equal((await t.as('dana').put('/flags/api_base_url/safe-variant', { variant: 'default' })).status, 422, 'a config flag has none');
    assert.equal((await t.as('dana').put('/flags/payments_enabled/safe-variant', { variant: 'nope' })).status, 422);
    assert.equal((await t.as('dana').post('/flags/payments_enabled/layers/dev/safe-value', { reason: 'x' })).status, 422, 'none named yet');
    assert.deepEqual((await t.as('dana').put('/flags/payments_enabled/safe-variant', { variant: 'off' })).json, { safeVariant: 'off' });
    assert.equal((await t.as('alice').get('/flags/payments_enabled')).json.safeVariant, 'off');
    assert.equal((await history('flag=payments_enabled&environment=prod'))[0].changeType, 'flag.update');

    // dev isn't protected: anyone who changes flags serves it at once. Acme's own settings serve on: they get it too.
    const own = await t.as('alice').put('/flags/payments_enabled/layers/dev/acme', {
      layer: { inherit: 'customer_only', defaultVariation: 'on', rules: [{ conditions: [{ field: 'app.version', op: 'semver_gte', values: ['1.0.0'] }], serveVariation: 'on' }] },
      expectedVersion: null });
    assert.equal(own.status, 200, JSON.stringify(own.json));
    const dev = await t.as('alice').post('/flags/payments_enabled/layers/dev/safe-value', { reason: 'INC-8' });
    assert.equal(dev.status, 200, JSON.stringify(dev.json));
    await t.settle();
    for (const entity of ['acme', 'globex', null]) {
      const r = await t.trace({ environment: 'dev', service: 'web', entity, attrs: { 'app.version': '2.0.0' }, flag: 'payments_enabled' });
      assert.deepEqual([r.value, r.variant], [false, 'off'], `${entity}: the safe value`);
      assert.notEqual(r.reason, 'DISABLED', 'a value is sent');
    }
    const flag = (await t.as('alice').get('/flags/payments_enabled')).json;
    assert.equal(flag.layers.dev.base.enabled, true, 'the defaults stay on');
    const acme = flag.layers.dev.entities.find((e: any) => e.entity === 'acme').layer;
    assert.ok(acme.rules.length === 1 && acme.rules.every((r: any) => r.disabled), 'acme’s rules are kept, switched off');
    assert.equal((await t.as('alice').post('/flags/payments_enabled/layers/dev/safe-value', { reason: 'again' })).status, 409, 'already safe');

    // prod is protected: on call breaks glass with a reason; an editor sends a request
    assert.equal((await t.as('carol').post('/flags/payments_enabled/layers/prod/safe-value', {})).status, 422, 'break-glass needs a reason');
    assert.equal((await t.as('alice').post('/flags/payments_enabled/layers/prod/safe-value', { reason: 'INC-9' })).status, 403);
    const asked = await t.as('alice').post('/flags/payments_enabled/layers/prod/safe-value', { reason: 'INC-9', request: true });
    assert.equal(asked.status, 202, JSON.stringify(asked.json));
    assert.equal(await status(asked.json.changeSetId), 'in_review');
    const now = await t.as('carol').post('/flags/payments_enabled/layers/prod/safe-value', { reason: 'INC-9: card provider down' });
    assert.deepEqual([now.status, now.json.bypass], [200, true], JSON.stringify(now.json));
    await t.settle();
    const r = await t.trace({ environment: 'prod', service: 'web', entity: 'acme', flag: 'payments_enabled' });
    assert.deepEqual([r.value, r.reason === 'DISABLED'], [false, false]);
    const [h] = await history('flag=payments_enabled&environment=prod');
    assert.deepEqual([h.actorType, h.changedBy, h.comment], ['bypass', 'carol', 'BREAK-GLASS (safe value): INC-9: card provider down']);
    // "stop sending" stays its own action: turning it off sends nothing
    const { version, layer } = await t.baseOf('payments_enabled', 'prod');
    const stop = await t.as('carol').put('/flags/payments_enabled/layers/prod/base', { layer: { ...layer, enabled: false }, expectedVersion: version, bypassReason: 'INC-9' });
    assert.equal(stop.status, 200);
    await t.settle();
    assert.equal((await t.trace({ environment: 'prod', service: 'web', entity: 'acme', flag: 'payments_enabled' })).reason, 'DISABLED');

    // a purpose without a safe value drops it
    assert.equal((await t.as('dana').put('/flags/payments_enabled/meta', { kind: 'config' })).status, 200);
    assert.equal((await t.as('dana').get('/flags/payments_enabled')).json.safeVariant, null);
    assert.equal((await t.as('dana').put('/flags/payments_enabled/meta', { kind: 'kill_switch' })).status, 200);
  });

  test('a time in the past is refused; any reviewer can unschedule (with a reason) or reject a scheduled request', async () => {
    const id = await request();
    await approve(id);
    const past = await t.as('alice').post(`/change-sets/${id}/schedule`, { at: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(past.status, 422);
    assert.match(past.json.error, /has passed/);
    assert.equal((await t.as('alice').post(`/change-sets/${id}/schedule`, { at: inAnHour() })).status, 200);

    // someone who isn't its author or a reviewer can't stop it; a reviewer can, with a reason
    assert.equal((await t.as('erin@example.com').post(`/change-sets/${id}/unschedule`, { reason: 'freeze' })).status, 403);
    assert.equal((await t.as('bob').post(`/change-sets/${id}/unschedule`, {})).status, 422, 'a reason is required');
    assert.equal((await t.as('bob').post(`/change-sets/${id}/unschedule`, { reason: 'Code freeze this week' })).status, 200);
    assert.equal(await status(id), 'approved');
    assert.equal((await t.as('bob').post(`/change-sets/${id}/unschedule`, { reason: 'again' })).status, 409, 'not scheduled any more');

    // scheduled again, then rejected by a reviewer: that needs a reason too
    assert.equal((await t.as('alice').post(`/change-sets/${id}/schedule`, { at: inAnHour() })).status, 200);
    assert.equal((await t.as('carol').post(`/change-sets/${id}/review`, { decision: 'reject' })).status, 422);
    const rejected = await t.as('carol').post(`/change-sets/${id}/review`, { decision: 'reject', comment: 'Not during the incident' });
    assert.equal(rejected.json.status, 'rejected', JSON.stringify(rejected.json));
    assert.equal((await t.as('bob').post(`/change-sets/${id}/review`, { decision: 'approve' })).status, 409, 'it is closed');

    const rows = (await history(`type=change_set`)).filter((h) => h.changeSetId === id);
    const unscheduled = rows.find((h) => h.changeType === 'change_set.unschedule');
    assert.deepEqual([unscheduled.changedBy, unscheduled.comment, unscheduled.environment], ['bob', 'Code freeze this week', 'prod']);
    assert.ok(unscheduled.before.scheduledAt, 'when it would have gone out');
    assert.deepEqual(rows.find((h) => h.changeType === 'change_set.reject').comment, 'Not during the incident');
  });

  test('a withdrawn request and a scheduled one that couldn’t apply are in History', async () => {
    const withdrawn = await request('huge');
    assert.equal((await t.as('bob').post(`/change-sets/${withdrawn}/cancel`)).status, 403, 'a reviewer rejects instead');
    assert.equal((await t.as('alice').post(`/change-sets/${withdrawn}/cancel`, { reason: 'Wrong value' })).status, 200);
    const [w] = (await history('type=change_set')).filter((h) => h.changeSetId === withdrawn && h.changeType === 'change_set.withdraw');
    assert.deepEqual([w.changedBy, w.comment, w.environment, w.before], ['alice', 'Wrong value', 'prod', { status: 'in_review' }]);

    // scheduled, then the flag changes under it: when its time comes it ends as a conflict, said in History
    const id = await request();
    await approve(id);
    assert.equal((await t.as('alice').post(`/change-sets/${id}/schedule`, { at: inAnHour() })).status, 200);
    const other = await request('huge');
    await approve(other);
    assert.equal((await t.as('alice').post(`/change-sets/${other}/apply`)).status, 200);
    await t.db.query(`update change_set set scheduled_at = now() - interval '1 second' where id = $1`, [id]);
    await t.settle();
    assert.equal(await status(id), 'conflict');
    const [failed] = (await history('type=change_set')).filter((h) => h.changeSetId === id && h.changeType === 'change_set.apply_failed');
    assert.ok(failed, 'in History');
    assert.deepEqual([failed.changedBy, failed.actorType, failed.environment, failed.after], ['scheduler', 'scheduler', 'prod', { status: 'conflict' }]);
    assert.match(failed.comment, /changed by someone else/);
  });

  test('approvers see when a request reassigns which devices are inside a %', async () => {
    const created = await t.as('dana').post('/flags', {
      key: 'shuffle_me', valueType: 'bool', kind: 'experiment', removeBy: '2027-06-30', variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
      delivery: { dev: ['web'], prod: ['web'] },
      base: { enabled: false, defaultVariation: 'off', rules: [{ conditions: [], split: { by: 'device.id', ranges: [{ variation: 'on', from: 0, to: 1000 }] } }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const { version, layer } = await t.baseOf('shuffle_me', 'prod');
    const moved = { ...layer, rules: layer.rules.map((r: any) => ({ ...r, split: { ...r.split, ranges: [{ variation: 'on', from: 5000, to: 6000 }] } })) };
    const plain = await t.as('alice').put('/flags/shuffle_me/layers/prod/base', { layer: moved, expectedVersion: version, reason: 'move it' });
    assert.equal(plain.json.code, 'needs_reshuffle', 'the author is asked first');
    const r = await t.as('alice').put('/flags/shuffle_me/layers/prod/base', { layer: moved, expectedVersion: version, reason: 'move it', allowReshuffle: true });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const cs = (await t.as('bob').get(`/change-sets/${r.json.changeSetId}`)).json;
    assert.equal(cs.items[0].allowReshuffle, true);
    const calm = (await t.as('bob').get(`/change-sets/${await request('huge')}`)).json;
    assert.equal(calm.items[0].allowReshuffle, false);
  });

  test('an archived flag comes back the same: its key, settings and services; off and in no service where approval is now needed', async () => {
    const created = await t.as('dana').post('/flags', {
      key: 'old_banner', valueType: 'bool', kind: 'config', variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
      delivery: { dev: ['web'] }, base: { enabled: true, defaultVariation: 'on', rules: [] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal((await t.as('alice').post('/flags/old_banner/unarchive')).status, 409, 'not archived');
    assert.equal((await t.as('alice').post('/flags/old_banner/archive')).status, 200);
    const again = await t.as('alice').post('/flags', { key: 'old_banner', valueType: 'bool', kind: 'config', variations: [{ key: 'on', value: true }, { key: 'off', value: false }] });
    assert.ok(again.status >= 400, 'the key is still taken');

    assert.equal((await t.as('alice').post('/flags/old_banner/unarchive')).status, 200);
    await t.settle();
    let f = (await t.as('alice').get('/flags/old_banner')).json;
    assert.deepEqual([f.archivedAt, f.layers.dev.base.enabled, f.delivery.dev], [null, true, ['web']]);
    assert.equal((await t.trace({ environment: 'dev', service: 'web', entity: 'acme', flag: 'old_banner' })).value, true, 'served again');
    const restored = (await history('flag=old_banner')).filter((h) => h.changeType === 'flag.unarchive');
    assert.deepEqual(restored.map((h) => h.environment).sort(), ['dev', 'prod'], 'in every environment’s History');

    // archived again, and dev needs approval by the time it comes back: there it comes back off and in no service
    assert.equal((await t.as('alice').post('/flags/old_banner/archive')).status, 200);
    assert.equal((await t.as('dana').put('/environments/dev', { name: 'Development', minApprovals: 1 })).status, 200);
    try {
      assert.equal((await t.as('alice').post('/flags/old_banner/unarchive')).status, 200);
      await t.settle();
      f = (await t.as('alice').get('/flags/old_banner')).json;
      assert.deepEqual([f.layers.dev.base.enabled, f.delivery.dev], [false, []]);
      const kinds = (await history('flag=old_banner&environment=dev')).slice(0, 3).map((h) => h.changeType).sort();
      assert.deepEqual(kinds, ['delivery.update', 'flag.unarchive', 'layer.update']);
    } finally {
      assert.equal((await t.as('dana').put('/environments/dev', { name: 'Development', minApprovals: 0 })).status, 200);
    }
  });
});
