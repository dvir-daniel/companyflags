// People's accounts: the sign-in library behind the access module (access.ts) keeps them — passwords, sign-ins with
// Google, GitHub or Microsoft, single sign-on with the organization's identity provider (SAML or OIDC, through its SSO
// plugin; sso.ts manages the connections) — and their sessions (a cookie).
// Password accounts can add two-factor sign-in (its twoFactor plugin: an authenticator app, and recovery codes).
// Each sign-in, and each one that doesn't go through, is told to the access module for History (`signedInNow`,
// `signInFailed`); so are the roles a connection's groups give (sso.ts group roles).
// Its tables are the auth_* ones and sso_provider (migrations 0004, 0005, 0020); it reaches them through the same
// database as everything else (db.ts), Postgres or embedded PGlite, by way of a small Kysely dialect below.
// It is an adapter: who may have an account,
// and what they may do, is decided by the access module. Its hooks ask `access.admit` before a password sign-in and
// before an account is made or a provider signs someone in, and tell `access.joined` once an account is made.
// `authAccounts` is how the access module reads and deletes accounts; nothing else touches the auth_* rows.

import { sso } from '@better-auth/sso';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type Dialect, type Driver, type Kysely, type QueryResult } from 'kysely';
import { createHmac, randomBytes } from 'node:crypto';
import type { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { Access, Accounts, Attempt, SignInWay, Who } from './access.ts';
import { all, HttpError, one, type Db, type Queryable } from './db.ts';
import { connectionUsed, groupRolesOf, roleFromGroups } from './sso.ts';
import { guardedFetches } from './publicFetch.ts';
import { hideLibrarySettings, renamedProblem } from './renamed.ts';

export type Provider = { clientId: string; clientSecret: string };
export type AuthSettings = {
  /** Signs session cookies. Required in production (FF_SECRET); elsewhere one is made and kept in the database. */
  secret?: string;
  /** Where the console is, e.g. https://flags.example.com (FF_PUBLIC_URL). Required in production. */
  baseURL?: string;
  /** Sign-ins through a provider, with a verified email at one of these domains, may join without an invite (with the join role, access.ts):
   *  one of the access module's admission rules (access.ts), set here with the providers. */
  signupDomains?: string[];
  google?: Provider;
  github?: Provider;
  microsoft?: Provider & { tenantId?: string };
  /** More origins the sign-in trusts, e.g. an identity provider on a private network (FF_TRUSTED_ORIGINS). */
  trustedOrigins?: string[];
  production?: boolean;
  /** Rate limits on sign-in. From the environment: on unless NODE_ENV is development or test, so a server started
   *  without NODE_ENV has them. Left out: in production only. */
  rateLimit?: boolean;
  /** Where sign-in rate limits read the client's address (clientAddressFor). By default the connection's own address.
   *  Behind a proxy, for connections from the proxies' addresses (FF_TRUSTED_PROXIES, comma-separated, e.g.
   *  10.0.0.0/8): the header the proxy sets (FF_CLIENT_IP_HEADER, e.g. cf-connecting-ip), or X-Forwarded-For past the
   *  proxies. A connection from anywhere else is its own address, whatever its headers say. */
  clientIp?: { header?: string; trustedProxies?: string[] };
  /** Where single sign-on is required, the most hours a session lasts (FF_SSO_SESSION_HOURS; access.ts). */
  ssoSessionHours?: number;
  /** How names are resolved when single sign-on reaches an identity provider: the system's, unless a test hands it another. */
  lookup?: typeof dnsLookup;
};

/** The header this server sets to the client's address for the sign-in's rate limits, replacing any value a client
 *  sent (identity.ts, clientAddressFor). The sign-in library reads only this one. */
export const CLIENT_IP_HEADER = 'x-ff-client-ip';

/** How long a password reset link works. */
export const RESET_LINK_HOURS = 24;

/** The sign-in library's `advanced.ipAddress`: the header this server sets (identity.ts), never one a client could send. */
export const ipAddressFor = () => ({ ipAddressHeaders: [CLIENT_IP_HEADER] });

/** The proxies' addresses (FF_TRUSTED_PROXIES), and why the settings can't be used, if they can't. */
function proxyList(s: Pick<AuthSettings, 'clientIp'>): { proxies: BlockList; problem: string | null } {
  const proxies = new BlockList();
  const header = s.clientIp?.header?.trim();
  const entries = s.clientIp?.trustedProxies ?? [];
  for (const entry of entries) {
    const [net, bits, extra] = entry.split('/');
    const family = isIP(net);
    const max = family === 4 ? 32 : 128;
    const n = bits === undefined ? max : /^[0-9]+$/.test(bits) ? Number(bits) : NaN;
    if (!family || extra !== undefined || !(n >= 0 && n <= max)) {
      return { proxies, problem: `FF_TRUSTED_PROXIES: "${entry}" isn’t an address or a range like 10.0.0.0/8` };
    }
    proxies.addSubnet(net, n, family === 4 ? 'ipv4' : 'ipv6');
  }
  if (header && !entries.length) {
    return { proxies, problem: `FF_CLIENT_IP_HEADER needs FF_TRUSTED_PROXIES: the addresses of the proxies that set ${header} (e.g. 10.0.0.0/8), so a client that reaches this server directly can’t set it` };
  }
  return { proxies, problem: null };
}

/** Why the client address settings can't be used, or null. The server doesn't start with them (authSecret). */
export const clientIpProblem = (s: Pick<AuthSettings, 'clientIp'>) => proxyList(s).problem;

/** An address as written: an IPv4 address written as IPv6 (::ffff:10.0.0.1) as itself. */
const plain = (a: string) => a.trim().replace(/^::ffff:(?=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$)/i, '');

/** The client's address for sign-in rate limits, from the connection's own address and the request's headers. Only a
 *  connection from one of the proxies (FF_TRUSTED_PROXIES) is believed about someone else's address: its header
 *  (FF_CLIENT_IP_HEADER), or the last address in X-Forwarded-For that isn't one of the proxies. */
export function clientAddressFor(s: Pick<AuthSettings, 'clientIp'>) {
  const header = s.clientIp?.header?.trim().toLowerCase();
  const { proxies } = proxyList(s);
  const trusted = (a: string) => { const f = isIP(a); return f !== 0 && proxies.check(a, f === 4 ? 'ipv4' : 'ipv6'); };
  return (headers: Headers, connection: string | undefined): string | undefined => {
    const from = connection ? plain(connection) : undefined;
    if (!from || !trusted(from)) return from;
    if (header) {
      const said = plain(headers.get(header) ?? '');
      return isIP(said) ? said : from;
    }
    const hops = (headers.get('x-forwarded-for') ?? '').split(',').map(plain).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isIP(hops[i])) return from;
      if (!trusted(hops[i])) return hops[i];
    }
    return from;
  };
}

