import test from 'node:test';
import { strict as assert } from 'node:assert';

// villagerAI.js → world.js → simulation.js → environment.js asserts on
// AIV_TERRAIN / AIV_CONFIG at module-load time. Mirror the stubs other tests
// use.
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

const {
  REST_BASE_TICKS,
  REST_EXTRA_PER_ENERGY,
  restDurationTicks,
  wantsToSleep,
} = await import('../src/app/villagerAI.js');
const {
  isDeepNight,
  isNightAmbient,
  createTimeOfDay,
} = await import('../src/app/simulation.js');
const { DAY_LENGTH } = await import('../src/app/constants.js');

// Mirror of the wake-at-dawn exit predicate in villagerTick.js (S2). Keeping
// a copy here lets us assert behavior without instantiating the full
// villager-tick state machine, matching the predicate-style approach used
// by tests/villager.restThreshold.phase3.test.js.
function shouldWake({ restTimer, energy, restStartedAtNight, nightNow }) {
  const wokeAtDawn = !!restStartedAtNight && !nightNow;
  return restTimer <= 0 || energy >= 0.995 || wokeAtDawn;
}

test('S1: wantsToSleep — soft night nudge fires at energy < 0.65 when not on a critical job', () => {
  const v = { state: 'idle', energy: 0.5 };
  assert.equal(
    wantsToSleep(v, { nightNow: true, deepNight: false, urgentFood: false }),
    true,
    'tired villager at night should want to sleep'
  );
  assert.equal(
    wantsToSleep(v, { nightNow: false, deepNight: false, urgentFood: false }),
    false,
    'same villager mid-day should not seek bed'
  );
  assert.equal(
    wantsToSleep({ state: 'idle', energy: 0.7 }, { nightNow: true, deepNight: false, urgentFood: false }),
    false,
    'rested villager at night does not seek bed via the soft nudge'
  );
});

test('S1: wantsToSleep — deep night forces sleep regardless of energy', () => {
  const v = { state: 'idle', energy: 0.95 };
  assert.equal(
    wantsToSleep(v, { nightNow: true, deepNight: true, urgentFood: false }),
    true,
    'deep night forces sleep even at near-full energy'
  );
  assert.equal(
    wantsToSleep(v, { nightNow: true, deepNight: true, urgentFood: true }),
    false,
    'urgentFood overrides deep-night sleep pull'
  );
});

test('S1: wantsToSleep — hard floor at 0.30 always sleeps', () => {
  assert.equal(
    wantsToSleep({ state: 'idle', energy: 0.25 }, { nightNow: false, deepNight: false, urgentFood: false }),
    true,
    'energy < 0.30 sleeps even mid-day'
  );
  assert.equal(
    wantsToSleep({ state: 'idle', energy: 0.31 }, { nightNow: false, deepNight: false, urgentFood: false }),
    false,
    'energy just above the hard floor does not sleep mid-day'
  );
});

test('S1: wantsToSleep — active building/hunt states suppress night sleep', () => {
  const opts = { nightNow: true, deepNight: true, urgentFood: false };
  assert.equal(
    wantsToSleep({ state: 'building', energy: 0.5 }, opts),
    false,
    'active builder does not abandon work at deep night'
  );
  assert.equal(
    wantsToSleep({ state: 'hunt', energy: 0.5 }, opts),
    false,
    'active hunter does not abandon hunt at deep night'
  );
  // But the 0.30 floor still trumps critical states — exhausted villagers
  // collapse regardless.
  assert.equal(
    wantsToSleep({ state: 'building', energy: 0.2 }, opts),
    true,
    'exhausted builder still sleeps at the hard floor'
  );
});

test('S2: wake-at-dawn fires when restStartedAtNight and night ends', () => {
  assert.equal(
    shouldWake({ restTimer: 50, energy: 0.7, restStartedAtNight: true, nightNow: false }),
    true,
    'sleeper from the night wakes when ambient flips to day'
  );
  assert.equal(
    shouldWake({ restTimer: 50, energy: 0.7, restStartedAtNight: true, nightNow: true }),
    false,
    'still night → no wake from the dawn condition'
  );
  assert.equal(
    shouldWake({ restTimer: 50, energy: 0.7, restStartedAtNight: false, nightNow: false }),
    false,
    'mid-day napper without the night flag stays until timer/energy'
  );
});

