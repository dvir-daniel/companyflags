// Plugins: the parts of CompanyFlags an installation turns on in companyflags.config.ts, the way Better Auth's
// plugins are. The core is the console and its API, sign-in, the evaluator, the change journal, publishing and app
// links. A plugin adds a way to read flags (OFREP, flagd JSON, CDN files), work to do after a publish (a CDN purge),
// work of its own in the background (sending webhooks), or another way into the console's API (MCP, for agents). The built-in ones are in plugins/; each is a function that
// takes its options and returns a Plugin.
//
//   export default defineConfig({ plugins: [ofrep(), flagd(), cdnFiles(), cloudflare(), webhooks(), mcp()] });
//
// A plugin's setup runs once, when the server starts, with what the core shares (PluginContext). What it returns is
// mounted by createApp (index.ts): its routes at the root, its console routes under /api behind the console's sign-in
// (after the core's own, so a core route always wins), and its onPublish after each environment publishes (workers.ts).

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { HttpError, type Db } from './db.ts';
import type { EventHub, PublishScope } from './events.ts';
import type { KeyCache } from './auth.ts';
import type { AppCache, LinkCache } from './delivery.ts';
import type { Person } from './access.ts';
import type { Actor } from './layers.ts';
import type { Sealer } from './sealed.ts';
import type { PublishState } from './workers.ts';
import { contextFor, evaluate, sortedFlagKeys, UnknownEntityError, type EvalResult, type Snapshot } from './evaluator.ts';

/** What each environment serves now, one snapshot per environment. A snapshot never changes once built. */
export type Snapshots = {
  readonly snapshots: ReadonlyMap<string, Snapshot>;
  /** @internal, for the built-in plugins: rebuild an environment's snapshot from the database, for a reader that knows
   *  this server is behind (OFREP's flagConfigEtag, ofrep.ts). The workers tell the others listening (workers.ts). */
  refresh?(db: Db, environment: string): Promise<Snapshot>;
};

/** Who asks the evaluator: a service, the entity (none: what everyone gets before sign-in), and what the device or
 *  request says about itself, flat ("app.version", "device.id"). Only the attributes an app may report are used. */
export type Asking = { service: string; entity?: string | null; attrs?: Record<string, unknown> };
/** One flag's answer, or every flag sent to the service, as OFREP answers them. 404 for an unknown environment or
 *  entity. */
export type Evaluate = {
  (environment: string, who: Asking, flagKey: string): EvalResult;
  (environment: string, who: Asking): EvalResult[];
};

/** After an environment publishes: 'purged' when it purged a cache (Settings → CDN shows when), 'off' when it had
 *  nothing to do, and nothing for any other work it did. `scope`: whose answers the publish may have changed (null:
 *  anyone's in the environment; events.ts PublishScope), so a cache drops only what changed. */
export type OnPublish = (environment: string, scope?: PublishScope) => Promise<void | 'off' | 'purged'>;

/** What the core shares with plugins. */
export type PluginContext = {
  /** The server's database. Writing to it doesn't add to History or publish anything, and a plugin has no tables of
   *  its own: the migrations are the core's. */
  db: Db;
  /** What each environment serves now. */
  plane: Snapshots;
  /** hub.subscribe: every server process hears each publish (its own, or one it caught up with), for live readers
   *  such as an event stream. onPublish runs once per publish, in one process, for work done once. */
  hub: Pick<EventHub, 'subscribe'>;
  /** The one evaluator (evaluator.ts), for a plugin that reads flags: it answers as OFREP does. */
  evaluate: Evaluate;
  /** The server's environment variables (a test passes its own). */
  env: Readonly<Record<string, string | undefined>>;
  /** The console's address (BETTER_AUTH_URL), for links in what a plugin sends; unknown when it isn't set. */
  baseURL?: string | null;
  log: (m: string) => void;
  /** The core app's own fetch: a request to the console's API (`/api/...`) answered in this process, with no network
   *  in between, exactly as a script's request would be. Send the caller's own `Authorization: Bearer cfp_…` (an
   *  access token, tokens.ts) and every role, approval and History entry holds as for them: a plugin that changes flags
   *  goes through it, never around it (the mcp plugin). It works once the server is built, so call it from a
   *  request, not from setup. */
  request: (input: string, init?: RequestInit) => Promise<Response>;
  /** Seals a secret a plugin keeps for another system before it goes into the database, and opens it again
   *  (sealed.ts: AES-GCM, with a key from BETTER_AUTH_SECRET). `open` throws a SealError for a value sealed with
   *  another secret. */
  secrets: Sealer;
  /** How far each environment's publishing is behind, as /readyz reports it (workers.ts). */
  publishState: () => Promise<PublishState[]>;
  /** What /readyz warns about without failing: purges that didn't go through, and the plugins' own `warnings`. */
  warnings: () => Promise<string[]>;
  /** @internal, for the built-in plugins: API keys, app-link secrets and services, kept in memory and cleared when
   *  they change (journal.ts). */
  keys: KeyCache;
  /** @internal, for the built-in plugins */
  links: LinkCache;
  /** @internal, for the built-in plugins */
  services: AppCache;
};

