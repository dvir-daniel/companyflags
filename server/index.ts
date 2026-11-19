import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { consoleApi } from './api.ts';
import { FolderInUseError, HttpError, openDb, type Db } from './db.ts';
import { MigrationError } from './migrate.ts';
import { createIdentity, signInFromEnv, type SignIn } from './identity.ts';
import { createAccess } from './access.ts';
import { betterAuthAccounts, createAuth, SetupError } from './betterAuth.ts';
import { discoverOverHttp, singleSignOn, vouchingConnections, type Discover } from './sso.ts';
import { EventHub } from './events.ts';
import { AppCache, deliveryApi, LinkCache } from './delivery.ts';
import { ofrepApi } from './ofrep.ts';
import { KeyCache } from './auth.ts';
import { journaled } from './journal.ts';
import type { Purger } from './purge.ts';
import { createCdn, type CdnOptions } from './cdn.ts';
import { syncFields } from './fields.ts';
import { DataPlane } from './snapshot.ts';
import { startWorkers } from './workers.ts';

export type AppOptions = {
  databaseUrl?: string;                  // a Postgres server; without it, embedded Postgres in dataDir (or in memory)
  dataDir?: string;
  signIn?: SignIn;                       // how people sign in to the console (identity.ts); default: from the environment
  discover?: Discover;                   // reads an OIDC identity provider's settings (sso.ts); tests hand it the documents
  setup?: (db: Db) => Promise<void>;     // tests: fill a new, empty database
  log?: (m: string) => void;
  /** How this server reaches Cloudflare to purge app files after a publish (cdn.ts): `fetch`, and the zone and token
   *  set on the server (CF_ZONE_ID, CF_API_TOKEN). Only the server's own start sets it, so an app made in a test never
   *  purges a real Cloudflare zone. */
  cdn?: CdnOptions;
  /** tests: a purger of their own instead (publish.test.ts) */
  purge?: Purger;
};

export async function createApp(opts: AppOptions = {}) {
  const log = opts.log ?? (() => {});
  const { db: store, fresh, applied } = await openDb({ url: opts.databaseUrl, dataDir: opts.dataDir, log });
  if (applied.length) log(`database: applied ${applied.join(', ')}`);
  await syncFields(store);
  if (fresh && opts.setup) await opts.setup(store);          // before the app runs: nothing in memory to tell yet
  const plane = new DataPlane();
  for (const env of (await store.query<{ key: string }>(`select key from environment`)).rows) await plane.refresh(store, env.key);
  // A new database's setup (tests) is in the snapshots just built: nothing of it to publish. On a
  // database in use, rows still waiting are left to the workers: another server on it may be publishing them right
  // now, and publishing one twice (a rebuild, a CDN purge) does no harm.
  if (fresh) await store.query(`update publish_queue set published_at = now() where published_at is null`);

  const hub = new EventHub();
  // What this app keeps in memory is its own: two apps in one process share nothing. The change journal
  // (journal.ts) tells these parts about each change once it commits.
  const links = new LinkCache();
  const keys = new KeyCache();
  const apps = new AppCache();
  const db = journaled(store, {
    forgetClientLinks: () => links.forget(),
    forgetClientApps: () => apps.forget(),
    forgetApiKeys: () => keys.forget(),
    refresh: (env) => plane.refresh(store, env),
    wake: () => workers.wake(),
  }, log);

  // People and their access (access.ts) decide who may join; the sign-in (identity.ts) says who is asking, through
  // Better Auth (betterAuth.ts), which keeps the accounts and asks the access module whenever someone joins.
  const signIn = opts.signIn ?? signInFromEnv();
  const settings = signIn.kind === 'better-auth' ? signIn.settings : undefined;
  const access = createAccess(db, { accounts: betterAuthAccounts, connections: vouchingConnections, signupDomains: settings?.signupDomains });
  const auth = settings ? await createAuth(store, settings, access).catch(async (e) => { await store.close(); throw e; }) : undefined;
  const identity = createIdentity(signIn, access, auth);
  const sso = singleSignOn(db, {
    access, plugin: auth, discover: opts.discover ?? discoverOverHttp(settings?.trustedOrigins ?? []), baseURL: settings?.baseURL, production: settings?.production,
  });
  const cdn = createCdn(db, { ...opts.cdn, log });
  const workers = startWorkers(db, plane, hub, log, opts.purge ?? cdn.purge, {
    onRemoteChange: () => { links.forget(); keys.forget(); apps.forget(); },
  });

  const app = new Hono();
  app.onError(errorHandler(log));
  // Every response: no sniffing, never in a frame, no referrer beyond the origin. HSTS is left to whatever ends TLS in
  // front of this server; the app files set their own CORS (delivery.ts), so no Cross-Origin-Resource-Policy here.
  app.use('*', secureHeaders({
    strictTransportSecurity: false, crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false,
    xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin',
  }));
  // For load balancers and orchestrators: /healthz answers while the process runs, /readyz once the database answers.
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    try {
      await store.query('select 1');
      return c.json({ ok: true, environments: plane.snapshots.size });
    } catch {
      return c.json({ ok: false, error: 'the database isn’t answering' }, 503);
    }
  });
  app.route('/api', identity.routes);                    // sign-in pages and Better Auth: open to everyone
  app.route('/api', consoleApi({ db, plane, hub, identity, access, sso, cdn }));
  app.route('/', deliveryApi({ db, plane, links, keys, apps }));
  app.route('/', ofrepApi({ db, plane, keys, links, apps, hub }));   // OpenFeature's own providers (OFREP)
  // An unknown address under the API, the app files or the backend downloads is a 404 with a JSON error,
  // never the console's page (which answers every other address, below).
  const noSuchEndpoint = (c: Context) => c.json({ error: `no such endpoint: ${c.req.method} ${c.req.path}` }, 404);
  for (const prefix of ['/api', '/client', '/sdk', '/ofrep']) {
    app.all(prefix, noSuchEndpoint);
    app.all(`${prefix}/*`, noSuchEndpoint);
  }

  const dist = fileURLToPath(new URL('../web/dist', import.meta.url));
  if (existsSync(dist)) {
    // index.html is read on every request and never cached, so a rebuild shows up on the next reload;
    // the hashed /assets files can be cached forever.
    const page = (c: Context) => {
      const html = readFileSync(`${dist}/index.html`, 'utf8');
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      c.header('Content-Security-Policy', consolePolicy(html));
      return c.html(html);
    };
    app.get('/', page);
    app.get('/index.html', page);
    app.use('/assets/*', async (c, next) => { await next(); c.header('Cache-Control', 'public, max-age=31536000, immutable'); });
    app.use('/*', serveStatic({ root: './web/dist' }));
    app.get('*', page);
  }
  return { app, db, plane, hub, workers, identity };
}

