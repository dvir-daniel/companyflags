// The database: a real Postgres server in production (DATABASE_URL), or embedded Postgres (PGlite) for
// tests and local runs. Both answer the same way, so the rest of the code doesn't know which one it has.
// The schema is built and changed only by migrations (migrate.ts): a database is never wiped or reset.

import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { migrate } from './migrate.ts';

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
  log?: (m: string) => void;
};

/** Opens the database and brings its schema up to date. `fresh`: it was empty before this start. */
export async function openDb(o: DbOptions = {}): Promise<{ db: Db; fresh: boolean; applied: string[] }> {
  const db = await connectDb(o);
  try {
    const { fresh, applied } = await migrate(db);
    return { db, fresh, applied };
  } catch (e) {
    await db.close();
    throw e;
  }
}

/** Opens the database without touching its schema. */
export async function connectDb(o: DbOptions = {}): Promise<Db> {
  return o.url ? server(o.url, o.log ?? (() => {})) : embedded(o.dataDir);
}

async function embedded(dataDir?: string): Promise<Db> {
  const unlock = dataDir ? lockFolder(dataDir) : () => {};
  try {
    const opts = { extensions: { btree_gist } };
    const p = dataDir ? new PGlite(dataDir, opts) : new PGlite(opts);
    await p.waitReady;
    const on = (q: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
      query: async <T>(sql: string, params: unknown[] = []) => {
        const r = await q.query<T>(sql, params as any[]);
        return { rows: r.rows, affected: r.affectedRows };
      },
      exec: async (sql) => { await q.exec(sql); },
    });
    return { ...on(p), transaction: (fn) => p.transaction((tx) => fn(on(tx))), close: () => p.close().finally(unlock) };
  } catch (e) {
    unlock();
    throw e;
  }
}

/** The embedded database must only ever be open in one process: two writing the same folder damage it.
 *  A lock file next to the folder (data-local → data-local.lock; inside it, Postgres would take the folder for
 *  a database that already exists) names the process that has it. A second server refuses to open the folder,
 *  and a lock left by a process that has ended (a crash) is taken over. Returns the release. */
export class FolderInUseError extends Error {}
function lockFolder(dataDir: string): () => void {
  const file = `${resolve(dataDir)}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');                       // fails if the file exists: only one process gets it
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        try { if (Number(readFileSync(file, 'utf8')) === process.pid) unlinkSync(file); } catch { /* already gone */ }
      };
      process.on('exit', release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(file, 'utf8'));
      if (pid && running(pid)) {                              // this process too: it has the folder open already
        throw new FolderInUseError(`another CompanyFeatures server (process ${pid}) is using ${dataDir}. `
          + 'Stop it first: the embedded database can only be open in one process at a time.');
      }
      try { unlinkSync(file); } catch { /* someone else took it over: try again */ }
    }
  }
  throw new FolderInUseError(`couldn't lock ${dataDir}: another server is starting with it`);
}

function running(pid: number) {
  try { process.kill(pid, 0); return true; }                  // signal 0: only asks whether the process exists
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
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

function server(url: string, log: (m: string) => void): Db {
  const pool = new pg.Pool({ connectionString: url, types, max: Number(process.env.FF_DB_POOL ?? 10) });
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

/** A stable name for an error the console acts on (sent as `code` in the JSON error body), so it never has to read the
 *  message: `conflict` someone else changed what you edited, `needs_reshuffle` a % change needs a confirmed reshuffle. */
export type ErrorCode = 'conflict' | 'needs_reshuffle';

export class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  code?: ErrorCode;
  constructor(status: number, message: string, body: Record<string, unknown> = {}, code?: ErrorCode) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code;
  }
}
