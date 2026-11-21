// OAuth sign-in for MCP clients (Claude, Cursor, VS Code): the MCP authorization spec (2025-11-25), OAuth 2.1 with
// PKCE, on top of the console's own sign-in. On while the mcp plugin is (plugins/mcp.ts).
//
//   1. /mcp without a token: 401, WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"
//   2. GET /.well-known/oauth-protected-resource       this server's /mcp, and that it signs people in itself (RFC 9728)
//   3. GET /.well-known/oauth-authorization-server     where to register, sign in and get tokens (RFC 8414)
//   4. POST /oauth/register                             a public client registers itself: its name and redirect URIs (RFC 7591)
//   5. GET /oauth/authorize                             in the browser: the console's sign-in, then "Allow <client>?" with
//                                                       Viewer or Editor; POST: the answer, back to the client with a code
//   6. POST /oauth/token                                the code and its PKCE verifier (S256) for an access token and a
//                                                       refresh token; a refresh token for new ones (each used once)
//   7. POST /oauth/revoke                               either token ends the sign-in (RFC 7009)
//
// The access token is an agent's access token (tokens.ts): a row in access_token with agent = true, Viewer or Editor,
// named "<client> (OAuth)", on its person's Access tokens page, where revoking it ends the sign-in. So /mcp and the
// console's API check it as they check any token. It lasts an hour; the refresh token renews it (in place: same row)
// for 30 days after its last use, and never past 90 days from when the person allowed it (GRANT_DAYS): then the client
// signs in again, and the person allows it again, so an agent's sign-in can't outlast its person's access at the
// identity provider for good. An admin the sign-in rules ask to set up two-factor sign-in, who hasn't, can't allow a
// client, and their clients' tokens aren't given or renewed until they have (access.ts twoFactorPending). Tokens and
// codes are kept hashed. Every token is issued for this server's /mcp (the
// `resource`, RFC 8707) and nothing else: a request for another resource is refused.
// The sign-in library's own MCP plugin isn't used: it needs the jwt plugin, tables of its own and gives
// JWTs, where an access token row is what the console already checks, lists and revokes.

import { randomBytes, createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { all, one, type Db } from './db.ts';
import { sha256 } from './auth.ts';
import { audit } from './journal.ts';
import { TOKEN_PREFIX } from './tokens.ts';
import { roleInfo, tokenRoles, type Role } from './policy.ts';
import type { Access, Person } from './access.ts';
import type { Identity } from './identity.ts';

export const OAUTH_PREFIXES = ['/oauth', '/.well-known'];
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const REFRESH_PREFIX = 'cfr_';
const CLIENT_PREFIX = 'cfc_';
const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 30;
/** The most days an OAuth sign-in lasts, from when its person allowed the client: refreshing doesn't go past it. */
export const GRANT_DAYS = 90;
const CODE_SECONDS = 600;
/** Registration is open to anyone: a client nobody signed in with goes after a day, and there are at most this many
 *  at once, so registering over and over can't fill the database. */
export const MAX_UNUSED_CLIENTS = 1000;
/** Where the authorize page waits while its person signs in to the console (the console's page sends them back). */
const PENDING_COOKIE = 'companyflags.oauth';

type Client = { id: string; name: string; redirectUris: string[] };
type Ask = { client: Client; redirectUri: string; state: string | null; challenge: string; resource: string };

const b64url = (buf: Buffer) => buf.toString('base64url');
const secret = (prefix: string) => `${prefix}${b64url(randomBytes(32))}`;
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const NEVER = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'filesystem:', 'ws:', 'wss:']);

/** Why a redirect URI can't be registered, or null: https, http to this computer (loopback), or an app's own scheme. */
function redirectProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return 'a redirect URI is a URL of up to 500 characters';
  let u: URL;
  try { u = new URL(raw); } catch { return `${raw} isn’t a URL`; }
  if (u.hash || raw.includes('#')) return `${raw}: no #fragment`;
  if (NEVER.has(u.protocol)) return `${raw}: not a ${u.protocol} address`;
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) return `${raw}: http only to this computer (localhost, 127.0.0.1); use https`;
  if (u.username || u.password) return `${raw}: no user or password in it`;
  return null;
}

