// Where sign-in rate limits read the client's address (server/betterAuth.ts ipAddressFor): the connection's own address
// by default, which a client can't fake; behind a proxy, the header it sets, or X-Forwarded-For past known proxies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authSettingsFromEnv, CLIENT_IP_HEADER, ipAddressFor } from '../server/betterAuth.ts';

test('no proxy setting: only the address this server read from the connection', () => {
  assert.deepEqual(ipAddressFor(authSettingsFromEnv({})), { ipAddressHeaders: [CLIENT_IP_HEADER] });
});

test('a CDN’s own header, or X-Forwarded-For with the proxies to look past', () => {
  assert.deepEqual(ipAddressFor(authSettingsFromEnv({ FF_CLIENT_IP_HEADER: 'CF-Connecting-IP' })), { ipAddressHeaders: ['cf-connecting-ip'] });
  assert.deepEqual(ipAddressFor(authSettingsFromEnv({ FF_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.4' })),
    { ipAddressHeaders: ['x-forwarded-for'], trustedProxies: ['10.0.0.0/8', '192.168.1.4'] });
});
