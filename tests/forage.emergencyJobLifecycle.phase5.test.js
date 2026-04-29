import test from 'node:test';
import { strict as assert } from 'node:assert';

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
const { GRID_W, GRID_H } = await import('../src/app/constants.js');

// Small encoder mirroring the real `idx` closure dep. We don't need full
// GRID_W*GRID_H allocation because the AI only reads world.berries[i] and
// uses our stubbed idx to compute i.
const fakeIdx = (x, y) => y * GRID_W + x;

function makeBerryWorld(berryX, berryY) {
  const tiles = new Uint8Array(GRID_W * GRID_H);
  const berries = new Uint8Array(GRID_W * GRID_H);
  berries[fakeIdx(berryX, berryY)] = 1;
  return { tiles, berries, growth: new Uint8Array(0), trees: new Uint8Array(0), rocks: new Uint8Array(0) };
}

function makeAI({ jobs = [], world }) {
  const noteCalls = { count: 0, lastJob: null };
  const state = {
    units: { buildings: [], jobs, villagers: [], itemsOnGround: [] },
    stocks: { totals: { food: 0, wood: 0, stone: 0 }, reserved: {} },
    time: { tick: 100, dayTime: 1000 },
    world,
    bb: null,
  };
  const noop = () => {};
  // finishJob mirrors jobs.js: decrement assigned, optionally remove.
  const finishJob = (v, remove = false) => {
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
  const ai = createVillagerAI({
    state,
    policy: { style: { jobScoring: {} }, sliders: {} },
    pathfind: (sx, sy, x, y) => [{ x, y }], // any non-null path
    passable: () => true,
    Toast: { show: noop },
    addJob: noop,
    finishJob,
    noteJobAssignmentChanged: (j) => { noteCalls.count++; noteCalls.lastJob = j; },
    availableToReserve: () => 0,
    reserveMaterials: () => true,
    releaseReservedMaterials: noop,
    findAnimalById: () => null,
    findEntryTileNear: () => ({ x: 0, y: 0 }),
    getBuildingById: () => null,
    buildingsByKind: new Map(),
    idx: fakeIdx,
    ambientAt: () => 'day',
    isNightTime: () => false,
  });
  return { ai, state, jobs, noteCalls, finishJob };
}

function makeVillager(overrides = {}) {
  return {
    x: 5, y: 5,
    hunger: 1.1,
    energy: 0.5,
    happy: 0.5,
    condition: 'starving',
    starveStage: 2,
    state: 'idle',
    path: null,
    targetJob: null,
    targetI: null,
    _nextPathTick: 0,
    thought: '',
    ...overrides,
  };
}

test('B17: seekEmergencyFood attaches a matching unassigned forage job', () => {
  const world = makeBerryWorld(7, 5);
  const targetI = fakeIdx(7, 5);
  const forageJob = { id: 1, type: 'forage', x: 7, y: 5, targetI, prio: 0.85, assigned: 0 };
  const { ai, noteCalls } = makeAI({ jobs: [forageJob], world });
  const v = makeVillager();

  const ok = ai.seekEmergencyFood(v);
  assert.equal(ok, true, 'emergency forage should succeed when a berry is in range');
  assert.equal(v.state, 'forage');
  assert.equal(v.targetI, targetI);
  assert.equal(v.targetJob, forageJob, 'targetJob must be attached to the matching forage job');
  assert.equal(forageJob.assigned, 1, 'matching job must increment assigned to 1');
  assert.equal(noteCalls.count, 1, 'noteJobAssignmentChanged must fire exactly once');
  assert.equal(noteCalls.lastJob, forageJob);
});

test('B17: arriving at the berry tile removes the attached job from the queue', () => {
  const world = makeBerryWorld(7, 5);
  const targetI = fakeIdx(7, 5);
  const forageJob = { id: 1, type: 'forage', x: 7, y: 5, targetI, prio: 0.85, assigned: 0 };
  const { ai, jobs, finishJob } = makeAI({ jobs: [forageJob], world });
  const v = makeVillager();

  ai.seekEmergencyFood(v);
  assert.equal(jobs.length, 1, 'precondition: job is in queue while villager is walking');

  // Simulate the onArrive forage path: finishJob(v, true) is the cleanup call.
  finishJob(v, true);
  assert.equal(jobs.length, 0, 'matching job must be removed from the queue on arrival');
  assert.equal(v.targetJob, null);
});

test('B17: with no matching job, emergency forage proceeds without orphaning anything', () => {
  // Berry outside the planner's forage radius — no forage job was ever
  // emitted for it. Behavior must not regress: pickup proceeds, targetJob
  // stays null, no orphan accumulates.
  const world = makeBerryWorld(7, 5);
  const { ai, jobs } = makeAI({ jobs: [], world });
  const v = makeVillager();

  const ok = ai.seekEmergencyFood(v);
  assert.equal(ok, true);
  assert.equal(v.state, 'forage');
  assert.equal(v.targetJob, null, 'no matching job → targetJob stays null');
  assert.equal(jobs.length, 0, 'no orphan job created or left behind');
});

test('B17: an already-claimed forage job is not double-assigned', () => {
  // Another villager is already routed to this berry (assigned=1). The
  // emergency forager must not steal the count — the other villager owns
  // the cleanup.
  const world = makeBerryWorld(7, 5);
  const targetI = fakeIdx(7, 5);
  const claimedJob = { id: 1, type: 'forage', x: 7, y: 5, targetI, prio: 0.85, assigned: 1 };
  const { ai, noteCalls } = makeAI({ jobs: [claimedJob], world });
  const v = makeVillager();

  ai.seekEmergencyFood(v);
  assert.equal(claimedJob.assigned, 1, 'claimed job must not be double-incremented');
  assert.equal(v.targetJob, null, 'targetJob must stay null when no unassigned match exists');
  assert.equal(noteCalls.count, 0, 'noteJobAssignmentChanged must not fire on a claimed job');
});
