// Who may join, at the access module's interface (server/access.ts): one row per admission rule. Accounts and single
// sign-on connections are kept in memory here (in the app, Better Auth and sso.ts keep them); people, invites and
// removals go through the access module itself, as an admin's changes do. The sign-in flows over HTTP, through
// Better Auth, are in setup.test.ts and sso.test.ts.
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
  };
}

const DAY = 86_400_000;
let clock = new Date('2026-11-02T09:00:00Z');
const opened: { db: Db; drop: () => Promise<void> }[] = [];
after(async () => { for (const o of opened) { await o.db.close(); await o.drop(); } });

/** A new, empty database's people. FF_SIGNUP_DOMAINS is corp.com. */
async function install(connections: Vouching[] = []) {
  const t = await testDatabase();
  const { db } = await openDb({ url: t.url });
  opened.push({ db, drop: t.drop });
  const accounts = memoryAccounts();
  const access = createAccess(db, { accounts, connections: async () => connections, signupDomains: ['corp.com'], now: () => clock });
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

/** [what, the attempt, null when admitted or the refusal's code] */
type Row = [string, Attempt, string | null];
async function admits(access: Access, rows: Row[]) {
  for (const [what, attempt, refused] of rows) assert.equal((await access.admit(attempt))?.code ?? null, refused, what);
}

test('a new install: whoever makes the first account is the admin; after that an account needs an invite', async () => {
  const { access, joins } = await install();
  await admits(access, [['the first account, without an invite', password('lee@corp.com'), null]]);
  await joins('lee@corp.com');
  assert.equal((await access.signedIn({ email: 'lee@corp.com' })).role, 'admin');
  await admits(access, [['the next one, without an invite', password('sam@corp.com'), 'invite_required']]);
});

test('a database from before accounts: an existing admin makes the first account without an invite, nobody else does', async () => {
  const { access, joins } = await install();
  // people from the sign-in before accounts: the first to sign in is the admin, the next a viewer the admin promotes
  await access.signedIn({ email: 'ann@corp.com', name: 'Ann' });
  await access.signedIn({ email: 'bo@corp.com', name: 'Bo' });
  await access.setRole('bo@corp.com', 'editor', by('ann@corp.com'));
  await admits(access, [
    ['an existing admin', password('ann@corp.com'), null],
    ['an existing person who isn’t an admin', password('bo@corp.com'), 'invite_required'],
    ['anyone else', password('new@corp.com'), 'invite_required'],
  ]);
  await joins('ann@corp.com');
  assert.equal((await access.signedIn({ email: 'ann@corp.com' })).role, 'admin', 'the role she had');
  await access.setRole('bo@corp.com', 'admin', by('ann@corp.com'));
  await admits(access, [['once someone has an account, another admin needs an invite too', password('bo@corp.com'), 'invite_required']]);
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
    ['single sign-on, an email an admin added', sso('pal@partner.example'), null],
    ['single sign-on with a connection that isn’t there', sso('pat@corp.example', 'gone'), 'invite_required'],

    ['removed: a password account', password('rem@corp.example'), 'access_removed'],
    ['removed: single sign-on at their domain', sso('rem@corp.example'), 'access_removed'],
    ['removed: a provider signing them in again', provider('rem@corp.example', true, 'existing'), 'access_removed'],
    ['anyone else signing in again', provider('pal@partner.example', true, 'existing'), null],
  ]);
  assert.equal(await access.invitedBy(old), undefined, 'the sign-in page doesn’t greet an expired invite either');
});

test('a connection that requires single sign-on: no password sign-ins or password accounts at its domains, except admins', async () => {
  const { access, joins } = await install([{ id: 'okta', domains: ['corp.example'], requireSso: true }]);
  await joins('lee@corp.com');
  const lee = by('lee@corp.com');
  const ann = (await access.add({ email: 'ann@corp.example', role: 'admin' }, lee)).invite;
  const pat = (await access.add({ email: 'pat@corp.example', role: 'editor' }, lee)).invite;
  await admits(access, [
    ['a password sign-in, an admin', passwordSignIn('ann@corp.example'), null],
    ['a password sign-in, not an admin', passwordSignIn('pat@corp.example'), 'sso_required'],
    ['an invite, for an admin', password('ann@corp.example', ann), null],
    ['an invite, not for an admin', password('pat@corp.example', pat), 'sso_required'],
    ['a provider, an admin', provider('ann@corp.example'), null],
    ['a provider, not an admin', provider('pat@corp.example'), null],
    ['single sign-on, an admin', sso('ann@corp.example'), null],
    ['single sign-on, not an admin', sso('pat@corp.example'), null],
    ['a password sign-in at another domain', passwordSignIn('lee@corp.com'), null],
  ]);
  await access.remove('ann@corp.example', lee);
  await admits(access, [['an admin whose access was removed', passwordSignIn('ann@corp.example'), 'sso_required']]);
});
