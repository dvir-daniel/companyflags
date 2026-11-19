// OpenFeature's own providers against the server (server/ofrep.ts, OFREP 0.4): the OFREP web provider an app uses, with
// its entity's app link as the token, and the OFREP server provider a backend uses, with an API key. Every answer must
// equal the server's evaluator for that entity and device. Then the protocol's edges: who may ask about whom, 304s,
// the code default, errors and CORS.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenFeature as WebOpenFeature } from '@openfeature/web-sdk';
import { OpenFeature as ServerOpenFeature } from '@openfeature/server-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
import { OFREPProvider } from '@openfeature/ofrep-provider';
import { CSRF, startApp } from './helpers.ts';
import { sampleInstallation } from './sample.ts';
import { createApiKey, rotateClientLink } from '../server/control.ts';
import { contextFor, evaluate } from '../server/evaluator.ts';
import { appToken } from '../server/delivery.ts';

let t: Awaited<ReturnType<typeof startApp>>;
const system = { name: 'test', type: 'system' as const };
before(async () => {
  t = await startApp({ setup: sampleInstallation, signIn: { kind: 'test-header' } });
  await t.db.query(`insert into app_user (key, name, role) values ('admin', 'Admin', 'admin')`);
});
after(async () => { await t.stop(); });

const BASE = 'http://flags.test';
/** fetch, straight into the server */
const fetchApp = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  return t.app.request(new URL(req.url).pathname + new URL(req.url).search, {
    method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : await req.text(),
  });
}) as typeof globalThis.fetch;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  t.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** What the server's evaluator answers, as OpenFeature returns it: the value, or the default for the code default. */
function expected(env: string, project: string, entity: string | null, attrs: Record<string, unknown>, key: string, d: unknown) {
  const snap = t.plane.get(env);
  const r = evaluate(snap, key, contextFor(snap, { project, entity }, attrs, { trust: 'app' }), false);
  return r.codeDefault || r.errorCode ? d : r.value;
}
const tokenFor = (env: string, app: string, entity: string) => appToken(t.db, env, entity, app);

describe('an app with the OFREP web provider and its app link', () => {
  test('every flag is the server’s answer, for each context, and a publish reaches it', async () => {
    const token = await tokenFor('dev', 'web', 'lumen');
    const provider = new OFREPWebProvider({
      baseUrl: BASE, fetchImplementation: fetchApp, headers: [['Authorization', `Bearer ${token}`]],
      changeDetection: 'none', cacheMode: 'disabled', disableVisibilityRefresh: true,
    });
    await WebOpenFeature.setContext({ targetingKey: 'd-1', app: { version: '6.0.0' }, locale: { language: 'he' } });
    await WebOpenFeature.setProviderAndWait(provider);
    const client = WebOpenFeature.getClient();
    const attrs = { 'device.id': 'd-1', 'app.version': '6.0.0', 'locale.language': 'he' };

    assert.equal(client.getStringValue('api_base_url', 'x'), 'https://globex.api.example.com', 'a brand follows its company');
    assert.deepEqual(client.getObjectValue('theme', {}), { accent: '#f59e0b', radius: 12 });
    for (const [key, d] of [['new_checkout', false], ['payments_enabled', false], ['max_upload_mb', 1], ['welcome_message', 'code']] as const) {
      const got = typeof d === 'boolean' ? client.getBooleanValue(key, d) : typeof d === 'number' ? client.getNumberValue(key, d) : client.getStringValue(key, d);
      assert.deepEqual(got, expected('dev', 'web', 'lumen', attrs, key, d), key);
    }
    assert.equal(client.getStringValue('welcome_message', 'code'), 'ברוכים הבאים!');

    await WebOpenFeature.setContext({ targetingKey: 'd-2', locale: { language: 'en' } });
    assert.equal(client.getStringValue('welcome_message', 'from the app'), 'from the app', 'the code default: no value sent');
    const details = client.getStringDetails('no_such_flag', 'fallback');
    assert.equal(details.value, 'fallback');
    assert.equal(details.errorCode, 'FLAG_NOT_FOUND');

    // a publish (payments off): the provider's next fetch has the new answers
    assert.equal(client.getBooleanValue('payments_enabled', false), true);
    const { version, layer } = await layerOf('payments_enabled', 'dev');
    const r = await t.app.request('/api/flags/payments_enabled/layers/dev/base', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-user': 'admin', ...CSRF },
      body: JSON.stringify({ layer: { ...layer, enabled: false }, expectedVersion: version }) });
    assert.equal(r.status, 200, await r.text());
    await t.workers.drain();
    await WebOpenFeature.setContext({ targetingKey: 'd-3' });
    assert.equal(client.getBooleanValue('payments_enabled', false), false, 'off: nothing is sent, the app’s own default');
    await WebOpenFeature.close();
  });
});

