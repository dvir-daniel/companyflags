#!/usr/bin/env node
// The companyflags command, like Better Auth's CLI: it reads companyflags.config.ts (configFile.ts) and works on the
// database the server uses. With embedded Postgres (no DATABASE_URL) the server must be stopped first: its files can
// be open in one process at a time.
//
//   companyflags start                 run the server
//   companyflags init                  write companyflags.config.ts
//   companyflags secret                print a secret for BETTER_AUTH_SECRET
//   companyflags migrate [--check]     apply the database migrations (or list what's pending)
//   companyflags flags pull [file]     write the flags to a file (flags.json)
//   companyflags flags plan [file]     what a push would change
//   companyflags flags push [file]     make CompanyFlags match the file

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb, FolderInUseError, type Db } from './db.ts';
import { migrate, MigrationError, pendingMigrations, readMigrations } from './migrate.ts';
import { ConfigError } from './config.ts';
import { CONFIG_FILE, loadConfig, resolveConfig, SERVER_FOLDER } from './configFile.ts';
import { journaled } from './journal.ts';
import { describe, planFlags, pullFlags, pushFlags, type Done, type Plan } from './flagsAsCode.ts';

const HELP = `companyflags: the feature flag server, its database and your flags as code

Usage:
  companyflags start                 Run the server (the console, the API and the plugins)
  companyflags init                  Write ${CONFIG_FILE} in this folder
  companyflags secret                Print a random secret for BETTER_AUTH_SECRET
  companyflags migrate [--check]     Apply the database's migrations; --check only lists them (exit 1 if any)
  companyflags flags pull [file]     Write every flag to a file (default flags.json)
  companyflags flags plan [file]     Show what a push would change
  companyflags flags push [file]     Make CompanyFlags match the file [--as <name>]

It reads ${CONFIG_FILE} from this folder (or FF_CONFIG), then the environment (DATABASE_URL, FF_DATA_DIR, …).
With embedded Postgres (no DATABASE_URL), stop the server first: one process at a time can open its files.
Docs: https://dvir-daniel.github.io/companyflags/reference/cli`;

const CONFIG_TEMPLATE = `// How this CompanyFlags server runs. Every setting is optional: what isn't set here comes from the environment
// variables (DATABASE_URL, BETTER_AUTH_SECRET, …), then the defaults.
// Docs: https://dvir-daniel.github.io/companyflags/self-hosting/configuration
import { defineConfig } from 'companyflags/config';
import { appFiles, cloudflare, flagd, ofrep, webhooks } from 'companyflags/plugins';

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
    webhooks(),                                // webhooks out (Slack, CI, another system) and in (Migration page)
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
  // Each command takes out the options and arguments it knows; anything left is a mistake, never ignored.
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('-')) throw new UsageError(`${name} needs a value, e.g. ${name} <name>`);
    rest.splice(i, 2);
    return v;
  };
  const has = (name: string) => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };
  const nothingElse = (what: string) => {
    if (rest.length) throw new UsageError(`${what}: unknown ${rest[0].startsWith('-') ? 'option' : 'argument'} "${rest[0]}" (see companyflags help)`);
  };
  try {
    switch (command) {
      case undefined: case 'help': case '--help': case '-h':
        out(HELP);
        return 0;
      case 'start': {
        nothingElse('start');
        const { start } = await import('./index.ts');
        await start({ cwd, env });
        return -1;                                    // keeps running
      }
      case 'init': {
        const force = has('--force');
        nothingElse('init');
        const file = resolve(cwd, CONFIG_FILE);
        if (existsSync(file) && !force) throw new UsageError(`${CONFIG_FILE} is already here (--force writes over it)`);
        writeFileSync(file, CONFIG_TEMPLATE);
        out(`wrote ${file}`);
        // its imports (companyflags/config, /plugins) only resolve inside the server's folder
        if (!inside(SERVER_FOLDER, cwd)) err(`warning: this folder isn’t inside the server’s folder (${SERVER_FOLDER}), so the server can’t load this file: move it there (/app in Docker)`);
        out('next: set BETTER_AUTH_SECRET (companyflags secret makes one), then companyflags start');
        return 0;
      }
      case 'secret':
        nothingElse('secret');
        out(randomBytes(32).toString('base64url'));
        return 0;
      case 'migrate': {
        const check = has('--check');
        nothingElse('migrate');
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
        if (sub !== 'pull' && sub !== 'plan' && sub !== 'push') throw new UsageError('flags: pull, plan or push');
        const as = flag('--as') ?? env.USER ?? 'cli';
        const file = resolve(cwd, rest.shift() ?? 'flags.json');
        nothingElse(`flags ${sub}`);
        if (sub === 'pull') {
          return await withDb(cwd, env, true, async (db) => {
            const f = await pullFlags(db);
            writeFileSync(file, `${JSON.stringify(f, null, 2)}\n`);
            out(`wrote ${Object.keys(f.flags).length} flags to ${file}`);
            return 0;
          });
        }
        if (!existsSync(file)) throw new UsageError(`no ${file}: companyflags flags pull writes one`);
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
        throw new UsageError(`unknown command "${command}": see companyflags help`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError || e instanceof FolderInUseError || e instanceof MigrationError) {
      err(`companyflags: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** Whether a folder is the server's folder or inside it (through links too). */
function inside(root: string, dir: string) {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const r = relative(real(root), real(dir));
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
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
      if (pending.length) throw new UsageError(`the database is missing migrations (${pending.join(', ')}): run companyflags migrate first`);
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
  if (plan.onlyHere.length) out(`? only in CompanyFlags, left as they are: ${plan.onlyHere.join(', ')}`);
  if (!plan.steps.length && !plan.problems.length) out('nothing to change');
}

function printDone(done: Done[], out: Print) {
  for (const d of done) out(d.result === 'request' ? `→ request #${d.request}: ${describe(d.step)}` : `✓ ${describe(d.step)}`);
}

// run as a command (node server/cli.ts, or the companyflags bin, which may be a link to this file)
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exit(code);
}
