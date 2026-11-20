// OAuth sign-in for MCP clients (server/oauth.ts): discovery, registration, the authorize page with PKCE (signed in
// with the test sign-in), the code for tokens, the token on /mcp as an agent, refresh and revoke.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const BASE = 'http://localhost';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';

const req = async (method: string, path: string, o: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) => {
  const res = await t.app.request(path, {
    method,
    headers: {
      ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...o.headers,
    },
    body: o.json !== undefined ? JSON.stringify(o.json) : o.form ? new URLSearchParams(o.form).toString() : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, headers: res.headers, json, text, location: res.headers.get('location') };
};
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const register = async (name = 'Claude Code') =>
  (await req('POST', '/oauth/register', { json: { client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } })).json.client_id as string;

/** The browser part: the authorize page for `user`, then Allow with `role`. The code, and the state it came back with. */
async function authorize(clientId: string, challenge: string, o: { user?: string; role?: string; answer?: string; redirect?: string } = {}) {
  const q = { client_id: clientId, redirect_uri: o.redirect ?? REDIRECT, response_type: 'code', state: 'st-1', code_challenge: challenge,
    code_challenge_method: 'S256', resource: RESOURCE };
  const shown = await req('GET', `/oauth/authorize?${new URLSearchParams(q)}`, { headers: { 'x-user': o.user ?? 'alice' } });
  assert.equal(shown.status, 200, shown.text);
  const answer = await req('POST', '/oauth/authorize', { form: { ...q, role: o.role ?? 'editor', answer: o.answer ?? 'allow' },
    headers: { 'x-user': o.user ?? 'alice', origin: BASE } });
  assert.equal(answer.status, 302, answer.text);
  const to = new URL(answer.location!);
  return { page: shown.text, to, code: to.searchParams.get('code')!, state: to.searchParams.get('state') };
}
const exchange = (clientId: string, code: string, verifier: string) =>
  req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE } });
const mcp = (token: string | null, method = 'tools/list') => req('POST', '/mcp', {
  json: { jsonrpc: '2.0', id: 1, method, params: {} }, headers: token ? { authorization: `Bearer ${token}` } : {},
});

test('without a token, /mcp says where to sign in; the discovery documents', async () => {
  const none = await mcp(null);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  const bad = await mcp('cfp_madeup');
  assert.match(bad.headers.get('www-authenticate') ?? '', /resource_metadata=".*", error="invalid_token"/);

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const prm = await req('GET', path);
    assert.equal(prm.status, 200);
    assert.equal(prm.json.resource, RESOURCE);
    assert.deepEqual(prm.json.authorization_servers, [BASE]);
    assert.equal(prm.headers.get('access-control-allow-origin'), '*');
  }
  const as = (await req('GET', '/.well-known/oauth-authorization-server')).json;
  assert.equal(as.issuer, BASE);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
  assert.equal(as.authorization_endpoint, `${BASE}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${BASE}/oauth/token`);
  assert.equal(as.revocation_endpoint, `${BASE}/oauth/revoke`);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  assert.equal((await req('GET', '/.well-known/nothing')).status, 404);
});

