// The database: a real Postgres server in production (DATABASE_URL), or embedded Postgres (PGlite) for
// tests and local runs. Both answer the same way, so the rest of the code doesn't know which one it has.
// The schema is built and changed only by migrations (migrate.ts): a database is never wiped or reset.

import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import { checkSchema, migrate } from './migrate.ts';

export type Rows<T> = { rows: T[]; affected?: number };          // affected: rows an insert, update or delete changed

/** The database or an open transaction: one statement with $1… parameters, or several statements with none. */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<Rows<T>>;
  exec(sql: string): Promise<void>;
}
export type Tx = Queryable;
export interface Db extends Queryable {
  /** Runs fn in one transaction: committed if it returns, rolled back if it throws. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbOptions = {
  url?: string;                          // a Postgres server, e.g. postgres://user:pass@host:5432/flags?sslmode=verify-full
  dataDir?: string;                      // no url: embedded Postgres kept in this folder (nothing = in memory)
  pool?: number;                         // a Postgres server: at most this many connections (default FF_DB_POOL, else 10)
  caFile?: string;                       // a Postgres server: a PEM file of the CAs its certificate is checked against
  log?: (m: string) => void;
  /** tests: an in-memory embedded database made from this one (embeddedTemplate), migrated already, instead of
   *  replaying every migration: it counts as new (`fresh`). */
  template?: Blob;
};

/** Opens the database and brings its schema up to date. `fresh`: it was empty before this start. With `migrate:
 *  false` it only checks the schema (checkSchema): `newer` lists the migrations of a newer version it has. */
export async function openDb(o: DbOptions & { migrate?: boolean } = {}): Promise<{ db: Db; fresh: boolean; applied: string[]; newer: string[] }> {
  const db = await connectDb(o);
  try {
    if (o.migrate === false) return { db, fresh: false, applied: [], ...(await checkSchema(db)) };
    const { fresh, applied } = await migrate(db);
    return { db, fresh: fresh || !!o.template, applied, newer: [] };
  } catch (e) {
    await db.close();
    throw e;
  }
}

/** Opens the database without touching its schema. */
export async function connectDb(o: DbOptions = {}): Promise<Db> {
  return o.url ? server(poolConfig(o.url, o), o.log ?? (() => {})) : embedded(o.dataDir, o.template);
}

/** tests: a new in-memory embedded database with every migration applied, as a template for many (DbOptions.template):
 *  loading one is cheaper than migrating each. */
export async function embeddedTemplate(): Promise<Blob> {
  const p = new PGlite({ extensions: { btree_gist } });
  try {
    await p.waitReady;
    await migrate(wrap(p));
    return await p.dumpDataDir('none');
  } finally {
    await p.close();
  }
}

/** The Postgres major version of the embedded database (PGlite, pinned to one version in package.json). A data folder
 *  holds the major version that made it (PG_VERSION), and opens with that one only. */
export const EMBEDDED_PG_MAJOR = '18';

export class FolderVersionError extends Error {}

async function embedded(dataDir?: string, template?: Blob): Promise<Db> {
  const made = dataDir && existsSync(join(dataDir, 'PG_VERSION')) ? readFileSync(join(dataDir, 'PG_VERSION'), 'utf8').trim() : null;
  if (made && made !== EMBEDDED_PG_MAJOR) {
    throw new FolderVersionError(`${dataDir} was made by Postgres ${made}, and this version of CompanyFlags embeds Postgres ${EMBEDDED_PG_MAJOR}: `
      + 'run the version that made it, and move to a Postgres server with companyflags copy-to-postgres (docs: self-hosting/backups)');
  }
  const unlock = dataDir ? lockFolder(dataDir) : () => {};
  try {
    const opts = { extensions: { btree_gist }, ...(template && !dataDir ? { loadDataDir: template } : {}) };
    const p = dataDir ? new PGlite(dataDir, opts) : new PGlite(opts);
    await p.waitReady;
    const db = wrap(p);
    return { ...db, close: () => p.close().finally(unlock) };
  } catch (e) {
    unlock();
    throw e;
  }
}

