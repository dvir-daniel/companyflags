// People and their access: the one module that decides who may join, who is asking once they are signed in, what
// their role lets them do, and what removing their access takes away (docs/design/adr/0002-better-auth-is-an-adapter-behind-people-and-access.md).
//
//   createAccess(db, { accounts, connections, signupDomains })   the people of this app (app_user)
//     .signedIn(who)              who is asking: the person behind a signed-in email, added on their first sign-in
//     .admit(attempt)             may this sign-in, or this new account, go ahead (null), and if not, why (a Refusal)
//     .joined(email, name)        an account was made: they get their role, and their invite is used up
//     .people() .add() .invite() .setRole() .remove()    the People list in Settings, and an admin's changes to it
//     .invitedBy(token) .signInOptions() .connectionRemoved(q, id)    for the sign-in page and single sign-on (sso.ts)
//   may(person, right), mustBeAllowed(person, right)    what their role lets them do (the roles are policy.ts's)
//
// A person's key is their email. Their role is kept here (app_user); their accounts and sessions are kept by the
// sign-in, Better Auth (betterAuth.ts), behind `Accounts`, and the two meet on the email. Better Auth decides
// nothing about who may join: its hooks ask `admit`. Single sign-on connections are kept by sso.ts, behind `connections`.
//
// Who may join (`admit`):
//   - nobody whose access an admin removed;
//   - the first account: on a new install, whoever opens the setup link the server prints when it starts (they become
//     the admin). Until the first account is made, nobody else joins at all;
//   - a password account: with the invite link an admin made for that email, while it works (once, for 7 days);
//   - single sign-on: people at the connection's email domains (and subdomains) only. A connection vouches for the
//     emails at its domains and no others, so someone an admin added at another domain joins with their invite link;
//   - Google, GitHub or Microsoft, when they confirm the email: people an admin added, or anyone at a signup domain
//     (FF_SIGNUP_DOMAINS);
//   - where a connection requires single sign-on, no password or Google, GitHub or Microsoft sign-ins or accounts at its
//     domains, except for admins (a broken identity provider must not lock everyone out).
// People who join without an invite start as viewers; an admin gives them a role.

import { randomBytes } from 'node:crypto';
import { sameSecret, sha256 } from './auth.ts';
import { all, HttpError, one, type Db, type Queryable } from './db.ts';
import { audit } from './journal.ts';
import type { Actor } from './layers.ts';
import { isRole, roleInfo, ROLES, type Role, type RoleInfo } from './policy.ts';

export type { Role };
export type Person = { key: string; name: string; role: Role; removed: boolean };
/** active; invited: hasn't used their invite link yet; removed */
export type Status = 'active' | 'invited' | 'removed';
export type ListedPerson = { key: string; name: string; role: Role; status: Status };

/** A signed-in email, from the sign-in (identity.ts): who the request says it is, before we know the person. */
export type Who = { email: string; name?: string };

/** Someone signing in, or making an account (`account: 'new'`). `existing`: a returning sign-in, or a new way in to
 *  the account they have (a provider or single sign-on added to it). */
export type Attempt = (
  /** a password; for a new account, the invite link's secret */
  | { email: string; with: 'password'; account: 'new' | 'existing'; invite?: string }
  /** Google, GitHub or Microsoft; whether it confirms the email */
  | { email: string; with: 'provider'; account: 'new' | 'existing'; emailVerified: boolean }
  /** single sign-on, with this connection (its id) */
  | { email: string; with: 'sso'; account: 'new' | 'existing'; connection: string }
) & {
  /** the setup link's secret, when the request carries it: the first account needs it */
  setup?: string;
};

export type Refusal = { code: 'access_removed' | 'invite_required' | 'sso_required'; message: string };

/** Where accounts are kept: Better Auth's tables (betterAuth.ts `betterAuthAccounts`). */
export type Accounts = {
  /** whether anyone has an account yet */
  any(q: Queryable): Promise<boolean>;
  /** which of these emails have an account */
  of(q: Queryable, emails: string[]): Promise<Set<string>>;
  /** deletes this email's accounts and their sessions: signed out everywhere at once */
  remove(q: Queryable, email: string): Promise<void>;
  /** whether this email has a password (not only single sign-on or a provider) */
  hasPassword(q: Queryable, email: string): Promise<boolean>;
  /** deletes the sign-ins made with this single sign-on connection */
  removeSignInsWith(q: Queryable, connection: string): Promise<void>;
  /** ends the sessions of everyone at these email domains (and their subdomains), except these emails */
  endSessionsAt(q: Queryable, domains: string[], except: string[]): Promise<void>;
};

