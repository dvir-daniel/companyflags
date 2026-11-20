// Plugins (server/plugin.ts, server/plugins/) and companyflags.config.ts (server/config.ts, server/configFile.ts): an
// installation runs the plugins it lists, and only those; a plugin of its own can serve routes, console routes, ask
// the evaluator and run after a publish, and never takes the core's addresses; the config file wins over the
// environment, which wins over the defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { boot } from './helpers.ts';
import {
  appFiles, cloudflare, consoleRoutes, defaultPlugins, definePlugin, flagd, HttpError, ofrep, PluginError, type PluginContext,
} from '../server/plugins/index.ts';
import { ConfigError, defineConfig, type Config } from '../server/config.ts';
import { loadConfig, resolveConfig } from '../server/configFile.ts';

const ids = (plugins: { id: string }[]) => plugins.map((p) => p.id);

test('without a list, every built-in plugin runs, and the console is told which', async () => {
  const t = await boot();
  try {
    assert.deepEqual((await t.as('alice').get('/meta')).json.plugins, ['ofrep', 'flagd', 'app-files', 'cloudflare', 'webhooks']);
    assert.equal((await t.as('alice').get('/cdn')).status, 200, 'the Cloudflare plugin’s console routes');
  } finally { await t.stop(); }
});

test('only the listed plugins run: the others’ addresses are a JSON 404, and links leave out the app file', async () => {
  const t = await boot({ plugins: [ofrep()] });
  try {
    assert.deepEqual((await t.as('alice').get('/meta')).json.plugins, ['ofrep']);
    for (const path of ['/client/v1/flags/dev/web', '/sdk/v1/flagd/company/acme']) {
      const r = await t.call('GET', path);
      assert.equal(r.status, 404, path);
      assert.match(r.json.error, /^no such endpoint/, path);
    }
    assert.equal((await t.as('alice').get('/cdn')).status, 404, 'no Cloudflare settings without the plugin');
    assert.equal((await t.as('alice').get('/webhooks')).status, 404, 'no webhooks without the plugin');
    const hook = await t.call('POST', '/hooks/v1/ffh_1_aaaaaaaaaaaaaaaaaaaaaaaa', {});
    assert.equal(hook.status, 404, 'a webhook in’s address is a JSON 404 too');
    assert.match(hook.json.error, /^no such endpoint/);
    // OFREP still answers: an app token from the link endpoint, which has no file path now
    const key = (await t.as('dana').post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'all' })).json.key;
    const link = await t.call('GET', '/sdk/v1/links/company/acme?service=web', undefined, { authorization: `Bearer ${key}` });
    assert.equal(link.status, 200, JSON.stringify(link.json));
    assert.equal(link.json.path, undefined, 'no app files: no path');
    assert.match(link.json.token, /^ffl_dev\.web\./);
    const ofrepAnswer = await t.call('POST', '/ofrep/v1/evaluate/flags', { context: { targetingKey: 'd-1' } }, { authorization: `Bearer ${link.json.token}` });
    assert.equal(ofrepAnswer.status, 200, JSON.stringify(ofrepAnswer.json));
  } finally { await t.stop(); }
});

test('a plugin of one’s own: its routes, its console routes behind the sign-in, and a hook after each publish', async () => {
  const published: string[] = [];
  const audit = definePlugin({
    id: 'audit-feed',
    setup: ({ plane }) => {
      const routes = new Hono();
      routes.get('/audit-feed/v1/revisions', (c) => c.json(Object.fromEntries([...plane.snapshots].map(([k, s]) => [k, s.revision]))));
      // the core's HttpError, from companyflags/plugins: answered with its status and {"error": …}
      routes.post('/audit-feed/v1/check', () => { throw new HttpError(422, 'That isn’t a revision.'); });
      return {
        routes,
        prefixes: ['/audit-feed'],
        console: ({ adminOnly }) => {
          const app = consoleRoutes();
          app.get('/audit-feed', (c) => { adminOnly(c.get('user')); return c.json({ for: c.get('user').key }); });
          return app;
        },
        onPublish: async (env) => { published.push(env); },
      };
    },
  });
  const t = await boot({ plugins: [audit, appFiles()] });
  try {
    assert.equal(typeof (await t.call('GET', '/audit-feed/v1/revisions')).json.dev, 'number');
    assert.match((await t.call('GET', '/audit-feed/nothing')).json.error, /^no such endpoint/, 'its prefix is JSON, not the console page');
    const refused = await t.call('POST', '/audit-feed/v1/check', {});
    assert.deepEqual([refused.status, refused.json], [422, { error: 'That isn’t a revision.' }], 'an HttpError, not a 500');
    assert.equal((await t.as('dana').get('/audit-feed')).json.for, 'dana');
    assert.equal((await t.as('alice').get('/audit-feed')).status, 403, 'adminOnly: alice is an editor');
    assert.equal((await t.call('GET', '/api/audit-feed')).status, 401, 'signed in, as the console’s routes');
    // a change publishes dev, and the plugin hears of it
    assert.equal((await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'dev', projects: ['android', 'ios'] })).status, 200);
    await t.settle();
    assert.ok(published.includes('dev'), JSON.stringify(published));
    await new Promise((r) => setTimeout(r, 30));
    const row = (await t.db.query<{ purged: string | null }>(`select purged_at as purged from publish_queue order by id desc limit 1`)).rows[0];
    assert.equal(row.purged, null, 'it purged no cache: Settings → CDN doesn’t say it did');
  } finally { await t.stop(); }
});

