// What an operator sees and runs: the version, /readyz with publish lag (naming an environment whose snapshot can't be built),
// the metrics plugin, the publish log's retention, a server that doesn't migrate, the embedded database's version,
// backups and the move to Postgres, secrets sealed at rest, and the config's settings for all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { boot, builtIns, CSRF, testDatabase } from './helpers.ts';
import { connectDb, EMBEDDED_PG_MAJOR, FolderInUseError, FolderVersionError, one, type Db } from '../server/db.ts';
import { checkSchema, checksum, migrate, MigrationError, readMigrations, type Migration } from '../server/migrate.ts';
import { metrics } from '../server/plugins/metrics.ts';
import { startWorkers } from '../server/workers.ts';
import { VERSION } from '../server/packageFolder.ts';
import { BackupError, copyDatabase, copyDataDir, dumpPostgres, isEmpty } from '../server/backup.ts';
import { isSealed, sealer, SealError, sealStoredSecrets } from '../server/sealed.ts';
import { resolveConfig } from '../server/configFile.ts';
import { ConfigError } from '../server/config.ts';
import { main } from '../server/cli.ts';

const SERVER = new URL('../server/', import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), 'cf-ops-'));

test('the version: /healthz, /readyz and /api/meta say it', async () => {
  const t = await boot();
  try {
    assert.deepEqual(await (await t.app.request('/healthz')).json(), { ok: true, version: VERSION });
    const ready = await (await t.app.request('/readyz')).json() as any;
    assert.equal(ready.version, VERSION);
    assert.equal((await t.as('alice').get('/meta')).json.version, VERSION);
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
  } finally { await t.stop(); }
});

test('/readyz: ready while this server can serve; an environment whose snapshot can’t be built is in `failing`, and the log says why', async () => {
  const logs: string[] = [];
  const t = await boot({ log: (m) => logs.push(m) });
  try {
    const ok = await t.app.request('/readyz');
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.deepEqual(body.failing, []);
    assert.deepEqual(Object.keys(body.environments).sort(), ['dev', 'prod']);
    assert.deepEqual(Object.keys(body.environments.dev).sort(), ['failing', 'lagSeconds', 'purgeFailing', 'revision', 'serving']);
    assert.deepEqual(body.warnings, [], 'nothing to warn of');
    assert.equal(body.environments.dev.failing, false);

    // one environment's publish fails: it keeps serving the old values, and so does every instance, so they stay ready
    const refresh = t.plane.refresh.bind(t.plane);
    t.plane.refresh = async () => { throw new Error('the snapshot broke'); };
    try {
      await t.editBase('max_upload_mb', 'dev', (l) => ({ ...l, enabled: !l.enabled }));
      await t.settle();
      assert.ok(logs.some((l) => /publishing dev@\d+ failed .*the snapshot broke/.test(l)), logs.join('\n'));
      const failing = await t.app.request('/readyz');
      assert.equal(failing.status, 200, 'still ready: it serves dev’s old values and prod as it is');
      const said = await failing.json() as any;
      assert.deepEqual([said.ok, said.failing, said.environments.dev.failing, said.environments.prod.failing], [true, ['dev'], true, false]);
      assert.ok(said.environments.dev.serving < said.environments.dev.revision, 'dev serves the revision before');
      assert.doesNotMatch(JSON.stringify(said), /the snapshot broke/, 'the reason is in the log, not in a public answer');
    } finally {
      t.plane.refresh = refresh;
    }
    await t.db.query(`update publish_queue set claimed_until = null where published_at is null`);
    await t.settle();
    const again = await (await t.app.request('/readyz')).json() as any;
    assert.deepEqual(again.failing, [], 'once it builds again');

    // this server can't serve: it has no environment's snapshot loaded
    const snapshots = new Map(t.plane.snapshots);
    t.plane.snapshots.clear();
    try {
      const none = await t.app.request('/readyz');
      assert.equal(none.status, 503);
      assert.equal((await none.json() as any).code, 'unavailable');
    } finally {
      for (const [k, v] of snapshots) t.plane.snapshots.set(k, v);
    }
    assert.equal((await t.app.request('/readyz')).status, 200);
  } finally { await t.stop(); }
});