/** The request header that carries an invite link's secret when someone creates a password account. */
export const INVITE_HEADER = 'x-invite';

/** The setup link's secret, when the first account is made (access.ts): in this header, or in this cookie, which the
 *  setup link sets (identity.ts), so the console's own sign-up and provider sign-ins carry it. */
export const SETUP_HEADER = 'x-setup';
export const SETUP_COOKIE = 'companyflags.setup';

/** The setup link's secret: made from the sign-in's secret, so every server on one database prints the same link and
 *  nothing about it is stored. It works only while nobody has an account (access.ts). */
export const setupTokenFor = (secret: string) => createHmac('sha256', secret).update('companyflags/setup').digest('base64url').slice(0, 32);

/** The setup link's secret a request carries: the header, else the cookie. */
export function setupOf(headers: Headers | undefined | null): string | undefined {
  const said = headers?.get(SETUP_HEADER)?.trim();
  if (said) return said;
  for (const part of (headers?.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SETUP_COOKIE) return value.join('=') || undefined;
  }
  return undefined;
}

const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const provider = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : undefined);
const origins = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** The sign-in's settings from the environment. An old name set without its new one is refused (renamed.ts). */
export function authSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const renamed = renamedProblem(env);
  if (renamed) throw new SetupError(renamed);
  const microsoft = provider(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET);
  return {
    secret: env.FF_SECRET || undefined,
    baseURL: env.FF_PUBLIC_URL || undefined,
    signupDomains: list(env.FF_SIGNUP_DOMAINS),
    google: provider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: provider(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    microsoft: microsoft && { ...microsoft, tenantId: env.MICROSOFT_TENANT_ID || undefined },
    trustedOrigins: origins(env.FF_TRUSTED_ORIGINS),
    production: env.NODE_ENV === 'production',
    rateLimit: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
    clientIp: { header: env.FF_CLIENT_IP_HEADER?.trim() || undefined, trustedProxies: origins(env.FF_TRUSTED_PROXIES) },
    ssoSessionHours: hours(env.FF_SSO_SESSION_HOURS),
  };
}

