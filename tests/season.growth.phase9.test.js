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
  SEASON_GROWTH_BASE,
  SEASON_BLEND_WIDTH,
  seasonalGrowthMultiplier,
} = await import('../src/app/simulation.js');

const SPRING = 0;
const SUMMER = 1;
const AUTUMN = 2;
const WINTER = 3;

test('B4: growth multiplier returns each season base value at progress=0', () => {
  assert.equal(seasonalGrowthMultiplier(SPRING, 0), 1.0);
  assert.equal(seasonalGrowthMultiplier(SUMMER, 0), 1.2);
  assert.equal(seasonalGrowthMultiplier(AUTUMN, 0), 0.8);
  assert.equal(seasonalGrowthMultiplier(WINTER, 0), 0.3);
});

test('B4: growth multiplier holds base value through the middle of the season', () => {
  assert.equal(seasonalGrowthMultiplier(WINTER, 0.5), 0.3);
  assert.equal(seasonalGrowthMultiplier(WINTER, 1 - SEASON_BLEND_WIDTH), 0.3);
  assert.equal(seasonalGrowthMultiplier(SUMMER, 0.5), 1.2);
});

test('B4: growth multiplier blends to next season base over the tail window', () => {
  // End of winter blends toward spring (1.0).
  const winterEnd = seasonalGrowthMultiplier(WINTER, 1);
  assert.ok(Math.abs(winterEnd - SEASON_GROWTH_BASE[SPRING]) < 1e-9,
    `expected end-of-winter to equal spring base, got ${winterEnd}`);
  // A midpoint inside the blend window is strictly between base and next.
  const winterBlendMid = seasonalGrowthMultiplier(WINTER, 1 - SEASON_BLEND_WIDTH / 2);
  assert.ok(winterBlendMid > 0.3 && winterBlendMid < 1.0,
    `expected blend midpoint between 0.3 and 1.0, got ${winterBlendMid}`);
  // Monotonic ramp across the blend window.
  const a = seasonalGrowthMultiplier(WINTER, 1 - SEASON_BLEND_WIDTH + 1e-6);
  const b = seasonalGrowthMultiplier(WINTER, 1 - SEASON_BLEND_WIDTH / 2);
  const c = seasonalGrowthMultiplier(WINTER, 1);
  assert.ok(a < b && b < c, `expected monotonic blend, got ${a} ${b} ${c}`);
});

test('B4: end of summer blends toward autumn base', () => {
  const summerEnd = seasonalGrowthMultiplier(SUMMER, 1);
  assert.ok(Math.abs(summerEnd - SEASON_GROWTH_BASE[AUTUMN]) < 1e-9,
    `expected end-of-summer to equal autumn base, got ${summerEnd}`);
});

test('B4: spring/winter average ratio encodes "~3x slower in winter"', () => {
  const samples = 100;
  let springSum = 0;
  let winterSum = 0;
  for (let i = 0; i < samples; i++) {
    const p = i / samples;
    springSum += seasonalGrowthMultiplier(SPRING, p);
    winterSum += seasonalGrowthMultiplier(WINTER, p);
  }
  const ratio = (springSum / samples) / (winterSum / samples);
  assert.ok(ratio >= 2.7 && ratio <= 3.5,
    `expected spring/winter growth ratio in [2.7, 3.5], got ${ratio}`);
});

test('B4: out-of-range season values wrap into 0..3', () => {
  assert.equal(seasonalGrowthMultiplier(-1, 0), SEASON_GROWTH_BASE[WINTER]);
  assert.equal(seasonalGrowthMultiplier(4, 0), SEASON_GROWTH_BASE[SPRING]);
  assert.equal(seasonalGrowthMultiplier(7, 0), SEASON_GROWTH_BASE[WINTER]);
  assert.equal(seasonalGrowthMultiplier(6, 0), SEASON_GROWTH_BASE[AUTUMN]);
});

test('B4: non-finite progress is treated as 0', () => {
  assert.equal(seasonalGrowthMultiplier(WINTER, NaN), 0.3);
  assert.equal(seasonalGrowthMultiplier(WINTER, Infinity), 0.3);
  assert.equal(seasonalGrowthMultiplier(WINTER, undefined), 0.3);
});
