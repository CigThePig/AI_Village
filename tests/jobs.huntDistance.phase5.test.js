import test from 'node:test';
import { strict as assert } from 'node:assert';

// villagerAI → simulation → environment asserts on AIV_TERRAIN / AIV_CONFIG at
// module-load time; world.js → canvas.js touches `document` / `window`.
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

const { createVillagerAI } = await import('../src/app/villagerAI.js');

function makeAI({ animal, jobs = [] }) {
  const state = {
    units: { buildings: [], jobs, villagers: [], itemsOnGround: [] },
    stocks: { totals: { food: 0, wood: 0, stone: 0 }, reserved: {} },
    time: { tick: 100, dayTime: 1000 },
    world: {},
    bb: null,
  };
  const noop = () => {};
  // Empty-default scoring except a non-zero distanceFalloff so the distance
  // term actually matters in the score. Without it, B9 would be unobservable.
  const policy = { style: { jobScoring: { distanceFalloff: 0.01 } }, sliders: {} };
  const ai = createVillagerAI({
    state,
    policy,
    pathfind: () => null,
    passable: () => true,
    Toast: { show: noop },
    addJob: noop,
    finishJob: (v) => { v.targetJob = null; },
    noteJobAssignmentChanged: noop,
    availableToReserve: () => 0,
    reserveMaterials: () => true,
    releaseReservedMaterials: noop,
    findAnimalById: (id) => (animal && animal.id === id ? animal : null),
    findEntryTileNear: () => ({ x: 0, y: 0 }),
    getBuildingById: () => null,
    buildingsByKind: new Map(),
    idx: () => 0,
    ambientAt: () => 'day',
    isNightTime: () => false,
  });
  return { ai, state };
}

function makeVillager(overrides = {}) {
  return {
    x: 0, y: 0,
    hunger: 0,
    energy: 1,
    happy: 0.5, // mood = 0; isolates distance as the only score signal
    condition: 'normal',
    starveStage: 0,
    state: 'idle',
    path: null,
    targetJob: null,
    equippedBow: true, // pickJobFor filters out hunt jobs without a bow
    ...overrides,
  };
}

test('B9: scoreExistingJobForVillager uses live animal position, not stale j.x/j.y', () => {
  const animal = { id: 42, x: 10, y: 10 };
  const huntJob = { id: 1, type: 'hunt', x: 0, y: 0, prio: 0.5, targetAid: 42, assigned: 0 };
  const { ai } = makeAI({ animal, jobs: [huntJob] });
  const v = makeVillager();

  const scoreClose = ai.scoreExistingJobForVillager(huntJob, v, null);
  // Manhattan distance from (0,0) to live (10,10) = 20.
  // score = prio - distance*falloff = 0.5 - 20*0.01 = 0.3.
  assert.ok(Math.abs(scoreClose - 0.3) < 1e-9,
    `expected ~0.3 from live distance, got ${scoreClose}`);

  animal.x = 20; animal.y = 20;
  const scoreFar = ai.scoreExistingJobForVillager(huntJob, v, null);
  // Manhattan = 40 → score = 0.5 - 0.4 = 0.1.
  assert.ok(Math.abs(scoreFar - 0.1) < 1e-9,
    `expected ~0.1 after animal moved away, got ${scoreFar}`);

  assert.ok(scoreFar < scoreClose,
    'further animal must score strictly lower; otherwise the function is reading stale j.x/j.y');
});

test('B9: scoreExistingJobForVillager matches pickJobFor for the same hunt', () => {
  // pickJobFor's hunt branch (lines 629-633 villagerAI.js) already uses live
  // animal position. After the B9 fix, scoreExistingJobForVillager must agree
  // — otherwise maybeInterruptJob compares apples to oranges.
  const animal = { id: 7, x: 12, y: 8 };
  const huntJob = { id: 2, type: 'hunt', x: 0, y: 0, prio: 0.5, targetAid: 7, assigned: 0 };
  const { ai } = makeAI({ animal, jobs: [huntJob] });
  const v = makeVillager();

  const picked = ai.pickJobFor(v);
  assert.equal(picked, huntJob, 'pickJobFor should select the only hunt job');

  // Both functions must compute the same score for the same villager+job pair.
  // We rebuild pickJobFor's expected score: distance = |0-12|+|0-8| = 20,
  // score = 0.5 - 20*0.01 = 0.3.
  const scoreFromExisting = ai.scoreExistingJobForVillager(huntJob, v, null);
  assert.ok(Math.abs(scoreFromExisting - 0.3) < 1e-9,
    `scoreExistingJobForVillager must use live animal position; got ${scoreFromExisting}`);
});

test('B9: missing animal falls back to job spawn coordinates', () => {
  // findAnimalById returns null → use j.x/j.y as the fallback (matches
  // pickJobFor's `?? j.x` pattern). Important for the case where the animal
  // was killed but the job tombstone is still being scored.
  const huntJob = { id: 3, type: 'hunt', x: 5, y: 5, prio: 0.5, targetAid: 999, assigned: 0 };
  const { ai } = makeAI({ animal: null, jobs: [huntJob] });
  const v = makeVillager({ x: 0, y: 0 });

  const score = ai.scoreExistingJobForVillager(huntJob, v, null);
  // distance = 10, score = 0.5 - 0.1 = 0.4.
  assert.ok(Math.abs(score - 0.4) < 1e-9,
    `expected fallback to j.x/j.y when animal not found; got ${score}`);
});
