// App links as backends hand them out (GET /sdk/v1/links, server/delivery.ts), and app files read from another origin.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { appToken, readAppToken } from '../server/delivery.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

test('a backend gets an entity’s app link and OpenFeature token with its API key, within the key’s scope, never cached', async () => {
  const all = (await t.as('dana').post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'all' })).json.key;
  const own = (await t.as('dana').post('/api-keys', { environment: 'dev', project: 'server-ds', scope: 'entity', entity: 'acme' })).json.key;
  const ask = (key: string | null, path: string) => t.call('GET', path, undefined, key ? { authorization: `Bearer ${key}` } : {});
  const top = (await t.as('dana').get('/dimensions')).json.dimensions?.[0]?.key ?? 'company';

  const r = await ask(all, `/sdk/v1/links/${top}/acme?app=web`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.path, await t.link('dev', 'web', 'acme'), 'the same link the console shows');
  assert.equal(r.json.token, await appToken(t.db, 'dev', 'acme', 'web'));
  const token = readAppToken(r.json.token)!;
  assert.deepEqual([token.environment, token.app, token.entity], ['dev', 'web', 'acme']);
  assert.notEqual(token.secret, r.json.path.split('/').pop(), 'a secret of its own, bound to the app');
  assert.notEqual((await ask(all, `/sdk/v1/links/${top}/acme?app=ios`)).json.token.split('.').pop(), token.secret, 'another app, another token');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await t.call('GET', r.json.path)).status, 200, 'and it serves the file');

  assert.equal((await ask(own, `/sdk/v1/links/${top}/acme?app=ios`)).status, 200, 'its own entity');
  assert.equal((await ask(own, `/sdk/v1/links/${top}/globex?app=ios`)).status, 403, 'another entity: outside its scope');
  assert.equal((await ask(all, `/sdk/v1/links/${top}/acme`)).status, 400, 'no app named');
  assert.equal((await ask(all, `/sdk/v1/links/${top}/acme?app=server-ds`)).status, 404, 'a backend has no app file');
  assert.equal((await ask(all, `/sdk/v1/links/${top}/nobody?app=web`)).status, 404);
  assert.equal((await ask(all, `/sdk/v1/links/not-a-dimension/acme?app=web`)).status, 404);
  assert.equal((await ask(null, `/sdk/v1/links/${top}/acme?app=web`)).status, 401);
});

test('a web app on another origin may read its file (CORS), and sees the ETag; the console’s API stays same-origin', async () => {
  const path = await t.link('dev', 'web', 'acme');
  const res = await t.app.request(path, { headers: { origin: 'https://shop.example.com' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-expose-headers') ?? '', /ETag/i);
  const pre = await t.app.request(path, { method: 'OPTIONS', headers: { origin: 'https://shop.example.com', 'access-control-request-method': 'GET' } });
  assert.ok(pre.status === 204 || pre.status === 200, `preflight: ${pre.status}`);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const again = await t.app.request(path, { headers: { origin: 'https://shop.example.com', 'if-none-match': res.headers.get('etag')! } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('access-control-allow-origin'), '*', 'a 304 keeps CORS');
  assert.match(again.headers.get('cache-tag') ?? '', /env-dev/);
  const api = await t.app.request('/api/meta', { headers: { origin: 'https://shop.example.com' } });
  assert.equal(api.headers.get('access-control-allow-origin'), null);
});

test('health and security headers', async () => {
  assert.deepEqual(await (await t.app.request('/healthz')).json(), { ok: true });
  const ready = await t.app.request('/readyz');
  assert.equal(ready.status, 200);
  const res = await t.app.request('/api/meta');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('strict-transport-security'), null, 'HSTS is left to whatever ends TLS');
});
