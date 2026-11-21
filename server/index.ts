import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type ErrorHandler, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import { secureHeaders } from 'hono/secure-headers';
import { consoleApi } from './api.ts';
import { createTokens } from './tokens.ts';
import { OAUTH_PREFIXES, oauthRoutes } from './oauth.ts';
import { codeOf, DatabaseCaError, FolderInUseError, FolderVersionError, HttpError, openDb, type Db, type ErrorCode } from './db.ts';
import { MigrationError } from './migrate.ts';
import { createIdentity, signInFromEnv, type SignIn } from './identity.ts';
import { configDir, loadConfig, resolveConfig, type Resolved } from './configFile.ts';
import { createAppearance } from './appearanceStore.ts';
import { AppearanceError } from './appearance.ts';
import { createAccess } from './access.ts';
import { authSecret, betterAuthAccounts, createAuth, localSecret, rateLimitsOn, SetupError, setupTokenFor } from './betterAuth.ts';
import { discoverOverHttp, singleSignOn, vouchingConnections, type Discover } from './sso.ts';
import { EventHub } from './events.ts';
import { AppCache, LinkCache, linkRoutes } from './delivery.ts';
import { KeyCache } from './auth.ts';
import { journaled } from './journal.ts';
import { anyPurges, evaluatorFor, PluginError, publishHooks, setUpPlugins, type OnPublish, type Plugin, type PluginParts } from './plugin.ts';
import { setTagSecret } from './purge.ts';
import { defaultPlugins } from './plugins/index.ts';
import { syncFields } from './fields.ts';
import { DataPlane } from './snapshot.ts';
import { publishState, startWorkers, type PublishState } from './workers.ts';
import { sealer, sealStoredSecrets } from './sealed.ts';
import { CONSOLE_FOLDER, VERSION } from './packageFolder.ts';
import { flagsFileSchema } from './flagsAsCode.ts';

export type AppOptions = {
  databaseUrl?: string;                  // a Postgres server; without it, embedded Postgres in dataDir (or in memory)
  dataDir?: string;
  signIn?: SignIn;                       // how people sign in to the console (identity.ts); default: from the environment
  discover?: Discover;                   // reads an OIDC identity provider's settings (sso.ts); tests hand it the documents
  setup?: (db: Db) => Promise<void>;     // tests: fill a new, empty database
  log?: (m: string) => void;
  /** The plugins (plugin.ts, plugins/): what reads flags besides the console, and what runs after a publish. Without
   *  a list, every built-in one, with no `fetch` for Cloudflare or webhooks, so an app made in a test never reaches
   *  them (the server's own start passes the config's list, configFile.ts). A test gives its own, with fakes. */
  plugins?: Plugin[];
  /** The environment variables the plugins read (CF_ZONE_ID, …): process.env unless a test gives its own. */
  env?: NodeJS.ProcessEnv;
  /** tests: their own hook after each publish instead of the plugins' onPublish (publish.test.ts) */
  onPublish?: OnPublish;
  /** The config file's appearance (configFile.ts): set, it can't be changed in the console. */
  appearance?: unknown;
  /** false: don't apply migrations, only check the schema has them (--no-migrate, FF_MIGRATE=off). Default true. */
  migrate?: boolean;
  /** At most this many connections to a Postgres server (database.pool, FF_DB_POOL). */
  pool?: number;
  /** A PEM file of the certificate authorities a Postgres server's certificate is checked against (database.caFile,
   *  FF_DATABASE_CA_FILE). */
  databaseCaFile?: string;
  /** Days the publish log is kept (retention.publishLogDays). */
  publishLogDays?: number;
  /** tests: a migrated in-memory database to start from (db.ts embeddedTemplate) */
  template?: Blob;
};

