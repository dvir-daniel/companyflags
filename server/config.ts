// companyflags.config.ts: one typed file for how a server runs, the way Better Auth has its auth.ts. Every
// setting is optional. What the file doesn't set comes from the environment variables (docs/self-hosting/
// configuration.md), then the defaults, so a server with no file runs as before and the Docker image needs none.
//
//   import { defineConfig } from 'companyflags/config';
//   import { cdnFiles, cloudflare, flagd, mcp, ofrep, webhooks } from 'companyflags/plugins';
//
//   export default defineConfig({
//     database: { url: process.env.DATABASE_URL },
//     auth: { baseURL: 'https://flags.example.com' },
//     plugins: [ofrep(), flagd(), cdnFiles(), cloudflare(), webhooks(), mcp()],
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
    /** Whether the server applies the migrations when it starts (default true). false (FF_MIGRATE=off, or
     *  `companyflags start --no-migrate`): it only checks that the schema has them, and `companyflags migrate` applies
     *  them, e.g. with a database role that may change the schema, before a rolling upgrade. */
    migrate?: boolean;
    /** At most this many connections to the Postgres server (FF_DB_POOL; default 10). */
    pool?: number;
    /** A PEM file with the certificate authorities the Postgres server's certificate is checked against
     *  (FF_DATABASE_CA_FILE), e.g. Amazon RDS's global bundle. The certificate is always checked with it. A relative
     *  path starts from the config file's folder. */
    caFile?: string;
  };
  /** How long the server keeps what it no longer needs. History is kept forever: it's the record of every change. */
  retention?: {
    /** Days the publish log is kept: each publish and its CDN purge (Settings → CDN shows the newest). Default 30
     *  (FF_PUBLISH_LOG_DAYS); each environment's newest publish is always kept. */
    publishLogDays?: number;
  };
  server?: {
    /** PORT (default 8787) and HOST (default 0.0.0.0). */
    port?: number;
    host?: string;
    /** Seconds an idle connection is kept open (FF_KEEPALIVE_SECONDS; default 65): more than the load balancer in
     *  front keeps one (60 on AWS's and Google's), or it gets a 502 now and then. */
    keepAliveSeconds?: number;
  };
  /** Sign-in with Better Auth: the secret, the console's address, the providers and the rest (betterAuth.ts
   *  AuthSettings). Each setting left out comes from its environment variable (BETTER_AUTH_SECRET, …). Whether the
   *  server runs as production comes from NODE_ENV only. */
  auth?: Partial<Omit<AuthSettings, 'production'>>;
  /** What reads flags besides the console, and what runs after a publish (plugins/). Left out: the default ones
   *  (defaultPlugins() in plugins/index.ts); cloudfront(), cloudCdn() and metrics() run only when listed here. */
  plugins?: Plugin[];
  /** How the console looks: its name, logo, accent color and the rest (Settings → Appearance). Set here, it can't be
   *  changed in the console. Images are a file next to the config file ('./logo.svg') or a data URL. */
  appearance?: Partial<Appearance>;
};

/** Types a config file's default export. */
export const defineConfig = (config: Config): Config => config;

export class ConfigError extends Error {}
