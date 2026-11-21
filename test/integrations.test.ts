// Integrations from environment variables (server/integrations.ts): without a config file's `plugins`, the defaults
// less FF_INTEGRATIONS_OFF, then metrics(), cloudfront() and cloudCdn() when their variables are set. A config file
// that lists `plugins` wins entirely, and the variables it makes pointless are named at the start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from './helpers.ts';
import { ConfigError } from '../server/config.ts';
import { resolveConfig } from '../server/configFile.ts';
import { integrationNames } from '../server/integrations.ts';
import { cloudfront, metrics, ofrep } from '../server/plugins/index.ts';

const DEFAULTS = ['ofrep', 'flagd', 'cdn-files', 'cloudflare', 'webhooks', 'mcp'];
const on = (env: Record<string, string>) => resolveConfig({}, env).plugins.map((p) => p.id);

test('no variables: the six defaults', () => {
  assert.deepEqual(on({}), DEFAULTS);
  assert.deepEqual(resolveConfig({ server: { port: 9100 } }, {}).plugins.map((p) => p.id), DEFAULTS, 'a file without plugins too');
});

test('FF_METRICS=on adds metrics; off or unset leaves it out; anything else, or a token alone, stops the start', () => {
  assert.deepEqual(on({ FF_METRICS: 'on' }), [...DEFAULTS, 'metrics']);
  assert.deepEqual(on({ FF_METRICS: ' ON ' }), [...DEFAULTS, 'metrics']);
  assert.deepEqual(on({ FF_METRICS: 'off', FF_METRICS_TOKEN: 'scrape' }), DEFAULTS);
  assert.throws(() => on({ FF_METRICS: 'yes' }), (e: Error) => e instanceof ConfigError && /FF_METRICS is on or off, not yes/.test(e.message));
  assert.throws(() => on({ FF_METRICS_TOKEN: 'scrape' }), /FF_METRICS_TOKEN is set, but metrics are off: set FF_METRICS=on/);
});

test('FF_CLOUDFRONT_DISTRIBUTION_ID adds the CloudFront purge; the Cloud CDN purge needs its project and URL map', () => {
  assert.deepEqual(on({ FF_CLOUDFRONT_DISTRIBUTION_ID: 'E2QWRUHAPOMQZL' }), [...DEFAULTS, 'cloudfront']);
  assert.deepEqual(on({ FF_CLOUD_CDN_PROJECT: 'acme-flags', FF_CLOUD_CDN_URL_MAP: 'flags-map' }), [...DEFAULTS, 'cloud-cdn']);
  assert.throws(() => on({ FF_CLOUD_CDN_URL_MAP: 'flags-map' }), /needs FF_CLOUD_CDN_PROJECT and FF_CLOUD_CDN_URL_MAP: FF_CLOUD_CDN_PROJECT isn’t set/);
  assert.throws(() => on({ FF_CLOUD_CDN_HOST: 'flags.example.com' }), /FF_CLOUD_CDN_PROJECT and FF_CLOUD_CDN_URL_MAP aren’t set/);
  assert.deepEqual(on({ FF_METRICS: 'on', FF_CLOUDFRONT_DISTRIBUTION_ID: 'E2QWRUHAPOMQZL', FF_CLOUD_CDN_PROJECT: 'acme-flags', FF_CLOUD_CDN_URL_MAP: 'flags-map' }),
    [...DEFAULTS, 'metrics', 'cloudfront', 'cloud-cdn'], 'the defaults first, then each optional one');
});

test('FF_INTEGRATIONS_OFF turns defaults off by id; an unknown id, a part of the core or an optional one stops the start', () => {
  assert.deepEqual(on({ FF_INTEGRATIONS_OFF: 'mcp,webhooks' }), ['ofrep', 'flagd', 'cdn-files', 'cloudflare']);
  assert.deepEqual(on({ FF_INTEGRATIONS_OFF: ' MCP , ,cloudflare ' }), ['ofrep', 'flagd', 'cdn-files', 'webhooks']);
  assert.deepEqual(on({ FF_INTEGRATIONS_OFF: DEFAULTS.join(','), FF_METRICS: 'on' }), ['metrics']);
  assert.deepEqual(on({ FF_INTEGRATIONS_OFF: '' }), DEFAULTS);
  const can = /It can turn off: ofrep, flagd, cdn-files, cloudflare, webhooks, mcp\./;
  assert.throws(() => on({ FF_INTEGRATIONS_OFF: 'mcp,graphql' }), (e: Error) => e instanceof ConfigError && /no integration "graphql"/.test(e.message) && can.test(e.message));
  assert.throws(() => on({ FF_INTEGRATIONS_OFF: 'console' }), /"console" is part of the core, which is always on/);
  assert.throws(() => on({ FF_INTEGRATIONS_OFF: 'app-links' }), /part of the core/);
  assert.throws(() => on({ FF_INTEGRATIONS_OFF: 'metrics' }), /"metrics" is off already; only FF_METRICS=on turns it on/);
});

