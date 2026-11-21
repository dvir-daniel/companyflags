// Who is signed in to the console: the email a request comes with. Who that person is, whether they may join and
// what they may do is the access module's (access.ts).
// - People sign in with an account (accounts.ts): an email and password, single sign-on, or Google, GitHub or
//   Microsoft when they are set up. The session is a cookie; the server reads the person's email from it.
// - Tests can name the person in an X-User header (test-header).
// - A new server makes its first account, the admin's, with the setup link it prints when it starts (index.ts):
//   GET /api/setup/<secret> keeps the secret in a cookie and opens the console, where the admin account is made.

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Access, Who } from './access.ts';
import { authSettingsFromEnv, CLIENT_IP_HEADER, clientAddressFor, providersOf, SETUP_COOKIE, setupOf, type AuthSettings, type AuthService } from './accounts.ts';
import { HttpError } from './db.ts';

export type SignIn =
  | { kind: 'accounts'; settings: AuthSettings }
  | { kind: 'test-header' };                                                           // tests only: X-User names the person

export function signInFromEnv(env: NodeJS.ProcessEnv = process.env): SignIn {
  return { kind: 'accounts', settings: authSettingsFromEnv(env) };
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

/** How long the setup link's cookie lasts: long enough to make the admin account. */
const SETUP_COOKIE_SECONDS = 3600;

/** `auth`: the accounts sign-in (accounts.ts createAuth), for `kind: 'accounts'`. */
export function createIdentity(signIn: SignIn, access: Access, auth?: AuthService): Identity {
  if (signIn.kind === 'accounts' && !auth) throw new Error('the accounts sign-in needs its accounts (createAuth)');
  const who = async (h: Headers): Promise<Who | null> => {
    switch (signIn.kind) {
      case 'test-header': { const u = h.get('x-user'); return u ? { email: u } : null; }
      case 'accounts': return auth!.who(h);
    }
  };
  const settings = signIn.kind === 'accounts' ? signIn.settings : undefined;

  const routes = new Hono();
  // what the sign-in page shows: the ways to sign in, and, to whoever opened the setup link while nobody has an
  // account, making the first one (the admin's). Without the link it doesn't say whether anyone has an account.
  routes.get('/sign-in', async (c) => {
    const { firstPerson, sso } = await access.signInOptions(setupOf(c.req.raw.headers));
    return c.json({
      kind: signIn.kind,
      providers: settings ? providersOf(settings) : [],
      firstPerson,
      sso: !!settings && sso,
    });
  });
  // The setup link (index.ts prints it): its secret goes in a cookie for the sign-up, then on to the console. A wrong
  // secret gets the same answer as a server that has its admin, so the answer says nothing about the server.
  routes.get('/setup/:secret', async (c) => {
    const secret = c.req.param('secret');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    if (!(await access.setupOpen(secret))) {
      // a person opens this link in a browser: words on a page, not JSON
      return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Setup link · CompanyFlags</title>
<body style="font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 16px">
<p><b>This setup link doesn’t work.</b> The admin account is already made, or this isn’t the link the server printed when it started.</p>
<p><a href="/">Open the console</a> to sign in.</p></body>`, 404);
    }
    setCookie(c, SETUP_COOKIE, secret, {
      path: '/api', httpOnly: true, sameSite: 'Lax', maxAge: SETUP_COOKIE_SECONDS,
      secure: (settings?.baseURL ?? c.req.url).startsWith('https:'),
    });
    return c.redirect('/', 302);
  });
  // An invite link: who it is for, so the page can greet them. POST, with the secret in the body, keeps it out of
  // proxies' and CDNs' access logs.
  const invited = async (token: string) => {
    const p = await access.invitedBy(token);
    if (!p) throw new HttpError(404, 'this invite link has been used or has expired: ask an admin for a new one');
    return { email: p.key, name: p.name === p.key ? '' : p.name };
  };
  routes.post('/invites', async (c) => {
    const body = ((await c.req.json<{ token?: unknown } | null>().catch(() => null)) ?? {}) as { token?: unknown };
    return c.json(await invited(typeof body.token === 'string' ? body.token : ''));
  });
  // The sign-in: sign up, sign in, sign out, provider callbacks, single sign-on, the session (accounts.ts)
  // The request goes on with the client's address in CLIENT_IP_HEADER (whatever the client sent there is dropped), for
  // the sign-in's rate limits: the connection's own address, or what a trusted proxy says (clientAddressFor).
  const clientAddress = clientAddressFor(settings ?? {});
  if (auth) routes.on(['GET', 'POST'], '/auth/*', (c) => {
    const req = c.req.raw;
    const headers = new Headers(req.headers);
    headers.delete(CLIENT_IP_HEADER);
    const connection = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    const address = clientAddress(req.headers, connection);
    if (address) headers.set(CLIENT_IP_HEADER, address);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    return auth.handler(new Request(req.url, { method: req.method, headers, body: hasBody ? req.body : undefined, ...(hasBody ? { duplex: 'half' } : {}) } as RequestInit));
  });
  return { kind: signIn.kind, who, routes, ...(auth ? { passwordResetToken: auth.passwordResetToken } : {}) };
}