/** A single sign-on connection an admin added (sso.ts): it vouches for the people at its domains. */
export type Vouching = { id: string; domains: string[]; requireSso: boolean };

export type AccessOptions = {
  accounts: Accounts;
  /** the single sign-on connections an admin added (sso.ts `vouchingConnections`) */
  connections: (q: Queryable) => Promise<Vouching[]>;
  /** provider sign-ins with a confirmed email at these domains may join without an invite (FF_SIGNUP_DOMAINS) */
  signupDomains?: string[];
  /** The setup link's secret (betterAuth.ts setupTokenFor): the first account is made only with it, so whoever reaches
   *  a new server first can't make themselves its admin. Without one, no first account can be made. */
  setupToken?: string;
  /** the time, for invites (tests set it) */
  now?: () => Date;
};

/** How long an invite link works. */
const INVITE_DAYS = 7;

export type Access = ReturnType<typeof createAccess>;

// ---------------------------------------------------------------- what a role lets someone do

/** What the server asks of someone's role before a request (policy.ts RoleInfo): changing anything at all, and
 *  changing Settings. Reviews and break-glass have rules of their own (policy.ts reviewRefusal, switchPath). */
export type Right = keyof Pick<RoleInfo, 'changes' | 'changesSettings'>;

/** May this person do this: their role allows it (policy.ts), and their access hasn't been removed. */
export const may = (person: Pick<Person, 'role'> & { removed?: boolean }, right: Right) => !person.removed && roleInfo(person.role)[right];

const REFUSED: Record<Right, string> = {
  changes: 'viewers can look but not change anything: ask an admin for a role',
  changesSettings: 'only admins can change settings',
};
/** Refuses (403) what this person's role doesn't allow. */
export function mustBeAllowed(person: Pick<Person, 'role'> & { removed?: boolean }, right: Right): void {
  if (!may(person, right)) throw new HttpError(403, REFUSED[right]);
}

// ---------------------------------------------------------------- the people of this app

/** The roles that change settings, the admins (policy.ts): there is always one whose access isn't removed. */
const ADMINS = ROLES.filter((r) => roleInfo(r).changesSettings);
/** The lock a first sign-in and every change to people take: two first sign-ins at once can't both become admin,
 *  and the last admin can't be removed by two admins removing each other at once. */
const PEOPLE_LOCK = 727002;
const PERSON = `select key, name, role, removed_at is not null as removed from app_user where key = $1`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REMOVED: Refusal = { code: 'access_removed', message: 'An admin removed your access to CompanyFlags.' };
const SSO_REQUIRED: Refusal = { code: 'sso_required', message: 'Your organization signs in with single sign-on: use “Sign in with SSO”.' };
const INVITE_REQUIRED: Refusal = { code: 'invite_required', message: 'Ask an admin of CompanyFlags for an invite link.' };
const OUTSIDE_SSO: Refusal = {
  code: 'invite_required', message: 'Your identity provider signed you in, but this email isn’t at one of its email domains. Join with the invite link an admin sent you, or ask an admin for one.',
};

const clean = (email: unknown) => String(email ?? '').trim().toLowerCase();
const roleProblem = (role: unknown) => (isRole(role) ? null : `role: one of ${ROLES.join(', ')}`);

/** An email at one of these domains or their subdomains, as the SSO plugin matches them. */
const inDomains = (email: string, domains: readonly string[]) => {
  const at = email.split('@')[1]?.toLowerCase();
  return !!at && domains.some((d) => at === d || at.endsWith(`.${d}`));
};

