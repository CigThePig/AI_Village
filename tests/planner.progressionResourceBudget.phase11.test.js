import test from 'node:test';
import { strict as assert } from 'node:assert';

// Phase 11 (B13): applyProgressionPlanner deducts each pushed plan's wood
// and stone cost from the running `available` pool, so a later tier sees
// resources committed by an earlier tier in the same tick. Without the fix,
// two tiers can both pass meetsProgressionRequirements against the same
// wood and the planner stamps both as `unlocked = true` + cooldown'd, even
// though the downstream budget loop will only place one.

// Browser stubs for transitive imports (matches forage.emergencyJobLifecycle.phase5).
function ensureBrowserStubs() {
  if (!globalThis.document) {
    globalThis.document = { getElementById: () => ({ getContext: () => ({ imageSmoothingEnabled: true }), getBoundingClientRect: () => ({ width: 800, height: 600 }), style: {}, width: 0, height: 0 }) };
  }
  if (!globalThis.window) globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
  if (!globalThis.AIV_TERRAIN) globalThis.AIV_TERRAIN = { generateTerrain: () => ({}), makeHillshade: () => new Uint8ClampedArray(0) };
  if (!globalThis.AIV_CONFIG) globalThis.AIV_CONFIG = { WORLDGEN_DEFAULTS: {}, SHADING_DEFAULTS: { ambient: 0.5, intensity: 0.5, slopeScale: 1 } };
}
ensureBrowserStubs();

const { createPlanner } = await import('../src/app/planner.js');
const { GRID_W, GRID_H } = await import('../src/app/constants.js');

function makePlanner({ availableWood, availableStone = 100, villagers = 6, tiers }) {
  const buildings = [];
  const jobs = [];
  const villagerList = Array.from({ length: villagers }, (_, i) => ({ id: i + 1, x: 5, y: 5 }));
  const state = {
    units: { buildings, jobs, villagers: villagerList, animals: [] },
    stocks: { totals: { food: 0, wood: availableWood, stone: availableStone }, reserved: {} },
    time: { tick: 1000, dayTime: 1000 },
    world: {
      tiles: new Uint8Array(GRID_W * GRID_H),
      zone: new Uint8Array(GRID_W * GRID_H),
      growth: new Uint8Array(GRID_W * GRID_H),
      berries: new Uint8Array(GRID_W * GRID_H),
      trees: new Uint8Array(GRID_W * GRID_H),
      rocks: new Uint8Array(GRID_W * GRID_H),
    },
    bb: {
      villagers,
      availableFood: 100,
      availableWood,
      availableStone,
    },
  };
  const policy = {
    sliders: { food: 0.5, build: 0.5, explore: 0.3 },
    style: { jobScoring: {}, hunger: {}, jobCreation: {} },
    progression: {
      hysteresisTicks: 240,
      resourceHysteresis: 0.18,
      maxPlansPerTick: 2,
      tiers,
    },
  };
  const noop = () => {};
  const planner = createPlanner({
    state,
    policy,
    pathfind: () => null,
    addJob: noop,
    hasSimilarJob: () => false,
    noteJobRemoved: noop,
    requestBuildHauls: noop,
    countBuildingsByKind: (kind) => ({ total: buildings.filter((b) => b.kind === kind).length, built: 0 }),
    ensureBlackboardSnapshot: () => state.bb,
    getJobCreationConfig: () => ({}),
    violatesSpacing: () => false,
    zoneCanEverWork: () => true,
    zoneHasWorkNow: () => false,
    updateZoneRow: noop,
    markZoneOverlayDirty: noop,
    markStaticDirty: noop,
    availableToReserve: (resource) => state.stocks.totals[resource] || 0,
    reserveMaterials: () => true,
    releaseReservedMaterials: noop,
    addBuilding: noop,
    Toast: { show: noop },
    toTile: (n) => n | 0,
  });
  return { planner, state };
}

