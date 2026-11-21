// The database: a real Postgres server in production (DATABASE_URL), or embedded Postgres (PGlite) for
// tests and local runs. Both answer the same way, so the rest of the code doesn't know which one it has.
// The schema is built and changed only by migrations (migrate.ts): a database is never wiped or reset.

import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
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
  return o.url ? server(o.url, o.log ?? (() => {}), o.pool) : embedded(o.dataDir, o.template);
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

/** The embedded database must only ever be open in one process: two writing the same folder damage it.
 *  A lock file next to the folder (data-local → data-local.lock; inside it, Postgres would take the folder for
 *  a database that already exists) names the process that has it: its PID, and its command line. A second server
 *  refuses to open the folder. A lock is stale, and taken over, when the process it names has ended (a crash), when
 *  that PID now runs another program, or when it names this process but this process never took it: a hard stop
 *  (a kill, an out-of-memory) skips the release, and in Docker the next start is PID 1 again. Returns the release. */
export class FolderInUseError extends Error {}
const held = new Set<string>();                               // the lock files this process holds
export function lockFolder(dataDir: string): () => void {
  const file = `${resolve(dataDir)}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');                       // fails if the file exists: only one process gets it
      writeSync(fd, `${process.pid}\n${commandOf(process.pid) ?? ''}\n`);
      closeSync(fd);
      held.add(file);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        held.delete(file);
        process.off('exit', release);
        try { if (readLock(file).pid === process.pid) unlinkSync(file); } catch { /* already gone */ }
      };
      process.on('exit', release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const lock = readLock(file);
      if (lockInUse(file, lock)) {
        throw new FolderInUseError(`another CompanyFlags server (process ${lock.pid}) is using ${dataDir}. `
          + 'Stop it first: the embedded database can only be open in one process at a time.');
      }
      try { unlinkSync(file); } catch { /* someone else took it over: try again */ }
    }
  }
  throw new FolderInUseError(`couldn't lock ${dataDir}: another server is starting with it`);
}

type Lock = { pid: number; command: string };
function readLock(file: string): Lock {
  const [pid = '', ...rest] = readFileSync(file, 'utf8').split('\n');
  return { pid: Number(pid.trim()), command: rest.join('\n').trim() };
}

/** Whether the process a lock names still has the folder open. */
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

function server(url: string, log: (m: string) => void, size?: number): Db {
  const pool = new pg.Pool({ connectionString: url, types, max: size ?? Number(process.env.FF_DB_POOL || 10) });
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
