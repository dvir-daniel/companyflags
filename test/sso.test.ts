// Single sign-on (server/sso.ts): an admin adds an OIDC connection for the company's domains, people there sign in
// with the identity provider and join as viewers, a connection can require single sign-on, and only admins manage
// connections. The identity provider is a small fake one served by this test (discovery, authorize, token, JWKS), read
// over the network as in production; an app can also be handed identity providers' settings through the discovery
// adapter (sso.ts Discover), so adding a connection needs no network.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import * as samlify from 'samlify';
import type { lookup as dnsLookup } from 'node:dns';
import { discoverOverHttp, isPublicAddress, readIdpMetadata } from '../server/sso.ts';
import type { AppOptions } from '../server/index.ts';
import { browser, startApp } from './helpers.ts';

// ---------------------------------------------------------------- the identity provider
type IdpUser = { sub: string; email: string; name: string; email_verified?: boolean; groups?: string[] };
let idp: Server;
let IDP = '';
let key: CryptoKey;
let jwk: Record<string, unknown>;
let signingInAs: IdpUser = { sub: 'u1', email: 'pat@corp.example', name: 'Pat' };
const codes = new Map<string, { user: IdpUser; nonce?: string; clientId: string }>();

// What the discovery adapter (sso.ts Discover) reads, by address, for an app handed it: an identity provider's
// settings. Anything else can't be reached, as with a wrong issuer address.
const settingsAt = new Map<string, unknown>();
const discover = async (url: string) => {
  if (!settingsAt.has(url)) throw new Error('getaddrinfo ENOTFOUND');
  return settingsAt.get(url);
};

