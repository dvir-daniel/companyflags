// Access tokens (server/tokens.ts): a person's token for the console's API. Never above its person's role; an agent's
// is Viewer or Editor and its changes are recorded as an agent's; made and revoked only in the signed-in console;
// refused from a browser, once revoked, or once expired.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const make = async (user: string, body: Record<string, unknown>) => t.as(user).post('/tokens', body);
/** A request with the token only: no sign-in, no console header. */
const withToken = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await t.app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

test('a token acts as its person, without the console’s header, and an agent’s changes say so in History', async () => {
  const made = await make('alice', { name: 'Claude in my editor', agent: true });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.match(made.json.token, /^cfp_/);
  assert.deepEqual([made.json.role, made.json.agent, made.json.person], ['editor', true, 'alice']);
  const read = await withToken(made.json.token, 'GET', '/api/flags/max_upload_mb');
  assert.equal(read.status, 200);
  const changed = await withToken(made.json.token, 'PUT', '/api/flags/max_upload_mb/meta', { description: 'Set by an agent' });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  const h = (await t.as('alice').get('/history?flag=max_upload_mb')).json;
  const row = (Array.isArray(h) ? h : h.rows).find((r: { changeType: string }) => r.changeType === 'flag.update');
  assert.deepEqual([row.changedBy, row.actorType], ['alice', 'agent']);
  // the list shows it without its value
  const list = (await t.as('alice').get('/tokens')).json;
  assert.ok(list.some((x: { prefix: string; token?: string }) => made.json.token.startsWith(x.prefix) && !x.token));
});

test('never above its person: an agent is Viewer or Editor, a person’s token up to their own role', async () => {
  assert.equal((await make('bob', { name: 'agent', agent: true, role: 'approver' })).status, 422, 'an agent never approves');
  assert.equal((await make('alice', { name: 'mine', role: 'admin' })).status, 422, 'an editor makes no admin token');
  assert.equal((await make('dana', { name: 'admin script', role: 'admin' })).status, 422, 'not even an admin makes an admin token');
  const oncall = await make('dana', { name: 'admin script', role: 'oncall' });
  assert.equal(oncall.status, 201, 'an admin’s token is On call at most');
  assert.equal((await make('dana', { name: 'default' })).json.role, 'oncall', 'and that is its default');
  // a viewer may make a token, a viewer's
  const viewer = await make('vera', { name: 'read only' });
  if (viewer.status === 201) {
    assert.equal(viewer.json.role, 'viewer');
    assert.equal((await withToken(viewer.json.token, 'PUT', '/api/flags/max_upload_mb/meta', { description: 'no' })).status, 403);
  }
});

test('tokens are made in the console only, never from a browser, and stop when revoked or expired', async () => {
  const made = (await make('alice', { name: 'CI' })).json;
  assert.equal((await withToken(made.token, 'POST', '/api/tokens', { name: 'another' })).status, 403, 'no tokens made with a token');
  assert.equal((await withToken(made.token, 'GET', '/api/flags', undefined, { origin: 'https://evil.example' })).status, 403, 'not from a browser');
  assert.equal((await withToken('cfp_madeup', 'GET', '/api/flags')).status, 401);
  // expired
  const old = (await make('alice', { name: 'old' })).json;
  await t.db.query(`update access_token set expires_at = now() - interval '1 minute' where id = $1`, [old.id]);
  assert.equal((await withToken(old.token, 'GET', '/api/flags')).status, 401);
  // revoked: by its person, at once
  assert.equal((await t.as('alice').del(`/tokens/${made.id}`)).status, 200);
  assert.equal((await withToken(made.token, 'GET', '/api/flags?environment=dev')).status, 401);
  // someone else's token isn't yours to revoke; an admin's is
  const bobs = (await make('bob', { name: 'bob script' })).json;
  assert.equal((await t.as('alice').del(`/tokens/${bobs.id}`)).status, 404);
  assert.equal((await t.as('dana').del(`/tokens/${bobs.id}`)).status, 200);
});

