// The database is never reset: the schema only moves forward through migrations (server/migrate.ts), and a
// restart keeps everything. Runs on the in-memory database, or on a real Postgres with pnpm test:pg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDb, FolderInUseError, one, type Db } from '../server/db.ts';
import { checksum, migrate, MigrationError, readMigrations, type Migration } from '../server/migrate.ts';
import { createApp } from '../server/index.ts';
import { CSRF, testDatabase } from './helpers.ts';
import { syncFields } from '../server/fields.ts';
import { fixtures } from './fixtures.ts';
import { readFileSync } from 'node:fs';
import { seedBeforeDimensions, CHANGE_SET_RULE, CUSTOMERS, DIMENSION_OF, KEYS } from './before-dimensions.ts';

const m = (name: string, sql: string): Migration => ({ name, sql, checksum: checksum(sql) });
const SHIPPED = readMigrations();

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

test('0009 moves every % of devices on a database from before it to hash version 2 (flagd’s)', () => withDb(async (open) => {
  const db = await open();
  await migrate(db);
  await syncFields(db);                                 // as the server does on start, before its setup
  await fixtures(db);
  // the database as 0008 left it: % rules with version 1, which was then the only one allowed
  await db.exec(`alter table flag_rule drop constraint flag_rule_hash_version_check;
    update flag_rule set split_hash_version = 1 where split_by is not null;
    set constraints all immediate;
    alter table flag_rule add constraint flag_rule_hash_version_check check (split_hash_version is null or split_hash_version = 1);
    delete from schema_migration where name = '0009_flagd_hash.sql';`);
  const versions = async () => (await db.query<{ v: number; n: number }>(`select split_hash_version as v, count(*)::int as n from flag_rule where split_by is not null group by 1`)).rows;
  assert.deepEqual((await versions()).map((r) => r.v), [1]);
  const rules = (await versions())[0].n;
  assert.deepEqual((await migrate(db)).applied, ['0009_flagd_hash.sql']);
  assert.deepEqual(await versions(), [{ v: 2, n: rules }], 'every % rule, and nothing else');
  await assert.rejects(db.query(`update flag_rule set split_hash_version = 1 where split_by is not null`), /flag_rule_hash_version_check/);
}));

test('0011 lets a version release go without a remove-by date; an on/off release still needs one', () => withDb(async (open) => {
  const db = await open();
  await migrate(db);
  await syncFields(db);
  await fixtures(db);
  // the database as 0010 left it: every release needs a remove-by date
  await db.exec(`alter table flag drop constraint flag_remove_by_check;
    alter table flag add constraint flag_check check (kind not in ('release','experiment') or remove_by is not null);
    delete from schema_migration where name = '0011_version_releases.sql';`);
  await assert.rejects(db.query(`insert into flag (key, value_type, kind) values ('web_bundle', 'string', 'release')`), /flag_check/);
  assert.deepEqual((await migrate(db)).applied, ['0011_version_releases.sql']);
  await db.query(`insert into flag (key, value_type, kind) values ('web_bundle', 'string', 'release')`);
  await assert.rejects(db.query(`insert into flag (key, value_type, kind) values ('new_thing', 'bool', 'release')`), /flag_remove_by_check/);
  await assert.rejects(db.query(`insert into flag (key, value_type, kind) values ('an_experiment', 'string', 'experiment')`), /flag_remove_by_check/);
  const releases = await one<{ n: number }>(db, `select count(*)::int as n from flag where kind = 'release' and remove_by is not null`);
  assert.ok(releases!.n >= 3, 'the releases already there keep their dates');
}));

