// Better Auth (better-auth.com) is the sign-in behind the access module (access.ts): it keeps people's accounts —
// passwords, sign-ins with Google, GitHub or Microsoft, single sign-on with the company's identity provider (SAML or
// OIDC, through its SSO plugin; sso.ts manages the connections) — and their sessions (a cookie).
// Its tables are the auth_* ones and sso_provider (migrations 0004, 0005); it reaches them through the same
// database as everything else (db.ts), Postgres or embedded PGlite, by way of a small Kysely dialect below.
// It is an adapter (docs/design/adr/0002-better-auth-is-an-adapter-behind-people-and-access.md): who may have an account,
// and what they may do, is decided by the access module. Its hooks ask `access.admit` before a password sign-in and
// before an account is made or a provider signs someone in, and tell `access.joined` once an account is made.
// `betterAuthAccounts` is how the access module reads and deletes accounts; nothing else touches the auth_* rows.

import { sso } from '@better-auth/sso';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type Dialect, type Driver, type Kysely, type QueryResult } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { Access, Accounts, Attempt, Who } from './access.ts';
import { all, HttpError, one, type Db, type Queryable } from './db.ts';

export type Provider = { clientId: string; clientSecret: string };
export type AuthSettings = {
  /** Signs session cookies. Required in production (BETTER_AUTH_SECRET); elsewhere one is made and kept in the database. */
  secret?: string;
  /** Where the console is, e.g. https://flags.example.com (BETTER_AUTH_URL). Required in production. */
  baseURL?: string;
  /** Sign-ins through a provider, with a verified email at one of these domains, may join without an invite (as viewers):
   *  one of the access module's admission rules (access.ts), set here with the providers. */
  signupDomains?: string[];
  google?: Provider;
  github?: Provider;
  microsoft?: Provider & { tenantId?: string };
  /** More origins Better Auth trusts, e.g. an identity provider on a private network (BETTER_AUTH_TRUSTED_ORIGINS). */
  trustedOrigins?: string[];
  production?: boolean;
  /** Where sign-in rate limits read the client's address (ipAddressFor). By default the connection's own address; behind
   *  a proxy, the header it sets (FF_CLIENT_IP_HEADER, e.g. cf-connecting-ip) or X-Forwarded-For past the proxies'
   *  addresses (FF_TRUSTED_PROXIES, comma-separated, e.g. 10.0.0.0/8). */
  clientIp?: { header?: string; trustedProxies?: string[] };
};

/** The header this server sets to the connection's own address for Better Auth's rate limits, replacing any value a
 *  client sent (identity.ts). Read only when no proxy setting says otherwise. */
export const CLIENT_IP_HEADER = 'x-ff-client-ip';

/** How long a password reset link works. */
export const RESET_LINK_HOURS = 24;

/** Better Auth's `advanced.ipAddress`: which header holds the client's address, and which proxies to look past. */
export function ipAddressFor(s: Pick<AuthSettings, 'clientIp'>) {
  const header = s.clientIp?.header?.toLowerCase();
  const trustedProxies = s.clientIp?.trustedProxies?.length ? s.clientIp.trustedProxies : undefined;
  if (header) return { ipAddressHeaders: [header], ...(trustedProxies ? { trustedProxies } : {}) };
  if (trustedProxies) return { ipAddressHeaders: ['x-forwarded-for'], trustedProxies };
  return { ipAddressHeaders: [CLIENT_IP_HEADER] };
}

/** The request header that carries an invite link's secret when someone creates a password account. */
export const INVITE_HEADER = 'x-invite';

