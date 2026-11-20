// Plugins (server/plugin.ts, server/plugins/) and companyfeatures.config.ts (server/config.ts): an installation runs the
// plugins it lists, and only those; a plugin of its own can serve routes, console routes and run after a publish; the
// config file wins over the environment, which wins over the defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { boot } from './helpers.ts';
import { appFiles, cloudflare, consoleRoutes, defaultPlugins, definePlugin, flagd, ofrep } from '../server/plugins/index.ts';
import { PluginError } from '../server/plugin.ts';
import { ConfigError, defineConfig, loadConfig, resolveConfig } from '../server/config.ts';

const ids = (plugins: { id: string }[]) => plugins.map((p) => p.id);

test('without a list, every built-in plugin runs, and the console is told which', async () => {
  const t = await boot();
  try {
    assert.deepEqual((await t.as('alice').get('/meta')).json.plugins, ['ofrep', 'flagd', 'app-files', 'cloudflare']);
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
    // OFREP still answers: an app token from the link endpoint, which has no file path now
    const key = (await t.as('dana').post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'all' })).json.key;
    const link = await t.call('GET', '/sdk/v1/links/company/acme?flagSet=web', undefined, { authorization: `Bearer ${key}` });
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
      return {
        routes,
        prefixes: ['/audit-feed'],
        console: ({ adminOnly }) => {
          const app = consoleRoutes();
          app.get('/audit-feed', (c) => { adminOnly(c.get('user')); return c.json({ for: c.get('user').key }); });
          return app;
        },
        onPublish: async (env) => { published.push(env); return 'purged'; },
      };
    },
  });
  const t = await boot({ plugins: [audit, appFiles()] });
  try {
    assert.equal(typeof (await t.call('GET', '/audit-feed/v1/revisions')).json.dev, 'number');
    assert.match((await t.call('GET', '/audit-feed/nothing')).json.error, /^no such endpoint/, 'its prefix is JSON, not the console page');
    assert.equal((await t.as('dana').get('/audit-feed')).json.for, 'dana');
    assert.equal((await t.as('alice').get('/audit-feed')).status, 403, 'adminOnly: alice is an editor');
    assert.equal((await t.call('GET', '/api/audit-feed')).status, 401, 'signed in, as the console’s routes');
    // a change publishes dev, and the plugin hears of it
    assert.equal((await t.as('alice').put('/flags/android_quick_share/delivery', { environment: 'dev', projects: ['android', 'ios'] })).status, 200);
    await t.settle();
    assert.ok(published.includes('dev'), JSON.stringify(published));
  } finally { await t.stop(); }
});

test('a plugin that isn’t one, or one listed twice, stops the start with what’s wrong', async () => {
  await assert.rejects(boot({ plugins: [ofrep(), ofrep()] }), (e: Error) => e instanceof PluginError && /listed twice/.test(e.message));
  await assert.rejects(boot({ plugins: [{ id: 'Bad Name', setup: () => ({}) }] }), (e: Error) => e instanceof PluginError && /not a plugin/.test(e.message));
});

test('the config: the file’s settings, else the environment’s, else the defaults', () => {
  const env = { DATABASE_URL: 'postgres://env/db', PORT: '9000', BETTER_AUTH_URL: 'https://env.example.com', CF_ZONE_ID: 'z', CF_API_TOKEN: 't' };
  const none = resolveConfig({}, {});
  assert.deepEqual([none.databaseUrl, none.dataDir, none.port, none.host], [undefined, './data', 8787, '0.0.0.0']);
  assert.deepEqual(ids(none.plugins), ['ofrep', 'flagd', 'app-files', 'cloudflare']);
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
  assert.deepEqual(ids(defaultPlugins()), ['ofrep', 'flagd', 'app-files', 'cloudflare']);
  assert.equal(cloudflare().id, 'cloudflare');
});

test('the config file: found in the folder (importing companyfeatures/config and /plugins), or named by FF_CONFIG', async () => {
  // inside the repository, so 'companyfeatures/…' resolves to this package, as it does for a config in the app's folder
  const dir = mkdtempSync(join(import.meta.dirname, '.config-'));
  try {
    assert.deepEqual(await loadConfig({ cwd: dir, env: {} }), { config: {}, file: null });
    writeFileSync(join(dir, 'companyfeatures.config.ts'), `import { defineConfig } from 'companyfeatures/config';
import { flagd, ofrep } from 'companyfeatures/plugins';
export default defineConfig({ server: { port: 9200 }, plugins: [ofrep(), flagd()] });
`);
    const { config, file } = await loadConfig({ cwd: dir, env: {} });
    assert.equal(file, join(dir, 'companyfeatures.config.ts'));
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
