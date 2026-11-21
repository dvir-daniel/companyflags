// Publishing (server/workers.ts): a change is built into a new snapshot, open consoles are told (events.ts, GET
// /api/events), and the CDN drops the environment's files (purge.ts), without a slow or failed purge holding up
// anything. A purger is only ever given to createApp by the server's own start, so these tests use fakes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { entityTag, envTag, fileTags, linkTag, purgeTags, PURGE_TIMEOUT_MS, setTagSecret } from '../server/purge.ts';
import { PURGE_AGAIN_MS, ROUND_MS, startWorkers } from '../server/workers.ts';
import { joinScopes, type PublishScope } from '../server/events.ts';
import { purgeTagsFor } from '../server/cdn.ts';

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
  const workers = startWorkers(own.db, own.plane, own.hub, () => {}, hook, { purgeAgainAfterMs: 400 }); // longer than a publish takes, even on a slow Postgres
  c.after(async () => { await workers.stop(); await own.stop(); });
  assert.ok(PURGE_AGAIN_MS > ROUND_MS, 'after other servers’ next round');

  const flip = (on: boolean) => own.editBase('payments_enabled', 'dev', (layer) => ({ ...layer, enabled: on }));
  assert.equal((await flip(false)).status, 200);
  await workers.drain();
  assert.deepEqual(calls, ['dev'], 'at once');
  for (let i = 0; i < 300 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ['dev', 'dev'], 'and once more');

  calls.length = 0;
  for (const on of [true, false, true]) { assert.equal((await flip(on)).status, 200); await workers.drain(); }
  assert.deepEqual(calls, ['dev', 'dev', 'dev'], 'each publish at once');
  await new Promise((r) => setTimeout(r, 800));
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

test('each publish says whose answers it changed: a new entity, a rename or a description nobody’s; an entity’s settings or link only its own', async (c) => {
  const heard: [string, PublishScope][] = [];
  const own = await boot({ onPublish: async (env, scope) => { heard.push([env, scope ?? null]); return 'off' as const; } });
  c.after(() => own.stop());
  const told: [string, PublishScope][] = [];
  c.after(own.hub.subscribe((env, _revision, scope) => told.push([env, scope])));
  const step = async (r: Promise<{ status: number; json: any }>, status = 200) => {
    heard.length = 0;
    told.length = 0;
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.json));
    await own.workers.drain();
    return { heard: [...heard], told: [...told] };
  };
  const nobody = { entities: [], links: [] };

  const added = await step(own.as('alice').post('/dimensions/company', { key: 'acme-west', name: 'Acme West' }), 201);
  assert.deepEqual(added.heard, [['dev', nobody], ['prod', nobody]], 'a new entity: every environment learns of it, nothing to purge');
  assert.deepEqual(added.told, added.heard, 'and no event stream to wake');
  assert.ok(Object.hasOwn(own.plane.get('prod').entities, 'acme-west'), 'every environment’s snapshot has it');

  assert.deepEqual((await step(own.as('alice').put('/dimensions/company/acme-west', { name: 'Acme West Coast' }))).heard, [['dev', nobody], ['prod', nobody]], 'a rename');
  assert.deepEqual((await step(own.as('alice').put('/flags/payments_enabled/meta', { description: 'Takes payments' }))).heard, [['dev', nobody], ['prod', nobody]],
    'a flag’s description');

  const { version, layer } = await (async () => {
    const j = (await own.as('alice').get('/flags/ds_backend_config')).json;
    const { version: v, updatedAt: _u, updatedBy: _b, ...l } = j.layers.dev.entities.find((e: any) => e.entity === 'soylent').layer;
    return { version: v as number, layer: l };
  })();
  assert.deepEqual((await step(own.as('alice').put('/flags/ds_backend_config/layers/dev/soylent', { layer: { ...layer, rules: [] }, expectedVersion: version }))).heard,
    [['dev', { entities: ['soylent'], links: [] }]], 'an entity’s own settings: it and those under it');

  const rotated = await step(own.as('dana').post(`${await own.entityPath('acme')}/link/rotate?environment=dev`));
  assert.deepEqual(rotated.heard, [['dev', { entities: [], links: ['acme'] }], ['prod', { entities: [], links: ['acme'] }]], 'a replaced link: its own files');

  assert.deepEqual((await step(own.editBase('payments_enabled', 'dev', (l) => ({ ...l, enabled: false })))).heard, [['dev', null]], 'the defaults: everyone’s');
});

