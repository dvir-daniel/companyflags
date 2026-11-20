// The console's safety helpers (web/src/pages/safetyKit.ts): how many % points a change to a % moves, as the review
// says it, and the schedule field's checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromNow, percentMoves, scheduleProblem } from '../web/src/pages/safetyKit.ts';

const pct = (ranges: { variation: string; from: number; to: number }[], salt = 'checkout') => ({
  name: null, locked: false, disabled: false, conditions: [], serveVariation: null, split: { by: 'device.id', fallbackBy: null, salt, hashVersion: 2, ranges },
});

test('percent moves: growing adds devices, a moved range reassigns them, a new salt places everyone again', () => {
  const ten = pct([{ variation: 'on', from: 0, to: 1000 }]);
  assert.deepEqual(percentMoves(ten, pct([{ variation: 'on', from: 0, to: 2500 }])), { moved: 15, lose: 0, reshuffled: false }, '10% → 25%: 15 points get it');
  assert.deepEqual(percentMoves(ten, pct([{ variation: 'on', from: 0, to: 500 }])), { moved: 5, lose: 5, reshuffled: false }, 'back to 5%: 5 points lose it');
  assert.deepEqual(percentMoves(ten, pct([{ variation: 'on', from: 5000, to: 6000 }])), { moved: 20, lose: 10, reshuffled: false }, 'the same 10%, other devices');
  assert.deepEqual(percentMoves(ten, pct([{ variation: 'off', from: 0, to: 1000 }])), { moved: 10, lose: 10, reshuffled: false }, 'the same devices, another value');
  assert.deepEqual(percentMoves(ten, pct([{ variation: 'on', from: 0, to: 1000 }], 'other')), { moved: 100, lose: 10, reshuffled: true });
  assert.deepEqual(percentMoves(ten, ten), { moved: 0, lose: 0, reshuffled: false });
  assert.equal(percentMoves({ ...ten, split: null }, { ...ten, split: null }), null, 'not a % rule');
});

test('the schedule field: a time that has passed is refused; how far off it is, in words', () => {
  const now = new Date('2026-11-20T10:00:00Z').getTime();
  assert.match(scheduleProblem('', now)!, /Pick a date/);
  assert.match(scheduleProblem(new Date(now - 60_000).toISOString(), now)!, /has passed/);
  assert.equal(scheduleProblem(new Date(now + 60_000).toISOString(), now), null);
  assert.equal(fromNow(new Date(now + 5 * 60_000).toISOString(), now), 'in 5 minutes');
  assert.equal(fromNow(new Date(now + 14 * 3600_000).toISOString(), now), 'in 14 hours');
  assert.equal(fromNow(new Date(now + 3 * 86400_000).toISOString(), now), 'in 3 days');
});
