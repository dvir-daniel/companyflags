// Versions in rules ("App version is below 5.0.0") are compared as versions (M4), not as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpVersion, compareSemver, compareVersions, newVersionProblem, parseSemver, releaseVersionProblem } from '../server/semver.ts';
import { testCondition } from '../server/evaluator.ts';

test('semver compares numerically, not as strings', () => {
  const v = (s: string) => parseSemver(s)!;
  assert.equal(compareSemver(v('5.10.0'), v('5.9.0')), 1);
  assert.equal(compareSemver(v('5'), v('5.0.0')), 0);
  assert.equal(compareSemver(v('5.0.0-beta.2'), v('5.0.0')), -1);
  assert.equal(compareSemver(v('5.0.0-beta.10'), v('5.0.0-beta.2')), 1);
  assert.equal(parseSemver('five'), null);
});

test('a version in a rule is read once and compared the same every time', () => {
  const below5 = { field: 'app.version', op: 'semver_lt' as const, values: ['5.0.0'] };
  for (let i = 0; i < 3; i++) {
    assert.equal(testCondition(below5, '4.9.9'), true);
    assert.equal(testCondition(below5, '5.10.0'), false);
    assert.equal(testCondition(below5, 'banana'), null, 'an app version that isn’t one: missing');
  }
  assert.equal(testCondition({ field: 'app.version', op: 'semver_gte', values: ['not-a-version'] }, '1.0.0'), null, 'a rule version that isn’t one');
});

// Release versions (docs/content/docs/guide/releases.md): a version release's values, stricter than what rules compare.
test('a release version is SemVer 2.0.0 with one spelling: three numbers, a lowercase prerelease, no v, no +build', () => {
  for (const ok of ['0.0.0', '1.0.1', '10.20.30', '1.0.1-beta.2', '1.0.0-0.3.7', '1.0.0-x-y-z.--', '2.0.0-rc.1']) {
    assert.equal(releaseVersionProblem(ok), null, ok);
  }
  const refused: [string, RegExp][] = [
    ['v1.0.1', /no v in front/], ['1.0', /Three numbers/], ['1', /Three numbers/], ['01.0.0', /leading zeros/], ['1.0.1+5', /No \+ part/],
    ['1.0.1-RC.1', /Lowercase after the dash: 1\.0\.1-rc\.1/], ['1.0.1-01', /Write it as/], [' 1.0.1', /No spaces/], ['1.0.1-', /Write it as/],
    [`1.0.0-${'a'.repeat(60)}`, /At most 64/], ['9007199254740992.0.0', /at most 9007199254740991/], ['', /Write a version/],
  ];
  for (const [v, why] of refused) assert.match(releaseVersionProblem(v) ?? 'accepted', why, v);
  assert.equal(releaseVersionProblem(1 as unknown), 'Write a version, like 1.0.0');
});

test('release versions sort as semver.org says', () => {
  const list = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  assert.deepEqual([...list].reverse().sort(compareVersions), list);
});

test('the next version, as npm version makes it; a new one is higher than every one before', () => {
  const bump = (v: string) => (['patch', 'minor', 'major'] as const).map((p) => bumpVersion(v, p));
  assert.deepEqual(bump('1.0.0'), ['1.0.1', '1.1.0', '2.0.0']);
  assert.deepEqual(bump('1.2.3'), ['1.2.4', '1.3.0', '2.0.0']);
  assert.deepEqual(bump('1.1.0-rc.1'), ['1.1.0', '1.1.0', '2.0.0']);
  assert.deepEqual(bump('2.0.0-rc.1'), ['2.0.0', '2.0.0', '2.0.0']);
  assert.deepEqual(bump('1.2.3-beta'), ['1.2.3', '1.3.0', '2.0.0']);
  const had = ['1.0.0', '1.0.1-beta.1'];
  assert.equal(newVersionProblem('1.0.1', had), null);
  assert.equal(newVersionProblem('1.0.1-beta.1', had), '1.0.1-beta.1 is already a version');
  assert.equal(newVersionProblem('1.0.1-alpha', had), 'Higher than 1.0.1-beta.1, the newest version');
  assert.equal(newVersionProblem('0.9.0', had), 'Higher than 1.0.1-beta.1, the newest version');
  assert.match(newVersionProblem('v2.0.0', had)!, /no v/);
  assert.equal(newVersionProblem('1.0.0', []), null);
});
