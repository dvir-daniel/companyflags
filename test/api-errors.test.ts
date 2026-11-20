// The HTTP API's contract for mistakes: every error is { error, code } with a stable code, a duplicate key is a 409,
// the database's own words never reach the caller, a missing or broken body is a 400 (never a 500), a request names
// its environment (none is picked for it), and a key scoped to an entity can't tell which entities exist.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { boot, CSRF } from './helpers.ts';
import { errorHandler } from '../server/index.ts';
import { ERROR_CODES } from '../server/db.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const CODES = new Set(Object.keys(ERROR_CODES));
const flag = (key: string) => ({ key, valueType: 'bool', kind: 'ops', delivery: {}, variations: [{ key: 'on', value: true }], base: { enabled: false, defaultVariation: 'on', rules: [] } });

test('a flag key that is taken is a 409 already_exists, archived or not; a bad key is a 422 in plain words', async () => {
  const alice = t.as('alice');
  const twice = await alice.post('/flags', flag('new_checkout'));
  assert.deepEqual([twice.status, twice.json.code], [409, 'already_exists'], JSON.stringify(twice.json));
  assert.match(twice.json.error, /“new_checkout” is taken already/);
  assert.equal((await alice.post('/flags', flag('soon_gone'))).status, 201);
  assert.equal((await alice.post('/flags/soon_gone/archive')).status, 200);
  const archived = await alice.post('/flags', flag('soon_gone'));
  assert.deepEqual([archived.status, archived.json.code], [409, 'already_exists']);
  assert.match(archived.json.error, /archived flags keep their key/);
  const bad = await alice.post('/flags', flag('Not A Key'));
  assert.deepEqual([bad.status, bad.json.code], [422, 'invalid']);
  for (const r of [twice, archived, bad]) assert.doesNotMatch(JSON.stringify(r.json), /constraint|duplicate key|violates|relation/);
  // the other keys that are taken say so the same way
  assert.equal((await t.as('dana').post('/environments', { key: 'dev', name: 'Dev again' })).json.code, 'already_exists');
  assert.equal((await t.as('dana').post('/services', { key: 'web', kind: 'client' })).json.code, 'already_exists');
});

test('a constraint the database enforces is said plainly, with its words in the log only', async () => {
  const seen: string[] = [];
  const app = new Hono();
  app.onError(errorHandler((m) => seen.push(m)));
  const pg = (code: string, message: string) => () => { throw Object.assign(new Error(message), { code }); };
  app.get('/unique', pg('23505', 'duplicate key value violates unique constraint "flag_key_key"'));
  app.get('/check', pg('23514', 'new row for relation "flag" violates check constraint "flag_key_check"'));
  app.get('/fk', pg('23503', 'insert or update on table "x" violates foreign key constraint "x_y_fkey"'));
  app.get('/trigger', pg('P0001', 'history is append-only'));
  const answer = async (p: string) => { const r = await app.request(p); return [r.status, await r.json()]; };
  assert.deepEqual(await answer('/unique'), [409, { error: 'that key is taken already', code: 'already_exists' }]);
  assert.deepEqual(await answer('/check'), [422, { error: 'a value in the request isn’t allowed', code: 'invalid' }]);
  assert.deepEqual((await answer('/fk'))[0], 422);
  assert.deepEqual(await answer('/trigger'), [422, { error: 'history is append-only', code: 'invalid' }], 'our own triggers’ words are ours to show');
  assert.equal(seen.length, 3);
  assert.ok(seen.some((l) => /flag_key_key/.test(l)), 'the database’s words are logged');
});

/** Every write route of the API (the console's, the stable one's and the plugins'), with sample values in its address. */
function writeRoutes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  return t.app.routes
    .filter((r) => r.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !r.path.startsWith('/api/auth'))
    .map((r) => ({ method: r.method, path: r.path.replace(/:(\w+)(\{[^}]*\})?/g, (_m, name: string, re?: string) => (re ? '999999' : `nope_${name}`)) }))
    .filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

test('every write route: an empty body, null, a list or broken JSON is a 400 or another refusal, never a 500, and always with a code', async () => {
  const routes = writeRoutes();
  assert.ok(routes.length > 40, `found ${routes.length} write routes`);
  for (const { method, path } of routes) {
    for (const body of ['', 'null', '[1]', '"text"', '{"key": ']) {
      const res = await t.app.request(path, { method, headers: { 'content-type': 'application/json', 'x-user': 'dana', ...CSRF }, body: body || undefined });
      const text = await res.text();
      assert.ok(res.status < 500, `${method} ${path} with ${JSON.stringify(body)}: ${res.status} ${text}`);
      if (res.status >= 400 && res.headers.get('content-type')?.includes('json')) {
        const json = JSON.parse(text);
        assert.ok(CODES.has(json.code), `${method} ${path} with ${JSON.stringify(body)}: code ${json.code} (${text})`);
      }
      // the console's API and the stable one refuse a body that isn't an object (the sign-in's open routes read their own)
      if (body && !body.startsWith('{') && !path.startsWith('/api/invites')) assert.equal(res.status, 400, `${method} ${path} with ${body}`);
    }
  }
});

test('an empty body where one is needed says to send one', async () => {
  const r = await t.app.request('/api/flags', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'alice', ...CSRF } });
  assert.deepEqual([r.status, await r.json()], [400, { error: 'send a JSON object in the body', code: 'bad_json' }]);
});

test('an environment is never picked for a request: one that names none is a 400', async () => {
  const alice = t.as('alice');
  for (const path of ['/flags', '/dimensions/company/acme/flags', '/dimensions/company/acme/children']) {
    const r = await alice.get(path);
    assert.deepEqual([r.status, r.json.code], [400, 'bad_request'], path);
    assert.match(r.json.error, /name the environment/);
  }
  assert.equal((await t.as('dana').get('/dimensions/company/acme/link')).status, 400);
  assert.equal((await t.as('dana').post('/dimensions/company/acme/link/rotate')).status, 400);
  assert.equal((await alice.get('/flags?environment=dev')).status, 200);
});

test('the API says service, never project or app', async () => {
  const meta = (await t.as('alice').get('/meta')).json;
  assert.ok(Array.isArray(meta.services) && !('projects' in meta));
  const made = await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const key = (await t.as('dana').get('/api-keys')).json.find((k: any) => k.id === made.json.id);
  assert.deepEqual([key.service, key.serviceKind, 'project' in key], ['server-ds', 'server', false]);
  const traced = await t.as('alice').post('/trace', { environment: 'dev', service: 'web', entity: null, attrs: {}, flag: 'new_checkout' });
  assert.equal(traced.status, 200, JSON.stringify(traced.json));
});

test('a key scoped to an entity gets a 403 for an entity that doesn’t exist, as for one outside its scope; an all-key a 404', async () => {
  const dana = t.as('dana');
  const own = (await dana.post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'entity', entity: 'acme' })).json.key;
  const every = (await dana.post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json.key;
  const ask = async (key: string, path: string) => (await t.call('GET', path, undefined, { authorization: `Bearer ${key}` })).status;
  for (const path of ['/sdk/v1/links/company/no_such_one?service=web', '/sdk/v1/flagd/company/no_such_one']) {
    assert.equal(await ask(own, path), 403, path);
    assert.equal(await ask(own, path.replace('no_such_one', 'globex')), 403, `${path}: outside its scope`);
    assert.equal(await ask(every, path), 404, path);
  }
});