test('scopes join: anyone’s wins; and the tags a purge sends for each', () => {
  assert.deepEqual(joinScopes({ entities: ['acme'], links: [] }, { entities: ['acme', 'globex'], links: ['lumen'] }), { entities: ['acme', 'globex'], links: ['lumen'] });
  assert.equal(joinScopes({ entities: ['acme'], links: [] }, null), null);
  assert.deepEqual(purgeTagsFor('dev', null), ['env-dev']);
  assert.deepEqual(purgeTagsFor('dev', { entities: [], links: [] }), [], 'nobody’s: nothing');
  assert.deepEqual(purgeTagsFor('dev', { entities: ['globex'], links: ['acme'] }), [entityTag('dev', 'globex'), linkTag('dev', 'acme')]);
  assert.deepEqual(purgeTagsFor('dev', { entities: Array.from({ length: 40 }, (_, i) => `e${i}`), links: [] }), ['env-dev'], 'too many tags: the environment’s');
});

test('the purge once more, later, covers every publish of the burst, not only the last', async (c) => {
  const calls: PublishScope[] = [];
  const hook = async (_env: string, scope?: PublishScope) => { calls.push(scope ?? null); return 'purged' as const; };
  const own = await boot({ onPublish: hook });
  await own.workers.stop();
  const workers = startWorkers(own.db, own.plane, own.hub, () => {}, hook, { purgeAgainAfterMs: 400 });
  c.after(async () => { await workers.stop(); await own.stop(); });
  assert.equal((await own.editBase('payments_enabled', 'dev', (l) => ({ ...l, enabled: false }))).status, 200);
  await workers.drain();
  assert.equal((await own.as('alice').post('/dimensions/company', { key: 'acme-west', name: 'Acme West' })).status, 201);
  await workers.drain();
  for (let i = 0; i < 300 && calls.length < 5; i++) await new Promise((r) => setTimeout(r, 10));
  // dev: the defaults (null), the new entity (nobody); prod: the new entity; then once more for each environment
  assert.deepEqual(calls.slice(0, 3), [null, { entities: [], links: [] }, { entities: [], links: [] }]);
  assert.ok(calls.slice(3).includes(null), 'once more for dev: the defaults’ change too, though the new entity came after');
});

test('cache tags name no entity: keyed hashes, the same on every server with the secret, within the CDNs’ limits', () => {
  setTagSecret('one-server-secret-0123456789abcdefghij');
  const tags = fileTags('prod', ['lumen', 'globex']);
  assert.equal(tags[0], 'env-prod', 'the environment’s stays readable: the address names it already');
  for (const tag of tags.slice(1)) {
    assert.match(tag, /^[el]-[0-9a-f]{16}$/);
    assert.ok(!/lumen|globex/.test(tag), `${tag} names no entity`);
  }
  assert.equal(new Set(tags).size, tags.length, 'each its own');
  assert.notEqual(entityTag('prod', 'lumen'), entityTag('dev', 'lumen'), 'per environment');
  assert.notEqual(entityTag('prod', 'lumen'), linkTag('prod', 'lumen'), 'an entity’s tag isn’t its link’s');
  // what a purge sends matches what the files carry: the same key gives the same tags
  assert.deepEqual(purgeTagsFor('prod', { entities: ['globex'], links: ['lumen'] }), [tags[2], tags[3]]);
  setTagSecret('one-server-secret-0123456789abcdefghij');
  assert.deepEqual(fileTags('prod', ['lumen', 'globex']), tags, 'another server with the same secret: the same tags');
  setTagSecret('another-server-secret-0123456789abcdefghij');
  assert.notDeepEqual(fileTags('prod', ['lumen', 'globex']), tags, 'without the secret, a guess can’t be checked');
  // Cloud CDN: up to 120 bytes a tag, ASCII 0x21–0x7E without commas; CloudFront: 256 characters; both: 50 a file
  const long = 'e'.repeat(200);
  for (const tag of [...fileTags(long, Array.from({ length: 10 }, (_, i) => `entity-${i}`)), envTag('prod')]) {
    assert.ok(tag.length <= 120 && /^[\x21-\x7e]+$/.test(tag) && !tag.includes(','), tag);
  }
});
