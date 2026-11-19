// The rule editor's draft model (web/src/lines.ts): loading a flag into the editor and publishing it
// again must never change what anyone gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { changes, lineToRule, preview, removeEntity, setOwnValues, toDraft, toLayers, type Draft, type Line } from '../web/src/lines.ts';
import type { FlagDetail, Layer, Meta } from '../web/src/api.ts';
import { boot } from './helpers.ts';

const K = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const layer = (l: Partial<Layer>): Layer => ({ version: 1, enabled: null, variationWhenOff: null, defaultVariation: null, inherit: null, rules: [], ...l });
const everyoneOnAndroid = { ruleKey: K(1), name: null, locked: false, disabled: false, conditions: [{ field: 'project', op: 'in', values: ['android'] }], serveVariation: 'b', split: null };

const flag: FlagDetail = {
  key: 'f', valueType: 'string', kind: 'config', description: null, owner: null, removeBy: null, archivedAt: null, name: null, tags: [],
  variations: [{ key: 'a', value: 'A' }, { key: 'b', value: 'B' }, { key: 'c', value: 'C' }],
  delivery: { dev: ['android', 'web'] },
  layers: { dev: {
    base: layer({ enabled: true, variationWhenOff: 'code_default', defaultVariation: 'a', rules: [everyoneOnAndroid] }),
    entities: [
      { entity: 'microsoft', layer: layer({ inherit: 'base_rules_then_customer_default', defaultVariation: 'c' }) },
      { entity: 'google', layer: layer({ inherit: 'customer_only', defaultVariation: 'c' }) },
    ],
  } },
};
const meta = {
  dimensions: [{ key: 'company', singular: 'company', plural: 'companies', entities: 2, withParent: 0 }],
  entities: [{ key: 'microsoft', name: 'Microsoft', dimension: 'company', createdAt: '' }, { key: 'google', name: 'Google', dimension: 'company', createdAt: '' }],
  fields: [{ name: 'project', valueType: 'string', comesFrom: 'key', canSplitBy: false, description: '' }],
} as unknown as Meta;
const gets = (d: ReturnType<typeof toDraft>, entity: string, project: string) =>
  preview(flag, 'dev', d, true, meta, { project, entity, attrs: {} }).variant;

test('an own default that comes after the rules for everyone stays after them', () => {
  const d = toDraft(flag, 'dev');
  assert.deepEqual(d.afterEveryone, { microsoft: 'c' });
  // opening the flag changes nothing: published as it opens, the base and Microsoft's layer are the ones stored
  const opened = toLayers(d, true);
  assert.deepEqual(opened.base.rules, flag.layers.dev.base.rules);
  assert.equal(opened.base.defaultVariation, flag.layers.dev.base.defaultVariation);
  assert.deepEqual(opened.entities.get('microsoft'), { rules: [], inherit: 'base_rules_then_customer_default', defaultVariation: 'c' });
  assert.equal(gets(d, 'microsoft', 'android'), 'b');                             // the rule for everyone wins
  assert.equal(gets(d, 'microsoft', 'web'), 'c');                                 // then Microsoft's default
  assert.equal(gets(d, 'google', 'android'), 'c');                                // own settings only skips the rules for everyone
  // editing Microsoft republishes it with its mode kept
  const edited = { ...d, lines: [...d.lines, { id: K(9), entity: 'microsoft', locked: false, paused: false, name: null, conditions: [{ field: 'project', op: 'in', values: ['web'] }], serveVariation: 'a', split: null }] };
  const [item] = changes(flag, 'dev', d, edited);
  assert.deepEqual([item.entity, item.layer?.inherit, item.layer?.defaultVariation], ['microsoft', 'base_rules_then_customer_default', 'c']);
  assert.equal(gets(edited, 'microsoft', 'android'), 'b');
});

test('setting, clearing and removing an own default', () => {
  const d = toDraft(flag, 'dev');
  const own = setOwnValues(d, ['microsoft'], 'a');                                // an own value now beats the rules for everyone
  assert.deepEqual(own.afterEveryone, {});
  assert.equal(gets(own, 'microsoft', 'android'), 'a');
  const gone = removeEntity(d, 'microsoft');
  assert.equal(toLayers(gone, true).entities.has('microsoft'), false);
  assert.equal(gets(gone, 'microsoft', 'web'), 'a');
  assert.deepEqual(lineToRule(d.lines.find((l) => l.id === K(1))!).conditions, everyoneOnAndroid.conditions);
});

// ---- the translation is exact: what is stored comes back unchanged, for all three choices

// The parts of a stored layer the console edits (versions and the fixed On/Off fields left out), as toLayers writes them.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const storedBase = (l: Layer) => plain({ enabled: l.enabled, defaultVariation: l.defaultVariation, rules: l.rules });
const storedOwn = (l: Layer) => plain({ inherit: l.inherit, defaultVariation: l.defaultVariation, rules: l.rules });