/** What a plugin's console routes may use: who is asking is c.get('user'), set by the console's sign-in. */
export type ConsoleHelpers = {
  actor: (u: Person) => Actor;
  /** Refuses (403) anyone who isn't an admin. */
  adminOnly: (u: Person) => void;
  /** The request's JSON body, an object: an empty body is a 400 (bad_json), or {} when `optional`. A body that
   *  isn't a JSON object never gets this far. */
  body: <T = Record<string, unknown>>(c: Context, optional?: boolean) => Promise<T>;
};
export type ConsoleRoutes = Hono<{ Variables: { user: Person } }>;
/** A plugin's console routes, to fill in and return from its `console`. */
export const consoleRoutes = (): ConsoleRoutes => new Hono<{ Variables: { user: Person } }>();

/** A plugin's root routes, to fill in and return as its `routes`: made with the server's own Hono, so the types
 *  match whatever copy of hono the plugin's folder has. */
export const pluginRoutes = (): Hono => new Hono();

export type PluginParts = {
  /** Served at the root, for apps and backends (e.g. /ofrep/v1/…). Every route is under one of its `prefixes`: one
   *  that isn't stops the start. */
  routes?: Hono;
  /** Its own address prefixes, such as '/ofrep': its routes live under them, and an unknown address under one is a
   *  JSON 404, never the console's page. Each starts with '/', and none is the core's (CORE_PREFIXES) or another
   *  plugin's. */
  prefixes?: string[];
  /** Runs on every request, before the routes (the metrics plugin counts them): call `await next()` to go on. It
   *  sees each answer once it's made. It may add headers, never change who may do what. */
  middleware?: MiddlewareHandler;
  /** Served under /api for the console, signed in, as its other routes are (e.g. a settings page's). The core's own
   *  routes come first: a plugin can't answer in their place. */
  console?: (h: ConsoleHelpers) => ConsoleRoutes;
  /** After an environment publishes, once per publish. A failure is logged with the plugin's name and kept on the
   *  publish; it never undoes the publish, and the other plugins' onPublish still run. */
  onPublish?: OnPublish;
  /** What an operator should know, though the server serves (a CDN purge that can't run): /readyz lists them under
   *  `warnings`, still answering 200, and the metrics plugin counts them. */
  warnings?: () => Promise<string[]> | string[];
  /** Work it does on its own, in the background (sending webhooks): running from setup, stopped before the database
   *  closes. `wake`: something changed, look now; `drain`: let the round under way, and one more, finish (tests). */
  worker?: { wake: () => void; stop: () => Promise<void>; drain: () => Promise<void> };
};

export type Plugin = {
  /** Its name, unique, in lowercase with dashes: the console reads which are on from /api/meta. */
  id: string;
  setup: (ctx: PluginContext) => PluginParts | Promise<PluginParts>;
};

/** Types a plugin: `export const myPlugin = (o: Options) => definePlugin({ id: 'my-plugin', setup: (ctx) => ({ … }) })`. */
export const definePlugin = (p: Plugin): Plugin => p;

export class PluginError extends Error {}

/** The address prefixes of the core: the console's API, the app links for backends, OAuth sign-in for MCP clients
 *  (oauth.ts), the health checks and the console's own files. A plugin can claim none of them, nor anything under
 *  them. (/sdk is shared: the core's links, and the flagd plugin's /sdk/v1/flagd.) */
export const CORE_PREFIXES = ['/api', '/sdk/v1/links', '/oauth', '/.well-known', '/healthz', '/readyz', '/assets', '/index.html'];
const within = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
/** Whether an address (a route's path, '/ofrep/*' or '/hooks/v1/:token') is under a prefix. */
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** The plugin's routes that aren't under one of its prefixes (a route for every address, '*', is under none). */
function strayRoutes(parts: PluginParts): string[] {
  const routes = parts.routes?.routes ?? [];
  const mine = parts.prefixes ?? [];
  return routes.filter((r) => {
    const path = r.path.replace(/\/?\*$/, '') || '/';
    return !mine.some((p) => under(path, p));
  }).map((r) => `${r.method === 'ALL' ? '' : `${r.method} `}${r.path}`);
}

/** Each plugin's setup, in order, once every entry is known to be a plugin with a name of its own. If one setup
 *  fails, the background work of those before it is stopped, and the error is passed on. */
