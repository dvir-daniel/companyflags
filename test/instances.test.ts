// Several servers on one database (server/workers.ts catchUp): what one publishes, the others serve after their next
// round, a link replaced on one stops working on the others, and an environment added on one is served by all.
// Needs a real Postgres server: the embedded one is a single process's (pnpm test:pg, and CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, startApp, testDatabase } from './helpers.ts';

const needsPg = process.env.FF_TEST_PG ? false : 'needs a Postgres server (pnpm test:pg)';

test('two servers on one database serve the same thing after a round', { skip: needsPg }, async () => {
  const tdb = await testDatabase();
  const a = await boot({ databaseUrl: tdb.url });
  const b = await startApp({ databaseUrl: tdb.url, signIn: { kind: 'test-header' } });
  try {
    const fileOn = async (server: typeof a | typeof b, path: string) => {
      const r = await server.app.request(path);
      return { status: r.status, body: r.status === 200 ? await r.json() as { revision: number; flags: Record<string, unknown> } : null };
    };
    assert.ok((await fileOn(b, '/client/v1/flags/dev/web')).body!.flags.payments_enabled, 'b starts with what a has');

    // a switches payments off; b catches up on its next round
    await a.editBase('payments_enabled', 'dev', (layer) => ({ ...layer, enabled: false }));
    await b.workers.drain();
    const onB = await fileOn(b, '/client/v1/flags/dev/web');
    assert.equal(onB.body!.flags.payments_enabled, undefined, 'off: nothing is sent');
    assert.equal(onB.body!.revision, a.plane.get('dev').revision);

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
    assert.equal((await fileOn(b, '/client/v1/flags/staging/web')).status, 200);
  } finally {
    await b.workers.stop();
    await b.db.close();
    await a.stop();
    await tdb.drop();
  }
});
