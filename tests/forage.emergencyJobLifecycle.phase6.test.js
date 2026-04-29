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
    pathfind: (sx, sy, x, y) => [{ x, y }],
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

test('Phase 6 carry-over: emergency forage releases a prior non-forage claim', () => {
  // The urgent-food path can fire while the villager is mid-job. Without
  // releasing the prior claim, its assigned counter leaks to 1 forever and
  // the job becomes unpickable.
  const world = makeBerryWorld(7, 5);
  const targetI = fakeIdx(7, 5);
  const chopJob = { id: 42, type: 'chop', x: 9, y: 9, prio: 0.5, assigned: 1 };
  const forageJob = { id: 1, type: 'forage', x: 7, y: 5, targetI, prio: 0.85, assigned: 0 };
  const { ai } = makeAI({ jobs: [chopJob, forageJob], world });
  const v = makeVillager({ targetJob: chopJob, state: 'chop' });

  const ok = ai.seekEmergencyFood(v);
  assert.equal(ok, true);
  assert.equal(chopJob.assigned, 0, 'prior chop job must be released back to assigned=0');
  assert.equal(forageJob.assigned, 1, 'forage job must be claimed');
  assert.equal(v.targetJob, forageJob, 'targetJob must point at the forage job');
});

test('Phase 6 carry-over: emergency forage with no prior claim is unchanged', () => {
  // Regression guard: the new release branch must not run when v.targetJob
  // is null (the original Phase 5 case).
  const world = makeBerryWorld(7, 5);
  const targetI = fakeIdx(7, 5);
  const forageJob = { id: 1, type: 'forage', x: 7, y: 5, targetI, prio: 0.85, assigned: 0 };
  const { ai } = makeAI({ jobs: [forageJob], world });
  const v = makeVillager();

  const ok = ai.seekEmergencyFood(v);
  assert.equal(ok, true);
  assert.equal(v.targetJob, forageJob);
  assert.equal(forageJob.assigned, 1);
});