export async function setUpPlugins(plugins: readonly Plugin[], ctx: PluginContext): Promise<{ id: string; parts: PluginParts }[]> {
  const seen = new Set<string>();
  for (const p of plugins) {
    if (!p || typeof p.setup !== 'function' || !/^[a-z][a-z0-9-]*$/.test(p.id ?? '')) {
      throw new PluginError(`not a plugin: ${JSON.stringify(p?.id ?? p)} (a plugin has an id in lowercase and a setup function)`);
    }
    if (seen.has(p.id)) throw new PluginError(`the plugin "${p.id}" is listed twice in plugins`);
    seen.add(p.id);
  }
  const out: { id: string; parts: PluginParts }[] = [];
  const claimed: { prefix: string; id: string }[] = [];
  try {
    for (const p of plugins) {
      const parts = (await p.setup(ctx)) ?? {};
      out.push({ id: p.id, parts });
      for (const prefix of parts.prefixes ?? []) {
        if (typeof prefix !== 'string' || !/^\/[^/]/.test(prefix) || prefix.endsWith('/')) {
          throw new PluginError(`the plugin "${p.id}": a prefix starts with / and doesn't end with one, like '/${p.id}' (not ${JSON.stringify(prefix)})`);
        }
        const core = CORE_PREFIXES.find((c) => within(prefix, c));
        if (core) throw new PluginError(`the plugin "${p.id}": the prefix ${prefix} is taken by the core (${core})`);
        const other = claimed.find((c) => within(prefix, c.prefix));
        if (other) throw new PluginError(`the plugin "${p.id}": the prefix ${prefix} is taken by the plugin "${other.id}" (${other.prefix})`);
        claimed.push({ prefix, id: p.id });
      }
      const stray = strayRoutes(parts);
      if (stray.length) {
        const where = parts.prefixes?.length ? `its prefixes (${parts.prefixes.join(', ')})` : 'a prefix of its own: add prefixes: [\'/…\']';
        throw new PluginError(`the plugin "${p.id}": the route ${stray[0]} isn’t under ${where}`);
      }
      if (parts.middleware !== undefined && typeof parts.middleware !== 'function') {
        throw new PluginError(`the plugin "${p.id}": middleware is a function (c, next) => …`);
      }
    }
  } catch (e) {
    await Promise.all(out.map((s) => s.parts.worker?.stop().catch(() => {})));
    throw e;
  }
  return out;
}

/** The plugins' onPublish failed after a publish: which ones and why, and whether a cache was purged all the same. */
export class PublishHookError extends Error {
  purged: boolean;
  constructor(message: string, purged: boolean) { super(message); this.purged = purged; }
}

/** The plugins' onPublish as the publisher's one hook. Each one runs, whatever the others do. 'purged' when one of
 *  them purged a cache; the failures are thrown together, each with its plugin's name, once all have finished. */
export function publishHooks(set: readonly { id: string; parts: PluginParts }[]): OnPublish | undefined {
  const hooks = set.flatMap((s) => (s.parts.onPublish ? [{ id: s.id, run: s.parts.onPublish }] : []));
  if (!hooks.length) return undefined;
  return async (environment, scope = null) => {
    const results = await Promise.allSettled(hooks.map(async (h) => h.run(environment, scope)));
    const purged = results.some((r) => r.status === 'fulfilled' && r.value === 'purged');
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${hooks[i].id}: ${(r.reason as Error)?.message ?? String(r.reason)}`] : []));
    if (failed.length) throw new PublishHookError(failed.join('; '), purged);
    if (purged) return 'purged';
  };
}

/** The evaluator for plugins (PluginContext.evaluate): the context made as for an app (contextFor, trust 'app'), then
 *  the same evaluate OFREP answers with. */
export function evaluatorFor(plane: Snapshots): Evaluate {
  function run(environment: string, who: Asking, flagKey: string): EvalResult;
  function run(environment: string, who: Asking): EvalResult[];
  function run(environment: string, who: Asking, flagKey?: string): EvalResult | EvalResult[] {
    const snap = plane.snapshots.get(environment);
    if (!snap) throw new HttpError(404, `environment "${environment}" not found`);
    let ctx;
    try {
      ctx = contextFor(snap, { project: who.service, entity: who.entity ?? null }, who.attrs);
    } catch (e) {
      if (e instanceof UnknownEntityError) throw new HttpError(404, e.message);
      throw e;
    }
    if (flagKey !== undefined) return evaluate(snap, flagKey, ctx, false);
    return sortedFlagKeys(snap).filter((k) => snap.flags[k].delivery.includes(who.service)).map((k) => evaluate(snap, k, ctx, false));
  }
  return run;
}