async function idpHandler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url!, IDP);
  const json = (v: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.pathname === '/.well-known/openid-configuration') {
    return json({
      issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, jwks_uri: `${IDP}/jwks`,
      userinfo_endpoint: `${IDP}/userinfo`, token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (url.pathname === '/jwks') return json({ keys: [jwk] });
  if (url.pathname === '/authorize') {
    // the person signs in here; the provider sends them back with a one-time code
    const code = `code-${codes.size + 1}`;
    codes.set(code, { user: signingInAs, nonce: url.searchParams.get('nonce') ?? undefined, clientId: url.searchParams.get('client_id')! });
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state')!);
    res.writeHead(302, { location: back.toString() }); return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const basic = req.headers.authorization?.replace(/^Basic /, '');
    const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [form.get('client_id'), form.get('client_secret')];
    const grant = codes.get(form.get('code') ?? '');
    if (!grant || id !== 'console-app' || secret !== 'idp-secret' || grant.clientId !== id) return json({ error: 'invalid_grant' }, 400);
    codes.delete(form.get('code')!);
    const { user, nonce } = grant;
    const idToken = await new SignJWT({ email: user.email, email_verified: user.email_verified ?? true, name: user.name, ...(user.groups ? { groups: user.groups } : {}), ...(nonce ? { nonce } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(IDP).setAudience(id).setSubject(user.sub).setIssuedAt().setExpirationTime('5m').sign(key);
    return json({ access_token: `at-${user.sub}`, token_type: 'Bearer', expires_in: 300, id_token: idToken });
  }
  if (url.pathname === '/userinfo') {
    const user = [...codes.values()][0]?.user ?? signingInAs;
    return json({ sub: user.sub, email: user.email, email_verified: user.email_verified ?? true, name: user.name, ...(user.groups ? { groups: user.groups } : {}) });
  }
  json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------- the app
const ORIGIN = 'http://localhost';
const PASSWORD = 'correct horse battery';
// a trusted address where nothing listens: what an unreachable identity provider looks like
const DEAD = 'http://127.0.0.1:1';

type App = Awaited<ReturnType<typeof startApp>>;
/** A new app whose first account, ann@corp.example, is the admin; admin() signs her in again (a new session). */
async function appWithAdmin(opts: Pick<AppOptions, 'discover'> = {}) {
  // the fake provider is on this machine: Better Auth only talks to private addresses it is told to trust
  const ctx = await startApp({ signIn: { kind: 'better-auth', settings: { trustedOrigins: [IDP, DEAD] } }, ...opts });
  const call = browser(ctx, ORIGIN);
  const first = await call('POST', '/api/auth/sign-up/email', { body: { email: 'ann@corp.example', name: 'Ann', password: PASSWORD },
    headers: { 'x-setup': ctx.setupToken! } });
  assert.equal(first.status, 200);
  const admin = async () => {
    const r = await call('POST', '/api/auth/sign-in/email', { body: { email: 'ann@corp.example', password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.cookie;
  };
  return { ctx, call, admin };
}

before(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = createServer((req, res) => { idpHandler(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }); });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  IDP = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});
after(() => { idp.close(); });

test('a public address is one on the public internet', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(a), true, a);
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::',
    'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) assert.equal(isPublicAddress(a), false, a);
});

// A storyline: one company's OIDC connection, from adding it to removing it. Each test picks up where the one before
// left off (the connection, who signed in with it, requiring single sign-on), so they run in this order, together.
describe('OIDC, start to finish (in order)', () => {
  let app: Awaited<ReturnType<typeof appWithAdmin>>;
  let ctx: App;
  let call: ReturnType<typeof browser>;
  before(async () => { app = await appWithAdmin(); ctx = app.ctx; call = app.call; });
  after(async () => { await ctx.stop(); });

  /** A whole single sign-on round trip, as a browser makes it: start, the provider, back to the console. */
  async function signInWithSso(email: string, as: IdpUser) {
    signingInAs = as;
    const start = await call('POST', '/api/auth/sign-in/sso', { body: { email, callbackURL: '/', errorCallbackURL: '/' } });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    const atIdp = await fetch(start.json.url, { redirect: 'manual' });
    const back = new URL(atIdp.headers.get('location')!);
    const done = await call('GET', `${back.pathname}${back.search}`, { cookie: start.cookie });
    return { status: done.status, location: done.location ?? '', cookie: done.cookie };
  }
  const meta = (cookie: string) => call('GET', '/api/meta', { cookie });
  const okta = () => ({ type: 'oidc', id: 'okta', issuer: IDP, clientId: 'console-app', clientSecret: 'idp-secret', domains: 'corp.example, @Corp-Labs.example' });

  test('only admins add connections, through the console (Better Auth’s own endpoints are off)', async () => {
    const admin = await app.admin();
    assert.equal((await call('POST', '/api/auth/sso/register', { cookie: admin, body: { providerId: 'x', issuer: IDP, domain: 'corp.example' } })).status, 404);
    assert.equal((await call('POST', '/api/sso', { body: okta() })).status, 401, 'signed in');
    assert.equal((await call('POST', '/api/sso', { cookie: admin, body: { ...okta(), id: 'Has Spaces' } })).status, 422);
    assert.equal((await call('POST', '/api/sso', { cookie: admin, body: { ...okta(), domains: 'not a domain' } })).status, 422);

    const added = await call('POST', '/api/sso', { cookie: admin, body: okta() });
    assert.equal(added.status, 201, JSON.stringify(added.json));
    assert.deepEqual([added.json.id, added.json.type, added.json.domains, added.json.clientId], ['okta', 'oidc', ['corp.example', 'corp-labs.example'], 'console-app']);
    assert.equal(added.json.serviceProvider.oidcRedirectUri, 'http://localhost/api/auth/sso/callback/okta', 'what the provider’s admin enters');
    assert.ok(!JSON.stringify((await call('GET', '/api/sso', { cookie: admin })).json).includes('idp-secret'), 'the secret never leaves the server');
    assert.equal((await call('POST', '/api/sso', { cookie: admin, body: { ...okta(), id: 'okta2', domains: 'corp.example' } })).status, 409, 'one connection per domain');
    assert.equal((await call('GET', '/api/sign-in')).json.sso, true, 'the sign-in page offers single sign-on');
  });

  test('a connection is edited in place; it can’t be required before anyone has signed in with it', async () => {
    const admin = await app.admin();
    const put = (body: unknown) => call('PUT', '/api/sso/okta', { cookie: admin, body });
    const early = await put({ requireSso: true });
    assert.equal(early.status, 409, 'not tested yet');
    assert.match(early.json.error ?? early.json.message, /Test sign-in/);
    assert.equal((await call('POST', '/api/sso', { cookie: admin, body: { ...okta(), id: 'okta3', domains: 'corp-eu.example', requireSso: true } })).status, 409, 'nor when it is added');

    const edited = await put({ domains: 'corp.example, corp-labs.example, corp-eu.example', clientSecret: 'idp-secret' });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.deepEqual(edited.json.domains, ['corp.example', 'corp-labs.example', 'corp-eu.example']);
    assert.equal(edited.json.lastSignInAt, null);
    assert.equal((await put({ domains: 'not a domain' })).status, 422);
    assert.equal((await put({ type: 'saml' })).status, 422, 'the protocol stays');
    assert.equal((await put({ groupRoles: { claim: 'groups', roles: { admins: 'owner' } } })).status, 422, 'a group’s role is a role');
    assert.equal((await put({ domains: 'corp.example, corp-labs.example' })).status, 200);
    const config = JSON.parse((await ctx.db.query<{ c: string }>(`select oidc_config as c from sso_provider where provider_id = 'okta'`)).rows[0].c);
    assert.deepEqual([config.clientId, config.clientSecret, config.issuer], ['console-app', 'idp-secret', IDP], 'its settings as the SSO plugin reads them');
    const h = ((await call('GET', '/api/history?type=sso.update', { cookie: admin })).json as any[]);
    assert.ok(h.length >= 2 && !JSON.stringify(h).includes('idp-secret'), 'History has the edits, never the secret');
  });

  test('people at the company’s domains sign in with the identity provider and join as viewers', async () => {
    const pat = await signInWithSso('pat@corp.example', { sub: 'u-pat', email: 'pat@corp.example', name: 'Pat Ruiz' });
    assert.equal(pat.status, 302);
    assert.equal(new URL(pat.location, ORIGIN).pathname, '/');
    const m = await meta(pat.cookie);
    assert.equal(m.status, 200);
    assert.deepEqual([m.json.me.key, m.json.me.name, m.json.me.role], ['pat@corp.example', 'Pat Ruiz', 'viewer']);

    const again = await signInWithSso('pat@corp.example', { sub: 'u-pat', email: 'pat@corp.example', name: 'Pat Ruiz' });
    assert.equal((await meta(again.cookie)).json.me.key, 'pat@corp.example', 'next time, the same person');
    assert.equal((await ctx.db.query(`select 1 from auth_user where email = 'pat@corp.example'`)).rows.length, 1);

    const sub = await signInWithSso('lou@corp-labs.example', { sub: 'u-lou', email: 'lou@eu.corp-labs.example', name: 'Lou' });
    assert.equal((await meta(sub.cookie)).json.me.key, 'lou@eu.corp-labs.example', 'every domain of the connection, and their subdomains');
  });

  test('the provider’s tokens are kept encrypted', async () => {
    const rows = (await ctx.db.query<{ access_token: string | null }>(`select access_token from auth_account where provider_id = 'okta'`)).rows;
    assert.ok(rows.length > 0 && rows.every((r) => !r.access_token || !r.access_token.startsWith('at-')), JSON.stringify(rows));
  });

  test('the provider can’t sign in emails outside its domains, even someone an admin added: they join with their invite link', async () => {
    const outsider = await signInWithSso('pat@corp.example', { sub: 'u-x', email: 'x@elsewhere.example', name: 'X' });
    assert.match(outsider.location, /error=invite_required/);
    assert.equal(outsider.cookie.includes('session_token'), false);
    assert.equal((await ctx.db.query(`select 1 from auth_user where email = 'x@elsewhere.example'`)).rows.length, 0);

    // an admin added them, as an admin: the connection still doesn't vouch for an email at another domain
    const { invite } = (await call('POST', '/api/people', { cookie: await app.admin(), body: { email: 'x@elsewhere.example', role: 'admin' } })).json;
    const claimed = await signInWithSso('pat@corp.example', { sub: 'u-x', email: 'x@elsewhere.example', name: 'X' });
    assert.match(claimed.location, /error=invite_required/);
    assert.equal(claimed.cookie.includes('session_token'), false, 'no session');
    assert.equal((await ctx.db.query(`select 1 from auth_user where email = 'x@elsewhere.example'`)).rows.length, 0, 'no account');
    const people = (await meta(await app.admin())).json.users as { key: string; status: string }[];
    assert.equal(people.find((p) => p.key === 'x@elsewhere.example')?.status, 'invited', 'their invite is still theirs to use');

    // their invite link works, and they have the role the admin chose
    const joined = await call('POST', '/api/auth/sign-up/email', { headers: { 'x-invite': invite }, body: { email: 'x@elsewhere.example', name: 'X', password: PASSWORD } });
    assert.equal(joined.status, 200, JSON.stringify(joined.json));
    const m = (await meta(joined.cookie)).json.me;
    assert.deepEqual([m.key, m.role], ['x@elsewhere.example', 'admin'], 'with the role the admin chose');
  });

  test('an expired invite doesn’t let the provider in at another domain either', async () => {
    assert.equal((await call('POST', '/api/people', { cookie: await app.admin(), body: { email: 'old@elsewhere.example', role: 'editor' } })).status, 201);
    await ctx.db.query(`update app_user set invite_expires_at = now() - interval '1 day' where key = 'old@elsewhere.example'`);
    const late = await signInWithSso('pat@corp.example', { sub: 'u-old', email: 'old@elsewhere.example', name: 'Old' });
    assert.match(late.location, /error=invite_required/);
    assert.equal((await ctx.db.query(`select 1 from auth_user where email = 'old@elsewhere.example'`)).rows.length, 0);
  });

  test('an existing password account at the domain signs in with the provider as the same person', async () => {
    const ann = await signInWithSso('ann@corp.example', { sub: 'u-ann', email: 'ann@corp.example', name: 'Ann' });
    assert.ok(ann.cookie.includes('session_token'), `signed in (went to ${ann.location})`);
    const m = (await meta(ann.cookie)).json.me;
    assert.deepEqual([m.key, m.role], ['ann@corp.example', 'admin']);
    assert.equal((await ctx.db.query(`select 1 from auth_user where email = 'ann@corp.example'`)).rows.length, 1, 'one account, two ways in');
  });

  test('removing someone’s access deletes what single sign-on made too: the identity provider can’t sign them back in', async () => {
    const admin = await app.admin();
    const lou = { sub: 'u-lou', email: 'lou@eu.corp-labs.example', name: 'Lou' };
    const session = (await signInWithSso('lou@corp-labs.example', lou)).cookie;
    assert.equal((await meta(session)).status, 200);
    assert.equal((await call('DELETE', `/api/people/${lou.email}`, { cookie: admin, body: {} })).status, 200);
    assert.equal((await meta(session)).status, 401, 'signed out');
    assert.equal((await ctx.db.query(`select 1 from auth_user where email = $1`, [lou.email])).rows.length, 0, 'their account is gone');
    const back = await signInWithSso('lou@corp-labs.example', lou);
    assert.match(back.location, /error=access_removed/, 'their company’s domain doesn’t let them back in');
    assert.equal(back.cookie.includes('session_token'), false);
    assert.equal((await meta(admin)).json.users.find((u: any) => u.key === lou.email).status, 'removed', 'still listed');

    assert.equal((await call('POST', `/api/people/${lou.email}/invite`, { cookie: admin, body: {} })).status, 200);
    const again = await signInWithSso('lou@corp-labs.example', lou);
    assert.deepEqual([(await meta(again.cookie)).json.me.key, (await meta(again.cookie)).json.me.role], [lou.email, 'viewer'], 'invited again, the identity provider signs them in');
  });

  test('a connection can require single sign-on: no passwords at its domains, except the break-glass admin', async () => {
    const admin = await app.admin();
    const { invite } = (await call('POST', '/api/people', { cookie: admin, body: { email: 'sam@corp.example' } })).json;
    const pat = await signInWithSso('pat@corp.example', { sub: 'u-pat', email: 'pat@corp.example', name: 'Pat Ruiz' });
    const used = (await call('GET', '/api/sso', { cookie: admin })).json.connections[0];
    assert.ok(used.lastSignInAt, 'someone signed in with it: it works');
    const signIns = ((await call('GET', '/api/history?type=sign_in', { cookie: admin })).json as any[]).filter((r) => r.changeType === 'sign_in');
    assert.deepEqual(signIns[0].after, { person: 'pat@corp.example', with: 'sso', connection: 'okta' }, 'History says how');
    assert.equal((await call('PUT', '/api/sso/okta', { cookie: pat.cookie, body: { requireSso: true } })).status, 403, 'admins only');
    // Ann keeps her password: she is the break-glass admin
    assert.equal((await call('PUT', '/api/sign-in-rules', { cookie: admin, body: { breakGlassAdmin: 'ann@corp.example' } })).status, 200);
    assert.equal((await call('PUT', '/api/sso/okta', { cookie: admin, body: { requireSso: true } })).json.requireSso, true);

    const signUp = await call('POST', '/api/auth/sign-up/email', { headers: { 'x-invite': invite }, body: { email: 'sam@corp.example', name: 'Sam', password: PASSWORD } });
    assert.equal(signUp.status, 403, 'not even with an invite');
    await app.admin();                               // the break-glass admin still can: a broken provider must not lock everyone out
    // a non-admin with a password from before: refused, and told to use single sign-on
    await call('PUT', '/api/sso/okta', { cookie: admin, body: { requireSso: false } });
    const kim = (await call('POST', '/api/people', { cookie: admin, body: { email: 'kim@corp.example' } })).json.invite;
    const made = await call('POST', '/api/auth/sign-up/email', { headers: { 'x-invite': kim }, body: { email: 'kim@corp.example', name: 'Kim', password: PASSWORD } });
    assert.equal(made.status, 200);
    const patAgain = await signInWithSso('pat@corp.example', { sub: 'u-pat', email: 'pat@corp.example', name: 'Pat Ruiz' });
    const stillAdmin = await app.admin();
    for (const s of [made.cookie, patAgain.cookie, stillAdmin]) assert.equal((await meta(s)).status, 200);
    await call('PUT', '/api/sso/okta', { cookie: stillAdmin, body: { requireSso: true } });
    assert.equal((await meta(made.cookie)).status, 401, 'required from now: a password session from before ends');
    assert.equal((await meta(patAgain.cookie)).status, 401, 'everyone at its domains signs in again, with single sign-on');
    assert.equal((await meta(stillAdmin)).status, 200, 'except the break-glass admin');
    const refused = await call('POST', '/api/auth/sign-in/email', { body: { email: 'kim@corp.example', password: PASSWORD } });
    assert.equal(refused.status, 403);
    assert.match(refused.json.message, /single sign-on/);
    const failed = ((await call('GET', '/api/history?type=sign_in.failed', { cookie: stillAdmin })).json as any[])[0];
    assert.deepEqual(failed.after, { person: 'kim@corp.example', with: 'password', why: 'sso_required' }, 'a refused sign-in is in History');
    assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: 'someone@other.example', password: PASSWORD } })).status, 401, 'other domains as before');
  });

  test('where single sign-on is required, a session ends after FF_SSO_SESSION_HOURS, and the identity provider is asked again', async () => {
    const pat = await signInWithSso('pat@corp.example', { sub: 'u-pat', email: 'pat@corp.example', name: 'Pat Ruiz' });
    assert.equal((await meta(pat.cookie)).status, 200);
    await ctx.db.query(`update auth_session set created_at = now() - interval '13 hours'
      where user_id = (select id from auth_user where email = 'pat@corp.example')`);
    assert.equal((await meta(pat.cookie)).status, 401, 'older than 12 hours: signed out');
    assert.equal((await ctx.db.query(`select 1 from auth_session where user_id = (select id from auth_user where email = 'pat@corp.example')`)).rows.length, 0, 'the session is gone');
    const admin = await app.admin();
    await ctx.db.query(`update auth_session set created_at = now() - interval '13 hours' where user_id = (select id from auth_user where email = 'ann@corp.example')`);
    assert.equal((await meta(admin)).status, 200, 'the break-glass admin’s password session goes on');
  });

  test('group roles: the identity provider’s groups give a role, each sign-in; none named gives the join role', async () => {
    const admin = await app.admin();
    const set = await call('PUT', '/api/sso/okta', { cookie: admin, body: { groupRoles: { claim: 'groups', roles: { 'flag-approvers': 'approver', 'flag-editors': 'editor' } } } });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    const as = (groups: string[]) => ({ sub: 'u-pat', email: 'pat@corp.example', name: 'Pat Ruiz', groups });
    const role = async (groups: string[]) => (await meta((await signInWithSso('pat@corp.example', as(groups))).cookie)).json.me.role;
    assert.equal(await role(['flag-editors', 'flag-approvers', 'everyone']), 'approver', 'the highest of their groups');
    assert.equal(await role(['flag-editors']), 'editor');
    assert.equal(await role(['everyone']), 'viewer', 'none named: the join role');
    const changes = ((await call('GET', '/api/history?type=person.role', { cookie: admin })).json as any[]).filter((r) => r.after?.from === 'groups');
    assert.equal(changes[0].changedBy, 'sso:okta', 'History says the identity provider’s groups did it');
    assert.equal((await call('PUT', '/api/sso/okta', { cookie: admin, body: { groupRoles: null } })).json.groupRoles, null);
    assert.equal(await role(['flag-editors']), 'viewer', 'without group roles, the role stays as it is');
  });

  test('removing a connection: nobody signs in with it any more, everyone who did is signed out; it’s all in History', async () => {
    const pat = await signInWithSso('pat@corp.example', { sub: 'u-pat', email: 'pat@corp.example', name: 'Pat Ruiz' });
    assert.equal((await meta(pat.cookie)).status, 200);
    const kimPassword = await call('PUT', '/api/sso/okta', { cookie: await app.admin(), body: { requireSso: false } });
    assert.equal(kimPassword.status, 200);
    const kim = await call('POST', '/api/auth/sign-in/email', { body: { email: 'kim@corp.example', password: PASSWORD } });
    assert.equal(kim.status, 200, 'kim never used single sign-on');

    assert.equal((await call('DELETE', '/api/sso/okta', { cookie: await app.admin(), body: {} })).status, 200);
    const start = await call('POST', '/api/auth/sign-in/sso', { body: { email: 'pat@corp.example', callbackURL: '/' } });
    assert.equal(start.status, 404);
    assert.match(start.json.message, /no provider/i);
    assert.equal((await meta(pat.cookie)).status, 401, 'a session from the removed connection ends at once');
    assert.equal((await meta(kim.cookie)).status, 200, 'a session of someone who never used it goes on');
    const admin = await app.admin();                 // Ann signed in with it too, so her old sessions ended
    assert.deepEqual((await call('GET', '/api/sso', { cookie: admin })).json.connections, []);
    assert.equal((await call('GET', '/api/sign-in')).json.sso, false);
    const types = ((await call('GET', '/api/history', { cookie: admin })).json as any[]).map((h) => h.changeType);
    for (const t of ['sso.add', 'sso.update', 'sso.remove']) assert.ok(types.includes(t), t);
  });
});

