// Settings → CDN (server/cdn.ts): an admin saves the Cloudflare zone and token, checked with Cloudflare first; the
// token never comes back to the browser; publishes then purge with them; the server's own (cloudflare()'s options,
// else CF_ZONE_ID and CF_API_TOKEN) win and can't be changed from the console. Cloudflare here is a fake.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, builtIns } from './helpers.ts';
import { cloudflare as cloudflarePlugin, metrics as metricsPlugin } from '../server/plugins/index.ts';
import { sealer } from '../server/sealed.ts';
import { entityTag, linkTag } from '../server/purge.ts';

const ZONE = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1234';
type Call = { url: string; token: string; tags: string[] };
const calls: Call[] = [];
let answer: { status: number; body: string } = { status: 200, body: '{"success":true}' };
const cloudflare = (async (url: string, init: RequestInit) => {
  calls.push({ url, token: (init.headers as Record<string, string>).authorization.replace('Bearer ', ''), tags: JSON.parse(String(init.body)).tags });
  return new Response(answer.body, { status: answer.status });
}) as unknown as typeof fetch;
const ok = () => { answer = { status: 200, body: '{"success":true}' }; };

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot({ plugins: builtIns({ cloudflare: { fetch: cloudflare } }) }); });
after(async () => { await t.stop(); });

const lastPublish = async () => {
  for (let i = 0; i < 50; i++) {
    const row = (await t.db.query<{ purged: string | null; error: string | null }>(`select purged_at as purged, last_error as error from publish_queue order by id desc limit 1`)).rows[0];
    if (row.purged || row.error) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { purged: null, error: null };
};
/** How long the CDN may serve an old copy of a CDN file while it asks again (CDN-Cache-Control). */
const staleFor = async () => (await t.cdnFile('dev', 'web', 'acme')).headers.get('cdn-cache-control')?.match(/stale-while-revalidate=(\d+)/)?.[1];
const change = (n: number) => t.editBase('max_upload_mb', 'dev', (layer) => ({ ...layer, defaultVariation: n % 2 ? 'enterprise' : 'standard' }));

test('nothing set up: publishes don’t purge, and the page says so', async () => {
  const s = (await t.as('alice').get('/cdn')).json;
  assert.deepEqual([s.source, s.zoneId, s.tokenEnd, s.reachable], [null, null, null, true]);
  calls.length = 0;
  assert.equal((await change(1)).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, [], 'no CDN, no call');
  assert.equal(await staleFor(), '600', 'no purge: the CDN may serve an old copy 10 minutes while it asks again');
});

test('only admins change it; a bad zone ID or a missing token is refused before asking Cloudflare', async () => {
  assert.equal((await t.as('alice').put('/cdn', { zoneId: ZONE, token: TOKEN })).status, 403);
  calls.length = 0;
  const bad = await t.as('dana').put('/cdn', { zoneId: 'my-zone', token: TOKEN });
  assert.equal(bad.status, 422);
  assert.match(bad.json.error, /32 letters and digits/);
  assert.match((await t.as('dana').put('/cdn', { zoneId: ZONE })).json.error, /Add the API token/);
  assert.deepEqual(calls, []);
});

test('Cloudflare is asked first: a token it refuses isn’t saved, and the page says what permission it needs', async () => {
  answer = { status: 403, body: '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' };
  const r = await t.as('dana').put('/cdn', { zoneId: ZONE, token: TOKEN });
  assert.equal(r.status, 422);
  assert.match(r.json.error, /Zone → Cache Purge → Purge/);
  assert.match(r.json.error, /Authentication error/);
  assert.deepEqual(calls.at(-1)!.tags, ['companyflags-check'], 'the check purges a tag no file carries');
  assert.equal((await t.as('alice').get('/cdn')).json.source, null, 'nothing saved');
  ok();
});

test('saved: the token never comes back, History names only its end, and publishes purge with it', async () => {
  const saved = await t.as('dana').put('/cdn', { zoneId: ZONE.toUpperCase(), token: ` ${TOKEN} ` });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual([saved.json.source, saved.json.zoneId, saved.json.tokenEnd, saved.json.updatedBy], ['console', ZONE, '1234', 'dana']);
  const page = JSON.stringify((await t.as('vic@example.com').get('/cdn')).json);
  assert.ok(!page.includes(TOKEN.slice(0, -4)), 'the token isn’t on the page, even for admins');
  const historyRes = await t.as('dana').get('/history?type=cdn');
  assert.equal(historyRes.status, 200, JSON.stringify(historyRes.json));
  const history = historyRes.json;
  const entry = history[0];                                  // GET /history answers with the entries, newest first
  assert.equal(entry.changeType, 'cdn.update');
  assert.deepEqual(entry.after, { zoneId: ZONE, tokenEnd: '1234' });
  assert.ok(!JSON.stringify(history).includes(TOKEN.slice(0, -4)), 'nor in History');

  calls.length = 0;
  assert.equal((await change(2)).status, 200);
  const row = await lastPublish();
  assert.ok(row.purged, 'the publish says when its purge went through');
  assert.deepEqual(calls, [{ url: `https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`, token: TOKEN, tags: ['env-dev'] }]);
  const s = (await t.as('alice').get('/cdn')).json;
  assert.equal(s.publishes[0].environment, 'dev');
  assert.ok(s.publishes[0].purgedAt);
  // a purge drops a changed file at once, so the CDN may keep the old one a day: its cover while this server is down,
  // for CDNs that don't read stale-if-error (Google Cloud CDN)
  assert.equal(await staleFor(), '86400');
});

test('a new zone ID keeps the saved token; purge now; a failed purge shows on the publish', async () => {
  const other = 'fedcba9876543210fedcba9876543210';
  calls.length = 0;
  assert.equal((await t.as('dana').put('/cdn', { zoneId: other })).status, 200);
  assert.equal(calls[0].token, TOKEN, 'checked with the saved token');
  assert.equal((await t.as('alice').get('/cdn')).json.zoneId, other);

  calls.length = 0;
  assert.equal((await t.as('alice').post('/cdn/purge', { environment: 'prod' })).status, 403, 'admins only');
  assert.equal((await t.as('dana').post('/cdn/purge', { environment: 'nope' })).status, 404);
  assert.equal((await t.as('dana').post('/cdn/purge', { environment: 'prod' })).status, 200);
  assert.deepEqual(calls.map((c) => c.tags), [['env-prod']]);

  answer = { status: 500, body: 'down' };
  const failed = await t.as('dana').post('/cdn/purge', { environment: 'prod' });
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /didn’t go through: Cloudflare said 500/);
  assert.equal((await change(3)).status, 200, 'a publish still goes out');
  assert.match((await lastPublish()).error ?? '', /^purge: cloudflare: Cloudflare said 500/, 'kept with the plugin’s name');
  ok();
});