async function layerOf(flag: string, env: string) {
  const r = await t.app.request(`/api/flags/${flag}`, { headers: { 'x-user': 'admin' } });
  const { version, updatedAt: _u, updatedBy: _b, ...layer } = (await r.json() as any).layers[env].base;
  return { version: version as number, layer };
}

describe('a backend with the OFREP server provider and an API key', () => {
  test('per-request contexts name the entity by its dimension; answers equal the server’s', async () => {
    const { key } = await createApiKey(t.db, { environment: 'prod', project: 'api', scope: 'all' }, system);
    await ServerOpenFeature.setProviderAndWait(new OFREPProvider({ baseUrl: BASE, fetchImplementation: fetchApp, headers: [['Authorization', `Bearer ${key}`]] }));
    const client = ServerOpenFeature.getClient();
    for (const entity of ['globex', 'lumen', 'acme', 'initech', null]) {
      const ctx = { targetingKey: 'd-7', ...(entity ? { [t.plane.get('prod').entities[entity].dimension]: entity } : {}) };
      const attrs = { 'device.id': 'd-7' };
      assert.equal(await client.getStringValue('api_base_url', 'x', ctx), expected('prod', 'api', entity, attrs, 'api_base_url', 'x'), `${entity}`);
      assert.equal(await client.getNumberValue('max_upload_mb', 1, ctx), expected('prod', 'api', entity, attrs, 'max_upload_mb', 1), `${entity}`);
    }
    const missing = await client.getBooleanDetails('theme', false, { company: 'acme' });
    assert.equal(missing.errorCode, 'FLAG_NOT_FOUND', 'theme isn’t sent to the backend');
    await ServerOpenFeature.close();
  });
});

