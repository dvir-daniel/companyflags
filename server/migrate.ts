// Schema changes: numbered SQL files in server/migrations, applied in order, each exactly once.
// - Each file runs in its own transaction: it applies completely or not at all.
// - Servers take a lock while migrating, so two servers starting together never apply the same file twice.
// - An applied file must never change: change the schema with a new file. The server refuses to start
//   if an applied file's checksum differs, or if the database has a migration this code doesn't know
//   (an older server started after a newer one upgraded the database).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LOCK = 727_001;                    // the advisory lock every server takes while migrating

export type Migration = { name: string; sql: string; checksum: string };

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map((name) => {
    const sql = readFileSync(`${dir}/${name}`, 'utf8');
    return { name, sql, checksum: checksum(sql) };
  });
}

export const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

export class MigrationError extends Error {}

/** Applies every migration the database doesn't have yet. `fresh`: the database had none before. */
export async function migrate(db: Db, migrations = readMigrations()): Promise<{ applied: string[]; fresh: boolean }> {
  const applied: string[] = [];
  let fresh: boolean | undefined;
  for (;;) {
    const name = await db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [LOCK]);
      await tx.exec(`create table if not exists schema_migration (
        name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
      const done = new Map((await tx.query<{ name: string; checksum: string }>(`select name, checksum from schema_migration`)).rows
        .map((r) => [r.name, r.checksum]));
      fresh ??= done.size === 0;
      const known = new Set(migrations.map((m) => m.name));
      for (const n of done.keys()) {
        if (!known.has(n)) throw new MigrationError(`the database has migration ${n}, which this version of the server doesn't have: run the newer version`);
      }
      for (const m of migrations) {
        const c = done.get(m.name);
        if (c !== undefined && c !== m.checksum) {
          throw new MigrationError(`migration ${m.name} was changed after it was applied: put the change in a new migration file instead`);
        }
      }
      const next = migrations.find((m) => !done.has(m.name));
      if (!next) return null;
      await tx.exec(next.sql);
      await tx.query(`insert into schema_migration (name, checksum) values ($1, $2)`, [next.name, next.checksum]);
      return next.name;
    });
    if (!name) return { applied, fresh: !!fresh };
    applied.push(name);
  }
}

/** The migrations the database doesn't have yet, without applying any (the CLI's migrate --check). */
export async function pendingMigrations(db: Db, migrations = readMigrations()): Promise<string[]> {
  const table = await db.query<{ t: string | null }>(`select to_regclass('schema_migration')::text as t`);
  if (!table.rows[0]?.t) return migrations.map((m) => m.name);
  const done = new Set((await db.query<{ name: string }>(`select name from schema_migration`)).rows.map((r) => r.name));
  return migrations.filter((m) => !done.has(m.name)).map((m) => m.name);
}
