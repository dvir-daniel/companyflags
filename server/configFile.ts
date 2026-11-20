// Reads companyflags.config.ts (config.ts has its type) for the server (index.ts) and the CLI (cli.ts): from the
// folder they run in, or the file FF_CONFIG names. Then works out the settings a server runs with: the file's, else
// the environment's, else the defaults.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authSettingsFromEnv } from './betterAuth.ts';
import { ConfigError, type Config } from './config.ts';
import type { SignIn } from './identity.ts';
import type { Plugin } from './plugin.ts';
import { defaultPlugins } from './plugins/index.ts';

export const CONFIG_FILE = 'companyflags.config.ts';

/** The server's own folder (where its package.json is): `companyflags/…` resolves only for a file inside it. */
export const SERVER_FOLDER = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/** The config file, from FF_CONFIG or companyflags.config.ts in `cwd`: its default export, or {} when there is
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
    const err = e as NodeJS.ErrnoException;
    // outside the server's folder, `companyflags/config` names no package: say where the file must be
    if (err.code === 'ERR_MODULE_NOT_FOUND' && /['"]companyflags['"]/.test(err.message ?? '')) {
      throw new ConfigError(`${file} imports companyflags/…, which only resolves inside the server’s folder (${SERVER_FOLDER}): keep the file there (/app in Docker)`);
    }
    throw new ConfigError(`${file} couldn’t be loaded: ${err.message}`);
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

/** The settings a server runs with: the config file's, else the environment's, else the defaults. Whether it runs as
 *  production is NODE_ENV's alone, so a file can't turn off the production checks. */
export function resolveConfig(config: Config, env: NodeJS.ProcessEnv = process.env): Resolved {
  const port = config.server?.port ?? Number(env.PORT || 8787);          // an empty PORT is the default, not port 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`server.port (or PORT) must be a port number, not ${port}`);
  const fromEnv = authSettingsFromEnv(env);
  return {
    databaseUrl: config.database?.url || env.DATABASE_URL || undefined,
    dataDir: config.database?.dataDir || env.FF_DATA_DIR || './data',
    port,
    host: config.server?.host || env.HOST || '0.0.0.0',
    signIn: { kind: 'better-auth', settings: { ...fromEnv, ...stripUndefined(config.auth ?? {}), production: fromEnv.production } },
    plugins: config.plugins ?? defaultPlugins(),
  };
}

/** A setting written as undefined in the file (e.g. process.env.X that isn't set) leaves the environment's in place. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
