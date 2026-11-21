// Who may join, at the access module's interface (server/access.ts): one row per admission rule. Accounts and single
// sign-on connections are kept in memory here (in the app, the sign-in and sso.ts keep them); people, invites and
// removals go through the access module itself, as an admin's changes do. The sign-in flows over HTTP
// are in setup.test.ts and sso.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccess, type Access, type Accounts, type Attempt, type Vouching } from '../server/access.ts';
import { openDb, type Db } from '../server/db.ts';
import type { Actor } from '../server/layers.ts';
import { testDatabase } from './helpers.ts';

/** Accounts as the sign-in keeps them, in memory: `made` is someone making one. */
function memoryAccounts(): Accounts & { made: (email: string) => void } {
  const emails = new Set<string>();
  return {
    made: (email) => { emails.add(email); },
    any: async () => emails.size > 0,
    of: async (_q, list) => new Set(list.filter((e) => emails.has(e))),
    remove: async (_q, email) => { emails.delete(email); },
    hasPassword: async (_q, email) => emails.has(email),
    removeSignInsWith: async () => {},
    endSessionsAt: async () => {},
    twoFactorOn: async () => false,
  };
}

const DAY = 86_400_000;
let clock = new Date('2026-11-02T09:00:00Z');
const opened: { db: Db; drop: () => Promise<void> }[] = [];
after(async () => { for (const o of opened) { await o.db.close(); await o.drop(); } });

/** The setup link's secret on these installs (the server makes it from its secret: accounts.ts setupTokenFor). */
const SETUP = 'the-setup-link-secret';

/** A new, empty database's people. FF_SIGNUP_DOMAINS is corp.com. */
async function install(connections: Vouching[] = []) {
  const t = await testDatabase();
  const { db } = await openDb({ url: t.url });
  opened.push({ db, drop: t.drop });
  const accounts = memoryAccounts();
  const access = createAccess(db, { accounts, connections: async () => connections, signupDomains: ['corp.com'], now: () => clock, setupToken: SETUP });
  /** someone makes an account, as the sign-in tells the access module */
  const joins = async (email: string) => { await access.joined(email, email.split('@')[0]); accounts.made(email); };
  return { access, joins };
}
const by = (email: string): Actor => ({ name: email, type: 'user' });

// the ways in, as the sign-in describes them to the access module
const password = (email: string, invite?: string): Attempt => ({ email, with: 'password', account: 'new', invite });
const passwordSignIn = (email: string): Attempt => ({ email, with: 'password', account: 'existing' });
const provider = (email: string, emailVerified = true, account: Attempt['account'] = 'new'): Attempt => ({ email, with: 'provider', account, emailVerified });
const sso = (email: string, connection = 'okta'): Attempt => ({ email, with: 'sso', account: 'new', connection });
/** the same attempt, from a browser that opened the setup link (or a request with its secret) */
const withSetup = (a: Attempt, setup = SETUP): Attempt => ({ ...a, setup });

/** [what, the attempt, null when admitted or the refusal's code] */
type Row = [string, Attempt, string | null];
async function admits(access: Access, rows: Row[]) {
  for (const [what, attempt, refused] of rows) assert.equal((await access.admit(attempt))?.code ?? null, refused, what);
}

test('a new install: whoever opens the setup link makes the first account, the admin; after that an account needs an invite', async () => {
  const { access, joins } = await install();
  await admits(access, [
    ['the first account, without the setup link', password('eve@elsewhere.example'), 'invite_required'],
    ['the first account, with a made-up setup link', withSetup(password('eve@elsewhere.example'), 'not-the-secret'), 'invite_required'],
    ['a provider at a signup domain, before anyone has an account', provider('pat@corp.com'), 'invite_required'],
    ['the first account, with the setup link', withSetup(password('lee@corp.com')), null],
    ['the first account, with a provider and the setup link', withSetup(provider('lee@corp.com')), null],
  ]);
  assert.equal((await access.signInOptions()).firstPerson, false, 'the sign-in page doesn’t say nobody has an account');
  assert.equal((await access.signInOptions(SETUP)).firstPerson, true, 'unless it was opened with the setup link');
  await joins('lee@corp.com');
  assert.equal((await access.signedIn({ email: 'lee@corp.com' })).role, 'admin');
  await admits(access, [
    ['the next one, without an invite', password('sam@corp.com'), 'invite_required'],
    ['the next one, with the setup link: it works once', withSetup(password('sam@corp.com')), 'invite_required'],
  ]);
  assert.equal((await access.signInOptions(SETUP)).firstPerson, false);
});