const settled = async () => { await t.workers.drain(); await new Promise((r) => setTimeout(r, 30)); };

test('a purge drops only what changed: nothing for a new entity or a description, an entity’s tag for its settings', async () => {
  calls.length = 0;
  assert.equal((await t.as('alice').post('/dimensions/company', { key: 'acme-east', name: 'Acme East' })).status, 201);
  await settled();
  assert.equal(calls.length, 0, 'a new entity: nobody’s answers changed, nothing purged');
  assert.equal((await t.as('alice').put('/flags/payments_enabled/meta', { description: 'Takes card payments' })).status, 200);
  await settled();
  assert.equal(calls.length, 0, 'a flag’s description: nothing purged');

  const j = (await t.as('alice').get('/flags/ds_backend_config')).json;
  const { version, updatedAt: _u, updatedBy: _b, ...layer } = j.layers.dev.entities.find((e: any) => e.entity === 'soylent').layer;
  assert.equal((await t.as('alice').put('/flags/ds_backend_config/layers/dev/soylent', { layer: { ...layer, rules: [] }, expectedVersion: version })).status, 200);
  await settled();
  assert.deepEqual(calls.map((c) => c.tags), [[entityTag('dev', 'soylent')]], 'its files and those under it');

  calls.length = 0;
  assert.equal((await t.as('dana').post(`${await t.entityPath('acme')}/link/rotate?environment=dev`)).status, 200);
  await settled();
  assert.deepEqual(calls.map((c) => c.tags).sort(), [[linkTag('dev', 'acme')], [linkTag('prod', 'acme')]].sort(), 'a replaced link: its own files, in each environment');
});

test('a token that can’t be read (BETTER_AUTH_SECRET changed): the purge fails on the publish, and /readyz warns but answers 200', async () => {
  const sealedElsewhere = sealer('another-better-auth-secret-0123456789abcdef').seal(TOKEN);
  await t.db.query(`update cdn_setting set api_token = $1`, [sealedElsewhere]);
  calls.length = 0;
  let ready = await t.app.request('/readyz');
  assert.equal(ready.status, 200);
  assert.ok(((await ready.json()) as any).warnings.some((w: string) => /token can’t be read/.test(w)), 'said at once, before any publish');

  assert.equal((await change(5)).status, 200);
  assert.match((await lastPublish()).error ?? '', /^purge: cloudflare: The CDN’s API token can’t be read/);
  assert.deepEqual(calls, [], 'nothing went to Cloudflare');
  ready = await t.app.request('/readyz');
  assert.equal(ready.status, 200, 'still ready: the server serves');
  const body = await ready.json() as any;
  assert.equal(body.environments.dev.purgeFailing, true);
  assert.equal(body.environments.dev.failing, false);
  assert.ok(body.warnings.some((w: string) => /CDN purge after dev’s last publish didn’t go through/.test(w)));
  assert.match((await t.as('dana').post('/cdn/purge', { environment: 'dev' })).json.error, /token can’t be read/);

  // saved again: the next purge goes through, and the warnings go
  assert.equal((await t.as('dana').put('/cdn', { zoneId: ZONE, token: TOKEN })).status, 200);
  assert.equal((await change(6)).status, 200);
  assert.ok((await lastPublish()).purged);
  const after = await (await t.app.request('/readyz')).json() as any;
  assert.deepEqual(after.warnings, []);
  assert.equal(after.environments.dev.purgeFailing, false);
});

