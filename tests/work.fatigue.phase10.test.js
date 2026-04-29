import test from 'node:test';
import { strict as assert } from 'node:assert';

// Same browser-stub preamble as build.laborResume.phase7.test.js.
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

const { workEffortMultiplier } = await import('../src/app/villagerAI.js');
const { createVillagerTick } = await import('../src/app/villagerTick.js');
const { createOnArrive } = await import('../src/app/onArrive.js');
const { BUILDINGS, ensureBuildingData } = await import('../src/app/world.js');
const { TILES, ITEM, ZONES } = await import('../src/app/constants.js');

// --- workEffortMultiplier unit tests --------------------------------------

test('S5: workEffortMultiplier returns 1.0 for a healthy, rested villager', () => {
  assert.equal(workEffortMultiplier({ condition: 'normal', energy: 1 }), 1);
  assert.equal(workEffortMultiplier({ condition: 'normal', energy: 0.5 }), 1);
  // Exactly 0.30 is *not* below the threshold (the cutoff is `< 0.30`).
  assert.equal(workEffortMultiplier({ condition: 'normal', energy: 0.3 }), 1);
});

test('S5: workEffortMultiplier penalises hungry/starving/sick conditions', () => {
  assert.equal(workEffortMultiplier({ condition: 'hungry', energy: 1 }), 0.9);
  assert.equal(workEffortMultiplier({ condition: 'starving', energy: 1 }), 0.7);
  assert.equal(workEffortMultiplier({ condition: 'sick', energy: 1 }), 0.5);
});

test('S5: low energy compounds with condition multiplicatively', () => {
  // starving (0.7) × low-energy (0.85) = 0.595
  const m = workEffortMultiplier({ condition: 'starving', energy: 0.1 });
  assert.ok(Math.abs(m - 0.595) < 1e-12, `expected 0.595, got ${m}`);
});

test('S5: workEffortMultiplier handles missing fields safely', () => {
  // No condition / no energy → treated as healthy + full energy.
  assert.equal(workEffortMultiplier({}), 1);
  assert.equal(workEffortMultiplier({ condition: undefined, energy: undefined }), 1);
});

// --- Building labor ----------------------------------------------------------

function makeState({ buildings = [], jobs = [], villagers = [], totals = {} } = {}) {
  return {
    units: { buildings, jobs, villagers, itemsOnGround: [] },
    stocks: { totals: { food: 0, wood: 0, stone: 0, ...totals }, reserved: {} },
    time: { tick: 0, dayTime: 0, speedIdx: 0 },
    bb: null,
    world: {
      tiles: new Uint8Array(0),
      trees: new Uint8Array(0),
      rocks: new Uint8Array(0),
      growth: new Uint16Array(0),
      berries: new Uint8Array(0),
    },
  };
}

function makeFinishJob(jobs) {
  return (v, remove = false) => {
    const job = v.targetJob;
    if (job) {
      job.assigned = Math.max(0, (job.assigned || 0) - 1);
      if (remove) {
        const ji = jobs.indexOf(job);
        if (ji !== -1) jobs.splice(ji, 1);
      }
    }
    v.targetJob = null;
  };
}

function makeVillagerTickSystem(state) {
  const noop = () => {};
  const finishJob = makeFinishJob(state.units.jobs);
  return createVillagerTick({
    state,
    policy: { style: { jobScoring: { restEnergyThreshold: 0.0 } }, routine: {} },
    pathfind: () => null,
    ambientAt: () => 'day',
    nearbyWarmth: () => false,
    agricultureBonusesAt: () => ({ growthBonus: 0, harvestBonus: 0, moodBonus: 0 }),
    getBuildingById: (id) => state.units.buildings.find((b) => b.id === id) || null,
    noteBuildingActivity: (b) => {
      if (b) {
        ensureBuildingData(b);
        b.activity.lastUse = state.time.tick;
      }
    },
    endBuildingStay: (v) => {
      if (v.activeBuildingId) {
        const prev = state.units.buildings.find((b) => b.id === v.activeBuildingId);
        if (prev) {
          ensureBuildingData(prev);
          prev.activity.occupants = Math.max(0, (prev.activity.occupants || 0) - 1);
        }
        v.activeBuildingId = null;
      }
      v.targetBuilding = null;
    },
    cancelHaulJobsForBuilding: noop,
    finishJob,
    markStaticDirty: noop,
    markEmittersDirty: noop,
    issueStarveToast: noop,
    enterSickState: noop,
    suppressJob: noop,
    noteJobAssignmentChanged: noop,
    getJobCreationConfig: () => ({}),
    findEntryTileNear: () => null,
    findNearestBuilding: () => null,
    buildingCenter: (b) => ({ x: b.x, y: b.y }),
    findHuntApproachPath: () => null,
    findAnimalById: () => null,
    buildingAt: () => null,
    chooseIdleBeforeJobs: () => false,
    chooseIdleAfterJobs: () => false,
    foragingJob: () => false,
    seekEmergencyFood: () => false,
    consumeFood: () => false,
    findPanicHarvestJob: () => null,
    pickJobFor: () => null,
    maybeInterruptJob: () => false,
    tryStartPregnancy: noop,
    completePregnancy: noop,
    promoteChildToAdult: noop,
    stepAlong: noop,
  });
}