const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const provider = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : undefined);
const origins = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function authSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const microsoft = provider(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET);
  return {
    secret: env.BETTER_AUTH_SECRET || undefined,
    baseURL: env.BETTER_AUTH_URL || undefined,
    signupDomains: list(env.FF_SIGNUP_DOMAINS),
    google: provider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: provider(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    microsoft: microsoft && { ...microsoft, tenantId: env.MICROSOFT_TENANT_ID || undefined },
    trustedOrigins: origins(env.BETTER_AUTH_TRUSTED_ORIGINS),
    production: env.NODE_ENV === 'production',
    clientIp: { header: env.FF_CLIENT_IP_HEADER?.trim() || undefined, trustedProxies: origins(env.FF_TRUSTED_PROXIES) },
  };
}

/** The provider sign-ins that are set up, for the sign-in page. */
export const providersOf = (s: AuthSettings) => (['google', 'github', 'microsoft'] as const).filter((p) => s[p]);

// Better Auth's names for its columns, in this schema's snake_case
const TIMES = { createdAt: 'created_at', updatedAt: 'updated_at' };

/** The sign-in can't start as configured (production needs a secret and the console's address). */
export class SetupError extends Error {}

/** What the rest of the app uses of Better Auth. */
export type BetterAuth = {
  /** its endpoints: sign up, sign in, sign out, provider callbacks, single sign-on, the session (mounted at /api/auth) */
  handler: (request: Request) => Promise<Response>;
  /** who is signed in, from a request's session cookie */
  who: (headers: Headers) => Promise<Who | null>;
  /** a password reset token for this email (access.ts passwordReset): Better Auth makes and keeps it; it works once */
  passwordResetToken: (email: string) => Promise<string | null>;
  /** keeps a new single sign-on connection in the SSO plugin, as the admin whose request this is (sso.ts) */
  registerConnection: (body: Record<string, unknown>, headers: Headers) => Promise<void>;
};