export async function createApp(opts: AppOptions = {}) {
  const log = opts.log ?? (() => {});
  const { db: store, fresh, applied, newer } = await openDb({ url: opts.databaseUrl, dataDir: opts.dataDir, log, migrate: opts.migrate, pool: opts.pool, caFile: opts.databaseCaFile, template: opts.template });
  if (applied.length) log(`database: applied ${applied.join(', ')}`);
  if (newer.length) log(`warning: the database has migrations of a newer version (${newer.join(', ')}): this server keeps running, but upgrade it soon`);
  await syncFields(store);
  if (fresh && opts.setup) await opts.setup(store);          // before the app runs: nothing in memory to tell yet
  const plane = new DataPlane();
  for (const env of (await store.query<{ key: string }>(`select key from environment`)).rows) await plane.refresh(store, env.key);
  // A new database's setup (tests) is in the snapshots just built: nothing of it to publish. On a
  // database in use, rows still waiting are left to the workers: another server on it may be publishing them right
  // now, and publishing one twice (a rebuild, a CDN purge) does no harm.
  if (fresh) await store.query(`update publish_queue set published_at = now() where published_at is null`);

  const hub = new EventHub();
  // What this server keeps in memory is its own: two servers in one process share nothing. The change journal
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
  // The server's secret (BETTER_AUTH_SECRET, or away from production one it made for itself): it makes the setup link,
  // whose secret the first account (the admin's) is made only with (access.ts), and seals the secrets kept for other
  // systems (sealed.ts). Those saved before they were sealed are sealed now.
  const secret = await (settings ? authSecret(store, settings) : localSecret(store)).catch(async (e) => { await store.close(); throw e; });
  const setupToken = settings ? setupTokenFor(secret) : undefined;
  const secrets = sealer(secret);
  setTagSecret(secret);                                   // the CDN files' cache tags (purge.ts): the same on every server
  const sealedNow = await sealStoredSecrets(store, secrets).catch(async (e) => { await store.close(); throw e; });
  if (sealedNow) log(`sealed the secrets of ${sealedNow} saved settings (the CDN token, webhooks) with a key from BETTER_AUTH_SECRET`);
  const access = createAccess(db, {
    accounts: betterAuthAccounts, connections: vouchingConnections, signupDomains: settings?.signupDomains, setupToken, ssoSessionHours: settings?.ssoSessionHours,
  });
  const auth = settings ? await createAuth(store, settings, access).catch(async (e) => { await store.close(); throw e; }) : undefined;
  const identity = createIdentity(signIn, access, auth);
  const sso = singleSignOn(db, {
    access, plugin: auth, discover: opts.discover ?? discoverOverHttp(settings?.trustedOrigins ?? []), baseURL: settings?.baseURL, production: settings?.production, trustedOrigins: settings?.trustedOrigins,
  });
  // the plugins (plugin.ts): set up once, with what the core shares. `request` is the app's own fetch, bound once the
  // app below is built.
  let built: Hono | null = null;
  const request = async (input: string, init?: RequestInit) => {
    if (!built) throw new Error('the server isn’t built yet: call request from a request, not from a plugin’s setup');
    return built.request(input, init);
  };
  // What /readyz warns of without failing (a purge that didn't go through, the plugins' own warnings), read once the
  // plugins are set up.
  let pluginsSetUp: { id: string; parts: PluginParts }[] = [];
  const warningsOf = async (state?: PublishState[]): Promise<string[]> => {
    const purges = (state ?? await publishState(store, plane)).filter((s) => s.purgeError)
      // why is in Settings → CDN and the log, not in a public answer
      .map((s) => `the CDN purge after ${s.environment}’s last publish didn’t go through: apps reading CDN files get changes only once the CDN’s minute is up (Settings → CDN and the server’s log say why)`);
    const own = await Promise.all(pluginsSetUp.map(async (p) => {
      try { return (await p.parts.warnings?.()) ?? []; } catch (e) { return [`${p.id}: ${(e as Error).message}`]; }
    }));
    return [...purges, ...own.flat()];
  };
  const plugins = await setUpPlugins(opts.plugins ?? defaultPlugins({ cloudflare: { fetch: undefined }, webhooks: { fetch: undefined } }), {
    db, plane, hub, evaluate: evaluatorFor(plane), env: opts.env ?? process.env, baseURL: settings?.baseURL, log, request, secrets,
    publishState: () => publishState(store, plane), warnings: () => warningsOf(), purging: () => anyPurges(pluginsSetUp), keys, links, services: apps,
  }).catch(async (e) => { await store.close(); throw e; });
  pluginsSetUp = plugins;
  const on = new Set(plugins.map((p) => p.id));
  const publisher = startWorkers(db, plane, hub, log, opts.onPublish ?? publishHooks(plugins), {
    onRemoteChange: () => { links.forget(); keys.forget(); apps.forget(); }, publishLogDays: opts.publishLogDays,
  });
  // The plugins' own background work (sending webhooks) runs beside the publisher: a slow address never holds it up.
  const background = plugins.map((p) => p.parts.worker).filter((w): w is NonNullable<typeof w> => !!w);
  const workers = {
    wake: () => { publisher.wake(); for (const w of background) w.wake(); },
    stop: async () => { await Promise.all([publisher.stop(), ...background.map((w) => w.stop())]); },
    drain: async () => { await publisher.drain(); for (const w of background) await w.drain(); },
  };

  const appearance = createAppearance(db, opts.appearance);   // checked now: a mistake in the config file stops here
  const app = new Hono();
  app.onError(errorHandler(log));
  // the plugins' middleware (plugin.ts): first, so it sees every request and every answer (the metrics plugin)
  for (const p of plugins) if (p.parts.middleware) app.use('*', p.parts.middleware);
  // Every response: no sniffing, never in a frame, no referrer beyond the origin. HSTS is left to whatever ends TLS in
  // front of this server; the CDN files set their own CORS (delivery.ts), so no Cross-Origin-Resource-Policy here.
  app.use('*', secureHeaders({
    strictTransportSecurity: false, crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false,
    xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin',
  }));
  app.use('*', bodyLimits());
  // For load balancers and orchestrators: /healthz answers while the process runs, /readyz while this process can serve:
  // the database answers, and it has the environments' snapshots loaded. Both say the version. For alerting, it lists
  // the environments whose publish fails (`failing`) and `warnings` (a CDN purge that didn't go through, or can't run),
  // still answering 200: one broken environment doesn't take every instance out.
  app.get('/healthz', (c) => c.json({ ok: true, version: VERSION }));
  app.get('/flags.schema.json', (c) => c.json(flagsFileSchema()));   // flags as code's file, for editors (flagsAsCode.ts)
  app.get('/readyz', async (c) => {
    let state: PublishState[];
    try {
      state = await publishState(store, plane);
    } catch {
      return c.json({ ok: false, version: VERSION, error: 'the database isn’t answering', code: 'unavailable', failing: [] }, 503);
    }
    // what each environment serves, and how far its publishing is behind. A snapshot that can't be built keeps the old
    // values serving: the environment is in `failing` (for alerts), and the log says why (workers.ts). It stays ready:
    // the publish fails the same way on every instance, and taking them all out would stop serving the old values too.
    // An environment made a moment ago on another instance has `serving: null` here until the next round loads it.
    const environments = Object.fromEntries(state.map((s) => [s.environment, {
      revision: s.revision, serving: s.serving, lagSeconds: s.lagSeconds, failing: !!s.error, purgeFailing: !!s.purgeError,
    }]));
    const warnings = await warningsOf(state).catch(() => []);
    const failing = state.filter((s) => s.error).map((s) => s.environment);
    if (state.length && state.every((s) => s.serving === null)) {
      return c.json({ ok: false, version: VERSION, error: 'this server serves no environment yet', code: 'unavailable', failing, environments, warnings }, 503);
    }
    return c.json({ ok: true, version: VERSION, failing, environments, warnings });
  });
  app.route('/api', identity.routes);                    // sign-in pages and Better Auth: open to everyone
  app.route('/api', appearance.routes());                // the name, logo and note the sign-in page shows: open too
  const tokens = createTokens(db);
  app.route('/api', consoleApi({ db, plane, hub, identity, access, sso, tokens, plugins, appearance }));
  app.route('/', linkRoutes({ db, plane, links, keys, services: apps }, { files: on.has('cdn-files') }));   // app links, for backends
  for (const p of plugins) if (p.parts.routes) app.route('/', p.parts.routes);
  // OAuth sign-in for MCP clients (oauth.ts): on with the mcp plugin
  if (on.has('mcp')) app.route('/', oauthRoutes({ db, identity, access, baseURL: settings?.baseURL }));
  // An unknown address under the API, the CDN files or the backend downloads is a 404 with a JSON error,
  // never the console's page (which answers every other address, below). The built-in plugins' prefixes stay JSON
  // even when the plugin is off.
  const noSuchEndpoint = (c: Context) => c.json({ error: `no such endpoint: ${c.req.method} ${c.req.path}`, code: 'not_found' }, 404);
  const prefixes = new Set(['/api', '/cdn', '/sdk', '/ofrep', '/hooks', '/mcp', ...(on.has('mcp') ? OAUTH_PREFIXES : []), ...plugins.flatMap((p) => p.parts.prefixes ?? [])]);
  for (const prefix of prefixes) {
    app.all(prefix, noSuchEndpoint);
    app.all(`${prefix}/*`, noSuchEndpoint);
  }

  const dist = CONSOLE_FOLDER;                   // from the package's folder, never the one it runs in
  if (existsSync(dist)) {
    // index.html is read on every request and never cached, so a rebuild shows up on the next reload;
    // the hashed /assets files can be cached forever.
    const page = async (c: Context) => {
      const html = await appearance.page(readFileSync(`${dist}/index.html`, 'utf8'));
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      c.header('Content-Security-Policy', consolePolicy(html));
      return c.html(html);
    };
    app.get('/', page);
    app.get('/index.html', page);
    app.use('/assets/*', async (c, next) => { await next(); c.header('Cache-Control', 'public, max-age=31536000, immutable'); });
    app.use('/*', serveStatic({ root: dist }));
    app.get('*', page);
  } else {
    // A clone where the console isn't built (pnpm dev serves it with Vite instead): the server's own address says
    // where the console is, rather than a bare 404. The setup link lands here too when it's opened on this port.
    app.get('/', (c) => {
      c.header('Cache-Control', 'no-store');
      return c.html(CONSOLE_NOT_BUILT, 404);
    });
  }
  built = app;
  return { app, db, plane, hub, workers, identity, plugins: [...on], setupToken, needsSetup: () => access.needsSetup() };
}

