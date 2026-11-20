// Every key is for one service in one environment (server/auth.ts). An app service's key is public: it reads its own
// service's values over OFREP, from a browser too, for the context the app sends, and nothing else (no flagd rules,
// no app links, no other service's flags). A backend service's key is secret: a browser holding one is refused.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const keyFor = async (service: string) => {
  const r = await t.as('dana').post('/api-keys', { environment: 'dev', project: service, scope: 'all' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.key as string;
};
const ofrep = (key: string, context: Record<string, unknown>, headers: Record<string, string> = {}) =>
  t.call('POST', '/ofrep/v1/evaluate/flags', { context }, { authorization: `Bearer ${key}`, ...headers });
const BROWSER = { origin: 'https://app.acme.test' };

test('an app service’s key reads its own service’s values over OFREP, from a browser too', async () => {
  const web = await keyFor('web');
  const r = await ofrep(web, { targetingKey: 'device-1' }, BROWSER);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const keys = r.json.flags.map((f: { key: string }) => f.key);
  assert.ok(keys.length > 0);
  assert.ok(!keys.includes('android_quick_share'), 'only in the android service');
  assert.ok(!keys.includes('ds_backend_config'), 'only in a backend service');
  // the app says who it is in the context; with a public key that is targeting, not proof (signed app links are)
  const asCompany = await ofrep(web, { targetingKey: 'device-1', company: 'acme' }, BROWSER);
  assert.equal(asCompany.status, 200, JSON.stringify(asCompany.json));
  // the android app's key sees its own flag
  const android = await ofrep(await keyFor('android'), { targetingKey: 'device-1' });
  assert.ok(android.json.flags.some((f: { key: string }) => f.key === 'android_quick_share'));
});

test('an app service’s key gets no rules and hands out no app links', async () => {
  const web = await keyFor('web');
  const auth = { authorization: `Bearer ${web}` };
  const flagd = await t.call('GET', '/sdk/v1/flagd/company/acme', undefined, auth);
  assert.equal(flagd.status, 403);
  assert.match(flagd.json.error, /values only/);
  const link = await t.call('GET', '/sdk/v1/links/company/acme?service=web', undefined, auth);
  assert.equal(link.status, 403);
  assert.match(link.json.error, /can’t hand out app links/);
});

test('a backend service’s key is refused from a browser, and works from a server', async () => {
  const ds = await keyFor('server-ds');
  const fromBrowser = await ofrep(ds, { targetingKey: 'device-1' }, BROWSER);
  assert.equal(fromBrowser.status, 403);
  assert.match(fromBrowser.json.error, /can’t be used from a browser/);
  assert.equal((await t.call('GET', '/sdk/v1/flagd/company/acme', undefined, { authorization: `Bearer ${ds}`, ...BROWSER })).status, 403);
  const fromServer = await ofrep(ds, { targetingKey: 'device-1', company: 'acme' });
  assert.equal(fromServer.status, 200, JSON.stringify(fromServer.json));
  assert.ok(fromServer.json.flags.some((f: { key: string }) => f.key === 'ds_backend_config'), 'its own backend flag');
  assert.ok(!fromServer.json.flags.some((f: { key: string }) => f.key === 'android_quick_share'), 'not another service’s');
});

test('the links endpoint still takes ?flagSet= from 0.2', async () => {
  const ds = await keyFor('server-ds');
  const r = await t.call('GET', '/sdk/v1/links/company/acme?flagSet=web', undefined, { authorization: `Bearer ${ds}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.service, 'web');
});
