import test from 'node:test';
import { strict as assert } from 'node:assert';

// onArrive.js → simulation.js → environment.js asserts on AIV_TERRAIN /
// AIV_CONFIG at module-load time, and world.js → canvas.js touches `document`
// / `window`. None of these are exercised by this test — the stubs only need
// to satisfy load-time guards.
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
const { createVillagerTick } = await import('../src/app/villagerTick.js');
const { BUILDINGS, ensureBuildingData } = await import('../src/app/world.js');

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

// Mirrors src/app/jobs.js finishJob: decrements assigned, optionally removes
// from the jobs queue, clears v.targetJob.
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

function makeOnArrive(state) {
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
    agricultureHarvestAt: () => 0,
    findEntryTileNear: () => null,
    getBuildingById: (id) => state.units.buildings.find((b) => b.id === id) || null,
    setActiveBuilding: (v, b) => {
      if (b) {
        ensureBuildingData(b);
        b.activity.occupants = (b.activity.occupants || 0) + 1;
        v.activeBuildingId = b.id;
      }
    },
    noteBuildingActivity: (b) => {
      if (b) {
        ensureBuildingData(b);
        b.activity.lastUse = state.time.tick;
      }
    },
    buildingAt: () => null,
    dropItem: noop,
    removeItemAtIndex: noop,
    itemTileIndex: { get: () => undefined },
    markStaticDirty: noop,
    markEmittersDirty: noop,
    onZoneTileSown: noop,
    getSecondsPerTick: () => 1 / 6,
    getSpeedPxPerSec: () => 0.08 * 32 * 6,
  });
}

