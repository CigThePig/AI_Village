import test from 'node:test';
import { strict as assert } from 'node:assert';

// onArrive.js → simulation.js → environment.js asserts on AIV_TERRAIN /
// AIV_CONFIG at module-load time, and world.js → canvas.js touches `document`
// / `window`. None of these are exercised by the stepAlong calculation under
// test — the stubs only need to satisfy load-time guards. (Mirrors the
// approach in hunting.phase6.test.js.)
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
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener: () => {},
    };
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

// Mirrors src/app.js:942-944. tick.js folds SPEEDS[speedIdx] into dt — per-tick
// step size in stepAlong must therefore be independent of speedIdx.
const TICKS_PER_SEC = 6;
const SECONDS_PER_TICK = 1 / TICKS_PER_SEC;
const SPEED_PX_PER_SEC = 0.08 * 32 * TICKS_PER_SEC;

function makeState(speedIdx) {
  return {
    units: { buildings: [], itemsOnGround: [] },
    stocks: { totals: {}, reserved: {} },
    time: { tick: 0, speedIdx },
    world: {}
  };
}

function makeSystem(state) {
  // stepAlong only consumes getSecondsPerTick / getSpeedPxPerSec from opts;
  // the remaining deps are only invoked from onArrive (the path-completion
  // handler), so no-op stubs are fine as long as the test villager doesn't
  // reach the end of its path in a single step.
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
    agricultureBonusesAt: () => ({}),
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
    getSpeedPxPerSec: () => SPEED_PX_PER_SEC
  });
}

function makeVillager() {
  return {
    x: 0,
    y: 0,
    path: [{ x: 1000, y: 0 }],
    condition: 'normal',
    happy: 0.5,
    speed: 1
  };
}

test('per-tick step size is identical at all speedIdx values (B11)', () => {
  const distances = [0, 1, 2, 3].map((speedIdx) => {
    const state = makeState(speedIdx);
    const { stepAlong } = makeSystem(state);
    const v = makeVillager();
    stepAlong(v);
    return v.x;
  });

  // Bit-identical: stepAlong no longer reads speedIdx, so the four runs
  // execute the exact same arithmetic.
  for (let i = 1; i < distances.length; i++) {
    assert.equal(
      distances[i],
      distances[0],
      `step at speedIdx=${i} must equal step at speedIdx=0`
    );
  }
});

test('per-tick step matches the speed-free formula', () => {
  const state = makeState(0);
  const { stepAlong } = makeSystem(state);
  const v = makeVillager();
  stepAlong(v);

  const moodSpeed = 0.75 + v.happy * 0.5; // happy=0.5 -> 1.0
  const expectedStep =
    (SPEED_PX_PER_SEC * v.speed * /* penalty=normal */ 1 * moodSpeed * SECONDS_PER_TICK) / TILE;

  assert.equal(v.x, expectedStep);
});
