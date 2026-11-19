// The rule editor's draft model (web/src/lines.ts), beyond loading and publishing (test/lines.test.ts): the keys of
// values typed for one entity, which values publishing creates, line order, and what an edit publishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changes, hiddenKey, sortLines, toDraft, valuesToCreate, type Draft, type Line } from '../web/src/lines.ts';
import type { FlagDetail, Layer } from '../web/src/api.ts';

const K = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const layer = (l: Partial<Layer>): Layer => ({ version: 1, enabled: null, variationWhenOff: null, defaultVariation: null, inherit: null, rules: [], ...l });
const line = (id: number, l: Partial<Line> = {}): Line => ({ id: K(id), entity: null, locked: false, paused: false, name: null, conditions: [], serveVariation: 'a', split: null, ...l });

const flag: FlagDetail = {
  key: 'f', valueType: 'string', kind: 'config', description: null, owner: null, removeBy: null, archivedAt: null, name: null, tags: [],
  variations: [{ key: 'a', value: 'A' }, { key: 'b', value: 'B' }],
  delivery: { dev: ['android'] },
  layers: { dev: {
    base: layer({ version: 7, enabled: true, defaultVariation: 'a', rules: [{ ruleKey: K(1), name: null, locked: false, disabled: false, conditions: [], serveVariation: 'b', split: null }] }),
    entities: [{ entity: 'acme', layer: layer({ version: 3, inherit: 'base_rules_then_customer_default', defaultVariation: 'b' }) }],
  } },
};

test('a value typed for one entity keeps the key it was stored under', () => {
  // these keys are in the database: changing the hash would orphan every stored per-entity value
  assert.equal(hiddenKey(true), 'val-08956a4c870bf5f4');
  assert.equal(hiddenKey(false), 'val-a2630f8a6393f0aa');
  assert.equal(hiddenKey(0), 'val-eb2b2475ab050fb7');
  assert.equal(hiddenKey(42), 'val-a59208386db3c32f');
  assert.equal(hiddenKey('eu-host'), 'val-5bef510bfa6b64fc');
  assert.equal(hiddenKey(''), 'val-ada151798dddd9f7');
  assert.equal(hiddenKey(null), 'val-9b55e0da69fcb93a');
  assert.equal(hiddenKey({ a: 1, b: [2, 3] }), 'val-63f423c6339a58f7');
  assert.equal(hiddenKey('héllo ✓'), 'val-21bdbe65c6165a06');
  assert.notEqual(hiddenKey('42'), hiddenKey(42));                                 // the JSON, so the type counts
});

test('publishing creates only the typed values a line uses and the flag lacks', () => {
  const used = hiddenKey('used'), unused = hiddenKey('unused'), split = hiddenKey('split'), later = hiddenKey('later');
  const draft: Draft = {
    fallback: 'a',
    lines: [
      line(1, { entity: 'acme', serveVariation: used }),
      line(2, { entity: 'globex', serveVariation: null, split: { by: 'device.id', fallbackBy: null, ranges: [{ variation: split, from: 0, to: 10000 }] } }),
    ],
    newValues: { [used]: 'used', [unused]: 'unused', [split]: 'split', [later]: 'later', a: 'A' },
    afterEveryone: { initech: later },
  };
  const made = valuesToCreate(flag, draft);
  assert.deepEqual(made.map((v) => v.key).sort(), [used, split, later].sort());   // not "unused", not "a" (it exists)
  assert.equal(made.find((v) => v.key === used)?.value, 'used');
});

test('lines sort into evaluation order: overrides, entities grouped as they first appear, then everyone', () => {
  const lines = [
    line(1),                                        // everyone
    line(2, { entity: 'b' }),
    line(3, { locked: true }),                      // an override
    line(4, { entity: 'a' }),
    line(5, { entity: 'b' }),
    line(6),
    line(7, { entity: 'a', locked: true }),       // locked means nothing on an entity's line: it stays with its entity
  ];
  assert.deepEqual(sortLines(lines).map((l) => l.id), [K(3), K(2), K(5), K(4), K(7), K(1), K(6)]);
  assert.deepEqual(sortLines([]), []);
});

test('an edit publishes only the layers it changed, against the versions it was made on', () => {
  const orig = toDraft(flag, 'dev');
  assert.deepEqual(changes(flag, 'dev', orig, orig), []);

  // a new default for everyone: only the base layer, at its stored version
  const [base] = changes(flag, 'dev', orig, { ...orig, fallback: 'b' });
  assert.deepEqual([base.entity, base.expectedVersion, base.layer?.defaultVariation], [null, 7, 'b']);

  // a rule for an entity without settings yet: a new layer (no version to check)
  const added = changes(flag, 'dev', orig, { ...orig, lines: sortLines([...orig.lines, line(9, { entity: 'globex', serveVariation: 'b' })]) });
  assert.equal(added.length, 1);
  assert.deepEqual([added[0].entity, added[0].expectedVersion, added[0].layer?.rules.length], ['globex', null, 1]);

  // acme back to the same as everyone: its layer is removed, against its stored version
  const cleared = changes(flag, 'dev', orig, { ...orig, afterEveryone: {} });
  assert.deepEqual(cleared, [{ entity: 'acme', expectedVersion: 3, layer: null }]);
});
