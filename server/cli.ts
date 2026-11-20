#!/usr/bin/env node
// The companyfeatures command, like Better Auth's CLI: it reads companyfeatures.config.ts (config.ts) and works on the
// database the server uses. With embedded Postgres (no DATABASE_URL) the server must be stopped first: its files can
// be open in one process at a time.
//
//   companyfeatures start                 run the server
//   companyfeatures init                  write companyfeatures.config.ts
//   companyfeatures secret                print a secret for BETTER_AUTH_SECRET
//   companyfeatures migrate [--check]     apply the database migrations (or list what's pending)
//   companyfeatures flags pull [file]     write the flags to a file (flags.json)
//   companyfeatures flags plan [file]     what a push would change
//   companyfeatures flags push [file]     make CompanyFeatures match the file

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb, FolderInUseError, type Db } from './db.ts';
import { migrate, MigrationError, pendingMigrations, readMigrations } from './migrate.ts';
import { CONFIG_FILE, ConfigError, loadConfig, resolveConfig } from './config.ts';
import { journaled } from './journal.ts';
import { describe, planFlags, pullFlags, pushFlags, type Done, type Plan } from './flagsAsCode.ts';

const HELP = `companyfeatures: the feature flag server, its database and your flags as code

Usage:
  companyfeatures start                 Run the server (the console, the API and the plugins)
  companyfeatures init                  Write ${CONFIG_FILE} in this folder
  companyfeatures secret                Print a random secret for BETTER_AUTH_SECRET
  companyfeatures migrate [--check]     Apply the database's migrations; --check only lists them (exit 1 if any)
  companyfeatures flags pull [file]     Write every flag to a file (default flags.json)
  companyfeatures flags plan [file]     Show what a push would change
  companyfeatures flags push [file]     Make CompanyFeatures match the file [--as <name>]

It reads ${CONFIG_FILE} from this folder (or FF_CONFIG), then the environment (DATABASE_URL, FF_DATA_DIR, …).
With embedded Postgres (no DATABASE_URL), stop the server first: one process at a time can open its files.
Docs: https://dvir-daniel.github.io/companyfeatures/reference/cli`;

const CONFIG_TEMPLATE = `// How this CompanyFeatures server runs. Every setting is optional: what isn't set here comes from the environment
// variables (DATABASE_URL, BETTER_AUTH_SECRET, …), then the defaults.
// Docs: https://dvir-daniel.github.io/companyfeatures/self-hosting/configuration
import { defineConfig } from 'companyfeatures/config';
import { appFiles, cloudflare, flagd, ofrep } from 'companyfeatures/plugins';

export default defineConfig({
  database: {
    url: process.env.DATABASE_URL,            // Postgres; without it, embedded Postgres in dataDir
    // dataDir: './data',
  },
  auth: {
    // baseURL: 'https://flags.example.com',   // where the console is (BETTER_AUTH_URL)
  },
  plugins: [
    ofrep(),                                   // OpenFeature's OFREP providers, for apps and backends
    flagd(),                                   // flagd JSON, for backends that evaluate in-process
    appFiles(),                                // values-only files per entity, behind a CDN
    cloudflare(),                              // purge Cloudflare's cache after each publish (CF_ZONE_ID, CF_API_TOKEN)
  ],
});
`;

class UsageError extends Error {}
type Print = (line: string) => void;

/** Runs one command; its exit code, or -1 for start (the server keeps running). `out` and `err` print a line (tests
 *  pass their own). */
