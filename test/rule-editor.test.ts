// The rule editor's helpers (web/src/lines.ts, web/src/pages/rolloutKit.ts): a new rule's empty check, an entity's own
// default and where it comes, what "Check who gets what" can be sure of, new values of variants in the draft, the
// review's sentences, and the split editor's parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankCheck, changes, deviceDependence, lineProblem, lineToRule, newLine, ownDefault, preview, servedBy, setOwnDefault, setVariantValues, summarize, toDraft,
  toLayers, valueEdits, valueOf, type Draft, type Line,
} from '../web/src/lines.ts';
import { endToEnd, isContiguous, leftOver, withoutPart, withPart, withShare } from '../web/src/pages/rolloutKit.ts';
import { CHOICE_NAME, splitUnit, whenText } from '../server/words.ts';
import type { FlagDetail, Layer, Meta } from '../web/src/api.ts';

const K = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const layer = (l: Partial<Layer>): Layer => ({ version: 1, enabled: null, variationWhenOff: null, defaultVariation: null, inherit: null, rules: [], ...l });
const rule = (n: number, r: Partial<Layer['rules'][number]> = {}): Layer['rules'][number] =>
  ({ ruleKey: K(n), name: null, locked: false, disabled: false, conditions: [], serveVariation: 'b', split: null, ...r });

// an override for old Android apps, a rule for everyone on web, and Acme with nothing of its own yet
const flag: FlagDetail = {
  key: 'checkout', valueType: 'string', kind: 'config', description: null, owner: null, removeBy: null, archivedAt: null, name: null, tags: [],
  variations: [{ key: 'a', value: 'A' }, { key: 'b', value: 'B' }, { key: 'c', value: 'C' }],
  delivery: { dev: ['android', 'web'] },
  layers: { dev: {
    base: layer({ enabled: true, variationWhenOff: 'code_default', defaultVariation: 'a', rules: [
      rule(1, { locked: true, serveVariation: 'c', conditions: [{ field: 'project', op: 'in', values: ['android'] }, { field: 'app.version', op: 'semver_lt', values: ['5.0.0'] }] }),
      rule(2, { conditions: [{ field: 'project', op: 'in', values: ['web'] }] }),
    ] }),
    entities: [],
  } },
};
const meta = {
  dimensions: [{ key: 'company', singular: 'company', plural: 'companies', entities: 1, withParent: 0 }],
  entities: [{ key: 'acme', name: 'Acme Corp', dimension: 'company', createdAt: '' }],
  fields: [
    { name: 'project', valueType: 'string', comesFrom: 'key', canSplitBy: false, description: '' },
    { name: 'app.version', valueType: 'semver', comesFrom: 'sdk', canSplitBy: false, description: '' },
    { name: 'device.id', valueType: 'string', comesFrom: 'sdk', canSplitBy: true, description: '' },
    { name: 'session.id', valueType: 'string', comesFrom: 'sdk', canSplitBy: true, description: '' },
    { name: 'company', valueType: 'string', comesFrom: 'token', canSplitBy: false, description: '' },
  ],
} as unknown as Meta;
const check = (d: Draft, entity: string | null, project: string, attrs: Record<string, unknown> = {}) => preview(flag, 'dev', d, true, meta, { project, entity, attrs });

// ---- a new rule

test('a new rule starts with one empty check: incomplete until its attribute is chosen, and never "Service is …"', () => {
  const l = newLine('b', null);
  assert.deepEqual(l.conditions, [blankCheck()]);
  assert.notEqual(l.conditions[0].field, 'project');
  const d = toDraft(flag, 'dev');
  assert.match(lineProblem(l, flag, d, meta.fields) ?? '', /Choose what this check is about/);
  // the empty check isn't sent; once chosen and filled in, the rule can be saved
  assert.deepEqual(lineToRule(l).conditions, []);
  const done: Line = { ...l, conditions: [{ field: 'app.version', op: 'semver_gte', values: ['6.0.0'] }] };
  assert.equal(lineProblem(done, flag, d, meta.fields), null);
  // on an entity's own settings, a new rule is a rule, not its default (that has no checks at all)
  const own = newLine('b', 'acme');
  const withRule = { ...d, lines: [...d.lines, own] };
  assert.equal(ownDefault(withRule, 'acme'), null);
});

test('a rule’s name and pause are saved with it', () => {
  const l: Line = { ...newLine('b', null), conditions: [{ field: 'project', op: 'in', values: ['web'] }], name: '  Web beta  ', paused: true };
  const r = lineToRule(l);
  assert.equal(r.name, 'Web beta');
  assert.equal(r.disabled, true);
  // a paused rule is skipped
  const d = toDraft(flag, 'dev');
  const paused = { ...d, lines: d.lines.map((x) => (x.id === K(2) ? { ...x, paused: true } : x)) };
  assert.equal(check(paused, null, 'web').variant, 'a');
  assert.equal(check(d, null, 'web').variant, 'b');
});

