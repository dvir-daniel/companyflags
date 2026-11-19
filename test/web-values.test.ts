// A flag's values as typed in the console (web/src/valueText.ts): the text read back as a value, and the checks that
// decide whether it can be saved. The two must agree: what rowError lets through, fromText reads as typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankRow, fromText, rowError, toText, valueError, type ValueRow } from '../web/src/valueText.ts';

const row = (key: string, text: string, isNew = true): ValueRow => ({ key, text, isNew });

test('true and false read the same in any case', () => {
  assert.equal(fromText('bool', 'true'), true);
  assert.equal(fromText('bool', 'TRUE'), true);
  assert.equal(fromText('bool', ' True '), true);
  assert.equal(fromText('bool', 'false'), false);
  assert.equal(fromText('bool', 'FALSE'), false);
  assert.equal(rowError('bool', row('on', 'TRUE'), []), null);
  assert.equal(rowError('bool', row('on', 'yes'), []), 'Pick true or false');
  assert.throws(() => fromText('bool', 'yes'), /true or false/);
});

test('an empty number is an error, never 0', () => {
  assert.equal(rowError('number', row('limit', ''), []), 'Enter a number');
  assert.equal(rowError('number', row('limit', '  '), []), 'Enter a number');
  assert.equal(rowError('number', row('limit', 'abc'), []), 'Enter a number');
  assert.equal(rowError('number', row('limit', 'Infinity'), []), 'Enter a number');
  assert.throws(() => fromText('number', ''), /Enter a number/);
  assert.equal(fromText('number', '42'), 42);
  assert.equal(fromText('number', '-1.5'), -1.5);
  assert.equal(fromText('number', '0'), 0);
  assert.equal(rowError('number', row('limit', '0'), []), null);
});

test('JSON and text', () => {
  assert.deepEqual(fromText('json', '{"a":[1,2]}'), { a: [1, 2] });
  assert.equal(rowError('json', row('cfg', '{nope'), []), 'Not valid JSON');
  assert.throws(() => fromText('json', '{nope'));
  assert.equal(fromText('string', ' as typed '), ' as typed ');
  assert.equal(rowError('string', row('copy', ''), []), null);             // empty text is a value
  assert.equal(valueError('string', ''), null);
});

test('whatever rowError lets through, fromText reads', () => {
  const cases: [string, string][] = [['bool', 'True'], ['bool', 'false'], ['number', ' 7 '], ['number', '1e3'], ['json', '[]'], ['json', 'null'], ['string', '']];
  for (const [type, text] of cases) {
    assert.equal(rowError(type, row('x', text), []), null, `${type} ${JSON.stringify(text)}`);
    assert.doesNotThrow(() => fromText(type, text), `${type} ${JSON.stringify(text)}`);
  }
});

test('names: given, lowercase, not reserved, unique', () => {
  assert.equal(rowError('string', row('', 'x'), []), 'Give this value a name');
  assert.equal(rowError('string', row('Big', 'x'), []), 'Name: lowercase letters, digits, - and _');
  assert.equal(rowError('string', row('code_default', 'x'), []), 'That name is reserved');
  assert.equal(rowError('string', row('val-123', 'x'), []), 'That name is reserved');
  const twin = row('eu', 'x');
  assert.equal(rowError('string', twin, [twin, row('eu', 'y')]), 'Names must be unique');
  // the name is checked before the value
  assert.equal(rowError('number', row('', ''), []), 'Give this value a name');
});

test('values to text and back, and a blank row', () => {
  assert.equal(toText('bool', true), 'true');
  assert.equal(toText('number', 3), '3');
  assert.equal(fromText('json', toText('json', { a: 1 })) instanceof Object, true);
  assert.deepEqual(fromText('json', toText('json', { a: 1 })), { a: 1 });
  assert.equal(blankRow('bool', [row('on', 'TRUE', false)]).text, 'false');   // the other one
  assert.equal(blankRow('number', []).text, '0');
});
