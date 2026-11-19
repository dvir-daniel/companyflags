// Golden vectors (M6). If any of these change, every device in every split moves: that is a
// migration (a new hash_version), not a refactor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, HASH_VERSION, murmur3, murmur3Cbor } from '../server/hash.ts';

test('murmur3 x86_32 matches published reference vectors', () => {
  assert.equal(murmur3(''), 0);
  assert.equal(murmur3('hello'), 0x248bfa47);
  assert.equal(murmur3('The quick brown fox jumps over the lazy dog'), 0x2e4ff723);
  assert.equal(murmur3('héllo wörld'), 2549609076); // UTF-8 input
});

// flagd's fractional: bucket = hash × total weight >> 32, then the first entry whose cumulative weight passes it.
const fractional = (value: string, entries: [string, number][]) => {
  const total = entries.reduce((a, [, w]) => a + w, 0);
  const bucket = Math.floor((murmur3Cbor(value) * total) / 4294967296);
  let end = 0;
  for (const [name, w] of entries) if (bucket < (end += w)) return name;
};

test('hash_version 2 is flagd’s fractional: the answers flagd’s own tests expect', () => {
  // github.com/open-feature/flagd core/pkg/evaluator/fractional_test.go (explicit bucketing values)
  const four: [string, number][] = [['red', 25], ['blue', 25], ['green', 25], ['yellow', 25]];
  const cases: [string, [string, number][], string][] = [
    ['headerColorrachel@faas.com', four, 'red'], ['headerColormonica@faas.com', four, 'green'],
    ['headerColorjoey@faas.com', four, 'red'], ['headerColorross@faas.com', four, 'green'],
    ['my-seedrachel@faas.com', four, 'green'], ['my-seedmonica@faas.com', four, 'yellow'],
    ['my-seedjoey@faas.com', four, 'green'], ['my-seedross@faas.com', four, 'red'],
    ['ross@faas.com', four, 'red'],
    ['email', [['red', 50], ['blue', 25], ['green', 25]], 'blue'],
    ['foo@foo.com', [['red', 25], ['blue', 25]], 'blue'],
    ['test_a@faas.com', four, 'red'], ['test_b@faas.com', four, 'red'], ['test_c@faas.com', four, 'green'], ['test_d@faas.com', four, 'green'],
  ];
  for (const [value, entries, want] of cases) assert.equal(fractional(value, entries), want, value);
});

test('hash_version 2 bucket golden vectors', () => {
  assert.equal(HASH_VERSION, 2);
  assert.equal(bucketFor('new_checkout', 'device-001', 2), 7067);
  assert.equal(bucketFor('new_checkout', 'device-002', 2), 2585);
  assert.equal(bucketFor('dark_mode_v2', 'abc', 2), 2589);
  assert.equal(bucketFor('payments', '00000000-0000-4000-8000-000000000000', 2), 8396);
  // CBOR heads of every length: one byte below 24 bytes, two below 256, three below 65536 (every head byte here is
  // ASCII, so murmur3's UTF-8 path hashes exactly these bytes)
  const ascii = (head: number[], text: string) => murmur3(String.fromCharCode(...head) + text);
  assert.equal(murmur3Cbor('x'.repeat(23)), ascii([0x77], 'x'.repeat(23)));
  assert.equal(murmur3Cbor('x'.repeat(24)), ascii([0x78, 24], 'x'.repeat(24)));
  assert.equal(murmur3Cbor('x'.repeat(300)), ascii([0x79, 1, 44], 'x'.repeat(300)));
  assert.equal(murmur3Cbor('x'.repeat(70000)), ascii([0x7a, 0, 1, 0x11, 0x70], 'x'.repeat(70000)));
});

test('a long input hashes the same the first time as after (the byte buffer grows for it)', () => {
  const long = 'é'.repeat(5000);
  const first = murmur3(long);
  assert.equal(murmur3(long), first);
  const firstCbor = murmur3Cbor(long + 'x');
  assert.equal(murmur3Cbor(long + 'x'), firstCbor);
});

test('buckets are roughly uniform', () => {
  let under2000 = 0;
  for (let i = 0; i < 20000; i++) if (bucketFor('new_checkout', `d-${i}`, 2) < 2000) under2000++;
  assert.ok(Math.abs(under2000 / 20000 - 0.2) < 0.015, `expected ~20%, got ${under2000 / 200}%`);
});

test('unknown and retired hash versions are rejected, never silently remapped', () => {
  assert.throws(() => bucketFor('x', 'y', 3), /unsupported hash_version 3/);
  assert.throws(() => bucketFor('x', 'y', 1), /unsupported hash_version 1/, 'version 1 was retired by migration 0009');
});