/** A PGlite as a Db (its close is PGlite's own). */
function wrap(p: PGlite): Db {
  const on = (q: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
    query: async <T>(sql: string, params: unknown[] = []) => {
      const r = await q.query<T>(sql, params as any[]);
      return { rows: r.rows, affected: r.affectedRows };
    },
    exec: async (sql) => { await q.exec(sql); },
  });
  return { ...on(p), transaction: (fn) => p.transaction((tx) => fn(on(tx))), close: () => p.close() };
}

/** The embedded database must only ever be open in one process: two writing the same folder damage it. It is for one
 *  container only: a volume shared by several (two replicas, or the old and the new one during a deploy) is refused.
 *  A lock file next to the folder (data-local → data-local.lock; inside it, Postgres would take the folder for a
 *  database that already exists) names who has it: the host (its name, and on Linux the machine's boot ID: each
 *  container has its own name, each VM its own boot ID), the process (its PID and command line), and when it was last
 *  seen: the holder writes the time again every few seconds while it is open (HEARTBEAT_MS).
 *  - Another host's lock is in use while its time is fresh (STALE_MS): a process ID means nothing across hosts. One
 *    whose holder hasn't written for longer stopped without letting go (a hard stop, a host that went away), and is
 *    taken over.
 *  - This host's lock is decided by its process: stale when that process has ended (a crash), when its PID now runs
 *    another program, or when it names this process but this process never took it: a hard stop (a kill, an
 *    out-of-memory) skips the release, and a container that starts again is PID 1 again, with the same host name.
 *  Returns the release. */
export class FolderInUseError extends Error {}
const held = new Set<string>();                               // the lock files this process holds
/** How often the holder writes its time into the lock, and how old that time is before another host takes it over. */
export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;

type Lock = { pid: number; command: string; host: string | null; boot: string | null; instance: string | null; seen: number | null };
/** This host: its name, and the boot ID of the machine (Linux: the kernel's, one per VM; elsewhere none). */
export function thisHost(): { host: string; boot: string | null } {
  let boot: string | null = null;
  try { boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { /* not Linux */ }
  return { host: hostname(), boot };
}

export function lockFolder(dataDir: string, o: { heartbeatMs?: number } = {}): () => void {
  const file = `${resolve(dataDir)}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const me = { pid: process.pid, command: commandOf(process.pid) ?? '', ...thisHost(), instance: randomUUID() };
  const text = () => `${JSON.stringify({ ...me, seen: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');                       // fails if the file exists: only one process gets it
      writeSync(fd, text());
      closeSync(fd);
      held.add(file);
      // the time, again and again while it is open: through a new file renamed over the lock, so a reader never sees
      // half of it. Not once someone else has it (taken over after this process stalled): then it is theirs.
      const beat = setInterval(() => {
        try {
          if (readLock(file).instance !== me.instance) { clearInterval(beat); return; }
          const next = `${file}.${me.instance}`;
          writeFileSync(next, text());
          renameSync(next, file);
        } catch { /* the volume is away for a moment: next time */ }
      }, o.heartbeatMs ?? HEARTBEAT_MS);
      beat.unref();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        held.delete(file);
        process.off('exit', release);
        try { if (readLock(file).instance === me.instance) unlinkSync(file); } catch { /* already gone */ }
      };
      process.on('exit', release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let was: string;
      try { was = readFileSync(file, 'utf8'); } catch { continue; }    // let go of a moment ago: try again
      const lock = parseLock(was);
      if (otherHost(lock)) {
        const age = lock.seen === null ? Infinity : Date.now() - lock.seen;
        if (age < STALE_MS) {
          throw new FolderInUseError(`the embedded database in ${dataDir} is open in another container (${lock.host}, seen ${Math.max(0, Math.round(age / 1000))} s ago): `
            + 'it is for one container only; use Postgres for several (DATABASE_URL). If that container is gone, this one takes the folder over '
            + `once its lock is ${STALE_MS / 1000} s old.`);
        }
      } else if (lockInUse(file, lock)) {
        throw new FolderInUseError(`another CompanyFlags server (process ${lock.pid}) is using ${dataDir}. `
          + 'Stop it first: the embedded database can only be open in one process at a time.');
      }
      // stale: taken over, unless it changed since it was read (another server took it over first: try again)
      try { if (readFileSync(file, 'utf8') === was) unlinkSync(file); } catch { /* gone already: try again */ }
    }
  }
  throw new FolderInUseError(`couldn't lock ${dataDir}: another server is starting with it`);
}

function readLock(file: string): Lock { return parseLock(readFileSync(file, 'utf8')); }
/** A lock as written: JSON, or the PID and command line on two lines (from before), which names no host. */
function parseLock(text: string): Lock {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const seen = typeof j.seen === 'string' ? Date.parse(j.seen) : NaN;
    return { pid: Number(j.pid), command: str(j.command) ?? '', host: str(j.host), boot: str(j.boot), instance: str(j.instance), seen: Number.isFinite(seen) ? seen : null };
  } catch {
    const [pid = '', ...rest] = text.split('\n');
    return { pid: Number(pid.trim()), command: rest.join('\n').trim(), host: null, boot: null, instance: null, seen: null };
  }
}

/** Whether a lock was taken on another host: another host name, or another machine's boot. A lock that names no host
 *  is judged as this host's, by its process. */
function otherHost(lock: Lock): boolean {
  if (!lock.host) return false;
  const here = thisHost();
  return lock.host !== here.host || (!!lock.boot && !!here.boot && lock.boot !== here.boot);
}

/** Whether the process a lock (of this host) names still has the folder open. */
function lockInUse(file: string, lock: Lock): boolean {
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) return false;
  if (lock.pid === process.pid) return held.has(file);       // this process: in use only if it took the lock itself
  if (!running(lock.pid)) return false;
  // the PID runs, but maybe another program now: in use only while it runs the command that took the lock
  const now = lock.command ? commandOf(lock.pid) : null;
  return now === null || now === lock.command;               // can't tell: in use, to be safe
}