// ---- an entity's own default and where it comes

test('setting a default says where it comes: after the rules for everyone, or instead of them', () => {
  const d = toDraft(flag, 'dev');
  const last = setOwnDefault(d, 'acme', 'c', 'last');
  assert.deepEqual(ownDefault(last, 'acme'), { variant: 'c', place: 'last', line: null });
  assert.deepEqual(toLayers(last, true).entities.get('acme'), { rules: [], inherit: 'base_rules_then_customer_default', defaultVariation: 'c' });
  assert.equal(check(last, 'acme', 'web').variant, 'b');                    // the rule for everyone still decides first
  assert.equal(check(last, 'acme', 'android', { 'app.version': '6.0.0' }).variant, 'c');

  const first = setOwnDefault(last, 'acme', 'c', 'first');
  assert.equal(ownDefault(first, 'acme')?.place, 'first');
  assert.deepEqual(first.afterEveryone, {});
  assert.deepEqual(toLayers(first, true).entities.get('acme'), { inherit: 'customer_only', defaultVariation: 'c', rules: [] });
  assert.equal(check(first, 'acme', 'web').variant, 'c');                   // the rules for everyone are skipped
  // overrides still apply
  assert.equal(check(first, 'acme', 'android', { 'app.version': '4.0.0' }).variant, 'c');

  // a new value keeps where it comes, and its line keeps its id; clearing it follows what's above again
  const id = ownDefault(first, 'acme')!.line!.id;
  const changed = setOwnDefault(first, 'acme', 'b', 'first');
  assert.deepEqual([ownDefault(changed, 'acme')?.variant, ownDefault(changed, 'acme')?.line?.id], ['b', id]);
  assert.equal(ownDefault(setOwnDefault(changed, 'acme', null, 'first'), 'acme'), null);
  assert.equal(changes(flag, 'dev', d, setOwnDefault(changed, 'acme', null, 'first')).length, 0);
  // the review says which it is
  assert.deepEqual(summarize(flag, d, last, meta), ['Set c for Acme Corp, after the rules for everyone']);
  assert.deepEqual(summarize(flag, d, first, meta), ['Set c for Acme Corp, before the rules for everyone (they’re skipped)']);
});

test('the names of the three choices say what happens after the entity’s own rules', () => {
  assert.equal(CHOICE_NAME.base_rules_then_base_default, 'Follow what’s above');
  assert.equal(CHOICE_NAME.base_rules_then_customer_default, 'Own default last');
  assert.equal(CHOICE_NAME.customer_only, 'Skip what’s above');
});

// ---- what "Check who gets what" can be sure of

test('with no device details, an override that matches only on a missing version depends on the device', () => {
  const d = toDraft(flag, 'dev');
  const blind = check(d, 'acme', 'android');
  assert.equal(blind.variant, 'c');                                        // the override fails closed
  assert.deepEqual(deviceDependence(blind), { depends: true, fields: ['app.version'], matchedOnMissing: K(1) });
  // with the version sent, it's known
  const known = check(d, 'acme', 'android', { 'app.version': '6.0.0' });
  assert.equal(known.variant, 'a');
  assert.deepEqual(deviceDependence(known), { depends: false, fields: [], matchedOnMissing: null });
  const old = check(d, 'acme', 'android', { 'app.version': '4.0.0' });
  assert.equal(deviceDependence(old).depends, false);
  // on web the override doesn't match whatever the version: nothing depends on the device
  assert.equal(deviceDependence(check(d, 'acme', 'web')).depends, false);
});

test('a rule above the answer that skipped a missing value, or a % with no device ID, makes it depend on the device', () => {
  const d = toDraft(flag, 'dev');
  const gated: Line = { id: K(5), entity: null, locked: false, paused: false, name: null, conditions: [{ field: 'app.version', op: 'semver_gte', values: ['6.0.0'] }], serveVariation: 'b', split: null };
  const byVersion = { ...d, lines: [...d.lines.filter((l) => l.id !== K(2)), gated] };
  const r = check(byVersion, 'acme', 'web');
  assert.equal(r.decidedBy.section, 'default');
  assert.deepEqual(deviceDependence(r), { depends: true, fields: ['app.version'], matchedOnMissing: null });
  const pct: Line = { ...gated, conditions: [], serveVariation: null, split: { by: 'device.id', fallbackBy: null, ranges: [{ variation: 'b', from: 0, to: 5000 }] } };
  const byPct = { ...d, lines: [...d.lines.filter((l) => l.id !== K(2)), pct] };
  assert.deepEqual(deviceDependence(check(byPct, 'acme', 'web')).fields, ['device.id']);
  assert.equal(deviceDependence(check(byPct, 'acme', 'web', { 'device.id': 'd-1' })).depends, false);
});

// ---- new values of variants go through the draft

