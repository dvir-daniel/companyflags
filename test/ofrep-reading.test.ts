// Reading flags over OFREP, the parts a backend or an app leans on to trust an answer (server/ofrep.ts): what each answer
// says about itself (flagMetadata), contexts that would otherwise be read as something else, FLAG_NOT_FOUND in words,
// entities added from a backend as they sign up (PUT /sdk/v1/entities), change events only for the streams whose answers
// changed, and the OFREP web provider end to end: a change event, its refetch, and the cached answer it leaves behind.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { OpenFeature, ProviderEvents } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
import { CSRF, startApp } from './helpers.ts';
import { sampleInstallation } from './sample.ts';
import { createApiKey, rotateAppLink } from '../server/control.ts';
import { appToken } from '../server/delivery.ts';
import { contextProblem, whoseAnswersChanged } from '../server/ofrep.ts';
import { CODE_DEFAULT, type FlagDef, type Layer } from '../server/evaluator.ts';
import { entities, snapshotOf } from './kit.ts';

let t: Awaited<ReturnType<typeof startApp>>;
const system = { name: 'test', type: 'system' as const };
before(async () => {
  t = await startApp({ setup: sampleInstallation, signIn: { kind: 'test-header' } });
  await t.db.query(`insert into app_user (key, name, role) values ('admin', 'Admin', 'admin')`);
});
after(async () => { await t.stop(); });

const BASE = 'http://flags.test';
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  t.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const bulk = async (key: string, context: unknown, headers: Record<string, string> = {}) => {
  const r = await post('/ofrep/v1/evaluate/flags', { context }, { ...bearer(key), ...headers });
  return { status: r.status, etag: r.headers.get('etag'), json: r.status === 200 || r.status >= 400 ? await r.json() as any : null };
};
const one = async (key: string, flag: string, context: unknown) => {
  const r = await post(`/ofrep/v1/evaluate/flags/${flag}`, { context }, bearer(key));
  return { status: r.status, json: await r.json() as any };
};
const apiKey = async (scope: 'all' | 'below' | 'entity' = 'all', entity?: string, project = 'api') =>
  (await createApiKey(t.db, { environment: 'dev', project, scope, entity }, system)).key;

