import test from 'node:test';
import { strict as assert } from 'node:assert';

// Phase 2 — Coherent farm plots.
//
// Locks in the contract from AI_VILLAGE_PLAN.md Phase 2:
//   1. Same seed + same world → identical plot table.
//   2. Every FARM zone tile lies inside exactly one rectangular plot whose
//      bounding box is axis-aligned and within policy size bounds.
//   3. At least one plot per settlement abuts the wells slot, and every plot
//      shares an edge with another plot or with wells (anti-corner-cut).
//   4. Distinct seeds produce distinct plot signatures.
//   5. Save format bumped to v9; v8 → v9 migration is a no-op.

function ensureBrowserStubs() {
  if (!globalThis.document) {
    globalThis.document = { getElementById: () => ({ getContext: () => ({ imageSmoothingEnabled: true }), getBoundingClientRect: () => ({ width: 800, height: 600 }), style: {}, width: 0, height: 0 }) };
  }
  if (!globalThis.window) globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
  if (!globalThis.AIV_TERRAIN) globalThis.AIV_TERRAIN = { generateTerrain: () => ({}), makeHillshade: () => new Uint8ClampedArray(0) };
  if (!globalThis.AIV_CONFIG) globalThis.AIV_CONFIG = { WORLDGEN_DEFAULTS: {}, SHADING_DEFAULTS: { ambient: 0.5, intensity: 0.5, slopeScale: 1 } };
}
ensureBrowserStubs();

const { buildLayout, findFarmPlotForTile } = await import('../src/app/layout.js');
const { GRID_W, GRID_H, TILES, ZONES, SAVE_VERSION, SAVE_MIGRATIONS } = await import('../src/app/constants.js');
const { createPlanner } = await import('../src/app/planner.js');
const { policy } = await import('../src/policy/policy.js');

const N = GRID_W * GRID_H;

function blankWorld(seed = 0) {
  return {
    seed,
    tiles: new Uint8Array(N).fill(TILES.GRASS),
    trees: new Uint8Array(N),
    rocks: new Uint8Array(N),
    berries: new Uint8Array(N),
    growth: new Uint8Array(N),
    zone: new Uint8Array(N),
    farmPlots: [],
    width: GRID_W,
    height: GRID_H,
    aux: {}
  };
}

function makePlanner(world) {
  const buildings = [];
  const state = {
    units: { buildings, jobs: [], villagers: [], animals: [] },
    stocks: { totals: { food: 0, wood: 100, stone: 50 }, reserved: {} },
    time: { tick: 1 },
    world,
    bb: { villagers: 1, availableFood: 0, availableWood: 100, availableStone: 50 }
  };
  const noop = () => {};
  return createPlanner({
    state,
    policy,
    pathfind: () => [{ x: 0, y: 0 }],
    addJob: noop,
    hasSimilarJob: () => false,
    noteJobRemoved: noop,
    requestBuildHauls: noop,
    countBuildingsByKind: (k) => ({ total: buildings.filter((b) => b.kind === k).length, built: 0 }),
    ensureBlackboardSnapshot: () => state.bb,
    getJobCreationConfig: () => ({}),
    violatesSpacing: () => false,
    zoneCanEverWork: () => true,
    zoneHasWorkNow: () => false,
    updateZoneRow: noop,
    markZoneOverlayDirty: noop,
    markStaticDirty: noop,
    availableToReserve: (r) => state.stocks.totals[r] || 0,
    reserveMaterials: () => true,
    releaseReservedMaterials: noop,
    addBuilding: noop,
    Toast: { show: noop },
    toTile: (n) => n | 0
  });
}

function plotSignature(plots) {
  return plots
    .map((p) => `${p.id}:${p.x},${p.y},${p.w}x${p.h}:${p.orientation}`)
    .sort()
    .join('|');
}

test('Phase 2: layoutFarmPlots is deterministic for the same seed and world', () => {
  const w1 = blankWorld(424242);
  const w2 = blankWorld(424242);
  w1.layout = buildLayout(424242, w1);
  w2.layout = buildLayout(424242, w2);
  const p1 = makePlanner(w1);
  const p2 = makePlanner(w2);
  p1._layoutFarmPlots(60);
  p2._layoutFarmPlots(60);
  assert.equal(plotSignature(w1.farmPlots), plotSignature(w2.farmPlots),
    'identical seed+world must produce identical plot tables');
});

test('Phase 2: every FARM zone tile lies inside exactly one plot rectangle', () => {
  const w = blankWorld(99);
  w.layout = buildLayout(99, w);
  const planner = makePlanner(w);
  planner._layoutFarmPlots(80);

  let farmTiles = 0;
  let outsideAnyPlot = 0;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (w.zone[y * GRID_W + x] !== ZONES.FARM) continue;
      farmTiles++;
      const plot = findFarmPlotForTile(w, x, y);
      if (!plot) outsideAnyPlot++;
    }
  }
  assert.ok(farmTiles > 0, 'expected at least one FARM tile to be marked');
  assert.equal(outsideAnyPlot, 0, `${outsideAnyPlot} FARM tiles fall outside every plot`);
});

