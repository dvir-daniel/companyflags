// Plugins: the parts of CompanyFeatures an installation turns on in companyfeatures.config.ts, the way Better Auth's
// plugins are. The core is the console and its API, sign-in, the evaluator, the change journal, publishing and app
// links. A plugin adds a way to read flags (OFREP, flagd JSON, app files) or something to do after a publish (a CDN
// purge). The built-in ones are in plugins/; each is a function that takes its options and returns a Plugin.
//
//   export default defineConfig({ plugins: [ofrep(), flagd(), appFiles(), cloudflare()] });
//
// A plugin's setup runs once, when the server starts, with what the core shares (PluginContext). What it returns is
// mounted by createApp (index.ts): its routes at the root, its console routes under /api behind the console's sign-in,
// and its onPublish after each environment publishes (workers.ts).

import { Hono } from 'hono';
import type { Db } from './db.ts';
import type { DataPlane } from './snapshot.ts';
import type { EventHub } from './events.ts';
import type { KeyCache } from './auth.ts';
import type { AppCache, LinkCache } from './delivery.ts';
import type { Person } from './access.ts';
import type { Actor } from './layers.ts';
import type { Purger } from './purge.ts';

/** What the core shares with plugins. */
export type PluginContext = {
  /** The journaled database (journal.ts): a change made through it is recorded, and published once it commits. */
  db: Db;
  /** What each environment serves now, one snapshot per environment. */
  plane: Pick<DataPlane, 'snapshots'>;
  /** Live updates: a plugin can tell its readers when an environment publishes (events.ts). */
  hub: EventHub;
  /** API keys, app-link secrets and flag sets, kept in memory and cleared when they change (journal.ts). */
  keys: KeyCache;
  links: LinkCache;
  flagSets: AppCache;
  log: (m: string) => void;
};

/** What a plugin's console routes may use: who is asking is c.get('user'), set by the console's sign-in. */
export type ConsoleHelpers = {
  actor: (u: Person) => Actor;
  /** Refuses (403) anyone who isn't an admin. */
  adminOnly: (u: Person) => void;
};
export type ConsoleRoutes = Hono<{ Variables: { user: Person } }>;
/** A plugin's console routes, to fill in and return from its `console`. */
export const consoleRoutes = (): ConsoleRoutes => new Hono<{ Variables: { user: Person } }>();

export type PluginParts = {
  /** Served at the root, for apps and backends (e.g. /ofrep/v1/…). */
  routes?: Hono;
  /** Its own address prefixes: an unknown address under one is a JSON 404, never the console's page. */
  prefixes?: string[];
  /** Served under /api for the console, signed in, as its other routes are (e.g. a settings page's). */
  console?: (h: ConsoleHelpers) => ConsoleRoutes;
  /** After an environment publishes, once per publish: 'off' when it had nothing to do. A failure is logged and kept
   *  on the publish (Settings shows it); it never undoes the publish. */
  onPublish?: Purger;
};

export type Plugin = {
  /** Its name, unique, in lowercase with dashes: the console reads which are on from /api/meta. */
  id: string;
  setup: (ctx: PluginContext) => PluginParts | Promise<PluginParts>;
};

/** Types a plugin: `export const myPlugin = (o: Options) => definePlugin({ id: 'my-plugin', setup: (ctx) => ({ … }) })`. */
export const definePlugin = (p: Plugin): Plugin => p;

/** Each plugin's setup, in order; a name used twice is a mistake in the config. */
export async function setUpPlugins(plugins: readonly Plugin[], ctx: PluginContext): Promise<{ id: string; parts: PluginParts }[]> {
  const seen = new Set<string>();
  const out: { id: string; parts: PluginParts }[] = [];
  for (const p of plugins) {
    if (!p || typeof p.setup !== 'function' || !/^[a-z][a-z0-9-]*$/.test(p.id ?? '')) {
      throw new PluginError(`not a plugin: ${JSON.stringify(p?.id ?? p)} (a plugin has an id in lowercase and a setup function)`);
    }
    if (seen.has(p.id)) throw new PluginError(`the plugin "${p.id}" is listed twice in plugins`);
    seen.add(p.id);
    out.push({ id: p.id, parts: await p.setup(ctx) });
  }
  return out;
}

export class PluginError extends Error {}

/** The plugins' onPublish, one after the other, as the publisher's one purger: 'off' when none had anything to do. */
export function publishHooks(set: { parts: PluginParts }[]): Purger | undefined {
  const hooks = set.map((s) => s.parts.onPublish).filter((h): h is Purger => !!h);
  if (!hooks.length) return undefined;
  return async (environment) => {
    let any = false;
    for (const h of hooks) if ((await h(environment)) !== 'off') any = true;
    return any ? 'purged' : 'off';
  };
}