async function layerOf(flag: string, env: string, entity = 'base') {
  const r = await t.app.request(`/api/flags/${flag}`, { headers: { 'x-user': 'admin' } });
  const j = await r.json() as any;
  const l = entity === 'base' ? j.layers[env].base : j.layers[env].entities.find((e: any) => e.entity === entity).layer;
  const { version, updatedAt: _u, updatedBy: _b, ...layer } = l;
  return { version: version as number, layer };
}
async function saveLayer(flag: string, env: string, entity: string, edit: (l: any) => any) {
  const { version, layer } = await layerOf(flag, env, entity);
  const r = await t.app.request(`/api/flags/${flag}/layers/${env}/${entity}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-user': 'admin', ...CSRF },
    body: JSON.stringify({ layer: edit(layer), expectedVersion: version }) });
  assert.equal(r.status, 200, await r.text());
  await t.workers.drain();
}

describe('what an answer says about itself', () => {
  test('every answer names its publish and the entity that asked; a backend’s secret key also gets the rule', async () => {
    const revision = t.plane.get('dev').revision;
    const token = await appToken(t.db, 'dev', 'lumen', 'web');
    const app = await bulk(token, { targetingKey: 'd-1' });
    assert.equal(app.status, 200);
    for (const f of app.json.flags) {
      assert.equal(f.metadata.revision, revision, f.key);
      assert.equal(f.metadata.entity, 'lumen', f.key);
      assert.equal('ruleKey' in f.metadata, false, 'an app never sees which rule decided');
    }
    assert.deepEqual(app.json.metadata, { environment: 'dev', revision, entity: 'lumen' });
    const split = app.json.flags.find((f: any) => f.key === 'new_checkout');
    assert.ok(split.metadata.group, 'a % group’s name stays');

    const all = await apiKey();
    const decided = await one(all, 'max_upload_mb', { company: 'acme' });
    const rule = t.plane.get('dev').flags.max_upload_mb.base.rules[0].ruleKey;
    assert.deepEqual(decided.json.metadata, { revision, entity: 'acme', ruleKey: rule });
    const byDefault = await one(all, 'max_upload_mb', { company: 'initech' });
    assert.deepEqual(byDefault.json.metadata, { revision, entity: 'initech' }, 'no rule decided: no rule key');
    const none = await one(all, 'max_upload_mb', {});
    assert.deepEqual(none.json.metadata, { revision }, 'asked as no entity: no entity');
  });

  test('a publish that changes nothing for this context is still a 304, though the revision moved on', async () => {
    const token = await appToken(t.db, 'dev', 'lumen', 'web');
    const first = await bulk(token, { targetingKey: 'd-1' });
    // a change for another entity only
    await saveLayer('new_checkout', 'dev', 'acme', (l) => ({ ...l, rules: [] }));
    assert.ok(t.plane.get('dev').revision > first.json.metadata.revision);
    assert.equal((await bulk(token, { targetingKey: 'd-1' }, { 'if-none-match': first.etag! })).status, 304);
  });
});

describe('contexts that would be read as something else', () => {
  test('a misspelled dimension, `entity`, or an attribute written dotted: 400 INVALID_CONTEXT, naming the dimensions only', async () => {
    const all = await apiKey();
    for (const context of [{ compnay: 'acme' }, { Company: 'acme' }, { companies: 'acme' }, { brnd: 'lumen', company: 'globex' }, { entity: 'acme' }]) {
      const r = await bulk(all, { targetingKey: 'd-1', ...context });
      assert.equal(r.status, 400, JSON.stringify(context));
      assert.equal(r.json.errorCode, 'INVALID_CONTEXT');
      assert.match(r.json.errorDetails, /name the entity by its dimension: "company", "brand"/);
      assert.doesNotMatch(r.json.errorDetails, /acme|lumen|globex/, 'no entity is named');
    }
    const dotted = await bulk(all, { targetingKey: 'd-1', 'app.version': '6.0.0' });
    assert.equal(dotted.status, 400);
    assert.equal(dotted.json.errorCode, 'INVALID_CONTEXT');
    assert.match(dotted.json.errorDetails, /"app\.version" is written dotted: nest it, \{"app": \{"version": …\}\}/);
    assert.equal((await bulk(all, { device: { 'os.version': '1' } })).status, 200, 'a dotted name that is no attribute is left alone');
    // what isn't a mistake: nested attributes, a dimension, and keys nothing reads
    for (const context of [{ app: { version: '6.0.0' } }, { company: 'acme' }, { email: 'a@example.com', plan: 'pro', userId: 'u-1' }, { companyId: 42 }]) {
      assert.equal((await bulk(all, { targetingKey: 'd-1', ...context })).status, 200, JSON.stringify(context));
    }
  });

  test('the checks on their own, for other dimensions', () => {
    const snap = { dimensions: ['region', 'store'], fields: { region: { valueType: 'string', comesFrom: 'token' }, store: { valueType: 'string', comesFrom: 'token' },
      entity: { valueType: 'string', comesFrom: 'token' }, 'app.version': { valueType: 'semver', comesFrom: 'sdk' }, 'device.id': { valueType: 'string', comesFrom: 'sdk' } } };
    assert.match(contextProblem(snap, { stores: 'acme-12' }) ?? '', /"stores" isn’t a dimension: name the entity by its dimension: "region", "store"/);
    assert.match(contextProblem(snap, { regoin: 'eu' }) ?? '', /"regoin" isn’t a dimension/);
    assert.match(contextProblem(snap, { Store_: 'acme-12' }) ?? '', /isn’t a dimension/);
    assert.equal(contextProblem(snap, { store: 'acme-12', region: 'eu' }), null);
    assert.equal(contextProblem(snap, { storey: 3 }), null, 'only text can name an entity');
    assert.equal(contextProblem(snap, { language: 'en', country: 'US' }), null);
    assert.match(contextProblem(snap, { 'device.id': 'd-1' }) ?? '', /written dotted/);
    assert.match(contextProblem({ dimensions: [], fields: {} }, { entity: 'x' }) ?? '', /no dimensions/);
  });
});

describe('FLAG_NOT_FOUND in words', () => {
  test('a backend’s key hears “not in this service” apart from “no such flag”; an app’s key, one answer for both', async () => {
    const all = await apiKey();
    const notHere = await one(all, 'theme', {});
    assert.equal(notHere.status, 404);
    assert.equal(notHere.json.errorCode, 'FLAG_NOT_FOUND');
    assert.equal(notHere.json.errorDetails, 'the flag "theme" isn’t sent to service "api": add the service on the flag’s Settings tab');
    const nowhere = await one(all, 'no_such_flag', {});
    assert.equal(nowhere.json.errorDetails, 'no flag "no_such_flag" in environment "dev"');

    const web = await appToken(t.db, 'dev', 'acme', 'web');
    const fromApp = await one(web, 'no_such_flag', {});
    assert.equal(fromApp.status, 404);
    assert.equal(fromApp.json.errorDetails, 'no flag "no_such_flag" in service "web": check its key, and that the flag is sent to this service');
  });
});

describe('entities added from a backend as they sign up', () => {
  const put = (key: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    t.app.request(`/sdk/v1/entities/${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(key), ...headers }, body: JSON.stringify(body) });

  test('PUT /sdk/v1/entities/<dimension>/<entity>: an `all` key adds it, and its very next request asks as it', async () => {
    const all = await apiKey();
    assert.equal((await bulk(all, { company: 'stark' })).status, 400, 'not there yet');
    const made = await put(all, 'company/stark', { name: 'Stark Industries' });
    assert.equal(made.status, 201, await made.clone().text());
    assert.deepEqual(await made.json(), { key: 'stark', name: 'Stark Industries', dimension: 'company', parent: null, created: true });
    const asked = await bulk(all, { company: 'stark' });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    assert.equal(asked.json.metadata.entity, 'stark');

    // again: nothing changes; a new name renames it; a new parent is the console's
    const revision = t.plane.get('dev').revision;
    const again = await put(all, 'company/stark', { name: 'Stark Industries' });
    assert.equal(again.status, 200);
    assert.equal((await again.json() as any).created, false);
    await t.workers.drain();
    assert.equal(t.plane.get('dev').revision, revision, 'nothing written: no publish');
    const renamed = await put(all, 'company/stark', { name: 'Stark' });
    assert.equal((await renamed.json() as any).name, 'Stark');
    const moved = await put(all, 'company/stark', { parent: 'acme' });
    assert.equal(moved.status, 409);
    assert.match((await moved.json() as any).error, /move it in the console/);

    // under a parent; no name: the key
    const kid = await put(all, 'brand/stark-kids', { parent: 'stark' });
    assert.equal(kid.status, 201);
    assert.deepEqual(await kid.json(), { key: 'stark-kids', name: 'stark-kids', dimension: 'brand', parent: 'stark', created: true });
    assert.equal((await bulk(all, { company: 'stark', brand: 'stark-kids' })).status, 200);
    assert.equal((await put(all, 'brand/stark', {})).status, 409, 'the key is a company’s');
    assert.equal((await put(all, 'brand/nova', { parent: 'nobody' })).status, 422, 'a parent that isn’t there');
    assert.equal((await put(all, 'company/Not A Key', {})).status, 422);
    assert.equal((await put(all, 'planet/mars', {})).status, 404, 'no such dimension');
  });

  test('only a backend’s key for every entity adds one, never from a browser', async () => {
    const below = await apiKey('below', 'globex');
    const own = await apiKey('entity', 'acme');
    const web = await apiKey('all', undefined, 'web');
    const all = await apiKey();
    for (const key of [below, own, web]) assert.equal((await put(key, 'company/wayne', { name: 'Wayne' })).status, 403);
    assert.equal((await put(all, 'company/wayne', { name: 'Wayne' }, { origin: 'https://shop.example.com' })).status, 403);
    assert.equal((await put('ff_dev_api_nope', 'company/wayne', {})).status, 401);
    const bad = await t.app.request('/sdk/v1/entities/company/wayne', { method: 'PUT', headers: { ...bearer(all), 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    // History says which key added it
    assert.equal((await put(all, 'company/wayne', { name: 'Wayne' })).status, 201);
    const h = (await t.db.query<{ actor: string }>(`select changed_by as actor from change_history where entity = 'wayne' order by id limit 1`)).rows[0];
    assert.match(h?.actor ?? '', /^API key ff_dev_api_/);
  });
});

// ---------------------------------------------------------------- change events, scoped
const reader = (res: Response) => {
  const r = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  // one read at a time, kept across calls: a read that loses the race to the timer still gets the next chunk
  let pending: ReturnType<typeof r.read> | null = null;
  return {
    /** what came, waiting up to `ms` for `re` */
    async until(re: RegExp, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!re.test(text) && Date.now() < deadline) {
        pending ??= r.read();
        const got = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), 50))]);
        if (!got) continue;
        pending = null;
        if (got.done) break;
        if (got.value) text += decoder.decode(got.value);
      }
      return re.test(text);
    },
    take() { const s = text; text = ''; return s; },
    cancel: () => r.cancel().catch(() => {}),
  };
};
const EVENT = /data: \{"type":"refetchEvaluation","etag":"\d+"\}/;

