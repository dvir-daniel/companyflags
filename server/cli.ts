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
//   companyflags flags unused [file]   flags no code mentions, and keys the code reads that aren't flags
// The flags commands go through a server's API instead with --url and --token (COMPANYFLAGS_URL, COMPANYFLAGS_TOKEN).
//   companyflags mcp --url … --token … MCP over stdio, for AI clients that start local servers (plugins/mcp.ts)

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectDb, FolderInUseError, type Db } from './db.ts';
import { migrate, MigrationError, pendingMigrations, readMigrations } from './migrate.ts';
import { ConfigError } from './config.ts';
import { canImportConfig, CONFIG_FILE, loadConfig, resolveConfig, whereConfigGoes } from './configFile.ts';
import { journaled } from './journal.ts';
import { describe, planFlags, pullFlags, pushFlags, type Done, type Plan } from './flagsAsCode.ts';
import { codeReferences } from './codeReferences.ts';

const HELP = `companyflags: the feature flag server, its database and your flags as code

Usage:
  companyflags start                 Run the server (the console, the API and the plugins)
  companyflags init                  Write ${CONFIG_FILE} in this folder
  companyflags secret                Print a random secret for BETTER_AUTH_SECRET
  companyflags migrate [--check]     Apply the database's migrations; --check only lists them (exit 1 if any)
  companyflags flags pull [file]     Write every flag to a file (default flags.json)
  companyflags flags plan [file]     Show what a push would change
  companyflags flags push [file]     Make CompanyFlags match the file [--as <name>]
  companyflags flags unused [file]   List flags no code mentions, and keys the code reads that aren't flags
                                     [--src <dir>] (default: this folder); --strict exits 1 if there are any
  companyflags mcp --url <server> --token <cfp_…>
                                     MCP over stdio for AI clients: each line goes to the server's /mcp
                                     (or COMPANYFLAGS_URL and COMPANYFLAGS_TOKEN)

The flags commands take --url <server> and --token <cfp_…> (or COMPANYFLAGS_URL and COMPANYFLAGS_TOKEN) to go
through a server's API with an access token. History then shows the token's person (or agent), not --as.
Without a URL, they read ${CONFIG_FILE} from this folder (or FF_CONFIG), then the environment (DATABASE_URL,
FF_DATA_DIR, …), and open the database. With embedded Postgres (no DATABASE_URL), stop the server first: one
process at a time can open its files.
Docs: https://dvir-daniel.github.io/companyflags/reference/cli`;

const CONFIG_TEMPLATE = `// How this CompanyFlags server runs. Every setting is optional: what isn't set here comes from the environment
// variables (DATABASE_URL, BETTER_AUTH_SECRET, …), then the defaults.
// Docs: https://dvir-daniel.github.io/companyflags/self-hosting/configuration
import { defineConfig } from 'companyflags/config';
import { appFiles, cloudflare, flagd, mcp, ofrep, webhooks } from 'companyflags/plugins';

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
        if (sub !== 'pull' && sub !== 'plan' && sub !== 'push' && sub !== 'unused') throw new UsageError('flags: pull, plan, push or unused');
        const server = remote(flag('--url') ?? env.COMPANYFLAGS_URL, flag('--token') ?? env.COMPANYFLAGS_TOKEN);
        if (sub === 'unused') {
          const src = resolve(cwd, flag('--src') ?? '.');
          const strict = has('--strict');
          const file = resolve(cwd, rest.shift() ?? 'flags.json');
          nothingElse('flags unused');
          if (!existsSync(src)) throw new UsageError(`no folder ${src} (--src)`);
          const keys = Object.keys((server ? await server.call('GET', '') : readFlagsFile(file)).flags ?? {});
          const found = codeReferences(keys, src, { skip: [file] });
          if (found.unused.length) out(`? unused: ${found.unused.join(', ')}`);
          for (const u of found.unknown) out(`! unknown: ${u.key} (${relative(cwd, u.file) || u.file}:${u.line})`);
          if (!found.unused.length && !found.unknown.length) out(`nothing to report: the code mentions all ${keys.length} flags and reads no others`);
          return strict && (found.unused.length || found.unknown.length) ? 1 : 0;
        }
        const asName = flag('--as');
        const file = resolve(cwd, rest.shift() ?? 'flags.json');
        nothingElse(`flags ${sub}`);
        if (server && asName) throw new UsageError('--as is for the database: over HTTP, History shows the token’s person');
        const as = asName ?? env.USER ?? 'cli';
        if (sub === 'pull') {
          const write = (f: { flags: Record<string, unknown> }) => {
            writeFileSync(file, `${JSON.stringify(f, null, 2)}\n`);
            out(`wrote ${Object.keys(f.flags).length} flags to ${file}`);
            return 0;
          };
          if (server) return write(await server.call('GET', ''));
          return await withDb(cwd, env, true, async (db) => write(await pullFlags(db)));
        }
        const parsed = readFlagsFile(file);
        if (server) {
          if (sub === 'plan') {
            const plan: Plan = await server.call('POST', '/plan', parsed);
            printPlan(plan, out);
            return plan.problems.length ? 1 : 0;
          }
          const r: { plan: Plan; done: Done[] } = await server.call('POST', '/push', parsed, (status, body) => {
            // a file with problems (nothing pushed), or a step refused (with what was done before it)
            const b = body as { error?: string; plan?: Plan; done?: Done[] } | null;
            if (!b?.plan) return false;
            printPlan(b.plan, out);
            if (b.done) {
              printDone(b.done, out);
              err(`stopped: ${b.error ?? `the server answered ${status}`}`);
            }
            return true;
          });
          if (!r) return 1;
          printPlan(r.plan, out);
          printDone(r.done, out);
          return 0;
        }
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
    if (e instanceof UsageError || e instanceof ServerError || e instanceof ConfigError || e instanceof FolderInUseError || e instanceof MigrationError) {
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
