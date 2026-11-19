// CSV export (web/src/csv.ts): free text that a spreadsheet would run as a formula is neutralised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../web/src/csv.ts';

test('a cell that starts like a formula is kept as text', () => {
  assert.equal(csvCell('=SUM(1)'), `"'=SUM(1)"`);
  assert.equal(csvCell('+1'), `"'+1"`);
  assert.equal(csvCell('-2'), `"'-2"`);
  assert.equal(csvCell('@cmd'), `"'@cmd"`);
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(csvCell('a=b'), '"a=b"');                                    // only at the start
});

test('numbers stay numbers, quotes are doubled, nothing is empty', () => {
  assert.equal(csvCell(-5), '"-5"');
  assert.equal(csvCell(42), '"42"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(false), '"false"');
});

test('rows under a header', () => {
  assert.equal(toCsv(['key', 'note'], [['a', '=1'], ['b', null]]), `"key","note"\n"a","'=1"\n"b",""`);
});