test('without a setup link, a new install makes no first account at all', async () => {
  const t = await testDatabase();
  const { db } = await openDb({ url: t.url });
  opened.push({ db, drop: t.drop });
  const access = createAccess(db, { accounts: memoryAccounts(), connections: async () => [] });
  await admits(access, [['the first account', withSetup(password('lee@corp.com'), ''), 'invite_required']]);
});

test('who may join an install in use: invites, signup domains, single sign-on, removed people', async () => {
  const { access, joins } = await install([{ id: 'okta', domains: ['corp.example'], requireSso: false }]);
  await joins('lee@corp.com');                                              // the admin
  const lee = by('lee@corp.com');
  const old = (await access.add({ email: 'old@corp.com' }, lee)).invite;
  clock = new Date(clock.getTime() + 8 * DAY);                              // a week and a day later
  const sam = (await access.add({ email: 'sam@corp.com' }, lee)).invite;
  const kim = (await access.add({ email: 'kim@corp.com', role: 'editor' }, lee)).invite;
  await joins('kim@corp.com');                                              // with her invite
  await access.add({ email: 'pal@partner.example', role: 'editor' }, lee);
  await access.add({ email: 'rem@corp.example' }, lee);
  await joins('rem@corp.example');
  await access.remove('rem@corp.example', lee);

  await admits(access, [
    ['an invite, for its email', password('sam@corp.com', sam), null],
    ['an invite, for another email', password('eve@corp.com', sam), 'invite_required'],
    ['an invite, expired', password('old@corp.com', old), 'invite_required'],
    ['an invite, already used', password('kim@corp.com', kim), 'invite_required'],
    ['a made-up invite', password('sam@corp.com', 'not-the-link'), 'invite_required'],
    ['no invite', password('sam@corp.com'), 'invite_required'],

    ['a provider confirms an email at a signup domain', provider('new@corp.com'), null],
    ['a provider, without confirming the email', provider('new@corp.com', false), 'invite_required'],
    ['a provider, an email elsewhere', provider('x@elsewhere.example'), 'invite_required'],
    ['a provider, an email an admin added', provider('pal@partner.example'), null],
    ['a password account at a signup domain', password('new@corp.com'), 'invite_required'],

    ['single sign-on at the connection’s domain', sso('pat@corp.example'), null],
    ['single sign-on at a subdomain of it', sso('lou@eu.corp.example'), null],
    ['single sign-on, an email outside its domains', sso('x@elsewhere.example'), 'invite_required'],
    // a connection vouches for its own domains only: someone an admin added elsewhere joins with their invite link
    ['single sign-on, an email an admin added at another domain', sso('pal@partner.example'), 'invite_required'],
    ['single sign-on, an invite expired at another domain', sso('old@corp.com'), 'invite_required'],
    ['single sign-on with a connection that isn’t there', sso('pat@corp.example', 'gone'), 'invite_required'],

    ['removed: a password account', password('rem@corp.example'), 'access_removed'],
    ['removed: single sign-on at their domain', sso('rem@corp.example'), 'access_removed'],
    ['removed: a provider signing them in again', provider('rem@corp.example', true, 'existing'), 'access_removed'],
    ['anyone else signing in again', provider('pal@partner.example', true, 'existing'), null],
  ]);
  assert.equal(await access.invitedBy(old), undefined, 'the sign-in page doesn’t greet an expired invite either');
});