/** FF_SSO_SESSION_HOURS: a number of hours from 1 to 720, or unset. */
function hours(v?: string): number | undefined {
  if (!v?.trim()) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 720) throw new SetupError(`FF_SSO_SESSION_HOURS: hours from 1 to 720, e.g. 12 (it is "${v}")`);
  return n;
}

/** Whether sign-in has rate limits: as set, or in production. */
export const rateLimitsOn = (s: Pick<AuthSettings, 'rateLimit' | 'production'>) => s.rateLimit ?? !!s.production;

/** The provider sign-ins that are set up, for the sign-in page. */
export const providersOf = (s: AuthSettings) => (['google', 'github', 'microsoft'] as const).filter((p) => s[p]);

// The sign-in library's names for its columns, in this schema's snake_case
const TIMES = { createdAt: 'created_at', updatedAt: 'updated_at' };

/** The sign-in can't start as configured (production needs a secret and the console's address). */
export class SetupError extends Error {}

/** What the rest of the app uses of the sign-in. */
export type AuthService = {
  /** its endpoints: sign up, sign in, sign out, provider callbacks, single sign-on, the session (mounted at /api/auth) */
  handler: (request: Request) => Promise<Response>;
  /** who is signed in, from a request's session cookie */
  who: (headers: Headers) => Promise<Who | null>;
  /** a password reset token for this email (access.ts passwordReset): the sign-in makes and keeps it; it works once */
  passwordResetToken: (email: string) => Promise<string | null>;
  /** keeps a new single sign-on connection in the SSO plugin, as the admin whose request this is (sso.ts) */
  registerConnection: (body: Record<string, unknown>, headers: Headers) => Promise<void>;
};

/** The secret that signs session cookies and makes the setup link: FF_SECRET, required in production;
 *  elsewhere one made on the first start and kept in the database. Settings the sign-in can't start with are refused
 *  (SetupError). */
export async function authSecret(db: Db, s: AuthSettings): Promise<string> {
  if (s.production && !s.secret) throw new SetupError('set FF_SECRET (at least 32 random characters, e.g. openssl rand -base64 32) to sign people in');
  // checked here, everywhere, so the sign-in library never warns about it in words of its own
  if (s.secret && s.secret.length < 32) throw new SetupError('FF_SECRET is too short: use at least 32 random characters, e.g. openssl rand -base64 32');
  if (s.secret && lowEntropy(s.secret)) throw new SetupError('FF_SECRET repeats too few characters to be random: make one with openssl rand -base64 32');
  if (s.production && !s.baseURL) throw new SetupError('set FF_PUBLIC_URL to the console’s address, e.g. https://flags.example.com');
  const problem = clientIpProblem(s);
  if (problem) throw new SetupError(problem);
  return s.secret ?? await localSecret(db);
}

