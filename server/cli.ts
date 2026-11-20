#!/usr/bin/env node
// The companyflags command, like Better Auth's CLI: it reads companyflags.config.ts (configFile.ts) and works on the
// database the server uses. With embedded Postgres (no DATABASE_URL) the server must be stopped first: its files can
// be open in one process at a time.
//
//   companyflags start [--no-migrate]  run the server (--no-migrate: only check the schema has every migration)
//   companyflags version               print the version
//   companyflags init                  write companyflags.config.ts
//   companyflags secret                print a secret for BETTER_AUTH_SECRET
//   companyflags migrate [--check]     apply the database migrations (or list what's pending)
//   companyflags backup [path]         pg_dump of a Postgres server, or a copy of the embedded database's folder
//   companyflags copy-to-postgres <url> copy the embedded database into a new, empty Postgres database
//   companyflags flags pull [file]     write the flags to a file (flags.json)
//   companyflags flags plan [file]     what a push would change (--json, --exit-code)
//   companyflags flags push [file]     make CompanyFlags match the file (--reason, --link, --json, --exit-code)
//   companyflags flags unused [file]   flags no code mentions, and keys the code reads that aren't flags
//   companyflags flags export --flagd  one service's flags as flagd JSON, written to a file (offline)
// The flags commands go through a server's API instead with --url and --token (COMPANYFLAGS_URL, COMPANYFLAGS_TOKEN).
// In CI (CI set), they never open an embedded database: a missing secret fails the job instead.
//   companyflags mcp --url … --token … MCP over stdio, for AI clients that start local servers (plugins/mcp.ts)

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectDb, FolderInUseError, FolderVersionError, type Db } from './db.ts';
import { BackupError, backupName, copyDataDir, copyDatabase, dumpPostgres, isEmpty, sizeOf } from './backup.ts';
import { VERSION } from './packageFolder.ts';
import { migrate, MigrationError, pendingMigrations, readMigrations } from './migrate.ts';
import { ConfigError } from './config.ts';
import { canImportConfig, CONFIG_FILE, loadConfig, resolveConfig, whereConfigGoes } from './configFile.ts';
import { journaled } from './journal.ts';
import {
  DEFINITION, describe, hasChanges, narrowFile, noteProblem, planFlags, pullFlags, pushFlags, type Done, type FlagsFile, type Plan,
} from './flagsAsCode.ts';
import { codeReferences } from './codeReferences.ts';
import { buildFlagdDoc, type FlagdDoc } from './flagd.ts';
import { buildSnapshot } from './snapshot.ts';
import { all } from './db.ts';

const HELP = `companyflags: the feature flag server, its database and your flags as code

Usage:
  companyflags start                 Run the server (the console, the API and the plugins)
                                     [--no-migrate]: don't apply migrations, only check they are applied
  companyflags version               Print the version (also --version)
  companyflags init                  Write ${CONFIG_FILE} in this folder
  companyflags secret                Print a random secret for BETTER_AUTH_SECRET
  companyflags migrate [--check]     Apply the database's migrations; --check only lists them (exit 1 if any)
  companyflags backup [path]         Back up the database: pg_dump of a Postgres server (a .dump file), or a
                                     copy of the embedded database's folder (stop the server first)
  companyflags copy-to-postgres <url>
                                     Copy the embedded database into a new, empty Postgres database, to move
                                     to a Postgres server (stop the server first)
  companyflags flags pull [file]     Write the flags to a file (default flags.json); an existing file keeps its
                                     source, owns and scope
  companyflags flags plan [file]     Show what a push would change [--json] [--exit-code: 2 when there are changes]
  companyflags flags push [file]     Make CompanyFlags match the file [--as <name>] [--reason <text>] [--link <url>]
                                     [--json] [--exit-code: 2 when a change waits for approval]
  companyflags flags unused [file]   List flags no code mentions, and keys the code reads that aren't flags
                                     [--src <dir>] (default: this folder); --strict exits 1 if there are any
  companyflags flags export --flagd --env <environment> --service <service> [--entity <entity>] [file]
                                     Write that service's flags as flagd JSON (default flagd.json), from the database
  companyflags mcp --url <server> --token <cfp_…>
                                     MCP over stdio for AI clients: each line goes to the server's /mcp
                                     (or COMPANYFLAGS_URL and COMPANYFLAGS_TOKEN)

The flags commands take --url <server> and --token <cfp_…> (or COMPANYFLAGS_URL and COMPANYFLAGS_TOKEN) to go
through a server's API with an access token. History then shows the token's person (or agent), not --as.
Without a URL, they read ${CONFIG_FILE} from this folder (or FF_CONFIG), then the environment (DATABASE_URL,
FF_DATA_DIR, …), and open the database. With embedded Postgres (no DATABASE_URL), stop the server first: one
process at a time can open its files. In CI (CI set) they need a server or DATABASE_URL (or FF_DATA_DIR said
outright): an empty secret fails the job.
Docs: https://dvir-daniel.github.io/companyflags/reference/cli`;