test('registration: public clients, with redirect URIs that are https, this computer or an app’s own scheme', async () => {
  const ok = await req('POST', '/oauth/register', { json: { client_name: 'Cursor', redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback', 'https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_post' } });
  assert.equal(ok.status, 201, ok.text);
  assert.match(ok.json.client_id, /^cfc_/);
  assert.equal(ok.json.token_endpoint_auth_method, 'none');
  assert.equal(ok.json.client_secret, undefined);
  for (const uris of [[], ['http://evil.example/cb'], ['javascript:alert(1)'], ['https://x.example/cb#frag'], 'nope']) {
    assert.equal((await req('POST', '/oauth/register', { json: { redirect_uris: uris } })).status, 400, JSON.stringify(uris));
  }
});

test('the whole sign-in: authorize with PKCE, the code for tokens, the token on /mcp as an agent', async () => {
  const client = await register();
  const { verifier, challenge } = pkce();
  // signed out: off to the console's sign-in, and back after it
  const q = new URLSearchParams({ client_id: client, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE });
  const out = await req('GET', `/oauth/authorize?${q}`);
  assert.equal(out.status, 302);
  assert.equal(out.location, '/');
  const pending = out.headers.getSetCookie().find((x) => x.startsWith('companyflags.oauth='))!.split(';')[0];
  const back = await req('GET', '/', { headers: { cookie: pending, 'x-user': 'alice' } });
  assert.equal(back.status, 302);
  assert.equal(back.location, `/oauth/authorize?${q}`);

  const a = await authorize(client, challenge);
  assert.match(a.page, /Allow Claude Code\?/);
  assert.match(a.page, /127\.0\.0\.1:33418/, 'the page says where the code goes');
  assert.match(a.page, /value="viewer"/);
  assert.equal(a.to.origin + a.to.pathname, REDIRECT);
  assert.equal(a.state, 'st-1');
  assert.equal(a.to.searchParams.get('iss'), BASE);

  const tok = await exchange(client, a.code, verifier);
  assert.equal(tok.status, 200, tok.text);
  assert.equal(tok.json.token_type, 'Bearer');
  assert.match(tok.json.access_token, /^cfp_/);
  assert.match(tok.json.refresh_token, /^cfr_/);
  assert.equal(tok.headers.get('cache-control'), 'no-store');

  const tools = await mcp(tok.json.access_token);
  assert.equal(tools.status, 200);
  assert.ok(tools.json.result.tools.some((x: { name: string }) => x.name === 'list_flags'));

  // on alice's Access tokens page, as an agent's Editor token; kept hashed
  const list = (await t.as('alice').get('/tokens')).json as { name: string; role: string; agent: boolean; prefix: string }[];
  const row = list.find((x) => x.name === 'Claude Code (OAuth)')!;
  assert.deepEqual([row.role, row.agent], ['editor', true]);
  assert.ok(tok.json.access_token.startsWith(row.prefix));
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const stored = await t.db.query<{ raw: number; hashed: number }>(`select count(*) filter (where t.token_hash = $1)::int as raw,
      count(*) filter (where t.token_hash = $2 and g.refresh_hash = $3)::int as hashed
    from access_token t join oauth_grant g on g.token_id = t.id`, [tok.json.access_token, sha(tok.json.access_token), sha(tok.json.refresh_token)]);
  assert.deepEqual(stored.rows[0], { raw: 0, hashed: 1 }, 'kept hashed, never raw');

  // what it changes is recorded as an agent's, under alice's name
  const changed = await req('PUT', '/api/flags/max_upload_mb/meta', { json: { description: 'Set over OAuth' }, headers: { authorization: `Bearer ${tok.json.access_token}` } });
  assert.equal(changed.status, 200, changed.text);
  const h = (await t.as('alice').get('/history?flag=max_upload_mb')).json;
  const entry = (Array.isArray(h) ? h : h.rows).find((r: { changeType: string }) => r.changeType === 'flag.update');
  assert.deepEqual([entry.changedBy, entry.actorType], ['alice', 'agent']);
});

test('a wrong code_verifier, a used code, a wrong resource or client are refused', async () => {
  const client = await register();
  const { verifier, challenge } = pkce();
  const a = await authorize(client, challenge);
  const wrong = await exchange(client, a.code, pkce().verifier);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, 'invalid_grant');
  assert.equal((await exchange(client, a.code, verifier)).json.error, 'invalid_grant', 'a code is tried once');

  const b = await authorize(client, challenge);
  const other = await register('Other');
  assert.equal((await exchange(other, b.code, verifier)).json.error, 'invalid_grant', 'another client’s code');
  const ok = await exchange(client, b.code, verifier);
  assert.equal(ok.status, 200);
  const again = await exchange(client, b.code, verifier);
  assert.equal(again.json.error, 'invalid_grant');
  assert.equal((await mcp(ok.json.access_token)).status, 401, 'a code used twice revokes the token it gave');

  const c = await authorize(client, challenge);
  const elsewhere = await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: client, code: c.code, code_verifier: verifier, redirect_uri: REDIRECT, resource: 'https://other.example/mcp' } });
  assert.equal(elsewhere.json.error, 'invalid_target');
  assert.equal((await req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: 'cfc_nope', code: c.code, code_verifier: verifier } })).status, 401);
});

