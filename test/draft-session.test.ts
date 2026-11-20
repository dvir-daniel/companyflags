// The draft session (web/src/draftSession.ts), at its interface: one person's draft in one environment, kept in
// storage, checked for newer versions, rebased and published. The HTTP adapter goes through the app's own request
// handler (boot()), so every answer is the real server's; storage is in memory.
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError, type Meta } from '../web/src/api.ts';
import { DraftSession, memoryStorage, StaleDraftError, storageKey, type DraftStorage, type Http } from '../web/src/draftSession.ts';
import { hiddenKey, setOwnValues, setVariantValues, type Line } from '../web/src/lines.ts';
import { boot } from './helpers.ts';

let t: Awaited<ReturnType<typeof boot>>;
let meta: Meta;
before(async () => { t = await boot(); meta = (await t.as('alice').get('/meta')).json; });
after(async () => { await t.stop(); });

/** The console's api() for one person, over the app's request handler: a failure throws ApiError with the server's code. */
const httpAs = (user: string, log?: string[]): Http => async (method, path, body) => {
  log?.push(`${method} ${path}`);
  const r = await t.call(method, `/api${path}`, method === 'GET' ? undefined : body ?? {}, { 'x-user': user });
  if (r.status >= 400) throw new ApiError(r.status, r.json);
  return r.json;
};
const sessionOf = (env: string, o: { storage?: DraftStorage; log?: string[]; debounceMs?: number } = {}) =>
  new DraftSession({ person: 'alice', env, http: httpAs('alice', o.log), storage: o.storage ?? memoryStorage(), debounceMs: o.debounceMs });
const opened = async (s: DraftSession, ...flags: string[]) => { for (const f of flags) { s.open(f); await s.refresh(f); } return s; };
const stored = (storage: DraftStorage, env: string) => JSON.parse(storage.getItem(storageKey('alice', env)) ?? 'null');
const flagNow = async (key: string) => (await t.as('alice').get(`/flags/${key}`)).json;
const rule = (more: Partial<Line> = {}): Line => ({
  id: randomUUID(), entity: null, locked: false, paused: false, name: null, conditions: [{ field: 'project', op: 'in', values: ['web'] }],
  serveVariation: 'huge', split: null, ...more,
});

test('opening a flag and editing it: what changed, as items and sentences, with lines kept in order', async () => {
  // the first paint shows the console's last copy; opening keeps the very same lines
  const known = await flagNow('max_upload_mb');
  const first = sessionOf('dev');
  const painted = first.view('max_upload_mb', meta, known);
  assert.equal(painted.status, 'ready');
  first.open('max_upload_mb', known);
  assert.equal(first.view('max_upload_mb', meta).draft, painted.draft);

  const s = await opened(sessionOf('dev'), 'max_upload_mb');
  const open = s.view('max_upload_mb', meta);
  assert.equal(open.status, 'ready');
  assert.equal(open.changed, false);
  assert.equal(s.summary(meta).flags.length, 0);

  // an override added last is put first (evaluation order), and the flag is in the draft
  const override = rule({ locked: true });
  s.edit('max_upload_mb', (d) => ({ ...d, lines: [...d.lines, override] }));
  const v = s.view('max_upload_mb', meta);
  assert.equal(v.changed, true);
  assert.equal(v.draft!.lines[0].id, override.id);
  assert.deepEqual(v.items.map((i) => [i.flag, i.entity, i.expectedVersion]), [['max_upload_mb', null, open.live!.layers.dev.base.version]]);
  assert.equal(v.sentences.length, 1);
  assert.match(v.sentences[0], /^Add override: .+ → 5000$/);              // an override is called one
  assert.deepEqual(v.problems, []);
  assert.equal(s.summary(meta).has('max_upload_mb'), true);
  assert.equal(s.summary(meta).changes, 1);
  assert.equal(s.view('max_upload_mb', meta), v, 'the same view until something changes');

  // an incomplete rule is a problem from the shared checks
  const empty = rule({ conditions: [{ field: 'project', op: 'in', values: [] }] });
  s.edit('max_upload_mb', (d) => ({ ...d, lines: [...d.lines, empty] }));
  assert.deepEqual(s.view('max_upload_mb', meta).problems.map((p) => p.line), [empty.id]);

  // undoing every edit takes the flag out of the draft
  s.edit('max_upload_mb', (d) => ({ ...d, lines: d.lines.filter((l) => l.id !== override.id && l.id !== empty.id) }));
  assert.equal(s.view('max_upload_mb', meta).changed, false);
  assert.equal(s.summary(meta).has('max_upload_mb'), false);
});

