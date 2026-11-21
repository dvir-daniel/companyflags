// Several servers on one database (server/workers.ts catchUp): what one publishes, the others serve after their next
// round, a link replaced on one stops working on the others, and an environment added on one is served by all. An
// OFREP provider that heard of a publish gets it from any of them at once (ofrep.ts flagConfigEtag).
// Needs a real Postgres server: the embedded one is a single process's (pnpm test:pg, and CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, cdnAnswer, startApp, testDatabase } from './helpers.ts';
import type { FlagdDoc } from '../server/flagd.ts';
import { appToken } from '../server/delivery.ts';
import { createApiKey } from '../server/control.ts';

const needsPg = process.env.FF_TEST_PG ? false : 'needs a Postgres server (pnpm test:pg)';

test('two servers on one database serve the same thing after a round', { skip: needsPg }, async () => {
  const tdb = await testDatabase();
  const a = await boot({ databaseUrl: tdb.url });
  const b = await startApp({ databaseUrl: tdb.url, signIn: { kind: 'test-header' } });
  try {
    const fileOn = async (server: typeof a | typeof b, path: string) => {
      const r = await server.app.request(path);
      return { status: r.status, body: r.status === 200 ? await r.json() as FlagdDoc : null };
    };
    const onA = cdnAnswer((await fileOn(a, '/cdn/v1/flags/dev/web')).body!, 'payments_enabled');
    assert.ok(!onA.codeDefault);
    assert.deepEqual(cdnAnswer((await fileOn(b, '/cdn/v1/flags/dev/web')).body!, 'payments_enabled'), onA, 'b starts with what a has');

    // a switches payments off; b catches up on its next round
    await a.editBase('payments_enabled', 'dev', (layer) => ({ ...layer, enabled: false }));
    await b.workers.drain();
    const onB = await fileOn(b, '/cdn/v1/flags/dev/web');
    assert.equal(onB.body!.flags.payments_enabled.state, 'DISABLED', 'off: the app keeps the default in its code');
    assert.equal(onB.body!.metadata.revision, a.plane.get('dev').revision);

    // a link replaced on a stops working on b
    const link = await a.link('dev', 'web', 'acme');
    assert.equal((await fileOn(b, link)).status, 200);
    assert.equal((await a.as('dana').post(`${await a.entityPath('acme')}/link/rotate?environment=dev`)).status, 200);
    await a.settle();
    await b.workers.drain();
    assert.equal((await fileOn(b, link)).status, 404, 'the old link, on the other server');
    assert.equal((await fileOn(b, await a.link('dev', 'web', 'acme'))).status, 200, 'the new one works there too');

    // an environment added on a is served by b
    assert.equal((await a.as('dana').post('/environments', { key: 'staging', name: 'Staging' })).status, 201);
    await b.workers.drain();
    assert.equal((await fileOn(b, '/cdn/v1/flags/staging/web')).status, 200);
  } finally {
    await b.workers.stop();
    await b.db.close();
    await a.stop();
    await tdb.drop();
  }
});

