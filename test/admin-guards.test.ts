// What only a person does, signed in (server/api.ts peopleOnly): access tokens are refused on people, invites, password
// resets, single sign-on, the sign-in rules and the appearance, and on lowering an environment's approvals. A token
// is On call at most (policy.ts TOKEN_MAX_ROLE), even one made as an admin before. API keys can expire.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../server/auth.ts';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

/** A request with the token only: no sign-in, no console header. */
const withToken = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await t.app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

test('a token can’t manage people, sign-in, single sign-on or the look, or lower approvals: not even one made as an admin', async () => {
  const made = (await t.as('dana').post('/tokens', { name: 'script', role: 'oncall' })).json;
  // a token made as an admin before tokens stopped at On call: it acts as On call
  const old = 'cfp_an-old-admin-token-made-before';
  await t.db.query(`insert into access_token (token_hash, token_prefix, person_id, name, role, expires_at)
    select $1, 'cfp_an-old', id, 'old admin', 'admin', now() + interval '1 day' from app_user where key = 'dana'`, [sha256(old)]);
  const prod = (await t.as('dana').get('/meta')).json.environments.find((e: { key: string }) => e.key === 'prod');
  for (const token of [made.token, old]) {
    for (const [method, path, body] of [
      ['POST', '/api/people', { email: 'new@example.com', role: 'admin' }],
      ['PUT', '/api/people/alice', { role: 'admin' }],
      ['POST', '/api/people/alice/invite', {}],
      ['POST', '/api/people/alice/password-reset', {}],
      ['DELETE', '/api/people/alice', {}],
      ['PUT', '/api/appearance', { name: 'Not ours' }],
      ['DELETE', '/api/appearance', {}],
      ['POST', '/api/sso', { type: 'oidc', id: 'okta', domains: 'example.com' }],
      ['PUT', '/api/sso/okta', { requireSso: true }],
      ['DELETE', '/api/sso/okta', {}],
      ['PUT', '/api/sign-in-rules', { joinRole: 'editor' }],
      ['PUT', '/api/environments/prod', { minApprovals: 0 }],
      ['POST', '/api/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' }],
    ] as const) {
      const r = await withToken(token, method, path, body);
      assert.equal(r.status, 403, `${method} ${path}: ${JSON.stringify(r.json)}`);
    }
    assert.equal((await withToken(token, 'GET', '/api/meta')).json.me.role, 'oncall', 'it acts as On call');
    assert.equal((await withToken(token, 'GET', '/api/sign-in-rules')).status, 200, 'it may look');
  }
  assert.equal((await t.as('dana').get('/meta')).json.environments.find((e: { key: string }) => e.key === 'prod').minApprovals, prod.minApprovals, 'unchanged');
  // signed in, the admin lowers it, and raises it back
  assert.equal((await t.as('dana').put('/environments/prod', { minApprovals: 0 })).status, 200);
  assert.equal((await t.as('dana').put('/environments/prod', { minApprovals: prod.minApprovals })).status, 200);
});

test('the sign-in rules: admins change them signed in; everyone may read them', async () => {
  assert.deepEqual((({ breakGlassAdmin, adminsNeedTwoFactor, joinRole }) => ({ breakGlassAdmin, adminsNeedTwoFactor, joinRole }))((await t.as('vera').get('/sign-in-rules')).json),
    { breakGlassAdmin: null, adminsNeedTwoFactor: false, joinRole: 'viewer' });
  assert.equal((await t.as('carol').put('/sign-in-rules', { joinRole: 'editor' })).status, 403, 'admins only');
  assert.equal((await t.as('dana').put('/sign-in-rules', { breakGlassAdmin: 'alice' })).status, 422, 'the break-glass admin is an admin');
  const set = await t.as('dana').put('/sign-in-rules', { breakGlassAdmin: 'dana', joinRole: 'editor' });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.deepEqual([set.json.breakGlassAdmin, set.json.joinRole, set.json.updatedBy], ['dana', 'editor', 'dana']);
  const h = (await t.as('dana').get('/history?type=sign_in.rules')).json;
  assert.ok((Array.isArray(h) ? h : h.rows).length >= 1, 'in History');
  await t.as('dana').put('/sign-in-rules', { breakGlassAdmin: null, joinRole: 'viewer' });
});

test('API keys can expire: shown in the list, refused once expired; without days they work until revoked', async () => {
  const ofrep = (key: string) => t.call('POST', '/ofrep/v1/evaluate/flags', { context: {} }, { authorization: `Bearer ${key}` });
  for (const days of [0, 1.5, 5000, 'soon']) {
    assert.equal((await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all', days })).status, 422, `days: ${days}`);
  }
  const forever = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json;
  assert.equal(forever.expiresAt, null);
  const month = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all', days: 30 })).json;
  const left = (Date.parse(month.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(left > 29.9 && left <= 30, `in 30 days (${left})`);
  const row = (await t.as('alice').get('/api-keys')).json.find((k: { id: number }) => k.id === month.id);
  assert.equal(Date.parse(row.expiresAt), Date.parse(month.expiresAt), 'the list shows when it ends');

  assert.equal((await ofrep(month.key)).status, 200);
  const ended = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all', days: 1 })).json;
  await t.db.query(`update api_key set expires_at = now() - interval '1 minute' where id = $1`, [ended.id]);
  const refused = await ofrep(ended.key);
  assert.equal(refused.status, 401);
  assert.match(JSON.stringify(refused.json), /expired/);
  assert.equal((await ofrep(forever.key)).status, 200);
});