const KB = 1024;
/** The most a request may send, by where it goes (the first prefix that matches), and everywhere else. */
export const BODY_LIMITS: readonly (readonly [prefix: string, bytes: number])[] = [
  ['/api/auth/', 256 * KB],          // sign-in forms, and providers' and single sign-on's answers (a SAML answer)
  ['/ofrep/', 64 * KB],              // an evaluation context
  ['/hooks/', 1000 * KB],            // a webhook in (webhooks.ts BODY_MAX)
  ['/api/migration/', 4096 * KB],    // a file to import
];
export const BODY_MAX = 1024 * KB;

/** Refuses (413) a body larger than its address allows. It counts the bytes as they come, so a body sent in chunks
 *  (with no Content-Length) is cut off too, before it is all in memory. */
function bodyLimits(): MiddlewareHandler {
  const size = (bytes: number) => (bytes >= 1000 * KB ? `${Math.round(bytes / (1024 * KB))} MB` : `${Math.round(bytes / KB)} KB`);
  const limit = (bytes: number) => bodyLimit({ maxSize: bytes, onError: (c) => c.json({ error: `the request body is larger than ${size(bytes)}`, code: 'too_large' }, 413) });
  const byPrefix = BODY_LIMITS.map(([prefix, bytes]) => [prefix, limit(bytes)] as const);
  const rest = limit(BODY_MAX);
  return (c, next) => (byPrefix.find(([prefix]) => c.req.path.startsWith(prefix))?.[1] ?? rest)(c, next);
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
/** Postgres's constraint violations (class 23), said plainly: its own words name tables and constraints, so they go
 *  to the log, never into the answer. */
const REFUSED: Record<string, [status: 409 | 422, code: ErrorCode, words: string]> = {
  '23505': [409, 'already_exists', 'that key is taken already'],
  '23P01': [409, 'blocked', 'that overlaps something saved already'],
  '23503': [422, 'invalid', 'the request names something that doesn’t exist, or removes something still in use'],
  '23502': [422, 'invalid', 'a value the request needs is missing'],
  '23514': [422, 'invalid', 'a value in the request isn’t allowed'],
};

/** How an error becomes a response, by what it is, never by its wording. Every answer is { error, code }: the
 *  sentence, and a stable code (db.ts ERROR_CODES) for callers to act on.
 *  - HttpError (ours) or HTTPException (Hono's): its status and message, and an HttpError's `code` and body;
 *  - a Postgres constraint violation (class 23): 409 or 422, said plainly (REFUSED), with the database's own words
 *    in the log only;
 *  - an exception raised by one of our triggers (P0001): 422 with its words, which the migrations wrote;
 *  - a value of the wrong form (BAD_VALUE): 400, said plainly;
 *  - anything else is a bug: logged with its stack, and a 500 that gives nothing away. The log names the route, not the
 *    address: an app link's or a webhook's address is its secret. */
export function errorHandler(log: (m: string) => void): ErrorHandler {
  return (err, c) => {
    if (err instanceof HttpError) return c.json({ ...err.body, error: err.message, code: err.code }, err.status as 400);
    if (err instanceof HTTPException) return c.json({ error: err.message, code: codeOf(err.status) }, err.status);       // Hono's own (e.g. a body too big)
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (BAD_VALUE.has(code)) return c.json({ error: 'a number, date or ID in the request isn’t valid', code: 'bad_request' }, 400);
      if (code === 'P0001') return c.json({ error: err.message, code: 'invalid' }, 422);
      if (code.startsWith('23')) {
        const [status, said, words] = REFUSED[code] ?? [422, 'invalid', 'the request doesn’t fit what is saved'];
        log(`refused by the database: ${c.req.method} ${loggedPath(c)}: ${err.message}`);
        return c.json({ error: words, code: said }, status);
      }
    }
    log(`error: ${c.req.method} ${loggedPath(c)}: ${err.stack ?? err.message ?? String(err)}`);
    return c.json({ error: 'internal error', code: 'internal' }, 500);
  };
}