function running(pid: number) {
  try { process.kill(pid, 0); return true; }                  // signal 0: only asks whether the process exists
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A process's command line, or null if this system won't say: /proc on Linux, ps elsewhere. */
function commandOf(pid: number): string | null {
  if (process.platform === 'linux') {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { return null; }
  }
  if (process.platform === 'win32') return null;
  const ps = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.trim() ? ps.stdout.trim() : null;
}

// pg returns bigints as strings and dates at local midnight; PGlite returns numbers and UTC midnight.
// Read them the PGlite way so both give the same values (ids stay far below 2^53).
const builtin = pg.types.getTypeParser as (oid: number, format?: string) => (v: string) => unknown;
const PARSERS: Record<number, (v: string) => unknown> = {
  20: Number,                                                                         // int8
  1016: (v) => (builtin(1016)(v) as (string | null)[]).map((x) => (x === null ? null : Number(x))), // int8[]
  1082: (v) => new Date(`${v}T00:00:00Z`),                                            // date
};
const types = { getTypeParser: (oid: number, format?: string) => PARSERS[oid] ?? builtin(oid, format) } as pg.CustomTypesConfig;

export class DatabaseCaError extends Error {}
const SSL_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

/** How node-postgres connects to a Postgres server. In the URL, its own rules: sslmode=require (and prefer, verify-ca)
 *  means verify-full, the certificate checked against the system's CAs (and NODE_EXTRA_CA_CERTS), or sslrootcert's.
 *  With `caFile` (database.caFile, FF_DATABASE_CA_FILE), e.g. Amazon RDS's global bundle, TLS is always on and the
 *  certificate is checked against that file, its host name too (sslmode=verify-ca: the certificate only). */
export function poolConfig(url: string, o: Pick<DbOptions, 'pool' | 'caFile'> = {}): pg.PoolConfig {
  const base = { types, max: o.pool ?? Number(process.env.FF_DB_POOL || 10) };
  if (!o.caFile) return { ...base, connectionString: url };
  const read = (file: string, what: string) => {
    try { return readFileSync(file, 'utf8'); } catch (e) { throw new DatabaseCaError(`can’t read ${what} ${file}: ${(e as Error).message}`); }
  };
  const ca = read(o.caFile, 'the database’s CA file (database.caFile, FF_DATABASE_CA_FILE)');
  if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new DatabaseCaError(`${o.caFile} has no certificate in it: the database’s CA file is PEM (-----BEGIN CERTIFICATE-----)`);
  // the URL's own TLS settings would replace these (node-postgres reads the URL last): taken out, and read here
  const at = url.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
  const mode = params.get('sslmode');
  if (mode && !['prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) {
    throw new DatabaseCaError(`sslmode=${mode} in the database URL doesn’t check the certificate, and the CA file (FF_DATABASE_CA_FILE) is there to check it: use sslmode=verify-full, or leave it out`);
  }
  const ssl: NonNullable<Exclude<pg.PoolConfig['ssl'], boolean>> = { ca, rejectUnauthorized: true };
  const cert = params.get('sslcert');
  const key = params.get('sslkey');
  if (cert) ssl.cert = read(cert, 'sslcert');
  if (key) ssl.key = read(key, 'sslkey');
  if (mode === 'verify-ca') ssl.checkServerIdentity = () => undefined;
  for (const p of SSL_PARAMS) params.delete(p);
  const rest = params.toString();
  return { ...base, connectionString: `${at < 0 ? url : url.slice(0, at)}${rest ? `?${rest}` : ''}`, ssl };
}

function server(config: pg.PoolConfig, log: (m: string) => void): Db {
  const pool = new pg.Pool(config);
  // A connection that drops while idle (a failover, a restart) is replaced on the next query.
  // Without this listener the error would end the process.
  pool.on('error', (e) => log(`database connection lost: ${e.message}`));
  const on = (c: pg.Pool | pg.PoolClient): Queryable => ({
    query: async <T>(sql: string, params: unknown[] = []) => {
      const r = await c.query(sql, params);
      return { rows: r.rows as T[], affected: r.rowCount ?? undefined };
    },
    exec: async (sql) => { await c.query(sql); },       // no parameters: several statements may run at once
  });
  return {
    ...on(pool),
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('begin');
        const out = await fn(on(client));
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => { broken = true; });
        throw e;
      } finally {
        client.release(broken);                           // a connection that couldn't roll back is closed, not reused
      }
    },
    close: () => pool.end(),
  };
}

