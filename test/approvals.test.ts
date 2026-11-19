// Requests (change sets) in an environment that needs approvals: who may review, schedule, cancel and apply them,
// that each happens once even when two people act at the same time, and that nothing that changes what such an
// environment serves can skip the review (variant values, delivery, archiving, new flags, moving a customer).
// Production needs 1 approval in the test data (fixtures.ts).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => {
  t = await boot();
  // a second editor (people an admin added sign in as themselves; test-header names them)
  assert.equal((await t.as('dana').post('/people', { email: 'erin@example.com', role: 'editor' })).status, 201);
});
after(async () => { await t.stop(); });

/** A request in an environment that needs approvals: a change to a flag's defaults. Returns its id. */
async function request(o: { flag?: string; env?: string; by?: string; edit?: (layer: any) => any } = {}): Promise<number> {
  const flag = o.flag ?? 'max_upload_mb';
  const env = o.env ?? 'prod';
  const { version, layer } = await t.baseOf(flag, env);
  const r = await t.as(o.by ?? 'alice').put(`/flags/${flag}/layers/${env}/base`,
    { layer: (o.edit ?? ((l) => ({ ...l, defaultVariation: 'enterprise' })))(layer), expectedVersion: version, reason: 'a test request' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  return r.json.changeSetId;
}
const status = async (id: number) => (await t.as('alice').get(`/change-sets/${id}`)).json.status;
const review = (who: string, id: number, decision: 'approve' | 'reject' = 'approve') => t.as(who).post(`/change-sets/${id}/review`, { decision });

test('an editor can’t approve someone else’s request; a reviewer can reject it, and then it is closed', async () => {
  const id = await request();
  const byEditor = await review('erin@example.com', id);
  assert.equal(byEditor.status, 403);
  assert.match(byEditor.json.error, /role editor cannot review requests/);
  assert.equal(await status(id), 'in_review');
  const rejected = await review('bob', id, 'reject');
  assert.equal(rejected.status, 200, JSON.stringify(rejected.json));
  assert.equal(rejected.json.status, 'rejected');
  assert.equal((await t.as('alice').post(`/change-sets/${id}/apply`)).status, 409, 'a rejected request isn’t applied');
  assert.equal((await review('carol', id)).status, 409, 'nor reviewed again');
  const h = (await t.as('alice').get('/history?limit=50')).json.filter((x: any) => x.changeSetId === id).map((x: any) => x.changeType);
  assert.deepEqual(h.sort(), ['change_set.create', 'change_set.reject']);
});

test('cancel: only the author, and only while the request is open', async () => {
  const id = await request();
  const byOther = await t.as('bob').post(`/change-sets/${id}/cancel`);
  assert.equal(byOther.status, 403);
  assert.match(byOther.json.error, /only the author/);
  assert.equal(await status(id), 'in_review');
  assert.equal((await t.as('alice').post(`/change-sets/${id}/cancel`)).status, 200);
  assert.equal(await status(id), 'cancelled');
  assert.equal((await t.as('alice').post(`/change-sets/${id}/cancel`)).status, 409, 'already cancelled');
  assert.equal((await review('bob', id)).status, 409, 'nobody reviews a cancelled request');
  const listed = (await t.as('alice').get('/change-sets?status=cancelled')).json;
  assert.ok(listed.some((c: any) => c.id === id) && listed.every((c: any) => c.status === 'cancelled'));
});

test('where two approvals are needed, one isn’t enough, and two at the same time both count', async () => {
  assert.equal((await t.as('dana').post('/environments', { key: 'stage', name: 'Staging', minApprovals: 2 })).status, 201);
  await t.settle();
  const on = (l: any) => ({ ...l, enabled: true });
  const one = await request({ env: 'stage', flag: 'api_base_url', edit: on });
  assert.equal((await review('bob', one)).json.status, 'in_review', 'one approval of two');
  assert.equal((await t.as('alice').post(`/change-sets/${one}/apply`)).status, 409);
  assert.equal((await review('carol', one)).json.status, 'approved');

  const two = await request({ env: 'stage', flag: 'payments_enabled', edit: on });
  const both = await Promise.all([review('bob', two), review('dana', two)]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.equal(await status(two), 'approved', 'neither approval was counted without the other');
  assert.equal((await t.as('alice').get(`/change-sets/${two}`)).json.reviews.filter((r: any) => r.decision === 'approve' && r.current).length, 2);
});

test('a request is applied once: a second apply at the same time finds it applied and leaves it so', async () => {
  const id = await request({ flag: 'welcome_message', edit: (l) => ({ ...l, defaultVariation: 'holiday' }) });
  assert.equal((await review('bob', id)).json.status, 'approved');
  const applies = await Promise.all([t.as('alice').post(`/change-sets/${id}/apply`), t.as('bob').post(`/change-sets/${id}/apply`)]);
  assert.deepEqual(applies.map((r) => r.status).sort(), [200, 409], JSON.stringify(applies.map((r) => r.json)));
  const lost = applies.find((r) => r.status === 409)!;
  assert.match(lost.json.error, /this request is applied/);
  const cs = (await t.as('alice').get(`/change-sets/${id}`)).json;
  assert.equal(cs.status, 'applied', 'not turned into a conflict by the one that lost');
  assert.equal(cs.lastError, null);
  assert.ok(cs.appliedRevision > 0);
  const changes = (await t.as('alice').get('/history?flag=welcome_message&environment=prod')).json.filter((x: any) => x.changeSetId === id && x.changeType === 'layer.update');
  assert.equal(changes.length, 1, 'its change was made once');
  assert.equal((await t.as('alice').post(`/change-sets/${id}/apply`)).status, 409);
  assert.equal(await status(id), 'applied');
});

test('scheduling: by the author or a reviewer, only once approved, and in History', async () => {
  const id = await request({ flag: 'data_region_host', edit: (l) => ({ ...l, defaultVariation: 'eu' }) });
  const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal((await t.as('alice').post(`/change-sets/${id}/schedule`, { at: inAnHour })).status, 409, 'not approved yet');
  await review('bob', id);
  const byEditor = await t.as('erin@example.com').post(`/change-sets/${id}/schedule`, { at: inAnHour });
  assert.equal(byEditor.status, 403, 'another editor may not');
  assert.equal((await t.as('alice').post(`/change-sets/${id}/schedule`, { at: 'tomorrow-ish' })).status, 422);
  assert.equal((await t.as('alice').post(`/change-sets/${id}/schedule`, { at: inAnHour })).status, 200, 'the author may');
  const cs = (await t.as('alice').get(`/change-sets/${id}`)).json;
  assert.deepEqual([cs.status, new Date(cs.scheduledAt).toISOString()], ['scheduled', inAnHour]);
  assert.equal((await t.as('bob').post(`/change-sets/${id}/schedule`, { at: inAnHour })).status, 409, 'it isn’t approved any more, it’s scheduled');
  const h = (await t.as('alice').get('/history?limit=50')).json.find((x: any) => x.changeSetId === id && x.changeType === 'change_set.schedule');
  assert.deepEqual([h?.changedBy, h?.after?.scheduledAt], ['alice', inAnHour]);

  const other = await request({ flag: 'dark_mode_v2', edit: (l) => ({ ...l, defaultVariation: 'on' }) });
  await review('carol', other);
  assert.equal((await t.as('bob').post(`/change-sets/${other}/schedule`, { at: inAnHour })).status, 200, 'a reviewer may');
  assert.equal((await t.as('alice').post(`/change-sets/${other}/cancel`)).status, 200, 'and the author can still withdraw it');
});

test('a request names an entity that exists; one that doesn’t is refused, not saved as a change to the defaults', async () => {
  const items = (entity: string) => [{ flag: 'max_upload_mb', entity, expectedLayerVersion: null, proposed: { inherit: 'customer_only', defaultVariation: 'huge', rules: [] } }];
  const unknown = await t.as('alice').post('/change-sets', { environment: 'prod', reason: 'x', items: items('nobody') });
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /“nobody” not found|"nobody" not found/);
  assert.equal((await t.as('alice').post('/change-sets', { environment: 'prod', reason: 'x', items: items('acme') })).status, 201);
});

test('the request list: newest first, with each item’s kind; filtered by status', async () => {
  const id = await request({ flag: 'android_quick_share', edit: (l) => ({ ...l, defaultVariation: 'off' }) });
  const list = await t.as('alice').get('/change-sets');
  assert.equal(list.status, 200);
  const ids = list.json.map((c: any) => c.id);
  assert.deepEqual(ids, [...ids].sort((a: number, b: number) => b - a));
  const mine = list.json.find((c: any) => c.id === id);
  assert.deepEqual([mine.environment, mine.status, mine.author, mine.items], ['prod', 'in_review', 'alice', [{ kind: 'layer', flag: 'android_quick_share', entity: null }]]);
  const open = (await t.as('alice').get('/change-sets?status=in_review')).json;
  assert.ok(open.length > 0 && open.every((c: any) => c.status === 'in_review'));
  // the console's badge: the requests waiting, in every environment, that the signed-in person may approve
  // (policy.ts mayApprove: not their own, not already approved by them as they are now)
  const forBob = open.filter((c: any) => c.author !== 'bob' && !(c.reviews ?? []).some((r: any) => r.reviewer === 'bob' && r.decision === 'approve' && r.current));
  const meta = (await t.as('bob').get('/meta')).json;
  assert.ok(forBob.length > 0);
  assert.equal(meta.pendingApprovals, forBob.length, 'a reviewer: every request waiting that they may approve');
  assert.equal((await t.as('alice').get('/meta')).json.pendingApprovals, 0, 'an editor approves nothing');
  const pending = async (who: string) => (await t.as(who).get('/meta')).json.pendingApprovals as number;
  const carol = await pending('carol');
  await request({ flag: 'android_quick_share', edit: (l) => ({ ...l, enabled: false }) });
  assert.deepEqual([await pending('bob'), await pending('carol')], [meta.pendingApprovals + 1, carol + 1]);
  await request({ by: 'bob' });
  assert.deepEqual([await pending('bob'), await pending('carol')], [meta.pendingApprovals + 1, carol + 2], 'not their own request');
});

test('POST /flags/:key/publish/:env: several layers of one flag at once, applied together or one request', async () => {
  const flag = (await t.as('alice').get('/flags/new_checkout')).json;
  const items = (env: string) => {
    const { version, updatedAt: _u, updatedBy: _b, ...base } = flag.layers[env].base;
    return [
      { entity: null, expectedVersion: version, layer: { ...base, defaultVariation: 'on' } },
      { entity: 'initech', expectedVersion: null, layer: { inherit: 'customer_only', defaultVariation: 'off', rules: [] } },
    ];
  };
  const dev = await t.as('alice').post('/flags/new_checkout/publish/dev', { items: items('dev') });
  assert.equal(dev.status, 200, JSON.stringify(dev.json));
  assert.equal(dev.json.applied, true);
  const h = (await t.as('alice').get(`/history?environment=dev&revision=${dev.json.revision}`)).json;
  assert.deepEqual(h.map((x: any) => x.entity).sort(), ['initech', null].sort(), 'both in one version');
  assert.equal((await t.as('alice').post('/flags/new_checkout/publish/prod', { items: items('prod') })).status, 422, 'a reason for the reviewer');
  const prod = await t.as('alice').post('/flags/new_checkout/publish/prod', { items: items('prod'), reason: 'initech launch' });
  assert.equal(prod.status, 202);
  assert.equal((await t.as('alice').get(`/change-sets/${prod.json.changeSetId}`)).json.items.length, 2);
  assert.equal((await t.as('alice').post('/flags/new_checkout/publish/dev', { items: [] })).status, 422, 'nothing to publish');
});

// ---------------------------------------------------------------- nothing skips the review

test('variant values: new ones and unused ones change at once (audited, republished); one production serves is refused', async () => {
  const before = t.plane.get('dev').revision;
  const added = await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'giant', value: 9999 }] });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  await t.settle();
  assert.equal(t.plane.get('dev').flags.max_upload_mb.variations.giant, 9999, 'published');
  assert.ok(t.plane.get('dev').revision > before);
  const h = (await t.as('alice').get('/history?flag=max_upload_mb')).json
    .filter((x: any) => x.changeType === 'variations.update' && x.after.some((v: any) => v.key === 'giant') && !x.before.some((v: any) => v.key === 'giant'));
  const envs = (await t.as('alice').get('/meta')).json.environments.map((e: any) => e.key);
  assert.deepEqual(h.map((x: any) => x.environment).sort(), [...envs].sort(), 'in every environment’s history, with before and after');
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'giant', value: 9000 }] })).status, 200, 'nothing serves it yet');
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'standard', value: 100 }] })).status, 200, 'the same value is no change');

  for (const [variant, how] of [['standard', 'the default'], ['enterprise', 'a rule'], ['huge', 'a customer’s rule']]) {
    const r = await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: variant, value: 1 }] });
    assert.equal(r.status, 409, `${variant} (${how})`);
    assert.equal(r.json.error, `${variant} is served in prod, which needs approval: add a new value and point the rules at it`);
  }
  await t.settle();
  assert.equal(t.plane.get('prod').flags.max_upload_mb.variations.standard, 100, 'unchanged');
  // a % of devices serves "on" in production for new_checkout
  assert.equal((await t.as('alice').put('/flags/new_checkout/variations', { variations: [{ key: 'on', value: false }] })).status, 409);
});