/** Where an error happened, for the log. The console's API as it is (its addresses hold no secrets); anything else by
 *  its route as written (/cdn/v1/flags/:env/:app/:entity/:secret), never the address, which can be a secret (an
 *  app link, a webhook's address, an invite); with no such route, only the address's first two parts. */
function loggedPath(c: Context): string {
  const path = c.req.path;
  if (/^\/api\/(?!auth\/|setup\/|invites\/)/.test(path)) return path;
  let route = '';
  try { route = routePath(c); } catch { route = ''; }
  if (route && !route.includes('*')) return route;
  return path.replace(/^(\/[^/]+\/[^/]+)\/.+/, '$1/…');
}

/** Keeps an idle connection open this long (server.keepAliveSeconds, FF_KEEPALIVE_SECONDS; default 65): longer than
 *  the load balancer in front keeps one (60 seconds on AWS's and Google's), so the server never closes a connection
 *  just as the load balancer sends a request on it (a 502). Headers may take a second more (Node's own advice). */
export function keepAlive(server: HttpServer, seconds: number) {
  server.keepAliveTimeout = seconds * 1000;
  server.headersTimeout = seconds * 1000 + 1000;
}

/** Stops taking requests and lets the open ones finish. Idle keep-alive connections are closed at once, and so is each
 *  one that falls idle meanwhile (its request done), rather than after the keep-alive time; whatever is still open
 *  after `forceMs` (live-update streams) is cut. */