test('a connection that requires single sign-on: no password or provider sign-ins or accounts at its domains, except the break-glass admin', async () => {
  const { access, joins } = await install([{ id: 'okta', domains: ['corp.example'], requireSso: true }]);
  await joins('lee@corp.com');
  const lee = by('lee@corp.com');
  const ann = (await access.add({ email: 'ann@corp.example', role: 'admin' }, lee)).invite;
  const bea = (await access.add({ email: 'bea@corp.example', role: 'admin' }, lee)).invite;
  const pat = (await access.add({ email: 'pat@corp.example', role: 'editor' }, lee)).invite;
  await admits(access, [['no break-glass admin yet: an admin uses single sign-on too', passwordSignIn('ann@corp.example'), 'sso_required']]);
  await admits(access, [['an invite, for an admin who isn’t the break-glass admin yet', password('ann@corp.example', ann), 'sso_required']]);
  // the break-glass admin needs a password: an admin who signs in only with the identity provider can't break glass
  await assert.rejects(access.setRules({ breakGlassAdmin: 'ann@corp.example' }, lee), { status: 422, message: /password/ });
  await joins('ann@corp.example');                     // she has one now (a password link, made in People)
  await access.setRules({ breakGlassAdmin: 'ann@corp.example' }, lee);
  await admits(access, [
    ['a password sign-in, the break-glass admin', passwordSignIn('ann@corp.example'), null],
    ['a password sign-in, another admin', passwordSignIn('bea@corp.example'), 'sso_required'],
    ['a password sign-in, not an admin', passwordSignIn('pat@corp.example'), 'sso_required'],
    ['an invite, for another admin', password('bea@corp.example', bea), 'sso_required'],
    ['an invite, not for an admin', password('pat@corp.example', pat), 'sso_required'],
    ['a provider, the break-glass admin', provider('ann@corp.example'), null],
    ['a provider, the break-glass admin signing in again', provider('ann@corp.example', true, 'existing'), null],
    // a provider keeps confirming an email after its owner left: only the identity provider says who still works there
    ['a provider, not an admin', provider('pat@corp.example'), 'sso_required'],
    ['a provider, not an admin signing in again (GitHub, to the account they have)', provider('pat@corp.example', true, 'existing'), 'sso_required'],
    ['a provider at a subdomain, not an admin', provider('lou@eu.corp.example', true, 'existing'), 'sso_required'],
    ['a provider at another domain', provider('pal@partner.example', true, 'existing'), null],
    ['single sign-on, the break-glass admin', sso('ann@corp.example'), null],
    ['single sign-on, not an admin', sso('pat@corp.example'), null],
    ['a password sign-in at another domain', passwordSignIn('lee@corp.com'), null],
  ]);
  await access.setRole('ann@corp.example', 'editor', lee);
  await admits(access, [['the break-glass admin, no longer an admin', passwordSignIn('ann@corp.example'), 'sso_required']]);
  await access.setRole('ann@corp.example', 'admin', lee);
  await access.remove('ann@corp.example', lee);
  await admits(access, [['the break-glass admin, whose access was removed', passwordSignIn('ann@corp.example'), 'sso_required']]);
});

test('the sign-in rules: the break-glass admin is an admin, the join role is never admin, two-factor needs the admin’s own first', async () => {
  const { access, joins } = await install([{ id: 'okta', domains: ['corp.example'], requireSso: false }]);
  await joins('lee@corp.com');
  const lee = by('lee@corp.com');
  await access.add({ email: 'pat@corp.example', role: 'editor' }, lee);
  const refused = async (input: Record<string, unknown>, status: number) =>
    assert.equal(await access.setRules(input, lee).then(() => 200, (e: { status?: number }) => e.status), status, JSON.stringify(input));
  await refused({ breakGlassAdmin: 'pat@corp.example' }, 422);
  await refused({ breakGlassAdmin: 'nobody@corp.example' }, 422);
  await refused({ joinRole: 'admin' }, 422);
  await refused({ joinRole: 'owner' }, 422);
  // lee has a password (memoryAccounts) and no second factor yet
  await refused({ adminsNeedTwoFactor: true }, 409);
  assert.deepEqual((({ breakGlassAdmin, adminsNeedTwoFactor, joinRole }) => ({ breakGlassAdmin, adminsNeedTwoFactor, joinRole }))(await access.rules()),
    { breakGlassAdmin: null, adminsNeedTwoFactor: false, joinRole: 'viewer' }, 'nothing changed: the least role by default');

  await access.setRules({ joinRole: 'editor', breakGlassAdmin: 'lee@corp.com' }, lee);
  assert.equal((await access.signedIn({ email: 'new@corp.example' })).role, 'editor', 'people who join without an invite get the join role');
  assert.equal((await access.rules()).breakGlassAdmin, 'lee@corp.com');
});

test('where single sign-on is required, a session lasts ssoSessionHours: then it ends and they sign in again', async () => {
  const { access, joins } = await install([{ id: 'okta', domains: ['corp.example'], requireSso: true }]);
  await joins('lee@corp.example');
  await access.setRules({ breakGlassAdmin: 'lee@corp.example' }, by('lee@corp.example'));
  let ended = 0;
  const session = (email: string, hoursAgo: number) => ({ email, since: new Date(clock.getTime() - hoursAgo * 3_600_000), end: async () => { ended++; } });
  assert.equal((await access.signedIn(session('pat@corp.example', 11))).key, 'pat@corp.example', 'within 12 hours');
  await assert.rejects(access.signedIn(session('pat@corp.example', 13)), { status: 401 });
  assert.equal(ended, 1, 'the old session ends');
  assert.equal((await access.signedIn(session('lee@corp.example', 100))).key, 'lee@corp.example', 'the break-glass admin’s password session goes on');
  assert.equal((await access.signedIn(session('kim@other.example', 100))).key, 'kim@other.example', 'where single sign-on isn’t required, as before');
});

