// Password resets without email (server/access.ts passwordReset, server/betterAuth.ts): an admin makes a reset link in
// People, it works once, it signs the person out everywhere, and nobody can ask for one by email.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { browser, startApp } from './helpers.ts';
import type { SignIn } from '../server/identity.ts';

const signIn: SignIn = { kind: 'better-auth', settings: {} };
const PASSWORD = 'correct horse battery';
let ctx: Awaited<ReturnType<typeof startApp>>;
let call: ReturnType<typeof browser>;
const cookies = new Map<string, string>();

before(async () => { ctx = await startApp({ signIn }); call = browser(ctx); });
after(async () => { await ctx.stop(); });

// without an invite: the first account, with the setup link the server prints
const signUp = async (email: string, invite?: string) => {
  const r = await call('POST', '/api/auth/sign-up/email', { body: { email, name: email.split('@')[0], password: PASSWORD },
    headers: invite ? { 'x-invite': invite } : { 'x-setup': ctx.setupToken! } });
  if (r.status === 200) cookies.set(email, r.cookie);
  return r;
};
const signInAs = (email: string, password: string) => call('POST', '/api/auth/sign-in/email', { body: { email, password } });
const as = (email: string) => ({
  post: (p: string, body: unknown = {}) => call('POST', `/api${p}`, { cookie: cookies.get(email), body }),
  get: (p: string) => call('GET', `/api${p}`, { cookie: cookies.get(email) }),
});

test('an admin makes a reset link; it sets a new password once and signs the person out everywhere', async () => {
  assert.equal((await signUp('ada@corp.com')).status, 200, 'the first account: the admin');
  const added = await as('ada@corp.com').post('/people', { email: 'bo@corp.com', role: 'editor' });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  assert.equal((await as('ada@corp.com').post('/people/bo@corp.com/password-reset')).status, 409, 'no account yet: an invite, not a reset');
  assert.equal((await signUp('bo@corp.com', added.json.invite)).status, 200);
  const before = cookies.get('bo@corp.com')!;
  assert.equal((await call('GET', '/api/meta', { cookie: before })).status, 200);

  assert.equal((await as('bo@corp.com').post('/people/ada@corp.com/password-reset')).status, 403, 'only admins');
  const made = await as('ada@corp.com').post('/people/bo@corp.com/password-reset');
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const token = made.json.token as string;
  assert.ok(token.length >= 16);

  const reset = await call('POST', '/api/auth/reset-password', { body: { newPassword: 'a brand new password', token } });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal((await call('GET', '/api/meta', { cookie: before })).status, 401, 'signed out everywhere');
  assert.equal((await signInAs('bo@corp.com', PASSWORD)).status, 401, 'the old password is gone');
  assert.equal((await signInAs('bo@corp.com', 'a brand new password')).status, 200);
  assert.notEqual((await call('POST', '/api/auth/reset-password', { body: { newPassword: 'yet another password', token } })).status, 200, 'it works once');

  const history = await as('ada@corp.com').get('/history?kind=person.password_reset');
  assert.ok(JSON.stringify(history.json).includes('person.password_reset'), 'recorded in History');
});

test('nobody can ask for a reset by email, and short passwords are refused', async () => {
  for (const path of ['/api/auth/request-password-reset', '/api/auth/forget-password']) {
    const r = await call('POST', path, { body: { email: 'bo@corp.com', redirectTo: '/' } });
    assert.equal(r.status, 404, `${path}: ${r.status}`);
  }
  const made = await as('ada@corp.com').post('/people/bo@corp.com/password-reset');
  assert.equal((await call('POST', '/api/auth/reset-password', { body: { newPassword: 'short', token: made.json.token } })).status, 400);
  assert.equal((await as('ada@corp.com').post('/people/nobody@corp.com/password-reset')).status, 404);
});
