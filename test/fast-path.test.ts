// App requests skip the step-by-step explanation. They must still get exactly the same answers.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { boot } from './helpers.ts';
import { evaluate } from '../server/evaluator.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const DEVICES: Record<string, unknown>[] = [
  {},
  { 'device.id': 'dev-1', 'app.version': '6.2.0', 'device.platform': 'android' },
  { 'device.id': 'dev-2', 'app.version': '4.9.3' },
  { 'device.id': 'old-77', 'app.version': 'not-a-version' },
  { 'session.id': 's-9', 'device.browser': 'chrome' },
  ...Array.from({ length: 40 }, (_, i) => ({ 'device.id': `bulk-${i}`, 'app.version': `${4 + (i % 4)}.${i % 10}.0` })),
];

test('fast path gives the same answer as the explained path for every flag, app, entity and device', () => {
  let compared = 0;
  for (const env of ['dev', 'prod']) {
    const snap = t.plane.get(env);
    const projects = ['android', 'ios', 'web', 'server-wupserver', 'server-ds'];
    const entities = [null, ...Object.values(snap.entities)];
    for (const flag of Object.keys(snap.flags)) for (const project of projects) for (const entity of entities) for (const attrs of DEVICES) {
      const ctx = { environment: env, project, entity, attrs };
      const full = evaluate(snap, flag, ctx);
      const fast = evaluate(snap, flag, ctx, false);
      assert.deepEqual(
        { value: fast.value, variant: fast.variant, reason: fast.reason, codeDefault: fast.codeDefault, errorCode: fast.errorCode },
        { value: full.value, variant: full.variant, reason: full.reason, codeDefault: full.codeDefault, errorCode: full.errorCode },
        `${env} ${flag} ${project} ${entity?.key} ${JSON.stringify(attrs)}`,
      );
      assert.equal(fast.trace.length, 0);
      compared++;
    }
  }
  assert.ok(compared > 1000, `compared ${compared}`);
});

test('backend download (flagd JSON): gzipped, 304 when its flags are unchanged, rebuilt when they change', async () => {
  const key = (await t.as('dana').post('/api-keys', { environment: 'dev', service: 'server-ds', scope: 'all' })).json.key;
  const get = (extra: Record<string, string> = {}) => t.app.request('/sdk/v1/flagd/company/acme', { headers: { authorization: `Bearer ${key}`, 'accept-encoding': 'gzip', ...extra } });
  const r = await get();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  const doc = JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString());
  assert.ok(Object.keys(doc.flags).length > 0 && doc.metadata.flagSetId === 'dev/server-ds/acme' && typeof doc.metadata.revision === 'number');
  const etag = r.headers.get('etag')!;
  assert.equal((await get({ 'if-none-match': etag })).status, 304);

  // a publish that doesn't change this backend's flags (an entity renamed) is still a 304
  assert.equal((await t.as('alice').put('/dimensions/company/acme', { name: 'Acme Corporation' })).status, 200);
  await t.settle();
  assert.equal((await get({ 'if-none-match': etag })).status, 304);

  // sending one more flag to this backend changes them
  const projects = [...t.plane.get('dev').flags.new_checkout.delivery, 'server-ds'];
  assert.equal((await t.as('dana').put('/flags/new_checkout/delivery', { environment: 'dev', services: projects })).status, 200);
  await t.settle();
  const changed = await get({ 'if-none-match': etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
});