test('an admin with a password must set up two-factor first when the rules say so; sign-ins and group roles are told to History', async () => {
  const { access, joins } = await install();
  await joins('lee@corp.com');
  const lee = by('lee@corp.com');
  await access.add({ email: 'ann@corp.com', role: 'admin' }, lee);
  await joins('ann@corp.com');
  // lee has no second factor: the rules can't ask it of admins until she has one. Here two-factor is on for no one,
  // so turn it on as someone with no password (SSO only): the memory accounts know only the ones that joined
  await access.setRules({ adminsNeedTwoFactor: true }, by('sso-only@corp.com'));
  assert.equal((await access.signedIn({ email: 'ann@corp.com' })).needsTwoFactor, true, 'an admin with a password and no second factor');
  assert.equal((await access.signedIn({ email: 'ann@corp.com', twoFactor: true })).needsTwoFactor, undefined, 'with a second factor');
  assert.equal((await access.signedIn({ email: 'viv@corp.com' })).needsTwoFactor, undefined, 'not an admin');

  await access.signedInNow('ann@corp.com', { with: 'password' });
  await access.signInFailed('ann@corp.com', { with: 'two-factor' }, 'INVALID_CODE');
  const listed = (await access.people()).find((p) => p.key === 'ann@corp.com')!;
  assert.ok(listed.lastSignedInAt, 'last signed in, for the People list');

  // the identity provider's groups: never the last admin's role down, and the break-glass admin's left alone
  await access.groupRole('viv@corp.com', 'approver', 'okta');
  assert.equal((await access.signedIn({ email: 'viv@corp.com' })).role, 'approver');
  await access.setRules({ breakGlassAdmin: 'ann@corp.com' }, lee);
  await access.groupRole('ann@corp.com', 'viewer', 'okta');
  assert.equal((await access.signedIn({ email: 'ann@corp.com', twoFactor: true })).role, 'admin', 'the break-glass admin keeps their role');
});

test('a password link: for anyone with an account, a first password too; an invite for someone without one', async () => {
  const { access, joins } = await install([{ id: 'okta', domains: ['corp.example'], requireSso: true }]);
  await joins('lee@corp.com');
  const lee = by('lee@corp.com');
  await access.add({ email: 'pat@corp.example', role: 'editor' }, lee);
  await access.add({ email: 'kim@corp.com', role: 'editor' }, lee);
  const link = (key: string) => access.passwordReset(key, lee, async () => 'reset-token');
  await assert.rejects(link('kim@corp.com'), { status: 409, message: /invite link/ }, 'no account yet: an invite');
  await joins('pat@corp.example');
  const made = await link('pat@corp.example');
  assert.equal(made.token, 'reset-token');
  assert.equal(made.ssoRequired, true, 'their domain requires single sign-on: the console says the password waits');
  assert.equal((await link('lee@corp.com')).ssoRequired, false);
  await assert.rejects(access.invite('pat@corp.example', lee), { status: 409, message: /password link/ }, 'an account: a password link, not an invite');
});

test('an admin who must set up two-factor sign-in has it pending for tokens and OAuth too, only while the rules ask it', async () => {
  const { access, joins } = await install();
  await joins('lee@corp.com');
  await access.add({ email: 'ann@corp.com', role: 'admin' }, by('lee@corp.com'));
  await access.add({ email: 'viv@corp.com', role: 'editor' }, by('lee@corp.com'));
  await joins('ann@corp.com');
  await joins('viv@corp.com');
  assert.equal(await access.twoFactorPending('ann@corp.com'), false, 'the rules don’t ask it');
  await access.setRules({ adminsNeedTwoFactor: true }, by('sso-only@corp.com'));
  assert.equal(await access.twoFactorPending('ann@corp.com'), true, 'an admin with a password and no second factor');
  assert.equal(await access.twoFactorPending('viv@corp.com'), false, 'not an admin');
  assert.equal(await access.twoFactorPending('sso-only@corp.com'), false, 'nobody here');
});
