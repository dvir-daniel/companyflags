// The console's pickers (web/src/pages/entityPickerKit.ts, rolloutKit.ts): an entity is picked by key, so two of the
// same name are never mixed up; a rollout's % box saves only a share it can store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityLabel, type Entity } from '../web/src/api.ts';
import { PICK_LIMIT, resolveTyped, searchable, searchEntities } from '../web/src/pages/entityPickerKit.ts';
import { percentText, readPercent } from '../web/src/pages/rolloutKit.ts';

const at = '2026-01-01T00:00:00Z';
const entities: Entity[] = [
  { key: 'globex', name: 'Globex', dimension: 'company', createdAt: at },
  { key: 'lumen', name: 'Lumen', dimension: 'brand', parent: 'globex', createdAt: at },
  { key: 'bolt', name: 'Bolt', dimension: 'brand', parent: 'globex', createdAt: at },
  { key: 'lumen-main', name: 'Main store', dimension: 'store', parent: 'lumen', createdAt: at },
  { key: 'bolt-main', name: 'Main store', dimension: 'store', parent: 'bolt', createdAt: at },
  { key: 'bolt-outlet', name: 'Outlet', dimension: 'store', parent: 'bolt', createdAt: at },
];
const list = searchable(entities, (e) => entityLabel(entities, e.key));
const keys = (es: Entity[]) => es.map((e) => e.key);

test('two entities of the same name both match, each by its own key', () => {
  assert.deepEqual(keys(searchEntities(list, 'main store').items), ['lumen-main', 'bolt-main']);
  assert.deepEqual(keys(searchEntities(list, 'Main store (Bolt)').items), ['bolt-main']);
  assert.deepEqual(keys(searchEntities(list, 'bolt-main').items), ['bolt-main']);
});

test('a search finds by name or key, in any case, best match first', () => {
  // "bolt" is Bolt's key and name (exact), then what starts with it, then what has it anywhere
  assert.deepEqual(keys(searchEntities(list, 'BOLT').items), ['bolt', 'bolt-main', 'bolt-outlet']);
  assert.deepEqual(keys(searchEntities(list, 'outl').items), ['bolt-outlet']);
  assert.deepEqual(searchEntities(list, 'nobody'), { items: [], total: 0 });
  assert.equal(searchEntities(list, '  ').total, entities.length);
});

test('a long list shows at most the limit, and says how many match', () => {
  const many: Entity[] = Array.from({ length: 5000 }, (_, i) => ({ key: `store-${i}`, name: `Store ${i}`, dimension: 'store', createdAt: at }));
  const big = searchable(many, (e) => e.name);
  const all = searchEntities(big, '');
  assert.equal(all.items.length, PICK_LIMIT);
  assert.equal(all.total, 5000);
  const some = searchEntities(big, 'store 12');
  assert.equal(some.items.length, PICK_LIMIT);
  assert.equal(some.total, 111);                 // 12, 120–129, 1200–1299
  assert.equal(some.items[0].key, 'store-12');    // the exact one first
  assert.equal(searchEntities(big, 'store', 8).items.length, 8);
});

test('what is typed out in full picks one entity, never one of two that share a name', () => {
  assert.equal(resolveTyped(list, 'Main store'), null);
  assert.equal(resolveTyped(list, 'main store (bolt)')?.key, 'bolt-main');
  assert.equal(resolveTyped(list, 'Main store (Lumen)')?.key, 'lumen-main');
  assert.equal(resolveTyped(list, 'BOLT-MAIN')?.key, 'bolt-main');
  assert.equal(resolveTyped(list, 'outlet')?.key, 'bolt-outlet');
  assert.equal(resolveTyped(list, 'Main'), null);
  assert.equal(resolveTyped(list, ''), null);
});

test('an empty % box saves nothing, never 0%', () => {
  assert.deepEqual(readPercent(''), { ok: true, to: null });
  assert.deepEqual(readPercent('   '), { ok: true, to: null });
});

test('the % box reads 0 to 100 with at most two decimals', () => {
  assert.deepEqual(readPercent('0'), { ok: true, to: 0 });
  assert.deepEqual(readPercent('100'), { ok: true, to: 10000 });
  assert.deepEqual(readPercent('12.5'), { ok: true, to: 1250 });
  assert.deepEqual(readPercent('12,5'), { ok: true, to: 1250 });
  assert.deepEqual(readPercent('0.01'), { ok: true, to: 1 });
  assert.deepEqual(readPercent('.5'), { ok: true, to: 50 });
  assert.deepEqual(readPercent('33.33%'), { ok: true, to: 3333 });
  assert.deepEqual(readPercent('12.'), { ok: true, to: 1200 });   // on the way to 12.5
});

test('the % box says why it can’t save anything else', () => {
  assert.deepEqual(readPercent('101'), { ok: false, error: 'Enter a number from 0 to 100' });
  assert.deepEqual(readPercent('-1'), { ok: false, error: 'Enter a number from 0 to 100' });
  assert.deepEqual(readPercent('abc'), { ok: false, error: 'Enter a number from 0 to 100' });
  assert.deepEqual(readPercent('1e2'), { ok: false, error: 'Enter a number from 0 to 100' });
  assert.deepEqual(readPercent('12.345'), { ok: false, error: 'Use at most two decimals' });
});

test('a share shows as the % box reads it back', () => {
  for (const to of [0, 1, 50, 1250, 3333, 10000]) {
    assert.equal(percentText(to), String(to / 100));
    assert.deepEqual(readPercent(percentText(to)), { ok: true, to });
  }
});