test('each plugin’s onPublish runs whatever the others do; a failure is kept with the plugin’s name', async () => {
  const heard: string[] = [];
  const logs: string[] = [];
  const failing = definePlugin({ id: 'failing', setup: () => ({ onPublish: async () => { throw new Error('the feed is down'); } }) });
  const purging = definePlugin({ id: 'purging', setup: () => ({ onPublish: async (env) => { heard.push(env); return 'purged' as const; } }) });
  const t = await boot({ plugins: [failing, purging], log: (m) => logs.push(m) });
  try {
    const { version, layer } = await t.baseOf('payments_enabled', 'dev');
    assert.equal((await t.as('alice').put('/flags/payments_enabled/layers/dev/base', { layer: { ...layer, enabled: !layer.enabled }, expectedVersion: version })).status, 200);
    await t.settle();
    let row: { purged: string | null; error: string | null } | undefined;
    for (let i = 0; i < 50 && !(row?.error && row.purged); i++) {
      row = (await t.db.query<{ purged: string | null; error: string | null }>(`select purged_at as purged, last_error as error from publish_queue order by id desc limit 1`)).rows[0];
      if (!(row.error && row.purged)) await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(heard, ['dev'], 'the plugin after the failing one still ran');
    assert.equal(row?.error, 'purge: failing: the feed is down');
    assert.ok(row?.purged, 'the other one purged, and the publish says so');
    assert.ok(logs.includes('after publishing dev: failing: the feed is down'), logs.join('\n'));
  } finally { await t.stop(); }
});

test('a plugin that reads flags asks the one evaluator, and gets what OFREP gives an app', async () => {
  let ask: PluginContext['evaluate'] | undefined;
  const reader = definePlugin({ id: 'reader', setup: (ctx) => { ask = ctx.evaluate; return {}; } });
  const t = await boot({ plugins: [ofrep(), reader] });
  try {
    const key = (await t.as('dana').post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'all' })).json.key;
    const { token } = (await t.call('GET', '/sdk/v1/links/company/acme?service=web', undefined, { authorization: `Bearer ${key}` })).json;
    const app = await t.call('POST', '/ofrep/v1/evaluate/flags', { context: { targetingKey: 'd-1', device: { platform: 'web' } } }, { authorization: `Bearer ${token}` });
    assert.equal(app.status, 200, JSON.stringify(app.json));
    const fromOfrep = app.json.flags.map((f: { key: string; value?: unknown }) => [f.key, f.value ?? null]);
    const who = { service: 'web', entity: 'acme', attrs: { 'device.id': 'd-1', 'device.platform': 'web' } };
    const every = ask!('dev', who);
    assert.ok(every.length > 0);
    assert.deepEqual(every.map((r) => [r.key, r.errorCode || r.codeDefault ? null : r.value ?? null]), fromOfrep);
    const first = ask!('dev', who, every[0].key);
    assert.deepEqual([first.key, first.value], [every[0].key, every[0].value]);
    assert.throws(() => ask!('nowhere', { service: 'web' }), (e: Error) => e instanceof HttpError && e.status === 404);
    assert.throws(() => ask!('dev', { service: 'web', entity: 'nobody' }), (e: Error) => e instanceof HttpError && e.status === 404);
  } finally { await t.stop(); }
});

