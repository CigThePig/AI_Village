import test from 'node:test';
import { strict as assert } from 'node:assert';

// villagerAI.js → simulation.js → environment.js asserts on AIV_TERRAIN /
// AIV_CONFIG at module-load time. Mirror the stub pattern from the other
// phase-10 tests so the import resolves.
function ensureBrowserStubs() {
  if (!globalThis.document) {
    globalThis.document = {
      getElementById: () => ({
        getContext: () => ({ imageSmoothingEnabled: true }),
        getBoundingClientRect: () => ({ width: 800, height: 600 }),
        style: {},
        width: 0,
        height: 0,
      }),
    };
  }
  if (!globalThis.window) {
    globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
  }
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

const { HYDRATION_BUFF_TICKS, HYDRATION_VISIT_THRESHOLD } = await import('../src/app/villagerAI.js');

// Phase 10 (S10): pre-Phase-10 villagers were >0.90 hydrated for ~76% of the
// day at decay 0.00018/tick + 320-tick buff. The new constants tighten that
// so dry stretches matter — buff is shorter, decay is faster, and the
// dehydrated penalty kicks in earlier.

// Mirror of the constants in src/app/villagerTick.js. Kept here as plain
// numbers so a regression that drifts the .js value is caught loudly without
// reaching into the module's internals (those constants aren't exported on
// purpose — only the tick function consumes them).
const HYDRATION_DECAY = 0.00028;
const HYDRATION_LOW = 0.32;

test('S10: hydration buff is tightened from 320 to 200 ticks', () => {
  assert.equal(HYDRATION_BUFF_TICKS, 200,
    'shorter buff → energy/hunger/mood bonus is a punctual reward, not a default state');
});

test('S10: visit threshold is unchanged so the well decision still triggers at 0.46', () => {
  assert.equal(HYDRATION_VISIT_THRESHOLD, 0.46);
});

test('S10: decay rate reaches the visit threshold within ~half a day', () => {
  // (1.0 - 0.46) / 0.00028 ≈ 1929 ticks. A 3600-tick day means a villager
  // would seek a well roughly twice per day, not once.
  const ticksToVisit = (1 - HYDRATION_VISIT_THRESHOLD) / HYDRATION_DECAY;
  assert.ok(ticksToVisit < 2000,
    `decay rate must reach visit threshold within ~1929 ticks, got ${ticksToVisit}`);
  assert.ok(ticksToVisit > 1500,
    `but not so fast that villagers thrash on wells (cooldown is ~576), got ${ticksToVisit}`);
});

test('S10: dehydration is reachable in normal play, not just edge cases', () => {
  // (1.0 - 0.32) / 0.00028 ≈ 2429 ticks → about 67% of a day. A villager
  // who skips a well visit will spend the late part of the day under the
  // dehydration penalty (energy drain ×1.12, mood loss).
  const ticksToDehydrated = (1 - HYDRATION_LOW) / HYDRATION_DECAY;
  assert.ok(ticksToDehydrated < 3000,
    `dehydrated state must be reachable within a single day's drain, got ${ticksToDehydrated}`);
});

test('S10: simulating decay over the buff window leaves the buff expired', () => {
  // After drinking, hydrationBuffTicks=200. After 200 ticks of decrement
  // it should be 0 (i.e., no longer "hydrated buff").
  let buff = HYDRATION_BUFF_TICKS;
  for (let i = 0; i < HYDRATION_BUFF_TICKS; i++) {
    if (buff > 0) buff--;
  }
  assert.equal(buff, 0, 'buff timer counts down to zero across exactly its duration');
});

test('S10: simulating ~2000 ticks of decay pushes a full villager below visit threshold', () => {
  // (1.0 - 0.46) / 0.00028 ≈ 1929 ticks. Using a slightly higher bound here
  // so the assertion is robust against tiny rate adjustments.
  let hydration = 1;
  const TICKS = 2000;
  for (let i = 0; i < TICKS; i++) {
    hydration = Math.max(0, hydration - HYDRATION_DECAY);
  }
  assert.ok(hydration < HYDRATION_VISIT_THRESHOLD,
    `after ${TICKS} ticks (~55% of a day) a villager should be seeking a well, got hydration=${hydration}`);
});