test('a saved draft someone else changed since: found at review and before publish, refused, then rebased keeping my edits', async () => {
  const storage = memoryStorage();
  const mine = await opened(sessionOf('dev', { storage }), 'welcome_message');
  mine.edit('welcome_message', (d) => ({ ...d, fallback: 'holiday' }));
  mine.close();

  // Bob adds a rule for everyone to the same layer
  const base = (await flagNow('welcome_message')).layers.dev.base;
  const bobs = { ruleKey: randomUUID(), name: 'Holiday on web', locked: false, disabled: false, conditions: [{ field: 'project', op: 'in', values: ['web'] }], serveVariation: 'holiday', split: null };
  const put = await t.as('bob').put('/flags/welcome_message/layers/dev/base', { layer: { ...base, rules: [...base.rules, bobs] }, expectedVersion: base.version });
  assert.equal(put.status, 200, JSON.stringify(put.json));

  // the review opens (the browser came back later): the session asks the server for every flag in the draft
  assert.deepEqual(await sessionOf('dev', { storage }).checkStale(), ['welcome_message']);

  // publishing without the rebase is refused before anything is sent
  const log: string[] = [];
  const s = sessionOf('dev', { storage, log });
  await assert.rejects(s.publish({ meta }), (e) => e instanceof StaleDraftError && e.code === 'stale' && e.flags.join() === 'welcome_message');
  assert.deepEqual(log.filter((l) => !l.startsWith('GET')), []);
  assert.deepEqual(s.summary(meta).stale, ['welcome_message']);
  assert.equal((await flagNow('welcome_message')).layers.dev.base.defaultVariation, 'code_default');

  // keep my edits on the new version: my default stays, Bob's rule stays
  assert.deepEqual(await s.rebase(), ['welcome_message']);
  const [g] = s.summary(meta).flags;
  assert.equal(g.stale, false);
  assert.deepEqual(g.sentences, ['Default: the in-app default, now holiday']);
  assert.equal(g.items[0].expectedVersion, base.version + 1);
  const res = await s.publish({ meta });
  assert.equal(res.applied, true);
  const after = (await flagNow('welcome_message')).layers.dev.base;
  assert.equal(after.defaultVariation, 'holiday');
  assert.ok(after.rules.some((r: { ruleKey: string }) => r.ruleKey === bobs.ruleKey));
  assert.equal(s.summary(meta).flags.length, 0);
  assert.equal(storage.getItem(storageKey('alice', 'dev')), null);
});

