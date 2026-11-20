// The built-in plugins (../plugin.ts). Without a config file, or with one that doesn't list plugins, all of them are on.

import type { Plugin } from '../plugin.ts';
import { appFiles } from './appFiles.ts';
import { cloudflare, type CloudflareOptions } from './cloudflare.ts';
import { flagd } from './flagd.ts';
import { ofrep } from './ofrep.ts';

export { appFiles, cloudflare, flagd, ofrep, type CloudflareOptions };
export { definePlugin, consoleRoutes, type Plugin, type PluginContext, type PluginParts, type ConsoleHelpers } from '../plugin.ts';

/** Every built-in plugin, as an installation without a list of its own gets them. */
export const defaultPlugins = (o: { cloudflare?: CloudflareOptions } = {}): Plugin[] =>
  [ofrep(), flagd(), appFiles(), cloudflare(o.cloudflare)];