/** The console page's Content-Security-Policy: scripts only from this server, plus the page's own inline scripts by
 *  their hash (the theme script that runs before the first paint), so an injected script can't run. Styles may be
 *  inline: the components set some. Everything else from this server only, and never inside another site's frame. */
const policies = new Map<string, string>();
export function consolePolicy(html: string): string {
  let policy = policies.get(html);
  if (policy) return policy;
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  policy = [
    `default-src 'self'`, `script-src 'self' ${hashes.join(' ')}`.trim(), `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`, `font-src 'self' data:`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');
  policies.clear();                                      // one index.html at a time: a rebuild replaces it
  policies.set(html, policy);
  return policy;
}

// Postgres: invalid text for a type (22P02), a number out of range (22003), a bad date or time (22007, 22008)
const BAD_VALUE = new Set(['22P02', '22003', '22007', '22008']);

/** How an error becomes a response, by what it is, never by its wording:
 *  - HttpError (ours) or HTTPException (Hono's): its status and message (and an HttpError's `code`, which the
 *    console reads instead of the wording);
 *  - a Postgres constraint violation (class 23) or an exception raised by a trigger (P0001): 422 with the
 *    database's message, the schema doing its job;
 *  - a value of the wrong form (BAD_VALUE): 400, said plainly;
 *  - anything else is a bug: logged with its stack, and a 500 that gives nothing away. */
export function errorHandler(log: (m: string) => void): ErrorHandler {
  return (err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...err.body, ...(err.code ? { code: err.code } : {}) }, err.status as 400);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);       // Hono's own (e.g. a body too big)
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (BAD_VALUE.has(code)) return c.json({ error: 'a number, date or ID in the request isn’t valid' }, 400);
      if (code.startsWith('23') || code === 'P0001') return c.json({ error: err.message }, 422);
    }
    log(`error: ${c.req.method} ${c.req.path}: ${err.stack ?? err.message ?? String(err)}`);
    return c.json({ error: 'internal error' }, 500);
  };
}

/** Whether nothing is listening on this port yet. */
function portFree(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const probe = createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);              // an empty PORT is the default, not port 0
  const host = process.env.HOST || '0.0.0.0';
  const dataDir = process.env.FF_DATA_DIR || './data';
  const fail = (m: string): never => { console.error(`[ff] ${m}`); process.exit(1); };
  const log = (m: string) => console.log(`[ff] ${m}`);
  // the port first: a second copy started by mistake stops here, before it opens any data
  if (!(await portFree(port, host))) {
    fail(`port ${port} is already in use: CompanyFeatures may already be running (open http://localhost:${port}), or start this one with PORT=<another port>`);
  }
  let signIn: SignIn;
  try { signIn = signInFromEnv(); } catch (e) { fail((e as Error).message); }
  const ctx = await createApp({
    databaseUrl: process.env.DATABASE_URL || undefined,
    dataDir,
    signIn: signIn!,
    cdn: { fetch: globalThis.fetch, server: { zoneId: process.env.CF_ZONE_ID, token: process.env.CF_API_TOKEN } },
    log,
  }).catch((e: Error) => (e instanceof FolderInUseError || e instanceof MigrationError || e instanceof SetupError ? fail(e.message) : Promise.reject(e)));
  if (signIn!.kind === 'better-auth') {
    const settings = signIn!.settings;
    const ways = ['email and password', ...(['google', 'github', 'microsoft'] as const).filter((p) => settings[p])];
    log(`sign-in with Better Auth: ${ways.join(', ')}`);
  }
  const server = serve({ fetch: ctx.app.fetch, port, hostname: host }, () => log(`console and app files on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
  server.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'EADDRINUSE' ? `port ${port} was taken while starting` : e.message));

  // Ctrl-C or a platform stop: stop taking requests and let the open ones finish, let the worker finish its round
  // (a publish or a scheduled apply), then close the database properly (it writes its files on close), instead of
  // being cut off mid-write. Live-update streams never end on their own, so they are closed after a few seconds.
  // A second Ctrl-C stops at once.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${signal}: stopping`);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const http = server as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
    http.closeIdleConnections?.();
    const force = setTimeout(() => http.closeAllConnections?.(), 5000);
    await closed;
    clearTimeout(force);
    await ctx.workers.stop();
    await ctx.db.close().catch((e) => console.error(`[ff] closing the database: ${e.message}`));
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}