test('opening any stored flag and saving it unchanged writes back exactly what is stored', async () => {
  const t = await boot();
  try {
    const alice = t.as('alice');
    // more shapes than the fixtures: each choice with rules, and condition-free rules (plain, paused, a %) in each
    const rule = (serve: string | null, more: object = {}) => ({ ruleKey: randomUUID(), name: null, locked: false, disabled: false, conditions: [], serveVariation: serve, split: null, ...more });
    const onWeb = { conditions: [{ field: 'project', op: 'in', values: ['web'] }] };
    const half = { serveVariation: null, split: { by: 'device.id', fallbackBy: null, ranges: [{ variation: 'on', from: 0, to: 5000 }] } };
    const extra: [string, string, object][] = [
      ['max_upload_mb', 'acme', { inherit: 'customer_only', defaultVariation: 'huge', rules: [rule('enterprise', onWeb), rule('standard', { name: 'Everything else' })] }],
      ['max_upload_mb', 'globex', { inherit: 'base_rules_then_customer_default', defaultVariation: 'huge', rules: [rule('enterprise', onWeb), rule('standard')] }],
      ['max_upload_mb', 'initech', { inherit: 'base_rules_then_base_default', rules: [rule('enterprise', onWeb), rule('huge', { disabled: true })] }],
      ['new_checkout', 'acme', { inherit: 'customer_only', defaultVariation: 'off', rules: [rule('on', { disabled: true }), rule(null, half)] }],
      ['new_checkout', 'globex', { inherit: 'base_rules_then_base_default', rules: [rule(null, half)] }],
      ['welcome_message', 'acme', { inherit: 'customer_only', defaultVariation: 'code_default', rules: [] }],
    ];
    for (const [key, entity, layer] of extra) {
      const r = await alice.put(`/flags/${key}/layers/dev/${entity}`, { layer, expectedVersion: null });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const seen = new Set<string>();
    // the list is always paged (one page holds every fixture flag)
    for (const { key } of (await alice.get('/flags?page=0&size=200')).json.rows as { key: string }[]) {
      const flag: FlagDetail = (await alice.get(`/flags/${key}`)).json;
      for (const [env, stored] of Object.entries(flag.layers)) {
        const back = toLayers(toDraft(flag, env), !!stored.base.enabled);
        const where = `${key} in ${env}`;
        assert.deepEqual(plain(back.base), storedBase(stored.base), where);
        assert.deepEqual(Object.fromEntries([...back.entities].map(([c, d]) => [c, plain(d)])),
          Object.fromEntries(stored.entities.map(({ entity, layer: l }) => [entity, storedOwn(l)])), where);
        for (const { layer: l } of stored.entities) {
          assert.deepEqual([l.enabled, l.variationWhenOff], [null, null], where);
          seen.add(l.inherit!);
        }
        assert.deepEqual(changes(flag, env, toDraft(flag, env), toDraft(flag, env)), [], where);
      }
    }
    assert.deepEqual([...seen].sort(), ['base_rules_then_base_default', 'base_rules_then_customer_default', 'customer_only']);

    // republishing SAP (Own settings only) with a new value keeps it Own settings only: the trace still skips the rules for everyone
    const flag: FlagDetail = (await alice.get('/flags/data_region_host')).json;
    const d = toDraft(flag, 'dev');
    const next = { ...d, lines: d.lines.map((l) => (l.entity === 'sap' ? { ...l, serveVariation: 'eu' } : l)) };
    const items = changes(flag, 'dev', d, next);
    assert.deepEqual(items.map((i) => [i.entity, i.layer?.inherit, i.layer?.defaultVariation, i.layer?.rules.length]), [['sap', 'customer_only', 'eu', 0]]);
    assert.equal((await alice.post('/flags/data_region_host/publish/dev', { items })).status, 200);
    await t.settle();
    const sap = await t.trace({ flag: 'data_region_host', project: 'web', entity: 'sap' });
    assert.equal(sap.variant, 'eu');
    assert.equal(sap.decidedBy.section, 'entity_default');
    assert.ok(sap.trace.some((s: { outcome: string; detail: string }) => s.outcome === 'skipped' && /uses only its own settings/.test(s.detail)));
    assert.deepEqual((await alice.get('/flags/data_region_host/impact/dev')).json.ownOnly, ['sap']);
  } finally {
    await t.stop();
  }
});

// ---- editing the "Own settings only" default

// Google: Own settings only, with one rule of its own before its default
const googleOnWeb = { ruleKey: K(2), name: null, locked: false, disabled: false, conditions: [{ field: 'project', op: 'in', values: ['web'] }], serveVariation: 'a', split: null };
const only: FlagDetail = structuredClone(flag);
only.layers.dev.entities[1].layer.rules = [googleOnWeb];
const googleLayer = (orig: Draft, next: Draft) => {
  const items = changes(only, 'dev', orig, next).filter((i) => i.entity === 'google');
  assert.equal(items.length, 1);
  return items[0].layer && plain(items[0].layer);
};
const ownLine = (d: Draft) => d.lines.filter((l) => l.entity === 'google').at(-1)!;
const withOwn = (d: Draft, f: (l: Line) => Line | null): Draft => ({ ...d, lines: d.lines.flatMap((l) => (l === ownLine(d) ? [f(l)].filter((x) => x !== null) : [l])) });
const asRule = (l: Line) => plain(lineToRule(l));

test('the Own settings only default shows as the last line for that entity, and keeps the choice', () => {
  const d = toDraft(only, 'dev');
  const own = ownLine(d);
  assert.deepEqual([own.conditions, own.split, own.serveVariation, own.ownOnly], [[], null, 'c', true]);
  assert.deepEqual(changes(only, 'dev', d, structuredClone(d)), []);
  const r = preview(only, 'dev', d, true, meta, { project: 'android', entity: 'google', attrs: {} });
  assert.deepEqual([r.variant, r.decidedBy.section], ['c', 'entity_default']);
  assert.ok(r.trace.some((s) => s.outcome === 'skipped' && /uses only its own settings/.test(s.detail)));
  // a new value: still Own settings only, with the new default
  assert.deepEqual(googleLayer(d, withOwn(d, (l) => ({ ...l, serveVariation: 'b' }))),
    { inherit: 'customer_only', defaultVariation: 'b', rules: [asRule(d.lines.find((l) => l.id === K(2))!)] });
  assert.deepEqual(googleLayer(d, setOwnValues(d, ['google'], 'a')), { inherit: 'customer_only', defaultVariation: 'a', rules: [asRule(d.lines.find((l) => l.id === K(2))!)] });
});

test('a condition, a % split, a pause, a move or deleting it makes the Own settings only default an ordinary rule again', () => {
  const d = toDraft(only, 'dev');
  const rule2 = asRule(d.lines.find((l) => l.id === K(2))!);
  const rulesOnly = (rules: unknown[]) => ({ inherit: 'base_rules_then_base_default', defaultVariation: null, rules });
  const onWeb = withOwn(d, (l) => ({ ...l, conditions: [{ field: 'project', op: 'in', values: ['web'] }] }));
  assert.deepEqual(googleLayer(d, onWeb), rulesOnly([rule2, asRule(ownLine(onWeb))]));
  assert.equal(gets(d, 'google', 'android'), 'c');                                 // Own settings only: the rules for everyone are skipped
  assert.equal(preview(only, 'dev', onWeb, true, meta, { project: 'android', entity: 'google', attrs: {} }).variant, 'b');   // now they apply
  const split = withOwn(d, (l) => ({ ...l, serveVariation: null, split: { by: 'device.id', fallbackBy: null, ranges: [{ variation: 'b', from: 0, to: 5000 }] } }));
  assert.deepEqual(googleLayer(d, split), rulesOnly([rule2, asRule(ownLine(split))]));
  const paused = withOwn(d, (l) => ({ ...l, paused: true }));
  assert.deepEqual(googleLayer(d, paused), rulesOnly([rule2, asRule(ownLine(paused))]));
  // moved above Google's other rule: no longer last, so it's a rule like the one now after it
  const own = ownLine(d);
  const moved = { ...d, lines: [...d.lines.filter((l) => l.entity !== 'google'), own, ...d.lines.filter((l) => l.entity === 'google' && l !== own)] };
  assert.deepEqual(googleLayer(d, moved), rulesOnly([asRule(own), rule2]));
  assert.deepEqual(googleLayer(d, withOwn(d, () => null)), rulesOnly([rule2]));
  assert.deepEqual(googleLayer(d, setOwnValues(d, ['google'], null)), rulesOnly([rule2]));
  // with a default after the rules for everyone, the rule comes back as Rules + own default
  assert.deepEqual(googleLayer(d, { ...onWeb, afterEveryone: { ...onWeb.afterEveryone, google: 'b' } }),
    { inherit: 'base_rules_then_customer_default', defaultVariation: 'b', rules: [rule2, asRule(ownLine(onWeb))] });
  // an entity whose only line was the default is back to the same as everyone
  const plainGoogle = toDraft(flag, 'dev');
  const [gone] = changes(flag, 'dev', plainGoogle, withOwn(plainGoogle, () => null));
  assert.deepEqual([gone.entity, gone.layer], ['google', null]);
});
