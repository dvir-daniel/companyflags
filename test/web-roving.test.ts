// The keyboard in the console's groups with one Tab stop (packages/ui roving.ts: tabs and radio groups): the arrow
// keys move to the next item that can be chosen, wrapping around, and Home and End go to the ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowTarget } from '../packages/ui/src/components/roving.ts';

test('arrow keys move through the items that can be chosen, and wrap around', () => {
  const all = [true, true, true];
  assert.equal(arrowTarget('ArrowRight', 0, all), 1);
  assert.equal(arrowTarget('ArrowRight', 2, all), 0, 'past the last: the first');
  assert.equal(arrowTarget('ArrowLeft', 0, all), 2, 'before the first: the last');
  assert.equal(arrowTarget('Home', 2, all), 0);
  assert.equal(arrowTarget('End', 0, all), 2);
  assert.equal(arrowTarget('Enter', 0, all), null, 'other keys are the page’s');
});

test('a disabled item is skipped; ↑/↓ count only in a radio group', () => {
  const some = [true, false, true, false];
  assert.equal(arrowTarget('ArrowRight', 0, some), 2);
  assert.equal(arrowTarget('End', 0, some), 2);
  assert.equal(arrowTarget('ArrowDown', 0, some), null, 'tabs leave ↑/↓ to the page');
  assert.equal(arrowTarget('ArrowDown', 0, some, 'both'), 2);
  assert.equal(arrowTarget('ArrowRight', 0, [false, false]), null);
});