const CONFIG_TEMPLATE = `// How this CompanyFlags server runs. Every setting is optional: what isn't set here comes from the environment
// variables (DATABASE_URL, BETTER_AUTH_SECRET, …), then the defaults.
// Docs: https://dvir-daniel.github.io/companyflags/self-hosting/configuration
import { defineConfig } from 'companyflags/config';
import { cdnFiles, cloudflare, flagd, mcp, ofrep, webhooks } from 'companyflags/plugins';

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
    cdnFiles(),                                // CDN files (flagd JSON) per entity, behind a CDN
    cloudflare(),                              // purge Cloudflare's cache after each publish (CF_ZONE_ID, CF_API_TOKEN)
    webhooks(),                                // webhooks out (Slack, CI, another system) and in (Migration page)
    mcp(),                                     // MCP at /mcp, for AI agents with an access token
  ],
});
`;

class UsageError extends Error {}
/** The server (--url) refused or couldn't be reached: one line, exit 1. */
class ServerError extends Error {}
type Print = (line: string) => void;

/** Runs one command; its exit code, or -1 for start (the server keeps running). `out` and `err` print a line (tests
 *  pass their own). */
export async function main(argv: string[], o: {
  cwd?: string; env?: NodeJS.ProcessEnv; out?: Print; err?: Print;
  /** mcp: where the messages come from, and how the server is reached (tests pass their own) */
  stdin?: NodeJS.ReadableStream; fetch?: typeof fetch;
} = {}): Promise<number> {
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
      case 'version': case '--version': case '-v':
        nothingElse('version');
        out(`companyflags ${VERSION}`);
        return 0;
      case 'start': {
        const noMigrate = has('--no-migrate');
        nothingElse('start');
        const { start } = await import('./index.ts');
        await start({ cwd, env, migrate: !noMigrate });
        return -1;                                    // keeps running
      }
      case 'backup': {
        const dest = rest.shift();
        nothingElse('backup');
        const { config } = await loadConfig({ cwd, env });
        const r = resolveConfig(config, env);
        if (r.databaseUrl) {
          const file = resolve(cwd, dest ?? `${backupName()}.dump`);
          if (existsSync(file)) throw new UsageError(`${file} is there already: name a new file`);
          dumpPostgres(r.databaseUrl, file);
          out(`backed up the Postgres database to ${file} (${sizeOf(file)}): pg_restore --no-owner -d <database> ${file} puts it back`);
          return 0;
        }
        const dataDir = resolve(cwd, r.dataDir);
        const folder = resolve(cwd, dest ?? backupName());
        copyDataDir(dataDir, folder);
        out(`backed up the embedded database to ${folder} (${sizeOf(folder)}): copy it to ${dataDir} (with the server stopped) to put it back`);
        return 0;
      }
      case 'copy-to-postgres': {
        const url = rest.shift();
        nothingElse('copy-to-postgres');
        if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new UsageError('copy-to-postgres <postgres://…>: the new, empty Postgres database to copy into');
        const { config } = await loadConfig({ cwd, env });
        const r = resolveConfig(config, env);
        if (r.databaseUrl) throw new UsageError('this server uses a Postgres server already (DATABASE_URL): copy-to-postgres moves off the embedded database');
        const dataDir = resolve(cwd, r.dataDir);
        if (!existsSync(dataDir)) throw new UsageError(`no embedded database at ${dataDir} (FF_DATA_DIR)`);
        const source = await connectDb({ dataDir });
        try {
          const pending = await pendingMigrations(source);
          if (pending.length) throw new UsageError(`the embedded database is missing migrations (${pending.join(', ')}): run companyflags migrate first`);
          const target = await connectDb({ url });
          try {
            if (!(await isEmpty(target))) throw new UsageError('that Postgres database has tables already: copy into a new, empty one');
            await migrate(target);
            const copied = await copyDatabase(source, target, { log: (m) => out(`  ${m}`) });
            const rows = Object.values(copied).reduce((a, b) => a + b, 0);
            out(`copied ${rows} rows into Postgres. Next: set DATABASE_URL to it (or database.url in ${CONFIG_FILE}) and start the server.`);
            out(`Keep ${dataDir} until you have checked the new one: nothing in it changed.`);
          } finally {
            await target.close();
          }
        } finally {
          await source.close();
        }
        return 0;
      }
      case 'init': {
        const force = has('--force');
        nothingElse('init');
        const file = resolve(cwd, CONFIG_FILE);
        if (existsSync(file) && !force) throw new UsageError(`${CONFIG_FILE} is already here (--force writes over it)`);
        writeFileSync(file, CONFIG_TEMPLATE);
        out(`wrote ${file}`);
        // its imports (companyflags/config, /plugins) resolve inside the server's folder, or where the package is installed
        if (!canImportConfig(cwd)) err(`warning: this folder can’t import companyflags/config, so the server can’t load this file: ${whereConfigGoes()}`);
        // a folder made by npm i: Node reads the file as a module either way, but warns unless package.json says so
        const pkg = resolve(cwd, 'package.json');
        if (existsSync(pkg) && !/"type"\s*:\s*"module"/.test(readFileSync(pkg, 'utf8'))) out('tip: add "type": "module" to package.json, so Node loads the file without a warning');
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
        if (sub !== 'pull' && sub !== 'plan' && sub !== 'push' && sub !== 'unused' && sub !== 'export') throw new UsageError('flags: pull, plan, push, unused or export');
        const server = remote(flag('--url') ?? env.COMPANYFLAGS_URL, flag('--token') ?? env.COMPANYFLAGS_TOKEN);
        if (sub === 'unused') {
          const src = resolve(cwd, flag('--src') ?? '.');
          const strict = has('--strict');
          const file = resolve(cwd, rest.shift() ?? 'flags.json');
          nothingElse('flags unused');
          if (!existsSync(src)) throw new UsageError(`no folder ${src} (--src)`);
          // with a server: its flags, in the scope of the flags file here, if there is one
          const local = server && !existsSync(file) ? null : readFlagsFile(file) as FlagsFile;
          const keys = Object.keys((server ? narrowFile(await server.call('GET', ''), { scope: local?.scope }) : local!).flags ?? {});
          const found = codeReferences(keys, src, { skip: [file] });
          if (found.unused.length) out(`? unused: ${found.unused.join(', ')}`);
          for (const u of found.unknown) out(`! unknown: ${u.key} (${relative(cwd, u.file) || u.file}:${u.line})`);
          if (!found.unused.length && !found.unknown.length) out(`nothing to report: the code mentions all ${keys.length} flags and reads no others`);
          return strict && (found.unused.length || found.unknown.length) ? 1 : 0;
        }
        if (sub === 'export') {
          const flagd = has('--flagd');
          const environment = flag('--env');
          const service = flag('--service');
          const entity = flag('--entity');
          const file = resolve(cwd, rest.shift() ?? 'flagd.json');
          nothingElse('flags export');
          if (!flagd) throw new UsageError('flags export: --flagd (the one format it writes: flagd JSON)');
          if (server) throw new UsageError('flags export reads the database, offline: run it without --url (a backend downloads the same JSON from /sdk/v1/flagd with its key)');
          if (!environment || !service) throw new UsageError('flags export --flagd needs --env <environment> and --service <service>');
          return await withDb(cwd, env, true, async (db) => {
            const doc = await exportFlagd(db, environment, service, entity ?? null);
            writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
            out(`wrote ${Object.keys(doc.flags).length} flags of ${service} in ${environment}${entity ? ` for ${entity}` : ''} to ${file}`);
            return 0;
          }, { flags: true });
        }
        const asName = flag('--as');
        const json = has('--json');
        const exitCode = has('--exit-code');
        const note = sub === 'push' ? { reason: flag('--reason') ?? null, link: flag('--link') ?? ciLink(env) } : {};
        const file = resolve(cwd, rest.shift() ?? 'flags.json');
        nothingElse(`flags ${sub}`);
        if (server && asName) throw new UsageError('--as is for the database: over HTTP, History shows the token’s person');
        const problem = noteProblem(note);
        if (problem) throw new UsageError(`flags push: ${problem}`);
        const as = asName ?? env.USER ?? 'cli';
        if (sub === 'pull') {
          // an existing file keeps its name, the fields it owns and its scope
          const was = existsSync(file) ? readFlagsFile(file) as FlagsFile : null;
          const write = (all: FlagsFile) => {
            const f = narrowFile(all, { source: was?.source, owns: was ? was.owns ?? [...DEFINITION] : undefined, scope: was?.scope });
            writeFileSync(file, `${JSON.stringify(f, null, 2)}\n`);
            out(`wrote ${Object.keys(f.flags).length} flags to ${file}`);
            return 0;
          };
          if (server) return write(await server.call('GET', ''));
          return await withDb(cwd, env, true, async (db) => write(await pullFlags(db)), { flags: true });
        }
        const parsed = readFlagsFile(file);
        // plan: 1 with problems, and with --exit-code 2 when there are changes; push: with --exit-code, 2 when a change waits
        const planned = (plan: Plan) => {
          if (json) out(JSON.stringify(plan, null, 2)); else printPlan(plan, out);
          return plan.problems.length ? 1 : exitCode && hasChanges(plan) ? 2 : 0;
        };
        const pushed = (plan: Plan, done: Done[]) => {
          if (json) out(JSON.stringify({ plan, done }, null, 2)); else { printPlan(plan, out); printDone(done, out); }
          return exitCode && done.some((d) => d.result === 'request') ? 2 : 0;
        };
        if (server) {
          if (sub === 'plan') return planned(await server.call('POST', '/plan', parsed));
          const r: { plan: Plan; done: Done[] } = await server.call('POST', '/push', { file: parsed, ...note }, (status, body) => {
            // a file with problems (nothing pushed), or a step refused (with what was done before it)
            const b = body as { error?: string; plan?: Plan; done?: Done[] } | null;
            if (!b?.plan) return false;
            if (json) out(JSON.stringify(b, null, 2));
            else { printPlan(b.plan, out); if (b.done) printDone(b.done, out); }
            if (b.done) err(`stopped: ${b.error ?? `the server answered ${status}`}`);
            return true;
          });
          return r ? pushed(r.plan, r.done) : 1;
        }
        return await withDb(cwd, env, true, async (db) => {
          const plan = await planFlags(db, parsed);
          if (sub === 'plan' || plan.problems.length) return planned(plan);
          try {
            return pushed(plan, await pushFlags(db, plan, { name: as, type: 'system' }, note));
          } catch (e) {
            const done = (e as Error & { done?: Done[] }).done ?? [];
            if (json) out(JSON.stringify({ error: (e as Error).message, plan, done }, null, 2)); else { printPlan(plan, out); printDone(done, out); }
            err(`stopped: ${(e as Error).message}`);
            return 1;
          }
        }, { flags: true });
      }
      case 'mcp': {
        const url = flag('--url') ?? env.COMPANYFLAGS_URL;
        const token = flag('--token') ?? env.COMPANYFLAGS_TOKEN;
        nothingElse('mcp');
        if (!url || !/^https?:\/\//.test(url)) throw new UsageError('mcp: --url <server> (or COMPANYFLAGS_URL), e.g. --url https://flags.example.com');
        if (!token?.startsWith('cfp_')) throw new UsageError('mcp: --token <cfp_…> (or COMPANYFLAGS_TOKEN): an access token made in the console');
        return await mcpOverStdio({ endpoint: `${url.replace(/\/+$/, '')}/mcp`, token, stdin: o.stdin ?? process.stdin, fetch: o.fetch ?? fetch, out, err });
      }
      default:
        throw new UsageError(`unknown command "${command}": see companyflags help`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ServerError || e instanceof ConfigError || e instanceof FolderInUseError || e instanceof FolderVersionError
      || e instanceof MigrationError || e instanceof BackupError) {
      err(`companyflags: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** The flags file, read and parsed. */
function readFlagsFile(file: string): { flags?: Record<string, unknown> } {
  if (!existsSync(file)) throw new UsageError(`no ${file}: companyflags flags pull writes one`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`${file} isn’t valid JSON: ${(e as Error).message}`); }
}

/** A server's flags as code (api.ts /api/flags-as-code), with an access token; undefined without a URL (the database
 *  mode). `call` answers the JSON of a 2xx; any other answer is one line (a ServerError), unless `refused` handles it
 *  (then `call` answers undefined). */
function remote(url: string | undefined, token: string | undefined) {
  // an empty value is a secret that isn't set (a fork's pull request, a misspelled name): never the database instead
  if (url !== undefined && !url.trim()) throw new UsageError('--url (or COMPANYFLAGS_URL) is empty: is the secret set for this job?');
  if (token !== undefined && !token.trim()) throw new UsageError('--token (or COMPANYFLAGS_TOKEN) is empty: is the secret set for this job?');
  if (!url) {
    if (token) throw new UsageError('--token goes with --url (or COMPANYFLAGS_URL): without one, the flags commands open the database');
    return undefined;
  }
  let base: URL;
  try { base = new URL(url); } catch { throw new UsageError(`--url: "${url}" isn’t an address, e.g. https://flags.example.com`); }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new UsageError(`--url: "${url}" isn’t an http or https address`);
  if (!token) throw new UsageError('--url needs an access token: --token cfp_… (or COMPANYFLAGS_TOKEN), made in the signed-in console');
  const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}/api/flags-as-code`;
  return {
    async call(method: 'GET' | 'POST', path: string, body?: unknown, refused?: (status: number, body: unknown) => boolean): Promise<any> {
      let res: Response;
      try {
        res = await fetch(`${root}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        const why = (e as Error & { cause?: Error }).cause?.message ?? (e as Error).message;
        throw new ServerError(`can’t reach ${base.origin}: ${why}`);
      }
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: said below */ }
      if (res.ok && json !== null) return json;
      if (!res.ok && refused?.(res.status, json)) return undefined;
      const said = (json as { error?: string } | null)?.error ?? (res.ok ? 'an answer that isn’t JSON (is this a CompanyFlags server?)' : text.slice(0, 200) || res.statusText);
      throw new ServerError(`${base.origin} answered ${res.status}: ${said}`);
    },
  };
}