describe('change events reach the streams whose answers changed', () => {
  test('each answer lists its own stream; a change for one entity wakes it and those under it, not the others', async () => {
    const streamOf = async (entity: string) => (await bulk(await appToken(t.db, 'dev', entity, 'web'), {})).json.eventStreams[0].endpoint.requestUri as string;
    const uris = { acme: await streamOf('acme'), globex: await streamOf('globex'), lumen: await streamOf('lumen') };
    assert.match(uris.lumen, /^\/ofrep\/v1\/events\/dev\/web\/lumen\/[\w-]{22}$/);
    const before = (await bulk(await apiKey('all', undefined, 'web'), {})).json.eventStreams[0].endpoint.requestUri as string;
    assert.match(before, /^\/ofrep\/v1\/events\/dev\/web\/[\w-]{22}$/, 'no entity');
    assert.equal((await t.app.request(uris.lumen.replace('/lumen/', '/bolt/'))).status, 404, 'a signature is for its own entity');
    assert.equal((await t.app.request(uris.lumen.replace('/web/', '/ios/'))).status, 404, 'and its own service');

    // an answer from before streams had a scope listed the whole environment's: that address still works, for everything
    const secret = (await t.db.query<{ link_secret: string }>(`select link_secret from environment where key = 'dev'`)).rows[0].link_secret;
    const whole = `/ofrep/v1/events/dev/${createHmac('sha256', secret).update('ofrep-events').digest('base64url').slice(0, 22)}`;
    const listening = Object.fromEntries(await Promise.all([...Object.entries(uris), ['none', before], ['whole', whole]].map(async ([k, uri]) => {
      const res = await t.app.request(uri);
      assert.equal(res.status, 200);
      const s = reader(res);
      assert.ok(await s.until(/: connected/));
      s.take();
      return [k, s] as const;
    })));
    const heard = async () => {
      const got: Record<string, boolean> = {};
      for (const [k, s] of Object.entries(listening)) { got[k] = await s.until(EVENT, 150); s.take(); }
      return got;
    };

    await saveLayer('api_base_url', 'dev', 'globex', (l) => ({ ...l, defaultVariation: 'shared' }));
    assert.deepEqual(await heard(), { acme: false, globex: true, lumen: true, none: false, whole: true }, 'Globex’s own settings: Globex and its brands');
    await saveLayer('max_upload_mb', 'dev', 'base', (l) => ({ ...l, defaultVariation: 'enterprise' }));
    assert.deepEqual(await heard(), { acme: true, globex: true, lumen: true, none: true, whole: true }, 'everyone’s settings: everyone');
    const added = await t.app.request('/sdk/v1/entities/company/oscorp', { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(await apiKey()) }, body: '{"name":"Oscorp"}' });
    assert.equal(added.status, 201);
    await t.workers.drain();
    assert.deepEqual(await heard(), { acme: false, globex: false, lumen: false, none: false, whole: true }, 'a new entity changes nobody’s answers');
    await rotateAppLink(t.db, 'lumen', system);
    await t.workers.drain();
    assert.deepEqual(await heard(), { acme: true, globex: true, lumen: true, none: true, whole: true }, 'nothing it can see changed (a replaced link): everyone, as before');
    for (const s of Object.values(listening)) await s.cancel();
  });

  test('whose answers a publish changed, from the snapshots before and after', () => {
    const ents = entities([['acme', 'Acme', 'company'], ['globex', 'Globex', 'company'], ['lumen', 'Lumen', 'brand', 'globex'], ['bolt', 'Bolt', 'brand', 'globex']]);
    const layer = (over: Partial<Layer> = {}): Layer => ({ version: 1, enabled: null, variationWhenOff: null, defaultVariation: 'a', inherit: 'base_rules_then_customer_default', rules: [], ...over });
    const flag = (key: string, over: Partial<FlagDef> = {}): FlagDef => ({
      key, valueType: 'string', kind: 'config', variations: { a: 'A', b: 'B', [CODE_DEFAULT]: null }, delivery: ['web'],
      base: { version: 1, enabled: true, variationWhenOff: CODE_DEFAULT, defaultVariation: 'a', inherit: null, rules: [] }, entities: {}, ...over,
    });
    const dims = ['company', 'brand'];
    const prev = snapshotOf([flag('f'), flag('g', { delivery: ['ios'] })], ents, dims, { revision: 1 });
    const who = (next: typeof prev) => {
      const reach = whoseAnswersChanged(prev, next);
      return ['web', 'ios'].flatMap((s) => [null, 'acme', 'globex', 'lumen', 'bolt'].filter((e) => reach(s, e)).map((e) => `${s}:${e ?? '-'}`));
    };
    const next = (flags: FlagDef[], e = ents) => snapshotOf(flags, e, dims, { revision: 2 });
    assert.deepEqual(who(next([flag('f', { base: { ...prev.flags.f.base, defaultVariation: 'b' } }), flag('g', { delivery: ['ios'] })])),
      ['web:-', 'web:acme', 'web:globex', 'web:lumen', 'web:bolt'], 'everyone’s settings: every entity of its services');
    assert.deepEqual(who(next([flag('f', { entities: { globex: layer() } }), flag('g', { delivery: ['ios'] })])),
      ['web:globex', 'web:lumen', 'web:bolt'], 'an entity’s own: it and those under it, in its services');
    assert.deepEqual(who(next([flag('f'), flag('g', { delivery: ['ios', 'web'] })])),
      ['web:-', 'web:acme', 'web:globex', 'web:lumen', 'web:bolt', 'ios:-', 'ios:acme', 'ios:globex', 'ios:lumen', 'ios:bolt'], 'its services: the old and the new');
    const moved = entities([['acme', 'Acme', 'company'], ['globex', 'Globex', 'company'], ['lumen', 'Lumen', 'brand', 'acme'], ['bolt', 'Bolt', 'brand', 'globex']]);
    assert.deepEqual(who(next([flag('f'), flag('g', { delivery: ['ios'] })], moved)), ['web:lumen', 'ios:lumen'], 'an entity moved: its own');
    const more = entities([['acme', 'Acme', 'company'], ['globex', 'Globex', 'company'], ['lumen', 'Lumen', 'brand', 'globex'], ['bolt', 'Bolt', 'brand', 'globex'], ['new', 'New', 'company']]);
    assert.deepEqual(who(next([flag('f'), flag('g', { delivery: ['ios'] })], more)), [], 'a new entity: nobody');
    assert.equal(who(next([flag('f'), flag('g', { delivery: ['ios'] })])).length, 10, 'nothing visible changed: everyone');
  });
});