test('B13: when wood is tight, the second tier is NOT unlocked or cooldown-stamped', () => {
  // stockpile: storage costs 8 wood; housing: hut costs 10 wood.
  // available = 16 wood: stockpile passes (16 ≥ 12), pushes storage, deducts to 8.
  // housing then sees wood=8, fails the requires.wood=16 check, no push.
  const tiers = [
    { id: 'stockpile', minPopulation: 2, requires: { wood: 12 }, priority: 8.6, plans: [{ kind: 'storage', target: 1 }] },
    { id: 'housing', minPopulation: 4, requires: { wood: 16 }, priority: 8.3, plans: [{ kind: 'hut', target: 2 }] },
  ];
  const { planner, state } = makePlanner({ availableWood: 16, tiers });
  const queue = [];
  planner._applyProgressionPlanner(queue, state.bb, {}, { x: 5, y: 5 });

  assert.equal(queue.length, 1, 'only one tier should successfully push (stockpile)');
  assert.equal(queue[0].kind, 'storage');

  const memory = planner._progressionMemory;
  const stockpileState = memory.get('stockpile');
  const housingState = memory.get('housing');
  assert.ok(stockpileState?.unlocked === true, 'stockpile is unlocked (it shipped)');
  assert.ok(stockpileState.cooldownUntil > 1000, 'stockpile cooldown is set');

  // The whole point of B13: housing should NOT be flagged as shipped.
  assert.notEqual(housingState?.unlocked, true,
    'housing must not be flagged unlocked when its plan was budget-skipped');
  assert.ok(!housingState || (housingState.cooldownUntil ?? 0) <= 1000,
    'housing must not be put on cooldown when its plan was budget-skipped');
});

test('B13: when wood is plenty, both tiers ship and both get cooldown-stamped', () => {
  const tiers = [
    { id: 'stockpile', minPopulation: 2, requires: { wood: 12 }, priority: 8.6, plans: [{ kind: 'storage', target: 1 }] },
    { id: 'housing', minPopulation: 4, requires: { wood: 16 }, priority: 8.3, plans: [{ kind: 'hut', target: 2 }] },
  ];
  const { planner, state } = makePlanner({ availableWood: 30, tiers });
  const queue = [];
  planner._applyProgressionPlanner(queue, state.bb, {}, { x: 5, y: 5 });

  // maxPlansPerTick=2 caps the queue length even when more tiers are eligible.
  assert.equal(queue.length, 2, 'both tiers ship when wood is plenty');
  assert.ok(queue.some((q) => q.kind === 'storage'));
  assert.ok(queue.some((q) => q.kind === 'hut'));

  const memory = planner._progressionMemory;
  assert.equal(memory.get('stockpile')?.unlocked, true);
  assert.equal(memory.get('housing')?.unlocked, true);
});

test('B13: stone cost is also deducted (well/hunterLodge case)', () => {
  // hunterLodge costs 10 wood + 2 stone; well costs 0 wood + 6 stone.
  // Set stone = 6: hunterLodge ships first (deducts 2 stone → 4 left).
  // Then well requires { stone: 6 }; sees 4, fails.
  const tiers = [
    { id: 'workshops', minPopulation: 2, requires: { wood: 10, stone: 2 }, priority: 7.9, plans: [{ kind: 'hunterLodge', target: 1 }] },
    { id: 'infrastructure', minPopulation: 2, requires: { wood: 0, stone: 6 }, priority: 7.4, plans: [{ kind: 'well', target: 1 }] },
  ];
  const { planner, state } = makePlanner({ availableWood: 30, availableStone: 6, tiers });
  const queue = [];
  planner._applyProgressionPlanner(queue, state.bb, {}, { x: 5, y: 5 });

  assert.equal(queue.length, 1, 'only workshops ships; infrastructure budget-blocked on stone');
  assert.equal(queue[0].kind, 'hunterLodge');

  const memory = planner._progressionMemory;
  assert.notEqual(memory.get('infrastructure')?.unlocked, true);
});