test('S2: wake-at-dawn does not regress the original exit conditions', () => {
  assert.equal(
    shouldWake({ restTimer: 0, energy: 0.5, restStartedAtNight: false, nightNow: true }),
    true,
    'restTimer expiry still wakes'
  );
  assert.equal(
    shouldWake({ restTimer: 100, energy: 0.999, restStartedAtNight: false, nightNow: true }),
    true,
    'near-full energy still wakes'
  );
});

test('S3: restDurationTicks unifies the on-arrive seed and the in-state clamp', () => {
  for (const e of [0, 0.3, 0.65, 1.0]) {
    const expected = REST_BASE_TICKS + Math.round(Math.max(0, 1 - e) * REST_EXTRA_PER_ENERGY);
    assert.equal(
      restDurationTicks(e),
      expected,
      `restDurationTicks(${e}) must equal the canonical formula`
    );
  }
  // Both call sites previously diverged: villagerTick.js used a ×0.35
  // multiplier, onArrive.js used ×1.0. After unification both use ×1.0 —
  // assert the helper agrees with the on-arrive value at energy 0.
  assert.equal(restDurationTicks(0), REST_BASE_TICKS + REST_EXTRA_PER_ENERGY);
});

test('isDeepNight: window centered on midnight, false during day and edges', () => {
  // DAY_LENGTH = 3600, daytime portion = 2/3, nighttime portion = 1/3.
  // dayTime = 0 corresponds to noon (peak ambient), dayTime = 1800 to
  // midnight (midpoint of the night portion).
  assert.equal(isDeepNight(0, DAY_LENGTH), false, 'noon is not deep night');
  assert.equal(isDeepNight(DAY_LENGTH * 0.25, DAY_LENGTH), false, 'mid-afternoon is not deep night');
  assert.equal(isDeepNight(1800, DAY_LENGTH), true, 'midnight is deep night');
  // Edges of the deep-night window: ±10% of nighttime portion = ±120 ticks.
  assert.equal(isDeepNight(1700, DAY_LENGTH), true, 'just before midnight is deep night');
  assert.equal(isDeepNight(1900, DAY_LENGTH), true, 'just after midnight is deep night');
  assert.equal(isDeepNight(1500, DAY_LENGTH), false, 'early-night edge outside the window');
  assert.equal(isDeepNight(2100, DAY_LENGTH), false, 'late-night edge outside the window');
  // Wrap handling: dayTime values past DAY_LENGTH should still classify
  // correctly via the % 1 phase rotation.
  assert.equal(isDeepNight(1800 + DAY_LENGTH, DAY_LENGTH), true, 'wrap: midnight one cycle later');
});

test('S1 acceptance: across a full day the predicate matches ambient on a normal villager', () => {
  // Synthetic full-day sweep. The fix-plan acceptance is "the village's sleep
  // state matches ambient." We assert the predicate is true for ≥80% of
  // deep-night ticks and false for ≥95% of mid-day ticks.
  const time = createTimeOfDay({ getTick: () => 0, getDayTime: () => 0 });
  const v = { state: 'idle', energy: 0.7 };
  let deepNightSamples = 0;
  let deepNightSleeps = 0;
  let midDaySamples = 0;
  let midDayWakes = 0;
  for (let dt = 0; dt < DAY_LENGTH; dt += 60) {
    const ambient = time.ambientAt(dt);
    const nightNow = isNightAmbient(ambient);
    const deepNight = isDeepNight(dt, DAY_LENGTH);
    const sleep = wantsToSleep(v, { nightNow, deepNight, urgentFood: false });
    if (deepNight) {
      deepNightSamples += 1;
      if (sleep) deepNightSleeps += 1;
    }
    // "mid-day" sample: well away from the deep-night window AND not night.
    if (!nightNow && !deepNight && (dt < DAY_LENGTH * 0.25 || dt > DAY_LENGTH * 0.75)) {
      midDaySamples += 1;
      if (!sleep) midDayWakes += 1;
    }
  }
  assert.ok(deepNightSamples > 0, 'must have observed deep-night samples');
  assert.ok(midDaySamples > 0, 'must have observed mid-day samples');
  assert.ok(
    deepNightSleeps / deepNightSamples >= 0.8,
    `expected ≥80% deep-night sleeps, got ${deepNightSleeps}/${deepNightSamples}`
  );
  assert.ok(
    midDayWakes / midDaySamples >= 0.95,
    `expected ≥95% mid-day wakes, got ${midDayWakes}/${midDaySamples}`
  );
});