export async function createAuth(db: Db, s: AuthSettings, access: Access): Promise<AuthService> {
  const resetTokens = new Map<string, string>();     // email → the reset token the sign-in just made (sendResetPassword)
  const secret = await authSecret(db, s);
  hideLibrarySettings();                             // it reads only what is passed here (renamed.ts)
  const microsoft = s.microsoft && { clientId: s.microsoft.clientId, clientSecret: s.microsoft.clientSecret, tenantId: s.microsoft.tenantId ?? 'common' };

  const auth = betterAuth({
    appName: 'CompanyFlags',
    basePath: '/api/auth',
    // locally the console may be on another port (the Vite dev server proxies /api): any localhost address works
    baseURL: s.baseURL ?? {
      allowedHosts: ['localhost', 'localhost:*', '127.0.0.1', '127.0.0.1:*'], protocol: 'http',
      fallback: `http://localhost:${process.env.PORT ?? 8787}`,       // a request without a Host header
    },
    secret,
    database: { dialect: dbDialect(db), type: 'postgres', transaction: false },
    telemetry: { enabled: false },
    // its log lines in this server's words: "sign-in: …"
    logger: { log: libraryLog },
    emailAndPassword: {
      enabled: true, minPasswordLength: 10,
      // Password resets: this server sends no email, so an admin makes a reset link in People (access.ts
      // passwordReset), and the token the sign-in makes for it is kept here until the admin's request takes it. Asking
      // for a reset by email is switched off (disabledPaths). A reset signs the person out everywhere.
      sendResetPassword: async ({ user, token }) => { resetTokens.set(user.email.toLowerCase(), token); },
      resetPasswordTokenExpiresIn: RESET_LINK_HOURS * 3600,
      revokeSessionsOnPasswordReset: true,
      // a reset link also turns two-factor sign-in off, for someone who lost their authenticator and their recovery
      // codes: they set it up again (an admin made the link, as they could invite them again)
      onPasswordReset: async ({ user }) => {
        await db.query(`delete from auth_two_factor where user_id = $1`, [user.id]);
        await db.query(`update auth_user set two_factor_enabled = false where id = $1`, [user.id]);
      },
    },
    socialProviders: {
      ...(s.google && { google: { ...s.google, prompt: 'select_account' as const } }),
      ...(s.github && { github: s.github }),
      ...(microsoft && { microsoft }),
    },
    trustedOrigins: s.trustedOrigins,
    // said here rather than left to the library's reading of NODE_ENV: rate limits on sign-in as set (rateLimitsOn),
    // and the Origin check always (the library would skip it when NODE_ENV=test)
    rateLimit: { enabled: rateLimitsOn(s) },
    // its cookies are named after this server (companyflags.session_token, …)
    advanced: { disableOriginCheck: false, ipAddress: ipAddressFor(), cookiePrefix: 'companyflags' },
    // nobody changes or deletes their own account here: an admin removes access (access.ts).
    // Single sign-on connections are managed by admins through the console's API (sso.ts), never these endpoints.
    disabledPaths: ['/delete-user', '/change-email', '/update-user', '/request-password-reset', '/forget-password', ...SSO_ADMIN_PATHS, ...NO_EMAIL_CODES],
    plugins: [twoFactor({
      issuer: 'CompanyFlags',
      // the twoFactor plugin's tables, in this schema's names (migration 0020)
      schema: {
        user: { fields: { twoFactorEnabled: 'two_factor_enabled' } },
        twoFactor: {
          modelName: 'auth_two_factor',
          fields: { userId: 'user_id', backupCodes: 'backup_codes', failedVerificationCount: 'failed_verification_count', lockedUntil: 'locked_until' },
        },
      },
    }), sso({
      // a connection is trusted for its email domains (it vouches for those emails and can sign in to their
      // existing accounts) once marked verified: admins add connections, and adding marks them (sso.ts)
      domainVerification: { enabled: true },
      providersLimit: 1000,
      // each sign-in with a connection that has group roles: the role its groups give (sso.ts, access.ts groupRole)
      provisionUserOnEveryLogin: true,
      provisionUser: async ({ user, userInfo, provider }) => {
        try {
          const role = roleFromGroups(await groupRolesOf(db, provider.providerId), userInfo.groups, (await access.rules()).joinRole);
          if (role) await access.groupRole(user.email, role, provider.providerId);
        } catch (e) {
          console.error(`single sign-on ${provider.providerId}: the role from groups wasn’t set: ${(e as Error).message}`);
        }
      },
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
        if (refusal) {
          await access.signInFailed(email, { with: 'password' }, refusal.code);
          throw new APIError('FORBIDDEN', { code: refusal.code, message: refusal.message });
        }
      }),
      // each sign-in, for History: the session it made (a password sign-in that asks for a second factor isn't one
      // yet: its code is), or why it didn't go through
      after: createAuthMiddleware(async (ctx) => {
        const way = signInWay(ctx.path, ctx.params as Record<string, string> | undefined);
        if (!way) return;
        const made = ctx.context.newSession;
        const twoFactorStep = way.with === 'two-factor' || way.with === 'recovery code';
        // a code checked while signed in is setting two-factor up, not signing in
        const signingIn = !twoFactorStep || !!(await ctx.getSignedCookie(ctx.context.createAuthCookie('two_factor').name, ctx.context.secret));
        if (!signingIn) return;
        if (made?.user) {
          if (way.with === 'password' && (made.user as { twoFactorEnabled?: boolean }).twoFactorEnabled) return;
          await access.signedInNow(made.user.email, way);
          if (way.with === 'sso' && way.connection) await connectionUsed(db, way.connection);
          return;
        }
        const failed = ctx.context.returned;
        // a refused sign-up, or a refused provider or single sign-on, is told by validateUserInfo
        if (!(failed instanceof APIError) || ctx.path === '/sign-up/email' || (way.with !== 'password' && !twoFactorStep)) return;
        const code = (failed.body as { code?: string } | undefined)?.code ?? String(failed.status);
        let email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '');
        if (twoFactorStep) {
          const pending = await ctx.getSignedCookie(ctx.context.createAuthCookie('two_factor').name, ctx.context.secret);
          const v = pending ? await ctx.context.internalAdapter.findVerificationValue(pending) : null;
          email = v ? (await ctx.context.internalAdapter.findUserById(v.value))?.email ?? '' : '';
        }
        await access.signInFailed(email, way, code);
      }),
    },
    user: {
      modelName: 'auth_user',
      fields: { emailVerified: 'email_verified', ...TIMES },
      // before an account is made, and whenever a provider or single sign-on signs someone in: the access module decides
      validateUserInfo: async ({ user, source }, ctx) => {
        const attempt = attemptOf(user, source, ctx);
        const refusal = await access.admit(attempt);
        if (!refusal) return undefined;
        const way: SignInWay = attempt.with === 'sso' ? { with: 'sso', connection: attempt.connection }
          : attempt.with === 'provider' ? { with: 'provider' } : { with: 'password' };
        await access.signInFailed(attempt.email, way, refusal.code);
        return { error: refusal.code, errorDescription: refusal.message };
      },
    },
    session: {
      modelName: 'auth_session',
      fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', ...TIMES },
    },
    account: {
      // Someone with a password account can later sign in with single sign-on, Google… as the same person.
      // The library would first want the password account's email verified (we send no email); it's safe without:
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

  // Single sign-on reaches the identity provider from this server (OIDC: its token, keys and user info addresses):
  // only on the public internet, or at a trusted origin, with the connection's own lookup (publicFetch.ts), as when its
  // settings were read (sso.ts). The library's own check looks the name up once before; this one is the connection's.
  const guard = { allowedOrigins: s.trustedOrigins ?? [], lookup: s.lookup };
  const reachesIdp = (path: string) => path.startsWith('/api/auth/sso/') || path === '/api/auth/sign-in/sso';
  return {
    handler: (request) => (reachesIdp(new URL(request.url).pathname) ? guardedFetches(guard, () => auth.handler(request)) : auth.handler(request)),
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
      if (!session) return null;
      const { token, createdAt } = session.session;
      return {
        email: session.user.email.toLowerCase(), name: session.user.name,
        twoFactor: (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true,
        since: new Date(createdAt),
        end: async () => { await db.query(`delete from auth_session where token = $1`, [token]); },
      };
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

/** What the sign-in library tells its validateUserInfo hook, in the access module's words. */
type UserInfo = { email?: string | null; emailVerified?: boolean | null };
type Source = { action: string; method: string; sso?: { providerId: string } };
function attemptOf(user: UserInfo, source: Source, ctx?: { headers?: Headers; request?: Request } | null): Attempt {
  const email = String(user.email ?? '');
  const account = source.action === 'create-user' ? 'new' : 'existing';  // else a returning sign-in, or a way in added
  const headers = ctx?.headers ?? ctx?.request?.headers;
  const setup = setupOf(headers);
  if (source.sso?.providerId) return { email, with: 'sso', account, connection: source.sso.providerId, setup };
  if (source.method === 'email-password') return { email, with: 'password', account, invite: headers?.get(INVITE_HEADER) ?? undefined, setup };
  return { email, with: 'provider', account, emailVerified: user.emailVerified === true, setup };
}

/** How a request to one of the sign-in's endpoints signs someone in, or null when it doesn't: a password (a new account,
 *  too), its second step (an authenticator code or a recovery code), single sign-on's callbacks, a provider's. */
export function signInWay(path: string, params?: Record<string, string>): SignInWay | null {
  if (path === '/sign-in/email' || path === '/sign-up/email') return { with: 'password' };
  if (path === '/two-factor/verify-totp') return { with: 'two-factor' };
  if (path === '/two-factor/verify-backup-code') return { with: 'recovery code' };
  const last = (key: string) => params?.[key] ?? path.split('/').pop() ?? '';
  if (/^\/sso\/(callback|saml2\/callback|saml2\/sp\/acs)\//.test(path)) return { with: 'sso', connection: last('providerId') };
  if (/^\/callback\//.test(path)) return { with: 'provider', provider: last('id') };
  return null;
}

/** The sign-in's accounts, for the access module (access.ts `Accounts`): auth_user, one per email; its sessions and
 *  ways in (auth_session, auth_account) are deleted with it. */
export const authAccounts: Accounts = {
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
  // a connection now requires single sign-on: the sessions at its domains end (their ways in stay)
  endSessionsAt: async (q, domains, except) => {
    await q.query(`delete from auth_session where user_id in (select id from auth_user
      where exists (select 1 from unnest($1::text[]) d where split_part(lower(email), '@', 2) = d or split_part(lower(email), '@', 2) like '%.' || d)
        and not (lower(email) = any($2::text[])))`, [domains, except]);
  },
  twoFactorOn: async (q, email) => !!(await one(q, `select 1 from auth_user where lower(email) = $1 and two_factor_enabled`, [email])),
};

/** The SSO plugin's endpoints for managing connections: open to any signed-in person, so they're switched off. */
const SSO_ADMIN_PATHS = ['/sso/register', '/sso/update-provider', '/sso/delete-provider', '/sso/providers', '/sso/get-provider',
  '/sso/request-domain-verification', '/sso/verify-domain'];
/** Two-factor codes by email or text message: this server sends neither, so they're off (an authenticator app it is). */
const NO_EMAIL_CODES = ['/two-factor/send-otp', '/two-factor/verify-otp'];

function asHttpError(e: unknown): Error {
  if (e instanceof APIError) {
    const status = typeof e.statusCode === 'number' ? e.statusCode : 422;
    const message = (e.body as { message?: string } | undefined)?.message || e.message;
    return new HttpError(status >= 500 ? 502 : status === 401 ? 403 : status, message.charAt(0).toLowerCase() + message.slice(1));
  }
  return e as Error;
}

/** Too few different characters for its length to be random (the library's own measure: under 120 bits). */
const lowEntropy = (secret: string) => secret.length * Math.log2(Math.max(new Set(secret).size, 1)) < 120;

/** The sign-in library's log lines, said as this server's: "sign-in: …", without the library's own tag. */
function libraryLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) {
  const said = `sign-in: ${String(message).replace(/^\s*\[[^\]]*\]:?\s*/, '')}`;
  if (level === 'error') console.error(said, ...args);
  else if (level === 'warn') console.warn(said, ...args);
  else console.log(said, ...args);
}

/** Away from production, a secret made on the first start and kept in the database, so sessions outlive restarts. */
export async function localSecret(db: Db): Promise<string> {
  await db.query(`insert into server_secret (name, value) values ('auth', $1) on conflict (name) do nothing`, [randomBytes(32).toString('base64url')]);
  return (await one<{ value: string }>(db, `select value from server_secret where name = 'auth'`))!.value;
}

/** Kysely (which the sign-in library builds its queries with) on top of our database. Each query runs on its own:
 *  the library is told not to use transactions (`transaction: false`). */
export function dbDialect(db: Queryable): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
      const r = await db.query<R>(q.sql, [...q.parameters]);
      return r.affected === undefined ? { rows: r.rows } : { rows: r.rows, numAffectedRows: BigInt(r.affected) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error('streaming queries are not supported'); },
  };
  const noTransactions = async () => { throw new Error('transactions are not supported here: the sign-in runs with transaction: false'); };
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
