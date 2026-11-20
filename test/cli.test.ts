// The companyflags command (server/cli.ts): help, init, secret, migrate, and flags as code (server/flagsAsCode.ts)
// pull, plan and push, on the database the config names. A push goes through the console's own functions: where
// changes need approval it makes a request, and a file with problems changes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../server/cli.ts';
import { createApp } from '../server/index.ts';
import { sampleInstallation } from './sample.ts';
import { testDatabase } from './helpers.ts';
import { readFlags } from '../server/flagsAsCode.ts';

/** Runs the command and returns its exit code and what it printed. */
async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  let text = '';
  const print = (line: string) => { text += `${line}\n`; };
  const code = await main(args, { cwd, env, out: print, err: print });
  return { code, text };
}

test('help, secret and init', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match((await run(['help'], dir, {})).text, /companyflags flags push/);
  const secret = (await run(['secret'], dir, {})).text.trim();
  assert.ok(secret.length >= 32 && /^[A-Za-z0-9_-]+$/.test(secret), secret);
  assert.notEqual((await run(['secret'], dir, {})).text.trim(), secret);
  assert.equal((await run(['init'], dir, {})).code, 0);
  assert.match(readFileSync(join(dir, 'companyflags.config.ts'), 'utf8'), /defineConfig\(\{[\s\S]*ofrep\(\)/);
  const again = await run(['init'], dir, {});
  assert.deepEqual([again.code, /already here/.test(again.text)], [1, true]);
  assert.equal((await run(['init', '--force'], dir, {})).code, 0);
  const unknown = await run(['deploy'], dir, {});
  assert.deepEqual([unknown.code, /unknown command "deploy"/.test(unknown.text)], [1, true]);
});

test('migrate: --check lists what’s pending, then migrate applies it', async (t) => {
  const tdb = await testDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'ff-cli-'));
  t.after(async () => { rmSync(dir, { recursive: true, force: true }); await tdb.drop(); });
  const env = tdb.url ? { DATABASE_URL: tdb.url } : { FF_DATA_DIR: join(dir, 'data') };
  const before = await run(['migrate', '--check'], dir, env);
  assert.equal(before.code, 1, before.text);
  assert.match(before.text, /pending: 0001_init/);
  const applied = await run(['migrate'], dir, env);
  assert.deepEqual([applied.code, /applied: 0001_init.*0013_dimensions/.test(applied.text)], [0, true], applied.text);
  assert.deepEqual(await run(['migrate', '--check'], dir, env), { code: 0, text: 'the database is up to date\n' });
  // flags need the current schema: on an empty folder they say to migrate first
  const other = mkdtempSync(join(tmpdir(), 'ff-cli-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  if (!tdb.url) assert.match((await run(['flags', 'pull'], other, { FF_DATA_DIR: join(other, 'data') })).text, /run companyflags migrate first/);
});

test('flags as code: pull writes the flags; plan and push make CompanyFlags match the file', async (t) => {
  const tdb = await testDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'ff-cli-'));
  t.after(async () => { rmSync(dir, { recursive: true, force: true }); await tdb.drop(); });
  const dataDir = join(dir, 'data');
  // the test data, made the way a server makes it, then the server stops (embedded Postgres: one process at a time)
  const app = await createApp({ databaseUrl: tdb.url, dataDir: tdb.url ? undefined : dataDir, setup: sampleInstallation, signIn: { kind: 'test-header' } });
  await app.workers.stop();
  await app.db.close();
  const env = tdb.url ? { DATABASE_URL: tdb.url } : { FF_DATA_DIR: dataDir };

  const pulled = await run(['flags', 'pull'], dir, env);
  assert.equal(pulled.code, 0, pulled.text);
  const file = JSON.parse(readFileSync(join(dir, 'flags.json'), 'utf8'));
  assert.deepEqual(file.flags.new_checkout.flagSets, { dev: ['web', 'ios', 'android'], prod: ['web', 'ios', 'android'] });
  assert.equal(file.flags.new_checkout.type, 'bool');
  assert.equal(file.flags.new_checkout.variants, undefined, 'on/off is left out');
  assert.deepEqual(await run(['flags', 'plan'], dir, env), { code: 0, text: `= ${Object.keys(file.flags).length} unchanged\nnothing to change\n` },
    'a file just pulled matches');

  // a new flag, a new description, and a flag set taken out in production (which needs approval there)
  file.flags.dark_mode = { name: 'Dark mode', kind: 'ops', type: 'bool', tags: ['ui'], flagSets: { dev: ['web'], prod: ['web'] } };
  file.flags.new_checkout.description = 'The one-page checkout';
  file.flags.new_checkout.flagSets.prod = ['web', 'ios'];
  writeFileSync(join(dir, 'flags.json'), JSON.stringify(file));
  const plan = await run(['flags', 'plan'], dir, env);
  assert.equal(plan.code, 0, plan.text);
  assert.match(plan.text, /^\+ create dark_mode \(ops, bool\)$/m);
  assert.match(plan.text, /^~ change new_checkout: description$/m);
  assert.match(plan.text, /^~ flag sets of new_checkout in prod: web, ios, android → web, ios \(a request: it needs approval there\)$/m);
  const pushed = await run(['flags', 'push', '--as', 'ci@acme.test'], dir, env);
  assert.equal(pushed.code, 0, pushed.text);
  assert.match(pushed.text, /^✓ create dark_mode/m);
  assert.match(pushed.text, /^→ request #\d+: flag sets of new_checkout in prod/m);

  // what's there now: the new flag and description at once; production waits for its request
  const after = await run(['flags', 'plan'], dir, env);
  assert.equal(after.text.split('\n').filter((l) => /^[+~]/.test(l)).length, 1, after.text);
  assert.match(after.text, /^~ flag sets of new_checkout in prod/m);

  // a file with problems changes nothing
  file.flags.broken = { kind: 'feature', type: 'bool', flagSets: { dev: ['tv'], staging: [] } };
  file.flags.dark_mode.type = 'string';
  writeFileSync(join(dir, 'flags.json'), JSON.stringify(file));
  const bad = await run(['flags', 'push'], dir, env);
  assert.equal(bad.code, 1);
  for (const p of [/! broken: kind is one of/, /! broken: no flag set "tv"/, /! broken: no environment "staging"/, /! dark_mode: its type is bool here/]) assert.match(bad.text, p);

  const store = await createApp({ databaseUrl: tdb.url, dataDir: tdb.url ? undefined : dataDir, signIn: { kind: 'test-header' } });
  try {
    const flags = new Map((await readFlags(store.db)).map((f) => [f.key, f]));
    assert.equal(flags.get('new_checkout')!.description, 'The one-page checkout');
    assert.deepEqual(flags.get('dark_mode')!.flagSets, { dev: ['web'], prod: ['web'] });
    assert.ok(!flags.has('broken'));
    const who = await store.db.query<{ actor: string }>(`select changed_by as actor from change_history where change_type = 'flag.create' and flag = 'dark_mode' limit 1`);
    assert.equal(who.rows[0]?.actor, 'ci@acme.test', 'the history says who pushed');
  } finally {
    await store.workers.stop();
    await store.db.close();
  }
  assert.ok(existsSync(join(dir, 'flags.json')));
});
