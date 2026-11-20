// Publishing (server/workers.ts): a change is built into a new snapshot, open consoles are told (events.ts, GET
// /api/events), and the CDN drops the environment's files (purge.ts), without a slow or failed purge holding up
// anything. A purger is only ever given to createApp by the server's own start, so these tests use fakes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { purgeTags, PURGE_TIMEOUT_MS } from '../server/purge.ts';
import { PURGE_AGAIN_MS, ROUND_MS, startWorkers } from '../server/workers.ts';

type Mode = 'ok' | 'fail' | 'hang';
let mode: Mode = 'ok';
const purged: string[] = [];
const fakePurger = (env: string) => {
  purged.push(env);
  if (mode === 'fail') return Promise.reject(new Error('the CDN said no'));
  if (mode === 'hang') return new Promise<void>(() => {});
  return Promise.resolve('purged' as const);
};

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot({ onPublish: fakePurger }); });
after(async () => { await t.stop(); });

const change = (n: number) => t.editBase('max_upload_mb', 'dev', (layer) => ({ ...layer, defaultVariation: n % 2 ? 'enterprise' : 'standard' }));
const pending = async () => Number((await t.db.query<{ n: number }>(`select count(*)::int as n from publish_queue where published_at is null`)).rows[0].n);

test('a publish purges its environment from the CDN once the change is live, and tells open consoles', async () => {
  mode = 'ok';
  purged.length = 0;
  const events: unknown[] = [];
  const off = t.hub.subscribeConsole((event, data) => events.push([event, data]));
  try {
    assert.equal((await change(1)).status, 200);
    assert.deepEqual(purged, ['dev'], 'the environment that changed, once');
    let purgedAt = null;
    for (let i = 0; i < 50 && !purgedAt; i++) {
      purgedAt = (await t.db.query<{ at: string | null }>(`select purged_at as at from publish_queue order by id desc limit 1`)).rows[0].at;
      if (!purgedAt) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(purgedAt, 'the publish row says when its purge went through');
    const revision = t.plane.get('dev').revision;
    assert.deepEqual(events, [['revision', { environment: 'dev', revision }]]);
    assert.equal(await pending(), 0);
  } finally { off(); }
});

test('a purge that fails or never answers doesn’t hold up publishing; a failure is noted on the outbox row', async () => {
  mode = 'hang';
  assert.equal((await change(2)).status, 200, 'settled although the purge never answers');
  assert.equal(await pending(), 0, 'published');
  assert.equal(t.plane.get('dev').flags.max_upload_mb.base.defaultVariation, 'standard');

  mode = 'fail';
  assert.equal((await change(3)).status, 200);
  assert.equal(await pending(), 0);
  let noted = '';
  for (let i = 0; i < 100 && !noted; i++) {
    noted = (await t.db.query<{ e: string | null }>(`select last_error as e from publish_queue where published_at is not null order by id desc limit 1`)).rows[0].e ?? '';
    if (!noted) await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(noted, /purge: the CDN said no/);
  mode = 'ok';
});

test('a Cloudflare purge: one call to the zone, its tags, the token, a time limit; Cloudflare’s own words when it says no', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response('{"success":true}')
      : new Response('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}', { status: 403 });
  }) as unknown as typeof fetch;
  await purgeTags(fake, { zoneId: 'zone-1', token: 'token-1' }, ['env-prod']);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { tags: ['env-prod'] });
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer token-1');
  assert.ok(calls[0].init.signal instanceof AbortSignal, `gives up after ${PURGE_TIMEOUT_MS} ms`);
  await assert.rejects(purgeTags(fake, { zoneId: 'zone-1', token: 'token-1' }, ['env-dev']), /Cloudflare said 403: Authentication error/);
});

