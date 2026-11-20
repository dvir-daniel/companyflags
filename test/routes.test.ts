// Addresses: one the server doesn't know answers 404 with a JSON error (never the console's page), and a bad
// value in an address or body is the request's fault (404 / 400), never a 500 with database text.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

test('an unknown API, CDN-file or backend address is a 404 with a JSON error, not the console page', async () => {
  const signedIn = { 'x-user': 'alice' };
  const cases: [string, string, Record<string, string>][] = [
    ['GET', '/api/nope', signedIn], ['POST', '/api/flags/new_checkout/nope', signedIn], ['DELETE', '/api/customers/acme', signedIn],
    ['GET', '/cdn/v1/nope', {}], ['GET', '/cdn', {}], ['GET', '/cdn/v1/flags/dev/web/acme/secret/extra', {}],
    ['GET', '/sdk/v1/nope', {}], ['GET', '/sdk', {}],
  ];
  for (const [method, path, headers] of cases) {
    const r = await t.call(method, path, method === 'GET' ? undefined : {}, headers);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.match(String(r.headers.get('content-type')), /application\/json/, `${method} ${path}`);
    assert.match(r.json.error, /no such endpoint/, `${method} ${path}`);
  }
});

test('every other address is the console’s page, for links into it', async (c) => {
  if (!existsSync(new URL('../web/dist/index.html', import.meta.url))) {
    c.skip('the console isn’t built (web/dist is missing): run pnpm build first');
    return;
  }
  const page = await t.app.request('/flags/dev');
  assert.equal(page.status, 200);
  assert.match(String(page.headers.get('content-type')), /text\/html/);
});

test('an ID that isn’t a number is a 404; one too big for the database is a 400, never a 500', async () => {
  const alice = t.as('alice');
  assert.equal((await alice.get('/change-sets/abc')).status, 404);
  assert.equal((await alice.post('/change-sets/abc/apply')).status, 404);
  assert.equal((await alice.post('/change-sets/1x/review', { decision: 'approve' })).status, 404);
  assert.equal((await t.as('dana').post('/api-keys/abc/revoke')).status, 404);
  assert.equal((await t.as('dana').post('/environments/dev/versions/abc/restore', { reason: 'x' })).status, 404);
  const big = await alice.get('/change-sets/99999999999999999999');
  assert.equal(big.status, 400, JSON.stringify(big.json));
  assert.doesNotMatch(big.json.error, /bigint|syntax|range/, 'no database text');
  assert.equal((await alice.get('/change-sets/999999')).status, 404, 'a well-formed ID that doesn’t exist is still a 404');
});
