// Reads companyflags.config.ts (config.ts has its type) for the server (index.ts) and the CLI (cli.ts): from the
// folder they run in, or the file FF_CONFIG names. Then works out the settings a server runs with: the file's, else
// the environment's, else the defaults.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { authSettingsFromEnv } from './betterAuth.ts';
import { ConfigError, type Config } from './config.ts';
import type { SignIn } from './identity.ts';
import type { Plugin } from './plugin.ts';
import { defaultPlugins } from './plugins/index.ts';
import { PACKAGE_FOLDER } from './packageFolder.ts';
import type { Appearance } from './appearance.ts';

export const CONFIG_FILE = 'companyflags.config.ts';

/** The server's own folder (where its package.json is): the repository, /app in Docker, or node_modules/companyflags. */
export const SERVER_FOLDER = PACKAGE_FOLDER;

/** Whether a config file in `dir` can import `companyflags/config`: inside the server's folder (the package names
 *  itself), or in a folder where the package is installed (npm i companyflags). */
export function canImportConfig(dir: string): boolean {
  try { createRequire(join(dir, CONFIG_FILE)).resolve('companyflags/config'); return true; } catch { return false; }
}

/** What to do when a config file's folder can't import `companyflags/…`. A server installed from npm (npx) has no
 *  folder of its own to offer. */
export const whereConfigGoes = () => /[\\/]node_modules[\\/]/.test(SERVER_FOLDER)
  ? 'install the package beside it (npm i companyflags), then run npx companyflags there'
  : `install the package beside it (npm i companyflags), or keep the file in the server’s folder (${SERVER_FOLDER}; /app in Docker)`;

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
    // where the package isn't installed, `companyflags/config` names no package: say where the file can be
    if (err.code === 'ERR_MODULE_NOT_FOUND' && /['"]companyflags['"]/.test(err.message ?? '')) {
      throw new ConfigError(`${file} imports companyflags/…, which doesn’t resolve from its folder: ${whereConfigGoes()}`);
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
  /** false: only check the schema at the start (database.migrate, FF_MIGRATE=off) */
  migrate: boolean;
  pool: number;
  publishLogDays: number;
  port: number;
  host: string;
  signIn: SignIn;
  plugins: Plugin[];
  /** The config file's appearance, with its images read into data URLs (null: set in the console). */
  appearance: Partial<Appearance> | null;
};

/** The settings a server runs with: the config file's, else the environment's, else the defaults. Whether it runs as
 *  production is NODE_ENV's alone, so a file can't turn off the production checks. */
export function resolveConfig(config: Config, env: NodeJS.ProcessEnv = process.env, dir = process.cwd()): Resolved {
  const port = config.server?.port ?? Number(env.PORT || 8787);          // an empty PORT is the default, not port 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`server.port (or PORT) must be a port number, not ${port}`);
  const fromEnv = authSettingsFromEnv(env);
  const pool = config.database?.pool ?? Number(env.FF_DB_POOL || 10);
  if (!Number.isInteger(pool) || pool < 1 || pool > 1000) throw new ConfigError(`database.pool (or FF_DB_POOL) must be a whole number from 1 to 1000, not ${pool}`);
  const days = config.retention?.publishLogDays ?? Number(env.FF_PUBLISH_LOG_DAYS || 30);
  if (!Number.isInteger(days) || days < 1) throw new ConfigError(`retention.publishLogDays (or FF_PUBLISH_LOG_DAYS) must be a whole number of days, at least 1, not ${days}`);
  const migrateEnv = env.FF_MIGRATE?.trim().toLowerCase();
  if (migrateEnv && !['on', 'off'].includes(migrateEnv)) throw new ConfigError(`FF_MIGRATE is on or off, not ${env.FF_MIGRATE}`);
  return {
    databaseUrl: config.database?.url || env.DATABASE_URL || undefined,
    dataDir: config.database?.dataDir || env.FF_DATA_DIR || './data',
    migrate: config.database?.migrate ?? migrateEnv !== 'off',
    pool,
    publishLogDays: days,
    port,
    host: config.server?.host || env.HOST || '0.0.0.0',
    signIn: { kind: 'better-auth', settings: { ...fromEnv, ...stripUndefined(config.auth ?? {}), production: fromEnv.production } },
    plugins: config.plugins ?? defaultPlugins(),
    appearance: config.appearance ? withImages(config.appearance, dir) : null,
  };
}

const IMAGE_FILE: Record<string, string> = {
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
};
/** The config file's images: a data URL as it is, or a file beside the config file read into one. */
function withImages(a: Partial<Appearance>, dir: string): Partial<Appearance> {
  const read = (v: string | null | undefined, what: string) => {
    if (!v || v.startsWith('data:')) return v;
    const type = IMAGE_FILE[extname(v).toLowerCase()];
    if (!type) throw new ConfigError(`appearance.${what}: ${v} isn’t an image file (.png, .svg, .webp, .jpg, .gif or .ico)`);
    const path = isAbsolute(v) ? v : resolve(dir, v);
    if (!existsSync(path)) throw new ConfigError(`appearance.${what}: no file ${path}`);
    return `data:${type};base64,${readFileSync(path).toString('base64')}`;
  };
  return { ...a, logo: read(a.logo, 'logo'), logoDark: read(a.logoDark, 'logoDark'), icon: read(a.icon, 'icon') };
}
/** The folder a config file's relative paths start from. */
export const configDir = (file: string | null, cwd = process.cwd()) => (file ? dirname(file) : cwd);

/** A setting written as undefined in the file (e.g. process.env.X that isn't set) leaves the environment's in place. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