test('the metrics plugin: requests by route, flag reads, publish lag and open streams, in Prometheus’s text format', async () => {
  const t = await boot({ plugins: [...builtIns(), metrics({ token: 'scrape-me-please' })] });
  try {
    await t.as('alice').get('/flags?environment=dev');
    await t.cdnFile('dev', 'web', null);
    const stream = await t.app.request('/api/events', { headers: { 'x-user': 'alice' } });
    assert.equal(stream.status, 200);
    const scrape = async () => {
      const r = await t.app.request('/metrics', { headers: { authorization: 'Bearer scrape-me-please' } });
      assert.equal(r.status, 200);
      assert.match(String(r.headers.get('content-type')), /text\/plain; version=0\.0\.4/);
      return r.text();
    };
    let text = await scrape();
    assert.match(text, /companyflags_http_requests_total\{method="GET",route="\/api\/flags",status="200"\} 1/);
    assert.match(text, /companyflags_flag_requests_total\{protocol="cdn",status="200"\} 1/);
    assert.match(text, /companyflags_http_request_duration_seconds_count\{route="\/api\/flags"\} 1/);
    assert.match(text, /companyflags_publish_lag_seconds\{environment="dev"\} 0/);
    assert.match(text, /companyflags_publish_failing\{environment="prod"\} 0/);
    assert.match(text, new RegExp(`companyflags_info\\{version="${VERSION.replace(/\./g, '\\.')}"\\} 1`));
    assert.match(text, /companyflags_event_streams\{route="\/api\/events"\} 1/);
    await stream.body!.cancel();
    text = await scrape();
    assert.match(text, /companyflags_event_streams\{route="\/api\/events"\} 0/);
    assert.equal((await t.app.request('/metrics')).status, 401, 'a token is set: a scraper sends it');
    assert.equal((await t.app.request('/metrics', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  } finally { await t.stop(); }
});

test('a plugin’s routes stay under its prefixes, and nobody claims the core’s', async () => {
  const { definePlugin, pluginRoutes, PluginError } = await import('../server/plugin.ts');
  const { ofrep } = await import('../server/plugins/ofrep.ts');
  const withRoute = (path: string, prefixes?: string[]) => definePlugin({ id: 'stray', setup: () => {
    const routes = pluginRoutes();
    routes.get(path, (c) => c.text('mine'));
    return { routes, prefixes };
  } });
  const refused: [ReturnType<typeof definePlugin>, RegExp][] = [
    [withRoute('/', ['/stray']), /the route GET \/ isn’t under its prefixes/],
    [withRoute('/elsewhere/x', ['/stray']), /GET \/elsewhere\/x/],
    [withRoute('/stray/x'), /add prefixes/],
    [withRoute('*', ['/stray']), /isn’t under/],
    [withRoute('/oauth/token', ['/oauth']), /taken by the core \(\/oauth\)/],
    [withRoute('/.well-known/x', ['/.well-known']), /taken by the core/],
    [withRoute('/healthz', ['/healthz']), /taken by the core/],
    [withRoute('/sdk/v1/links/x', ['/sdk/v1/links']), /taken by the core/],
    [withRoute('/sdk/v1/flagd/x', ['/sdk/v1/flagd']), /taken by the plugin "flagd"/],
    [definePlugin({ id: 'odd', setup: () => ({ middleware: 'yes' as never }) }), /middleware is a function/],
  ];
  const { flagd } = await import('../server/plugins/flagd.ts');
  for (const [p, why] of refused) {
    await assert.rejects(boot({ plugins: [ofrep(), flagd(), p] }), (e: Error) => e instanceof PluginError && why.test(e.message), String(why));
  }
  const t = await boot({ plugins: [withRoute('/stray/v1/hello', ['/stray'])] });
  try { assert.equal(await (await t.app.request('/stray/v1/hello')).text(), 'mine'); } finally { await t.stop(); }
});

test('the publish log keeps each environment’s newest publish and drops the rest after the retention', async () => {
  const t = await boot();
  try {
    await t.db.query(`insert into publish_queue (environment_id, revision, created_at, published_at)
      select id, 1, now() - interval '40 days', now() - interval '40 days' from environment`);
    await t.db.query(`insert into publish_queue (environment_id, revision, created_at, published_at)
      select id, 1, now() - interval '3 days', now() - interval '3 days' from environment`);
    const before = Number((await one<{ n: string }>(t.db, `select count(*) as n from publish_queue`))!.n);
    const logs: string[] = [];
    const w = startWorkers(t.db, t.plane, t.hub, (m) => logs.push(m), undefined, { publishLogDays: 30, pruneEveryMs: 0 });
    await w.drain();
    await w.stop();
    const left = await t.db.query<{ old: boolean }>(`select published_at < now() - interval '30 days' as old from publish_queue`);
    assert.equal(left.rows.filter((r) => r.old).length, 0, 'nothing older than 30 days');
    assert.ok(left.rows.length < before && left.rows.length >= 2, 'the newer rows stay');
    assert.ok(logs.some((l) => /dropped \d+ publish log rows older than 30 days/.test(l)));
  } finally { await t.stop(); }
});

test('without migrating (--no-migrate): the schema must have this version’s migrations; a newer version’s are allowed', async () => {
  const m = (name: string, sql: string): Migration => ({ name, sql, checksum: checksum(sql) });
  const tdb = await testDatabase();
  const db = tdb.url ? await connectDb({ url: tdb.url }) : await connectDb();
  try {
    await assert.rejects(checkSchema(db, [m('0001_a.sql', 'create table a (id int)')]), (e: Error) => e instanceof MigrationError && /no schema yet/.test(e.message));
    await migrate(db, [m('0001_a.sql', 'create table a (id int)')]);
    await assert.rejects(checkSchema(db, [m('0001_a.sql', 'create table a (id int)'), m('0002_b.sql', 'create table b (id int)')]),
      (e: Error) => e instanceof MigrationError && /missing migrations \(0002_b.sql\)/.test(e.message));
    await migrate(db, [m('0001_a.sql', 'create table a (id int)'), m('0002_b.sql', 'create table b (id int)')]);
    assert.deepEqual(await checkSchema(db, [m('0001_a.sql', 'create table a (id int)')]), { newer: ['0002_b.sql'] }, 'the version before keeps running');
    await assert.rejects(checkSchema(db, [m('0001_a.sql', 'create table a (id int primary key)'), m('0002_b.sql', 'create table b (id int)')]),
      (e: Error) => e instanceof MigrationError && /changed after it was applied/.test(e.message));
  } finally { await db.close(); await tdb.drop(); }
  const empty = await testDatabase();
  try {
    const { createApp } = await import('../server/index.ts');
    await assert.rejects(createApp({ databaseUrl: empty.url, migrate: false, signIn: { kind: 'test-header' }, env: {} }), MigrationError);
  } finally { await empty.drop(); }
});

test('the config: migrate, the pool and the publish log’s retention, from the file or the environment', () => {
  const none = resolveConfig({}, {});
  assert.deepEqual([none.migrate, none.pool, none.publishLogDays], [true, 10, 30]);
  const env = resolveConfig({}, { FF_MIGRATE: 'off', FF_DB_POOL: '25', FF_PUBLISH_LOG_DAYS: '7' });
  assert.deepEqual([env.migrate, env.pool, env.publishLogDays], [false, 25, 7]);
  const file = resolveConfig({ database: { migrate: true, pool: 4 }, retention: { publishLogDays: 90 } }, { FF_MIGRATE: 'off' });
  assert.deepEqual([file.migrate, file.pool, file.publishLogDays], [true, 4, 90]);
  assert.throws(() => resolveConfig({}, { FF_MIGRATE: 'sometimes' }), ConfigError);
  assert.throws(() => resolveConfig({ database: { pool: 0 } }, {}), ConfigError);
  assert.throws(() => resolveConfig({ retention: { publishLogDays: 0 } }, {}), ConfigError);
});

test('the embedded database is the Postgres it says, and a folder made by another major version isn’t opened', async () => {
  const db = await connectDb();
  try {
    const v = (await one<{ v: string }>(db, `select current_setting('server_version') as v`))!.v;
    assert.equal(v.split('.')[0], EMBEDDED_PG_MAJOR, 'EMBEDDED_PG_MAJOR matches the pinned PGlite');
  } finally { await db.close(); }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.dependencies['@electric-sql/pglite'], /^\d+\.\d+\.\d+$/, 'PGlite is pinned to one version');
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'PG_VERSION'), '17\n');
    await assert.rejects(connectDb({ dataDir: join(dir, 'data') }), (e: Error) => e instanceof FolderVersionError && /made by Postgres 17/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backup of the embedded database: a copy of its folder, made only while no server has it open', async () => {
  const dir = tmp();
  try {
    const data = join(dir, 'data');
    const db = await connectDb({ dataDir: data });
    await migrate(db);
    await db.query(`insert into environment (key, name, link_secret) values ('dev', 'Development', 'x')`);
    assert.throws(() => copyDataDir(data, join(dir, 'busy')), FolderInUseError, 'the server has it open');
    await db.close();
    const lines: string[] = [];
    const code = await main(['backup', join(dir, 'copy')], { cwd: dir, env: { FF_DATA_DIR: data }, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join('\n'));
    assert.match(lines.join('\n'), /backed up the embedded database to .*copy/);
    const copy = await connectDb({ dataDir: join(dir, 'copy') });
    try { assert.equal((await one<{ key: string }>(copy, `select key from environment`))?.key, 'dev'); } finally { await copy.close(); }
    assert.equal(await main(['backup', join(dir, 'copy')], { cwd: dir, env: { FF_DATA_DIR: data }, out: () => {}, err: () => {} }), 1, 'never over another backup');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backup of a Postgres server: pg_dump into one file, with the password kept off its command line', async (c) => {
  assert.throws(() => dumpPostgres('postgres://u:p@localhost:1/x', join(tmpdir(), 'never.dump'), { pgDump: 'no-such-pg-dump-here' }),
    (e: Error) => e instanceof BackupError && /pg_dump isn’t installed here/.test(e.message));
  const which = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (!process.env.FF_TEST_PG || which.status !== 0) { c.skip('needs FF_TEST_PG and pg_dump'); return; }
  const t = await boot();
  const server = Number((await one<{ v: string }>(t.db, `select current_setting('server_version_num') as v`))!.v.slice(0, -4));
  const local = Number(/(\d+)\.\d+/.exec(which.stdout)?.[1] ?? 0);
  if (local < server) {
    await t.stop();
    c.skip(`pg_dump ${local} is older than the server (${server}): pg_dump refuses`);
    return;
  }
  const dir = tmp();
  try {
    const lines: string[] = [];
    // the test database's own address: what DATABASE_URL would be
    const url = (await one<{ d: string }>(t.db, `select current_database() as d`))!.d;
    const u = new URL(process.env.FF_TEST_PG);
    u.pathname = `/${url}`;
    const code = await main(['backup', join(dir, 'flags.dump')], { cwd: dir, env: { DATABASE_URL: u.toString() }, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(readFileSync(join(dir, 'flags.dump')).subarray(0, 5).toString() === 'PGDMP', 'a custom-format dump');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await t.stop();
  }
});

test('copying a database into a new one: every row, ids that go on after them, and nothing left half done', async () => {
  const t = await boot();
  const tdb = await testDatabase();
  const target: Db = tdb.url ? await connectDb({ url: tdb.url }) : await connectDb();
  try {
    assert.equal(await isEmpty(target), true);
    await migrate(target);
    const copied = await copyDatabase(t.db, target);
    const tables = (await t.db.query<{ name: string }>(`select tablename as name from pg_tables where schemaname = 'public' and tablename <> 'schema_migration'`)).rows;
    for (const { name } of tables) {
      const count = async (db: Db) => Number((await one<{ n: string }>(db, `select count(*) as n from "${name}"`))!.n);
      assert.equal(await count(target), await count(t.db), name);
      assert.equal(copied[name], await count(t.db), name);
    }
    const sample = `select key, name, parent_id is not null as has_parent from entity order by key`;
    assert.deepEqual((await target.query(sample)).rows, (await t.db.query(sample)).rows);
    const layers = `select f.key, l.enabled, l.version from flag_layer l join flag f on f.id = l.flag_id order by l.id`;
    assert.deepEqual((await target.query(layers)).rows, (await t.db.query(layers)).rows);
    // the next row gets the next id, after the copied ones
    const max = Number((await one<{ m: string }>(target, `select max(id) as m from change_history`))!.m);
    const next = await one<{ id: string }>(target, `insert into change_history (environment_id, changed_by, actor_type, change_type) select id, 'x', 'system', 'environment.update' from environment limit 1 returning id`);
    assert.ok(Number(next!.id) > max);
  } finally {
    await target.close();
    await tdb.drop();
    await t.stop();
  }
});

test('companyflags copy-to-postgres: from the embedded database into a new, empty Postgres database', { skip: !process.env.FF_TEST_PG && 'needs FF_TEST_PG' }, async () => {
  const dir = tmp();
  const tdb = await testDatabase();
  try {
    const data = join(dir, 'data');
    const db = await connectDb({ dataDir: data });
    await migrate(db);
    await db.query(`insert into environment (key, name, link_secret) values ('dev', 'Development', 'x')`);
    await db.close();
    const lines: string[] = [];
    const run = (args: string[]) => main(args, { cwd: dir, env: { FF_DATA_DIR: data }, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    assert.equal(await run(['copy-to-postgres', tdb.url!]), 0, lines.join('\n'));
    const pg = await connectDb({ url: tdb.url });
    try { assert.equal((await one<{ key: string }>(pg, `select key from environment`))?.key, 'dev'); } finally { await pg.close(); }
    assert.equal(await run(['copy-to-postgres', tdb.url!]), 1, 'never into a database with tables');
    assert.match(lines.join('\n'), /has tables already/);
  } finally {
    await tdb.drop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secrets kept for other systems are sealed: another secret can’t open them, and old plain rows are sealed at the start', async () => {
  const box = sealer('a server secret of at least 32 characters');
  const sealed = box.seal('cf-token-abcdefghijklmnopqrstuvwxyz');
  assert.ok(isSealed(sealed) && !sealed.includes('abcdefghijkl'));
  assert.equal(box.open(sealed), 'cf-token-abcdefghijklmnopqrstuvwxyz');
  assert.notEqual(box.seal('same'), box.seal('same'), 'a new nonce each time');
  assert.equal(box.open('plain-from-before'), 'plain-from-before');
  assert.throws(() => sealer('another secret entirely, also long enough').open(sealed), SealError);

  const t = await boot();
  try {
    await t.db.query(`insert into cdn_setting (id, zone_id, api_token, updated_by) values (true, $1, $2, 'dana')`, ['0'.repeat(32), 'cf-plain-token-0123456789abcdef']);
    await t.db.query(`insert into webhook (name, url, headers, events, secret, cursor, created_by) values ('CI', 'https://ci.example.com', $1, '{changes}', 'whsec_plain', 0, 'dana')`,
      [JSON.stringify({ Authorization: 'Bearer old-system' })]);
    assert.equal(await sealStoredSecrets(t.db, box), 2);
    assert.equal(await sealStoredSecrets(t.db, box), 0, 'once');
    const cdn = (await one<{ t: string }>(t.db, `select api_token as t from cdn_setting`))!.t;
    const hook = (await one<{ secret: string; headers: Record<string, string> }>(t.db, `select secret, headers from webhook where name = 'CI'`))!;
    assert.deepEqual([isSealed(cdn), isSealed(hook.secret), isSealed(hook.headers.Authorization)], [true, true, true]);
    assert.equal(box.open(hook.headers.Authorization), 'Bearer old-system');
    assert.equal(box.open(cdn), 'cf-plain-token-0123456789abcdef');
  } finally { await t.stop(); }
});

test('a webhook made in the console is stored sealed, and the console still never sees its secret or headers', async () => {
  const t = await boot();
  try {
    const r = await t.as('dana').post('/webhooks', { name: 'CI', url: 'https://ci.example.com/hook', headers: { Authorization: 'Bearer s3cret-value' }, events: ['changes'] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const row = (await one<{ secret: string; headers: Record<string, string> }>(t.db, `select secret, headers from webhook where name = 'CI'`))!;
    assert.ok(isSealed(row.secret) && isSealed(row.headers.Authorization));
    assert.ok(!JSON.stringify(row).includes('s3cret-value') && !JSON.stringify(row).includes(r.json.secret));
    assert.deepEqual((await t.as('dana').get('/webhooks')).json.webhooks[0].headerNames, ['Authorization']);
  } finally { await t.stop(); }
});

test('companyflags version, and start: the version on its first line, and the port it listens on in FF_PORT_FILE', async () => {
  const lines: string[] = [];
  assert.equal(await main(['--version'], { out: (l) => lines.push(l) }), 0);
  assert.deepEqual(lines, [`companyflags ${VERSION}`]);
  const dir = tmp();
  const portFile = join(dir, 'port');
  const child = spawn(process.execPath, [join(SERVER, 'cli.ts'), 'start', '--no-migrate'], {
    cwd: dir, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', FF_DATA_DIR: join(dir, 'data'), FF_PORT_FILE: portFile, FF_CONFIG: '', NODE_ENV: 'development' },
  });
  let said = '';
  child.stdout.on('data', (d) => { said += d; });
  child.stderr.on('data', (d) => { said += d; });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  try {
    // --no-migrate on a new database: it stops, and says to migrate first
    assert.equal(await exited, 1);
    assert.match(said, new RegExp(`CompanyFlags ${VERSION.replace(/\./g, '\\.')}`));
    assert.match(said, /run companyflags migrate first/);
    const again = spawn(process.execPath, [join(SERVER, 'cli.ts'), 'start'], {
      cwd: dir, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', FF_DATA_DIR: join(dir, 'data'), FF_PORT_FILE: portFile, FF_CONFIG: '', NODE_ENV: 'development' },
    });
    try {
      for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
      const port = Number(readFileSync(portFile, 'utf8'));
      assert.ok(port > 0);
      const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
      assert.deepEqual(health, { ok: true, version: VERSION });
    } finally {
      again.kill('SIGTERM');
      await new Promise((r) => again.on('exit', r));
    }
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the migration files: numbered 0001 up, with no number used twice and none skipped', () => {
  const names = readMigrations().map((m) => m.name);
  const numbers = names.map((n) => Number(n.slice(0, 4)));
  assert.equal(new Set(numbers).size, numbers.length, `a number is used twice: ${names.join(', ')}`);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), 'numbered 0001, 0002, … with none skipped');
});

test('server/schema.sql is the schema the migrations make (pnpm schema writes it)', async () => {
  const { currentSchema, SCHEMA_FILE } = await import('../server/schemaFile.ts');
  const db = await connectDb();
  try {
    await migrate(db);
    assert.equal(readFileSync(SCHEMA_FILE, 'utf8'), await currentSchema(db), 'run pnpm schema and commit server/schema.sql');
  } finally { await db.close(); }
});

void CSRF;
