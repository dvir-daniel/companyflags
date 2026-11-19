// Who is signed in to the console: the email a request comes with. Who that person is, whether they may join and
// what they may do is the access module's (access.ts).
// - People sign in with Better Auth (betterAuth.ts): an email and password, single sign-on, or Google, GitHub or
//   Microsoft when they are set up. The session is a cookie; the server reads the person's email from it.
// - Tests can name the person in an X-User header (test-header).

import { Hono } from 'hono';
import type { Access, Who } from './access.ts';
import { authSettingsFromEnv, CLIENT_IP_HEADER, providersOf, type AuthSettings, type BetterAuth } from './betterAuth.ts';
import { HttpError } from './db.ts';

export type SignIn =
  | { kind: 'better-auth'; settings: AuthSettings }
  | { kind: 'test-header' };                                                           // tests only: X-User names the person

export function signInFromEnv(env: NodeJS.ProcessEnv = process.env): SignIn {
  return { kind: 'better-auth', settings: authSettingsFromEnv(env) };
}

export type Identity = {
  kind: SignIn['kind'];
  /** Who is asking, from a request's headers: their email (their key) and name, or null when not signed in. */
  who: (headers: Headers) => Promise<Who | null>;
  /** The sign-in pages' endpoints, open to everyone: mounted at /api before the console's own. */
  routes: Hono;
  /** A password reset token for an email, from the sign-in; none with the test sign-in. */
  passwordResetToken?: (email: string) => Promise<string | null>;
};

/** `auth`: the Better Auth sign-in (betterAuth.ts createAuth), for `kind: 'better-auth'`. */
export function createIdentity(signIn: SignIn, access: Access, auth?: BetterAuth): Identity {
  if (signIn.kind === 'better-auth' && !auth) throw new Error('the Better Auth sign-in needs Better Auth (createAuth)');
  const who = async (h: Headers): Promise<Who | null> => {
    switch (signIn.kind) {
      case 'test-header': { const u = h.get('x-user'); return u ? { email: u } : null; }
      case 'better-auth': return auth!.who(h);
    }
  };

  const routes = new Hono();
  // what the sign-in page shows: the ways to sign in, and whether nobody has an account yet (the admin makes the first)
  routes.get('/sign-in', async (c) => {
    const { firstPerson, sso } = await access.signInOptions();
    return c.json({
      kind: signIn.kind,
      providers: signIn.kind === 'better-auth' ? providersOf(signIn.settings) : [],
      firstPerson,
      sso: signIn.kind === 'better-auth' && sso,
    });
  });
  // an invite link: who it is for, so the page can greet them
  routes.get('/invites/:token', async (c) => {
    const p = await access.invitedBy(c.req.param('token'));
    if (!p) throw new HttpError(404, 'this invite link has been used or has expired: ask an admin for a new one');
    return c.json({ email: p.key, name: p.name === p.key ? '' : p.name });
  });
  // Better Auth: sign up, sign in, sign out, provider callbacks, single sign-on, the session (betterAuth.ts)
  // The request goes on with the connection's own address in CLIENT_IP_HEADER (whatever the client sent there is
  // dropped), for Better Auth's sign-in rate limits when no proxy is configured (betterAuth.ts ipAddressFor).
  if (auth) routes.on(['GET', 'POST'], '/auth/*', (c) => {
    const req = c.req.raw;
    const headers = new Headers(req.headers);
    headers.delete(CLIENT_IP_HEADER);
    const address = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    if (address) headers.set(CLIENT_IP_HEADER, address.replace(/^::ffff:/, ''));
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    return auth.handler(new Request(req.url, { method: req.method, headers, body: hasBody ? req.body : undefined, ...(hasBody ? { duplex: 'half' } : {}) } as RequestInit));
  });
  return { kind: signIn.kind, who, routes, ...(auth ? { passwordResetToken: auth.passwordResetToken } : {}) };
}
