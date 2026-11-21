// Two-factor sign-in for password accounts (server/accounts.ts, the sign-in's twoFactor plugin): an authenticator
// app's code after the password, recovery codes that work once, the rule that admins with a password set it up first
// (access.ts needsTwoFactor), a reset link that turns it off, and each sign-in in History and the People list.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { browser, startApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
let ctx: Awaited<ReturnType<typeof startApp>>;
let call: ReturnType<typeof browser>;
before(async () => { ctx = await startApp({ signIn: { kind: 'accounts', settings: {} } }); call = browser(ctx); });
after(async () => { await ctx.stop(); });

/** An authenticator app's code now, for an otpauth:// address's secret (RFC 6238: base32, HMAC-SHA1, 30 seconds). */
function totp(uri: string, at = Date.now()) {
  const secret = new URL(uri).searchParams.get('secret')!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1] & 15;
  return String(((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

const signIn = (email: string) => call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
const meta = (cookie: string) => call('GET', '/api/meta', { cookie });
const history = async (cookie: string, type: string) => {
  const h = (await call('GET', `/api/history?type=${type}`, { cookie })).json;
  return (Array.isArray(h) ? h : h.rows) as { changeType: string; changedBy: string; after: { person: string; with: string; why?: string } }[];
};

const RESOURCE = 'http://localhost/mcp';
const REDIRECT = 'http://127.0.0.1:33418/callback';
/** An MCP client signed in over OAuth (oauth.ts) as the person with this session: its client ID, the authorize
 *  address's query, and the token answer. */
async function oauthSignIn(cookie: string) {
  const client = (await call('POST', '/oauth/register', { body: { client_name: 'Claude Code', redirect_uris: [REDIRECT] } })).json.client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const q = { client_id: client, redirect_uri: REDIRECT, response_type: 'code', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: RESOURCE };
  const query = new URLSearchParams(q).toString();
  const allowed = await call('POST', '/oauth/authorize', { cookie, form: { ...q, role: 'editor', answer: 'allow' } });
  const code = new URL(allowed.location ?? 'http://x/').searchParams.get('code') ?? '';
  const tokens = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: client, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE } });
  return { client, query, tokens };
}

let uri = '';
let recovery: string[] = [];

