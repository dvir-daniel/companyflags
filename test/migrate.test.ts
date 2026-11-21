// The database is never reset: the schema only moves forward through migrations (server/migrate.ts), and a
// restart keeps everything. Runs on the in-memory database, or on a real Postgres with pnpm test:pg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDb, FolderInUseError, lockFolder, one, STALE_MS, thisHost, type Db } from '../server/db.ts';
import { checksum, migrate, MigrationError, readMigrations, type Migration } from '../server/migrate.ts';
import { createApp } from '../server/index.ts';
import { CSRF, testDatabase } from './helpers.ts';
import { fixtures } from './fixtures.ts';

const m = (name: string, sql: string): Migration => ({ name, sql, checksum: checksum(sql) });
const SHIPPED = readMigrations();

/** A lock file as a server writes it (db.ts lockFolder), by default this host's. */
const lockText = (o: Record<string, unknown>) => `${JSON.stringify({ pid: 1, command: 'node server/index.ts', ...thisHost(), instance: crypto.randomUUID(), seen: new Date().toISOString(), ...o })}\n`;

async function withDb(fn: (open: () => Promise<Db>) => Promise<void>) {
  const t = await testDatabase();
  const opened: Db[] = [];
  let shared: Promise<Db> | undefined;      // embedded in-memory: one database, so every open returns it
  const open = async () => {
    if (!t.url) return (shared ??= connectDb());
    const db = await connectDb({ url: t.url });
    opened.push(db);
    return db;
  };
  try { await fn(open); } finally {
    for (const db of opened) await db.close();
    await (await shared)?.close();
    await t.drop();
  }
}

const names = async (db: Db) => (await db.query<{ name: string }>(`select name from schema_migration order by name`)).rows.map((r) => r.name);

test('a new database gets every migration once; running again applies nothing', () => withDb(async (open) => {
  const db = await open();
  const first = await migrate(db);
  assert.deepEqual(first, { applied: SHIPPED.map((x) => x.name), fresh: true });
  assert.ok(await one(db, `select 1 from information_schema.tables where table_name = 'flag'`), 'the schema is there');
  const indexes = (await db.query<{ name: string }>(`select indexname as name from pg_indexes where schemaname = 'public'`)).rows.map((r) => r.name);
  for (const i of ['change_history_by_revision', 'change_history_by_flag', 'change_history_by_entity', 'auth_user_lower_email', 'change_set_scheduled', 'change_set_by_status']) {
    assert.ok(indexes.includes(i), `index ${i}`);
  }
  const kind = await one<{ d: string }>(db, `select column_default as d from information_schema.columns where table_name = 'change_set_item' and column_name = 'kind'`);
  assert.match(kind?.d ?? '', /'layer'/, 'change set items are layer changes unless they say otherwise');
  assert.deepEqual(await migrate(db), { applied: [], fresh: false });
  assert.deepEqual(await names(db), SHIPPED.map((x) => x.name));
}));

test('an upgrade applies only the new file and keeps the data', () => withDb(async (open) => {
  const db = await open();
  await migrate(db, [m('0001_a.sql', `create table thing (id int primary key, name text)`)]);
  await db.query(`insert into thing values (1, 'kept')`);
  const r = await migrate(db, [m('0001_a.sql', `create table thing (id int primary key, name text)`), m('0002_b.sql', `alter table thing add column note text`)]);
  assert.deepEqual(r, { applied: ['0002_b.sql'], fresh: false });
  assert.deepEqual((await db.query(`select id, name, note from thing`)).rows, [{ id: 1, name: 'kept', note: null }]);
}));

test('a version release may go without a remove-by date; an on/off release or an experiment needs one', () => withDb(async (open) => {
  const db = await open();
  await migrate(db);
  await db.query(`insert into flag (key, value_type, kind) values ('web_bundle', 'string', 'release')`);
  await assert.rejects(db.query(`insert into flag (key, value_type, kind) values ('new_thing', 'bool', 'release')`), /flag_remove_by_check/);
  await assert.rejects(db.query(`insert into flag (key, value_type, kind) values ('an_experiment', 'string', 'experiment')`), /flag_remove_by_check/);
}));

test('a migration that fails changes nothing, and the fixed one applies later', () => withDb(async (open) => {
  const db = await open();
  const a = m('0001_a.sql', `create table thing (id int primary key)`);
  await migrate(db, [a]);
  await assert.rejects(migrate(db, [a, m('0002_b.sql', `alter table thing add column x int; select 1/0;`)]), /division by zero/);
  assert.equal(await one(db, `select 1 from information_schema.columns where table_name = 'thing' and column_name = 'x'`), undefined);
  assert.deepEqual(await names(db), ['0001_a.sql']);
  assert.deepEqual((await migrate(db, [a, m('0002_b.sql', `alter table thing add column x int`)])).applied, ['0002_b.sql']);
}));

