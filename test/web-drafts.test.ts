// The draft session in a browser (web/src/draftSession.ts sharedSession and browserStorage): the console's one
// session per person and environment, kept in this browser's storage until it's published. What it stores carries a
// version, anything stored in another shape is dropped on reading (and said, instead of crashing the editor), another
// tab's change is read again, the page being hidden writes what's waiting, and a browser that can't store the draft
// says so and keeps it for the tab. (The session itself, at its interface: draft-session.test.ts.)
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlagDetail, Layer, Meta } from '../web/src/api.ts';

// a browser: storage (that can be made to refuse writes, as when it's full) and window events
const stored = new Map<string, string>();
let full = false;
const fakeStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (full) throw Object.assign(new Error('the quota has been exceeded'), { name: 'QuotaExceededError' });
    stored.set(k, String(v));
  },
  removeItem: (k: string) => { stored.delete(k); },
};
const listeners = new Map<string, ((e: { key?: string | null }) => void)[]>();
const fakeWindow = {
  localStorage: fakeStorage,
  addEventListener: (type: string, fn: (e: { key?: string | null }) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
};
const fire = (type: string, e: { key?: string | null } = {}) => { for (const fn of listeners.get(type) ?? []) fn(e); };

let drafts: typeof import('../web/src/draftSession.ts');
before(async () => {
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true });
  drafts = await import('../web/src/draftSession.ts');
});

const layer = (l: Partial<Layer>): Layer => ({ version: 4, enabled: true, variationWhenOff: null, defaultVariation: 'a', inherit: null, rules: [], ...l });
const flag: FlagDetail = {
  key: 'f', valueType: 'string', kind: 'config', description: null, owner: null, removeBy: null, archivedAt: null, name: null, tags: [],
  variations: [{ key: 'a', value: 'A' }, { key: 'b', value: 'B' }], delivery: { dev: [] },
  layers: { dev: { base: layer({}), entities: [] } },
};
const meta: Pick<Meta, 'entities' | 'dimensions' | 'fields' | 'environments'> = { entities: [], dimensions: [], fields: [], environments: [{ key: 'dev', name: 'Development', minApprovals: 0, revision: 1 }] };
// nothing here reaches the server: the flag is opened from the console's last copy of it
const http = async () => { throw new Error('no server in this test'); };

// each test as its own person: the console keeps one session per person and environment
let n = 0;
const sessionFor = () => {
  const person = `ana${++n}`;
  return { person, key: drafts.storageKey(person, 'dev'), s: drafts.sharedSession(person, 'dev', http, ['dev']) };
};
const editFallback = (s: ReturnType<typeof sessionFor>['s'], to: string) => { s.open('f', flag); s.edit('f', (d) => ({ ...d, fallback: to })); };

test('a draft is kept in this browser, per person and environment, with its version', () => {
  const { s, key, person } = sessionFor();
  assert.equal(drafts.sharedSession(person, 'dev', http, ['dev']), s, 'one session per person and environment');
  editFallback(s, 'b');
  assert.equal(stored.has(key), false, 'written after a pause, not on every keystroke');
  s.flush();
  const doc = JSON.parse(stored.get(key)!);
  assert.equal(doc.version, 2);
  assert.deepEqual(Object.keys(doc.flags), ['f']);
  assert.equal(doc.flags.f.draft.fallback, 'b');
  assert.deepEqual(s.summary(meta).flags.map((f) => f.items.map((i) => [i.flag, i.entity, i.expectedVersion, i.layer?.defaultVariation])), [[['f', null, 4, 'b']]],
    'publishing it sends the changed layer, at the version it was edited on');
  s.discard();
  assert.equal(stored.has(key), false, 'nothing left: nothing stored');
});

test('the page being hidden writes what is waiting', () => {
  const { s, key } = sessionFor();
  editFallback(s, 'b');
  assert.equal(stored.has(key), false);
  fire('pagehide');
  assert.equal(JSON.parse(stored.get(key)!).flags.f.draft.fallback, 'b');
});

test('another tab’s change is read again', () => {
  const { s, key } = sessionFor();
  editFallback(s, 'b');
  s.flush();
  stored.set(key, JSON.stringify({ version: 2, flags: {} }));                // another tab published it
  assert.equal(s.has('f'), true, 'still the copy read before…');
  fire('storage', { key: 'cf.something.else' });
  assert.equal(s.has('f'), true, '…another key changing means nothing…');
  fire('storage', { key });
  assert.equal(s.has('f'), false, '…until its own key changes');
});

test('a store in another shape, or not JSON at all, reads as empty and says so', () => {
  for (const junk of [JSON.stringify({ version: 3, flags: { f: {} } }), '{not json', JSON.stringify([1, 2])]) {
    const person = `ana${++n}`;
    const key = drafts.storageKey(person, 'dev');
    stored.set(key, junk);
    const s = drafts.sharedSession(person, 'dev', http, ['dev']);
    assert.equal(s.summary(meta).flags.length, 0, junk);
    assert.deepEqual(s.takeNotices().map((x) => x.kind), ['dropped'], junk);
    assert.equal(stored.has(key), false, `${junk}: cleared, so it isn't read again`);
  }
});

test('a browser that can’t store the draft says so once, and keeps it for this tab', () => {
  const { s, key } = sessionFor();
  s.takeNotices();
  full = true;
  try {
    editFallback(s, 'b');
    s.flush();
    s.edit('f', (d) => ({ ...d, fallback: 'code_default' }));         // still a change: the next write fails too
    s.flush();
    const said = s.takeNotices();
    assert.deepEqual(said.map((x) => x.kind), ['not-saved']);
    assert.match(said[0].message, /storage is full/);
    assert.equal(s.has('f'), true, 'kept in this tab');
    assert.equal(stored.has(key), false);
  } finally {
    full = false;
  }
  s.flush();
  s.discard();
});

test('there is no browser storage in Node unless a window has one', () => {
  assert.equal(drafts.browserStorage(), fakeStorage);
});

test('a draft saved before dimensions keeps its own settings for the same entity, not as rules for everyone', () => {
  const person = `ana${++n}`;
  const key = drafts.storageKey(person, 'dev');
  // the shape a console kept before dimensions: `customers` / `customer` / `customerOnly`
  const K = '00000000-0000-4000-8000-000000000001';
  const own = layer({ version: 2, enabled: null, inherit: 'customer_only', defaultVariation: 'a' });
  const oldLine = { id: K, customer: 'acme', locked: false, paused: false, name: null, conditions: [], serveVariation: 'b', split: null, customerOnly: true };
  stored.set(key, JSON.stringify({ version: 2, flags: { f: {
    at: new Date().toISOString(), ownIds: { acme: K },
    based: { valueType: 'string', kind: 'config', variations: flag.variations, layers: { base: layer({}), customers: [{ customer: 'acme', layer: own }] } },
    draft: { fallback: 'a', lines: [oldLine], newValues: {}, afterEveryone: {} },
  } } }));
  const s = drafts.sharedSession(person, 'dev', http, ['dev']);
  const items = s.summary(meta).flags.flatMap((f) => f.items);
  assert.deepEqual(items.map((i) => [i.entity, i.layer?.inherit, i.layer?.defaultVariation]), [['acme', 'customer_only', 'b']],
    'the edit is still to acme’s own settings, still "Own settings only"');
});
