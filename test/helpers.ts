import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp, type AppOptions } from '../server/index.ts';
import { embeddedTemplate } from '../server/db.ts';
import { defaultPlugins, type CloudflareOptions, type WebhooksOptions } from '../server/plugins/index.ts';
import { bucketFor, HASH_VERSION } from '../server/hash.ts';
import { fixtures } from './fixtures.ts';

export { cdnAnswer } from './flagdReference.ts';

// Tests never run as production (whatever the shell says): no rate limits on sign-in, no production checks.
// (The server sets Better Auth's rate limits and Origin check itself, so this doesn't depend on import order.)
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'development';

/** The header the console sends with every change (server/api.ts CSRF_HEADER). */
export const CSRF = { 'x-requested-with': 'companyflags' } as const;

// Tests use an in-memory database. With FF_TEST_PG set to a Postgres server (pnpm test:pg), each boot
// gets its own new database on that server instead, dropped again by stop().
export async function testDatabase(): Promise<{ url?: string; drop: () => Promise<void> }> {
  const admin = process.env.FF_TEST_PG;
  if (!admin) return { drop: async () => {} };
  const name = `ff_test_${randomUUID().replaceAll('-', '')}`;
  const run = async (sql: string) => { const c = new pg.Client(admin); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
  await run(`create database ${name}`);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => run(`drop database ${name} with (force)`) };
}

type App = Awaited<ReturnType<typeof createApp>>;

// In memory, every app of a test file starts from one database migrated once (db.ts embeddedTemplate): loading it is
// cheaper than replaying every migration for each. On a Postgres server (FF_TEST_PG) each still migrates its own.
let template: Promise<Blob> | undefined;

/** Every built-in plugin, as a server without a list gets them, with these options: no `fetch` for Cloudflare or
 *  webhooks unless a test gives a fake, so a test never reaches them. */
export const builtIns = (o: { cloudflare?: CloudflareOptions; webhooks?: WebhooksOptions } = {}) =>
  defaultPlugins({ cloudflare: { fetch: undefined, ...o.cloudflare }, webhooks: { fetch: undefined, ...o.webhooks } });

/** createApp on a new test database; stop() stops the workers, closes the database and drops it. If the app
 *  can't start, the database is dropped before the error is passed on. The plugins read no environment variables
 *  of the shell (CF_ZONE_ID, …) unless a test gives its own `env`. */
export async function startApp(opts: AppOptions = {}): Promise<App & { stop: () => Promise<void> }> {
  const tdb = opts.databaseUrl || opts.dataDir ? { url: opts.databaseUrl, drop: async () => {} } : await testDatabase();
  let ctx: App;
  try {
    const fromTemplate = !tdb.url && !opts.dataDir && !process.env.FF_TEST_NO_TEMPLATE;
    ctx = await createApp({ env: {}, ...opts, databaseUrl: tdb.url, ...(fromTemplate ? { template: await (template ??= embeddedTemplate()) } : {}) });
  } catch (e) {
    await tdb.drop().catch(() => {});
    throw e;
  }
  const stop = async () => { await ctx.workers.stop(); await ctx.db.close(); await tdb.drop(); };
  return { ...ctx, stop };
}

/** A response, read: its status, its body (JSON when it is), its headers, the cookies it set (as a Cookie header;
 *  a deleted cookie comes back empty) and where it redirects. */
async function read(res: Response) {
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
  return { status: res.status, json, headers: res.headers, cookie, location: res.headers.get('location') };
}

export type BrowserCall = { cookie?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> };
/** Requests as a browser on the console makes them: same origin, the session cookie if it has one, and (for a
 *  change) the console's header. A JSON body, or a form. */
export function browser(app: { app: App['app'] }, origin = 'http://localhost') {
  return async (method: string, path: string, o: BrowserCall = {}) => read(await app.app.request(path, {
    method,
    headers: {
      origin, ...(o.cookie ? { cookie: o.cookie } : {}), ...(method === 'GET' ? {} : CSRF),
      'content-type': o.form ? 'application/x-www-form-urlencoded' : 'application/json', ...o.headers,
    },
    body: o.form ? new URLSearchParams(o.form).toString() : o.body === undefined ? undefined : JSON.stringify(o.body),
  }));
}

