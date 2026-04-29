import test from 'node:test';
import { strict as assert } from 'node:assert';

// simulation.js -> environment.js asserts on AIV_TERRAIN / AIV_CONFIG at
// module-load time. Mirror the stubs other tests use.
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
  SEASON_HUNGER_BASE,
  seasonalHungerMultiplier,
} = await import('../src/app/simulation.js');

const SPRING = 0;
const SUMMER = 1;
const AUTUMN = 2;
const WINTER = 3;

test('S7: hunger multiplier matches per-season tuning', () => {
  assert.equal(seasonalHungerMultiplier(SPRING), 1.0);
  assert.equal(seasonalHungerMultiplier(SUMMER), 0.95);
  assert.equal(seasonalHungerMultiplier(AUTUMN), 1.0);
  assert.equal(seasonalHungerMultiplier(WINTER), 1.15);
});

test('S7: winter/spring hunger ratio is ~1.15 (drains ~15% faster in winter)', () => {
  const ratio = seasonalHungerMultiplier(WINTER) / seasonalHungerMultiplier(SPRING);
  assert.ok(ratio > 1.149 && ratio < 1.151,
    `expected winter/spring hunger ratio ~1.15, got ${ratio}`);
});

test('S7: out-of-range season values wrap into 0..3', () => {
  assert.equal(seasonalHungerMultiplier(-1), SEASON_HUNGER_BASE[WINTER]);
  assert.equal(seasonalHungerMultiplier(4), SEASON_HUNGER_BASE[SPRING]);
  assert.equal(seasonalHungerMultiplier(7), SEASON_HUNGER_BASE[WINTER]);
  assert.equal(seasonalHungerMultiplier(6), SEASON_HUNGER_BASE[AUTUMN]);
});
