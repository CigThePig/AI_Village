import test from 'node:test';
import { strict as assert } from 'node:assert';

// villagerAI → simulation → environment asserts on AIV_TERRAIN / AIV_CONFIG
// at module-load time; world.js → canvas.js touches `document` / `window`.
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

const { createVillagerAI, HYDRATION_VISIT_THRESHOLD } = await import('../src/app/villagerAI.js');
const { GRID_W } = await import('../src/app/constants.js');

let nextBuildingId = 1;
function makeBuilding(kind, x = 0, y = 0) {
  return {
    id: nextBuildingId++,
    kind,
    x,
    y,
    w: 1,
    h: 1,
    built: 1,
    progress: 1,
    activity: { occupants: 0, lastUse: 0 },
    effects: {},
  };
}

function makeAI({ buildings = [] } = {}) {
  const noop = () => {};
  const buildingsByKind = new Map();
  for (const b of buildings) {
    if (!buildingsByKind.has(b.kind)) buildingsByKind.set(b.kind, []);
    buildingsByKind.get(b.kind).push(b);
  }
  const state = {
    units: { buildings, jobs: [], villagers: [], itemsOnGround: [], animals: [] },
    stocks: { totals: { food: 0, wood: 0, stone: 0 }, reserved: {} },
    time: { tick: 1000, dayTime: 1200 },
    world: {
      tiles: new Uint8Array(GRID_W * GRID_W),
      zone: new Uint8Array(GRID_W * GRID_W),
      growth: new Uint8Array(GRID_W * GRID_W),
      berries: new Uint8Array(GRID_W * GRID_W),
      trees: new Uint8Array(GRID_W * GRID_W),
      rocks: new Uint8Array(GRID_W * GRID_W),
    },
    bb: {},
  };
  // Pathfind always returns a one-step path so any "go to building" helper succeeds.
  const pathfind = (sx, sy, dx, dy) => [{ x: dx, y: dy }];
  const ai = createVillagerAI({
    state,
    policy: { style: { jobScoring: {}, hunger: {}, jobCreation: {} }, sliders: {} },
    pathfind,
    passable: () => true,
    Toast: { show: noop },
    addJob: noop,
    finishJob: (v) => { v.targetJob = null; },
    noteJobAssignmentChanged: noop,
    availableToReserve: () => 1,
    reserveMaterials: () => true,
    releaseReservedMaterials: noop,
    findAnimalById: () => null,
    findEntryTileNear: (b) => ({ x: b.x, y: b.y }),
    getBuildingById: (id) => buildings.find((b) => b.id === id) || null,
    buildingsByKind,
    idx: (x, y) => y * GRID_W + x,
    ambientAt: (dt) => (dt > 1100 && dt < 1700 ? 'night' : 'day'),
    isNightTime: () => true,
  });
  return { ai, state };
}

function makeVillager(overrides = {}) {
  return {
    x: 0,
    y: 0,
    inv: null,
    equippedBow: false,
    hunger: 0.5,
    energy: 0.9,
    happy: 0.7,
    hydration: 1.0,
    hydrationBuffTicks: 0,
    nextHydrateTick: 0,
    nextSocialTick: 0,
    nextStorageIdleTick: 0,
    nextStarveWarning: 0,
    socialTimer: 0,
    restTimer: 0,
    condition: 'normal',
    starveStage: 0,
    sickTimer: 0,
    recoveryTimer: 0,
    state: 'idle',
    lifeStage: 'adult',
    path: null,
    targetJob: null,
    targetBuilding: null,
    activeBuildingId: null,
    reservedPickup: null,
    _nextPathTick: 0,
    _wanderFailures: new Map(),
    _forageFailures: new Map(),
    thought: '',
    ...overrides,
  };
}

const DEFAULT_BEFORE_CTX = {
  urgentFood: false,
  needsFood: false,
  nightNow: false,
  deepNight: false,
  ambientNow: 'day',
  effectiveRest: 0.26,
};

const DEFAULT_AFTER_CTX = {
  urgentFood: false,
  needsFood: false,
  ambientNow: 'day',
  jobs: [],
  hasPickedJob: false,
  stage: 0,
};

test('S11: chooseIdleBeforeJobs prefers low-energy rest over sleep / hydrate / social', () => {
  const buildings = [makeBuilding('hut', 0, 0), makeBuilding('well', 1, 0), makeBuilding('campfire', 2, 0)];
  const { ai } = makeAI({ buildings });
  const v = makeVillager({ energy: 0.1, hydration: 0.2 });
  const acted = ai.chooseIdleBeforeJobs(v, { ...DEFAULT_BEFORE_CTX, nightNow: true, deepNight: true, ambientNow: 'night' });
  assert.equal(acted, true);
  assert.equal(v.state, 'rest', 'low-energy rest must outrank sleep/hydrate/social');
});

