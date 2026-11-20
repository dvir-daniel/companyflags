// What an app keeps in memory (app-link secrets, API keys, which apps are client apps) is its own: two apps
// started in one process, each with its own database, never answer from the other's copy.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let a: Awaited<ReturnType<typeof boot>>;
let b: Awaited<ReturnType<typeof boot>>;
before(async () => { a = await boot(); b = await boot(); });
after(async () => { await a.stop(); await b.stop(); });

test('an app checks a link against its own environments’ secrets', async () => {
  const linkA = await a.link('dev', 'web', 'acme');
  const linkB = await b.link('dev', 'web', 'acme');
  assert.notEqual(linkA, linkB, 'each database has its own secrets');
  assert.equal((await a.call('GET', linkA)).status, 200);             // a reads and keeps its secrets
  assert.equal((await b.call('GET', linkB)).status, 200, 'b checks its own link with its own secrets');
  assert.equal((await b.call('GET', linkA)).status, 404, 'and a’s link is no good at b');
});

test('an API key made in one app isn’t accepted by another', async () => {
  const key = (await a.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json.key;
  const get = (app: typeof a) => app.call('GET', '/sdk/v1/flagd/company/acme', undefined, { authorization: `Bearer ${key}` });
  assert.equal((await get(a)).status, 200);                           // a now has it in memory
  assert.equal((await get(b)).status, 401);
});

test('a client app added to one app isn’t known to another', async () => {
  assert.equal((await a.as('dana').post('/services', { key: 'tv', kind: 'client' })).status, 201);
  assert.equal((await a.call('GET', '/cdn/v1/flags/dev/tv')).status, 200);
  assert.equal((await b.call('GET', '/cdn/v1/flags/dev/tv')).status, 404);
});