function makeVillagerTick(state) {
  const noop = () => {};
  const finishJob = makeFinishJob(state.units.jobs);
  return createVillagerTick({
    state,
    policy: { style: { jobScoring: { restEnergyThreshold: 0.0 } }, routine: {} },
    pathfind: () => null,
    ambientAt: () => 'day',
    nearbyWarmth: () => false,
    agricultureMoodAt: () => 0,
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
    store: { wood: 10, stone: 0, food: 0 },
    spent: { wood: 0, stone: 0 },
    pending: { wood: 0, stone: 0 },
    progress: 0,
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
    state: 'build',
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
    activeBuildingId: null,
    thought: '',
    ageTicks: 100,
    lifeStage: 'adult',
    ...overrides,
  };
}

test('B3/S6: arriving at a fully supplied hut transitions to building state', () => {
  const b = makeHutBuilding();
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 1 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { onArrive } = makeOnArrive(state);
  const v = makeBuilder(job);
  state.units.villagers.push(v);

  onArrive(v);

  assert.equal(v.state, 'building', 'villager transitions into the new building state');
  assert.equal(b.spent.wood, 10, 'materials are consumed on arrival (supply-first preserved)');
  assert.equal(b.store.wood, 0, 'store drained into spent');
  assert.equal(b.built, 0, 'building is not yet complete — labor must accumulate');
  assert.equal(b.laborProgress, 0, 'labor starts at zero');
  assert.equal(job.assigned, 0, 'assigned is decremented so a second builder can join');
  assert.equal(v.activeBuildingId, b.id, 'villager occupies the building');
  assert.equal(state.units.jobs.length, 1, 'build job remains in queue until labor completes');
});

test('B3/S6: zero-labor kinds (campfire) preserve the legacy one-tick finish', () => {
  const b = {
    id: 2,
    kind: 'campfire',
    x: 0,
    y: 0,
    built: 0,
    store: { wood: 0, stone: 0, food: 0 },
    spent: { wood: 0, stone: 0 },
    pending: { wood: 0, stone: 0 },
    progress: 0,
  };
  ensureBuildingData(b);
  const job = { id: 1, type: 'build', bid: 2, x: 0, y: 0, prio: 1, assigned: 1 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { onArrive } = makeOnArrive(state);
  const v = makeBuilder(job);
  state.units.villagers.push(v);

  onArrive(v);

  assert.equal(b.built, 1, 'campfire still completes immediately (cost=0, labor=0)');
  assert.equal(v.state, 'idle');
  assert.equal(state.units.jobs.length, 0, 'campfire build job removed on arrival');
});

test('B3/S6: arriving when materials are already consumed resumes labor without re-spending', () => {
  // A previous builder consumed materials and bailed out before completing.
  // The next builder arrives and must not double-spend, just resume the labor.
  const b = makeHutBuilding({
    store: { wood: 0, stone: 0, food: 0 },
    spent: { wood: 10, stone: 0 },
    progress: 10,
    laborProgress: 30,
  });
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 1 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { onArrive } = makeOnArrive(state);
  const v = makeBuilder(job);
  state.units.villagers.push(v);

  onArrive(v);

  assert.equal(v.state, 'building', 'villager picks up where the previous builder left off');
  assert.equal(b.spent.wood, 10, 'materials not double-consumed');
  assert.equal(b.laborProgress, 30, 'labor progress preserved across builder hand-off');
  assert.equal(job.assigned, 0);
});

test('B3/S6: villagerTick increments laborProgress per tick while in building state', () => {
  const b = makeHutBuilding({
    store: { wood: 0, stone: 0, food: 0 },
    spent: { wood: 10, stone: 0 },
    progress: 10,
  });
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 0 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { villagerTick } = makeVillagerTick(state);
  const v = makeBuilder(job, { state: 'building', activeBuildingId: b.id });
  state.units.villagers.push(v);

  for (let i = 0; i < 30; i++) {
    villagerTick(v);
    state.time.tick++;
  }

  assert.equal(b.laborProgress, 30, 'labor accumulates one tick per villagerTick call');
  assert.equal(b.built, 0, 'building still not complete at half labor');
  assert.equal(v.state, 'building', 'villager remains in building state');
  assert.equal(state.units.jobs.length, 1, 'build job remains in queue while labor is in progress');
});

test('B3/S6: villagerTick completes the building when laborProgress reaches buildLaborTicks', () => {
  const goal = BUILDINGS.hut.buildLaborTicks;
  const b = makeHutBuilding({
    store: { wood: 1, stone: 0, food: 2 }, // leftover that should return to storage
    spent: { wood: 10, stone: 0 },
    progress: 10,
    laborProgress: goal - 1,
  });
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 0 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { villagerTick } = makeVillagerTick(state);
  const v = makeBuilder(job, { state: 'building', activeBuildingId: b.id });
  state.units.villagers.push(v);

  villagerTick(v);

  assert.equal(b.laborProgress, goal, 'final labor tick brings progress to goal');
  assert.equal(b.built, 1, 'building is complete');
  assert.equal(v.state, 'idle');
  assert.equal(state.units.jobs.length, 0, 'completed build job is removed from the queue');
  assert.equal(state.stocks.totals.wood, 1, 'leftover wood returned to storage');
  assert.equal(state.stocks.totals.food, 2, 'leftover food returned to storage');
  assert.equal(b.store.wood, 0, 'store drained on completion');
});

test('B3/S6: urgentFood interrupts labor, the build job survives and keeps progress', () => {
  const b = makeHutBuilding({
    store: { wood: 0, stone: 0, food: 0 },
    spent: { wood: 10, stone: 0 },
    progress: 10,
    laborProgress: 30,
  });
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 0 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { villagerTick } = makeVillagerTick(state);
  // starveStage=2 trips urgentFood inside villagerTick.
  const v = makeBuilder(job, {
    state: 'building',
    activeBuildingId: b.id,
    hunger: 1.1,
    starveStage: 2,
    condition: 'starving',
  });
  state.units.villagers.push(v);

  villagerTick(v);

  assert.equal(v.state, 'idle', 'starving villager bails out of labor');
  assert.equal(v.targetJob, null, 'build job detached from villager');
  assert.equal(state.units.jobs.length, 1, 'build job stays in queue for another builder');
  assert.equal(b.laborProgress, 30, 'labor progress preserved across interruption');
  assert.equal(b.built, 0, 'building stays unfinished after bail-out');
});

test('B3/S6: a hut takes buildLaborTicks ticks of labor end-to-end with one builder', () => {
  const b = makeHutBuilding();
  const job = { id: 1, type: 'build', bid: 1, x: 0, y: 0, prio: 1, assigned: 1 };
  const state = makeState({ buildings: [b], jobs: [job] });
  const { onArrive } = makeOnArrive(state);
  const { villagerTick } = makeVillagerTick(state);
  const v = makeBuilder(job);
  state.units.villagers.push(v);

  onArrive(v);
  assert.equal(v.state, 'building');

  // After arrival the villager needs `buildLaborTicks` more ticks to finish.
  const goal = BUILDINGS.hut.buildLaborTicks;
  for (let i = 0; i < goal; i++) {
    villagerTick(v);
    state.time.tick++;
    if (b.built >= 1) break;
  }
  assert.equal(b.built, 1, 'one builder finishes the hut after exactly buildLaborTicks ticks');
  assert.equal(b.laborProgress, goal);
});