describe('the protocol', () => {
  test('who may ask about whom', async () => {
    const all = (await createApiKey(t.db, { environment: 'dev', project: 'api', scope: 'all' }, system)).key;
    const below = (await createApiKey(t.db, { environment: 'dev', project: 'api', scope: 'below', entity: 'globex' }, system)).key;
    const own = (await createApiKey(t.db, { environment: 'dev', project: 'api', scope: 'entity', entity: 'acme' }, system)).key;
    const bulk = (auth: Record<string, string>, context: unknown) => post('/ofrep/v1/evaluate/flags', { context }, auth);
    const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

    assert.equal((await bulk({}, {})).status, 401, 'no credential');
    assert.equal((await bulk(bearer('ff_dev_api_nope'), {})).status, 401);
    assert.equal((await bulk({ 'x-api-key': all }, { company: 'acme' })).status, 200, 'OFREP’s X-API-Key header');
    assert.equal((await bulk(bearer(below), { brand: 'lumen' })).status, 200, 'below its entity');
    assert.equal((await bulk(bearer(below), { company: 'acme' })).status, 403, 'outside its scope');
    assert.equal((await bulk(bearer(own), { company: 'globex' })).status, 403);
    assert.equal((await bulk(bearer(all), { company: 'nobody' })).status, 400, 'no such entity');
    const mismatch = await bulk(bearer(all), { company: 'acme', brand: 'lumen' });
    assert.equal(mismatch.status, 400, 'a brand under another company');
    assert.equal((await mismatch.json() as any).errorCode, 'INVALID_CONTEXT');
    assert.equal((await bulk(bearer(all), { company: 'globex', brand: 'lumen' })).status, 200, 'the chain agrees');

    // a key for one entity that names none asks as its entity; an `all` key, as no entity
    const asOwn = await (await bulk(bearer(own), { targetingKey: 'd-1' })).json() as any;
    assert.equal(asOwn.flags.find((f: any) => f.key === 'max_upload_mb').value, 1000, 'acme is an enterprise company');
    const asNone = await (await bulk(bearer(all), { targetingKey: 'd-1' })).json() as any;
    assert.equal(asNone.flags.find((f: any) => f.key === 'max_upload_mb').value, 100);

    // the app's token: only its own entity, and a replaced link stops it at once
    const token = await tokenFor('dev', 'web', 'lumen');
    assert.equal((await bulk(bearer(token), {})).status, 200);
    assert.equal((await bulk(bearer(token), { company: 'acme' })).status, 403);
    assert.equal((await bulk(bearer(token), { company: 'globex', brand: 'lumen' })).status, 200, 'naming itself and its company');
    assert.equal((await bulk(bearer(token.replace('.web.', '.api.')), {})).status, 401, 'a backend has no app token');
    assert.equal((await bulk(bearer(token.replace('.web.', '.ios.')), {})).status, 401, 'a token is bound to its app');
    assert.equal((await bulk(bearer(await tokenFor('dev', 'ios', 'lumen')), {})).status, 200, 'the app’s own token');
    assert.equal((await bulk(bearer(token.slice(0, -2) + 'xx'), {})).status, 401);
    await rotateClientLink(t.db, 'lumen', system);
    assert.equal((await bulk(bearer(token), {})).status, 401, 'the replaced link’s token');
    assert.equal((await bulk(bearer(await tokenFor('dev', 'web', 'lumen')), {})).status, 200, 'the new one');
  });

  test('bulk: an ETag, a 304 while nothing changed; the code default has no value', async () => {
    const all = (await createApiKey(t.db, { environment: 'dev', project: 'api', scope: 'all' }, system)).key;
    const auth = { authorization: `Bearer ${all}` };
    const first = await post('/ofrep/v1/evaluate/flags', { context: { targetingKey: 'd-1', company: 'acme' } }, auth);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag')!;
    assert.match(etag, /^W\/"/);
    const body = await first.json() as any;
    assert.ok(Array.isArray(body.flags));
    assert.equal((await post('/ofrep/v1/evaluate/flags', { context: { targetingKey: 'd-1', company: 'acme' } }, { ...auth, 'if-none-match': etag })).status, 304);
    assert.equal((await post('/ofrep/v1/evaluate/flags', { context: { targetingKey: 'd-1', company: 'globex' } }, { ...auth, 'if-none-match': etag })).status, 200, 'another context');

    const one = await post('/ofrep/v1/evaluate/flags/max_upload_mb', { context: { company: 'acme' } }, auth);
    assert.equal(one.status, 200);
    const a = await one.json() as any;
    assert.equal(a.key, 'max_upload_mb');
    assert.equal(a.value, 1000);
    assert.equal(a.variant, 'enterprise');
    assert.ok(a.reason);

    const web = await tokenFor('dev', 'web', 'acme');
    const welcome = await (await post('/ofrep/v1/evaluate/flags/welcome_message', { context: { locale: { language: 'en' } } }, { authorization: `Bearer ${web}` })).json() as any;
    assert.equal('value' in welcome, false, 'the code default: no value, the app keeps its own');
    assert.equal('variant' in welcome, false, 'and no inner variant name');
    assert.ok(welcome.reason);

    const notFound = await post('/ofrep/v1/evaluate/flags/theme', { context: {} }, auth);
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json() as any).errorCode, 'FLAG_NOT_FOUND');
    const bad = await t.app.request('/ofrep/v1/evaluate/flags', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as any).errorCode, 'PARSE_ERROR');
    assert.equal((await post('/ofrep/v1/evaluate/flags', { nocontext: true }, auth)).status, 400);
  });

  test('browsers may call it from any origin, with the key in a header', async () => {
    const pre = await t.app.request('/ofrep/v1/evaluate/flags', { method: 'OPTIONS', headers: {
      origin: 'https://shop.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,if-none-match' } });
    assert.ok(pre.status === 204 || pre.status === 200);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/i);
    assert.equal((await t.app.request('/ofrep/v1/nope', { method: 'POST' })).status, 404);
  });
  test('change events: the bulk answer lists a stream that says refetchEvaluation on every publish in its environment', async () => {
    const token = await tokenFor('dev', 'web', 'acme');
    const bulk = await (await post('/ofrep/v1/evaluate/flags', { context: {} }, { authorization: `Bearer ${token}` })).json() as any;
    assert.equal(bulk.eventStreams.length, 1);
    const [es] = bulk.eventStreams;
    assert.equal(es.type, 'sse');
    assert.match(es.endpoint.requestUri, /^\/ofrep\/v1\/events\/dev\/[\w-]{22}$/);
    assert.equal((await t.app.request(es.endpoint.requestUri.replace(/[\w-]{22}$/, 'x'.repeat(22)))).status, 404, 'a made-up signature');
    assert.equal((await t.app.request('/ofrep/v1/events/prod/' + es.endpoint.requestUri.split('/').pop())).status, 404, 'another environment’s');

    const res = await t.app.request(es.endpoint.requestUri, { headers: { origin: 'https://shop.example.com' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (re: RegExp) => {
      const deadline = Date.now() + 5000;
      while (!re.test(text) && Date.now() < deadline) {
        const { value, done } = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: false }), 200))]);
        if (done) break;
        if (value) text += decoder.decode(value);
      }
      assert.match(text, re);
    };
    await until(/: connected/);
    const { version, layer } = await layerOf('max_upload_mb', 'dev');
    const r = await t.app.request('/api/flags/max_upload_mb/layers/dev/base', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-user': 'admin', ...CSRF },
      body: JSON.stringify({ layer: { ...layer, defaultVariation: 'enterprise' }, expectedVersion: version }) });
    assert.equal(r.status, 200, await r.text());
    await t.workers.drain();
    await until(/data: \{"type":"refetchEvaluation","etag":"\d+"\}/);
    await reader.cancel();
  });
});