test('a new value for a variant is a draft change, read by the preview and said in the review', () => {
  const d = toDraft(flag, 'dev');
  const edited = setVariantValues(flag, d, { b: 'B2' });
  assert.deepEqual(valueEdits(flag, edited), [{ key: 'b', value: 'B2', was: 'B' }]);
  assert.equal(valueOf(flag, edited, 'b'), 'B2');
  assert.equal(check(edited, 'acme', 'web').value, 'B2');
  assert.equal(changes(flag, 'dev', d, edited).length, 0, 'no layer changes: only the value');
  assert.deepEqual(summarize(flag, d, edited, meta), ['Change the value of b: B, now B2 (in every environment)']);
  // back to its own value: out of the draft
  assert.equal(setVariantValues(flag, edited, { b: 'B' }).variantValues, undefined);
  // where it's served here
  assert.deepEqual(servedBy(d, 'b'), { rules: 1, defaults: 0 });
  assert.deepEqual(servedBy(d, 'a'), { rules: 0, defaults: 1 });
});

// ---- the review's sentences

test('the review says what a changed rule was and is, a move, a pause, a name, and an override as one', () => {
  const d = toDraft(flag, 'dev');
  const [override, web] = d.lines;
  assert.match(summarize(flag, d, { ...d, lines: [{ ...override, serveVariation: 'b' }, web] }, meta)[0], /^Change override: .+ → c, now .+ → b$/);
  const widened = { ...d, lines: [override, { ...web, conditions: [{ field: 'project', op: 'in', values: ['web', 'android'] }] }] };
  assert.deepEqual(summarize(flag, d, widened, meta), ['Change rule: Service is web → b, now Service is web or android → b']);
  const named = { ...d, lines: [override, { ...web, name: 'Web beta', paused: true }] };
  assert.deepEqual(summarize(flag, d, named, meta), ['Pause rule: “Web beta” (Service is web) → b', 'Name rule “Web beta”: Service is web']);
  const third: Line = { ...web, id: K(3), conditions: [{ field: 'project', op: 'in', values: ['android'] }] };
  const before = { ...d, lines: [override, web, third] };
  const moved = { ...d, lines: [override, third, web] };
  assert.deepEqual(summarize(flag, before, moved, meta), ['Reorder the rules for everyone: 1. Service is android, 2. Service is web']);
  const split: Line = { ...web, serveVariation: null, split: { by: 'device.id', fallbackBy: null, ranges: [{ variation: 'a', from: 0, to: 5000 }, { variation: 'b', from: 5000, to: 7500 }, { variation: 'c', from: 7500, to: 10000 }] } };
  assert.deepEqual(summarize(flag, d, { ...d, lines: [override, split] }, meta), ['Change rule: Service is web → b, now Service is web → 50% a, 25% b, 25% c of devices']);
});

test('a % is worded by what it splits', () => {
  assert.equal(whenText([], { percent: 20 }), '20% of devices');
  assert.equal(whenText([], { percent: 20, by: 'session.id' }), '20% of sessions');
  assert.equal(splitUnit('company', meta.dimensions), 'companies');
});

// ---- the split editor's parts

test('a split’s parts lie end to end; a share stays within what the others leave', () => {
  const one = [{ variation: 'a', from: 0, to: 5000 }];
  const two = withPart(one, 'b', 2500);
  assert.deepEqual(two, [{ variation: 'a', from: 0, to: 5000 }, { variation: 'b', from: 5000, to: 7500 }]);
  const three = withPart(two, 'c', 9999);                                 // only what's left
  assert.deepEqual(three.at(-1), { variation: 'c', from: 7500, to: 10000 });
  assert.equal(leftOver(three), 0);
  // a bigger share than the others leave is cut down; the parts after it move along
  assert.deepEqual(withShare(three, 0, 9000), [{ variation: 'a', from: 0, to: 5000 }, { variation: 'b', from: 5000, to: 7500 }, { variation: 'c', from: 7500, to: 10000 }]);
  assert.deepEqual(withShare(three, 0, 2000), [{ variation: 'a', from: 0, to: 2000 }, { variation: 'b', from: 2000, to: 4500 }, { variation: 'c', from: 4500, to: 7000 }]);
  assert.deepEqual(withoutPart(three, 1), [{ variation: 'a', from: 0, to: 5000 }, { variation: 'c', from: 5000, to: 7500 }]);
  // a split made elsewhere, with gaps, is shown as it is until it's laid end to end
  const gaps = [{ variation: 'a', from: 1000, to: 2000, group: 'x' }, { variation: 'b', from: 5000, to: 6000 }];
  assert.equal(isContiguous(gaps), false);
  assert.deepEqual(endToEnd(gaps), [{ variation: 'a', from: 0, to: 1000, group: 'x' }, { variation: 'b', from: 1000, to: 2000 }]);
  assert.equal(isContiguous(endToEnd(gaps)), true);
});