test('0013: customers become company › brand, and every file, flagd JSON, link and key is what it was', async (t) => {
  const golden = JSON.parse(readFileSync(new URL('./before-dimensions.json', import.meta.url), 'utf8'));
  const tdb = await testDatabase();
  const dir = tdb.url ? undefined : mkdtempSync(join(tmpdir(), 'ff-0013-'));
  t.after(async () => { if (dir) rmSync(dir, { recursive: true, force: true }); await tdb.drop(); });
  // the database as 0012 left it, with the data of before dimensions
  const old = await connectDb(tdb.url ? { url: tdb.url } : { dataDir: dir });
  await migrate(old, SHIPPED.filter((x) => x.name < '0013'));
  assert.deepEqual(await names(old), golden.migrations, 'the same migrations the files were made on');
  await syncFields(old);
  const { changeSet } = await seedBeforeDimensions(old);
  await old.close();
  // the server starts on it, and applies 0013
  const lines: string[] = [];
  const app = await createApp({ databaseUrl: tdb.url, dataDir: dir, signIn: { kind: 'test-header' }, log: (l) => lines.push(l) });
  t.after(async () => { await app.workers.stop(); await app.db.close(); });
  assert.ok(lines.some((l) => /0013_dimensions/.test(l)), lines.join('\n'));
  const call = async (method: string, path: string, o: { as?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const r = await app.app.request(path, { method, headers: { 'content-type': 'application/json', ...(o.as ? { 'x-user': o.as } : {}), ...(method === 'GET' ? {} : CSRF), ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null, headers: r.headers };
  };

  // the dimensions, and every customer of then in its place
  assert.deepEqual((await call('GET', '/api/dimensions', { as: 'alice' })).json, [
    { key: 'company', singular: 'company', plural: 'companies', entities: 3, withParent: 0 },
    { key: 'brand', singular: 'brand', plural: 'brands', entities: 2, withParent: 2 },
  ]);
  for (const c of CUSTOMERS) assert.equal((await call('GET', `/api/dimensions/${DIMENSION_OF[c]}/${c}`, { as: 'alice' })).status, 200, c);
  assert.equal((await call('GET', '/api/dimensions/brand/velvet', { as: 'alice' })).json.parent, 'tyrell');
  // live rules use today's names; the old names stay as attributes for what still has them
  const rules = (await app.db.query<{ c: string; by: string | null }>(`select conditions::text as c, split_by as by from flag_rule`)).rows;
  assert.ok(rules.every((r) => !r.c.includes('customer.') && !r.by?.startsWith('customer.')), JSON.stringify(rules));
  assert.deepEqual(rules.map((r) => r.by).filter(Boolean).sort(), ['company', 'device.id', 'entity']);
  assert.ok(await one(app.db, `select 1 from condition_field where name = 'customer.id'`));

  // every app file: the same link (same secret), the same values, the same ETag
  for (const c of CUSTOMERS) {
    const link = (await call('GET', `/api/dimensions/${DIMENSION_OF[c]}/${c}/link?environment=prod`, { as: 'dana' })).json.path.replace(':service', 'web');
    assert.equal(link, golden.links[c], `${c}’s link`);
    const file = await call('GET', link);
    assert.equal(file.status, 200, c);
    assert.deepEqual([file.json.flags, file.json.revision], [golden.files[c].flags, golden.files[c].revision], `${c}’s file`);
    assert.equal(file.headers.get('etag'), golden.files[c].etag, `${c}’s ETag`);
  }
  const anon = await call('GET', '/client/v1/flags/prod/web');
  assert.deepEqual([anon.json.flags, anon.headers.get('etag')], [golden.files[''].flags, golden.files[''].etag], 'before login');

  // flagd JSON: Velvet's own key (now scope entity) and the shared one (now all), by path and by the old header
  const flagd = (key: string, path = '', headers: Record<string, string> = {}) => call('GET', `/sdk/v1/flagd${path}`, { headers: { authorization: `Bearer ${key}`, ...headers } });
  // the same flags and ETags; only flagSetId differs, as it names the service since 0.1.0 (<env>/<service>/<entity>)
  const now = (c: string) => { const d = golden.flagd[c].doc; return { ...d, metadata: { ...d.metadata, flagSetId: `prod/backend/${c}` } }; };
  const own = await flagd(KEYS.velvet);
  assert.deepEqual([own.status, own.json, own.headers.get('etag')], [200, now('velvet'), golden.flagd.velvet.etag]);
  for (const c of CUSTOMERS) {
    assert.deepEqual((await flagd(KEYS.shared, `/${DIMENSION_OF[c]}/${c}`)).json, now(c), `${c} by path`);
    const legacy = await flagd(KEYS.shared, '', { 'x-customer-id': c });
    assert.deepEqual([legacy.json, legacy.headers.get('etag')], [now(c), golden.flagd[c].etag], `${c} by X-Customer-Id`);
  }
  assert.deepEqual((await app.db.query(`select scope from api_key order by id`)).rows.map((r: any) => r.scope), ['entity', 'all']);

  // History from before reads: the old kinds, the entity column, and what a restore leaves alone, in words
  const onyx = (await call('GET', '/api/history?entity=onyx', { as: 'alice' })).json;
  assert.deepEqual(onyx.map((h: any) => [h.changeType, h.entity]), [['customer.update', 'onyx']]);
  const preview = (await call('GET', '/api/environments/prod/versions/0/restore-preview', { as: 'alice' })).json;
  assert.deepEqual(preview.notRolledBack.map((x: any) => x.text), ['Added Velvet under Tyrell', 'Onyx moved out of Tyrell']);

  // the change set in review still applies: its rule on customer.id means what it meant
  const cs = (await call('GET', `/api/change-sets/${changeSet}`, { as: 'alice' })).json;
  assert.deepEqual([cs.items[0].entity, cs.items[0].proposed.rules[0].conditions[0].field], [null, 'customer.id']);
  assert.equal((await call('POST', `/api/change-sets/${changeSet}/review`, { as: 'bob', body: { decision: 'approve' } })).status, 200);
  const applied = await call('POST', `/api/change-sets/${changeSet}/apply`, { as: 'alice' });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  await app.workers.drain();
  const solo = await call('GET', golden.links.solo);
  assert.deepEqual(solo.json.flags.f, { value: 'D' }, 'Solo first, by its rule from before');
  assert.ok((await app.db.query(`select 1 from flag_rule where rule_key = $1 and conditions::text like '%customer.id%'`, [CHANGE_SET_RULE])).rows.length, 'kept as it was written');
  assert.deepEqual((await call('GET', '/client/v1/flags/prod/web')).json.flags.f, { value: 'A' }, 'and only Solo: nobody else is named');
});

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
