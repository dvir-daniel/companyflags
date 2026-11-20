// Several servers on one database (server/workers.ts catchUp): what one publishes, the others serve after their next
// round, a link replaced on one stops working on the others, and an environment added on one is served by all. An
// OFREP provider that heard of a publish gets it from any of them at once (ofrep.ts flagConfigEtag).
// Needs a real Postgres server: the embedded one is a single process's (pnpm test:pg, and CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, cdnAnswer, startApp, testDatabase } from './helpers.ts';
import type { FlagdDoc } from '../server/flagd.ts';
import { appToken } from '../server/delivery.ts';

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
