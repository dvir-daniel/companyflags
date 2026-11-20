// Backups, and moving off the embedded database (the CLI's backup and copy-to-postgres, cli.ts).
//
// - A Postgres server is backed up with its own pg_dump (a custom-format file; pg_restore puts it back).
// - Embedded Postgres (PGlite) is a folder: the backup is a copy of it, made while no server has it open (the lock
//   beside the folder says so, db.ts), and put back by copying it into place.
// - copyDatabase copies every row of one database into another of the same schema, in one transaction: how an
//   installation that started on the embedded database moves to a Postgres server, with its history, people, keys and
//   links as they are.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lockFolder, type Db, type Queryable } from './db.ts';

export class BackupError extends Error {}

/** A name for a backup made now: companyflags-backup-2026-11-20-1530. */
export const backupName = (now = new Date()) => `companyflags-backup-${now.toISOString().slice(0, 16).replace('T', '-').replace(':', '')}`;

/** Backs up a Postgres server with pg_dump, into one file. The password goes to pg_dump in its environment, never on
 *  its command line (where other users of the machine could see it). */
export function dumpPostgres(url: string, file: string, o: { pgDump?: string } = {}): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new BackupError('DATABASE_URL isn’t a postgres:// address'); }
  const password = decodeURIComponent(u.password);
  u.password = '';
  const r = spawnSync(o.pgDump ?? 'pg_dump', ['--format=custom', '--no-owner', `--file=${file}`, `--dbname=${u.toString()}`], {
    env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) }, encoding: 'utf8',
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new BackupError('pg_dump isn’t installed here: install the PostgreSQL client tools (the same major version as the server, or newer), or run pg_dump from the postgres image');
  }
  if (r.error) throw new BackupError(`pg_dump couldn’t run: ${r.error.message}`);
  if (r.status !== 0) throw new BackupError(`pg_dump failed: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
}

/** Copies the embedded database's folder, while no server has it open. */
export function copyDataDir(dataDir: string, dest: string): void {
  const from = resolve(dataDir);
  if (!existsSync(`${from}/PG_VERSION`)) throw new BackupError(`${from} isn’t an embedded database folder (no PG_VERSION in it)`);
  if (existsSync(dest)) throw new BackupError(`${dest} is there already: name a new folder`);
  const release = lockFolder(dataDir);                  // a running server has it: stop it first (FolderInUseError)
  try {
    cpSync(from, dest, { recursive: true, preserveTimestamps: true });
  } finally {
    release();
  }
}

/** The size of a backup, for the CLI to say. */
export function sizeOf(path: string): string {
  const bytes = (p: string): number => (statSync(p).isDirectory()
    ? readdirSync(p).reduce((sum, f) => sum + bytes(join(p, f)), 0)
    : statSync(p).size);
  const n = bytes(path);
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

type Column = { name: string; type: string; identity: boolean };
type Table = { name: string; columns: Column[]; key: string[]; parents: { cols: string[]; table: string; refs: string[]; deferrable: boolean }[] };

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The tables of the public schema with their columns (not generated ones), primary key and foreign keys. */
async function tablesOf(db: Queryable): Promise<Table[]> {
  const cols = (await db.query<{ t: string; name: string; type: string; identity: boolean }>(`
    select c.relname as t, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attidentity <> '' as identity
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    order by c.relname, a.attnum`)).rows;
  const keys = (await db.query<{ t: string; cols: string[]; kind: string; parent: string | null; refs: string[] | null; deferrable: boolean }>(`
    select c.relname as t, con.contype::text as kind, p.relname as parent, con.condeferrable as deferrable,
      (select array_agg(a.attname::text order by k.i) from unnest(con.conkey) with ordinality k(n, i)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) as cols,
      (select array_agg(a.attname::text order by k.i) from unnest(con.confkey) with ordinality k(n, i)
        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) as refs
    from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_class p on p.oid = con.confrelid
    where n.nspname = 'public' and con.contype in ('p', 'f')`)).rows;
  const byName = new Map<string, Table>();
  for (const c of cols) {
    if (c.t === 'schema_migration') continue;            // the migrations fill it on the other side
    let t = byName.get(c.t);
    if (!t) byName.set(c.t, (t = { name: c.t, columns: [], key: [], parents: [] }));
    t.columns.push({ name: c.name, type: c.type, identity: c.identity });
  }
  for (const k of keys) {
    const t = byName.get(k.t);
    if (!t) continue;
    if (k.kind === 'p') t.key = k.cols;
    else t.parents.push({ cols: k.cols, table: k.parent!, refs: k.refs ?? [], deferrable: k.deferrable });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The tables in an order where each comes after the tables it refers to. A reference checked at commit (deferrable)
 *  doesn't order them: the copy defers those checks to its end. */
function inOrder(tables: Table[]): Table[] {
  const out: Table[] = [];
  const state = new Map<string, 'busy' | 'done'>();
  const byName = new Map(tables.map((t) => [t.name, t]));
  const visit = (t: Table, path: string[]) => {
    if (state.get(t.name) === 'done') return;
    if (state.get(t.name) === 'busy') throw new BackupError(`the tables refer to each other in a circle (${[...path, t.name].join(' → ')}): this copy can’t order them`);
    state.set(t.name, 'busy');
    for (const p of t.parents) {
      if (p.deferrable) continue;
      const parent = byName.get(p.table);
      if (parent && parent !== t) visit(parent, [...path, t.name]);
    }
    state.set(t.name, 'done');
    out.push(t);
  };
  for (const t of tables) visit(t, []);
  return out;
}

/** Rows of a table that refers to itself (an entity's parent), parents first. */
function parentsFirst(t: Table, rows: (string | null)[][]): (string | null)[][] {
  const self = t.parents.filter((p) => p.table === t.name);
  if (!self.length) return rows;
  if (self.some((p) => p.cols.length !== 1 || p.refs.length !== 1)) throw new BackupError(`${t.name} refers to itself with several columns: this copy can’t order its rows`);
  const at = (col: string) => t.columns.findIndex((c) => c.name === col);
  const links = self.map((p) => ({ from: at(p.cols[0]), to: at(p.refs[0]) }));
  const out: (string | null)[][] = [];
  const done = new Set<(string | null)[]>();
  const index = links.map((l) => new Map(rows.map((r) => [r[l.to], r])));
  const visit = (r: (string | null)[], depth: number) => {
    if (done.has(r)) return;
    if (depth > rows.length) throw new BackupError(`${t.name}'s rows refer to each other in a circle`);
    links.forEach((l, i) => {
      const parent = r[l.from] === null ? undefined : index[i].get(r[l.from]);
      if (parent && parent !== r) visit(parent, depth + 1);
    });
    done.add(r);
    out.push(r);
  };
  for (const r of rows) visit(r, 0);
  return out;
}