test('the issuer must be on the public internet unless trusted; what went wrong is said without the network’s details', async (t) => {
  const { ctx, call, admin } = await appWithAdmin();
  t.after(() => ctx.stop());
  const cookie = await admin();
  const add = (issuer: string) => call('POST', '/api/sso', { cookie, body: { type: 'oidc', id: 'probe', issuer, clientId: 'c', clientSecret: 's', domains: 'probe.example' } });
  for (const issuer of ['http://10.1.2.3', 'http://169.254.169.254', `http://localhost:${new URL(IDP).port}`, 'http://[::1]:8080']) {
    const r = await add(issuer);
    assert.equal(r.status, 422, issuer);
    assert.match(r.json.error, /isn’t on the public internet: .*BETTER_AUTH_TRUSTED_ORIGINS/, issuer);
  }
  // trusted (BETTER_AUTH_TRUSTED_ORIGINS), but nothing answers, or not with a discovery document: the same plain words
  for (const issuer of [DEAD, `${IDP}/no-such-tenant`]) {
    const r = await add(issuer);
    assert.equal(r.status, 422, issuer);
    assert.match(r.json.error, /^couldn’t read the identity provider’s settings at .*: check the issuer address$/, issuer);
    assert.doesNotMatch(r.json.error, /\bHTTP \d|\b404\b|ECONN|fetch failed|refused/i, issuer);
  }
  assert.deepEqual((await call('GET', '/api/sso', { cookie })).json.connections, [], 'nothing was added');
});