/** The configured database, opened for one command. `current`: it must have every migration (flags need today's
 *  schema; migrate is the command that changes it). `flags`: a flags command, which in CI (CI set) never opens an
 *  embedded database it wasn't told to (FF_DATA_DIR or the config's dataDir): there, no DATABASE_URL is a missing
 *  secret, and an empty database would answer with confident nonsense. */
async function withDb(cwd: string, env: NodeJS.ProcessEnv, current: boolean, run: (db: Db) => Promise<number>, o: { flags?: boolean } = {}): Promise<number> {
  const { config } = await loadConfig({ cwd, env });
  const r = resolveConfig(config, env);
  const ci = !!env.CI && env.CI !== 'false' && env.CI !== '0';
  if (o.flags && ci && !r.databaseUrl && !env.FF_DATA_DIR && !config.database?.dataDir) {
    throw new UsageError('no server to work on: set COMPANYFLAGS_URL and COMPANYFLAGS_TOKEN (or DATABASE_URL). In CI the flags commands '
      + 'don’t open an embedded database: is the secret set for this job?');
  }
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

/** MCP over stdio: each JSON-RPC line on stdin is posted to the server's /mcp with the token, and its answer is
 *  printed on stdout, one line each, in order. stdout carries nothing else: what goes wrong is said on stderr, and to
 *  the client as a JSON-RPC error when it asked something. Ends when stdin does. */
async function mcpOverStdio(o: { endpoint: string; token: string; stdin: NodeJS.ReadableStream; fetch: typeof fetch; out: Print; err: Print }) {
  const failed = (id: unknown, message: string) => {
    o.err(`companyflags mcp: ${message}`);
    if (id !== undefined && id !== null) o.out(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }));
  };
  const forward = async (line: string) => {
    let id: unknown;
    try { id = (JSON.parse(line) as { id?: unknown })?.id; } catch {
      o.out(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not valid JSON' } }));
      return;
    }
    let res: Response;
    try {
      res = await o.fetch(o.endpoint, {
        method: 'POST', body: line,
        headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      });
    } catch (e) { return failed(id, `can’t reach ${o.endpoint}: ${(e as Error).message}`); }
    const text = await res.text();
    let json: { jsonrpc?: unknown; error?: unknown } | null = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (json?.jsonrpc === '2.0') return o.out(JSON.stringify(json));
    if (res.ok) return;                                  // a notification: nothing to answer
    failed(id, `the server answered ${res.status}${typeof json?.error === 'string' ? `: ${json.error}` : ''}`);
  };
  let queue = Promise.resolve();
  for await (const line of createInterface({ input: o.stdin, crlfDelay: Infinity })) {
    if (line.trim()) queue = queue.then(() => forward(line)).catch((e: Error) => o.err(`companyflags mcp: ${e.message}`));
  }
  await queue;
  return 0;
}

