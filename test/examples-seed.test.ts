// The examples' seed (examples/seed.ts), run as its README says: against a server, with an Editor's access token.
// A token never changes settings, so the seed only checks the settings an admin makes in the console, says what is
// missing, and then makes the companies and the flags. Run again, it changes nothing.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { boot } from './helpers.ts';

const SEED = fileURLToPath(new URL('../examples/seed.ts', import.meta.url));

let t: Awaited<ReturnType<typeof boot>>;
let server: ServerType;
let url = '';
before(async () => {
  // a new server: an editor and an admin, nothing else
  t = await boot({ setup: async (db) => { await db.exec(`insert into app_user (key, name, role) values ('alice', 'Alice (editor)', 'editor'), ('dana', 'Dana (admin)', 'admin')`); } });
  server = await new Promise<ServerType>((done) => { const s = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => done(s)); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await t.stop();
});

/** Runs the seed in its own process, as `FLAGS_URL=… FLAGS_TOKEN=… node examples/seed.ts`. */
function seed(token: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [SEED], { env: { PATH: process.env.PATH, FLAGS_URL: url, FLAGS_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', fail);
    p.on('close', (code) => done({ code, out }));
  });
}

test('the seed works with an Editor’s token: it says which settings to make, then makes the companies and flags', async () => {
  const made = await t.as('alice').post('/tokens', { name: 'examples seed', role: 'editor' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.role, 'editor');
  const token = made.json.token as string;

  // before the admin made the settings: it says what to make, and makes nothing
  const first = await seed(token);
  assert.equal(first.code, 1, first.out);
  for (const step of ['Settings → Environments', 'Settings → Dimensions', 'Services → add web, kind App', 'Services → add api, kind Backend']) {
    assert.ok(first.out.includes(step), `says ${step}:\n${first.out}`);
  }
  assert.equal((await t.as('alice').get('/flags/new_checkout')).status, 404, 'made nothing');

  // the admin makes them in the console, signed in, as the README says
  const dana = t.as('dana');
  assert.equal((await dana.post('/environments', { key: 'dev', name: 'Development' })).status, 201);
  assert.equal((await dana.put('/dimensions', { dimensions: [{ key: 'company', singular: 'company', plural: 'companies' }] })).status, 200);
  assert.equal((await dana.post('/services', { key: 'web', kind: 'client' })).status, 201);
  assert.equal((await dana.post('/services', { key: 'api', kind: 'server' })).status, 201);

  const second = await seed(token);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /flag new_checkout: made/);
  assert.match(second.out, /API Keys → \+ New key/, 'it ends with the keys to make');
  await t.settle();
  for (const key of ['acme', 'globex']) assert.equal((await t.as('alice').get(`/dimensions/company/${key}`)).status, 200, key);
  for (const flag of ['new_checkout', 'welcome_message', 'max_upload_mb']) assert.equal((await t.as('alice').get(`/flags/${flag}`)).status, 200, flag);
  const acme = await t.trace({ service: 'web', entity: 'acme', flag: 'welcome_message' });
  assert.equal(acme.value, 'Welcome back, Acme Corp.');

  // again: nothing new
  const third = await seed(token);
  assert.equal(third.code, 0, third.out);
  assert.doesNotMatch(third.out, /: made/, third.out);

  // the keys it leaves to the admin: a token can't make one, the admin can
  const withToken = await fetch(`${url}/api/api-keys`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ environment: 'dev', service: 'web', scope: 'all' }) });
  assert.equal(withToken.status, 403);
  assert.equal((await dana.post('/api-keys', { environment: 'dev', service: 'web', scope: 'all', label: 'examples: web' })).status, 201);
});