export async function boot(opts: AppOptions = {}) {
  // a new database with the test data; X-User names the person (allowed in tests only)
  const ctx = await startApp({ setup: fixtures, signIn: { kind: 'test-header' }, ...opts });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => read(await ctx.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(method === 'GET' ? {} : CSRF), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const as = (user: string) => ({
    get: (p: string) => call('GET', `/api${p}`, undefined, { 'x-user': user }),
    post: (p: string, b?: unknown) => call('POST', `/api${p}`, b ?? {}, { 'x-user': user }),
    put: (p: string, b: unknown, h: Record<string, string> = {}) => call('PUT', `/api${p}`, b, { 'x-user': user, ...h }),
    del: (p: string, b?: unknown) => call('DELETE', `/api${p}`, b ?? {}, { 'x-user': user }),
  });
  const trace = async (body: { environment?: string; service: string; entity: string | null; attrs?: Record<string, unknown>; flag: string }) => {
    const r = await as('alice').post('/trace', { environment: 'dev', attrs: {}, ...body });
    if (r.status !== 200) throw new Error(JSON.stringify(r.json));
    return r.json.result;
  };
  const settle = () => ctx.workers.drain();
  // An entity's address in the console API: /dimensions/<its dimension>/<key> (an unknown one: in the top dimension)
  const entityPath = async (key: string) => {
    const r = await ctx.db.query<{ d: string }>(`select d.key as d from entity e join dimension d on d.id = e.dimension_id where e.key = $1`, [key]);
    const top = await ctx.db.query<{ d: string }>(`select key as d from dimension where parent_id is null`);
    return `/dimensions/${r.rows[0]?.d ?? top.rows[0]?.d ?? 'company'}/${key}`;
  };
  // What an app reads: its entity's CDN file (flagd JSON) at the entity's link (or, with no entity, the before-sign-in file)
  const link = async (environment: string, app: string, entity: string) =>
    (await as('dana').get(`${await entityPath(entity)}/link?environment=${environment}`)).json.path.replace(':service', app) as string;
  const cdnFile = async (environment: string, app: string, entity: string | null, headers: Record<string, string> = {}) =>
    call('GET', entity ? await link(environment, app, entity) : `/cdn/v1/flags/${environment}/${app}`, undefined, headers);
  /** A flag's defaults in an environment as a layer to save: without version, updatedAt and updatedBy. */
  const baseOf = async (flag: string, env: string) => {
    const { version, updatedAt: _u, updatedBy: _b, ...layer } = (await as('alice').get(`/flags/${flag}`)).json.layers[env].base;
    return { version: version as number, layer };
  };
  /** Changes a flag's defaults (get, edit, PUT with the version it had) and waits for the publish. Returns the PUT's answer. */
  const editBase = async (flag: string, env: string, edit: (layer: any) => any, o: { as?: string; reason?: string } = {}) => {
    const { version, layer } = await baseOf(flag, env);
    const r = await as(o.as ?? 'alice').put(`/flags/${flag}/layers/${env}/base`, { layer: edit(layer), expectedVersion: version, reason: o.reason });
    await settle();
    return r;
  };
  return { ...ctx, call, as, trace, settle, entityPath, link, cdnFile, baseOf, editBase };
}

/** A secret with one character changed, a few from its end: the last character of base64 can carry only padding bits,
 *  so changing it alone may not change the secret at all. */
export const changed = (secret: string) => {
  const i = secret.length - 5;
  return secret.slice(0, i) + (secret[i] === 'A' ? 'B' : 'A') + secret.slice(i + 1);
};

/** The first device id `${prefix}-0`, `${prefix}-1`… whose bucket for this salt is in [lo, hi), with the hash every % rule is
 *  saved with (or `hashVersion`). Gives up after `tries`. */
export function deviceIn(salt: string, lo: number, hi: number, o: { prefix?: string; tries?: number; hashVersion?: number } = {}): string {
  const tries = o.tries ?? 100_000;
  for (let i = 0; i < tries; i++) {
    const id = `${o.prefix ?? 'dev'}-${i}`;
    const b = bucketFor(salt, id, o.hashVersion ?? HASH_VERSION);
    if (b >= lo && b < hi) return id;
  }
  throw new Error(`no device among ${tries} ids lands in [${lo}, ${hi}) for salt "${salt}"`);
}