test('GET /api/events: a stream of revision events; when the console goes away, it stops listening', async () => {
  const before = t.hub.console.size;
  const res = await t.app.request('/api/events', { headers: { 'x-user': 'alice' } });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (pattern: RegExp) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before ${pattern}: ${text}`);
      text += decoder.decode(value);
    }
  };
  await until(/event: heartbeat/);
  assert.equal(t.hub.console.size, before + 1, 'listening');
  const changed = change(4);
  await until(/event: revision\ndata: \{"environment":"dev","revision":\d+\}/);
  assert.equal((await changed).status, 200);
  await reader.cancel();
  for (let i = 0; i < 50 && t.hub.console.size !== before; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.hub.console.size, before, 'unsubscribed');
});

test('stopping the workers waits for the round in progress, then starts no more', async (c) => {
  const own = await boot({ onPublish: fakePurger });
  c.after(() => own.db.close().catch(() => {}));
  const { version, layer } = await own.baseOf('payments_enabled', 'dev');
  assert.equal((await own.as('alice').put('/flags/payments_enabled/layers/dev/base', { layer: { ...layer, enabled: false }, expectedVersion: version })).status, 200);
  const round = own.workers.drain();                                         // a round starts now…
  await own.workers.stop();                                                  // …and stop waits for it
  const left = Number((await own.db.query<{ n: number }>(`select count(*)::int as n from publish_queue where published_at is null`)).rows[0].n);
  assert.equal(left, 0, 'the round finished before stop() returned');
  await round;
  assert.equal(own.plane.get('dev').flags.payments_enabled.base.enabled, false);
  await own.as('alice').put('/dimensions/company/acme', { name: 'Acme after stop' });
  own.workers.wake();
  await own.workers.drain();
  assert.equal(Number((await own.db.query<{ n: number }>(`select count(*)::int as n from publish_queue where published_at is null`)).rows[0].n), 2,
    'nothing runs after stop: the rename waits in the outbox (one row per environment)');
});

test('the purge runs once more a round and a margin later, once for a burst of publishes', async (c) => {
  const calls: string[] = [];
  const hook = async (env: string) => { calls.push(env); return 'purged' as const; };
  const own = await boot({ onPublish: hook });
  await own.workers.stop();                     // its own workers wait the full time: these run with a short one
  const workers = startWorkers(own.db, own.plane, own.hub, () => {}, hook, { purgeAgainAfterMs: 40 });
  c.after(async () => { await workers.stop(); await own.stop(); });
  assert.ok(PURGE_AGAIN_MS > ROUND_MS, 'after other servers’ next round');

  const flip = (on: boolean) => own.editBase('payments_enabled', 'dev', (layer) => ({ ...layer, enabled: on }));
  assert.equal((await flip(false)).status, 200);
  await workers.drain();
  assert.deepEqual(calls, ['dev'], 'at once');
  for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ['dev', 'dev'], 'and once more');

  calls.length = 0;
  for (const on of [true, false, true]) { assert.equal((await flip(on)).status, 200); await workers.drain(); }
  assert.deepEqual(calls, ['dev', 'dev', 'dev'], 'each publish at once');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(calls, ['dev', 'dev', 'dev', 'dev'], 'and one more for the burst');
});

test('a snapshot rebuilt before its publish was told (another server published it): the next round tells', async (c) => {
  const own = await boot();
  await own.workers.stop();
  let remote = 0;
  const workers = startWorkers(own.db, own.plane, own.hub, () => {}, undefined, { onRemoteChange: () => { remote++; } });
  c.after(async () => { await workers.stop(); await own.stop(); });
  const heard: [string, number][] = [];
  const off = own.hub.subscribe((env, revision) => heard.push([env, revision]));
  c.after(off);

  assert.equal((await own.editBase('payments_enabled', 'dev', (layer) => ({ ...layer, enabled: false }))).status, 200);
  // OFREP rebuilds the snapshot for a provider that heard of the publish (ofrep.ts flagConfigEtag)…
  const { revision } = await own.plane.refresh(own.db, 'dev');
  await workers.drain();
  assert.deepEqual(heard, [['dev', revision]], 'the outbox row tells, once');
  // …or another server publishes the row: its listeners hear of it, ours don't yet
  heard.length = 0;
  remote = 0;
  assert.equal((await own.editBase('payments_enabled', 'dev', (layer) => ({ ...layer, enabled: true }))).status, 200);
  const next = (await own.plane.refresh(own.db, 'dev')).revision;
  assert.ok(next > revision);
  await own.db.query(`update publish_queue set published_at = now() where published_at is null`);
  await workers.drain();
  assert.deepEqual(heard, [['dev', next]], 'told once');
  assert.equal(remote, 1);
  await workers.drain();
  assert.deepEqual(heard, [['dev', next]], 'and not again');
});
