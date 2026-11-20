// The rule attributes (server/fields.ts): one entry each says its group, label, known values and, for what the server
// works out itself, how its value is found. The console's rule editor and Debug tab are built from these entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIMENSION_GROUP, FIELD_GROUPS, FIELDS, fieldInfo, groupFields, groupLabel, namesEntities, reportedByApp, resolverFor, suggestedValues } from '../server/fields.ts';
import { conditionText, fieldLabel } from '../server/words.ts';

const DIMS = [{ key: 'company', singular: 'company', plural: 'companies' }, { key: 'brand', singular: 'brand', plural: 'brands' }];
const stored = (name: string) => ({ name, valueType: 'string', comesFrom: 'token', canSplitBy: true, description: '' });
// what /meta sends for each stored attribute: fields.ts's, and those of the dimensions and `entity`
const meta = [...FIELDS.map((f) => fieldInfo({ name: f.name, valueType: f.valueType, comesFrom: f.comesFrom, canSplitBy: f.canSplitBy, description: f.description }, DIMS)),
  ...['company', 'brand', 'entity'].map((n) => fieldInfo(stored(n), DIMS))];

test('every attribute in fields.ts is offered by the rule editor, under its group — except the environment; the dimensions’ last', () => {
  const groups = groupFields(meta, DIMS);
  // a rule already sits in one environment, so a check on it would always be true or always false
  assert.deepEqual(FIELDS.filter((f) => f.group === null).map((f) => f.name), ['environment']);
  assert.deepEqual(groups.flatMap(([, fs]) => fs.map((f) => f.name)).sort(),
    [...FIELDS.filter((f) => f.group !== null).map((f) => f.name), 'company', 'brand', 'entity'].sort(), 'each one, once');
  assert.deepEqual(groups.map(([g]) => g), [...FIELD_GROUPS], 'every group has attributes, in the editor’s order');
  for (const [g, fs] of groups) for (const f of fs) assert.equal(f.group, g, f.name);
  const dims = groups.find(([g]) => g === DIMENSION_GROUP)![1];
  assert.deepEqual(dims.map((f) => [f.name, f.label]), [['company', 'Company'], ['brand', 'Brand'], ['entity', 'Company or brand']], 'top first, then the entity itself');
  assert.equal(groupLabel(DIMENSION_GROUP, DIMS), 'Company and brand', 'the group is named with the dimensions’ words');
  assert.equal(groupLabel('App', DIMS), 'App');
  assert.deepEqual(groupFields([{ name: 'old.attribute', group: null }]), [], 'an attribute taken off the list isn’t offered');
  // one dimension: `entity` is the same as its attribute, so it isn't offered
  const one = [{ key: 'customer', singular: 'customer', plural: 'customers' }];
  assert.deepEqual([fieldInfo(stored('entity'), one).group, fieldInfo(stored('entity'), one).label, fieldInfo(stored('customer'), one).label], [null, 'Customer', 'Customer']);
  // the names from before dimensions are read as what they stand for, never offered
  assert.deepEqual([fieldInfo(stored('customer.id'), DIMS).label, fieldInfo(stored('customer.id'), DIMS).group], ['Company or brand', null]);
  assert.deepEqual([fieldInfo(stored('customer.company'), DIMS).label, fieldInfo(stored('customer.company'), DIMS).group], ['Company', null]);
});

test('the editor’s suggestions: the fixed lists, the apps, every entity, or one dimension’s entities', () => {
  const lists = { apps: ['android', 'web'], environments: ['dev', 'prod'],
    entities: [{ key: 'unilever', dimension: 'company' }, { key: 'dove', dimension: 'brand' }, { key: 'acme', dimension: 'company' }] };
  const of = (name: string) => suggestedValues(meta.find((f) => f.name === name), lists);
  assert.deepEqual(of('entity'), ['unilever', 'dove', 'acme']);
  assert.deepEqual(of('company'), ['unilever', 'acme']);
  assert.deepEqual(of('brand'), ['dove']);
  assert.deepEqual([of('project'), of('environment')], [['android', 'web'], ['dev', 'prod']]);
  assert.deepEqual(of('device.platform'), ['android', 'ios', 'web', 'macos', 'windows']);
  assert.deepEqual([of('app.version'), of('nope')], [[], []]);
});

test('labels and entity names come from the entries and the dimensions', () => {
  for (const f of FIELDS) assert.equal(fieldLabel(f.name), f.label);
  assert.equal(fieldLabel('old.attribute'), 'old.attribute');
  assert.deepEqual([fieldLabel('brand', DIMS), fieldLabel('entity', DIMS), fieldLabel('brand')], ['Brand', 'Company or brand', 'brand']);
  const names: Record<string, string> = { unilever: 'Unilever', dove: 'Dove' };
  const vocab = { dimensions: DIMS, nameOf: (k: string) => names[k] };
  assert.equal(conditionText({ field: 'company', op: 'in', values: ['unilever'] }, vocab), 'Company is Unilever');
  assert.equal(conditionText({ field: 'entity', op: 'not_in', values: ['dove'] }, vocab), 'Company or brand is not Dove');
  assert.equal(conditionText({ field: 'customer.id', op: 'in', values: ['dove', 'nobody'] }, vocab), 'Company or brand is Dove or nobody', 'old rules read the same way');
  assert.equal(conditionText({ field: 'project', op: 'in', values: ['dove'] }, vocab), 'Flag set is dove', 'only entity attributes name entities');
  assert.deepEqual(['company', 'brand', 'entity', 'customer.id', 'customer.company', 'project', 'store'].filter((f) => namesEntities(f, ['company', 'brand'])),
    ['company', 'brand', 'entity', 'customer.id', 'customer.company']);
});

test('what the server works out has a resolver and is never taken from the app; the rest is', () => {
  for (const f of FIELDS) {
    assert.equal(!!resolverFor(f.name, []), f.comesFrom !== 'sdk', f.name);
    assert.equal(reportedByApp(f.name, f), f.comesFrom === 'sdk', f.name);
  }
  for (const f of ['entity', 'company', 'brand', 'customer.id', 'customer.company']) {
    assert.ok(resolverFor(f, ['company', 'brand']), `${f}: worked out on the server`);
    assert.equal(reportedByApp(f, { comesFrom: 'token' }), false, f);
  }
  assert.equal(resolverFor('store', ['company', 'brand']), undefined, 'not a dimension here');
  assert.equal(reportedByApp('old.attribute', { comesFrom: 'token' }), false, 'one taken off the list keeps its stored source');
  assert.equal(reportedByApp('old.attribute', { comesFrom: 'sdk' }), true);
});