export async function stopHttp(server: HttpServer, forceMs = 5000) {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const idle = setInterval(() => server.closeIdleConnections(), 100);
  const force = setTimeout(() => server.closeAllConnections(), forceMs);
  await closed;
  clearInterval(idle);
  clearTimeout(force);
}

/** Whether nothing is listening on this port yet. */
function portFree(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const probe = createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** Where `pnpm dev` serves the console (vite.config.ts), when web/dist isn't built. */
export const DEV_CONSOLE = 'http://localhost:5173';

/** The server's `/` when web/dist isn't built: a clone running `pnpm dev`, or the server started before `pnpm build`. */
const CONSOLE_NOT_BUILT = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Console not built · CompanyFlags</title>
<body style="font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 16px">
<p><b>The console isn’t built here.</b> This is the API. With <code>pnpm dev</code>, the console is at <a href="${DEV_CONSOLE}">${DEV_CONSOLE}</a>.</p>
<p>To serve the console on this port too, run <code>pnpm serve</code> (or <code>pnpm build</code>, then start the server again).</p></body>`;

/** Addresses only this machine can reach. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Starts the server as configured (configFile.ts): the port first, then the database, then the requests. Used when this
 *  file is run (node server/index.ts) and by the CLI's start (cli.ts). */
export async function start(o: { cwd?: string; env?: NodeJS.ProcessEnv; migrate?: boolean } = {}) {
  const fail = (m: string): never => { console.error(`[companyflags] ${m}`); process.exit(1); };
  const log = (m: string) => console.log(`[companyflags] ${m}`);
  const env = o.env ?? process.env;
  let resolved: Resolved;
  let file: string | null;
  try {
    const loaded = await loadConfig(o);
    file = loaded.file;
    resolved = resolveConfig(loaded.config, env, configDir(loaded.file, o.cwd));
  } catch (e) { return fail((e as Error).message); }
  const { port, host, signIn } = resolved;
  // the port first: a second copy started by mistake stops here, before it opens any data
  if (!(await portFree(port, host))) {
    fail(`port ${port} is already in use: CompanyFlags may already be running (open http://localhost:${port}), or choose another port with server.port in companyflags.config.ts or PORT`);
  }
  log(`CompanyFlags ${VERSION}`);
  if (file) log(`config: ${file}`);
  const migrate = o.migrate !== false && resolved.migrate;
  if (!migrate) log('migrations: not applied at the start (--no-migrate or FF_MIGRATE=off): checking the schema has them');
  const ctx = await createApp({
    databaseUrl: resolved.databaseUrl, dataDir: resolved.dataDir, signIn, plugins: resolved.plugins, appearance: resolved.appearance ?? undefined, env, log,
    migrate, pool: resolved.pool, databaseCaFile: resolved.databaseCaFile, publishLogDays: resolved.publishLogDays,
  })
    .catch((e: Error) => (e instanceof FolderInUseError || e instanceof FolderVersionError || e instanceof DatabaseCaError || e instanceof MigrationError || e instanceof SetupError || e instanceof PluginError || e instanceof AppearanceError ? fail(e.message) : Promise.reject(e)));
  log(`plugins: ${ctx.plugins.join(', ') || 'none'}`);
  const local = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${port}`;
  // without web/dist (a clone running pnpm dev), the console is Vite's, which passes /api on to this server
  const consoleBuilt = existsSync(CONSOLE_FOLDER);
  if (!consoleBuilt) log(`the console isn’t built (web/dist): pnpm dev serves it on ${DEV_CONSOLE}; pnpm serve builds it and serves it on ${local}`);
  const consoleAddress = (signIn.kind === 'better-auth' && signIn.settings.baseURL?.replace(/\/+$/, '')) || (consoleBuilt ? local : DEV_CONSOLE);
  if (signIn.kind === 'better-auth') {
    const settings = signIn.settings;
    const ways = ['email and password', ...(['google', 'github', 'microsoft'] as const).filter((p) => settings[p])];
    log(`sign-in with Better Auth: ${ways.join(', ')}`);
    if (!rateLimitsOn(settings) && !LOOPBACK.has(host)) {
      log(`warning: sign-in has no rate limits (NODE_ENV is ${process.env.NODE_ENV ?? 'not set'}), and others can reach this server: set NODE_ENV=production`);
    }
  }
  const server = serve({ fetch: ctx.app.fetch, port, hostname: host }, () => {
    log(`CompanyFlags ${VERSION} on ${local}`);
    // the port it listens on, for a health check that can't read the config file (the Docker image's, FF_PORT_FILE)
    if (env.FF_PORT_FILE) {
      const actual = (server.address() as { port?: number } | null)?.port ?? port;
      try { writeFileSync(env.FF_PORT_FILE, `${actual}\n`); } catch (e) { log(`warning: couldn’t write FF_PORT_FILE ${env.FF_PORT_FILE}: ${(e as Error).message}`); }
    }
    // a new server: the admin account is made with this link, so whoever reaches the server first can't make it
    void ctx.needsSetup().then((needed) => {
      if (needed && ctx.setupToken) log(`nobody has an account yet: make the admin account at ${consoleAddress}/api/setup/${ctx.setupToken}`);
    }).catch(() => {});
  });
  server.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'EADDRINUSE' ? `port ${port} was taken while starting` : e.message));
  keepAlive(server as HttpServer, resolved.keepAliveSeconds);

  // Ctrl-C or a platform stop: stop taking requests and let the open ones finish, let the worker finish its round
  // (a publish or a scheduled apply), then close the database properly (it writes its files on close), instead of
  // being cut off mid-write. Live-update streams never end on their own, so they are closed after a few seconds.
  // A second Ctrl-C stops at once.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${signal}: stopping`);
    await stopHttp(server as HttpServer);
    await ctx.workers.stop();
    await ctx.db.close().catch((e) => console.error(`[companyflags] closing the database: ${e.message}`));
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

// run as a file (node server/index.ts), from any folder: one with a space in its path, or reached through a link
const runAsFile = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (runAsFile()) await start();
