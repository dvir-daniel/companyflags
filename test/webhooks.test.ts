// Webhooks (server/webhooks.ts). Out: each save is one signed message, in order, with what its flags are set to now;
// a webhook gets only the events and environments it asks for; Slack and JSONata reshape it; a failed send is tried
// again later; addresses, headers and secrets never come back. In: another system's values, imported at once or as a
// request where approval is needed, and the same values again change nothing (no loop). The receiving end is a fake.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, builtIns, changed } from './helpers.ts';
import { nextMessage, sign, type HistoryRow } from '../server/webhooks.ts';

// ---------------------------------------------------------------- which rows make a message (pure)

const row = (id: number, o: Partial<HistoryRow> = {}): HistoryRow => ({
  id, environment: 'dev', revision: id, changedAt: '2026-11-19T10:00:00Z', at: `t${id}`, changedBy: 'alice', actorType: 'user',
  kind: 'layer.update', flag: 'f', entity: null, before: null, after: null, comment: null, changeSetId: null, ...o,
});
const hook = { events: ['changes'], environments: null, cursor: 10 };

test('a message is one save: rows with the same time and person, the ones the webhook wants', () => {
  const rows = [row(11, { at: 'a' }), row(12, { at: 'a', kind: 'person.add', revision: null }), row(13, { at: 'a' }), row(14, { at: 'b' })];
  const n = nextMessage(rows, hook, null, 0);
  assert.deepEqual(n.message.map((r) => r.id), [11, 13]);
  assert.equal(n.cursor, 13, 'past the row it doesn’t want, up to the next save');
});

test('rows it doesn’t want move the cursor without a message; other environments are left out', () => {
  const n = nextMessage([row(11, { environment: 'prod', at: 'a' }), row(12, { kind: 'sso.add', revision: null, at: 'b' })], { ...hook, environments: ['dev'] }, null, 0);
  assert.deepEqual([n.message.length, n.cursor], [0, 12]);
});

test('a hole at the cursor is waited for, then passed over; a later hole stops the message before it', () => {
  const rows = [row(12, { at: 'a' })];
  const first = nextMessage(rows, hook, null, 1000, 50);
  assert.deepEqual([first.message.length, first.cursor, first.gapSince], [0, 10, 1000], 'row 11 may still be saving');
  assert.deepEqual(nextMessage(rows, hook, 1000, 1020, 50).message.length, 0, 'not yet');
  const later = nextMessage(rows, hook, 1000, 1100, 50);
  assert.deepEqual([later.message.map((r) => r.id), later.gapSince], [[12], null], 'taken for rolled back');
  const two = nextMessage([row(11, { at: 'a' }), row(13, { at: 'a' })], hook, null, 0, 50);
  assert.deepEqual([two.message.map((r) => r.id), two.cursor], [[11], 11]);
});

// ---------------------------------------------------------------- out, end to end

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
const calls: Call[] = [];
let status = 200;
const receiver = (async (url: string, init: RequestInit) => {
  calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: String(init.body) });
  return new Response('ok', { status });
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot({ plugins: builtIns({ webhooks: { fetch: receiver, gapWaitMs: 20, everyMs: 60_000 } }) }); });
after(async () => { await t.stop(); });

const flush = async () => { await t.settle(); await t.settle(); };
const bump = (n: number) => t.editBase('max_upload_mb', 'dev', (layer) => ({ ...layer, defaultVariation: n % 2 ? 'enterprise' : 'standard' }));
const removeAll = async () => {
  for (const w of (await t.as('dana').get('/webhooks')).json.webhooks) await t.as('dana').del(`/webhooks/${w.id}`);
  calls.length = 0;
};

test('only admins add webhooks; the address, headers and signing secret never come back', async () => {
  assert.equal((await t.as('alice').post('/webhooks', { name: 'CI', url: 'https://ci.example.com/hooks/flags' })).status, 403);
  const r = await t.as('dana').post('/webhooks', { name: 'CI', url: 'https://ci.example.com/hooks/flags?key=s3cret', headers: { Authorization: 'Bearer abc' } });
  assert.equal(r.status, 201);
  assert.match(r.json.secret, /^whsec_/);
  const list = (await t.as('alice').get('/webhooks')).json;
  const text = JSON.stringify(list);
  assert.equal(list.webhooks[0].host, 'ci.example.com');
  assert.deepEqual(list.webhooks[0].headerNames, ['Authorization']);
  for (const hidden of ['s3cret', 'Bearer abc', r.json.secret]) assert.ok(!text.includes(hidden), `${hidden} isn’t shown`);
  const h = (await t.as('dana').get('/history?type=webhook')).json;
  assert.ok(!JSON.stringify(h).includes('s3cret'), 'History keeps the host only');
  await removeAll();
});

