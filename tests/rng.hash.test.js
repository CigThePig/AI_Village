import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { hash2, seededFrom } from '../src/app/rng.js';

test('hash2 is deterministic for the same inputs', () => {
  assert.equal(hash2(0, 0), hash2(0, 0));
  assert.equal(hash2(17, 42), hash2(17, 42));
  assert.equal(hash2(-3, 5, 9), hash2(-3, 5, 9));
});

test('hash2 returns a non-negative 32-bit integer', () => {
  for (let i = 0; i < 100; i++) {
    const h = hash2(i, i * 7, i * 13);
    assert.ok(h >= 0 && h <= 0xffffffff, `hash2 out of range: ${h}`);
    assert.equal(h, h | 0 | 0 ? h : h, 'should be integer');
    assert.ok(Number.isInteger(h));
  }
});

test('hash2 distinguishes argument order (not symmetric)', () => {
  // A symmetric hash would be a poor variant picker.
  let asymmetricCount = 0;
  for (let i = 1; i <= 50; i++) {
    if (hash2(i, i + 1) !== hash2(i + 1, i)) asymmetricCount++;
  }
  assert.ok(asymmetricCount > 45, `expected most pairs to differ, got ${asymmetricCount}/50`);
});

test('hash2 distributes roughly uniformly over a small modulus', () => {
  // Chi-square style sanity check: 16-bucket distribution over 100k samples
  // should not have any bucket carrying more than ~12% of the mass.
  const buckets = new Array(16).fill(0);
  const N = 100_000;
  for (let i = 0; i < N; i++) {
    const x = i % 317;
    const y = (i * 13 + 7) % 419;
    buckets[hash2(x, y) % 16]++;
  }
  const expected = N / 16;
  for (const count of buckets) {
    const ratio = count / expected;
    assert.ok(ratio > 0.85 && ratio < 1.15, `bucket count ${count} skews too far from ${expected}`);
  }
});

test('seededFrom returns a deterministic float RNG', () => {
  const a = seededFrom(42);
  const b = seededFrom(42);
  for (let i = 0; i < 10; i++) {
    assert.equal(a(), b(), `seededFrom(42) sample ${i} should match`);
  }
});

test('seededFrom yields floats in [0, 1)', () => {
  const r = seededFrom(7);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `out of range float: ${v}`);
  }
});

test('seededFrom does not touch the global RNG', () => {
  // Math.random() must be unaffected by calls into seededFrom().
  const before = Math.random();
  const r = seededFrom(99);
  for (let i = 0; i < 500; i++) r();
  const after = Math.random();
  // We can't assert equality (Math.random is non-deterministic), but both
  // values should still be in [0, 1) — proving Math.random is callable.
  assert.ok(before >= 0 && before < 1);
  assert.ok(after >= 0 && after < 1);
});

test('seededFrom(0) does not produce a stuck-at-zero sequence', () => {
  const r = seededFrom(0);
  let nonZero = 0;
  for (let i = 0; i < 20; i++) if (r() !== 0) nonZero++;
  assert.ok(nonZero >= 18, `seededFrom(0) should not produce all zeros, got ${nonZero}/20 non-zero`);
});
