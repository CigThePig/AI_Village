import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// lighting.js → environment.js asserts on AIV_TERRAIN / AIV_CONFIG at
// module-load time. The stubs only need to satisfy load-time guards;
// gradeLightmap is pure and never reads from them.
function ensureBrowserStubs() {
  if (!globalThis.AIV_TERRAIN) {
    globalThis.AIV_TERRAIN = {
      generateTerrain: () => ({}),
      makeHillshade: () => new Uint8ClampedArray(0),
    };
  }
  if (!globalThis.AIV_CONFIG) {
    globalThis.AIV_CONFIG = {
      WORLDGEN_DEFAULTS: {},
      SHADING_DEFAULTS: { ambient: 0.5, intensity: 0.5, slopeScale: 1 },
    };
  }
}
ensureBrowserStubs();

const {
  DAWN_DUSK_TINT,
  NEUTRAL_TINT,
  NIGHT_TINT,
  gradeLightmap
} = await import('../src/app/lighting.js');

test('gradeLightmap returns night tint at deep night', () => {
  const t = gradeLightmap(0);
  assert.equal(t.r, NIGHT_TINT.r);
  assert.equal(t.g, NIGHT_TINT.g);
  assert.equal(t.b, NIGHT_TINT.b);
});

test('gradeLightmap returns neutral at full daylight', () => {
  const t = gradeLightmap(1.0);
  assert.equal(t.r, NEUTRAL_TINT.r);
  assert.equal(t.g, NEUTRAL_TINT.g);
  assert.equal(t.b, NEUTRAL_TINT.b);
});

test('gradeLightmap reaches dawn/dusk warm tint near ambient 0.55', () => {
  const t = gradeLightmap(0.55);
  assert.equal(t.r, DAWN_DUSK_TINT.r);
  assert.equal(t.g, DAWN_DUSK_TINT.g);
  assert.equal(t.b, DAWN_DUSK_TINT.b);
});

test('gradeLightmap blends night → neutral around ambient 0.4', () => {
  const t = gradeLightmap(0.4);
  // At ambient = 0.4 the night→neutral lerp lands on neutral.
  assert.ok(Math.abs(t.r - NEUTRAL_TINT.r) < 1e-6, `r ${t.r}`);
  assert.ok(Math.abs(t.g - NEUTRAL_TINT.g) < 1e-6, `g ${t.g}`);
  assert.ok(Math.abs(t.b - NEUTRAL_TINT.b) < 1e-6, `b ${t.b}`);
});

test('gradeLightmap warm tint pulls red above blue', () => {
  // Sanity check on the dawn/dusk tint shape: red dominates, blue attenuates.
  const t = gradeLightmap(0.55);
  assert.ok(t.r > t.b, `expected r=${t.r} > b=${t.b}`);
  assert.ok(t.r > t.g, `expected r=${t.r} > g=${t.g}`);
});

test('gradeLightmap night tint pulls blue above red', () => {
  const t = gradeLightmap(0);
  assert.ok(t.b > t.r, `expected b=${t.b} > r=${t.r}`);
  assert.ok(t.b > t.g, `expected b=${t.b} > g=${t.g}`);
});

test('gradeLightmap clamps invalid input', () => {
  // Non-finite / out-of-range values should not produce NaN tints.
  const tNeg = gradeLightmap(-0.5);
  const tInf = gradeLightmap(Infinity);
  for (const t of [tNeg, tInf]) {
    assert.ok(Number.isFinite(t.r));
    assert.ok(Number.isFinite(t.g));
    assert.ok(Number.isFinite(t.b));
  }
});

test('gradeLightmap returns a tint per channel in [0, 1]', () => {
  for (let a = 0; a <= 1; a += 0.05) {
    const t = gradeLightmap(a);
    for (const ch of ['r', 'g', 'b']) {
      assert.ok(t[ch] >= 0 && t[ch] <= 1, `${ch} at a=${a} = ${t[ch]} out of [0,1]`);
    }
  }
});