function makeHutBuilding(overrides = {}) {
  const b = {
    id: 1,
    kind: 'hut',
    x: 0,
    y: 0,
    built: 0,
    store: { wood: 0, stone: 0, food: 0 },
    spent: { wood: 10, stone: 0 },
    pending: { wood: 0, stone: 0 },
    progress: 10,
    laborProgress: 0,
    ...overrides,
  };
  ensureBuildingData(b);
  return b;
}

function makeBuilder(job, overrides = {}) {
  return {
    id: 'v1',
    x: 0,
    y: 0,
    path: [],
    state: 'building',
    targetJob: job,
    role: 'worker',
    speed: 1,
    inv: null,
    hunger: 0.1,
    energy: 0.8,
    happy: 0.6,
    hydration: 0.7,
    condition: 'normal',
    starveStage: 0,
    activeBuildingId: 1,
    thought: '',
    ageTicks: 100,
    lifeStage: 'adult',
    ...overrides,
  };
}

test('S5: a healthy builder accumulates 1.0 labor per tick (regression guard)', () => {
  const b = makeHutBuilding();
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 0 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { villagerTick } = makeVillagerTickSystem(state);
  const v = makeBuilder(job);
  state.units.villagers.push(v);

  for (let i = 0; i < 10; i++) {
    villagerTick(v);
    state.time.tick++;
  }
  // Float compare with tolerance (since we no longer truncate to int).
  assert.ok(Math.abs(b.laborProgress - 10) < 1e-9,
    `healthy builder accumulates 1.0 per tick, got ${b.laborProgress}`);
});

test('S5: a starving builder accumulates only 0.7 labor per tick', () => {
  const b = makeHutBuilding();
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 0 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { villagerTick } = makeVillagerTickSystem(state);
  // condition='starving' but starveStage=1 so we don't trip urgentFood (which
  // would yank the villager out of building state before we can measure).
  const v = makeBuilder(job, {
    condition: 'starving',
    starveStage: 1,
    hunger: 1.0,
    energy: 0.8,
  });
  state.units.villagers.push(v);

  for (let i = 0; i < 10; i++) {
    villagerTick(v);
    state.time.tick++;
  }
  assert.ok(Math.abs(b.laborProgress - 7) < 1e-9,
    `starving builder accumulates ~0.7/tick (10 ticks → 7), got ${b.laborProgress}`);
});

test('S5: a starving + exhausted builder accumulates ~0.595 labor per tick', () => {
  const b = makeHutBuilding();
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 0 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { villagerTick } = makeVillagerTickSystem(state);
  const v = makeBuilder(job, {
    condition: 'starving',
    starveStage: 1,
    hunger: 1.0,
    energy: 0.1, // below 0.30 → 0.85 energy penalty
  });
  state.units.villagers.push(v);

  for (let i = 0; i < 10; i++) {
    villagerTick(v);
    state.time.tick++;
  }
  // 10 × 0.7 × 0.85 = 5.95. Allow a small tolerance for energy clamp drift
  // (villagerTick mutates v.energy each tick).
  assert.ok(b.laborProgress < 7,
    `starving + exhausted builder must be slower than a healthy starving one (>7), got ${b.laborProgress}`);
  assert.ok(b.laborProgress > 4.5,
    `starving + exhausted builder still makes meaningful progress (~5.95), got ${b.laborProgress}`);
});

test('S5: a sick builder takes ~2× as many ticks to finish a hut as a healthy one', () => {
  // Sick = 0.5 multiplier, so 60 labor takes 120 ticks instead of 60.
  function ticksToFinish(condition) {
    const b = makeHutBuilding();
    const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 0 };
    const state = makeState({ buildings: [b], jobs: [job] });
    const { villagerTick } = makeVillagerTickSystem(state);
    const v = makeBuilder(job, condition === 'sick'
      ? { condition: 'sick', sickTimer: 5000, energy: 0.8, hunger: 1.05, starveStage: 1 }
      : { condition: 'normal' });
    state.units.villagers.push(v);
    let ticks = 0;
    while (b.built < 1 && ticks < 500) {
      villagerTick(v);
      state.time.tick++;
      ticks++;
    }
    return ticks;
  }

  const healthy = ticksToFinish('normal');
  const sick = ticksToFinish('sick');
  assert.equal(healthy, BUILDINGS.hut.buildLaborTicks,
    `healthy builder finishes in exactly buildLaborTicks (${BUILDINGS.hut.buildLaborTicks}), got ${healthy}`);
  assert.ok(sick >= healthy * 1.8,
    `sick builder takes at least ~1.8× as long as healthy, got sick=${sick} vs healthy=${healthy}`);
});

