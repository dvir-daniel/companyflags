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
import { loadConfig, resolveConfig, type Resolved } from './config.ts';
import { createAccess } from './access.ts';
import { betterAuthAccounts, createAuth, SetupError } from './betterAuth.ts';
import { discoverOverHttp, singleSignOn, vouchingConnections, type Discover } from './sso.ts';
import { EventHub } from './events.ts';
import { AppCache, LinkCache, linkRoutes } from './delivery.ts';
import { KeyCache } from './auth.ts';
import { journaled } from './journal.ts';
import type { Purger } from './purge.ts';
import { PluginError, publishHooks, setUpPlugins, type Plugin } from './plugin.ts';
import { defaultPlugins, type CloudflareOptions, type WebhooksOptions } from './plugins/index.ts';
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
  /** The plugins (plugin.ts, plugins/): what reads flags besides the console, and what runs after a publish. Without
   *  a list, every built-in one, with a Cloudflare purge that has no `fetch` unless `cdn` gives one, so an app made in
   *  a test never purges a real Cloudflare zone (the server's own start passes the config's list, config.ts). */
  plugins?: Plugin[];
  /** tests: the built-in Cloudflare plugin's options, when `plugins` isn't given */
  cdn?: CloudflareOptions;
  /** tests: a purger of their own instead of the plugins' onPublish (publish.test.ts) */
  purge?: Purger;
  /** tests: the built-in webhooks plugin's options, when `plugins` isn't given: without a `fetch` it sends nothing */
  webhooks?: WebhooksOptions;
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
  // the plugins (plugin.ts): set up once, with what the core shares
  const plugins = await setUpPlugins(opts.plugins ?? defaultPlugins({ cloudflare: opts.cdn ?? { fetch: undefined }, webhooks: opts.webhooks ?? { fetch: undefined } }),
    { db, plane, hub, keys, links, flagSets: apps, baseURL: settings?.baseURL, log }).catch(async (e) => { await store.close(); throw e; });
  const on = new Set(plugins.map((p) => p.id));
  const publisher = startWorkers(db, plane, hub, log, opts.purge ?? publishHooks(plugins), {
    onRemoteChange: () => { links.forget(); keys.forget(); apps.forget(); },
  });
  // The plugins' own background work (sending webhooks) runs beside the publisher: a slow address never holds it up.
  const background = plugins.map((p) => p.parts.worker).filter((w): w is NonNullable<typeof w> => !!w);
  const workers = {
    wake: () => { publisher.wake(); for (const w of background) w.wake(); },
    stop: async () => { await Promise.all([publisher.stop(), ...background.map((w) => w.stop())]); },
    drain: async () => { await publisher.drain(); for (const w of background) await w.drain(); },
  };

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
  app.route('/api', consoleApi({ db, plane, hub, identity, access, sso, plugins }));
  app.route('/', linkRoutes({ db, plane, links, keys, flagSets: apps }, { files: on.has('app-files') }));   // app links, for backends
  for (const p of plugins) if (p.parts.routes) app.route('/', p.parts.routes);
  // An unknown address under the API, the app files or the backend downloads is a 404 with a JSON error,
  // never the console's page (which answers every other address, below). The built-in plugins' prefixes stay JSON
  // even when the plugin is off.
  const noSuchEndpoint = (c: Context) => c.json({ error: `no such endpoint: ${c.req.method} ${c.req.path}` }, 404);
  const prefixes = new Set(['/api', '/client', '/sdk', '/ofrep', '/hooks', ...plugins.flatMap((p) => p.parts.prefixes ?? [])]);
  for (const prefix of prefixes) {
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
  return { app, db, plane, hub, workers, identity, plugins: [...on] };
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

/** Starts the server as configured (config.ts): the port first, then the database, then the requests. Used when this
 *  file is run (node server/index.ts) and by the CLI's start (cli.ts). */
export async function start(o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const fail = (m: string): never => { console.error(`[ff] ${m}`); process.exit(1); };
  const log = (m: string) => console.log(`[ff] ${m}`);
  let resolved: Resolved;
  let file: string | null;
  try {
    const loaded = await loadConfig(o);
    file = loaded.file;
    resolved = resolveConfig(loaded.config, o.env ?? process.env);
  } catch (e) { return fail((e as Error).message); }
  const { port, host, signIn } = resolved;
  // the port first: a second copy started by mistake stops here, before it opens any data
  if (!(await portFree(port, host))) {
    fail(`port ${port} is already in use: CompanyFeatures may already be running (open http://localhost:${port}), or start this one with PORT=<another port>`);
  }
  if (file) log(`config: ${file}`);
  const ctx = await createApp({ databaseUrl: resolved.databaseUrl, dataDir: resolved.dataDir, signIn, plugins: resolved.plugins, log })
    .catch((e: Error) => (e instanceof FolderInUseError || e instanceof MigrationError || e instanceof SetupError || e instanceof PluginError ? fail(e.message) : Promise.reject(e)));
  log(`plugins: ${ctx.plugins.join(', ') || 'none'}`);
  if (signIn.kind === 'better-auth') {
    const settings = signIn.settings;
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

if (import.meta.url === `file://${process.argv[1]}`) await start();
