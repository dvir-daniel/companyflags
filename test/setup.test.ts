// A ready app: it starts empty, people sign in with Better Auth (server/identity.ts, server/betterAuth.ts), the first
// person is the admin, others join with an admin's invite link, and the admin sets up environments, apps and roles
// in Settings before anyone creates flags. Each admission rule on its own: access.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.ts';
import { SetupError } from '../server/betterAuth.ts';
import { signInFromEnv, type SignIn } from '../server/identity.ts';
import { browser, CSRF, startApp, testDatabase } from './helpers.ts';

const signIn: SignIn = { kind: 'better-auth', settings: {} };
const PASSWORD = 'correct horse battery';
const flag = (key: string) => ({
  key, valueType: 'bool', kind: 'ops', variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
  delivery: { dev: ['web'], prod: ['web'] }, base: { enabled: true, defaultVariation: 'on', variationWhenOff: 'off', rules: [] },
});

// A storyline: one new install, from the first account to a flag reaching an app. Each test picks up where the one
// before it left off (the people who signed up, their sessions, the environments), so they run in this order, together.
describe('a new install, start to finish (in order)', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  let call: ReturnType<typeof browser>;
  before(async () => { ctx = await startApp({ signIn }); call = browser(ctx); });
  after(async () => { await ctx.stop(); });

  // each person's session cookie, from their last sign-up or sign-in
  const sessions = new Map<string, string>();
  // the cookie the setup link sets in the browser that opens it
  let setupCookie = '';
  const signUp = async (email: string, o: { invite?: string; name?: string; password?: string; cookie?: string } = {}) => {
    const r = await call('POST', '/api/auth/sign-up/email', {
      body: { email, name: o.name ?? email.split('@')[0], password: o.password ?? PASSWORD },
      headers: o.invite ? { 'x-invite': o.invite } : {},
      ...(o.cookie ? { cookie: o.cookie } : {}),
    });
    if (r.status === 200) sessions.set(email.toLowerCase(), r.cookie);
    return r;
  };
  const signInAs = async (email: string, password = PASSWORD) => {
    const r = await call('POST', '/api/auth/sign-in/email', { body: { email, password } });
    if (r.status === 200) sessions.set(email.toLowerCase(), r.cookie);
    return r;
  };
  const as = async (email: string) => {
    const cookie = sessions.get(email);
    assert.ok(cookie, `${email} has signed in`);
    return {
      get: (p: string) => call('GET', `/api${p}`, { cookie }),
      post: (p: string, b: unknown = {}) => call('POST', `/api${p}`, { cookie, body: b }),
      put: (p: string, b: unknown) => call('PUT', `/api${p}`, { cookie, body: b }),
      del: (p: string) => call('DELETE', `/api${p}`, { cookie, body: {} }),
    };
  };
  const accounts = async (email: string) => (await ctx.db.query(`select 1 from auth_user where email = $1`, [email])).rows.length;

  test('the app starts empty: no environments, apps, people, dimensions, entities or flags', async () => {
    for (const table of ['environment', 'project', 'app_user', 'auth_user', 'dimension', 'entity', 'flag']) {
      assert.equal((await ctx.db.query(`select 1 from ${table}`)).rows.length, 0, table);
    }
    assert.ok((await ctx.db.query(`select 1 from condition_field`)).rows.length > 10, 'the rule attributes are there');
    const page = await call('GET', '/api/sign-in');
    assert.deepEqual(page.json, { kind: 'better-auth', providers: [], firstPerson: false, sso: false }, 'the sign-in page doesn’t say the server is new');
  });

  test('whoever reaches a new server first can’t make the admin account: it takes the setup link the server printed', async () => {
    assert.ok(ctx.setupToken && ctx.setupToken.length >= 30);
    assert.equal(await ctx.needsSetup(), true);
    const first = await signUp('eve@elsewhere.example');
    assert.equal(first.status, 403, 'a sign-up without the setup link');
    assert.match(first.json.message, /invite link/, 'told what anyone without an invite is told');
    assert.equal((await signUp('eve@elsewhere.example', { cookie: 'companyflags.setup=made-up-secret' })).status, 403, 'a made-up setup link');
    assert.equal(await accounts('eve@elsewhere.example'), 0, 'no account was made');

    const wrong = await call('GET', '/api/setup/made-up-secret');
    assert.equal(wrong.status, 404);
    assert.equal(wrong.cookie, '', 'no cookie for a wrong link');
    assert.match(wrong.headers.get('content-type') ?? '', /^text\/html/, 'a page someone can read, not JSON');
    const open = await call('GET', `/api/setup/${ctx.setupToken}`);
    assert.deepEqual([open.status, open.location], [302, '/'], 'the link opens the console');
    assert.match(open.headers.get('set-cookie') ?? '', /HttpOnly/i);
    assert.match(open.headers.get('set-cookie') ?? '', /SameSite=Lax/i);
    setupCookie = open.cookie;
    assert.equal((await call('GET', '/api/sign-in', { cookie: setupCookie })).json.firstPerson, true, 'where the admin account is made');
  });

  test('only a Better Auth session signs someone in', async () => {
    assert.equal((await call('GET', '/api/meta')).status, 401, 'no cookie');
    assert.equal((await call('GET', '/api/meta', { cookie: 'better-auth.session_token=made-up.signature' })).status, 401, 'a made-up session');
    assert.equal((await call('GET', '/api/events')).status, 401, 'the live updates need sign-in too');
    assert.equal((await call('GET', '/api/meta', { headers: { 'x-user': 'lee@corp.com' } })).status, 401, 'the test header means nothing here');
    assert.equal((await ctx.db.query(`select 1 from app_user`)).rows.length, 0, 'nobody was added');
  });

  test('the first person to create an account is the admin; after that, an account needs an invite', async () => {
    const lee = await signUp('Lee@Corp.com', { name: 'Lee Park', cookie: setupCookie });
    assert.equal(lee.status, 200);
    const first = await (await as('lee@corp.com')).get('/meta');
    assert.equal(first.status, 200);
    assert.deepEqual([first.json.me.key, first.json.me.name, first.json.me.role, first.json.signIn], ['lee@corp.com', 'Lee Park', 'admin', 'better-auth']);
    assert.equal((await call('GET', '/api/sign-in', { cookie: setupCookie })).json.firstPerson, false);
    assert.equal((await call('GET', `/api/setup/${ctx.setupToken}`)).status, 404, 'the setup link works once');
    assert.equal(await ctx.needsSetup(), false);
    assert.equal((await signUp('sam@corp.com', { cookie: setupCookie })).status, 403, 'and its cookie makes no second account');

    const uninvited = await signUp('sam@corp.com');
    assert.equal(uninvited.status, 403);
    assert.match(uninvited.json.message, /invite link/);
    assert.equal(await accounts('sam@corp.com'), 0, 'no account was made');

    const admin = await as('lee@corp.com');
    const added = await admin.post('/people', { email: ' Sam@Corp.com ', role: 'viewer' });
    assert.equal(added.status, 201);
    assert.equal(added.json.key, 'sam@corp.com');
    const invite: string = added.json.invite;
    assert.ok(invite.length >= 30);
    assert.deepEqual((await call('POST', '/api/invites', { body: { token: invite } })).json, { email: 'sam@corp.com', name: '' }, 'the link knows who it is for');
    assert.deepEqual((await call('POST', '/api/invites', { body: { token: invite } })).json, { email: 'sam@corp.com', name: '' }, 'asked with the secret in the body, out of access logs');
    assert.equal((await call('POST', '/api/invites', { body: { token: 'not-the-link' } })).status, 404);
    assert.equal((await admin.get('/meta')).json.users.find((u: any) => u.key === 'sam@corp.com').status, 'invited');

    assert.equal((await signUp('sam@corp.com', { invite: 'not-the-link' })).status, 403, 'a wrong link');
    assert.equal((await signUp('eve@corp.com', { invite })).status, 403, 'the link is for one email only');
    assert.equal((await signUp('sam@corp.com', { invite, password: 'short' })).status, 400, 'passwords have at least 10 characters');
    const sam = await signUp('sam@corp.com', { invite, name: 'Sam Lee' });
    assert.equal(sam.status, 200);
    const meta = (await (await as('sam@corp.com')).get('/meta')).json;
    assert.deepEqual([meta.me.key, meta.me.name, meta.me.role], ['sam@corp.com', 'Sam Lee', 'viewer']);
    assert.equal(meta.users.find((u: any) => u.key === 'sam@corp.com').status, 'active');
    assert.equal((await call('POST', '/api/invites', { body: { token: invite } })).status, 404, 'an invite link works once');
    assert.equal((await admin.post('/people/sam@corp.com/invite')).status, 409, 'someone with an account needs no invite');
    assert.equal((await admin.post('/people', { email: 'sam@corp.com' })).status, 409, 'already here');
    assert.equal((await admin.post('/people', { email: 'not an email' })).status, 422);
    assert.equal((await admin.post('/people', { email: 'kim@corp.com', role: 'owner' })).status, 422);
    assert.equal((await (await as('sam@corp.com')).post('/people', { email: 'pal@corp.com' })).status, 403, 'only admins add people');
  });

  test('people sign in with their password and sign out', async () => {
    assert.equal((await signInAs('sam@corp.com', 'wrong password!')).status, 401);
    assert.equal((await signInAs('nobody@corp.com')).status, 401);
    const r = await signInAs('SAM@corp.com');
    assert.equal(r.status, 200);
    const cookie = sessions.get('sam@corp.com')!;
    assert.equal((await call('GET', '/api/meta', { cookie })).json.me.key, 'sam@corp.com');
    assert.equal((await call('POST', '/api/auth/sign-out', { cookie, body: {} })).status, 200);
    assert.equal((await call('GET', '/api/meta', { cookie })).status, 401, 'that session has ended');
    assert.equal((await signInAs('sam@corp.com')).status, 200);
    // from another site, a signed-in browser can't be made to act (Better Auth checks the origin)
    assert.equal((await call('POST', '/api/auth/sign-out', { cookie: sessions.get('sam@corp.com'), body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
  });

  test('nothing can be created before there is an environment', async () => {
    const r = await (await as('lee@corp.com')).post('/flags', flag('too_early'));
    assert.equal(r.status, 422);
    assert.match(r.json.error, /add an environment/);
  });

  test('the admin sets up environments and apps; bad input is refused', async () => {
    const lee = await as('lee@corp.com');
    assert.equal((await lee.post('/environments', { key: 'dev', name: 'Development', minApprovals: 0 })).status, 201);
    assert.equal((await lee.post('/environments', { key: 'prod', name: 'Production', minApprovals: 1 })).status, 201);
    assert.equal((await lee.post('/flag-sets', { key: 'web', kind: 'client' })).status, 201);
    assert.equal((await lee.post('/flag-sets', { key: 'checkout-api', kind: 'server' })).status, 201);
    assert.equal((await lee.post('/environments', { key: 'dev' })).status, 409, 'already there');
    assert.equal((await lee.post('/environments', { key: 'Has Spaces' })).status, 422);
    assert.equal((await lee.post('/environments', { key: 'qa', minApprovals: 9 })).status, 422);
    assert.equal((await lee.post('/flag-sets', { key: 'tv', kind: 'fridge' })).status, 422);
    const meta = (await lee.get('/meta')).json;
    assert.deepEqual(meta.environments.map((e: any) => [e.key, e.name, e.minApprovals]), [['dev', 'Development', 0], ['prod', 'Production', 1]]);
    assert.deepEqual(meta.projects.map((p: any) => p.key), ['web', 'checkout-api']);
    assert.equal((await lee.put('/environments/prod', { name: 'Live', minApprovals: 2 })).json.minApprovals, 2);
    assert.equal((await lee.put('/environments/prod', { name: 'Production', minApprovals: 1 })).status, 200);
  });

  test('the admin says what config is served per (its dimensions) before the first entity', async () => {
    const lee = await as('lee@corp.com');
    assert.deepEqual((await lee.get('/dimensions')).json, [], 'a new install has none: every app gets everyone’s file');
    assert.equal((await lee.post('/dimensions/customer', { key: 'acme', name: 'Acme' })).status, 404, 'no dimension to put it in yet');
    const saved = await lee.put('/dimensions', { dimensions: [{ key: 'customer', singular: 'customer', plural: 'customers' }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json, [{ key: 'customer', singular: 'customer', plural: 'customers', entities: 0, withParent: 0 }]);
    const meta = (await lee.get('/meta')).json;
    assert.deepEqual(meta.dimensions.map((d: any) => d.key), ['customer']);
    const field = meta.fields.find((f: any) => f.name === 'customer');
    assert.deepEqual([field.label, field.comesFrom, field.canSplitBy], ['Customer', 'token', true], 'its attribute, for rules');
    assert.equal(meta.fields.find((f: any) => f.name === 'entity').group, null, 'with one dimension, “exactly this one” is the same attribute');
  });

  test('a change signed in with the session cookie needs the console’s header, from the same site', async () => {
    const cookie = sessions.get('lee@corp.com')!;
    const post = (headers: Record<string, string>) => ctx.app.request('/api/dimensions/customer', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie, ...headers }, body: JSON.stringify({ key: 'csrf-probe', name: 'Probe' }) });
    const without = await post({});
    assert.equal(without.status, 403, 'a form or fetch from another page can’t add the header');
    assert.match(((await without.json()) as { error: string }).error, /x-requested-with/);
    assert.equal((await post({ ...CSRF, 'sec-fetch-site': 'cross-site' })).status, 403, 'nor come from another site');
    assert.equal((await post({ 'x-requested-with': 'XMLHttpRequest' })).status, 403, 'it must be the console’s own value');
    assert.equal((await ctx.db.query(`select 1 from entity where key = 'csrf-probe'`)).rows.length, 0, 'nothing was made');
    assert.equal((await post({ ...CSRF, 'sec-fetch-site': 'same-origin' })).status, 201, 'the console’s own request');
    assert.equal((await call('GET', '/api/meta', { cookie, headers: { 'x-requested-with': '' } })).status, 200, 'reading needs no header');
  });

  test('viewers can look but not change anything; settings are for admins only', async () => {
    const sam = await as('sam@corp.com');
    assert.equal((await sam.get('/flags')).status, 200);
    assert.equal((await sam.post('/flags', flag('by_a_viewer'))).status, 403);
    assert.equal((await sam.post('/dimensions/customer', { key: 'acme', name: 'Acme' })).status, 403);
    assert.equal((await sam.post('/trace', { environment: 'dev', project: 'web', entity: null, attrs: {} })).status, 200, 'trying rules changes nothing');
    const lee = await as('lee@corp.com');
    assert.equal((await lee.put('/people/sam@corp.com', { role: 'editor' })).status, 200);
    assert.equal((await sam.post('/dimensions/customer', { key: 'acme', name: 'Acme' })).status, 201, 'an editor can');
    assert.equal((await sam.post('/environments', { key: 'staging' })).status, 403, 'but not change settings');
    assert.equal((await sam.put('/people/sam@corp.com', { role: 'admin' })).status, 403, 'or give themselves a role');
    assert.equal((await sam.put('/dimensions', { dimensions: [] })).status, 403, 'or the dimensions, which are settings');
  });

  test('an admin removes someone’s access: their sessions end, and only a new invite lets them back in', async () => {
    const lee = await as('lee@corp.com');
    const { invite } = (await lee.post('/people', { email: 'kim@corp.com', name: 'Kim', role: 'editor' })).json;
    assert.equal((await signUp('kim@corp.com', { invite, name: 'Kim Ito' })).status, 200, 'the name they give replaces the admin’s');
    const kim = await as('kim@corp.com');
    assert.equal((await kim.get('/meta')).json.me.role, 'editor', 'the role the admin chose');
    const phone = sessions.get('kim@corp.com')!;
    assert.equal((await signInAs('kim@corp.com')).status, 200, 'and signs in on another device');
    const laptop = sessions.get('kim@corp.com')!;
    assert.notEqual(phone, laptop);

    assert.equal((await (await as('sam@corp.com')).del('/people/kim@corp.com')).status, 403, 'only admins remove people');
    assert.equal((await lee.del('/people/lee@corp.com')).status, 409, 'not yourself');
    assert.equal((await lee.del('/people/kim@corp.com')).status, 200);
    for (const cookie of [phone, laptop]) assert.equal((await call('GET', '/api/meta', { cookie })).status, 401, 'signed out everywhere');
    assert.equal(await accounts('kim@corp.com'), 0, 'their account is gone');
    assert.equal((await signInAs('kim@corp.com')).status, 401);
    const again = await signUp('kim@corp.com');
    assert.equal(again.status, 403);
    assert.match(again.json.message, /removed your access/);
    const users = (await lee.get('/meta')).json.users;
    assert.deepEqual(users.at(-1), { key: 'kim@corp.com', name: 'Kim Ito', role: 'editor', status: 'removed' }, 'still listed (history names them), last');
    assert.equal((await lee.put('/people/kim@corp.com', { role: 'admin' })).status, 409, 'no role without access');

    const back = await lee.post('/people/kim@corp.com/invite');
    assert.equal(back.status, 200);
    assert.equal((await signUp('kim@corp.com', { invite: back.json.invite, password: 'a new password' })).status, 200);
    assert.equal((await (await as('kim@corp.com')).get('/meta')).json.me.role, 'editor', 'back, with their role');

    const h = (await lee.get('/history')).json as any[];
    const types = h.map((x) => `${x.changeType} ${x.changedBy}`);
    for (const t of ['person.add lee@corp.com', 'person.remove lee@corp.com', 'person.invite lee@corp.com']) assert.ok(types.includes(t), t);
  });

  test('there is always an admin', async () => {
    const lee = await as('lee@corp.com');
    const r = await lee.put('/people/lee@corp.com', { role: 'viewer' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /only admin/);
    assert.equal((await lee.put('/people/sam@corp.com', { role: 'admin' })).status, 200);
    assert.equal((await lee.put('/people/lee@corp.com', { role: 'editor' })).status, 200, 'with another admin, yes');
    assert.equal((await lee.put('/people/nobody@corp.com', { role: 'editor' })).status, 403, 'lee is an editor now');
    assert.equal((await (await as('sam@corp.com')).put('/people/nobody@corp.com', { role: 'editor' })).status, 404);
  });

  test('a flag reaches the app; a new environment gives every flag its defaults there, switched off', async () => {
    const sam = await as('sam@corp.com');
    assert.equal((await sam.post('/flags', flag('fast_checkout'))).status, 201);
    await ctx.workers.drain();
    const dev = await call('GET', '/client/v1/flags/dev/web');
    assert.equal(dev.status, 200);
    assert.equal(dev.json.flags.fast_checkout.value, true);

    assert.equal((await sam.post('/environments', { key: 'staging', name: 'Staging' })).status, 201);
    await ctx.workers.drain();
    const f = (await sam.get('/flags/fast_checkout')).json;
    assert.equal(f.layers.staging.base.enabled, false);
    assert.equal(f.layers.staging.base.defaultVariation, f.layers.dev.base.defaultVariation, 'the same default as before');
    assert.deepEqual(f.layers.staging.base.rules, []);
    const staging = await call('GET', '/client/v1/flags/staging/web');
    assert.equal(staging.status, 200, 'its files are served at once');
    assert.ok(!('fast_checkout' in staging.json.flags), 'off there: apps keep the default in their code');
  });

  test('settings changes are in History, with who made them', async () => {
    const h = (await (await as('sam@corp.com')).get('/history')).json as any[];
    const types = h.map((x) => `${x.changeType} ${x.changedBy}`);
    for (const t of ['environment.create lee@corp.com', 'environment.update lee@corp.com', 'app.create lee@corp.com', 'person.role lee@corp.com', 'environment.create sam@corp.com']) {
      assert.ok(types.includes(t), t);
    }
  });
});

test('how people sign in comes from the environment; production needs a secret and the console’s address', async () => {
  const env = signInFromEnv({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's', FF_SIGNUP_DOMAINS: 'corp.com, @Corp.example' });
  assert.equal(env.kind, 'better-auth');
  if (env.kind !== 'better-auth') return;
  assert.deepEqual(env.settings.google, { clientId: 'g', clientSecret: 's' });
  assert.equal(env.settings.github, undefined, 'only providers with both an id and a secret');
  assert.deepEqual(env.settings.signupDomains, ['corp.com', 'corp.example']);
  const internal = signInFromEnv({ BETTER_AUTH_TRUSTED_ORIGINS: 'https://idp.corp.internal, http://10.0.0.5:8080' });
  assert.deepEqual(internal.kind === 'better-auth' && internal.settings.trustedOrigins, ['https://idp.corp.internal', 'http://10.0.0.5:8080']);
  const starting = (settings: object) => startApp({ signIn: { kind: 'better-auth', settings } });
  await assert.rejects(starting({ production: true, baseURL: 'https://flags.example.com' }), SetupError, 'no secret');
  await assert.rejects(starting({ production: true, secret: 'x'.repeat(40) }), SetupError, 'no address');
});

test('a database from before Better Auth: an existing admin makes the first account, everyone else needs an invite', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-upgrade-'));
  const tdb = await testDatabase();
  let old: Awaited<ReturnType<typeof startApp>> | undefined;
  t.after(async () => { await old?.stop(); await tdb.drop(); rmSync(dir, { recursive: true, force: true }); });
  const where = { databaseUrl: tdb.url, dataDir: join(dir, 'data') };
  // before: a sign-in that only names the person (like Cloudflare Access): Ann came first (the admin), then Bo
  const before = await startApp({ ...where, signIn: { kind: 'test-header' } });
  try {
    const call = browser(before);
    const header = (email: string) => ({ 'x-user': email });
    assert.equal((await call('GET', '/api/meta', { headers: header('ann@corp.com') })).json.me.role, 'admin');
    assert.equal((await call('GET', '/api/meta', { headers: header('bo@corp.com') })).json.me.role, 'viewer');
    assert.equal((await call('PUT', '/api/people/bo@corp.com', { body: { role: 'editor' }, headers: header('ann@corp.com') })).status, 200);
  } finally {
    await before.stop();
  }
  old = await startApp({ ...where, signIn });
  const call = browser(old);
  const setup = { 'x-setup': old.setupToken! };
  const up = (email: string, headers: Record<string, string> = {}) => call('POST', '/api/auth/sign-up/email', {
    body: { email, name: email.split('@')[0], password: PASSWORD }, headers });
  assert.equal((await call('GET', '/api/sign-in', { headers: setup })).json.firstPerson, true, 'nobody has an account yet');
  assert.equal((await up('bo@corp.com', setup)).status, 403, 'not an admin');
  assert.equal((await up('new@corp.com', setup)).status, 403, 'not anyone at all');
  assert.equal((await up('ann@corp.com')).status, 403, 'not even the admin, without the setup link');
  const ann = await up('ann@corp.com', setup);
  assert.equal(ann.status, 200);
  const meta = (await call('GET', '/api/meta', { cookie: ann.cookie })).json;
  assert.equal(meta.me.role, 'admin', 'the role they had');
  assert.deepEqual(meta.users.map((u: any) => [u.key, u.status]), [['ann@corp.com', 'active'], ['bo@corp.com', 'no_account']]);
  assert.equal((await call('GET', '/api/sign-in')).json.firstPerson, false);
  const link = await call('POST', '/api/people/bo@corp.com/invite', { cookie: ann.cookie, body: {} });
  assert.equal(link.status, 200);
  assert.equal((await up('bo@corp.com', { 'x-invite': link.json.invite })).status, 200);
  assert.equal((await call('GET', '/api/meta', { cookie: ann.cookie })).json.users[1].role, 'editor', 'and theirs');
});

test('sessions outlive a restart: the cookie secret is kept with the data', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-signin-'));
  const tdb = await testDatabase();
  const opts = { databaseUrl: tdb.url, dataDir: join(dir, 'data'), signIn };
  type App = Awaited<ReturnType<typeof createApp>>;
  const open = new Set<App>();
  const start = async () => { const a = await createApp(opts); open.add(a); return a; };
  const stop = async (a: App) => { open.delete(a); await a.workers.stop(); await a.db.close(); };
  t.after(async () => {
    for (const a of [...open]) await stop(a);
    await tdb.drop();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = await start();
  const r = await browser(first)('POST', '/api/auth/sign-up/email', { body: { email: 'ops@corp.com', name: 'Ops', password: PASSWORD }, headers: { 'x-setup': first.setupToken! } });
  assert.equal(r.status, 200);
  await stop(first);
  const second = await start();
  assert.equal(second.setupToken, first.setupToken, 'the same setup link after a restart (and on every server on the database)');
  const meta = await browser(second)('GET', '/api/meta', { cookie: r.cookie });
  assert.equal(meta.status, 200);
  assert.deepEqual([meta.json.me.key, meta.json.me.role], ['ops@corp.com', 'admin']);
});