/** The pull request or commit a CI job runs for (GitHub Actions, GitLab CI), as a link for `flags push`. */
export function ciLink(env: NodeJS.ProcessEnv): string | null {
  const { GITHUB_SERVER_URL: gh, GITHUB_REPOSITORY: repo, GITHUB_REF: ref, GITHUB_SHA: sha } = env;
  if (gh && repo) {
    const pr = /^refs\/pull\/(\d+)\//.exec(ref ?? '')?.[1];
    if (pr) return `${gh}/${repo}/pull/${pr}`;
    if (sha) return `${gh}/${repo}/commit/${sha}`;
  }
  const { CI_PROJECT_URL: gl, CI_MERGE_REQUEST_IID: mr, CI_COMMIT_SHA: commit } = env;
  if (gl && mr) return `${gl}/-/merge_requests/${mr}`;
  if (gl && commit) return `${gl}/-/commit/${commit}`;
  return null;
}

/** One service's flags in one environment as flagd JSON (flagd.ts), for one entity or none (`entity`: its key, or
 *  <dimension>/<key> as in /sdk/v1/flagd). The same document a backend downloads, built from the database. */
async function exportFlagd(db: Db, environment: string, service: string, entity: string | null): Promise<FlagdDoc> {
  const envs = (await all<{ key: string }>(db, `select key from environment order by id`)).map((e) => e.key);
  if (!envs.includes(environment)) throw new UsageError(`--env: no environment "${environment}" (there are: ${envs.join(', ') || 'none'})`);
  const services = (await all<{ key: string }>(db, `select key from project order by key`)).map((p) => p.key);
  if (!services.includes(service)) throw new UsageError(`--service: no service "${service}" (there are: ${services.join(', ') || 'none'})`);
  const snap = await buildSnapshot(db, environment);
  if (entity === null) return buildFlagdDoc(snap, service, null);
  const [dimension, key] = entity.includes('/') ? entity.split('/', 2) : [null, entity];
  const info = Object.hasOwn(snap.entities, key) ? snap.entities[key] : null;
  if (!info || (dimension && info.dimension !== dimension)) throw new UsageError(`--entity: no ${dimension ?? 'entity'} "${key}"`);
  return buildFlagdDoc(snap, service, info);
}

function printPlan(plan: Plan, out: Print) {
  for (const p of plan.problems) out(`! ${p}`);
  for (const s of plan.steps) out(`${s.request ? '…' : s.do === 'create' ? '+' : '~'} ${describe(s)}`);
  if (plan.unchanged.length) out(`= ${plan.unchanged.length} unchanged`);
  if (plan.onlyHere.length) out(`? only in CompanyFlags, left as they are: ${plan.onlyHere.join(', ')}`);
  for (const w of plan.waiting ?? []) out(`… request #${w.request} on ${w.flag} is waiting in ${w.environment}${w.reason ? `: ${w.reason}` : ''}`);
  if (!plan.steps.length && !plan.problems.length) out('nothing to change');
  else if (plan.steps.length && !hasChanges(plan) && !plan.problems.length) out('nothing new: every change is waiting in its request');
}

function printDone(done: Done[], out: Print) {
  for (const d of done) {
    if (d.result === 'done') out(`✓ ${describe(d.step)}`);
    else out(`→ request #${d.request}${d.reused ? ' (already open)' : ''}: ${describe({ ...d.step, request: undefined })}`);
  }
}

// run as a command (node server/cli.ts, or the companyflags bin, which may be a link to this file)
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exit(code);
}