test('a config file that lists plugins wins entirely, and names the variables it makes pointless', () => {
  const env = { FF_METRICS: 'on', FF_METRICS_TOKEN: 't', FF_INTEGRATIONS_OFF: 'not-an-id', FF_CLOUDFRONT_DISTRIBUTION_ID: 'E2QWRUHAPOMQZL', FF_CLOUD_CDN_URL_MAP: 'flags-map' };
  const r = resolveConfig({ plugins: [ofrep()] }, env);
  assert.deepEqual(r.plugins.map((p) => p.id), ['ofrep'], 'no error either: the variables aren’t read');
  assert.deepEqual(r.ignoredEnv, ['FF_INTEGRATIONS_OFF', 'FF_METRICS', 'FF_METRICS_TOKEN', 'FF_CLOUDFRONT_DISTRIBUTION_ID', 'FF_CLOUD_CDN_URL_MAP']);
  // a listed plugin still reads its own settings: those aren't ignored, but the switches are
  const listed = resolveConfig({ plugins: [ofrep(), metrics(), cloudfront()] }, env);
  assert.deepEqual(listed.ignoredEnv, ['FF_INTEGRATIONS_OFF', 'FF_METRICS', 'FF_CLOUD_CDN_URL_MAP']);
  assert.deepEqual(resolveConfig({ plugins: [ofrep()] }, {}).ignoredEnv, []);
  assert.deepEqual(resolveConfig({}, { FF_METRICS: 'on' }).ignoredEnv, [], 'without a list, nothing is ignored');
});

test('the startup log names the integrations in plain words', () => {
  assert.equal(integrationNames(on({ FF_METRICS: 'on', FF_CLOUDFRONT_DISTRIBUTION_ID: 'E2QWRUHAPOMQZL' })),
    'OFREP, flagd, CDN files, Cloudflare purge, webhooks, MCP, metrics, CloudFront purge');
  assert.equal(integrationNames(['cloud-cdn', 'audit-feed']), 'Cloud CDN purge, audit-feed', 'one of your own by its id');
  assert.equal(integrationNames([]), 'none');
});

test('a server from the variables alone: metrics behind its token, MCP off', async () => {
  const env = { FF_METRICS: 'on', FF_METRICS_TOKEN: 'scrape-me-please', FF_INTEGRATIONS_OFF: 'mcp' };
  const t = await boot({ plugins: resolveConfig({}, env).plugins, env });
  try {
    assert.deepEqual((await t.as('alice').get('/meta')).json.plugins, ['ofrep', 'flagd', 'cdn-files', 'cloudflare', 'webhooks', 'metrics']);
    assert.equal((await t.call('GET', '/metrics')).status, 401);
    const scraped = await t.call('GET', '/metrics', undefined, { authorization: 'Bearer scrape-me-please' });
    assert.equal(scraped.status, 200);
    assert.match(String(scraped.json), /companyflags_info/);
    const mcp = await t.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(mcp.status, 404);
    assert.match(mcp.json.error, /^no such endpoint/);
  } finally { await t.stop(); }
});

test('a wrong FF_INTEGRATIONS_OFF stops the start at once, saying why, before it opens any data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-integrations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'server', 'index.ts')], {
    cwd: dir, env: { ...process.env, FF_CONFIG: '', FF_DATA_DIR: join(dir, 'data'), FF_INTEGRATIONS_OFF: 'webhooks,evaluator' }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 1, `it ran nothing: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /^\[companyflags\] FF_INTEGRATIONS_OFF: "evaluator" is part of the core, which is always on\./);
});