/** The redirect URI fits one the client registered: exactly, or, to this computer over http, on any port (RFC 8252). */
function redirectFits(client: Client, uri: string): boolean {
  if (client.redirectUris.includes(uri)) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return false;
  return client.redirectUris.some((r) => {
    try {
      const v = new URL(r);
      return v.protocol === 'http:' && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
    } catch { return false; }
  });
}

/** What the page tells the person about where the code goes: the host, or the app's own scheme. */
function whereTo(uri: string) {
  const u = new URL(uri);
  if (u.protocol === 'https:') return u.host;
  if (u.protocol === 'http:') return `${u.host} (this computer)`;
  return `${u.protocol}${u.host ? `//${u.host}` : ''} (an app on this computer)`;
}

/** The page every answer of /oauth/authorize is: a box in the middle, nothing loaded from anywhere. */
function page(c: Context, title: string, body: string, status: 200 | 400 | 403 = 200) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · CompanyFlags</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --card: #fff; --ink: #111; --ink-2: #555; --line: #e4e4e7; --btn: #111; --btn-ink: #fff }
@media (prefers-color-scheme: dark) { :root { --bg: #09090b; --card: #111113; --ink: #fafafa; --ink-2: #a1a1aa; --line: #27272a; --btn: #fafafa; --btn-ink: #111 } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, sans-serif }
main { max-width: 26rem; margin: 12vh auto; padding: 0 16px }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 24px }
h1 { font-size: 19px; margin: 0 0 8px } p { margin: 0 0 12px; color: var(--ink-2) } b { color: var(--ink) }
label { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 0 0 8px; cursor: pointer }
label span { color: var(--ink-2) } .row { display: flex; gap: 8px; margin-top: 16px }
button { flex: 1; font: inherit; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer }
button.go { background: var(--btn); color: var(--btn-ink); border-color: var(--btn) }
</style><main><div class="card">${body}</div></main></html>`, status);
}

type Deps = { db: Db; identity: Identity; access: Access; baseURL?: string | null };

export function oauthRoutes({ db, identity, access, baseURL }: Deps) {
  const fixed = (() => { try { return baseURL ? new URL(baseURL).origin : null; } catch { return null; } })();
  const base = (c: Context) => fixed ?? new URL(c.req.url).origin;
  const resourceOf = (c: Context) => `${base(c)}/mcp`;
  /** The resource a client named, if it is this server's /mcp (or this server): the canonical one, else null. */
  const ourResource = (c: Context, said: string | undefined | null) => {
    if (said === undefined || said === null || said === '') return resourceOf(c);
    try {
      const u = new URL(said);
      if (u.hash || u.search) return null;
      const path = u.pathname.replace(/\/+$/, '');
      return u.origin === base(c) && (path === '/mcp' || path === '') ? resourceOf(c) : null;
    } catch { return null; }
  };

  const TWO_FACTOR_FIRST = 'set up two-factor sign-in first: your organization asks it of admins who sign in with a password';
  /** The page for an admin who must set up two-factor sign-in before allowing anything (access.ts needsTwoFactor). */
  const twoFactorPage = (c: Context) => page(c, 'Two-factor sign-in first',
    '<h1>Set up two-factor sign-in first</h1><p>Your organization asks it of admins who sign in with a password. Set it up in the console (your account menu → Account), then connect the app again.</p>', 403);

  /** The person signed in to the console, if any. */
  const signedIn = async (c: Context): Promise<Person | null> => {
    const who = await identity.who(c.req.raw.headers);
    if (!who) return null;
    const p = await access.signedIn(who).catch(() => null);
    return p && !p.removed ? p : null;
  };

  const clientById = async (id: unknown): Promise<Client | null> => {
    if (typeof id !== 'string' || !id.startsWith(CLIENT_PREFIX)) return null;
    const r = await one<{ id: string; name: string; redirect_uris: string[] }>(db, `select id, name, redirect_uris from oauth_client where id = $1`, [id]);
    return r ? { id: r.id, name: r.name, redirectUris: r.redirect_uris } : null;
  };

  const routes = new Hono();

  // The discovery documents and the endpoints a client calls from code: open to any origin, with no cookies
  const cors = (c: Context) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  };
  for (const path of [`${RESOURCE_METADATA_PATH}`, `${RESOURCE_METADATA_PATH}/mcp`, '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/oauth/revoke']) {
    routes.options(path, (c) => { cors(c); return c.body(null, 204); });
  }

  const protectedResource = (c: Context) => {
    cors(c);
    return c.json({
      resource: resourceOf(c),
      authorization_servers: [base(c)],
      bearer_methods_supported: ['header'],
      resource_name: 'CompanyFlags',
    });
  };
  routes.get(RESOURCE_METADATA_PATH, protectedResource);
  routes.get(`${RESOURCE_METADATA_PATH}/mcp`, protectedResource);
  routes.get('/.well-known/oauth-authorization-server', (c) => {
    cors(c);
    const b = base(c);
    return c.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      revocation_endpoint: `${b}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  // ---------------------------------------------------------------- registration (RFC 7591): public clients only
  routes.post('/oauth/register', async (c) => {
    cors(c);
    const bad = (description: string) => c.json({ error: 'invalid_client_metadata', error_description: description }, 400);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('send the client’s metadata as a JSON object');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris: 1 to 10 URLs' }, 400);
    for (const u of uris) {
      const problem = redirectProblem(u);
      if (problem) return c.json({ error: 'invalid_redirect_uri', error_description: problem }, 400);
    }
    const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) return bad('grant_types: authorization_code and refresh_token');
    const types = body.response_types ?? ['code'];
    if (!Array.isArray(types) || types.some((t) => t !== 'code')) return bad('response_types: code');
    // no control or invisible formatting characters (right-to-left overrides): the consent page shows the name as sent
    const rawName = typeof body.client_name === 'string' ? body.client_name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
    const name = (rawName || 'An MCP client').slice(0, 100);
    const unused = `not exists (select 1 from oauth_grant g where g.client_id = c.id)`;
    await db.query(`delete from oauth_client c where created_at < now() - interval '1 day' and ${unused}`);
    const count = await one<{ n: number }>(db, `select count(*)::int as n from oauth_client c where ${unused}`);
    if (count!.n >= MAX_UNUSED_CLIENTS) {
      c.header('Retry-After', '3600');
      return c.json({ error: 'temporarily_unavailable', error_description: 'too many clients registered and not used yet: try again later' }, 429);
    }
    const id = secret(CLIENT_PREFIX).slice(0, 36);
    const row = await one<{ at: number }>(db, `insert into oauth_client (id, name, redirect_uris) values ($1, $2, $3)
      returning extract(epoch from created_at)::bigint as at`, [id, name, uris]);
    c.header('Cache-Control', 'no-store');
    return c.json({
      client_id: id, client_id_issued_at: Number(row!.at), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }, 201);
  });

  // ---------------------------------------------------------------- the browser: sign in, then allow
  /** The request in an /authorize address or form, checked. A problem is shown on the page, never sent back to the
   *  client: anyone may register a client with any https redirect URI, so going back to it before the person has
   *  answered would make this server an open redirect to any address. */
  const askOf = async (c: Context, q: Record<string, string | undefined>): Promise<{ ask: Ask } | { page: Response }> => {
    const client = await clientById(q.client_id);
    if (!client) return { page: page(c, 'Unknown app', '<h1>This app isn’t known here</h1><p>Its client ID isn’t registered with this server. Connect it again from the app.</p>', 400) };
    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
    if (!redirectUri || !redirectFits(client, redirectUri)) {
      return { page: page(c, 'Wrong address', '<h1>This app asked to go back to an address it didn’t register</h1><p>Nothing was sent. Connect it again from the app.</p>', 400) };
    }
    const wrong = (description: string) => ({ page: page(c, 'Can’t connect', `<h1>This app’s request can’t be used</h1><p>${esc(description)}. Nothing was sent. Connect it again from the app.</p>`, 400) });
    if (q.response_type !== 'code') return wrong('response_type: code');
    if (!q.code_challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(q.code_challenge)) return wrong('PKCE is required: a code_challenge');
    if (q.code_challenge_method !== 'S256') return wrong('code_challenge_method: S256');
    const resource = ourResource(c, q.resource);
    if (!resource) return wrong(`this server gives tokens for ${resourceOf(c)} only`);
    return { ask: { client, redirectUri, state: q.state ?? null, challenge: q.code_challenge, resource } };
  };

  const KEYS = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'resource', 'scope'] as const;

  routes.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    const checked = await askOf(c, q);
    if ('page' in checked) return checked.page;
    const { ask } = checked;
    const p = await signedIn(c);
    if (p?.needsTwoFactor) return twoFactorPage(c);
    if (!p) {
      // to the console's sign-in, and back here after it (the console's page, below)
      const here = new URL(c.req.url);
      setCookie(c, PENDING_COOKIE, `/oauth/authorize${here.search}`, {
        path: '/', httpOnly: true, sameSite: 'Lax', maxAge: CODE_SECONDS, secure: base(c).startsWith('https:'),
      });
      return c.redirect('/', 302);
    }
    const roles = tokenRoles(p, true);
    const pick = roles.includes('editor') ? 'editor' : 'viewer';
    const hidden = KEYS.map((k) => (q[k] === undefined ? '' : `<input type="hidden" name="${k}" value="${esc(q[k]!)}">`)).join('');
    const option = (r: Role, words: string) => (roles.includes(r)
      ? `<label><input type="radio" name="role" value="${r}"${r === pick ? ' checked' : ''}><div><b>${roleInfo(r).label}</b><br><span>${words}</span></div></label>` : '');
    return page(c, `Allow ${ask.client.name}`, `<h1>Allow ${esc(ask.client.name)}?</h1>
<p>It will use CompanyFlags as you (<b>${esc(p.key)}</b>), as an agent. What it does shows in History as an agent’s.</p>
<form method="post" action="/oauth/authorize">${hidden}
${option('editor', 'Reads and changes flags. Where an environment needs approval, its changes are requests a person approves.')}
${option('viewer', 'Reads flags only.')}
<p>It goes back to <b>${esc(whereTo(ask.redirectUri))}</b>. It shows on your Account page, under access tokens, as “${esc(ask.client.name)} (OAuth)”, where you can revoke it.</p>
<div class="row"><button name="answer" value="deny">Deny</button><button class="go" name="answer" value="allow">Allow</button></div>
</form>`);
  });

  routes.post('/oauth/authorize', async (c) => {
    // a cookie goes with a form from any site: this answer must come from this server's own page
    const origin = c.req.header('origin');
    if ((origin && origin !== base(c) && origin !== new URL(c.req.url).origin) || c.req.header('sec-fetch-site') === 'cross-site') {
      return page(c, 'Not allowed', '<h1>This answer didn’t come from this server’s page</h1><p>Nothing was sent.</p>', 403);
    }
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const q = Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const checked = await askOf(c, q);
    if ('page' in checked) return checked.page;
    const { ask } = checked;
    const p = await signedIn(c);
    if (!p) return page(c, 'Signed out', '<h1>You’re signed out</h1><p>Connect the app again to sign in.</p>', 403);
    if (p.needsTwoFactor) return twoFactorPage(c);
    const to = new URL(ask.redirectUri);
    if (ask.state !== null) to.searchParams.set('state', ask.state);
    to.searchParams.set('iss', base(c));
    if (q.answer !== 'allow') {
      to.searchParams.set('error', 'access_denied');
      to.searchParams.set('error_description', 'the person didn’t allow it');
      return c.redirect(to.toString(), 302);
    }
    const role = q.role as Role;
    if (!tokenRoles(p, true).includes(role)) return page(c, 'Not allowed', '<h1>Choose Viewer or Editor</h1><p>An agent is never more than its person.</p>', 400);
    const code = secret('');
    await db.query(`delete from oauth_code where expires_at < now() - interval '1 day'`);
    await db.query(`insert into oauth_code (code_hash, client_id, person_id, role, redirect_uri, code_challenge, resource, expires_at)
      select $1, $2, u.id, $3, $4, $5, $6, now() + make_interval(secs => $7) from app_user u where u.key = $8`,
    [sha256(code), ask.client.id, role, ask.redirectUri, ask.challenge, ask.resource, CODE_SECONDS, p.key]);
    to.searchParams.set('code', code);
    return c.redirect(to.toString(), 302);
  });

  // ---------------------------------------------------------------- tokens
  const tokenError = (c: Context, error: string, description: string, status: 400 | 401 = 400) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ error, error_description: description }, status);
  };
  /** The client a token request is from: client_id in the form, or the user of HTTP Basic. */
  const clientIdOf = (c: Context, form: Record<string, string>) => {
    if (form.client_id) return form.client_id;
    const basic = c.req.header('authorization')?.match(/^Basic\s+(\S+)$/i)?.[1];
    if (!basic) return undefined;
    try { return decodeURIComponent(Buffer.from(basic, 'base64').toString('utf8').split(':')[0]); } catch { return undefined; }
  };
  const formOf = async (c: Context) => {
    const f = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    return Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  };
  const issued = (c: Context, access: string, refresh: string) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh });
  };

  routes.post('/oauth/token', async (c) => {
    cors(c);
    const form = await formOf(c);
    const client = await clientById(clientIdOf(c, form));
    if (!client) return tokenError(c, 'invalid_client', 'unknown client_id: register first', 401);
    const resource = ourResource(c, form.resource);
    if (!resource) return tokenError(c, 'invalid_target', `this server gives tokens for ${resourceOf(c)} only`);

    if (form.grant_type === 'authorization_code') {
      if (!form.code || !form.code_verifier) return tokenError(c, 'invalid_request', 'code and code_verifier are required');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(form.code_verifier)) return tokenError(c, 'invalid_grant', 'the code_verifier doesn’t fit the code');
      return db.transaction(async (tx) => {
        const code = await one<{ client_id: string; role: Role; redirect_uri: string; code_challenge: string; resource: string;
          expired: boolean; used: boolean; token_id: number | null; person: string; pname: string; prole: Role; removed: boolean }>(tx,
        `select k.client_id, k.role, k.redirect_uri, k.code_challenge, k.resource, k.expires_at < now() as expired, k.used_at is not null as used,
            k.token_id::int as token_id, u.key as person, u.name as pname, u.role as prole, u.removed_at is not null as removed
          from oauth_code k join app_user u on u.id = k.person_id where k.code_hash = $1 for update of k`, [sha256(form.code)]);
        if (!code || code.client_id !== client.id) return tokenError(c, 'invalid_grant', 'unknown code');
        if (code.used) {
          // a code seen twice may have been stolen: the token it gave stops working
          if (code.token_id) await tx.query(`update access_token set revoked_at = now() where id = $1 and revoked_at is null`, [code.token_id]);
          return tokenError(c, 'invalid_grant', 'this code was used already');
        }
        await tx.query(`update oauth_code set used_at = now() where code_hash = $1`, [sha256(form.code)]);
        if (code.expired) return tokenError(c, 'invalid_grant', 'this code expired');
        if ((form.redirect_uri ?? code.redirect_uri) !== code.redirect_uri) return tokenError(c, 'invalid_grant', 'redirect_uri isn’t the one the code was for');
        if (resource !== code.resource) return tokenError(c, 'invalid_target', 'resource isn’t the one the code was for');
        if (s256(form.code_verifier) !== code.code_challenge) return tokenError(c, 'invalid_grant', 'the code_verifier doesn’t fit the code');
        if (code.removed || !tokenRoles({ role: code.prole }, true).includes(code.role)) return tokenError(c, 'invalid_grant', 'this person can’t sign this app in any more');
        if (await access.twoFactorPending(code.person, tx)) return tokenError(c, 'invalid_grant', TWO_FACTOR_FIRST);
        const token = secret(TOKEN_PREFIX);
        const refresh = secret(REFRESH_PREFIX);
        const prefix = token.slice(0, TOKEN_PREFIX.length + 6);
        const name = `${client.name.slice(0, 72)} (OAuth)`;
        const row = await one<{ id: number }>(tx, `insert into access_token (token_hash, token_prefix, person_id, name, role, agent, expires_at)
          select $1, $2, u.id, $3, $4, true, now() + make_interval(secs => $5) from app_user u where u.key = $6 returning id::int as id`,
        [sha256(token), prefix, name, code.role, ACCESS_SECONDS, code.person]);
        await tx.query(`insert into oauth_grant (token_id, client_id, resource, refresh_hash, refresh_expires_at)
          values ($1, $2, $3, $4, now() + make_interval(days => $5))`, [row!.id, client.id, resource, sha256(refresh), REFRESH_DAYS]);
        await tx.query(`update oauth_code set token_id = $1 where code_hash = $2`, [row!.id, sha256(form.code)]);
        await audit(tx, { name: code.person, type: 'user' }, { kind: 'token.create', after: { id: row!.id, prefix, name, role: code.role, agent: true, oauth: client.id } });
        return issued(c, token, refresh);
      });
    }

    if (form.grant_type === 'refresh_token') {
      if (!form.refresh_token) return tokenError(c, 'invalid_request', 'refresh_token is required');
      const hash = sha256(form.refresh_token);
      return db.transaction(async (tx) => {
        // `expired`: 30 days without a refresh, or GRANT_DAYS since the person allowed it (the token row's created_at)
        const g = await one<{ token_id: number; client_id: string; resource: string; current: boolean; expired: boolean; revoked: boolean; role: Role; removed: boolean; person: string }>(tx,
          `select g.token_id::int as token_id, g.client_id, g.resource, g.refresh_hash = $1 as current,
              (g.refresh_expires_at < now() or t.created_at + make_interval(days => $2) < now()) as expired,
              t.revoked_at is not null as revoked, t.role, u.removed_at is not null as removed, u.key as person
            from oauth_grant g join access_token t on t.id = g.token_id join app_user u on u.id = t.person_id
            where g.refresh_hash = $1 or g.previous_refresh_hash = $1 for update of g, t`, [hash, GRANT_DAYS]);
        if (!g || g.client_id !== client.id) return tokenError(c, 'invalid_grant', 'unknown refresh token');
        if (!g.current) {
          // an old refresh token back again may have been stolen: the sign-in ends
          if (!g.revoked) await tx.query(`update access_token set revoked_at = now() where id = $1`, [g.token_id]);
          return tokenError(c, 'invalid_grant', 'this refresh token was used already: sign in again');
        }
        if (g.revoked || g.expired || g.removed) return tokenError(c, 'invalid_grant', 'this sign-in has ended: sign in again');
        if (resource !== g.resource) return tokenError(c, 'invalid_target', 'resource isn’t the one this sign-in is for');
        if (await access.twoFactorPending(g.person, tx)) return tokenError(c, 'invalid_grant', TWO_FACTOR_FIRST);
        const token = secret(TOKEN_PREFIX);
        const refresh = secret(REFRESH_PREFIX);
        // the access token never outlasts the sign-in, nor the refresh token: both end GRANT_DAYS after it was allowed
        await tx.query(`update access_token set token_hash = $1, token_prefix = $2,
            expires_at = least(now() + make_interval(secs => $3), created_at + make_interval(days => $5)) where id = $4`,
          [sha256(token), token.slice(0, TOKEN_PREFIX.length + 6), ACCESS_SECONDS, g.token_id, GRANT_DAYS]);
        await tx.query(`update oauth_grant g set previous_refresh_hash = refresh_hash, refresh_hash = $1,
            refresh_expires_at = least(now() + make_interval(days => $2), (select t.created_at from access_token t where t.id = g.token_id) + make_interval(days => $4))
          where token_id = $3`, [sha256(refresh), REFRESH_DAYS, g.token_id, GRANT_DAYS]);
        return issued(c, token, refresh);
      });
    }
    return tokenError(c, 'unsupported_grant_type', 'grant_type: authorization_code or refresh_token');
  });

  // RFC 7009: either token ends the sign-in. Always 200, whatever the token was.
  routes.post('/oauth/revoke', async (c) => {
    cors(c);
    const form = await formOf(c);
    const raw = form.token ?? '';
    const clientId = clientIdOf(c, form);
    const rows = await all<{ id: number; client_id: string; prefix: string; name: string; person: string; revoked: boolean }>(db,
      `select t.id::int as id, g.client_id, t.token_prefix as prefix, t.name, u.key as person, t.revoked_at is not null as revoked
        from oauth_grant g join access_token t on t.id = g.token_id join app_user u on u.id = t.person_id
        where t.token_hash = $1 or g.refresh_hash = $1`, [sha256(raw)]);
    const g = rows[0];
    if (g && !g.revoked && (!clientId || clientId === g.client_id)) {
      await db.transaction(async (tx) => {
        await tx.query(`update access_token set revoked_at = now() where id = $1 and revoked_at is null`, [g.id]);
        await audit(tx, { name: g.person, type: 'agent' }, { kind: 'token.revoke', before: { id: g.id, prefix: g.prefix, name: g.name, person: g.person } });
      });
    }
    c.header('Cache-Control', 'no-store');
    return c.body(null, 200);
  });

  // The console's page, after its person signed in there on the way to /oauth/authorize: back to it
  routes.get('/', async (c, next) => {
    const pending = getCookie(c, PENDING_COOKIE);
    if (pending && pending.startsWith('/oauth/authorize?') && (await signedIn(c))) {
      deleteCookie(c, PENDING_COOKIE, { path: '/' });
      return c.redirect(pending, 302);
    }
    await next();
  });

  return routes;
}
