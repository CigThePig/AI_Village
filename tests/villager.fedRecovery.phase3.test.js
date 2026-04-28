import test from 'node:test';
import { strict as assert } from 'node:assert';

// villagerAI → simulation → environment asserts on AIV_TERRAIN / AIV_CONFIG
// at module-load time; world.js → canvas.js touches `document` / `window`.
// Mirror movement.speed.test.js's load-time stubs.
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
  createVillagerAI,
  STARVE_THRESH,
  STARVE_RECOVERY_TICKS,
  FOOD_HUNGER_RECOVERY,
} = await import('../src/app/villagerAI.js');
const { ITEM } = await import('../src/app/constants.js');

function makeAI({ storageFood = 0 } = {}) {
  const storageTotals = { food: storageFood, wood: 0, stone: 0 };
  const state = {
    units: { buildings: [], jobs: [], villagers: [], itemsOnGround: [] },
    stocks: { totals: storageTotals, reserved: {} },
    time: { tick: 100, dayTime: 1000 },
    world: {},
  };
  const noop = () => {};
  const ai = createVillagerAI({
    state,
    policy: { style: { jobScoring: {}, hunger: {}, jobCreation: {} }, sliders: {} },
    pathfind: () => null,
    passable: () => true,
    Toast: { show: noop },
    addJob: noop,
    finishJob: (v) => { v.targetJob = null; },
    noteJobAssignmentChanged: noop,
    availableToReserve: () => 0,
    reserveMaterials: () => true,
    releaseReservedMaterials: noop,
    findAnimalById: () => null,
    findEntryTileNear: () => ({ x: 0, y: 0 }),
    getBuildingById: () => null,
    buildingsByKind: new Map(),
    idx: () => 0,
    ambientAt: () => 'day',
    isNightTime: () => false,
  });
  return { ai, state, storageTotals };
}

function makeVillager(overrides = {}) {
  return {
    x: 0,
    y: 0,
    inv: null,
    hunger: 0.5,
    energy: 0.8,
    happy: 0.7,
    condition: 'normal',
    starveStage: 0,
    sickTimer: 0,
    recoveryTimer: 0,
    state: 'idle',
    path: null,
    targetJob: null,
    nextStarveWarning: 0,
    thought: '',
    ...overrides,
  };
}

test('B14: STARVE_THRESH.sick is reachable from the hunger clamp', () => {
  // Hunger clamps at 1.2 in villagerTick.js. sick must be strictly below
  // the clamp so accumulation can reach stage 3.
  assert.ok(STARVE_THRESH.sick < 1.2, `sick=${STARVE_THRESH.sick} must be < hunger clamp 1.2`);
  assert.ok(STARVE_THRESH.sick > STARVE_THRESH.starving, 'sick must remain > starving');
  assert.ok(1.2 - STARVE_THRESH.sick >= 0.02, 'reachable margin must be at least 0.02');
});

test('B14: stage classification reaches 3 at clamp ceiling', () => {
  // Mirrors villagerTick.js stage assignment. Pure arithmetic.
  function classify(h) {
    let s = 0;
    if (h > STARVE_THRESH.hungry) s = 1;
    if (h > STARVE_THRESH.starving) s = 2;
    if (h > STARVE_THRESH.sick) s = 3;
    return s;
  }
  assert.equal(classify(1.2), 3, 'hunger at clamp ceiling must classify as stage 3');
  assert.equal(classify(STARVE_THRESH.starving + 0.001), 2);
  assert.equal(classify(STARVE_THRESH.hungry + 0.001), 1);
});

test('B7: healthy villager eating does NOT arm recoveryTimer', () => {
  const { ai } = makeAI();
  const v = makeVillager({ condition: 'normal', starveStage: 0, recoveryTimer: 0 });
  ai.handleVillagerFed(v, 'pack');
  assert.equal(v.recoveryTimer, 0, 'healthy meals must not arm the recovery buff');
  assert.equal(v.condition, 'normal');
});

test('B7: stage-1 hungry villager eating does NOT arm recoveryTimer', () => {
  const { ai } = makeAI();
  const v = makeVillager({ condition: 'hungry', starveStage: 1, recoveryTimer: 0 });
  ai.handleVillagerFed(v, 'camp');
  assert.equal(v.recoveryTimer, 0, 'sub-critical meals must not arm the recovery buff');
  assert.equal(v.condition, 'normal');
});

test('B7: stage-2 starving villager eating arms full STARVE_RECOVERY_TICKS', () => {
  const { ai } = makeAI();
  const v = makeVillager({ condition: 'starving', starveStage: 2, recoveryTimer: 0 });
  ai.handleVillagerFed(v, 'camp');
  assert.equal(v.recoveryTimer, STARVE_RECOVERY_TICKS);
  assert.equal(v.condition, 'recovering');
});

test('B7: sick villager eating clears sickTimer and arms full recovery', () => {
  const { ai } = makeAI();
  const v = makeVillager({
    condition: 'sick',
    starveStage: 3,
    sickTimer: 100,
    recoveryTimer: 0,
    state: 'sick',
  });
  ai.handleVillagerFed(v, 'camp');
  assert.equal(v.recoveryTimer, STARVE_RECOVERY_TICKS);
  assert.equal(v.sickTimer, 0);
  assert.equal(v.condition, 'recovering');
  assert.equal(v.state, 'idle');
});

test('B7: a second meal during recovery does not shorten the in-flight timer', () => {
  const { ai } = makeAI();
  const v = makeVillager({ condition: 'recovering', starveStage: 0, recoveryTimer: 200 });
  ai.handleVillagerFed(v, 'pack');
  assert.equal(v.recoveryTimer, 200, 'in-flight recovery must not be shortened');
});

test('B15: sick villager standing by storage can consumeFood and recover', () => {
  const { ai, storageTotals } = makeAI({ storageFood: 5 });
  const v = makeVillager({
    condition: 'sick',
    starveStage: 3,
    sickTimer: 100,
    hunger: 1.19,
    state: 'sick',
  });
  const ate = ai.consumeFood(v);
  assert.equal(ate, true, 'consumeFood must succeed when storage has food');
  assert.equal(v.condition, 'recovering');
  assert.equal(v.sickTimer, 0);
  assert.equal(v.state, 'idle');
  // Hunger should drop by FOOD_HUNGER_RECOVERY (clamped at 0).
  assert.ok(
    Math.abs(v.hunger - (1.19 - FOOD_HUNGER_RECOVERY)) < 1e-9,
    `hunger should drop by FOOD_HUNGER_RECOVERY; got ${v.hunger}`
  );
  assert.equal(storageTotals.food, 4, 'storage food must decrement by 1');
});

test('B15: sick villager with food in pack can consumeFood from inventory', () => {
  const { ai } = makeAI({ storageFood: 0 });
  const v = makeVillager({
    condition: 'sick',
    starveStage: 3,
    sickTimer: 100,
    hunger: 1.19,
    state: 'sick',
    inv: { type: ITEM.FOOD, qty: 1 },
  });
  const ate = ai.consumeFood(v);
  assert.equal(ate, true);
  assert.equal(v.inv, null, 'pack food must be consumed');
  assert.equal(v.condition, 'recovering');
});