test('another write path in this browser tells the session what it changed: the draft is stale at once', async () => {
  const s = await opened(sessionOf('dev'), 'api_base_url');
  s.edit('api_base_url', (d) => ({ ...d, fallback: 'wonka' }));
  // a brand-style "use its company's again": Vandelay's own settings removed, as Customers.tsx does it
  const ms = (await flagNow('api_base_url')).layers.dev.entities.find((c: { entity: string }) => c.entity === 'vandelay');
  const r = await t.as('alice').post('/environments/dev/publish', { items: [{ flag: 'api_base_url', entity: 'vandelay', expectedVersion: ms.layer.version, layer: null }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const told = s.noteChanged(['api_base_url']);
  assert.deepEqual(s.summary(meta).stale, ['api_base_url'], 'marked before the server answers');
  await told;
  assert.deepEqual(s.summary(meta).stale, ['api_base_url']);
  await s.rebase(['api_base_url']);
  assert.deepEqual(s.summary(meta).flags[0].sentences, ['Default: default, now wonka'], 'Vandelay stays removed');
  assert.equal((await s.publish({ meta })).applied, true);
  const now = (await flagNow('api_base_url')).layers.dev;
  assert.equal(now.base.defaultVariation, 'wonka');
  assert.equal(now.entities.some((c: { entity: string }) => c.entity === 'vandelay'), false);
});

test('publishing goes values → submit → clear, as one version with the sentences in its note', async () => {
  const log: string[] = [];
  const storage = memoryStorage();
  const key = storageKey('alice', 'dev');
  const logged: DraftStorage = {
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => { if (k === key) log.push('save'); storage.setItem(k, v); },
    removeItem: (k) => { if (k === key) log.push('clear'); storage.removeItem(k); },
  };
  const s = await opened(sessionOf('dev', { storage: logged, log }), 'ds_backend_config', 'dark_mode_v2');
  const value = { host: 'ds-oscorp.internal', poolSize: 5 };
  const hidden = hiddenKey(value);
  s.edit('ds_backend_config', (d) => setOwnValues(d, ['oscorp'], hidden, { key: hidden, value }));
  s.edit('dark_mode_v2', (d) => ({ ...d, fallback: 'on' }));
  s.flush();
  log.length = 0;

  const res = await s.publish({ meta, reason: 'Oscorp pool' });
  assert.deepEqual(log.filter((l) => !l.startsWith('GET')), ['PUT /flags/ds_backend_config/variations', 'POST /environments/dev/publish', 'clear']);
  assert.equal(res.applied, true);
  assert.deepEqual([...res.flags].sort(), ['dark_mode_v2', 'ds_backend_config']);
  assert.equal(s.summary(meta).flags.length, 0);
  assert.equal(storage.getItem(key), null);

  const ds = await flagNow('ds_backend_config');
  assert.ok(ds.variations.some((v: { key: string }) => v.key === hidden));
  assert.equal(ds.layers.dev.entities.find((c: { entity: string }) => c.entity === 'oscorp')?.layer.rules[0].serveVariation, hidden);
  const version = (await t.as('alice').get('/environments/dev/versions?page=0&size=1')).json.rows[0];
  assert.equal(version.revision, res.revision);
  assert.match(version.comment, /^Oscorp pool\n\n/);
  assert.match(version.comment, /dark_mode_v2: Default: false, now true/);
});

test('in a protected environment publishing makes one change set covering every flag', async () => {
  const log: string[] = [];
  const s = await opened(sessionOf('prod', { log }), 'max_upload_mb', 'payments_enabled');
  s.edit('max_upload_mb', (d) => ({ ...d, fallback: 'huge' }));
  s.edit('payments_enabled', (d) => ({ ...d, fallback: 'off' }));
  assert.equal(s.summary(meta).needsReview, true);
  const before = (await t.as('alice').get('/change-sets')).json.length;

  log.length = 0;
  await assert.rejects(s.publish({ meta }), /reason/);                       // the reviewer needs one, so nothing is sent
  assert.deepEqual(log, []);

  const res = await s.publish({ meta, reason: 'Bigger uploads, payments off' });
  assert.equal(res.applied, false);
  assert.equal(typeof res.changeSetId, 'number');
  const cs = (await t.as('alice').get(`/change-sets/${res.changeSetId}`)).json;
  assert.deepEqual(cs.items.map((i: { flag: string }) => i.flag).sort(), ['max_upload_mb', 'payments_enabled']);
  assert.equal((await t.as('alice').get('/change-sets')).json.length, before + 1);
  assert.equal((await flagNow('max_upload_mb')).layers.prod.base.defaultVariation, 'standard');   // nothing live yet
  assert.equal(s.summary(meta).flags.length, 0);
});

test('edits are written after a pause, or at once on flush and close; an entry keeps only this environment', async () => {
  const storage = memoryStorage();
  const key = storageKey('alice', 'dev');
  const s = await opened(sessionOf('dev', { storage, debounceMs: 400 }), 'max_upload_mb');
  const close = s.open('max_upload_mb');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    s.edit('max_upload_mb', (d) => ({ ...d, fallback: 'huge' }));
    assert.equal(storage.getItem(key), null);
    mock.timers.tick(399);
    s.edit('max_upload_mb', (d) => ({ ...d, fallback: 'enterprise' }));       // typing again starts the wait again
    mock.timers.tick(399);
    assert.equal(storage.getItem(key), null);
    mock.timers.tick(1);
    assert.equal(stored(storage, 'dev').flags.max_upload_mb.draft.fallback, 'enterprise');
    s.edit('max_upload_mb', (d) => ({ ...d, fallback: 'huge' }));
    assert.equal(stored(storage, 'dev').flags.max_upload_mb.draft.fallback, 'enterprise');
    close();                                                                  // leaving the flag writes what's waiting
    assert.equal(stored(storage, 'dev').flags.max_upload_mb.draft.fallback, 'huge');
  } finally {
    mock.timers.reset();
  }
  const entry = stored(storage, 'dev');
  assert.equal(entry.version, 2);
  assert.deepEqual(Object.keys(entry.flags.max_upload_mb.based).sort(), ['kind', 'layers', 'valueType', 'variations']);
  assert.deepEqual(Object.keys(entry.flags.max_upload_mb.based.layers).sort(), ['base', 'entities']);
  assert.deepEqual(entry.flags.max_upload_mb.based.layers, (await flagNow('max_upload_mb')).layers.dev);
});

test('a stored entry that fails the shape check is dropped and reported, never thrown; a full storage is reported once', async () => {
  const storage = memoryStorage();
  const first = await opened(sessionOf('dev', { storage }), 'max_upload_mb');
  first.edit('max_upload_mb', (d) => ({ ...d, fallback: 'huge' }));
  first.close();
  const kept = stored(storage, 'dev');
  storage.setItem(storageKey('alice', 'dev'), JSON.stringify({ ...kept, flags: { ...kept.flags, broken: { draft: { lines: 'not a list' } } } }));

  const s = sessionOf('dev', { storage });
  assert.deepEqual(s.takeNotices().map((n) => [n.kind, n.flags]), [['dropped', ['broken']]]);
  assert.deepEqual(s.takeNotices(), [], 'said once');
  assert.deepEqual(s.summary(meta).flags.map((f) => f.key), ['max_upload_mb']);
  assert.deepEqual(Object.keys(stored(storage, 'dev').flags), ['max_upload_mb'], 'written back without it');

  // a record this version doesn't know, and one that isn't JSON
  storage.setItem(storageKey('alice', 'prod'), JSON.stringify({ version: 3, flags: { x: {} } }));
  assert.deepEqual(sessionOf('prod', { storage }).takeNotices().map((n) => n.flags), [['x']]);
  assert.equal(storage.getItem(storageKey('alice', 'prod')), null);
  storage.setItem(storageKey('alice', 'staging'), 'not json');
  const [unreadable] = sessionOf('staging', { storage }).takeNotices();
  assert.match(unreadable.message, /couldn’t be read/);
  assert.equal(storage.getItem(storageKey('alice', 'staging')), null);

  const full: DraftStorage = { ...memoryStorage(), setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
  const tab = await opened(sessionOf('dev', { storage: full }), 'max_upload_mb');
  tab.edit('max_upload_mb', (d) => ({ ...d, fallback: 'huge' }));
  tab.flush();
  tab.edit('max_upload_mb', (d) => ({ ...d, fallback: 'enterprise' }));
  tab.flush();
  assert.deepEqual(tab.takeNotices().map((n) => [n.kind, /storage is full/.test(n.message)]), [['not-saved', true]]);
  assert.equal(tab.summary(meta).has('max_upload_mb'), true, 'still in this tab');
});

test('switching flag or environment never writes one environment’s draft under another’s key', async () => {
  // dev and prod differ, so each environment's stored layers are told apart
  const devBase = (await flagNow('data_region_host')).layers.dev.base;
  assert.equal((await t.as('alice').put('/flags/data_region_host/layers/dev/base', { layer: { ...devBase, defaultVariation: 'eu' }, expectedVersion: devBase.version })).status, 200);
  const storage = memoryStorage();
  const dev = await opened(sessionOf('dev', { storage }), 'data_region_host', 'max_upload_mb');
  const prod = await opened(sessionOf('prod', { storage }), 'data_region_host');
  dev.edit('data_region_host', (d) => ({ ...d, fallback: 'us' }));
  dev.edit('max_upload_mb', (d) => ({ ...d, fallback: 'huge' }));             // another flag: its own entry
  prod.edit('data_region_host', (d) => setOwnValues(d, ['oscorp'], 'eu'));
  dev.flush(); prod.flush();

  const flag = await flagNow('data_region_host');
  assert.deepEqual(stored(storage, 'dev').flags.data_region_host.based.layers, flag.layers.dev);
  assert.deepEqual(stored(storage, 'prod').flags.data_region_host.based.layers, flag.layers.prod);
  assert.equal(stored(storage, 'dev').flags.data_region_host.draft.fallback, 'us');
  assert.equal(stored(storage, 'dev').flags.max_upload_mb.draft.fallback, 'huge');
  assert.equal(stored(storage, 'prod').flags.data_region_host.draft.fallback, 'us');
  assert.deepEqual(Object.keys(stored(storage, 'prod').flags), ['data_region_host']);
  assert.equal(dev.view('data_region_host', meta).flag!.layers.dev.base.defaultVariation, 'eu');

  // the Undo of a discard in dev, clicked after moving to prod, restores dev's draft in dev only
  const undo = dev.discard(['data_region_host']);
  prod.edit('data_region_host', (d) => ({ ...d, fallback: 'eu' }));
  prod.flush();
  const prodBefore = storage.getItem(storageKey('alice', 'prod'));
  undo();
  assert.equal(storage.getItem(storageKey('alice', 'prod')), prodBefore);
  assert.equal(stored(storage, 'dev').flags.data_region_host.draft.fallback, 'us');
  assert.equal(dev.view('data_region_host', meta).draft!.fallback, 'us');
  assert.equal(prod.view('data_region_host', meta).draft!.fallback, 'eu');
});

test('a new value for a variant waits in the draft, goes out on publish, and is refused where an approved environment serves it', async () => {
  // a variant nobody serves yet: its new value is saved only when the draft is published
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'trial', value: 10 }] })).status, 200);
  const log: string[] = [];
  const s = await opened(sessionOf('dev', { log }), 'max_upload_mb');
  s.edit('max_upload_mb', (d) => setVariantValues(s.view('max_upload_mb', meta).flag!, d, { trial: 20 }));
  const v = s.view('max_upload_mb', meta);
  assert.equal(v.changed, true, 'a new value alone is a change');
  assert.deepEqual(v.items, [], 'no layer changes');
  assert.deepEqual(v.sentences, ['Change the value of trial: 10, now 20 (in every environment)']);
  assert.deepEqual(s.summary(meta).flags[0].values, [{ key: 'trial', value: 20, was: 10 }]);
  assert.equal((await flagNow('max_upload_mb')).variations.find((x: { key: string }) => x.key === 'trial').value, 10, 'not saved yet');
  log.length = 0;
  const res = await s.publish({ meta });
  assert.equal(res.applied, true);
  assert.deepEqual(log.filter((l) => !l.startsWith('GET')), ['PUT /flags/max_upload_mb/variations'], 'only the value: nothing to publish in the layers');
  assert.equal((await flagNow('max_upload_mb')).variations.find((x: { key: string }) => x.key === 'trial').value, 20);
  assert.equal(s.summary(meta).flags.length, 0);

  // someone else changes it meanwhile: the draft is stale, as for the layers
  const other = await opened(sessionOf('dev'), 'max_upload_mb');
  other.edit('max_upload_mb', (d) => setVariantValues(other.view('max_upload_mb', meta).flag!, d, { trial: 30 }));
  assert.equal((await t.as('alice').put('/flags/max_upload_mb/variations', { variations: [{ key: 'trial', value: 25 }] })).status, 200);
  assert.deepEqual(await other.checkStale(), ['max_upload_mb']);

  // a variant production serves (it needs approval) can't change under its approvers: refused, and nothing is sent
  const prodServed = await opened(sessionOf('dev', { log }), 'max_upload_mb');
  prodServed.edit('max_upload_mb', (d) => setVariantValues(prodServed.view('max_upload_mb', meta).flag!, d, { enterprise: 2000 }));
  await assert.rejects(prodServed.publish({ meta }), (e: ApiError) => e.status === 409 && /served in prod/.test(e.message));
  assert.equal((await flagNow('max_upload_mb')).variations.find((x: { key: string }) => x.key === 'enterprise').value, 1000);
  assert.equal(prodServed.summary(meta).flags.length, 1, 'the edit stays in the draft');
});
