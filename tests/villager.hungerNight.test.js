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
  FOOD_HUNGER_RECOVERY,
} = await import('../src/app/villagerAI.js');
const { ITEM } = await import('../src/app/constants.js');

// Mirror of the rate calc at src/app/villagerTick.js:158-163. Tick-only
// constants don't leave that module (project convention), so we replicate
// the formula here to assert behavior without spinning up the 30-dep tick
// state machine. Numeric constants must stay in sync with villagerTick.js.
const HUNGER_RATE = 0.00095;
const REST_HUNGER_MULT = 0.42;
const NIGHT_HUNGER_MULT = 0.65;

function computeHungerRate({ resting = false, nightNow = false } = {}) {
  const restMult = resting ? REST_HUNGER_MULT : 1;
  const nightMult = nightNow ? NIGHT_HUNGER_MULT : 1;
  // hydration / season factors hold at 1 for these tests so we isolate the
  // night and rest dimensions.
  return HUNGER_RATE * restMult * nightMult;
}

// Mirror of the peckish gate at src/app/villagerTick.js:423-426. Pack-only
// by design: storage runs are reserved for needsFood (stage>=1).
function shouldSnackFromPack(v, stage) {
  return stage === 0
    && v.hunger > STARVE_THRESH.peckish
    && !!v.inv
    && v.inv.type === ITEM.FOOD;
}

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

test('night reduces hunger rate when awake', () => {
  const day = computeHungerRate({ resting: false, nightNow: false });
  const night = computeHungerRate({ resting: false, nightNow: true });
  assert.ok(night < day, `night rate ${night} must be < day rate ${day}`);
  assert.ok(night > 0, 'night rate must remain positive — villagers still get hungry');
  assert.ok(
    Math.abs(night - HUNGER_RATE * NIGHT_HUNGER_MULT) < 1e-12,
    'night-awake rate must equal HUNGER_RATE * NIGHT_HUNGER_MULT'
  );
});

test('night and rest stack to a deeper slowdown than rest alone', () => {
  const restDay = computeHungerRate({ resting: true, nightNow: false });
  const restNight = computeHungerRate({ resting: true, nightNow: true });
  assert.ok(restNight < restDay, `rest+night ${restNight} must be < rest-only ${restDay}`);
  assert.ok(restNight > 0, 'deep-sleep rate must remain positive');
  assert.ok(
    Math.abs(restNight - HUNGER_RATE * REST_HUNGER_MULT * NIGHT_HUNGER_MULT) < 1e-12,
    'rest+night rate must equal product of all three factors'
  );
});

test('peckish threshold sits between healthy and stage-1 hungry', () => {
  assert.ok(
    STARVE_THRESH.peckish < STARVE_THRESH.hungry,
    `peckish ${STARVE_THRESH.peckish} must be strictly below hungry ${STARVE_THRESH.hungry}`
  );
  assert.ok(STARVE_THRESH.peckish > 0, 'peckish must be a real positive trigger');
  // Margin big enough that a typical foraging round-trip can't blow through
  // the proactive-snack window in one tick.
  assert.ok(
    STARVE_THRESH.hungry - STARVE_THRESH.peckish >= 0.15,
    'peckish must leave room before stage 1'
  );
});

test('snack predicate fires for stage-0 villager carrying food past peckish', () => {
  const v = makeVillager({ hunger: 0.65, inv: { type: ITEM.FOOD, qty: 1 } });
  assert.equal(shouldSnackFromPack(v, 0), true);
});

test('snack predicate does NOT fire when pack is empty (storage thrash guard)', () => {
  const v = makeVillager({ hunger: 0.65, inv: null });
  assert.equal(
    shouldSnackFromPack(v, 0),
    false,
    'empty pack at peckish must not snack — storage runs are reserved for stage>=1'
  );
});

test('snack predicate does NOT fire below the peckish threshold', () => {
  const v = makeVillager({ hunger: STARVE_THRESH.peckish - 0.001, inv: { type: ITEM.FOOD } });
  assert.equal(shouldSnackFromPack(v, 0), false);
});

test('snack predicate does NOT fire once already at stage 1', () => {
  // Once stage>=1 the existing needsFood branch handles eating (incl.
  // storage). The peckish gate exists only to act *before* stage 1.
  const v = makeVillager({ hunger: 0.85, inv: { type: ITEM.FOOD } });
  assert.equal(shouldSnackFromPack(v, 1), false);
});

test('stage-0 peckish snack from pack: eats from inv, leaves storage alone, no recovery armed', () => {
  // This locks down the B7 invariant for the new branch: a healthy
  // peckish snack must NOT arm recoveryTimer (which would be wrong — the
  // villager isn't recovering from anything).
  const { ai, storageTotals } = makeAI({ storageFood: 5 });
  const v = makeVillager({
    hunger: 0.65,
    starveStage: 0,
    condition: 'normal',
    inv: { type: ITEM.FOOD, qty: 1 },
  });
  const ate = ai.consumeFood(v);
  assert.equal(ate, true, 'consumeFood must succeed when pack has food');
  assert.equal(v.inv, null, 'pack food must be consumed');
  assert.equal(storageTotals.food, 5, 'storage must be untouched (pack-priority)');
  assert.equal(v.condition, 'normal', 'stage-0 meal must not change condition');
  assert.equal(v.recoveryTimer, 0, 'stage-0 meal must NOT arm the recovery timer');
  assert.ok(
    Math.abs(v.hunger - Math.max(0, 0.65 - FOOD_HUNGER_RECOVERY)) < 1e-9,
    `hunger should drop by FOOD_HUNGER_RECOVERY (clamped at 0); got ${v.hunger}`
  );
});