test('removing a person ends their tokens for good: inviting them again doesn’t bring old ones back', async () => {
  await t.db.query(`insert into app_user (key, name, role) values ('erin', 'Erin (editor)', 'editor')`);
  const made = (await make('erin', { name: 'laptop script' })).json;
  assert.equal((await withToken(made.token, 'GET', '/api/flags?environment=dev')).status, 200);
  assert.equal((await t.as('dana').del('/people/erin')).status, 200);
  assert.equal((await withToken(made.token, 'GET', '/api/flags?environment=dev')).status, 401);
  assert.equal((await t.as('dana').post('/people/erin/invite')).status, 200);
  assert.equal((await withToken(made.token, 'GET', '/api/flags?environment=dev')).status, 401, 'an invite gives back the role, not the old token');
  const row = (await t.as('dana').get('/tokens?all=1')).json.find((x: { id: number }) => x.id === made.id);
  assert.ok(row.revokedAt, 'shown as revoked');
});

test('where changes need approval, an agent’s change is a request a person approves', async () => {
  const agent = (await make('alice', { name: 'agent', agent: true })).json;
  const r = await withToken(agent.token, 'PUT', '/api/flags/android_quick_share/delivery', { environment: 'prod', services: ['android', 'ios'] });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const id = r.json.changeSetId;
  assert.equal((await withToken(agent.token, 'POST', `/api/change-sets/${id}/review`, { decision: 'approve' })).status, 403, 'it can’t approve');
  assert.equal((await t.as('bob').post(`/change-sets/${id}/review`, { decision: 'approve' })).status, 200, 'a person approves');
});

test('a request an agent proposes says so (byAgent); a person’s doesn’t', async () => {
  const agent = (await make('alice', { name: 'a', agent: true })).json;
  const now: string[] = (await t.as('alice').get('/flags/android_quick_share')).json.delivery.prod;
  const next = now.includes('web') ? now.filter((p) => p !== 'web') : [...now, 'web'];
  const byAgent = await withToken(agent.token, 'PUT', '/api/flags/android_quick_share/delivery', { environment: 'prod', services: next });
  assert.equal(byAgent.status, 202, JSON.stringify(byAgent.json));
  const byPerson = await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'prod', services: next });
  assert.equal(byPerson.status, 202, JSON.stringify(byPerson.json));
  const one = async (id: number) => (await t.as('bob').get(`/change-sets/${id}`)).json;
  assert.equal((await one(byAgent.json.changeSetId)).byAgent, true);
  assert.equal((await one(byPerson.json.changeSetId)).byAgent, false);
  const ids = [byAgent.json.changeSetId, byPerson.json.changeSetId];
  const list = (await t.as('bob').get('/change-sets')).json as { id: number; byAgent: boolean; author: string }[];
  assert.deepEqual(list.filter((c) => ids.includes(c.id)).map((c) => [c.author, c.byAgent]), [['alice', false], ['alice', true]],
    'both under alice’s name, newest first');
  // History says the agent asked
  const h = (await t.as('alice').get('/history?type=change_set.create')).json;
  const rows = (Array.isArray(h) ? h : h.rows) as { changeSetId: number; actorType: string }[];
  assert.equal(rows.find((r) => r.changeSetId === byAgent.json.changeSetId)?.actorType, 'agent');
  assert.equal(rows.find((r) => r.changeSetId === byPerson.json.changeSetId)?.actorType, 'user');
});

test('the console offers the roles the server allows a token (policy.ts tokenRoles)', async () => {
  const { roleChoices, allowedRole } = await import('../web/src/pages/tokensKit.ts');
  assert.deepEqual(roleChoices('viewer', false).map(([r]) => r), ['viewer']);
  assert.deepEqual(roleChoices('approver', false).map(([r]) => r), ['viewer', 'editor', 'approver']);
  assert.deepEqual(roleChoices('admin', true).map(([r]) => r), ['viewer', 'editor'], 'an agent: Viewer or Editor');
  assert.equal(allowedRole('admin', 'admin', true), 'editor', 'ticking "For an agent" brings an admin role down to Editor');
  const people: [string, string][] = [['alice', 'editor'], ['bob', 'approver'], ['carol', 'oncall'], ['dana', 'admin']];
  for (const [user, role] of people) {
    for (const agent of [false, true]) {
      for (const [r] of roleChoices(role, agent)) {
        assert.equal((await make(user, { name: `${role} ${r}`, agent, role: r })).status, 201, `${role} gives ${r}${agent ? ' to an agent' : ''}`);
      }
    }
  }
});
