// Bucketing hash contract. Each version maps a 32-bit MurmurHash3 (x86, seed 0) to [0, 10000) as
// floor(hash × 10000 / 2^32), over the text `${salt}/${unit}`:
//   hash_version 2: the hash of its deterministic CBOR encoding (a text-string head, then the UTF-8 bytes). This is
//     flagd's `fractional` with the bucketing value {"cat": [salt, "/", unit]} and weights out of 10000, so a backend
//     evaluating our flagd JSON (flagd.ts) puts every device in the same group as our server and the apps' files.
//     Every % rule is saved with it (checks.ts). Version 1 (the hash of the UTF-8 bytes alone) was retired by
//     migration 0009, which moved every rule to 2.
// Changing any part of a version is a migration: add a new version, never edit one.
// Golden vectors in test/hash.test.ts pin it, flagd's own test answers among them.

export const BUCKETS = 10000;
/** The version every % rule is saved with. */
export const HASH_VERSION = 2;

// One encoder and one byte buffer, reused: this runs once per "% of devices" rule on every request.
const encoder = new TextEncoder();
const HEAD = 5;                                          // room for the longest CBOR text-string head
let buf = new Uint8Array(256);

/** MurmurHash3 x86 32-bit of `data[start, start + len)`. */
function murmur3Bytes(data: Uint8Array, start: number, len: number, seed: number): number {
  const nblocks = len >>> 2;
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  for (let i = 0; i < nblocks; i++) {
    const o = start + i * 4;
    let k1 = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }

  const tail = start + nblocks * 4;
  let k1 = 0;
  switch (len & 3) {
    case 3: k1 ^= data[tail + 2] << 16; // falls through
    case 2: k1 ^= data[tail + 1] << 8;  // falls through
    case 1:
      k1 ^= data[tail];
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h1 ^= k1;
  }

  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

/** Writes `input` as UTF-8 at buf[HEAD…]; returns its length in bytes. */
function utf8(input: string): number {
  if (HEAD + input.length * 3 > buf.length) buf = new Uint8Array(HEAD + input.length * 3);   // worst case UTF-8 size
  return encoder.encodeInto(input, buf.subarray(HEAD)).written;
}

/** MurmurHash3 x86 32-bit of the UTF-8 bytes of `input`. */
export function murmur3(input: string, seed = 0): number {
  const n = utf8(input);                                 // first: it may replace `buf` with a bigger one
  return murmur3Bytes(buf, HEAD, n, seed);
}

/** MurmurHash3 x86 32-bit of `input` as a deterministic CBOR text string (RFC 8949 §4.2.1: the shortest head). */
export function murmur3Cbor(input: string, seed = 0): number {
  const n = utf8(input);
  let start: number;
  if (n < 24) { start = HEAD - 1; buf[start] = 0x60 | n; }
  else if (n < 0x100) { start = HEAD - 2; buf[start] = 0x78; buf[start + 1] = n; }
  else if (n < 0x10000) { start = HEAD - 3; buf[start] = 0x79; buf[start + 1] = n >>> 8; buf[start + 2] = n & 0xff; }
  else { start = HEAD - 5; buf[start] = 0x7a; buf[start + 1] = n >>> 24; buf[start + 2] = (n >>> 16) & 0xff; buf[start + 3] = (n >>> 8) & 0xff; buf[start + 4] = n & 0xff; }
  return murmur3Bytes(buf, start, HEAD - start + n, seed);
}

export function bucketFor(salt: string, unit: string, hashVersion: number): number {
  if (hashVersion !== 2) throw new Error(`unsupported hash_version ${hashVersion}`);
  return Math.floor((murmur3Cbor(`${salt}/${unit}`) * BUCKETS) / 4294967296);
}