// ---------------------------------------------------------------- the web provider, end to end
/** EventSource for Node (it has none before 24, and the provider needs one): reads the server's stream in-process. */
class TestEventSource extends EventTarget {
  static open: TestEventSource[] = [];
  readyState = 0;
  url: string;
  #cancel = () => {};
  constructor(url: string) {
    super();
    this.url = url;
    TestEventSource.open.push(this);
    void this.#run();
  }
  async #run() {
    const res = await t.app.request(new URL(this.url).pathname);
    if (res.status !== 200 || this.readyState === 2) { this.readyState = 2; this.dispatchEvent(new Event('error')); return; }
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
    const r = res.body!.getReader();
    this.#cancel = () => { r.cancel().catch(() => {}); };
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await r.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += decoder.decode(value);
      for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
        const data = buffer.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        buffer = buffer.slice(i + 2);
        if (data) this.dispatchEvent(new MessageEvent('message', { data }));
      }
    }
  }
  close() { this.readyState = 2; this.#cancel(); TestEventSource.open = TestEventSource.open.filter((s) => s !== this); }
}
/** localStorage for Node: what the provider keeps between visits. */
class MemoryStorage {
  #m = new Map<string, string>();
  getItem(k: string) { return this.#m.get(k) ?? null; }
  setItem(k: string, v: string) { this.#m.set(k, String(v)); }
  removeItem(k: string) { this.#m.delete(k); }
  entries() { return [...this.#m.entries()]; }
}

describe('the OFREP web provider, end to end', () => {
  test('a publish: the change event, the refetch with its revision, the new value, and the cached answer it keeps', async (c) => {
    const g = globalThis as unknown as Record<string, unknown>;
    const storage = new MemoryStorage();
    g.EventSource = TestEventSource;
    g.localStorage = storage;
    c.after(() => { delete g.EventSource; delete g.localStorage; });
    const asked: string[] = [];
    let online = true;
    const fetchApp = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!online) throw new TypeError('offline');
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      asked.push(url.pathname + url.search);
      return t.app.request(url.pathname + url.search, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : await req.text() });
    }) as typeof globalThis.fetch;
    // the docs' cache key (reading/remote-apps.md): the entity's dimensions are in it
    const cacheKeyGenerator = ({ url, auth, domain, targetingKey, context }: { url: string; auth?: string; domain?: string; targetingKey?: string; context: Record<string, unknown> }) =>
      JSON.stringify([url, auth ?? '', domain ?? '', targetingKey ?? '', context.company ?? '', context.brand ?? '']);
    const key = await apiKey('all', undefined, 'web');
    const provider = () => new OFREPWebProvider({ baseUrl: BASE, fetchImplementation: fetchApp, headers: [['Authorization', `Bearer ${key}`]],
      disableVisibilityRefresh: true, cacheKeyGenerator });

    await OpenFeature.setContext('e2e', { targetingKey: 'd-42', company: 'acme' });
    await OpenFeature.setProviderAndWait('e2e', provider());
    const client = OpenFeature.getClient('e2e');
    const before = client.getStringDetails('api_base_url', 'x');
    assert.equal(before.value, 'https://api.example.com');
    assert.equal(before.flagMetadata.entity, 'acme');
    for (let i = 0; i < 100 && !TestEventSource.open.some((s) => s.readyState === 1); i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(TestEventSource.open[0]?.url ?? '', /\/ofrep\/v1\/events\/dev\/web\/acme\//, 'listening to its own stream');

    const changed = new Promise<void>((resolve) => client.addHandler(ProviderEvents.ConfigurationChanged, () => resolve()));
    await saveLayer('api_base_url', 'dev', 'base', (l) => ({ ...l, rules: [{ name: 'Acme moved', conditions: [{ field: 'company', op: 'in', values: ['acme'] }], serveVariation: 'globex' }] }));
    const revision = t.plane.get('dev').revision;
    await Promise.race([changed, new Promise((_, no) => setTimeout(() => no(new Error('no ConfigurationChanged')), 5000))]);
    const after_ = client.getStringDetails('api_base_url', 'x');
    assert.equal(after_.value, 'https://globex.api.example.com', 'the new value, without polling');
    assert.equal(after_.flagMetadata.revision, revision);
    assert.ok(asked.some((p) => p === `/ofrep/v1/evaluate/flags?flagConfigEtag=${revision}`), `refetched with the revision: ${asked.join(' ')}`);
    const saved = storage.entries().map(([, v]) => JSON.parse(v));
    assert.ok(saved.some((e) => e.data.api_base_url?.value === 'https://globex.api.example.com'), 'the cached answer is the new one');
    await OpenFeature.clearProviders();

    // the next visit, offline: it starts from the cache, which has the new answer, for this entity only
    online = false;
    await OpenFeature.setContext('e2e', { targetingKey: 'd-42', company: 'acme' });
    await OpenFeature.setProviderAndWait('e2e', provider());
    const offline = OpenFeature.getClient('e2e').getStringDetails('api_base_url', 'x');
    assert.equal(offline.value, 'https://globex.api.example.com');
    assert.equal(offline.reason, 'CACHED');
    await OpenFeature.clearProviders();
    // the same device, signed in as another entity: nothing cached for it, so not Acme's answer either
    await OpenFeature.setContext('e2e', { targetingKey: 'd-42', company: 'initech' });
    await OpenFeature.setProviderAndWait('e2e', provider()).catch(() => {});
    assert.equal(OpenFeature.getClient('e2e').getStringValue('api_base_url', 'x'), 'x', 'another entity: not Acme’s cached answer');
    await OpenFeature.clearProviders();
    for (const s of TestEventSource.open) s.close();
  });
});