test('a plugin never takes the core’s addresses: its prefixes are checked at the start, and the core’s console routes answer first', async () => {
  const claiming = (prefix: string) => definePlugin({ id: 'claiming', setup: () => ({ prefixes: [prefix] }) });
  const refused: [string, RegExp][] = [
    ['audit', /starts with \//], ['/api', /taken by the core \(\/api\)/], ['/sdk/v2', /taken by the core \(\/sdk\)/], ['/ofrep/v2', /taken by the plugin "ofrep"/],
  ];
  for (const [prefix, why] of refused) {
    await assert.rejects(boot({ plugins: [ofrep(), claiming(prefix)] }), (e: Error) => e instanceof PluginError && why.test(e.message), prefix);
  }
  const shadow = definePlugin({
    id: 'shadow',
    setup: () => ({ console: () => { const app = consoleRoutes(); app.post('/trace', (c) => c.json({ shadow: true })); return app; } }),
  });
  const t = await boot({ plugins: [shadow] });
  try {
    const r = await t.as('alice').post('/trace', { environment: 'dev', project: 'android', entity: null, attrs: {}, flag: 'android_quick_share' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.shadow, r.json.result?.key], [undefined, 'android_quick_share'], 'the core’s trace answered');
  } finally { await t.stop(); }
});

test('a plugin that isn’t one, or one listed twice, stops the start with what’s wrong, before any setup runs', async () => {
  let setUp = 0;
  const counting = definePlugin({ id: 'counting', setup: () => { setUp++; return {}; } });
  await assert.rejects(boot({ plugins: [counting, ofrep(), ofrep()] }), (e: Error) => e instanceof PluginError && /listed twice/.test(e.message));
  await assert.rejects(boot({ plugins: [counting, { id: 'Bad Name', setup: () => ({}) }] }), (e: Error) => e instanceof PluginError && /not a plugin/.test(e.message));
  assert.equal(setUp, 0, 'every entry is checked first');
});

test('a setup that fails stops the background work of the plugins set up before it', async () => {
  let stopped = 0;
  const busy = definePlugin({ id: 'busy', setup: () => ({ worker: { wake: () => {}, drain: async () => {}, stop: async () => { stopped++; } } }) });
  const broken = definePlugin({ id: 'broken', setup: () => { throw new Error('no database for me'); } });
  await assert.rejects(boot({ plugins: [busy, broken] }), /no database for me/);
  assert.equal(stopped, 1);
});

test('the config: the file’s settings, else the environment’s, else the defaults', () => {
  const env = { DATABASE_URL: 'postgres://env/db', PORT: '9000', BETTER_AUTH_URL: 'https://env.example.com', CF_ZONE_ID: 'z', CF_API_TOKEN: 't' };
  const none = resolveConfig({}, {});
  assert.deepEqual([none.databaseUrl, none.dataDir, none.port, none.host], [undefined, './data', 8787, '0.0.0.0']);
  assert.deepEqual(ids(none.plugins), ['ofrep', 'flagd', 'app-files', 'cloudflare', 'webhooks']);
  const fromEnv = resolveConfig({}, env);
  assert.deepEqual([fromEnv.databaseUrl, fromEnv.port], ['postgres://env/db', 9000]);
  assert.equal(fromEnv.signIn.kind === 'better-auth' && fromEnv.signIn.settings.baseURL, 'https://env.example.com');
  const fromFile = resolveConfig(defineConfig({
    database: { url: 'postgres://file/db' }, server: { port: 9100 },
    auth: { baseURL: 'https://file.example.com', secret: undefined }, plugins: [ofrep(), flagd()],
  }), env);
  assert.deepEqual([fromFile.databaseUrl, fromFile.port, ids(fromFile.plugins)], ['postgres://file/db', 9100, ['ofrep', 'flagd']]);
  assert.equal(fromFile.signIn.kind === 'better-auth' && fromFile.signIn.settings.baseURL, 'https://file.example.com');
  assert.throws(() => resolveConfig({ server: { port: 70000 } }, {}), ConfigError);
  // production is NODE_ENV's alone: a file can't turn off the production checks
  const prod = resolveConfig({ auth: { production: false } } as Config, { NODE_ENV: 'production' });
  assert.equal(prod.signIn.kind === 'better-auth' && prod.signIn.settings.production, true);
  assert.deepEqual(ids(defaultPlugins()), ['ofrep', 'flagd', 'app-files', 'cloudflare', 'webhooks']);
  assert.equal(cloudflare().id, 'cloudflare');
});

test('the config file: found in the folder (importing companyflags/config and /plugins), or named by FF_CONFIG', async () => {
  // inside the repository, so 'companyflags/…' resolves to this package, as it does for a config in the app's folder
  const dir = mkdtempSync(join(import.meta.dirname, '.config-'));
  try {
    assert.deepEqual(await loadConfig({ cwd: dir, env: {} }), { config: {}, file: null });
    writeFileSync(join(dir, 'companyflags.config.ts'), `import { defineConfig } from 'companyflags/config';
import { flagd, ofrep } from 'companyflags/plugins';
export default defineConfig({ server: { port: 9200 }, plugins: [ofrep(), flagd()] });
`);
    const { config, file } = await loadConfig({ cwd: dir, env: {} });
    assert.equal(file, join(dir, 'companyflags.config.ts'));
    assert.deepEqual([config.server?.port, ids(config.plugins ?? [])], [9200, ['ofrep', 'flagd']]);
    writeFileSync(join(dir, 'other.config.ts'), `export default { server: { port: 9300 } };\n`);
    assert.equal((await loadConfig({ cwd: dir, env: { FF_CONFIG: 'other.config.ts' } })).config.server?.port, 9300);
    await assert.rejects(loadConfig({ cwd: dir, env: { FF_CONFIG: 'missing.ts' } }), ConfigError);
    writeFileSync(join(dir, 'bad.config.ts'), `export const config = {};\n`);
    await assert.rejects(loadConfig({ cwd: dir, env: { FF_CONFIG: 'bad.config.ts' } }), /export its config as the default/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a config file outside the server’s folder: the error says to keep it there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-config-'));
  try {
    writeFileSync(join(dir, 'companyflags.config.ts'), `import { defineConfig } from 'companyflags/config';\nexport default defineConfig({});\n`);
    await assert.rejects(loadConfig({ cwd: dir, env: {} }), (e: Error) => e instanceof ConfigError && /only resolves inside the server’s folder .*\/app in Docker/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