test('S11: low-energy rest fires even when villager is mid-task (audit B1 anomaly)', () => {
  const buildings = [makeBuilding('hut', 0, 0)];
  const { ai } = makeAI({ buildings });
  const v = makeVillager({ energy: 0.1, state: 'chop', targetJob: { type: 'chop' } });
  const acted = ai.chooseIdleBeforeJobs(v, DEFAULT_BEFORE_CTX);
  assert.equal(acted, true, 'rest is intentionally not gated on idle/!targetJob');
  assert.equal(v.state, 'rest');
});

test('S11: night-anchored sleep fires when energy fine but nightNow', () => {
  const buildings = [makeBuilding('hut', 0, 0), makeBuilding('well', 1, 0), makeBuilding('campfire', 2, 0)];
  const { ai } = makeAI({ buildings });
  const v = makeVillager({ energy: 0.5, hydration: 1.0 });
  const acted = ai.chooseIdleBeforeJobs(v, { ...DEFAULT_BEFORE_CTX, nightNow: true, deepNight: true, ambientNow: 'night' });
  assert.equal(acted, true);
  assert.equal(v.state, 'rest');
  assert.equal(v._fellAsleepAtNight, true, 'night-sleep marks the wake-at-dawn flag');
});

test('S11: hydrate fires in daylight when not urgent and hydration is low', () => {
  const buildings = [makeBuilding('well', 1, 0), makeBuilding('campfire', 2, 0)];
  const { ai } = makeAI({ buildings });
  const v = makeVillager({ energy: 0.9, hydration: HYDRATION_VISIT_THRESHOLD - 0.1 });
  const acted = ai.chooseIdleBeforeJobs(v, DEFAULT_BEFORE_CTX);
  assert.equal(acted, true);
  assert.equal(v.state, 'hydrate');
});

test('S11: hydrate is suppressed by urgentFood', () => {
  const buildings = [makeBuilding('well', 1, 0)];
  const { ai } = makeAI({ buildings });
  const v = makeVillager({ energy: 0.9, hydration: 0.1 });
  const acted = ai.chooseIdleBeforeJobs(v, { ...DEFAULT_BEFORE_CTX, urgentFood: true });
  assert.equal(acted, false, 'urgentFood blocks hydrate (and every later branch)');
  assert.equal(v.state, 'idle');
});

test('S11: night-social fires when nightNow, well-fed, hydrated, and a campfire exists', () => {
  const buildings = [makeBuilding('campfire', 2, 0)];
  const { ai } = makeAI({ buildings });
  const v = makeVillager({ energy: 0.9, hydration: 1.0 });
  const acted = ai.chooseIdleBeforeJobs(v, { ...DEFAULT_BEFORE_CTX, nightNow: true, ambientNow: 'night' });
  assert.equal(acted, true);
  assert.equal(v.state, 'socialize');
});

test('S11: chooseIdleBeforeJobs returns false when no branch can act', () => {
  const { ai } = makeAI({ buildings: [] });
  const v = makeVillager({ energy: 0.9, hydration: 1.0 });
  const acted = ai.chooseIdleBeforeJobs(v, DEFAULT_BEFORE_CTX);
  assert.equal(acted, false, 'no branch fires; caller should fall through to job pickup');
  assert.equal(v.state, 'idle');
});

test('S11: chooseIdleAfterJobs prefers storage idle when idle and queue empty', () => {
  const buildings = [makeBuilding('storage', 3, 0), makeBuilding('campfire', 2, 0)];
  const { ai } = makeAI({ buildings });
  const v = makeVillager();
  const acted = ai.chooseIdleAfterJobs(v, DEFAULT_AFTER_CTX);
  assert.equal(acted, true);
  assert.equal(v.state, 'storage_idle');
});

test('S11: storage idle does NOT fire when a job was picked this tick', () => {
  const buildings = [makeBuilding('storage', 3, 0)];
  const { ai } = makeAI({ buildings });
  const v = makeVillager();
  const acted = ai.chooseIdleAfterJobs(v, { ...DEFAULT_AFTER_CTX, hasPickedJob: true });
  // Falls through to roam fallback (always true). Storage state must NOT be set.
  assert.equal(acted, true);
  assert.notEqual(v.state, 'storage_idle');
});

test('S11: chooseIdleAfterJobs always returns true via roam fallback', () => {
  const { ai } = makeAI({ buildings: [] });
  const v = makeVillager();
  const acted = ai.chooseIdleAfterJobs(v, DEFAULT_AFTER_CTX);
  assert.equal(acted, true, 'roam fallback always acts');
});