test('a change is sent once, signed, with what the flag is set to now', async () => {
  const { secret } = (await t.as('dana').post('/webhooks', { name: 'CI', url: 'https://ci.example.com/hooks/flags' })).json;
  calls.length = 0;
  assert.equal((await bump(1)).status, 200);
  await flush();
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['webhook-signature'], sign(secret, c.headers['webhook-id'], Number(c.headers['webhook-timestamp']), c.body), 'Standard Webhooks signature');
  const m = JSON.parse(c.body);
  assert.equal(m.type, 'changes');
  assert.equal(m.data.by.name, 'Alice (editor)');
  assert.equal(m.data.changes[0].kind, 'layer.update');
  assert.equal(m.data.changes[0].flag, 'max_upload_mb');
  assert.equal(m.data.changes[0].environment, 'dev');
  assert.equal(m.data.values.dev.flags.max_upload_mb.value, 1000, 'values: as it is now');
  await flush();
  assert.equal(calls.length, 1, 'not again');
  await removeAll();
});

test('a webhook gets only its environments and events', async () => {
  await t.as('dana').post('/webhooks', { name: 'Prod only', url: 'https://ci.example.com/p', environments: ['prod'] });
  await t.as('dana').post('/webhooks', { name: 'Reviews', url: 'https://ci.example.com/r', events: ['reviews'] });
  calls.length = 0;
  await bump(2);
  await flush();
  assert.equal(calls.length, 0, 'a dev change: neither');
  // prod needs approval: the change becomes a request, which is a review
  const r = await t.editBase('max_upload_mb', 'prod', (layer) => ({ ...layer, defaultVariation: 'huge' }), { reason: 'Bigger uploads' });
  assert.equal(r.status, 202);
  await flush();
  assert.deepEqual(calls.map((c) => c.url), ['https://ci.example.com/r']);
  const m = JSON.parse(calls[0].body);
  assert.equal(m.type, 'reviews');
  assert.match(m.data.changes[0].text, /^Asked for a review of request #\d+$/);
  await removeAll();
});

test('Slack gets words; JSONata makes its own body, and nothing skips the message', async () => {
  await t.as('dana').post('/webhooks', { name: 'Slack', url: 'https://hooks.slack.com/services/T/B/x', format: 'slack' });
  await t.as('dana').post('/webhooks', { name: 'Old system', url: 'https://old.example.com/config', method: 'PUT', format: 'jsonata',
    expression: `type = "changes" ? { "settings": data.values.dev.flags ~> $each(function($v, $k) { { "name": $k, "value": $v.value } }) }` });
  calls.length = 0;
  await bump(3);
  await flush();
  const slack = JSON.parse(calls.find((c) => c.url.includes('slack'))!.body);
  assert.match(slack.text, /^\*Alice \(editor\)\* in \*Development\*\n• Changed settings on max_upload_mb/);
  const old = calls.find((c) => c.url.includes('old'))!;
  assert.equal(old.method, 'PUT');
  assert.deepEqual(JSON.parse(old.body), { settings: { name: 'max_upload_mb', value: 1000 } });
  // a ping isn't "changes": the expression makes nothing of it, so the test sends nothing
  const id = (await t.as('dana').get('/webhooks')).json.webhooks.find((w: { name: string }) => w.name === 'Old system').id;
  calls.length = 0;
  assert.deepEqual((await t.as('dana').post(`/webhooks/${id}/test`)).json, { ok: true, status: null, error: null, skipped: true });
  assert.equal(calls.length, 0);
  assert.equal((await t.as('dana').post('/webhooks', { name: 'Bad', url: 'https://x.example.com', format: 'jsonata', expression: '{ "a": ' })).status, 422);
  await removeAll();
});

test('a failed send is tried again later, in order, and the console says why', async () => {
  await t.as('dana').post('/webhooks', { name: 'Flaky', url: 'https://flaky.example.com' });
  calls.length = 0;
  status = 500;
  await bump(4);
  await flush();
  assert.equal(calls.length, 1);
  let w = (await t.as('dana').get('/webhooks')).json.webhooks[0];
  assert.deepEqual([w.lastStatus, w.lastError, w.attempts], [500, 'It answered 500.', 1]);
  assert.ok(w.nextAttemptAt);
  await bump(5);
  await flush();
  assert.equal(calls.length, 1, 'waits for the retry time, and the next change waits behind it');
  status = 200;
  await t.db.query(`update webhook set next_attempt_at = now()`);
  await flush();
  assert.equal(calls.length, 3, 'the failed one, then the next');
  assert.equal(JSON.parse(calls[1].body).data.changes[0].id, JSON.parse(calls[0].body).data.changes[0].id, 'the same message again');
  w = (await t.as('dana').get('/webhooks')).json.webhooks[0];
  assert.deepEqual([w.lastStatus, w.lastError, w.attempts], [200, null, 0]);
  await removeAll();
});

test('an expression that runs over its limits switches its webhook off, instead of running again and again', async () => {
  const { webhook } = (await t.as('dana').post('/webhooks', { name: 'Greedy', url: 'https://greedy.example.com', format: 'jsonata',
    expression: 'type = "changes" ? $count($sort([1..3000000]))' })).json;
  calls.length = 0;
  await bump(8);
  await flush();
  assert.equal(calls.length, 0, 'nothing sent');
  const w = (await t.as('dana').get('/webhooks')).json.webhooks.find((x: { id: number }) => x.id === webhook.id);
  assert.equal(w.enabled, false, 'switched off');
  assert.match(w.lastError, /more memory than an expression may use.*switched off: fix the expression/);
  assert.equal(w.nextAttemptAt, null, 'not tried again');
  await removeAll();
});

test('switched off, it sends nothing; back on, it goes on from now', async () => {
  const { webhook } = (await t.as('dana').post('/webhooks', { name: 'Paused', url: 'https://p.example.com' })).json;
  await t.as('dana').put(`/webhooks/${webhook.id}`, { enabled: false });
  calls.length = 0;
  await bump(6);
  await flush();
  assert.equal(calls.length, 0);
  await t.as('dana').put(`/webhooks/${webhook.id}`, { enabled: true });
  await flush();
  assert.equal(calls.length, 0, 'what happened while it was off isn’t sent');
  await bump(7);
  await flush();
  assert.equal(calls.length, 1);
  await removeAll();
});

// ---------------------------------------------------------------- in

const send = async (token: string, body: unknown) => {
  const res = await t.app.request(`/hooks/v1/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, any> };
};

test('incoming: another system’s values are imported into the webhook’s environment; the same values again change nothing', async () => {
  assert.equal((await t.as('alice').post('/webhooks/in', { name: 'Old', environment: 'dev', format: 'kv' })).status, 403);
  const { token, webhook } = (await t.as('dana').post('/webhooks/in', { name: 'Old config', environment: 'dev', format: 'kv' })).json;
  assert.match(token, /^ffh_\d+_/);
  // the whole secret: base64url may itself contain _, so it's everything after ffh_<id>_
  assert.ok(!JSON.stringify((await t.as('dana').get('/webhooks')).json).includes(token.replace(/^ffh_\d+_/, '')), 'the address is shown once');
  const r = await send(token, { max_upload_mb: 5000 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.applied, r.json.changed], [true, 1]);
  assert.equal((await t.baseOf('max_upload_mb', 'dev')).layer.defaultVariation, 'huge');
  const h = (await t.as('dana').get('/history?flag=max_upload_mb')).json;
  const entry = h[0];
  assert.equal(entry.changedBy, 'Webhook: Old config');
  assert.equal(entry.comment, 'From the webhook “Old config”');
  const again = await send(token, { max_upload_mb: 5000 });
  assert.deepEqual([again.status, again.json.changed], [200, 0], 'already so: no change, so a webhook out sending it back makes no loop');
  const seen = (await t.as('dana').get('/webhooks')).json.incoming.find((w: { id: number }) => w.id === webhook.id);
  assert.deepEqual([seen.lastStatus, seen.lastResult], [200, 'Nothing to change']);
});

test('incoming: a wrong address, bad JSON, unknown flags and wrong types are refused, and nothing changes', async () => {
  const { token } = (await t.as('dana').post('/webhooks/in', { name: 'Strict', environment: 'dev', format: 'kv' })).json;
  assert.equal((await send(changed(token), { max_upload_mb: 100 })).status, 401);
  assert.equal((await send('nope', {})).status, 401);
  assert.equal((await send(token, '{not json')).status, 400);
  const bad = await send(token, { no_such_flag: true, max_upload_mb: 'big' });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.json.problems, [
    'no_such_flag: there’s no such flag. Turn on “Create missing flags”, or create it first.',
    'max_upload_mb: its values are a number, not "big".',
  ]);
});

test('incoming: a body over 1 MB is refused as it arrives, even sent in chunks (no Content-Length), before the address is checked', async () => {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 3_000_000) { controller.close(); return; }
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
  const res = await t.app.request('/hooks/v1/ffh_1_aaaaaaaaaaaaaaaaaaaaaaaa', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
  } as RequestInit);
  assert.equal(res.status, 413, 'not 401: the size comes first, so a body with no address is never read whole');
  assert.deepEqual(await res.json(), { error: 'the request body is larger than 1 MB' });
  assert.ok(sent < 2_000_000, `stopped reading at ${sent} bytes`);
});

test('incoming into an environment that needs approval: a request for review', async () => {
  const { token } = (await t.as('dana').post('/webhooks/in', { name: 'Old prod', environment: 'prod', format: 'flagd' })).json;
  const r = await send(token, { flags: { max_upload_mb: { state: 'ENABLED', variants: { standard: 100, enterprise: 1000, huge: 5000 }, defaultVariant: 'enterprise',
    targeting: { if: [true, 'huge'] } } } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.applied, false);
  assert.ok(r.json.request);
  assert.deepEqual(r.json.warnings, ['max_upload_mb: its targeting isn’t brought over, only its default and on/off. Add rules in the console.']);
  const cs = (await t.as('bob').get(`/change-sets/${r.json.request}`)).json;
  assert.equal(cs.author ?? cs.changeSet?.author, 'Webhook: Old prod');
});
