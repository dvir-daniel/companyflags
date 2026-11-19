// Who may change what, and how a change goes through (policy.ts): pure decision tables, then the bulk switch end to end.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalsLeft, approvalsNeeded, approvalsOf, canBreakGlassRollback, mayApprove, mayReview, needsReview, pathIn, reviewRefusal, roleInfo, ROLES, switchPath, switchPlan,
  type ChangeSetFacts, type ReviewFacts,
} from '../server/policy.ts';
import { boot } from './helpers.ts';

// The facts the tables are written against, stated here rather than read from policy.ts.
const REVIEWERS = ['approver', 'oncall', 'admin'];
const BREAK_GLASS_ROLES = ['oncall', 'admin'];
const BREAK_GLASS_KINDS = ['kill_switch', 'ops'];
const KINDS = ['release', 'kill_switch', 'ops', 'experiment', 'config', 'permission'];
const STATUSES = ['in_review', 'approved', 'scheduled', 'applied', 'conflict', 'failed', 'rejected', 'cancelled'];
const OPEN = ['in_review', 'approved'];
const PROD = { minApprovals: 1 };
const DEV = { minApprovals: 0 };

test('roles: labels, and who changes, reviews and may break-glass', () => {
  assert.deepEqual(ROLES, ['viewer', 'editor', 'approver', 'oncall', 'admin']);
  assert.deepEqual(ROLES.map((r) => roleInfo(r).label), ['Viewer', 'Editor', 'Approver', 'On call', 'Admin']);
  assert.deepEqual(ROLES.filter((r) => roleInfo(r).changes), ['editor', 'approver', 'oncall', 'admin']);
  assert.deepEqual(ROLES.filter((r) => roleInfo(r).reviews), REVIEWERS);
  assert.deepEqual(ROLES.filter((r) => roleInfo(r).breaksGlass), BREAK_GLASS_ROLES);
  assert.deepEqual(ROLES.filter((r) => roleInfo(r).changesSettings), ['admin']);
  // on call and admins may also roll a version release back without review (layers.ts checks it's a rollback)
  assert.deepEqual(ROLES.filter((r) => canBreakGlassRollback('release', r)), BREAK_GLASS_ROLES);
  assert.equal(canBreakGlassRollback('config', 'admin'), false);
  assert.deepEqual(roleInfo('superuser'), { label: 'superuser', does: '', changes: false, reviews: false, breaksGlass: false, changesSettings: false });   // unknown: nothing
});

test('needs review and approvals needed: the environment’s min_approvals, at least one approval', () => {
  const table: [{ minApprovals: number } | undefined, boolean, number][] = [
    [{ minApprovals: 0 }, false, 1], [{ minApprovals: 1 }, true, 1], [{ minApprovals: 2 }, true, 2], [{ minApprovals: 5 }, true, 5], [undefined, false, 1],
  ];
  for (const [env, review, needed] of table) {
    assert.equal(needsReview(env), review, `needsReview ${JSON.stringify(env)}`);
    assert.equal(approvalsNeeded(env), needed, `approvalsNeeded ${JSON.stringify(env)}`);
  }
  // only approvals for the change set as it is now count
  const cs: ChangeSetFacts = { author: 'alice', status: 'in_review', reviews: [
    { reviewer: 'bob', decision: 'approve', current: true }, { reviewer: 'carol', decision: 'approve', current: false },
    { reviewer: 'dana', decision: 'reject', current: true },
  ] };
  assert.equal(approvalsOf(cs), 1);
  assert.deepEqual([approvalsLeft(cs, { minApprovals: 1 }), approvalsLeft(cs, { minApprovals: 3 }), approvalsLeft({ ...cs, reviews: null }, { minApprovals: 0 })], [0, 2, 1]);
});