test('which apps get a flag: at once in development; a request in production, checked against what it was', async () => {
  const dev = await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'dev', projects: ['android', 'ios'] });
  assert.equal(dev.status, 200, JSON.stringify(dev.json));
  assert.equal(dev.json.applied, true);
  assert.ok(dev.json.revision > 0);
  const stale = await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'dev', projects: ['android'], before: ['android'] });
  assert.equal(stale.status, 409, 'the console saw only android: someone added ios since');

  const asked = await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'prod', projects: ['android', 'ios'] });
  assert.equal(asked.status, 202, JSON.stringify(asked.json));
  assert.equal(asked.json.applied, false);
  const id = asked.json.changeSetId;
  await t.settle();
  assert.deepEqual(t.plane.get('prod').flags.android_quick_share.delivery, ['android'], 'nothing changed yet');
  const cs = (await t.as('alice').get(`/change-sets/${id}`)).json;
  assert.deepEqual(cs.items.map((i: any) => [i.kind, i.flag, i.entity, i.before, i.proposed]),
    [['delivery', 'android_quick_share', null, { projects: ['android'] }, { projects: ['android', 'ios'] }]]);
  assert.match(cs.reason, /android, ios/, 'a reason saying what changes, when none is given');
  assert.equal((await t.as('alice').get('/change-sets?status=in_review')).json.find((c: any) => c.id === id).items[0].kind, 'delivery');
  assert.equal((await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'prod', projects: ['android'] })).status, 422, 'no change');
  assert.equal((await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'prod', projects: ['fridge'] })).status, 422);

  await review('bob', id);
  assert.equal((await t.as('alice').post(`/change-sets/${id}/apply`)).status, 200);
  await t.settle();
  assert.deepEqual([...t.plane.get('prod').flags.android_quick_share.delivery].sort(), ['android', 'ios']);
  const h = (await t.as('alice').get('/history?flag=android_quick_share&environment=prod')).json.find((x: any) => x.changeType === 'delivery.update');
  assert.deepEqual([h.changeSetId, h.before, h.after], [id, ['android'], ['android', 'ios']]);

  // two requests made against the same apps: whichever is applied second finds them changed
  const remove = (await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'prod', projects: ['android'], reason: 'ios is not ready' })).json.changeSetId;
  const add = (await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'prod', projects: ['android', 'ios', 'web'] })).json.changeSetId;
  await review('bob', remove);
  await review('bob', add);
  assert.equal((await t.as('alice').post(`/change-sets/${add}/apply`)).status, 200);
  const late = await t.as('alice').post(`/change-sets/${remove}/apply`);
  assert.equal(late.status, 409);
  assert.match(late.json.error, /changed after this request was made/);
  assert.equal(await status(remove), 'conflict');
});

