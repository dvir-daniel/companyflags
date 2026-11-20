// Settings → CDN (server/cdn.ts): an admin saves the Cloudflare zone and token, checked with Cloudflare first; the
// token never comes back to the browser; publishes then purge with them; the server's own CF_ZONE_ID and
// CF_API_TOKEN win and can't be changed from the console. Cloudflare here is a fake.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

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
before(async () => { t = await boot({ cdn: { fetch: cloudflare } }); });
after(async () => { await t.stop(); });

const lastPublish = async () => {
  for (let i = 0; i < 50; i++) {
    const row = (await t.db.query<{ purged: string | null; error: string | null }>(`select purged_at as purged, last_error as error from publish_queue order by id desc limit 1`)).rows[0];
    if (row.purged || row.error) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { purged: null, error: null };
};
const change = (n: number) => t.editBase('max_upload_mb', 'dev', (layer) => ({ ...layer, defaultVariation: n % 2 ? 'enterprise' : 'standard' }));

test('nothing set up: publishes don’t purge, and the page says so', async () => {
  const s = (await t.as('alice').get('/cdn')).json;
  assert.deepEqual([s.source, s.zoneId, s.tokenEnd, s.reachable], [null, null, null, true]);
  calls.length = 0;
  assert.equal((await change(1)).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, [], 'no CDN, no call');
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
  assert.match((await lastPublish()).error ?? '', /^purge: Cloudflare said 500/);
  ok();
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
});

test('set on the server (CF_ZONE_ID, CF_API_TOKEN): it wins, shows as the server’s, and can’t be changed in the console', async () => {
  const own = await boot({ cdn: { fetch: cloudflare, zoneId: ZONE, token: TOKEN } });
  try {
    const s = (await own.as('alice').get('/cdn')).json;
    assert.deepEqual([s.source, s.zoneId, s.tokenEnd], ['server', ZONE, '1234']);
    const put = await own.as('dana').put('/cdn', { zoneId: ZONE, token: TOKEN });
    assert.equal(put.status, 409);
    assert.match(put.json.error, /CF_ZONE_ID/);
    assert.equal((await own.as('dana').del('/cdn')).status, 409);
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
