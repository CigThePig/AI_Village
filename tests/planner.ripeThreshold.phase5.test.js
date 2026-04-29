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

const { createPlanner } = await import('../src/app/planner.js');
const { GRID_W, GRID_H, TILES, RIPE_THRESHOLD } = await import('../src/app/constants.js');

function makePlanner() {
  const tiles = new Uint8Array(GRID_W * GRID_H);
  const growth = new Uint8Array(GRID_W * GRID_H);
  const zone = new Uint8Array(GRID_W * GRID_H);
  const berries = new Uint8Array(GRID_W * GRID_H);
  const trees = new Uint8Array(GRID_W * GRID_H);
  const rocks = new Uint8Array(GRID_W * GRID_H);
  const state = {
    units: { villagers: [], animals: [], buildings: [], jobs: [] },
    stocks: { totals: { food: 0, wood: 0, stone: 0, bow: 0, pelt: 0 }, reserved: {} },
    time: { tick: 0, dayTime: 0 },
    world: { tiles, growth, zone, berries, trees, rocks },
  };
  const noop = () => {};
  const planner = createPlanner({
    state,
    policy: { sliders: {}, style: { jobScoring: {}, jobCreation: {} } },
    pathfind: () => null,
    addJob: () => null,
    hasSimilarJob: () => false,
    noteJobRemoved: noop,
    requestBuildHauls: noop,
    countBuildingsByKind: () => 0,
    ensureBlackboardSnapshot: () => null,
    getJobCreationConfig: () => ({}),
    violatesSpacing: () => false,
    zoneCanEverWork: () => true,
    zoneHasWorkNow: () => true,
    updateZoneRow: noop,
    markZoneOverlayDirty: noop,
    markStaticDirty: noop,
    availableToReserve: () => 0,
    reserveMaterials: () => true,
    releaseReservedMaterials: noop,
    addBuilding: noop,
    Toast: { show: noop },
    toTile: (n) => n | 0,
  });
  return { planner, state, tiles, growth };
}

test('B2: RIPE_THRESHOLD constant is 150 (matches harvest job emit threshold)', () => {
  // Regression guard against accidental drift. The whole point of unifying
  // 150 and 160 was to fix the `hasRipeCrops()` / harvest-emit mismatch.
  assert.equal(RIPE_THRESHOLD, 150);
});

test('B2: hasRipeCrops returns true once any FARMLAND tile reaches RIPE_THRESHOLD', () => {
  const { planner, tiles, growth } = makePlanner();
  // Pre-condition: empty world has no ripe crops.
  assert.equal(planner.hasRipeCrops(), false, 'empty world should have no ripe crops');

  const i = 5 * GRID_W + 7;
  tiles[i] = TILES.FARMLAND;
  growth[i] = 149;
  assert.equal(planner.hasRipeCrops(), false, 'growth=149 must not count as ripe');

  growth[i] = RIPE_THRESHOLD;
  assert.equal(planner.hasRipeCrops(), true, 'growth=RIPE_THRESHOLD must count as ripe');
});

test('B2/S8/S9: at growth 152 hasRipeCrops is true (the old 160 threshold reported false)', () => {
  // The bug: harvest jobs emit at growth >= 150 but hasRipeCrops() defaulted
  // to threshold 160. During growth ∈ [150, 160), the planner believed "no
  // ripe crops" and the `forageNeed` clause spuriously added forage on top
  // of harvest. The fix unifies on RIPE_THRESHOLD = 150.
  const { planner, tiles, growth } = makePlanner();
  const i = 12 * GRID_W + 30;
  tiles[i] = TILES.FARMLAND;
  growth[i] = 152;
  assert.equal(planner.hasRipeCrops(), true,
    'growth=152 must report ripe; pre-fix this returned false because of the 160 default');
});

test('B2: non-FARMLAND tiles with high growth are ignored', () => {
  // Defensive: a stray growth value on a non-FARMLAND tile (e.g., a tile
  // that was zone-cleared mid-grow) should not inflate hasRipeCrops.
  const { planner, tiles, growth } = makePlanner();
  const i = 4 * GRID_W + 4;
  tiles[i] = TILES.GRASS;
  growth[i] = 200;
  assert.equal(planner.hasRipeCrops(), false);
});
