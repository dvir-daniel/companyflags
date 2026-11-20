// What webhooks are sent with (server/publicFetch.ts): the public internet only, unless an operator allows an origin on
// their own network. This machine, private networks and a cloud's metadata address are refused before anything is
// sent, however the address is written or whatever a name resolves to, and the webhook's test says the same words
// for every address it couldn't reach, so it can't be used to look around the server's network.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { lookup as dnsLookup } from 'node:dns';
import { boot, builtIns } from './helpers.ts';
import { NotPublicError, publicFetch } from '../server/publicFetch.ts';
import { UNREACHABLE } from '../server/webhooks.ts';

// a service on this machine, as one on the server's network would be: it counts what reaches it
const reached: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
let local: Server;
let port = 0;
before(async () => {
  local = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { reached.push({ method: req.method!, url: req.url!, headers: req.headers, body }); res.writeHead(204).end(); });
  });
  await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
  port = (local.address() as AddressInfo).port;
});
after(() => { local.close(); });

/** Names resolve to these addresses (a test's DNS). */
const dns = (names: Record<string, string[]>) => ((hostname: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) => {
  const list = names[hostname];
  if (!list) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
  cb(null, list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
}) as unknown as typeof dnsLookup;

test('this machine, private networks and the metadata address are refused before anything is sent', async () => {
  const send = publicFetch({ lookup: dns({
    'internal.acme.example': ['10.0.0.1'],
    'rebind.acme.example': ['93.184.215.14', '127.0.0.1'],        // one public address isn't enough: all of them must be
    'me.acme.example': ['::1'],
  }) });
  await assert.rejects(publicFetch()(`http://localhost:${port}/`), NotPublicError, 'this machine’s name, by the system’s own lookup');
  for (const url of [
    `http://127.0.0.1:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`,
    'http://169.254.169.254/latest/api/token', 'http://[::ffff:10.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::1]/', 'http://[fd00::1]/',
    'http://0.0.0.0/', 'http://2130706433/',                              // 127.0.0.1 written as one number
    'http://internal.acme.example/', `http://rebind.acme.example:${port}/`, `http://me.acme.example:${port}/`,
  ]) {
    await assert.rejects(send(url, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }, body: '{}' }), NotPublicError, url);
  }
  assert.equal(reached.length, 0, 'nothing reached the service on this machine');
});

test('an origin the operator allows is reached, with the webhook’s method, headers and body', async () => {
  const send = publicFetch({ allowedOrigins: [`http://127.0.0.1:${port}`] });
  const res = await send(`http://127.0.0.1:${port}/hooks/flags`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-team': 'flags' }, body: '{"a":1}' });
  assert.equal(res.status, 204);
  assert.deepEqual(reached.map((r) => [r.method, r.url, r.headers['x-team'], r.body]), [['PATCH', '/hooks/flags', 'flags', '{"a":1}']]);
  reached.length = 0;
  await assert.rejects(send(`http://127.0.0.2:${port}/`), NotPublicError, 'only that origin');
});

test('a webhook’s test says the same words for every address it couldn’t reach', async (t) => {
  const app = await boot({ plugins: builtIns({ webhooks: { fetch: publicFetch({ allowedOrigins: ['http://127.0.0.1:1'] }) } }) });
  t.after(() => app.stop());
  const tried = async (url: string) => {
    const made = await app.as('dana').post('/webhooks', { name: url, url });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    return (await app.as('dana').post(`/webhooks/${made.json.webhook.id}/test`)).json;
  };
  const answers = [
    await tried(`http://127.0.0.1:${port}/`),                 // something listens here: refused all the same
    await tried('http://169.254.169.254/latest/meta-data/'),
    await tried('http://127.0.0.1:1/'),                       // allowed, but nothing listens
  ];
  for (const a of answers) assert.deepEqual(a, { ok: false, status: null, error: UNREACHABLE });
  assert.equal(reached.length, 0);
});