test('the authorize page: no PKCE or plain PKCE goes back as an error, an unknown redirect is never followed, Deny', async () => {
  const client = await register();
  const base = { client_id: client, redirect_uri: REDIRECT, response_type: 'code', state: 's' };
  const noPkce = await req('GET', `/oauth/authorize?${new URLSearchParams(base)}`, { headers: { 'x-user': 'alice' } });
  assert.equal(new URL(noPkce.location!).searchParams.get('error'), 'invalid_request');
  const plain = await req('GET', `/oauth/authorize?${new URLSearchParams({ ...base, code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' })}`, { headers: { 'x-user': 'alice' } });
  assert.equal(new URL(plain.location!).searchParams.get('error'), 'invalid_request');
  const evil = await req('GET', `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: 'https://evil.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`, { headers: { 'x-user': 'alice' } });
  assert.equal(evil.status, 400);
  assert.equal(evil.location, null);
  // a loopback redirect on another port is the same app (RFC 8252)
  const { challenge } = pkce();
  const port = await authorize(client, challenge, { redirect: 'http://127.0.0.1:50999/callback' });
  assert.equal(port.to.port, '50999');
  const denied = await authorize(client, challenge, { answer: 'deny' });
  assert.equal(denied.to.searchParams.get('error'), 'access_denied');
  assert.equal(denied.code, null);
  // the answer comes from this server's page only
  const forged = await req('POST', '/oauth/authorize', { form: { ...base, code_challenge: challenge, code_challenge_method: 'S256', role: 'editor', answer: 'allow' },
    headers: { 'x-user': 'alice', origin: 'https://evil.example' } });
  assert.equal(forged.status, 403);
  // never above an agent: Viewer or Editor only
  const tooHigh = await req('POST', '/oauth/authorize', { form: { ...base, code_challenge: challenge, code_challenge_method: 'S256', role: 'admin', answer: 'allow' },
    headers: { 'x-user': 'dana', origin: BASE } });
  assert.equal(tooHigh.status, 400);
});

test('Viewer: reads, never changes', async () => {
  const client = await register('Read only');
  const { verifier, challenge } = pkce();
  const tok = (await exchange(client, (await authorize(client, challenge, { role: 'viewer' })).code, verifier)).json;
  assert.equal((await mcp(tok.access_token)).status, 200);
  const changed = await req('PUT', '/api/flags/max_upload_mb/meta', { json: { description: 'no' }, headers: { authorization: `Bearer ${tok.access_token}` } });
  assert.equal(changed.status, 403);
});

test('refresh: new tokens in the same row, each refresh token once; an old one back ends the sign-in', async () => {
  const client = await register('VS Code');
  const { verifier, challenge } = pkce();
  const first = (await exchange(client, (await authorize(client, challenge)).code, verifier)).json;
  const refresh = (token: string) => req('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: client, refresh_token: token, resource: RESOURCE } });
  const second = await refresh(first.refresh_token);
  assert.equal(second.status, 200, second.text);
  assert.notEqual(second.json.access_token, first.access_token);
  assert.notEqual(second.json.refresh_token, first.refresh_token);
  assert.equal((await mcp(first.access_token)).status, 401, 'the old access token stops');
  assert.equal((await mcp(second.json.access_token)).status, 200);
  const rows = (await t.as('alice').get('/tokens')).json.filter((x: { name: string }) => x.name === 'VS Code (OAuth)');
  assert.equal(rows.length, 1, 'one row on the Access tokens page');

  const replay = await refresh(first.refresh_token);
  assert.equal(replay.json.error, 'invalid_grant');
  assert.equal((await mcp(second.json.access_token)).status, 401, 'an old refresh token back revokes the sign-in');
  assert.equal((await refresh(second.json.refresh_token)).json.error, 'invalid_grant');
});

test('revoke: at /oauth/revoke, or on the Access tokens page', async () => {
  const client = await register('Revoked');
  const { verifier, challenge } = pkce();
  const one = (await exchange(client, (await authorize(client, challenge)).code, verifier)).json;
  const r = await req('POST', '/oauth/revoke', { form: { token: one.refresh_token, client_id: client } });
  assert.equal(r.status, 200);
  assert.equal((await mcp(one.access_token)).status, 401);
  assert.equal((await req('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: client, refresh_token: one.refresh_token } })).json.error, 'invalid_grant');
  assert.equal((await req('POST', '/oauth/revoke', { form: { token: 'cfp_unknown' } })).status, 200);

  const two = (await exchange(client, (await authorize(client, challenge)).code, verifier)).json;
  const row = (await t.as('alice').get('/tokens')).json.find((x: { prefix: string }) => two.access_token.startsWith(x.prefix));
  assert.equal((await t.as('alice').del(`/tokens/${row.id}`)).status, 200);
  assert.equal((await mcp(two.access_token)).status, 401);
  assert.equal((await req('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: client, refresh_token: two.refresh_token } })).json.error, 'invalid_grant');
});