export function createAccess(db: Db, opts: AccessOptions) {
  const { accounts, connections } = opts;
  const signupDomains = new Set(opts.signupDomains ?? []);
  const now = opts.now ?? (() => new Date());
  const inviteUntil = () => new Date(now().getTime() + INVITE_DAYS * 86_400_000).toISOString();

  /** How many people with an admin's role still have access (or whether this one does). */
  const activeAdmins = async (q: Queryable, email: string | null = null) => Number((await one<{ n: number }>(q,
    `select count(*)::int as n from app_user where role = any($1::text[]) and removed_at is null and ($2::text is null or key = $2)`,
    [ADMINS, email]))!.n);

  /** The setup link's secret, from the request: right, and nobody has an account yet. */
  const setupOpen = async (q: Queryable, setup: string | undefined) =>
    !!opts.setupToken && !!setup && sameSecret(sha256(setup), sha256(opts.setupToken)) && !(await accounts.any(q));

  /** The first account: made with the setup link, on a new install (no people yet). */
  const mayMakeFirstAccount = async (q: Queryable, setup: string | undefined) =>
    await setupOpen(q, setup) && !(await one(q, `select 1 from app_user limit 1`));

  /** Their domain has a connection that requires single sign-on, and they aren't an admin. */
  const ssoRequired = async (q: Queryable, email: string) => {
    if (!email.includes('@')) return false;
    if (!(await connections(q)).some((c) => c.requireSso && inDomains(email, c.domains))) return false;
    return !(await activeAdmins(q, email));
  };

  const newInvite = () => {
    const token = randomBytes(24).toString('base64url');
    return { token, hash: sha256(token) };
  };

  /** The person behind an email, added if they are new: the very first person is an admin, later ones viewers. */
  const person = async (who: Who): Promise<Person> => {
    const found = await one<Person>(db, PERSON, [who.email]);
    if (found) return found;
    return db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [PEOPLE_LOCK]);
      const again = await one<Person>(tx, PERSON, [who.email]);
      if (again) return again;
      const first = !(await one(tx, `select 1 from app_user limit 1`));
      return (await one<Person>(tx, `insert into app_user (key, name, role) values ($1, $2, $3)
        returning key, name, role, removed_at is not null as removed`, [who.email, who.name?.trim() || who.email, first ? 'admin' : 'viewer']))!;
    });
  };

  return {
    /** Who is asking: the person behind a signed-in email, added on their first sign-in (the very first person is an
     *  admin, later ones viewers). Refused when nobody is signed in (401) or an admin removed their access (403). */
    async signedIn(who: Who | null): Promise<Person> {
      if (!who) throw new HttpError(401, 'not signed in');
      const p = await person(who);
      if (p.removed) throw new HttpError(403, 'an admin removed your access to CompanyFlags');
      return p;
    },

    /** Whether this sign-in or new account may go ahead: null when it may, else why not (the rules at the top). */
    async admit(a: Attempt): Promise<Refusal | null> {
      const email = clean(a.email);
      // a returning password sign-in: someone whose access was removed has no password any more (removing access
      // deleted it), so only single sign-on can stand in the way
      if (a.with === 'password' && a.account === 'existing') return await ssoRequired(db, email) ? SSO_REQUIRED : null;
      const p = email ? await one<{ removed: boolean; invite_hash: string | null; invite_ok: boolean }>(db,
        `select removed_at is not null as removed, invite_hash, coalesce(invite_expires_at > $2::timestamptz, false) as invite_ok
         from app_user where key = $1`, [email, now().toISOString()]) : undefined;
      if (p?.removed) return REMOVED;
      // Google, GitHub or Microsoft, new or returning: where single sign-on is required, only the identity provider
      // says who still works there (a provider keeps confirming an email after its owner has left)
      if (a.with === 'provider' && await ssoRequired(db, email)) return SSO_REQUIRED;
      if (a.account === 'existing') return null;                       // a provider sign-in again, or one added to their account
      // nobody has an account yet: only the first one, made with the setup link
      if (!(await accounts.any(db))) return await mayMakeFirstAccount(db, a.setup) ? null : INVITE_REQUIRED;
      switch (a.with) {
        case 'password': {
          if (await ssoRequired(db, email)) return SSO_REQUIRED;
          const invited = !!a.invite && !!p?.invite_hash && p.invite_ok && sameSecret(p.invite_hash, sha256(a.invite));
          return invited ? null : INVITE_REQUIRED;
        }
        case 'sso': {
          // only at its own domains: a connection can't claim an email elsewhere, even one an admin added (with a role)
          const conn = (await connections(db)).find((c) => c.id === a.connection);
          return conn && inDomains(email, conn.domains) ? null : OUTSIDE_SSO;
        }
        case 'provider':
          return a.emailVerified && (p || signupDomains.has(email.split('@')[1] ?? '')) ? null : INVITE_REQUIRED;
      }
    },

    /** An account was made for this email: they are the admin if they are the first person, have the role an admin
     *  chose if they were added, and are a viewer otherwise. Their invite is used up, and the name they gave kept. */
    async joined(email: string, name?: string | null) {
      const key = clean(email);
      await person({ email: key, name: name ?? undefined });
      await db.query(`update app_user set name = $2, invite_hash = null, invite_expires_at = null where key = $1`, [key, name?.trim() || key]);
    },

    /** Everyone, removed people last (History still names them). */
    async people(): Promise<ListedPerson[]> {
      const rows = await all<{ key: string; name: string; role: Role; removed: boolean; invited: boolean }>(db,
        `select key, name, role, removed_at is not null as removed, invite_hash is not null as invited
         from app_user order by removed_at is not null, id`);
      return rows.map(({ removed, invited, ...r }) => ({ ...r, status: removed ? 'removed' : invited ? 'invited' : 'active' }));
    },

    /** An admin adds someone by email, with their role. They join with the invite link this returns
     *  (`#/join/<invite>`, shown once), by single sign-on at a connection's domains, or with a provider that confirms
     *  the same email. */
    async add(input: { email?: unknown; name?: unknown; role?: unknown }, actor: Actor) {
      const email = clean(input.email);
      if (!EMAIL.test(email)) throw new HttpError(422, 'email: their email address, e.g. sam@example.com');
      const role = input.role ?? 'viewer';
      const problem = roleProblem(role);
      if (problem) throw new HttpError(422, problem);
      const name = String(input.name ?? '').trim() || email;
      const { token, hash } = newInvite();
      return db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock($1)`, [PEOPLE_LOCK]);
        const cur = await one<{ removed: boolean }>(tx, `select removed_at is not null as removed from app_user where key = $1`, [email]);
        if (cur) throw new HttpError(409, cur.removed ? `${email}’s access was removed: invite them again from their row` : `${email} is already here`);
        await tx.query(`insert into app_user (key, name, role, invite_hash, invite_expires_at) values ($1, $2, $3, $4, $5::timestamptz)`,
          [email, name, role, hash, inviteUntil()]);
        await audit(tx, actor, { kind: 'person.add', after: { person: email, role } });
        return { key: email, name, role: role as Role, invite: token };
      });
    },

    /** A new invite link for someone who hasn't made an account yet (the last one stops working), or whose access was
     *  removed: inviting them again gives them back their role. */
    async invite(key: string, actor: Actor) {
      const { token, hash } = newInvite();
      return db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock($1)`, [PEOPLE_LOCK]);
        const cur = await one<{ role: Role; removed: boolean }>(tx, `select role, removed_at is not null as removed from app_user where key = $1`, [key]);
        if (!cur) throw new HttpError(404, `no person "${key}"`);
        if (!cur.removed && (await accounts.of(tx, [key])).has(key)) throw new HttpError(409, `${key} already has an account: they don’t need an invite`);
        await tx.query(`update app_user set invite_hash = $2, invite_expires_at = $3::timestamptz, removed_at = null where key = $1`, [key, hash, inviteUntil()]);
        await audit(tx, actor, { kind: 'person.invite', after: { person: key, role: cur.role } });
        return { key, role: cur.role, invite: token };
      });
    },

    /** A password reset link for someone with a password, made by an admin (this server sends no email). `token` asks
     *  the sign-in for one (betterAuth.ts passwordResetToken). Someone who signs in only with single sign-on or a
     *  provider has no password to reset, and someone whose access was removed is invited again instead. */
    async passwordReset(key: string, actor: Actor, token: (email: string) => Promise<string | null>) {
      const cur = await one<{ removed: boolean }>(db, `select removed_at is not null as removed from app_user where key = $1`, [key]);
      if (!cur) throw new HttpError(404, `no person "${key}"`);
      if (cur.removed) throw new HttpError(409, `${key}’s access was removed: invite them again instead`);
      if (!(await accounts.hasPassword(db, key))) {
        throw new HttpError(409, `${key} has no password to reset: they sign in with single sign-on or a provider`);
      }
      const t = await token(key);
      if (!t) throw new HttpError(500, 'the sign-in didn’t make a reset link');
      await db.transaction((tx) => audit(tx, actor, { kind: 'person.password_reset', after: { person: key } }));
      return { key, token: t };
    },

    /** An admin gives someone a role. There is always at least one admin. */
    async setRole(key: string, role: unknown, actor: Actor) {
      const problem = roleProblem(role);
      if (problem) throw new HttpError(422, problem);
      return db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock($1)`, [PEOPLE_LOCK]);
        const cur = await one<{ role: Role; removed: boolean }>(tx, `select role, removed_at is not null as removed from app_user where key = $1`, [key]);
        if (!cur) throw new HttpError(404, `no person "${key}"`);
        if (cur.removed) throw new HttpError(409, `${key}’s access was removed: invite them again first`);
        if (may(cur, 'changesSettings') && !roleInfo(role as Role).changesSettings && await activeAdmins(tx) <= 1) {
          throw new HttpError(409, 'this is the only admin: make someone else an admin first');
        }
        await tx.query(`update app_user set role = $2 where key = $1`, [key, role]);
        await audit(tx, actor, { kind: 'person.role', before: { person: key, role: cur.role }, after: { person: key, role } });
        return { key, role: role as Role };
      });
    },

    /** An admin removes someone's access: they are signed out everywhere at once and their accounts are deleted.
     *  Their row stays (History names them) and keeps its role, for if they are invited again. */
    async remove(key: string, actor: Actor) {
      if (key === actor.name) throw new HttpError(409, 'you can’t remove your own access: ask another admin');
      return db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock($1)`, [PEOPLE_LOCK]);
        const cur = await one<{ role: Role; removed: boolean }>(tx, `select role, removed_at is not null as removed from app_user where key = $1`, [key]);
        if (!cur) throw new HttpError(404, `no person "${key}"`);
        if (cur.removed) return { key, removed: true };
        if (may(cur, 'changesSettings') && await activeAdmins(tx) <= 1) throw new HttpError(409, 'this is the only admin: make someone else an admin first');
        await tx.query(`update app_user set removed_at = now(), invite_hash = null, invite_expires_at = null where key = $1`, [key]);
        await accounts.remove(tx, key);
        // their access tokens and OAuth sign-ins end for good: inviting them again gives back the role, not old tokens
        await tx.query(`update access_token set revoked_at = now() where revoked_at is null and person_id = (select id from app_user where key = $1)`, [key]);
        await tx.query(`delete from oauth_code where person_id = (select id from app_user where key = $1)`, [key]);
        await audit(tx, actor, { kind: 'person.remove', before: { person: key, role: cur.role } });
        return { key, removed: true };
      });
    },

    /** The person an invite link is for, while it still works. */
    async invitedBy(token: string): Promise<{ key: string; name: string } | undefined> {
      if (!token || token.length > 100) return undefined;
      return one(db, `select key, name from app_user where invite_hash = $1 and invite_expires_at > $2::timestamptz and removed_at is null`,
        [sha256(token), now().toISOString()]);
    },

    /** What the sign-in page offers: making the first account (to whoever opened the setup link, while nobody has
     *  an account: they become the admin), and single sign-on (an admin added a connection). Without the setup link,
     *  the page doesn't say whether anyone has an account. */
    async signInOptions(setup?: string) {
      return { firstPerson: await setupOpen(db, setup), sso: (await connections(db)).length > 0 };
    },

    /** Whether this setup link's secret works now: it is right, and nobody has an account yet. */
    setupOpen: (setup: string | undefined) => setupOpen(db, setup),

    /** Whether nobody has an account yet: the server then prints the setup link when it starts (index.ts). */
    async needsSetup() {
      return !(await accounts.any(db));
    },

    /** A single sign-on connection is being removed (sso.ts): the sign-ins made with it go too. People keep their role
     *  and any other way in, and can be invited to make a password account. */
    async connectionRemoved(q: Queryable, id: string) {
      await accounts.removeSignInsWith(q, id);
    },

    /** A connection requires single sign-on from now (sso.ts): everyone at its domains but the admins is signed out,
     *  so a session made with a password or a provider before doesn't go on, and signs in again with single sign-on. */
    async ssoNowRequired(q: Queryable, domains: string[]) {
      const admins = await all<{ key: string }>(q, `select key from app_user where role = any($1::text[]) and removed_at is null`, [ADMINS]);
      await accounts.endSessionsAt(q, domains, admins.map((a) => a.key));
    },
  };
}
