// An alert turns a kill switch off (POST /api/alerts/kill, layers.ts killFromAlert): with a person's On call or Admin
// access token, at once and without a review, even where the environment needs approval. Recorded like break-glass
// ('bypass', the person's name) with the alert's name. Only kill switches; never an Editor's or an agent's token, never
// from a browser, never with the console's sign-in.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const token = async (user: string, body: Record<string, unknown> = {}) => {
  const r = await t.as(user).post('/tokens', { name: 'Grafana alerts', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.token as string;
};
const kill = async (tok: string, body: unknown, o: { path?: string; headers?: Record<string, string> } = {}) => {
  const res = await t.app.request(o.path ?? '/api/alerts/kill', { method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...o.headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const prodBase = async (flag: string) => (await t.as('alice').get(`/flags/${flag}`)).json.layers.prod.base;

test('an on-call token turns a kill switch off in a protected environment at once, recorded as break-glass with the alert', async () => {
  assert.equal((await prodBase('payments_enabled')).enabled, true);
  const oncall = await token('carol');
  const r = await kill(oncall, { flag: 'payments_enabled', environment: 'prod', alert: 'Payments error rate' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.applied, r.json.bypass], [true, true]);
  await t.settle();
  const after = await prodBase('payments_enabled');
  assert.equal(after.enabled, false, 'off at once: no request');
  assert.equal(after.defaultVariation, 'on', 'nothing else changed');
  assert.equal((await t.db.query(`select 1 from change_set`)).rows.length, 0, 'no request was made');
  const h = (await t.as('alice').get('/history?flag=payments_enabled&environment=prod')).json;
  const row = (Array.isArray(h) ? h : h.rows).find((x: { changeType: string }) => x.changeType === 'layer.update');
  assert.deepEqual([row.actorType, row.changedBy, row.comment], ['bypass', 'carol', 'Turned off by the alert “Payments error rate”']);

  // the alert fires again: it's off already, nothing changes
  const again = await kill(oncall, { flag: 'payments_enabled', environment: 'prod', alert: 'Payments error rate' });
  assert.deepEqual([again.status, again.json], [200, { applied: false, alreadyOff: true }]);
});

test('where no approval is needed it is break-glass too; the address can carry the flag and the alert', async () => {
  const admin = await token('dana');
  const r = await kill(admin, {}, { path: '/api/alerts/kill?flag=payments_enabled&environment=dev&alert=Checkout%20latency' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await t.settle();
  const h = (await t.as('alice').get('/history?flag=payments_enabled&environment=dev')).json;
  const row = (Array.isArray(h) ? h : h.rows).find((x: { changeType: string }) => x.changeType === 'layer.update');
  assert.deepEqual([row.actorType, row.changedBy, row.comment], ['bypass', 'dana', 'Turned off by the alert “Checkout latency”']);
});

test('refused: an editor’s or agent’s token, a flag that isn’t a kill switch, a browser, the console’s sign-in', async () => {
  const editor = await token('alice');
  assert.equal((await kill(editor, { flag: 'payments_enabled', environment: 'prod' })).status, 403, 'an editor can’t break glass');
  const agent = await token('alice', { agent: true });
  assert.equal((await kill(agent, { flag: 'payments_enabled', environment: 'prod' })).status, 403, 'nor can an agent');
  const oncall = await token('carol');
  const ops = await kill(oncall, { flag: 'max_upload_mb', environment: 'prod' });
  assert.equal(ops.status, 422);
  assert.match(ops.json.error, /isn’t a kill switch/);
  assert.equal((await prodBase('max_upload_mb')).enabled, true, 'left as it was');
  assert.equal((await kill(oncall, { flag: 'payments_enabled' })).status, 422, 'it needs an environment');
  assert.equal((await kill(oncall, { flag: 'nope', environment: 'prod' })).status, 404);
  assert.equal((await kill(oncall, { flag: 'payments_enabled', environment: 'prod' }, { headers: { origin: 'https://grafana.example.com' } })).status, 403, 'not from a browser');
  assert.equal((await t.as('carol').post('/alerts/kill', { flag: 'payments_enabled', environment: 'prod' })).status, 403, 'only with a token');
});

test('an alerts token turns kill switches off and does nothing else; only On call and Admin people make one', async () => {
  const alerts = await token('dana', { alertsOnly: true });
  const made = (await t.as('dana').get('/tokens')).json.find((x: { alertsOnly: boolean }) => x.alertsOnly);
  assert.deepEqual([made.role, made.agent], ['oncall', false], 'On call, as break-glass needs');
  const r = await kill(alerts, { flag: 'payments_enabled', environment: 'dev', alert: 'Payments error rate' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const call = async (method: string, path: string, body?: unknown) => (await t.app.request(path, { method,
    headers: { authorization: `Bearer ${alerts}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).status;
  assert.equal(await call('GET', '/api/flags'), 403, 'it reads nothing');
  assert.equal(await call('PUT', '/api/flags/max_upload_mb/meta', { description: 'no' }), 403, 'it changes nothing');
  assert.equal(await call('POST', '/api/change-sets/1/review', { decision: 'approve' }), 403, 'it approves nothing');
  assert.equal((await t.as('alice').post('/tokens', { name: 'alerts', alertsOnly: true })).status, 422, 'an editor can’t make one');
  assert.equal((await t.as('carol').post('/tokens', { name: 'alerts', alertsOnly: true, agent: true })).status, 422, 'not for an agent');
  assert.equal((await t.as('carol').post('/tokens', { name: 'alerts', alertsOnly: true })).status, 201, 'an On call person can');
});