test('a provider that heard of a publish asks a server still behind: the new flags, not a stale 304', { skip: needsPg }, async () => {
  const tdb = await testDatabase();
  const a = await boot({ databaseUrl: tdb.url });
  const b = await startApp({ databaseUrl: tdb.url, signIn: { kind: 'test-header' } });
  await b.workers.stop();                                  // b stays behind: no rounds of its own
  try {
    const token = await appToken(a.db, 'dev', 'acme', 'web');
    const ask = (server: typeof a | typeof b, query = '', headers: Record<string, string> = {}) => server.app.request(`/ofrep/v1/evaluate/flags${query}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ context: { targetingKey: 'd-1' } }),
    });
    const payments = async (res: Response) => ((await res.json()) as { flags: { key: string; value?: unknown }[] }).flags.find((f) => f.key === 'payments_enabled');
    const first = await ask(b);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag')!;
    assert.equal((await payments(first))?.value, true);

    // a switches payments off; the change event it sends carries the new revision
    assert.equal((await a.editBase('payments_enabled', 'dev', (layer) => ({ ...layer, enabled: false }))).status, 200);
    const revision = a.plane.get('dev').revision;
    assert.ok(b.plane.get('dev').revision < revision);
    assert.equal((await ask(b, '', { 'if-none-match': etag })).status, 304, 'without it: what b has');

    const fresh = await ask(b, `?flagConfigEtag=${revision}`, { 'if-none-match': etag });
    assert.equal(fresh.status, 200, 'b catches up first');
    assert.equal('value' in ((await payments(fresh)) ?? {}), false, 'off: the app’s own default');
    assert.equal(b.plane.get('dev').revision, revision);
  } finally {
    await b.db.close();
    await a.stop();
    await tdb.drop();
  }
});

test('an entity added on one server: another still behind looks in the database before refusing it over OFREP', { skip: needsPg }, async () => {
  const tdb = await testDatabase();
  const a = await boot({ databaseUrl: tdb.url });
  const b = await startApp({ databaseUrl: tdb.url, signIn: { kind: 'test-header' } });
  await b.workers.stop();                                  // b stays behind: no rounds of its own
  try {
    const key = (await a.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json.key as string;
    const ask = (credential: string, context: Record<string, unknown>) => b.app.request('/ofrep/v1/evaluate/flags', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify({ context }),
    });
    const add = (path: string, body: unknown) => a.app.request(`/sdk/v1/entities/${path}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body),
    });
    assert.equal((await ask(key, { targetingKey: 'd-1' })).status, 200, 'b answers, and has read its links');
    assert.equal((await add('company/stark', { name: 'Stark Industries' })).status, 201);
    assert.equal((await add('brand/stark-west', { parent: 'stark' })).status, 201);
    assert.equal(Object.hasOwn(b.plane.get('dev').entities, 'stark'), false, 'b hasn’t caught up');
    const asked = await ask(key, { company: 'stark' });
    assert.equal(asked.status, 200, await asked.clone().text());
    assert.equal(((await asked.json()) as { metadata: { entity?: string } }).metadata.entity, 'stark');
    // an app token for an entity b has only just heard of: not a 401, which would stop the web provider for good
    const token = await appToken(a.db, 'dev', 'stark-west', 'web');
    const app = await ask(token, { targetingKey: 'd-1' });
    assert.equal(app.status, 200, await app.clone().text());
    assert.equal((await ask(key, { company: 'nobody' })).status, 400, 'one that isn’t there anywhere: refused');
  } finally {
    await b.db.close();
    await a.stop();
    await tdb.drop();
  }
});

test('an entity a backend adds on one server is served by another at once, before its round (delivery.ts caughtUpWith)', { skip: needsPg }, async () => {
  const tdb = await testDatabase();
  const a = await boot({ databaseUrl: tdb.url });
  const b = await startApp({ databaseUrl: tdb.url, signIn: { kind: 'test-header' } });
  await b.workers.stop();                                  // b stays behind: no rounds of its own
  try {
    const key = (await createApiKey(a.db, { environment: 'dev', project: 'server-ds', scope: 'all' }, { name: 'test', type: 'system' })).key;
    const auth = { authorization: `Bearer ${key}` };
    const put = await a.app.request('/sdk/v1/entities/company/acme-north', { method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: '{"name":"Acme North"}' });
    assert.equal(put.status, 201, await put.text());
    assert.ok(!Object.hasOwn(b.plane.get('dev').entities, 'acme-north'), 'b hasn’t caught up');

    // the backend asks b for the app link, and the app reads its file from b
    const link = await b.app.request('/sdk/v1/links/company/acme-north?service=web', { headers: auth });
    assert.equal(link.status, 200, await link.clone().text());
    const { path } = await link.json() as { path: string };
    const file = await b.app.request(path);
    assert.equal(file.status, 200, 'its first file, from the server that hadn’t heard of it');
    assert.equal(((await file.json()) as FlagdDoc).metadata.flagSetId, 'dev/web/acme-north');
    assert.equal((await b.app.request('/sdk/v1/flagd/company/acme-north', { headers: auth })).status, 200, 'and its flagd JSON');
    assert.equal((await b.app.request('/sdk/v1/flagd/company/acme-south', { headers: auth })).status, 404, 'one that isn’t there is still a 404');
  } finally {
    await b.db.close();
    await a.stop();
    await tdb.drop();
  }
});