test('the metrics: whether the last purge went through, and how many warnings /readyz lists', async (c) => {
  const own = await boot({ plugins: [...builtIns({ cloudflare: { fetch: cloudflare } }), metricsPlugin()] });
  c.after(() => own.stop());
  ok();
  assert.equal((await own.as('dana').put('/cdn', { zoneId: ZONE, token: TOKEN })).status, 200);
  answer = { status: 500, body: 'down' };
  assert.equal((await own.editBase('max_upload_mb', 'dev', (l) => ({ ...l, defaultVariation: 'enterprise' }))).status, 200);
  await own.workers.drain();
  for (let i = 0; i < 50; i++) {
    const row = (await own.db.query<{ e: string | null }>(`select last_error as e from publish_queue order by id desc limit 1`)).rows[0];
    if (row.e) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  ok();
  const text = await (await own.app.request('/metrics')).text();
  assert.match(text, /companyflags_purge_failing\{environment="dev"\} 1/);
  assert.match(text, /companyflags_purge_failing\{environment="prod"\} 0/);
  assert.match(text, /companyflags_warnings 1/);
  const ready = await (await own.app.request('/readyz')).json() as any;
  assert.equal(ready.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(ready), /Cloudflare said|down/, 'why is in Settings → CDN and the log, not in a public answer');
});

test('removed: publishes stop purging; removing again says there’s nothing', async () => {
  const r = await t.as('dana').del('/cdn');
  assert.equal(r.status, 200);
  assert.equal(r.json.source, null);
  assert.equal((await t.as('dana').del('/cdn')).status, 404);
  calls.length = 0;
  assert.equal((await change(4)).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, []);
  assert.equal(await staleFor(), '600', 'no purge any more: 10 minutes again');
});

test('set on the server (cloudflare()’s options): it wins, shows as the server’s, and can’t be changed in the console', async () => {
  const own = await boot({ plugins: builtIns({ cloudflare: { fetch: cloudflare, zoneId: ZONE, token: TOKEN } }) });
  try {
    const s = (await own.as('alice').get('/cdn')).json;
    assert.deepEqual([s.source, s.zoneId, s.tokenEnd], ['server', ZONE, '1234']);
    const put = await own.as('dana').put('/cdn', { zoneId: ZONE, token: TOKEN });
    assert.equal(put.status, 409);
    assert.match(put.json.error, /cloudflare\(\) in companyflags\.config\.ts, or CF_ZONE_ID/);
    assert.equal((await own.as('dana').del('/cdn')).status, 409);
  } finally { await own.stop(); }
});

test('set on the server with CF_ZONE_ID and CF_API_TOKEN, while the config file lists cloudflare() (as init writes it)', async () => {
  const own = await boot({ plugins: [cloudflarePlugin({ fetch: cloudflare })], env: { CF_ZONE_ID: ZONE, CF_API_TOKEN: TOKEN } });
  try {
    const s = (await own.as('alice').get('/cdn')).json;
    assert.deepEqual([s.source, s.zoneId, s.tokenEnd], ['server', ZONE, '1234']);
    calls.length = 0;
    const { version, layer } = await own.baseOf('max_upload_mb', 'dev');
    assert.equal((await own.as('alice').put('/flags/max_upload_mb/layers/dev/base', { layer: { ...layer, defaultVariation: layer.defaultVariation === 'enterprise' ? 'standard' : 'enterprise' }, expectedVersion: version })).status, 200);
    await own.settle();
    for (let i = 0; i < 50 && !calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(calls, [{ url: `https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`, token: TOKEN, tags: ['env-dev'] }]);
  } finally { await own.stop(); }
});

test('a server that can’t reach Cloudflare (tests, by default) says so instead of saving unchecked', async () => {
  const own = await boot();
  try {
    assert.equal((await own.as('alice').get('/cdn')).json.reachable, false);
    const r = await own.as('dana').put('/cdn', { zoneId: ZONE, token: TOKEN });
    assert.equal(r.status, 503);
  } finally { await own.stop(); }
});