export async function createAuth(db: Db, s: AuthSettings, access: Access): Promise<BetterAuth> {
  const resetTokens = new Map<string, string>();     // email → the reset token Better Auth just made (sendResetPassword)
  if (s.production && !s.secret) throw new SetupError('set BETTER_AUTH_SECRET (at least 32 random characters, e.g. openssl rand -base64 32) to sign people in');
  if (s.production && s.secret!.length < 32) throw new SetupError('BETTER_AUTH_SECRET is too short: use at least 32 random characters, e.g. openssl rand -base64 32');
  if (s.production && !s.baseURL) throw new SetupError('set BETTER_AUTH_URL to the console’s address, e.g. https://flags.example.com');
  const microsoft = s.microsoft && { clientId: s.microsoft.clientId, clientSecret: s.microsoft.clientSecret, tenantId: s.microsoft.tenantId ?? 'common' };

  const auth = betterAuth({
    appName: 'CompanyFeatures',
    basePath: '/api/auth',
    // locally the console may be on another port (the Vite dev server proxies /api): any localhost address works
    baseURL: s.baseURL ?? {
      allowedHosts: ['localhost', 'localhost:*', '127.0.0.1', '127.0.0.1:*'], protocol: 'http',
      fallback: `http://localhost:${process.env.PORT ?? 8787}`,       // a request without a Host header
    },
    secret: s.secret ?? await localSecret(db),
    database: { dialect: dbDialect(db), type: 'postgres', transaction: false },
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true, minPasswordLength: 10,
      // Password resets: this server sends no email, so an admin makes a reset link in People (access.ts
      // passwordReset), and the token Better Auth makes for it is kept here until the admin's request takes it. Asking
      // for a reset by email is switched off (disabledPaths). A reset signs the person out everywhere.
      sendResetPassword: async ({ user, token }) => { resetTokens.set(user.email.toLowerCase(), token); },
      resetPasswordTokenExpiresIn: RESET_LINK_HOURS * 3600,
      revokeSessionsOnPasswordReset: true,
    },
    socialProviders: {
      ...(s.google && { google: { ...s.google, prompt: 'select_account' as const } }),
      ...(s.github && { github: s.github }),
      ...(microsoft && { microsoft }),
    },
    trustedOrigins: s.trustedOrigins,
    // said here rather than left to Better Auth's reading of NODE_ENV: rate limits on sign-in in production only,
    // and the Origin check always (Better Auth would skip it when NODE_ENV=test)
    rateLimit: { enabled: !!s.production },
    advanced: { disableOriginCheck: false, ipAddress: ipAddressFor(s) },
    // nobody changes or deletes their own account here: an admin removes access (access.ts).
    // Single sign-on connections are managed by admins through the console's API (sso.ts), never these endpoints.
    disabledPaths: ['/delete-user', '/change-email', '/update-user', '/request-password-reset', '/forget-password', ...SSO_ADMIN_PATHS],
    plugins: [sso({
      // a connection is trusted for its email domains (it vouches for those emails and can sign in to their
      // existing accounts) once marked verified: admins add connections, and adding marks them (sso.ts)
      domainVerification: { enabled: true },
      providersLimit: 1000,
      schema: {
        ssoProvider: {
          modelName: 'sso_provider',
          fields: {
            providerId: 'provider_id', oidcConfig: 'oidc_config', samlConfig: 'saml_config', userId: 'user_id',
            organizationId: 'organization_id', domainVerified: 'domain_verified',
          },
        },
      },
    })],
    // a returning password sign-in: the access module may refuse it (a connection requires single sign-on)
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '');
        const refusal = await access.admit({ email, with: 'password', account: 'existing' });
        if (refusal) throw new APIError('FORBIDDEN', { code: refusal.code, message: refusal.message });
      }),
    },
    user: {
      modelName: 'auth_user',
      fields: { emailVerified: 'email_verified', ...TIMES },
      // before an account is made, and whenever a provider or single sign-on signs someone in: the access module decides
      validateUserInfo: async ({ user, source }, ctx) => {
        const refusal = await access.admit(attemptOf(user, source, ctx));
        return refusal ? { error: refusal.code, errorDescription: refusal.message } : undefined;
      },
    },
    session: {
      modelName: 'auth_session',
      fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', ...TIMES },
    },
    account: {
      // Someone with a password account can later sign in with single sign-on, Google… as the same person.
      // Better Auth would first want the password account's email verified (we send no email); it's safe without:
      // the access module only lets a password account be made from an invite link an admin sent to that address, or
      // as the very first account, so nobody can claim someone else's email ahead of them. The provider must still
      // vouch for the email.
      accountLinking: { requireLocalEmailVerified: false },
      // providers' access, refresh and ID tokens are kept encrypted with the secret (tokens stored before stay readable)
      encryptOAuthTokens: true,
      modelName: 'auth_account',
      fields: {
        userId: 'user_id', accountId: 'account_id', providerId: 'provider_id', accessToken: 'access_token', refreshToken: 'refresh_token',
        idToken: 'id_token', accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at', ...TIMES,
      },
    },
    verification: { modelName: 'auth_verification', fields: { expiresAt: 'expires_at', ...TIMES } },
    databaseHooks: {
      user: {
        create: {
          // their role (the access module): the admin if they're the first, what the admin chose if invited, otherwise viewer
          after: async (user) => { await access.joined(user.email, user.name); },
        },
      },
    },
  });

  return {
    handler: (request) => auth.handler(request),
    passwordResetToken: async (email) => {
      const key = email.toLowerCase();
      resetTokens.delete(key);
      await auth.api.requestPasswordReset({ body: { email: key, redirectTo: '/' } });
      const token = resetTokens.get(key) ?? null;
      resetTokens.delete(key);
      return token;
    },
    who: async (headers) => {
      const session = await auth.api.getSession({ headers });
      return session ? { email: session.user.email.toLowerCase(), name: session.user.name } : null;
    },
    registerConnection: async (body, headers) => {
      try {
        await auth.api.registerSSOProvider({ body: body as any, headers });
      } catch (e) {
        throw asHttpError(e);
      }
    },
  };
}

