// Where sign-in rate limits read the client's address (server/betterAuth.ts clientAddressFor): the connection's own
// address by default, which a client can't fake. Behind a proxy, the header it sets, or X-Forwarded-For past the
// proxies, but only on a connection from one of the proxies: a client that reaches the server directly is its own
// address, whatever headers it sends, so it can't get a new allowance of sign-in tries with each request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authSettingsFromEnv, CLIENT_IP_HEADER, clientAddressFor, clientIpProblem, ipAddressFor, rateLimitsOn, SetupError } from '../server/betterAuth.ts';
import { startApp } from './helpers.ts';

const ask = (env: Record<string, string>) => clientAddressFor(authSettingsFromEnv(env));
const headers = (h: Record<string, string>) => new Headers(h);

test('Better Auth reads only the address this server sets', () => {
  assert.deepEqual(ipAddressFor(), { ipAddressHeaders: [CLIENT_IP_HEADER] });
});

test('no proxy setting: the connection’s own address, whatever the headers say', () => {
  const address = ask({});
  assert.equal(address(headers({ 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' }), '203.0.113.9'), '203.0.113.9');
  assert.equal(address(headers({}), '::ffff:198.51.100.7'), '198.51.100.7', 'an IPv4 address written as IPv6');
  assert.equal(address(headers({}), undefined), undefined, 'no connection (a test’s request)');
});

test('a CDN’s own header: believed from the proxies only', () => {
  const address = ask({ FF_CLIENT_IP_HEADER: 'CF-Connecting-IP', FF_TRUSTED_PROXIES: '10.0.0.0/8' });
  const cf = (ip: string) => headers({ 'cf-connecting-ip': ip });
  assert.equal(address(cf('198.51.100.7'), '10.1.2.3'), '198.51.100.7', 'from the proxy');
  for (const fake of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
    assert.equal(address(cf(fake), '203.0.113.9'), '203.0.113.9', 'a client that reaches the server directly: its own address, each time');
  }
  assert.equal(address(cf('not an address'), '10.1.2.3'), '10.1.2.3', 'a header that isn’t an address: the proxy’s');
});

test('X-Forwarded-For: the last address that isn’t a proxy, from the proxies only', () => {
  const address = ask({ FF_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.4' });
  const xff = (v: string) => headers({ 'x-forwarded-for': v });
  assert.equal(address(xff('6.6.6.6, 198.51.100.7, 192.168.1.4'), '10.0.0.2'), '198.51.100.7', 'past both proxies; what the client wrote first is ignored');
  assert.equal(address(xff('6.6.6.6'), '203.0.113.9'), '203.0.113.9', 'a client that reaches the server directly');
  assert.equal(address(xff('192.168.1.4'), '10.0.0.2'), '10.0.0.2', 'only proxies: the connection’s');
});

test('sign-in has rate limits unless NODE_ENV says development or test: a server started without it has them', () => {
  const on = (NODE_ENV?: string) => rateLimitsOn(authSettingsFromEnv(NODE_ENV === undefined ? {} : { NODE_ENV }));
  assert.deepEqual([on(), on('production'), on('staging'), on('development'), on('test')], [true, true, true, false, false]);
  assert.equal(rateLimitsOn({}), false, 'settings made in code, without saying: production only');
  assert.equal(rateLimitsOn({ production: true }), true);
});

test('a header without the proxies’ addresses, or a range that isn’t one, doesn’t start', async () => {
  assert.match(clientIpProblem(authSettingsFromEnv({ FF_CLIENT_IP_HEADER: 'cf-connecting-ip' })) ?? '', /needs FF_TRUSTED_PROXIES/);
  assert.match(clientIpProblem(authSettingsFromEnv({ FF_TRUSTED_PROXIES: '10.0.0.0/99' })) ?? '', /isn’t an address or a range/);
  assert.equal(clientIpProblem(authSettingsFromEnv({ FF_TRUSTED_PROXIES: '10.0.0.0/8, fd00::/8, 192.168.1.4' })), null);
  await assert.rejects(startApp({ signIn: { kind: 'better-auth', settings: authSettingsFromEnv({ FF_CLIENT_IP_HEADER: 'cf-connecting-ip' }) } }), SetupError);
});

test('the change-event streams read the same proxy setting as sign-in, from the config file too (auth.clientIp)', async (c) => {
  const { definePlugin } = await import('../server/plugin.ts');
  let seen: unknown = 'not set up';
  const probe = definePlugin({ id: 'probe', setup: (ctx) => { seen = ctx.clientIp; return {}; } });
  const clientIp = { trustedProxies: ['10.0.0.0/8'], header: 'x-real-ip' };
  const app = await startApp({ signIn: { kind: 'better-auth', settings: { clientIp } }, plugins: [probe] });
  c.after(() => app.stop());
  assert.deepEqual(seen, clientIp, 'the plugins get the setting sign-in uses (server/ofrep.ts builds the stream limits from it)');
});
