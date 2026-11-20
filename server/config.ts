// companyfeatures.config.ts: one typed file for how a server runs, the way Better Auth has its auth.ts. Every
// setting is optional. What the file doesn't set comes from the environment variables (docs/self-hosting/
// configuration.md), then the defaults, so a server with no file runs as before and the Docker image needs none.
//
//   import { defineConfig } from 'companyfeatures/config';
//   import { appFiles, cloudflare, flagd, ofrep } from 'companyfeatures/plugins';
//
//   export default defineConfig({
//     database: { url: process.env.DATABASE_URL },
//     auth: { baseURL: 'https://flags.example.com' },
//     plugins: [ofrep(), flagd(), appFiles(), cloudflare()],
//   });
//
// The server (index.ts) and the CLI (cli.ts) read it from the folder they run in, or from FF_CONFIG.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { authSettingsFromEnv, type AuthSettings } from './betterAuth.ts';
import type { SignIn } from './identity.ts';
import type { Plugin } from './plugin.ts';
import { defaultPlugins } from './plugins/index.ts';

export type Config = {
  database?: {
    /** A Postgres server (DATABASE_URL). Without one, embedded Postgres in `dataDir`. */
    url?: string;
    /** Where embedded Postgres keeps its files (FF_DATA_DIR; default ./data). */
    dataDir?: string;
  };
  server?: {
    /** PORT (default 8787) and HOST (default 0.0.0.0). */
    port?: number;
    host?: string;
  };
  /** Sign-in with Better Auth: the secret, the console's address, the providers and the rest (betterAuth.ts
   *  AuthSettings). Each setting left out comes from its environment variable (BETTER_AUTH_SECRET, …). */
  auth?: Partial<AuthSettings>;
  /** What reads flags besides the console, and what runs after a publish (plugins/). Left out: all the built-in ones,
   *  with Cloudflare's zone and token from CF_ZONE_ID and CF_API_TOKEN. */
  plugins?: Plugin[];
};

/** Types a config file's default export. */
export const defineConfig = (config: Config): Config => config;

export const CONFIG_FILE = 'companyfeatures.config.ts';

export class ConfigError extends Error {}

/** The config file, from FF_CONFIG or companyfeatures.config.ts in `cwd`: its default export, or {} when there is
 *  none. A file that is named but missing, or doesn't export a config, is an error. */
export async function loadConfig(o: { cwd?: string; env?: NodeJS.ProcessEnv; file?: string } = {}): Promise<{ config: Config; file: string | null }> {
  const cwd = o.cwd ?? process.cwd();
  const env = o.env ?? process.env;
  const named = o.file ?? (env.FF_CONFIG?.trim() || undefined);
  const file = named ? (isAbsolute(named) ? named : resolve(cwd, named)) : resolve(cwd, CONFIG_FILE);
  if (!existsSync(file)) {
    if (named) throw new ConfigError(`no config file at ${file} (FF_CONFIG)`);
    return { config: {}, file: null };
  }
  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new ConfigError(`${file} couldn’t be loaded: ${(e as Error).message}`);
  }
  const config = mod.default;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError(`${file} must export its config as the default: export default defineConfig({ … })`);
  }
  const plugins = (config as Config).plugins;
  if (plugins !== undefined && !Array.isArray(plugins)) throw new ConfigError(`${file}: plugins is a list, e.g. plugins: [ofrep(), flagd()]`);
  return { config: config as Config, file };
}

export type Resolved = {
  databaseUrl: string | undefined;
  dataDir: string;
  port: number;
  host: string;
  signIn: SignIn;
  plugins: Plugin[];
};

/** The settings a server runs with: the config file's, else the environment's, else the defaults. */
export function resolveConfig(config: Config, env: NodeJS.ProcessEnv = process.env): Resolved {
  const port = config.server?.port ?? Number(env.PORT || 8787);          // an empty PORT is the default, not port 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`server.port (or PORT) must be a port number, not ${port}`);
  return {
    databaseUrl: config.database?.url || env.DATABASE_URL || undefined,
    dataDir: config.database?.dataDir || env.FF_DATA_DIR || './data',
    port,
    host: config.server?.host || env.HOST || '0.0.0.0',
    signIn: { kind: 'better-auth', settings: { ...authSettingsFromEnv(env), ...stripUndefined(config.auth ?? {}) } },
    plugins: config.plugins ?? defaultPlugins({ cloudflare: { zoneId: env.CF_ZONE_ID || undefined, token: env.CF_API_TOKEN || undefined } }),
  };
}

/** A setting written as undefined in the file (e.g. process.env.X that isn't set) leaves the environment's in place. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