export async function one<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await q.query<T>(sql, params);
  return r.rows[0];
}

export async function all<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q.query<T>(sql, params)).rows;
}

/** The stable codes of the HTTP API's errors (docs/reference/http-api.md lists them), sent as `code` beside the
 *  sentence in `error`. A caller acts on the code, never the words: the words may change in any release, the codes
 *  don't. Each has the status it goes with; an error that names no code gets its status's (codeOf). */
export const ERROR_CODES = {
  bad_request: 400,      // a value is missing or of the wrong form (in the address, the query or the body)
  bad_json: 400,         // the body isn't a JSON object
  unauthorized: 401,     // not signed in, or an unknown, expired or revoked token
  forbidden: 403,        // signed in, but this person's role (or this token) may not do it
  not_found: 404,        // no such flag, environment, entity, … (or no such endpoint)
  already_exists: 409,   // the key is taken already
  conflict: 409,         // someone else changed it since you read it: read it again
  blocked: 409,          // not now: something else has to change first (it's in use, turn it off first, …)
  too_large: 413,        // the body is larger than this address takes
  invalid: 422,          // understood, but what it asks for breaks a rule (the words say which)
  needs_reshuffle: 422,  // a % change moves devices to other values: send it again with allowReshuffle
  too_many_requests: 429,
  internal: 500,         // a bug: logged on the server, and nothing about it in the answer
  unavailable: 503,      // the database isn't answering
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

const CODE_OF_STATUS: Record<number, ErrorCode> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'blocked', 413: 'too_large', 422: 'invalid',
  429: 'too_many_requests', 500: 'internal', 503: 'unavailable',
};
/** The code an error gets from its status when it names none. */
export const codeOf = (status: number): ErrorCode => CODE_OF_STATUS[status] ?? (status >= 500 ? 'internal' : 'bad_request');

export class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  code: ErrorCode;
  constructor(status: number, message: string, body: Record<string, unknown> = {}, code?: ErrorCode) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code ?? codeOf(status);
  }
}