const PAGE = 5000;
const PARAMS = 30000;                                    // per insert: Postgres takes at most 65535 parameters

/** Copies every row from one database into another with the same schema (both migrated to the same version), in one
 *  transaction on the target: all of it, or nothing. Values travel as text and are cast back to their types, so
 *  nothing changes on the way (JSON, lists, times, bytes). The target's tables must hold nothing but what its own
 *  migrations put there, which is replaced. Returns the rows copied per table. */
export async function copyDatabase(from: Db, to: Db, o: { log?: (m: string) => void } = {}): Promise<Record<string, number>> {
  const tables = inOrder(await tablesOf(to));
  const fromTables = new Map((await tablesOf(from)).map((t) => [t.name, t]));
  for (const t of tables) {
    const f = fromTables.get(t.name);
    const missing = t.columns.filter((c) => !f?.columns.some((x) => x.name === c.name));
    if (!f || missing.length) throw new BackupError(`the two databases’ schemas differ (${t.name}${missing.length ? `: ${missing.map((c) => c.name).join(', ')}` : ''}): migrate both to the same version first`);
  }
  const copied: Record<string, number> = {};
  await to.transaction(async (tx) => {
    await tx.query(`set constraints all deferred`);     // references checked at commit (a flag's safe value)
    // what the target's migrations put there (the attributes everyone has, …) makes way for the source's rows
    for (const t of [...tables].reverse()) {
      if ((await tx.query(`select 1 from ${ident(t.name)} limit 1`)).rows.length) await tx.query(`delete from ${ident(t.name)}`);
    }
    for (const t of tables) {
      const names = t.columns.map((c) => ident(c.name));
      const select = `select ${t.columns.map((c) => `${ident(c.name)}::text`).join(', ')} from ${ident(t.name)}`;
      const order = t.key.length ? ` order by ${t.key.map(ident).join(', ')}` : ' order by 1';
      const selfRef = t.parents.some((p) => p.table === t.name);
      let rows: (string | null)[][] = [];
      const read = async (offset: number | null) => (await from.query<Record<string, string | null>>(
        `${select}${order}${offset === null ? '' : ` limit ${PAGE} offset ${offset}`}`)).rows.map((r) => Object.values(r));
      const write = async (batch: (string | null)[][]) => {
        const per = Math.max(1, Math.floor(PARAMS / t.columns.length));
        for (let i = 0; i < batch.length; i += per) {
          const chunk = batch.slice(i, i + per);
          const values = chunk.map((_, r) => `(${t.columns.map((c, k) => `$${r * t.columns.length + k + 1}::${c.type}`).join(', ')})`).join(', ');
          const overriding = t.columns.some((c) => c.identity) ? ' overriding system value' : '';
          await tx.query(`insert into ${ident(t.name)} (${names.join(', ')})${overriding} values ${values}`, chunk.flat());
        }
      };
      let n = 0;
      if (selfRef) {
        rows = parentsFirst(t, await read(null));      // a tree (entities, dimensions): small, read at once
        await write(rows);
        n = rows.length;
      } else {
        for (let offset = 0; ; offset += PAGE) {
          const page = await read(offset);
          if (!page.length) break;
          await write(page);
          n += page.length;
          if (page.length < PAGE) break;
        }
      }
      // the next id each table hands out comes after the rows copied
      for (const c of t.columns.filter((x) => x.identity)) {
        await tx.query(`select setval(pg_get_serial_sequence($1, $2), coalesce(max(${ident(c.name)}), 0) + 1, false) from ${ident(t.name)}`, [ident(t.name), c.name]);
      }
      copied[t.name] = n;
      if (n) o.log?.(`${t.name}: ${n}`);
    }
  });
  return copied;
}

/** Whether a database has no tables yet: a new one to copy into. */
export async function isEmpty(db: Queryable): Promise<boolean> {
  return !(await db.query(`select 1 from pg_tables where schemaname = 'public' limit 1`)).rows.length;
}
