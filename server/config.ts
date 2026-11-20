// companyflags.config.ts: one typed file for how a server runs, the way Better Auth has its auth.ts. Every
// setting is optional. What the file doesn't set comes from the environment variables (docs/self-hosting/
// configuration.md), then the defaults, so a server with no file runs as before and the Docker image needs none.
//
//   import { defineConfig } from 'companyflags/config';
//   import { appFiles, cloudflare, flagd, mcp, ofrep, webhooks } from 'companyflags/plugins';
//
//   export default defineConfig({
//     database: { url: process.env.DATABASE_URL },
//     auth: { baseURL: 'https://flags.example.com' },
//     plugins: [ofrep(), flagd(), appFiles(), cloudflare(), webhooks(), mcp()],
//   });
//
// This module is what `companyflags/config` gives a config file: its type and defineConfig. The server (index.ts) and
// the CLI (cli.ts) read the file with configFile.ts, from the folder they run in, or from FF_CONFIG.

import type { AuthSettings } from './betterAuth.ts';
import type { Plugin } from './plugin.ts';
import type { Appearance } from './appearance.ts';

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
   *  AuthSettings). Each setting left out comes from its environment variable (BETTER_AUTH_SECRET, …). Whether the
   *  server runs as production comes from NODE_ENV only. */
  auth?: Partial<Omit<AuthSettings, 'production'>>;
  /** What reads flags besides the console, and what runs after a publish (plugins/). Left out: all the built-in ones. */
  plugins?: Plugin[];
  /** How the console looks: its name, logo, accent color and the rest (Settings → Appearance). Set here, it can't be
   *  changed in the console. Images are a file next to the config file ('./logo.svg') or a data URL. */
  appearance?: Partial<Appearance>;
};

/** Types a config file's default export. */
export const defineConfig = (config: Config): Config => config;

export class ConfigError extends Error {}
