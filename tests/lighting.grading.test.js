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
  DAWN_TINT,
  DAY_TINT,
  DEEP_NIGHT_TINT,
  DUSK_TINT,
  NEUTRAL_TINT,
  NIGHT_TINT,
  gradeLightmap
} = await import('../src/app/lighting.js');
const { DAY_LENGTH } = await import('../src/app/constants.js');

const morningTime = DAY_LENGTH * 0.25;
const eveningTime = DAY_LENGTH * 0.75;

test('gradeLightmap returns deep night tint at ambient 0', () => {
  const t = gradeLightmap(0);
  assert.equal(t.r, DEEP_NIGHT_TINT.r);
  assert.equal(t.g, DEEP_NIGHT_TINT.g);
  assert.equal(t.b, DEEP_NIGHT_TINT.b);
});

test('gradeLightmap returns night tint at the deep-night/night seam', () => {
  const t = gradeLightmap(0.28);
  assert.ok(Math.abs(t.r - NIGHT_TINT.r) < 1e-6);
  assert.ok(Math.abs(t.g - NIGHT_TINT.g) < 1e-6);
  assert.ok(Math.abs(t.b - NIGHT_TINT.b) < 1e-6);
});

test('gradeLightmap returns neutral at full daylight', () => {
  const t = gradeLightmap(1.0);
  assert.equal(t.r, NEUTRAL_TINT.r);
  assert.equal(t.g, NEUTRAL_TINT.g);
  assert.equal(t.b, NEUTRAL_TINT.b);
});

test('gradeLightmap reaches dawn warm tint at ambient 0.42 in morning', () => {
  const t = gradeLightmap(0.42, morningTime);
  assert.ok(Math.abs(t.r - DAWN_TINT.r) < 1e-6, `r ${t.r}`);
  assert.ok(Math.abs(t.g - DAWN_TINT.g) < 1e-6, `g ${t.g}`);
  assert.ok(Math.abs(t.b - DAWN_TINT.b) < 1e-6, `b ${t.b}`);
});

test('gradeLightmap reaches dusk warm tint at ambient 0.42 in evening', () => {
  const t = gradeLightmap(0.42, eveningTime);
  assert.ok(Math.abs(t.r - DUSK_TINT.r) < 1e-6, `r ${t.r}`);
  assert.ok(Math.abs(t.g - DUSK_TINT.g) < 1e-6, `g ${t.g}`);
  assert.ok(Math.abs(t.b - DUSK_TINT.b) < 1e-6, `b ${t.b}`);
});

test('gradeLightmap reaches day tint at ambient 0.62', () => {
  const t = gradeLightmap(0.62, morningTime);
  assert.ok(Math.abs(t.r - DAY_TINT.r) < 1e-6, `r ${t.r}`);
  assert.ok(Math.abs(t.g - DAY_TINT.g) < 1e-6, `g ${t.g}`);
  assert.ok(Math.abs(t.b - DAY_TINT.b) < 1e-6, `b ${t.b}`);
});

test('gradeLightmap warm tint pulls red above blue at the warm shoulder', () => {
  const morn = gradeLightmap(0.5, morningTime);
  const eve = gradeLightmap(0.5, eveningTime);
  for (const t of [morn, eve]) {
    assert.ok(t.r > t.b, `expected r=${t.r} > b=${t.b}`);
    assert.ok(t.r > t.g, `expected r=${t.r} > g=${t.g}`);
  }
});

test('dusk reads warmer/redder than dawn', () => {
  const dawn = gradeLightmap(0.42, morningTime);
  const dusk = gradeLightmap(0.42, eveningTime);
  // Dusk drops green and blue further than dawn, so r/g and r/b ratios are higher.
  assert.ok(dusk.b < dawn.b, `dusk b=${dusk.b} should be < dawn b=${dawn.b}`);
  assert.ok(dusk.g < dawn.g, `dusk g=${dusk.g} should be < dawn g=${dawn.g}`);
});

test('gradeLightmap night tint pulls blue above red', () => {
  const t = gradeLightmap(0);
  assert.ok(t.b > t.r, `expected b=${t.b} > r=${t.r}`);
  assert.ok(t.b > t.g, `expected b=${t.b} > g=${t.g}`);
});

test('deep night is bluer than the night shoulder', () => {
  const deep = gradeLightmap(0);
  const night = gradeLightmap(0.28);
  assert.ok(deep.r < night.r, `deep r=${deep.r} should be < night r=${night.r}`);
  assert.ok(deep.g < night.g, `deep g=${deep.g} should be < night g=${night.g}`);
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
    for (const dt of [null, morningTime, eveningTime]) {
      const t = gradeLightmap(a, dt);
      for (const ch of ['r', 'g', 'b']) {
        assert.ok(t[ch] >= 0 && t[ch] <= 1, `${ch} at a=${a} dt=${dt} = ${t[ch]} out of [0,1]`);
      }
    }
  }
});

test('gradeLightmap defaults to dawn tint when dayTime is missing', () => {
  const noTime = gradeLightmap(0.42);
  assert.ok(Math.abs(noTime.r - DAWN_TINT.r) < 1e-6);
  assert.ok(Math.abs(noTime.g - DAWN_TINT.g) < 1e-6);
  assert.ok(Math.abs(noTime.b - DAWN_TINT.b) < 1e-6);
});
