import test from 'node:test';
import { strict as assert } from 'node:assert';

// Mirrors the load-time stubs from movement.speed.test.js: onArrive.js →
// simulation.js → environment.js asserts on AIV_TERRAIN / AIV_CONFIG, and
// world.js → canvas.js touches `document` / `window`. None of these are
// exercised by stepAlong.
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

const { createOnArrive } = await import('../src/app/onArrive.js');
const { TILE } = await import('../src/app/constants.js');

const TICKS_PER_SEC = 6;
const SECONDS_PER_TICK = 1 / TICKS_PER_SEC;
const SPEED_PX_PER_SEC = 0.08 * 32 * TICKS_PER_SEC;

function makeState() {
  return {
    units: { buildings: [], itemsOnGround: [] },
    stocks: { totals: {}, reserved: {} },
    time: { tick: 0, speedIdx: 0 },
    world: {},
  };
}

function makeSystem(state) {
  const noop = () => {};
  return createOnArrive({
    state,
    pathfind: () => null,
    idx: () => 0,
    finishJob: noop,
    suppressJob: noop,
    releaseReservedMaterials: noop,
    spendCraftMaterials: noop,
    cancelHaulJobsForBuilding: noop,
    findAnimalById: () => null,
    removeAnimal: noop,
    resolveHuntYield: () => ({}),
    chooseFleeTarget: () => null,
    queueAnimalLabel: noop,
    findHuntApproachPath: () => null,
    consumeFood: noop,
    handleVillagerFed: noop,
    findNearestBuilding: () => null,
    agricultureHarvestAt: () => 0,
    findEntryTileNear: () => null,
    getBuildingById: () => null,
    setActiveBuilding: noop,
    noteBuildingActivity: noop,
    buildingAt: () => null,
    dropItem: noop,
    removeItemAtIndex: noop,
    itemTileIndex: () => -1,
    markStaticDirty: noop,
    markEmittersDirty: noop,
    onZoneTileSown: noop,
    getSecondsPerTick: () => SECONDS_PER_TICK,
    getSpeedPxPerSec: () => SPEED_PX_PER_SEC,
  });
}

function makeVillager(overrides = {}) {
  return {
    x: 0,
    y: 0,
    path: [{ x: 1000, y: 0 }],
    condition: 'normal',
    happy: 0.5,
    speed: 1,
    energy: 1,
    ...overrides,
  };
}

function expectedStep({ penalty, moodSpeed, energyPenalty }) {
  return (SPEED_PX_PER_SEC * 1 * penalty * moodSpeed * energyPenalty * SECONDS_PER_TICK) / TILE;
}

test('S4: well-rested villager (energy ≥ 0.5) walks at the no-penalty speed', () => {
  const { stepAlong } = makeSystem(makeState());
  for (const energy of [1.0, 0.75, 0.5]) {
    const v = makeVillager({ energy });
    stepAlong(v);
    const step = expectedStep({ penalty: 1, moodSpeed: 1.0, energyPenalty: 1 });
    assert.equal(v.x, step, `energy=${energy} should walk full speed`);
  }
});

test('S4: a moderately tired villager (0.30 ≤ energy < 0.50) walks 5% slower', () => {
  const { stepAlong } = makeSystem(makeState());
  const v = makeVillager({ energy: 0.4 });
  stepAlong(v);
  const step = expectedStep({ penalty: 1, moodSpeed: 1.0, energyPenalty: 0.95 });
  assert.equal(v.x, step);
});

test('S4: an exhausted villager (energy < 0.30) walks 15% slower', () => {
  const { stepAlong } = makeSystem(makeState());
  const v = makeVillager({ energy: 0.1 });
  stepAlong(v);
  const step = expectedStep({ penalty: 1, moodSpeed: 1.0, energyPenalty: 0.85 });
  assert.equal(v.x, step);
});

test('S4: energy penalty is multiplicative with the condition penalty', () => {
  // A starving + exhausted villager should be slower than a starving + rested
  // one, but neither should be slower than a sick villager (which keeps its
  // 0.45× condition penalty as the hardest brake).
  const { stepAlong } = makeSystem(makeState());

  const starvingRested = makeVillager({ condition: 'starving', energy: 1 });
  const starvingTired = makeVillager({ condition: 'starving', energy: 0.1 });
  stepAlong(starvingRested);
  stepAlong(starvingTired);

  assert.ok(starvingTired.x < starvingRested.x,
    'low-energy starving villager moves slower than rested starving one');

  const expectedRested = expectedStep({ penalty: 0.7, moodSpeed: 1.0, energyPenalty: 1 });
  const expectedTired = expectedStep({ penalty: 0.7, moodSpeed: 1.0, energyPenalty: 0.85 });
  assert.equal(starvingRested.x, expectedRested);
  assert.equal(starvingTired.x, expectedTired);
});

test('S4: existing villagers without an energy field still walk at full speed (back-compat)', () => {
  // The B11 movement.speed test villager has no `energy` field; the
  // Number.isFinite guard treats that as 1.0 so the existing test still
  // passes after Phase 10.
  const { stepAlong } = makeSystem(makeState());
  const v = {
    x: 0, y: 0, path: [{ x: 1000, y: 0 }],
    condition: 'normal', happy: 0.5, speed: 1,
  };
  stepAlong(v);
  const step = expectedStep({ penalty: 1, moodSpeed: 1.0, energyPenalty: 1 });
  assert.equal(v.x, step);
});