export async function main(argv: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; out?: Print; err?: Print } = {}): Promise<number> {
  const cwd = o.cwd ?? process.cwd();
  const env = o.env ?? process.env;
  const out: Print = o.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err: Print = o.err ?? ((line) => process.stderr.write(`${line}\n`));
  const [command, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(name); if (i < 0) return undefined; const v = rest[i + 1]; rest.splice(i, 2); return v; };
  const has = (name: string) => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };
  try {
    switch (command) {
      case undefined: case 'help': case '--help': case '-h':
        out(HELP);
        return 0;
      case 'start': {
        const { start } = await import('./index.ts');
        await start({ cwd, env });
        return -1;                                    // keeps running
      }
      case 'init': {
        const file = resolve(cwd, CONFIG_FILE);
        if (existsSync(file) && !has('--force')) throw new UsageError(`${CONFIG_FILE} is already here (--force writes over it)`);
        writeFileSync(file, CONFIG_TEMPLATE);
        out(`wrote ${file}`);
        out('next: set BETTER_AUTH_SECRET (companyfeatures secret makes one), then companyfeatures start');
        return 0;
      }
      case 'secret':
        out(randomBytes(32).toString('base64url'));
        return 0;
      case 'migrate': {
        const check = has('--check');
        return await withDb(cwd, env, false, async (db) => {
          if (check) {
            const pending = await pendingMigrations(db);
            out(pending.length ? `pending: ${pending.join(', ')}` : 'the database is up to date');
            return pending.length ? 1 : 0;
          }
          const { applied } = await migrate(db);
          out(applied.length ? `applied: ${applied.join(', ')}` : 'the database is up to date');
          return 0;
        });
      }
      case 'flags': {
        const sub = rest.shift();
        const as = flag('--as') ?? env.USER ?? 'cli';
        const file = resolve(cwd, rest.shift() ?? 'flags.json');
        if (sub === 'pull') {
          return await withDb(cwd, env, true, async (db) => {
            const f = await pullFlags(db);
            writeFileSync(file, `${JSON.stringify(f, null, 2)}\n`);
            out(`wrote ${Object.keys(f.flags).length} flags to ${file}`);
            return 0;
          });
        }
        if (sub !== 'plan' && sub !== 'push') throw new UsageError('flags: pull, plan or push');
        if (!existsSync(file)) throw new UsageError(`no ${file}: companyfeatures flags pull writes one`);
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`${file} isn’t valid JSON: ${(e as Error).message}`); }
        return await withDb(cwd, env, true, async (db) => {
          const plan = await planFlags(db, parsed);
          printPlan(plan, out);
          if (plan.problems.length) return 1;
          if (sub === 'plan' || !plan.steps.length) return 0;
          try {
            const done = await pushFlags(db, plan, { name: as, type: 'system' });
            printDone(done, out);
            return 0;
          } catch (e) {
            printDone((e as Error & { done?: Done[] }).done ?? [], out);
            err(`stopped: ${(e as Error).message}`);
            return 1;
          }
        });
      }
      default:
        throw new UsageError(`unknown command "${command}": see companyfeatures help`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError || e instanceof FolderInUseError || e instanceof MigrationError) {
      err(`companyfeatures: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** The configured database, opened for one command. `current`: it must have every migration (flags need today's
 *  schema; migrate is the command that changes it). */
async function withDb(cwd: string, env: NodeJS.ProcessEnv, current: boolean, run: (db: Db) => Promise<number>): Promise<number> {
  const { config } = await loadConfig({ cwd, env });
  const r = resolveConfig(config, env);
  const store = await connectDb({ url: r.databaseUrl, dataDir: r.databaseUrl ? undefined : resolve(cwd, r.dataDir) });
  try {
    if (current) {
      const pending = await pendingMigrations(store);
      if (pending.length) throw new UsageError(`the database is missing migrations (${pending.join(', ')}): run companyfeatures migrate first`);
      const known = new Set(readMigrations().map((m) => m.name));
      const newer = (await store.query<{ name: string }>(`select name from schema_migration`)).rows.map((r) => r.name).filter((n) => !known.has(n));
      if (newer.length) throw new UsageError(`the database has migrations this version doesn’t know (${newer.join(', ')}): use the CLI of the version the server runs`);
    }
    // Changes go through the change journal as the console's do. The running server publishes them: its worker reads
    // the publish queue every second, whichever process wrote to it. Nothing to tell in this process.
    const nothing = () => {};
    const db = journaled(store, { forgetClientLinks: nothing, forgetClientApps: nothing, forgetApiKeys: nothing, refresh: async () => {}, wake: nothing });
    return await run(db);
  } finally {
    await store.close();
  }
}

function printPlan(plan: Plan, out: Print) {
  for (const p of plan.problems) out(`! ${p}`);
  for (const s of plan.steps) out(`${s.do === 'create' ? '+' : '~'} ${describe(s)}`);
  if (plan.unchanged.length) out(`= ${plan.unchanged.length} unchanged`);
  if (plan.onlyHere.length) out(`? only in CompanyFeatures, left as they are: ${plan.onlyHere.join(', ')}`);
  if (!plan.steps.length && !plan.problems.length) out('nothing to change');
}

function printDone(done: Done[], out: Print) {
  for (const d of done) out(d.result === 'request' ? `→ request #${d.request}: ${describe(d.step)}` : `✓ ${describe(d.step)}`);
}

// run as a command (node server/cli.ts, or the companyfeatures bin, which may be a link to this file)
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exit(code);
}