test('the issuer’s address is checked by the connection’s own lookup: a name can’t answer public, then private (DNS rebinding)', async () => {
  // a name that resolves to a public address the first time it is asked, and to this machine (the fake provider) after
  let asked = 0;
  const rebinding = ((_host: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) => {
    asked++;
    cb(null, [{ address: asked === 1 ? '93.184.215.14' : '127.0.0.1', family: 4 }]);
  }) as unknown as typeof dnsLookup;
  const read = discoverOverHttp([], { lookup: rebinding, timeoutMs: 500 });
  const port = new URL(IDP).port;
  const got = await read(`http://rebind.acme.example:${port}/.well-known/openid-configuration`).then((d) => d, (e: Error) => e);
  assert.ok(got instanceof Error, `the private address was never reached (got ${JSON.stringify(got)})`);
  assert.equal(asked, 1, 'resolved once, by the connection itself: what was checked is what it connects to');

  // and a name that answers private from the start is refused before anything is sent
  const local = ((_h: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
    cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as typeof dnsLookup;
  await assert.rejects(discoverOverHttp([], { lookup: local })(`http://idp.acme.example:${port}/.well-known/openid-configuration`),
    /isn’t on the public internet: .*BETTER_AUTH_TRUSTED_ORIGINS/);
});

test('adding an OIDC connection reads the identity provider’s settings through the discovery adapter, offline', async (t) => {
  const { ctx, call, admin } = await appWithAdmin({ discover });
  t.after(() => ctx.stop());
  const cookie = await admin();
  const issuer = 'https://login.offline.example';
  const at = `${issuer}/.well-known/openid-configuration`;
  const settings = { issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/oauth2/keys` };
  const conn = { type: 'oidc', id: 'offline', issuer: `${issuer}/`, clientId: 'console', clientSecret: 'shh', domains: 'offline.example' };
  const add = () => call('POST', '/api/sso', { cookie, body: conn });

  const unreachable = await add();
  assert.equal(unreachable.status, 422);
  assert.equal(unreachable.json.error, `couldn’t read the identity provider’s settings at ${at}: check the issuer address`, 'without the network’s details');
  settingsAt.set(at, { ...settings, jwks_uri: undefined });
  assert.match((await add()).json.error, /have no jwks_uri/);
  settingsAt.set(at, { ...settings, issuer: 'https://someone.else.example' });
  const other = (await add()).json.error;
  assert.equal(other, `the identity provider’s settings at ${at} are for another issuer: check the issuer address`);
  assert.doesNotMatch(other, /someone\.else/, 'nothing the document says is repeated back');
  settingsAt.set(at, settings);
  const added = await add();
  assert.equal(added.status, 201, JSON.stringify(added.json));
  assert.deepEqual([added.json.issuer, added.json.domains, added.json.clientId], [issuer, ['offline.example'], 'console']);

  const start = await call('POST', '/api/auth/sign-in/sso', { body: { email: 'kai@offline.example', callbackURL: '/' } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const to = new URL(start.json.url);
  assert.equal(`${to.origin}${to.pathname}`, settings.authorization_endpoint, 'people are sent where its settings say');
  assert.equal(to.searchParams.get('client_id'), 'console');
  assert.equal((await call('DELETE', '/api/sso/offline', { cookie, body: {} })).status, 200);
});

// A second storyline: a SAML connection is added, then its identity provider's signed answer signs someone in.
describe('SAML (in order)', () => {
  let app: Awaited<ReturnType<typeof appWithAdmin>>;
  let call: ReturnType<typeof browser>;
  before(async () => { app = await appWithAdmin(); call = app.call; });
  after(async () => { await app.ctx.stop(); });

  test('SAML: a connection from the identity provider’s metadata, sign-in goes to its sign-in page', async () => {
    const xml = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.corp.example/saml">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${CERT}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.corp.example/sso/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.corp.example/sso/redirect?app=1&amp;x=2"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
    assert.deepEqual(readIdpMetadata(xml), { entityId: 'https://idp.corp.example/saml', entryPoint: 'https://idp.corp.example/sso/redirect?app=1&x=2' });
    const added = await call('POST', '/api/sso', { cookie: await app.admin(), body: { type: 'saml', id: 'entra', domains: 'corp.example', metadata: xml } });
    assert.equal(added.status, 201, JSON.stringify(added.json));
    assert.equal(added.json.type, 'saml');
    assert.equal(added.json.entryPoint, 'https://idp.corp.example/sso/redirect?app=1&x=2');
    assert.equal(added.json.serviceProvider.samlAcsUrl, 'http://localhost/api/auth/sso/saml2/sp/acs/entra');

    const md = await app.ctx.app.request('/api/auth/sso/saml2/sp/metadata?providerId=entra');
    assert.equal(md.status, 200);
    const spXml = await md.text();
    assert.match(spXml, /entityID="http:\/\/localhost\/api\/auth\/sso\/saml2\/sp\/metadata\?providerId=entra"/);
    assert.match(spXml, /Location="http:\/\/localhost\/api\/auth\/sso\/saml2\/sp\/acs\/entra"/);

    const start = await call('POST', '/api/auth/sign-in/sso', { body: { email: 'pat@corp.example', callbackURL: '/' } });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    const to = new URL(start.json.url);
    assert.equal(`${to.origin}${to.pathname}`, 'https://idp.corp.example/sso/redirect');
    assert.ok(to.searchParams.get('SAMLRequest'), 'a SAML request for the identity provider');

    const forged = await call('POST', '/api/auth/sso/saml2/sp/acs/entra', { form: { SAMLResponse: Buffer.from('<Response/>').toString('base64') } });
    // refused: sent back to the console with an error, signing nobody in
    assert.equal(forged.status, 302, JSON.stringify(forged.json));
    assert.match(forged.location ?? '', /[?&]error=/, 'an unsigned response is refused');
    assert.equal(forged.cookie.includes('session_token'), false, 'and signs nobody in');
  });

  test('SAML: the identity provider’s signed answer signs the person in, once', async () => {
    const pem = (body: string, kind: string) => `-----BEGIN ${kind}-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END ${kind}-----\n`;
    const idpSaml = samlify.IdentityProvider({
      entityID: 'https://idp.corp.example/saml', signingCert: pem(CERT, 'CERTIFICATE'), privateKey: pem(KEY, 'PRIVATE KEY'),
      singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: 'https://idp.corp.example/sso/redirect' }],
      nameIDFormat: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
    });
    const sp = samlify.ServiceProvider({ metadata: await (await app.ctx.app.request('/api/auth/sso/saml2/sp/metadata?providerId=entra')).text() });

    const start = await call('POST', '/api/auth/sign-in/sso', { body: { email: 'pat@corp.example', callbackURL: '/' } });
    const q = Object.fromEntries(new URL(start.json.url).searchParams);
    const request = await idpSaml.parseLoginRequest(sp, 'redirect', { query: q });
    const answer = await idpSaml.createLoginResponse(sp, { extract: request.extract }, 'post', { email: 'pat@corp.example' }, undefined, false, q.RelayState);
    const done = await call('POST', '/api/auth/sso/saml2/sp/acs/entra', { form: { SAMLResponse: answer.context, ...(q.RelayState ? { RelayState: q.RelayState } : {}) } });
    assert.equal(done.status, 302, JSON.stringify(done.json));
    assert.ok(done.cookie.includes('session_token'), `signed in (went to ${done.location})`);
    const m = (await call('GET', '/api/meta', { cookie: done.cookie })).json.me;
    assert.deepEqual([m.key, m.role], ['pat@corp.example', 'viewer'], 'someone at the connection’s domain joins as a viewer');

    const replay = await call('POST', '/api/auth/sso/saml2/sp/acs/entra', { form: { SAMLResponse: answer.context } });
    assert.equal(replay.status, 302, JSON.stringify(replay.json));
    assert.match(replay.location ?? '', /[?&]error=invalid_saml_response/, 'an answer works once');
    assert.equal(replay.cookie.includes('session_token'), false);
  });
});

// a throwaway self-signed certificate and its key, only for the fake identity provider in these tests
const CERT = 'MIIDBzCCAe+gAwIBAgIUd0dNqZAsnuqP3OO+bLFI0lEPk3wwDQYJKoZIhvcNAQELBQAwEzERMA8GA1UEAwwIdGVzdC1pZHAwHhcNMjYxMTE3MTkyMjEzWhcNMzYxMTE0MTkyMjEzWjATMREwDwYDVQQDDAh0ZXN0LWlkcDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKo9WBCGo+2RLW7HouLKqU7vPTqgz+mKuwQhmvKEaIjsx/csFyP2Q2USTpOn7tKYMFrPkwPwfmdhYCgB/owDuNJLtcJ96kTDz1Hw+BssKZwcd+VVl1KZRxKTPOxRO8+0PgPaecnXT04vvKrpPOI/k0uwERJFZzdYwnNoviX5lOWQSZScERA8rgNasZkjTFKZ9jXw6v7FTbrLvpE8ttUn0Wu/QZLinMDL7WvJFiznaEVFVxV5YRuRAj1jCthP/4e/hFDvNAUyC/5xg6QbCrgR7iF/YB3U5ttzF0I+PvolzLEkINLKPh5WcWVoj/wnuUOR7KnVRfP+oTGxKKOP43+L74kCAwEAAaNTMFEwHQYDVR0OBBYEFOIZY/jzD0u8n0T+c1JVFT4XIeEcMB8GA1UdIwQYMBaAFOIZY/jzD0u8n0T+c1JVFT4XIeEcMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAEYYZjoILxE/8mga7q2POhf17K+vBqjf396VcvBlqT0MdNtFcyhBEGumHgED/jXIF1Hy+vgDkxrFRQar2lkvDCmYOdBXP56fHLL0nWuZx9X3KEkCk6EbAWlJY1QvqS1bLAvOjHvpbSFIbtq6o0aHQ4hzCVUbKPIgMfTKNb02i4iOI0CuFlEUYOO0Us0EoRt086+FawfdOGSP7JmXNqVpjKLop/hdtim3DTVg5T7kVHpDUz5KGsOEjkhZVYN7RaYRqh3S5TOZgf8rzIbuM00JWQ5Kl6GoK1hvGRht++h3qfVS+eP7Oz0rNnnKTLi7y3VSawqXqHaxUw6Ce1oKC7Lz9wA=';
const KEY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCqPVgQhqPtkS1ux6LiyqlO7z06oM/pirsEIZryhGiI7Mf3LBcj9kNlEk6Tp+7SmDBaz5MD8H5nYWAoAf6MA7jSS7XCfepEw89R8PgbLCmcHHflVZdSmUcSkzzsUTvPtD4D2nnJ109OL7yq6TziP5NLsBESRWc3WMJzaL4l+ZTlkEmUnBEQPK4DWrGZI0xSmfY18Or+xU26y76RPLbVJ9Frv0GS4pzAy+1ryRYs52hFRVcVeWEbkQI9YwrYT/+Hv4RQ7zQFMgv+cYOkGwq4Ee4hf2Ad1ObbcxdCPj76JcyxJCDSyj4eVnFlaI/8J7lDkeyp1UXz/qExsSijj+N/i++JAgMBAAECggEAMYj+/nQG8AH9y824JjCdGjQ/xzbyuHxfFYEnwmhnuGvZdaD1LMgj7R1qEsnbEpko/MuIdi18wl0RqyKFbD1LApn4Ddswlwi44xlwQAvWIbAg7PC+QtEJ3qxMHmE2u6WxI9Lm/CWz1EbMqZiLWDPyiqP1G7FpKrAfiJBSP9+DBVa/dV/AEsIoKbanY0JkiZZamSZe6Kh6qUAgcvYSrMbT4MThQjbLDIIy1t/XUpg5v/oQxJ/owvtMF48u5lWUY65iM0EcVXfnlGkkZ5sPMbKOBZHKSmHB9C2KE3CM9Dom3ZwWej3w5PeuKKLOAb/I6gu/JB5FzqJClMpEQgeQjjlXzwKBgQDweWIbmnOZB3nEu7TWlozOSA6+uPe0yXc+UCntQvIlPlVLOnLLeDsYi3pEX7NJA2a+7qxzBjPLZKGkSGpt1bVUSIhuchzTxKZd23gpoNbJzNlyjLzx/sGuUSDZWjNazrhZLCQDM8bV+YfbXE+PbnlnAlBwqPjozTcNXkNv7u+OHwKBgQC1OxtikzBdcd6kR4kcREkUr19Sog02VFGt3O60/kcJAc6zMA/JuKvL/q9u/17f8AP/pwsKVIoVvKW9ZhRYFJRJsSoT/Ied1QhK1Q3xZe3k2dKPVKRdyhmdZFfPCZ4AxaxDgG/3VpFBs2CnPv7dQRFIon/OghiEvaGzoQSKoZL9VwKBgQCV9ryuBiXs2vKfM4fVAtIQmnNHkUY4oiMQ4yEia0ti2nqKjYqlRPdlmSXImf3OnKZoj6NPoCCQyNLdBqQIluucAhfC+LrtfYdapNFM9Ja+BlfczdPO/lZ+hO19XnkEOkJQqexTauim7BRDQlADXJutF45ek6GWXNPmLFDV7yXJdQKBgQCG0VaY6Sf0i831ZaXw2jeHZMLDpPuxK96rOQx2piZP5AFROXK1PGTI10jIiL6aVmGTID/NSoCClRiyoaqGr6B0hY/o2FZGqoCFsqKxroLfWM8TgwLXJo4RkODliqD4sBRrDrO8SrC6MGe5YtqT22CxKPlstUjqDmupRiIrwvCm9wKBgEzm4cHw5Fkdhss46l1gaAOMkaLFjEULTsgIh6HAKYYyA8SvEqwhXa3AZtu0BeKGjJkFyRs22qH0oGITtRBKmcLefdmnUFu/hLSRxhscHDRW7tdpyHelC2ufKWsbLmmf9JYnQrPhAfXJMQak/ix3DrFBgU1BQpXwNLqdyQtSiuEZ';