// --- Harvest yield -----------------------------------------------------------

function makeWorldWithCrop() {
  // 1×1 world with a single farmland tile that has fully-grown crops.
  return {
    tiles: new Uint8Array([TILES.FARMLAND]),
    trees: new Uint8Array([0]),
    rocks: new Uint8Array([0]),
    growth: new Uint16Array([200]),
    berries: new Uint8Array([0]),
    zone: new Uint8Array([ZONES.FARM]),
  };
}

function makeOnArriveForHarvest(state, dropped) {
  const noop = () => {};
  const finishJob = makeFinishJob(state.units.jobs);
  return createOnArrive({
    state,
    pathfind: () => null,
    idx: () => 0,
    finishJob,
    suppressJob: noop,
    releaseReservedMaterials: noop,
    spendCraftMaterials: () => true,
    cancelHaulJobsForBuilding: noop,
    findAnimalById: () => null,
    removeAnimal: noop,
    resolveHuntYield: () => ({ meat: 0, pelts: 0 }),
    chooseFleeTarget: () => null,
    queueAnimalLabel: noop,
    findHuntApproachPath: () => null,
    consumeFood: () => false,
    handleVillagerFed: noop,
    findNearestBuilding: () => null,
    // No bonus tile so harvest yield is purely the workEffort * 2 base.
    agricultureBonusesAt: () => ({ growthBonus: 0, harvestBonus: 0, moodBonus: 0 }),
    findEntryTileNear: () => null,
    getBuildingById: () => null,
    setActiveBuilding: noop,
    noteBuildingActivity: noop,
    buildingAt: () => null,
    dropItem: (x, y, type, qty) => {
      if (type === ITEM.FOOD) dropped.push(qty);
    },
    removeItemAtIndex: noop,
    itemTileIndex: { get: () => undefined },
    markStaticDirty: noop,
    markEmittersDirty: noop,
    onZoneTileSown: noop,
    getSecondsPerTick: () => 1 / 6,
    getSpeedPxPerSec: () => 0.08 * 32 * 6,
  });
}

function makeHarvester(overrides = {}) {
  return {
    id: 'h1',
    x: 0,
    y: 0,
    path: [],
    state: 'harvest',
    targetJob: null,
    role: 'worker',
    speed: 1,
    inv: null,
    hunger: 0.1,
    energy: 0.8,
    happy: 0.6,
    hydration: 0.7,
    condition: 'normal',
    starveStage: 0,
    targetI: 0,
    thought: '',
    ageTicks: 100,
    lifeStage: 'adult',
    ...overrides,
  };
}

test('S5: a healthy harvester yields the full base of 2 food', () => {
  const state = makeState();
  state.world = makeWorldWithCrop();
  const dropped = [];
  const { onArrive } = makeOnArriveForHarvest(state, dropped);
  const v = makeHarvester();
  onArrive(v);
  assert.deepEqual(dropped, [2], 'healthy harvester yields 2 food (base * 1.0)');
});

test('S5: a sick harvester yields the floored minimum of 1 food', () => {
  const state = makeState();
  state.world = makeWorldWithCrop();
  const dropped = [];
  const { onArrive } = makeOnArriveForHarvest(state, dropped);
  const v = makeHarvester({ condition: 'sick' });
  onArrive(v);
  // round(2 × 0.5) = 1; the Math.max(1, …) floor would also catch this case.
  assert.deepEqual(dropped, [1], 'sick harvester yields 1 food (floored)');
});

test('S5: a starving harvester yields 1 food (round(2*0.7) = 1)', () => {
  const state = makeState();
  state.world = makeWorldWithCrop();
  const dropped = [];
  const { onArrive } = makeOnArriveForHarvest(state, dropped);
  const v = makeHarvester({ condition: 'starving' });
  onArrive(v);
  assert.deepEqual(dropped, [1], 'starving harvester yields 1 food');
});

test('S5: a hungry harvester still yields the full 2 food (round(2*0.9)=2)', () => {
  const state = makeState();
  state.world = makeWorldWithCrop();
  const dropped = [];
  const { onArrive } = makeOnArriveForHarvest(state, dropped);
  const v = makeHarvester({ condition: 'hungry' });
  onArrive(v);
  assert.deepEqual(dropped, [2], 'hungry harvester rounds back up to 2');
});
