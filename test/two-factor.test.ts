// Two-factor sign-in for password accounts (server/betterAuth.ts, Better Auth's twoFactor plugin): an authenticator
// app's code after the password, recovery codes that work once, the rule that admins with a password set it up first
// (access.ts needsTwoFactor), a reset link that turns it off, and each sign-in in History and the People list.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { browser, startApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
let ctx: Awaited<ReturnType<typeof startApp>>;
let call: ReturnType<typeof browser>;
before(async () => { ctx = await startApp({ signIn: { kind: 'better-auth', settings: {} } }); call = browser(ctx); });
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
  assert.equal((await call('PUT', '/api/sign-in-rules', { cookie: ann, body: { adminsNeedTwoFactor: true } })).status, 200);

  const m = await meta(bo);
  assert.equal(m.status, 200, 'the console still opens, to ask for it');
  assert.equal(m.json.me.needsTwoFactor, true);
  assert.equal((await call('GET', '/api/flags?environment=dev', { cookie: bo })).status, 403, 'and nothing else');
  assert.equal((await call('GET', '/api/account', { cookie: bo })).status, 200);
  assert.equal((await meta(ann)).json.me.needsTwoFactor, undefined, 'an admin with a second factor works as before');

  const enabled = await call('POST', '/api/auth/two-factor/enable', { cookie: bo, body: { password: PASSWORD } });
  const set = await call('POST', '/api/auth/two-factor/verify-totp', { cookie: bo, body: { code: totp(enabled.json.totpURI) } });
  assert.equal(set.status, 200);
  assert.equal((await call('GET', '/api/flags?environment=dev', { cookie: set.cookie })).status, 200, 'set up: the console works');
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