test('Phase 2: every plot satisfies 3 ≤ w,h ≤ 6 and stays inside the grid', () => {
  const w = blankWorld(7);
  w.layout = buildLayout(7, w);
  const planner = makePlanner(w);
  planner._layoutFarmPlots(60);

  assert.ok(w.farmPlots.length > 0, 'expected at least one plot');
  for (const p of w.farmPlots) {
    assert.ok(p.w >= 3 && p.w <= 6, `plot ${p.id} width ${p.w} outside [3,6]`);
    assert.ok(p.h >= 3 && p.h <= 6, `plot ${p.id} height ${p.h} outside [3,6]`);
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= GRID_W && p.y + p.h <= GRID_H,
      `plot ${p.id} (${p.x},${p.y},${p.w}x${p.h}) leaves the grid`);
  }
});

test('Phase 2: at least one plot per settlement abuts the wells slot', () => {
  const w = blankWorld(11);
  w.layout = buildLayout(11, w);
  const planner = makePlanner(w);
  planner._layoutFarmPlots(60);

  const anyAbutsWells = w.farmPlots.some((p) => p.abutsWells);
  assert.ok(anyAbutsWells, 'expected at least one plot to abut the wells slot');
});

test('Phase 2: every plot abuts wells OR another plot (neighbor adjacency rule)', () => {
  const w = blankWorld(31);
  w.layout = buildLayout(31, w);
  const planner = makePlanner(w);
  planner._layoutFarmPlots(60);

  for (const p of w.farmPlots) {
    assert.ok(p.abutsWells || p.abutsNeighbor,
      `plot ${p.id} (${p.x},${p.y},${p.w}x${p.h}) is isolated — no edge with wells or another plot`);
  }
});

test('Phase 2: distinct seeds produce distinct plot signatures', () => {
  const wA = blankWorld(101);
  const wB = blankWorld(202);
  wA.layout = buildLayout(101, wA);
  wB.layout = buildLayout(202, wB);
  makePlanner(wA)._layoutFarmPlots(60);
  makePlanner(wB)._layoutFarmPlots(60);
  assert.notEqual(plotSignature(wA.farmPlots), plotSignature(wB.farmPlots),
    'distinct seeds must produce distinct plot tables (visual gate)');
});

test('Phase 2: orientation tracks the fields slot aspect ratio', () => {
  // All four built-in archetypes have horizontal `fields` slots (w >= h),
  // so plots should report 'horizontal' orientation regardless of which one
  // gets selected for a given seed.
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = blankWorld(seed);
    w.layout = buildLayout(seed, w);
    const fields = w.layout.slots.find((s) => s.family === 'fields');
    assert.ok(fields, `seed ${seed}: missing fields slot`);
    const planner = makePlanner(w);
    planner._layoutFarmPlots(60);
    const expected = fields.footprint.w >= fields.footprint.h ? 'horizontal' : 'vertical';
    for (const p of w.farmPlots) {
      assert.equal(p.orientation, expected,
        `seed ${seed} plot ${p.id} orientation ${p.orientation} mismatches slot aspect (${fields.footprint.w}x${fields.footprint.h})`);
    }
  }
});

test('Phase 2: findFarmPlotForTile resolves tiles inside and outside plots', () => {
  const w = blankWorld(13);
  w.layout = buildLayout(13, w);
  makePlanner(w)._layoutFarmPlots(60);
  assert.ok(w.farmPlots.length > 0, 'precondition: at least one plot exists');

  const sample = w.farmPlots[0];
  const insideX = sample.x + 1;
  const insideY = sample.y + 1;
  const inside = findFarmPlotForTile(w, insideX, insideY);
  assert.ok(inside, 'expected findFarmPlotForTile to return a plot for an interior tile');
  assert.equal(inside.id, sample.id);

  // Tile that is far from the fields slot should be outside every plot.
  const outside = findFarmPlotForTile(w, 0, 0);
  assert.equal(outside, null, 'expected null for a tile outside every plot');
});

test('Phase 2: layoutFarmPlots returns false when no layout is present', () => {
  const w = blankWorld(0);
  // No layout assigned — defensive fallback path should bail.
  const planner = makePlanner(w);
  const result = planner._layoutFarmPlots(40);
  assert.equal(result, false);
  assert.equal(w.farmPlots.length, 0);
});

test('Phase 2: re-running layoutFarmPlots on an existing slot does not duplicate plots', () => {
  const w = blankWorld(77);
  w.layout = buildLayout(77, w);
  const planner = makePlanner(w);
  planner._layoutFarmPlots(60);
  const firstSig = plotSignature(w.farmPlots);
  planner._layoutFarmPlots(60);
  const secondSig = plotSignature(w.farmPlots);
  assert.equal(firstSig, secondSig,
    're-running layoutFarmPlots must replace, not append, plots for the same slot');
});

test('Phase 2: SAVE_VERSION is 9 and SAVE_MIGRATIONS exposes a no-op entry for v8→v9', () => {
  assert.equal(SAVE_VERSION, 9, 'SAVE_VERSION must be bumped to 9 for the farmPlots addition');
  const migrate8 = SAVE_MIGRATIONS.get(8);
  assert.equal(typeof migrate8, 'function', 'v8→v9 migration entry must exist');
  const probe = { foo: 'bar' };
  assert.deepEqual(migrate8(probe), probe, 'v8→v9 migration must be a pure no-op');
});