test('may approve: role × author × change set status × already reviewed × fresh or stale', () => {
  const MINE: Record<string, ReviewFacts[]> = {
    'not reviewed': [],
    'approved, fresh': [{ reviewer: 'me', decision: 'approve', current: true }],
    'approved, stale': [{ reviewer: 'me', decision: 'approve', current: false }],
  };
  let rows = 0;
  for (const role of ROLES) for (const own of [false, true]) for (const status of STATUSES) for (const [said, mine] of Object.entries(MINE)) {
    const cs: ChangeSetFacts = { author: own ? 'me' : 'someone', status, reviews: [{ reviewer: 'other', decision: 'approve', current: true }, ...mine] };
    const why = !OPEN.includes(status) ? 'closed' : own ? 'own' : !REVIEWERS.includes(role) ? 'role' : said === 'approved, fresh' ? 'done' : null;
    const where = `${role}, ${own ? 'author' : 'not author'}, ${status}, ${said}`;
    assert.equal(reviewRefusal({ key: 'me', role }, cs)?.why ?? null, why, where);
    assert.equal(mayApprove({ key: 'me', role }, cs), why === null, where);
    // rejecting: the same, except having approved already doesn't stop it
    assert.equal(mayReview({ key: 'me', role }, cs), why === null || why === 'done', where);
    rows++;
  }
  assert.equal(rows, 5 * 2 * STATUSES.length * 3);
  // the words the server answers with
  assert.equal(reviewRefusal({ key: 'alice', role: 'admin' }, { author: 'alice', status: 'in_review' })?.message, 'you can’t approve your own request');
  assert.equal(reviewRefusal({ key: 'alice', role: 'admin' }, { author: 'alice', status: 'in_review' }, 'reject')?.message, 'you can’t reject your own request');
  assert.equal(reviewRefusal({ key: 'bob', role: 'editor' }, { author: 'alice', status: 'in_review' })?.message, 'role editor cannot review requests');
  assert.equal(reviewRefusal({ key: 'bob', role: 'approver' }, { author: 'alice', status: 'applied' })?.message, 'this request is applied');
});

test('the switch: role × flag kind × protected or not', () => {
  let rows = 0;
  for (const role of ROLES) for (const kind of KINDS) for (const env of [DEV, PROD]) {
    const where = `${role}, ${kind}, ${needsReview(env) ? 'protected' : 'not protected'}`;
    const off = role === 'viewer' ? null : !needsReview(env) ? 'now'
      : BREAK_GLASS_ROLES.includes(role) && BREAK_GLASS_KINDS.includes(kind) ? 'break-glass' : 'review';
    const on = role === 'viewer' ? null : !needsReview(env) ? 'now' : 'review';      // break-glass only ever turns a flag off
    assert.equal(switchPath({ role }, { kind }, env, false), off, `off: ${where}`);
    assert.equal(switchPath({ role }, { kind }, env, true), on, `on: ${where}`);
    rows++;
  }
  assert.equal(rows, 5 * KINDS.length * 2);
});

test('the switch plan for several flags: now, review or break-glass, and the saved drafts it discards', () => {
  const flags = [
    { key: 'payments', kind: 'kill_switch', enabled: true }, { key: 'queue', kind: 'ops', enabled: true },
    { key: 'checkout', kind: 'release', enabled: true }, { key: 'api_url', kind: 'config', enabled: true },
    { key: 'old', kind: 'kill_switch', enabled: false },
  ];
  const drafted = new Set(['payments', 'checkout', 'old']);
  const has = (k: string) => drafted.has(k);
  const oncall = switchPlan({ role: 'oncall' }, flags, PROD, false, has);
  assert.deepEqual(oncall, {
    now: [], review: ['checkout', 'api_url'], breakGlass: ['payments', 'queue'], unchanged: ['old'], refused: [],
    drafted: ['payments', 'checkout'],                       // `old` doesn't change, so its draft stays
  });
  assert.deepEqual(flags.map((f) => pathIn(oncall, f.key)), ['break-glass', 'break-glass', 'review', 'review', null]);
  // the switch on one flag's page asks the same: one flag, its page's edits as the draft
  assert.deepEqual(switchPlan({ role: 'oncall' }, [flags[0]], PROD, false, () => true), { ...oncall, review: [], breakGlass: ['payments'], unchanged: [], drafted: ['payments'] });
  assert.deepEqual(switchPlan({ role: 'editor' }, flags, PROD, false, has).review, ['payments', 'queue', 'checkout', 'api_url']);
  assert.deepEqual(switchPlan({ role: 'oncall' }, flags, DEV, false, () => false),
    { now: ['payments', 'queue', 'checkout', 'api_url'], review: [], breakGlass: [], unchanged: ['old'], refused: [], drafted: [] });
  assert.deepEqual(switchPlan({ role: 'admin' }, flags, PROD, true, has),
    { now: [], review: ['old'], breakGlass: [], unchanged: ['payments', 'queue', 'checkout', 'api_url'], refused: [], drafted: ['old'] });
  assert.deepEqual(switchPlan({ role: 'viewer' }, flags, PROD, false, has),
    { now: [], review: [], breakGlass: [], unchanged: ['old'], refused: ['payments', 'queue', 'checkout', 'api_url'], drafted: [] });
});