test('an applied file that was edited stops the server from starting', () => withDb(async (open) => {
  const db = await open();
  await migrate(db, [m('0001_a.sql', `create table thing (id int)`)]);
  await assert.rejects(migrate(db, [m('0001_a.sql', `create table thing (id bigint)`)]),
    (e: Error) => e instanceof MigrationError && /0001_a\.sql was changed after it was applied/.test(e.message));
}));

test('an older server can’t start on a database a newer one already upgraded', () => withDb(async (open) => {
  const db = await open();
  await migrate(db, [m('0001_a.sql', `select 1`), m('0002_b.sql', `select 2`)]);
  await assert.rejects(migrate(db, [m('0001_a.sql', `select 1`)]),
    (e: Error) => e instanceof MigrationError && /has migration 0002_b\.sql/.test(e.message));
}));

// Embedded Postgres runs one statement at a time anyway, so only a real server shows the lock doing its job.
test('two servers starting together apply each migration exactly once', { skip: process.env.FF_TEST_PG ? false : 'needs a real Postgres server (pnpm test:pg): embedded Postgres serializes everything, lock or not' }, () => withDb(async (open) => {
  const files = [m('0001_a.sql', `create table thing (id int)`), m('0002_b.sql', `insert into thing values (1)`), m('0003_c.sql', `insert into thing values (2)`)];
  const [a, b] = await Promise.all([open().then((db) => migrate(db, files)), open().then((db) => migrate(db, files))]);
  assert.deepEqual([...a.applied, ...b.applied].sort(), files.map((x) => x.name), 'each file once, between the two');
  assert.equal([a.fresh, b.fresh].filter(Boolean).length, 1, 'only one of them found it empty (and seeds it)');
  assert.deepEqual((await (await open()).query(`select id from thing order by id`)).rows, [{ id: 1 }, { id: 2 }]);
}));

test('a restart keeps every change and doesn’t fill the database again', async (t) => {
  const tdb = await testDatabase();
  const dir = tdb.url ? undefined : mkdtempSync(join(tmpdir(), 'ff-restart-'));
  const opts = { databaseUrl: tdb.url, dataDir: dir, setup: fixtures, signIn: { kind: 'test-header' as const } };
  // whatever happens below, every server started here is stopped and the data removed (a running worker would
  // keep the test process alive)
  const running = new Set<Awaited<ReturnType<typeof createApp>>>();
  const stop = async (a: Awaited<ReturnType<typeof createApp>>) => { running.delete(a); await a.workers.stop(); await a.db.close(); };
  t.after(async () => {
    for (const a of [...running]) await stop(a);
    if (dir) rmSync(dir, { recursive: true, force: true });
    await tdb.drop();
  });
  const start = async (o = {}) => { const a = await createApp({ ...opts, ...o }); running.add(a); return a; };

  const first = await start();
  const customers = (await first.db.query(`select key from entity`)).rows.length;
  const made = await first.app.request('/api/flags', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'alice', ...CSRF },
    body: JSON.stringify({ key: 'survives_restart', valueType: 'bool', kind: 'ops', delivery: {},
      variations: [{ key: 'on', value: true }, { key: 'off', value: false }], base: { enabled: false, defaultVariation: 'off', rules: [] } }) });
  assert.equal(made.status, 201, await made.text());
  await stop(first);

  const lines: string[] = [];
  const again = await start({ log: (l: string) => lines.push(l) });
  assert.ok(await one(again.db, `select 1 from flag where key = 'survives_restart'`), 'the flag is still there');
  assert.equal((await again.db.query(`select key from entity`)).rows.length, customers, 'setup ran once');
  assert.ok(!lines.some((l) => /applied/.test(l)), lines.join('\n'));
});