test('archiving: refused while the flag is on, or sent to apps, where approvals are needed; a new flag starts off there', async () => {
  const on = await t.as('alice').post('/flags/payments_enabled/archive');
  assert.equal(on.status, 409);
  assert.equal(on.json.error, 'turn payments_enabled off in prod first (that change is reviewed)');
  assert.ok(!(await t.as('alice').get('/flags/payments_enabled')).json.archivedAt);

  const newFlag = (key: string, delivery: Record<string, string[]>) => t.as('alice').post('/flags', {
    key, valueType: 'bool', kind: 'ops', variations: [{ key: 'on', value: true }, { key: 'off', value: false }], delivery,
    base: { enabled: true, defaultVariation: 'on', rules: [] },
  });
  assert.equal((await newFlag('sent_to_prod', { dev: ['web'], prod: ['web'] })).status, 201);
  const made = (await t.as('alice').get('/flags/sent_to_prod')).json;
  assert.deepEqual([made.layers.dev.base.enabled, made.layers.prod.base.enabled], [true, false], 'on where asked, except where approvals are needed');
  const sent = await t.as('alice').post('/flags/sent_to_prod/archive');
  assert.equal(sent.status, 409);
  assert.match(sent.json.error, /stop sending sent_to_prod to apps in prod first/);

  assert.equal((await newFlag('dev_only', { dev: ['web'] })).status, 201);
  await t.settle();
  assert.ok(t.plane.get('dev').flags.dev_only);
  const archived = await t.as('alice').post('/flags/dev_only/archive');
  assert.equal(archived.status, 200, JSON.stringify(archived.json));
  await t.settle();
  assert.ok((await t.as('alice').get('/flags/dev_only')).json.archivedAt);
  assert.equal(t.plane.get('dev').flags.dev_only, undefined, 'gone from what apps get');
  assert.equal((await t.as('alice').post('/flags/dev_only/archive')).status, 404, 'already archived');
  assert.ok((await t.as('alice').get('/history?flag=dev_only')).json.some((x: any) => x.changeType === 'flag.archive'));
});