/** What Better Auth tells its validateUserInfo hook, in the access module's words. */
type UserInfo = { email?: string | null; emailVerified?: boolean | null };
type Source = { action: string; method: string; sso?: { providerId: string } };
function attemptOf(user: UserInfo, source: Source, ctx?: { headers?: Headers; request?: Request } | null): Attempt {
  const email = String(user.email ?? '');
  const account = source.action === 'create-user' ? 'new' : 'existing';  // else a returning sign-in, or a way in added
  if (source.sso?.providerId) return { email, with: 'sso', account, connection: source.sso.providerId };
  if (source.method === 'email-password') {
    return { email, with: 'password', account, invite: ctx?.headers?.get(INVITE_HEADER) ?? ctx?.request?.headers.get(INVITE_HEADER) ?? undefined };
  }
  return { email, with: 'provider', account, emailVerified: user.emailVerified === true };
}

/** Better Auth's accounts, for the access module (access.ts `Accounts`): auth_user, one per email; its sessions and
 *  ways in (auth_session, auth_account) are deleted with it. */
export const betterAuthAccounts: Accounts = {
  any: async (q) => !!(await one(q, `select 1 from auth_user limit 1`)),
  of: async (q, emails) => new Set((await all<{ email: string }>(q,
    `select lower(email) as email from auth_user where lower(email) = any($1::text[])`, [emails])).map((r) => r.email)),
  remove: async (q, email) => { await q.query(`delete from auth_user where lower(email) = $1`, [email]); },
  hasPassword: async (q, email) => !!(await one(q, `select 1 from auth_account a join auth_user u on u.id = a.user_id
    where lower(u.email) = $1 and a.provider_id = 'credential'`, [email])),
  // the identity provider may be why its connection is removed: whoever signed in with it is signed out everywhere
  removeSignInsWith: async (q, connection) => {
    await q.query(`delete from auth_session where user_id in (select user_id from auth_account where provider_id = $1)`, [connection]);
    await q.query(`delete from auth_account where provider_id = $1`, [connection]);
  },
};

/** Better Auth's endpoints for managing SSO connections: open to any signed-in person, so they're switched off. */
const SSO_ADMIN_PATHS = ['/sso/register', '/sso/update-provider', '/sso/delete-provider', '/sso/providers', '/sso/get-provider',
  '/sso/request-domain-verification', '/sso/verify-domain'];

function asHttpError(e: unknown): Error {
  if (e instanceof APIError) {
    const status = typeof e.statusCode === 'number' ? e.statusCode : 422;
    const message = (e.body as { message?: string } | undefined)?.message || e.message;
    return new HttpError(status >= 500 ? 502 : status === 401 ? 403 : status, message.charAt(0).toLowerCase() + message.slice(1));
  }
  return e as Error;
}

/** Away from production, a secret made on the first start and kept in the database, so sessions outlive restarts. */
async function localSecret(db: Db): Promise<string> {
  await db.query(`insert into server_secret (name, value) values ('auth', $1) on conflict (name) do nothing`, [randomBytes(32).toString('base64url')]);
  return (await one<{ value: string }>(db, `select value from server_secret where name = 'auth'`))!.value;
}

/** Kysely (which Better Auth builds its queries with) on top of our database. Each query runs on its own:
 *  Better Auth is told not to use transactions (`transaction: false`). */
export function dbDialect(db: Queryable): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
      const r = await db.query<R>(q.sql, [...q.parameters]);
      return r.affected === undefined ? { rows: r.rows } : { rows: r.rows, numAffectedRows: BigInt(r.affected) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error('streaming queries are not supported'); },
  };
  const noTransactions = async () => { throw new Error('transactions are not supported here: Better Auth runs with transaction: false'); };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: noTransactions,
    commitTransaction: noTransactions,
    rollbackTransaction: noTransactions,
    releaseConnection: async () => {},
    destroy: async () => {},                    // the database is closed by its owner (index.ts)
  };
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (k: Kysely<any>) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