describe('through the server', () => {
  let t: Awaited<ReturnType<typeof boot>>;
  before(async () => { t = await boot(); });
  after(async () => { await t.stop(); });

  test('on call turning several flags off in prod: break-glass for kill switch and ops flags, a review request for the others', async () => {
    const ops = await t.as('dana').post('/flags', {
      key: 'search_queue', valueType: 'bool', kind: 'ops', variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
      delivery: { dev: ['web'], prod: ['web'] }, base: { enabled: true, defaultVariation: 'on', rules: [] },
    });
    assert.equal(ops.status, 201, JSON.stringify(ops.json));
    // a new flag starts off where approvals are needed: switching it on in prod is a reviewed change like any other
    const fresh = (await t.as('dana').get('/flags/search_queue')).json.layers.prod.base;
    assert.equal(fresh.enabled, false);
    const on = await t.as('dana').put('/flags/search_queue/layers/prod/base', { layer: { ...fresh, enabled: true }, expectedVersion: fresh.version, reason: 'launch the queue' });
    assert.equal(on.status, 202, JSON.stringify(on.json));
    assert.equal((await t.as('bob').post(`/change-sets/${on.json.changeSetId}/review`, { decision: 'approve' })).json.status, 'approved');
    assert.equal((await t.as('dana').post(`/change-sets/${on.json.changeSetId}/apply`)).status, 200);
    await t.settle();
    const picked = ['payments_enabled', 'search_queue', 'new_checkout', 'api_base_url'];

    // what the Flags page's bulk bar has: the rows of the list, the environment and who is signed in
    const meta = (await t.as('carol').get('/meta')).json;
    const rows = (await t.as('carol').get('/flags?page=0&size=50&environment=prod')).json.rows.filter((r: any) => picked.includes(r.key));
    const plan = switchPlan(meta.me, rows.map((r: any) => ({ key: r.key, kind: r.kind, enabled: !!r.envs.prod?.enabled })),
      meta.environments.find((e: any) => e.key === 'prod'), false, () => false);
    assert.deepEqual([plan.breakGlass.sort(), plan.review.sort()], [['payments_enabled', 'search_queue'], ['api_base_url', 'new_checkout']]);

    // and what it sends for each, one by one
    const reason = 'INC-77: search and payments down';
    const answers: Record<string, { status: number; json: any }> = {};
    for (const key of [...plan.breakGlass, ...plan.review]) {
      const base = (await t.as('carol').get(`/flags/${key}`)).json.layers.prod.base;
      answers[key] = await t.as('carol').put(`/flags/${key}/layers/prod/base`, {
        layer: { ...base, enabled: false }, expectedVersion: base.version, reason, bypassReason: plan.breakGlass.includes(key) ? reason : undefined,
      });
    }
    for (const key of plan.breakGlass) assert.deepEqual([answers[key].status, answers[key].json.bypass], [200, true], key);
    for (const key of plan.review) assert.equal(answers[key].status, 202, key);
    await t.settle();

    for (const key of plan.breakGlass) {
      const h = (await t.as('dana').get(`/history?flag=${key}&environment=prod`)).json[0];
      assert.deepEqual([h.actorType, h.changedBy, h.comment], ['bypass', 'carol', `BREAK-GLASS: ${reason}`], key);
      assert.equal((await t.trace({ environment: 'prod', project: 'web', entity: 'acme', flag: key })).reason, 'DISABLED', key);
    }
    for (const key of plan.review) {
      assert.equal((await t.as('carol').get(`/flags/${key}`)).json.layers.prod.base.enabled, true, `${key} waits for review`);
    }

    // the sidebar's count: carol can't approve her own requests, bob can; approving twice is refused
    const waiting: ChangeSetFacts[] = (await t.as('bob').get('/change-sets?status=in_review')).json;
    const ids = plan.review.map((k) => answers[k].json.changeSetId);
    const mine = waiting.filter((c: any) => ids.includes(c.id));
    assert.equal(mine.length, 2);
    assert.ok(mine.every((c) => !mayApprove({ key: 'carol', role: 'oncall' }, c) && mayApprove({ key: 'bob', role: 'approver' }, c)));
    assert.equal((await t.as('carol').post(`/change-sets/${ids[0]}/review`, { decision: 'approve' })).status, 403);
    assert.equal((await t.as('bob').post(`/change-sets/${ids[0]}/review`, { decision: 'approve' })).json.status, 'approved');
    assert.equal((await t.as('bob').post(`/change-sets/${ids[0]}/review`, { decision: 'approve' })).status, 409);
    const [approved] = (await t.as('bob').get('/change-sets?status=approved')).json.filter((c: any) => c.id === ids[0]);
    assert.ok(!mayApprove({ key: 'bob', role: 'approver' }, approved) && mayApprove({ key: 'dana', role: 'admin' }, approved));
  });
});
