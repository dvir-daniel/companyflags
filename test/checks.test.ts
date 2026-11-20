// What the server accepts (checks.ts) and how lists page (listing.ts): pure, so no server is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLayer, checkRule, conditionProblem, entityKeyProblem, needsRemoveBy, type FieldFacts } from '../server/checks.ts';
import { canBreakGlass } from '../server/policy.ts';
import { likePattern, listQuery, pageOf, searchHit } from '../server/listing.ts';

const fields: FieldFacts = {
  project: { valueType: 'string', canSplitBy: false }, 'app.version': { valueType: 'semver', canSplitBy: false },
  'app.build': { valueType: 'int', canSplitBy: false }, 'device.id': { valueType: 'string', canSplitBy: true },
  'session.id': { valueType: 'string', canSplitBy: true },
};
const config = { key: 'f', kind: 'config', variants: new Set(['on', 'off']) };
const KEY = '00000000-0000-4000-8000-000000000001';

test('checks on one condition: the words the rule editor shows', () => {
  assert.equal(conditionProblem({ field: 'app.version', op: 'semver_lt', values: [] }, fields), 'Add a value for “App version”');
  assert.equal(conditionProblem({ field: 'app.version', op: 'semver_lt', values: ['five'] }, fields), 'App version must look like 5.0.0');
  assert.equal(conditionProblem({ field: 'app.version', op: 'semver_lt', values: ['5.1'] }, fields), null);
  assert.equal(conditionProblem({ field: 'app.build', op: 'gt', values: ['1.5'] }, fields), 'App build number must be a whole number');
  assert.equal(conditionProblem({ field: 'app.version', op: 'in', values: ['5.0.0'] }, fields), '“is” can’t be used with App version');
  assert.equal(conditionProblem({ field: 'project', op: 'exists' }, fields), null);
});

test('a version in a rule is saved in full: 6 → 6.0.0 (strict semver readers of flagd JSON refuse short ones)', () => {
  const rule = (values: string[]) => checkRule({ ruleKey: KEY, conditions: [{ field: 'app.version', op: 'semver_gte', values }], serveVariation: 'on' }, config, fields, { isBase: true });
  assert.deepEqual(rule(['6']).rule.conditions[0].values, ['6.0.0']);
  assert.deepEqual(rule(['v6.1']).rule.conditions[0].values, ['6.1.0']);
  assert.deepEqual(rule(['6.0-beta.1']).rule.conditions[0].values, ['6.0.0-beta.1']);
  assert.deepEqual(rule(['6.0.0+build.5']).rule.conditions[0].values, ['6.0.0'], 'comparing ignores the build');
  assert.deepEqual(rule(['6.2.1']).rule.conditions[0].values, ['6.2.1']);
  assert.deepEqual(rule(['five']).rule.conditions[0].values, ['five'], 'not a version: kept, and refused');
  assert.match(rule(['five']).problems.join(), /must look like 5.0.0/);
});

test('a rule: flag purpose rules and the % of devices', () => {
  const pct = (to: number, fallbackBy: string | null = null) => ({ ruleKey: KEY, split: { by: 'device.id', fallbackBy, ranges: [{ variation: 'on', from: 0, to }] } });
  assert.deepEqual(checkRule(pct(0), config, fields, { isBase: true }).problems, ['Set a percentage above 0']);
  assert.match(checkRule(pct(1000), { ...config, kind: 'permission' }, fields, { isBase: true }).problems.join(), /permission flags can’t use %/);
  assert.match(checkRule(pct(1000, 'session.id'), config, fields, { isBase: true }).problems.join(), /sticky/);
  assert.deepEqual(checkRule(pct(1000, 'session.id'), { ...config, kind: 'release' }, fields, { isBase: true }).problems, []);
  assert.match(checkRule({ ruleKey: KEY, locked: true, serveVariation: 'on' }, config, fields, { isBase: false }).problems.join(), /overrides are only for everyone/);
});

test('a layer: every problem, prefixed with the rule it is in', () => {
  const { errors } = checkLayer(config, fields, true, { enabled: true, defaultVariation: 'nope', rules: [
    { ruleKey: KEY, serveVariation: 'on', conditions: [{ field: 'app.build', op: 'gt', values: [] }] },
    { ruleKey: KEY, locked: true, serveVariation: 'off' },
  ] }, null);
  assert.deepEqual(errors, [
    'Default: unknown variant “nope”',
    'rule 1: Add a value for “App build number”',
    'rule 2: duplicate ruleKey',
    'rule 2: overrides must come before other rules',
  ]);
});

test('a flag’s kind decides whether it needs a remove-by date and whether on-call may switch it off', () => {
  assert.deepEqual(['release', 'experiment', 'config'].map((k) => needsRemoveBy(k)), [true, true, false]);
  // a version release (its values are versions) stays: no remove-by date; a release of other strings still needs one
  const versions = { valueType: 'string', variants: [{ key: '1_0_0', value: '1.0.0' }, { key: '1_0_1', value: '1.0.1' }] };
  assert.equal(needsRemoveBy('release', versions), false);
  assert.equal(needsRemoveBy('release', { valueType: 'string', variants: [{ key: 'a', value: '1.0' }] }), true);
  assert.equal(needsRemoveBy('release', { ...versions, valueType: 'json' }), true);
  assert.equal(needsRemoveBy('experiment', versions), true);
  assert.deepEqual([canBreakGlass('kill_switch', 'oncall'), canBreakGlass('kill_switch', 'editor'), canBreakGlass('config', 'admin')], [true, false, false]);
});

test('% of devices: every rule is saved with hash version 2 (flagd’s); no other is taken', () => {
  const pct = (hashVersion?: number) => ({ ruleKey: KEY, split: { by: 'device.id', hashVersion, ranges: [{ variation: 'on', from: 0, to: 1000 }] } });
  for (const v of [undefined, 2]) {
    const r = checkRule(pct(v), config, fields, { isBase: true });
    assert.deepEqual([r.problems, r.rule.split?.hashVersion], [[], 2], `sent ${v}`);
  }
  for (const v of [1, 3]) assert.deepEqual(checkRule(pct(v), config, fields, { isBase: true }).problems, [`% of devices: hash version ${v} doesn’t exist (only 2)`]);
});

test('“base”, “trace” and “compare” can’t be entity or environment keys: the console’s addresses use them', () => {
  for (const key of ['base', 'trace', 'compare']) assert.match(entityKeyProblem(key)!, /reserved word/, key);
  assert.equal(entityKeyProblem('acme'), null);
  assert.equal(entityKeyProblem('bases'), null);
  assert.match(entityKeyProblem('Acme')!, /lowercase/);
  assert.match(entityKeyProblem('-acme')!, /start with a letter or digit/);
});

test('lists: one paging contract', () => {
  const q = listQuery((k) => ({ page: '1', size: '999', q: ' AB ' } as Record<string, string>)[k])!;
  assert.deepEqual(q, { page: 1, size: 200, q: 'ab' });
  assert.equal(listQuery(() => undefined), null);
  const rows = Array.from({ length: 450 }, (_, i) => `row-${i}${i % 3 ? '' : '-ab'}`);
  const p = pageOf(rows, q, (r) => searchHit(q.q, r));
  assert.deepEqual([p.matched, p.all, p.rows.length, p.rows[0]], [150, 450, 0, undefined]);
  assert.equal(pageOf(rows, { page: 0, size: 10, q: '' }).rows.length, 10);
  assert.equal(likePattern('50%_off'), '%50\\%\\_off%');
});
