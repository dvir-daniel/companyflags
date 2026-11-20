// The built-in plugins (../plugin.ts). Without a config file, or with one that doesn't list plugins, all of them are on.

import type { Plugin } from '../plugin.ts';
import { cdnFiles } from './cdnFiles.ts';
import { cloudflare, type CloudflareOptions } from './cloudflare.ts';
import { flagd } from './flagd.ts';
import { mcp } from './mcp.ts';
import { metrics, type MetricsOptions } from './metrics.ts';
import { ofrep } from './ofrep.ts';
import { webhooks, type WebhooksOptions } from './webhooks.ts';

export { cdnFiles, cloudflare, flagd, mcp, metrics, ofrep, webhooks, type CloudflareOptions, type MetricsOptions, type WebhooksOptions };
export {
  definePlugin, consoleRoutes, pluginRoutes, PluginError, CORE_PREFIXES,
  type Plugin, type PluginContext, type PluginParts, type ConsoleHelpers, type ConsoleRoutes, type OnPublish, type Evaluate, type Asking, type Snapshots,
} from '../plugin.ts';
// what a plugin's code works with: throw an HttpError to answer with that status and {"error": message}
export { HttpError, ERROR_CODES, type Db, type Queryable, type ErrorCode } from '../db.ts';
export { SealError, type Sealer } from '../sealed.ts';
export type { PublishState } from '../workers.ts';
export type { Snapshot, EvalResult } from '../evaluator.ts';
export type { Person } from '../access.ts';
export type { Actor } from '../layers.ts';

/** Every built-in plugin, as an installation without a list of its own gets them (metrics() is listed on its own). */
export const defaultPlugins = (o: { cloudflare?: CloudflareOptions; webhooks?: WebhooksOptions } = {}): Plugin[] =>
  [ofrep(), flagd(), cdnFiles(), cloudflare(o.cloudflare), webhooks(o.webhooks), mcp()];