test('an embedded data folder opens in one server only; a lock left by a crash is taken over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-lock-'));
  try {
    const first = await connectDb({ dataDir: dir });
    await assert.rejects(connectDb({ dataDir: dir }), (e: Error) => e instanceof FolderInUseError && /another CompanyFlags server/.test(e.message));
    await first.close();
    assert.ok(!existsSync(`${dir}.lock`), 'closing releases it');
    const second = await connectDb({ dataDir: dir });
    await second.close();
    // a lock left by a process that has ended: a child that ran and exited (its pid is free again, not guessed)
    const ended = spawnSync(process.execPath, ['-e', '']).pid;
    assert.ok(ended);
    writeFileSync(`${dir}.lock`, `${ended}\n`);
    const third = await connectDb({ dataDir: dir });
    assert.ok(await one(third, `select 1 as ok`));
    await third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.lock`, { force: true });
  }
});

test('a stale lock is taken over: its PID is this process (PID 1 again in Docker), or now runs another program', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-lock-'));
  const others: ReturnType<typeof spawn>[] = [];
  try {
    // a hard stop skipped the release, and the next start has the same PID: in Docker, the server is always PID 1
    writeFileSync(`${dir}.lock`, `${process.pid}\nnode server/index.ts\n`);
    const own = await connectDb({ dataDir: dir });
    assert.ok(await one(own, `select 1 as ok`));
    await assert.rejects(connectDb({ dataDir: dir }), FolderInUseError, 'once this process has it, a second open is refused');
    await own.close();
    // the same, as a lock is written now: this host's name and boot, this PID, seen a moment ago (the container
    // restarted at once): still this host's, so decided by its process
    writeFileSync(`${dir}.lock`, lockText({ pid: process.pid, seen: new Date().toISOString() }));
    const restarted = await connectDb({ dataDir: dir });
    await restarted.close();

    // the PID runs, but another program now (the PID was reused after a crash)
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    others.push(other);
    writeFileSync(`${dir}.lock`, `${other.pid}\nnode server/index.ts\n`);
    const reused = await connectDb({ dataDir: dir });
    await reused.close();
  } finally {
    for (const p of others) p.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.lock`, { force: true });
  }
});

test('another server process holds the lock until it ends; after a hard stop (SIGKILL) the next start takes it over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-lock-'));
  const db = new URL('../server/db.ts', import.meta.url).href;
  const server = spawn(process.execPath, ['--input-type=module', '-e',
    `const { lockFolder } = await import(${JSON.stringify(db)}); lockFolder(${JSON.stringify(dir)}); console.log('locked'); setTimeout(() => {}, 60_000);`],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((done, fail) => {
      server.stdout!.on('data', (d) => { if (String(d).includes('locked')) done(); });
      server.on('exit', (code) => fail(new Error(`the other process ended (${code})`)));
    });
    await assert.rejects(connectDb({ dataDir: dir }), (e: Error) => e instanceof FolderInUseError && new RegExp(`process ${server.pid}`).test(e.message));
    const ended = new Promise((done) => server.on('exit', done));
    server.kill('SIGKILL');
    await ended;
    assert.ok(existsSync(`${dir}.lock`), 'a hard stop leaves the lock behind');
    const next = await connectDb({ dataDir: dir });
    assert.ok(await one(next, `select 1 as ok`));
    await next.close();
  } finally {
    server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.lock`, { force: true });
  }
});

test('the embedded database is for one container: a lock another container still writes is refused, one it stopped writing is taken over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-lock-'));
  try {
    // another container on the shared volume: PID 1 there too, which means nothing here. Its time is fresh: in use.
    writeFileSync(`${dir}.lock`, lockText({ pid: process.pid, host: 'web-7f9c2', boot: 'another-machine', seen: new Date(Date.now() - 4000).toISOString() }));
    await assert.rejects(connectDb({ dataDir: dir }), (e: Error) => e instanceof FolderInUseError
      && /open in another container \(web-7f9c2, seen 4 s ago\)/.test(e.message) && /for one container only; use Postgres for several/.test(e.message));
    // the same host name on another machine (a VM's own boot): another host as well
    writeFileSync(`${dir}.lock`, lockText({ boot: 'another-machine' }));
    if (thisHost().boot) await assert.rejects(connectDb({ dataDir: dir }), /another container/);
    // its holder stopped writing (a hard stop, a host that went away): taken over
    writeFileSync(`${dir}.lock`, lockText({ host: 'web-7f9c2', seen: new Date(Date.now() - STALE_MS - 1000).toISOString() }));
    const next = await connectDb({ dataDir: dir });
    assert.ok(await one(next, `select 1 as ok`));
    const lock = JSON.parse(readFileSync(`${dir}.lock`, 'utf8'));
    assert.deepEqual([lock.pid, lock.host, lock.boot], [process.pid, thisHost().host, thisHost().boot], 'it names this host and process now');
    await next.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.lock`, { force: true });
  }
});

test('the holder writes its time into the lock while it is open, and stops once another server took the lock over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-lock-'));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const release = lockFolder(dir, { heartbeatMs: 20 });
    const first = JSON.parse(readFileSync(`${dir}.lock`, 'utf8'));
    await wait(80);
    const later = JSON.parse(readFileSync(`${dir}.lock`, 'utf8'));
    assert.equal(later.instance, first.instance);
    assert.ok(Date.parse(later.seen) > Date.parse(first.seen), 'seen again');
    // another server took it over (this one stalled for longer than STALE_MS): it is theirs, never written over
    const theirs = lockText({ host: 'web-7f9c2' });
    writeFileSync(`${dir}.lock`, theirs);
    await wait(80);
    assert.equal(readFileSync(`${dir}.lock`, 'utf8'), theirs);
    release();
    assert.equal(readFileSync(`${dir}.lock`, 'utf8'), theirs, 'and the release leaves their lock in place');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.lock`, { force: true });
  }
});