test('an admin sets up two-factor sign-in; then a password alone doesn’t sign them in, the code does', async () => {
  const first = await call('POST', '/api/auth/sign-up/email', { body: { email: 'ann@acme.example', name: 'Ann', password: PASSWORD }, headers: { 'x-setup': ctx.setupToken! } });
  assert.equal(first.status, 200);
  let cookie = first.cookie;
  assert.deepEqual((await call('GET', '/api/account', { cookie })).json, { password: true, twoFactor: false });

  assert.equal((await call('POST', '/api/auth/two-factor/enable', { cookie, body: { password: 'wrong password!!' } })).status, 400, 'with the password');
  const enabled = await call('POST', '/api/auth/two-factor/enable', { cookie, body: { password: PASSWORD } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
  uri = enabled.json.totpURI;
  recovery = enabled.json.backupCodes;
  assert.match(uri, /^otpauth:\/\/totp\/CompanyFlags:ann%40acme\.example\?/);
  assert.equal(recovery.length, 10);
  assert.equal((await call('GET', '/api/account', { cookie })).json.twoFactor, false, 'not until a code from the app works');
  const verified = await call('POST', '/api/auth/two-factor/verify-totp', { cookie, body: { code: totp(uri) } });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  cookie = verified.cookie || cookie;
  assert.equal((await call('GET', '/api/account', { cookie })).json.twoFactor, true);
  const secrets = (await ctx.db.query<{ secret: string; backup_codes: string }>(`select secret, backup_codes from auth_two_factor`)).rows[0];
  assert.ok(!uri.includes(secrets.secret) && !recovery.some((c) => secrets.backup_codes.includes(c)), 'kept encrypted');

  const pending = await signIn('ann@acme.example');
  assert.equal(pending.status, 200);
  assert.equal(pending.json.twoFactorRedirect, true, 'the password alone asks for the code');
  assert.equal(pending.cookie.includes('session_token'), false, 'no session yet');
  const wrong = await call('POST', '/api/auth/two-factor/verify-totp', { cookie: pending.cookie, body: { code: '000000' === totp(uri) ? '111111' : '000000' } });
  assert.equal(wrong.status, 401);
  const done = await call('POST', '/api/auth/two-factor/verify-totp', { cookie: pending.cookie, body: { code: totp(uri) } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await meta(done.cookie)).json.me.key, 'ann@acme.example');

  const signIns = (await history(done.cookie, 'sign_in')).filter((r) => r.changeType === 'sign_in');
  assert.deepEqual(signIns.map((r) => r.after.with), ['two-factor', 'password'], 'the account made, then the code: not the password step alone, nor setting it up');
  const failed = await history(done.cookie, 'sign_in.failed');
  assert.ok(failed.some((r) => r.after.person === 'ann@acme.example' && r.after.with === 'two-factor'), 'a wrong code is in History');
  const listed = (await meta(done.cookie)).json.users.find((u: { key: string }) => u.key === 'ann@acme.example');
  assert.ok(listed.lastSignedInAt, 'the People list says when they last signed in');
});

test('a recovery code signs in once', async () => {
  const pending = await signIn('ann@acme.example');
  const ok = await call('POST', '/api/auth/two-factor/verify-backup-code', { cookie: pending.cookie, body: { code: recovery[0] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await meta(ok.cookie)).status, 200);
  const again = await signIn('ann@acme.example');
  assert.notEqual((await call('POST', '/api/auth/two-factor/verify-backup-code', { cookie: again.cookie, body: { code: recovery[0] } })).status, 200, 'used up');
});

test('the rules can ask admins with a password to set up two-factor first: until then, the console refuses them', async () => {
  const pending = await signIn('ann@acme.example');
  const ann = (await call('POST', '/api/auth/two-factor/verify-totp', { cookie: pending.cookie, body: { code: totp(uri) } })).cookie;
  const added = await call('POST', '/api/people', { cookie: ann, body: { email: 'bo@acme.example', role: 'admin' } });
  const bo = (await call('POST', '/api/auth/sign-up/email', { headers: { 'x-invite': added.json.invite }, body: { email: 'bo@acme.example', name: 'Bo', password: PASSWORD } })).cookie;
  // bo has no second factor: he can't be the one to ask it of admins
  assert.equal((await call('PUT', '/api/sign-in-rules', { cookie: bo, body: { adminsNeedTwoFactor: true } })).status, 409);
  // before the rule: bo makes an access token, and signs an MCP client in over OAuth
  const made = await call('POST', '/api/tokens', { cookie: bo, body: { name: 'CI', role: 'editor' } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const token = made.json.token as string;
  const viaToken = (path: string) => ctx.app.request(path, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await viaToken('/api/flags?environment=dev')).status, 200);
  const oauth = await oauthSignIn(bo);
  assert.equal(oauth.tokens.status, 200, JSON.stringify(oauth.tokens.json));
  assert.equal((await call('PUT', '/api/sign-in-rules', { cookie: ann, body: { adminsNeedTwoFactor: true } })).status, 200);

  const m = await meta(bo);
  assert.equal(m.status, 200, 'the console still opens, to ask for it');
  assert.equal(m.json.me.needsTwoFactor, true);
  assert.equal((await call('GET', '/api/flags?environment=dev', { cookie: bo })).status, 403, 'and nothing else');
  assert.equal((await call('GET', '/api/account', { cookie: bo })).status, 200);
  assert.equal((await meta(ann)).json.me.needsTwoFactor, undefined, 'an admin with a second factor works as before');
  // nor around it: his token made before, his OAuth client's refresh, a new client
  assert.equal((await viaToken('/api/flags?environment=dev')).status, 403, 'a token made before waits for it too');
  const renewed = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', client_id: oauth.client, refresh_token: oauth.tokens.json.refresh_token, resource: RESOURCE } });
  assert.equal(renewed.json.error, 'invalid_grant', 'an OAuth sign-in isn’t renewed');
  assert.match(renewed.json.error_description, /two-factor/);
  const asked = await call('GET', `/oauth/authorize?${oauth.query}`, { cookie: bo });
  assert.equal(asked.status, 403, 'a new client isn’t allowed');
  assert.match(String(asked.json), /Set up two-factor sign-in first/);

  const enabled = await call('POST', '/api/auth/two-factor/enable', { cookie: bo, body: { password: PASSWORD } });
  const set = await call('POST', '/api/auth/two-factor/verify-totp', { cookie: bo, body: { code: totp(enabled.json.totpURI) } });
  assert.equal(set.status, 200);
  assert.equal((await call('GET', '/api/flags?environment=dev', { cookie: set.cookie })).status, 200, 'set up: the console works');
  assert.equal((await viaToken('/api/flags?environment=dev')).status, 200, 'and his token');
});

test('a password reset link turns two-factor off, for someone who lost their authenticator', async () => {
  const pending = await signIn('ann@acme.example');
  const ann = (await call('POST', '/api/auth/two-factor/verify-totp', { cookie: pending.cookie, body: { code: totp(uri) } })).cookie;
  const { token } = (await call('POST', '/api/people/bo@acme.example/password-reset', { cookie: ann, body: {} })).json;
  assert.equal((await call('POST', '/api/auth/reset-password', { body: { newPassword: 'a brand new password', token } })).status, 200);
  const bo = await call('POST', '/api/auth/sign-in/email', { body: { email: 'bo@acme.example', password: 'a brand new password' } });
  assert.equal(bo.status, 200);
  assert.ok(bo.cookie.includes('session_token'), 'signed in with the password alone');
  assert.equal((await meta(bo.cookie)).json.me.needsTwoFactor, true, 'and asked to set it up again');
});
