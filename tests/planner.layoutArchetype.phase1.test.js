import test from 'node:test';
import { strict as assert } from 'node:assert';

// Phase 1 — Settlement layout templates.
//
// These tests lock in the contract from AI_VILLAGE_PLAN.md Phase 1:
//   1. Same seed + same terrain → identical archetype + slot table.
//   2. Different terrain shapes → different archetypes (radial / ribbon /
//      terrace / courtyard) AND visibly different anchor positions.
//   3. The planner's findPlacementNear routes each of the 6 building kinds
//      into its slot's footprint (the within-slot scoring is the tie-breaker,
//      not the layout selector).
//   4. SAVE_VERSION bumped to 8 with a no-op v7 migration entry.

function ensureBrowserStubs() {
  if (!globalThis.document) {
    globalThis.document = { getElementById: () => ({ getContext: () => ({ imageSmoothingEnabled: true }), getBoundingClientRect: () => ({ width: 800, height: 600 }), style: {}, width: 0, height: 0 }) };
  }
  if (!globalThis.window) globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
  if (!globalThis.AIV_TERRAIN) globalThis.AIV_TERRAIN = { generateTerrain: () => ({}), makeHillshade: () => new Uint8ClampedArray(0) };
  if (!globalThis.AIV_CONFIG) globalThis.AIV_CONFIG = { WORLDGEN_DEFAULTS: {}, SHADING_DEFAULTS: { ambient: 0.5, intensity: 0.5, slopeScale: 1 } };
}
ensureBrowserStubs();

const { buildLayout, chooseArchetype, analyzeTerrain, findSlotForKind, recomputeOccupancy } = await import('../src/app/layout.js');
const { GRID_W, GRID_H, TILES, SAVE_VERSION, SAVE_MIGRATIONS } = await import('../src/app/constants.js');
const { createPlanner } = await import('../src/app/planner.js');
const { policy } = await import('../src/policy/policy.js');

const N = GRID_W * GRID_H;

function blankWorld() {
  return {
    seed: 0,
    tiles: new Uint8Array(N).fill(TILES.GRASS),
    trees: new Uint8Array(N),
    rocks: new Uint8Array(N),
    berries: new Uint8Array(N),
    growth: new Uint8Array(N),
    zone: new Uint8Array(N),
    width: GRID_W,
    height: GRID_H,
    aux: {}
  };
}

function withWaterNorth() {
  const w = blankWorld();
  // Lay a water band across the north sixth of the map. dominantWaterSide
  // requires ≥2% of the map to be water and ≥40% of those tiles in the
  // dominant quadrant — a single-band stripe in the north satisfies both.
  for (let y = 0; y < Math.floor(GRID_H / 6); y++) {
    for (let x = 0; x < GRID_W; x++) {
      w.tiles[y * GRID_W + x] = TILES.WATER;
    }
  }
  return w;
}

function withDenseCenterTrees() {
  const w = blankWorld();
  const cx = (GRID_W / 2) | 0;
  const cy = (GRID_H / 2) | 0;
  for (let y = cy - 6; y <= cy + 6; y++) {
    for (let x = cx - 6; x <= cx + 6; x++) {
      w.trees[y * GRID_W + x] = 1;
    }
  }
  return w;
}

function withSlope() {
  const w = blankWorld();
  // Linear height ramp 0 → 250 across the map. analyzeTerrain reads
  // (max - min) / 255 as the slope strength, so this lands at ~0.98.
  const h = new Uint8Array(N);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      h[y * GRID_W + x] = Math.min(255, Math.floor((y / GRID_H) * 250));
    }
  }
  w.aux = { height: h };
  return w;
}

test('Phase 1: chooseArchetype is deterministic for the same seed and features', () => {
  const w = blankWorld();
  const features = analyzeTerrain(w);
  const a = chooseArchetype(12345, features);
  const b = chooseArchetype(12345, features);
  assert.equal(a, b, 'same seed must yield same archetype');
});

test('Phase 1: buildLayout is byte-equal across runs with the same seed and world', () => {
  const w1 = blankWorld();
  const w2 = blankWorld();
  const l1 = buildLayout(424242, w1);
  const l2 = buildLayout(424242, w2);
  // occupancy is a Map (not JSON-serializable in a stable way); compare the
  // rest of the structure.
  const stripped = (layout) => ({
    archetype: layout.archetype,
    origin: layout.origin,
    anchors: layout.anchors,
    slots: layout.slots,
    features: layout.features
  });
  assert.equal(JSON.stringify(stripped(l1)), JSON.stringify(stripped(l2)));
  assert.ok(l1.occupancy instanceof Map && l1.occupancy.size === 0);
});

test('Phase 1: terrain shape drives archetype — water→ribbon, dense center trees→radial, slope→terrace, open→courtyard', () => {
  const ribbon = buildLayout(1, withWaterNorth());
  const radial = buildLayout(2, withDenseCenterTrees());
  const terrace = buildLayout(3, withSlope());
  const courtyard = buildLayout(4, blankWorld());

  assert.equal(ribbon.archetype, 'ribbon', `expected ribbon, got ${ribbon.archetype}`);
  assert.equal(radial.archetype, 'radial', `expected radial, got ${radial.archetype}`);
  assert.equal(terrace.archetype, 'terrace', `expected terrace, got ${terrace.archetype}`);
  assert.equal(courtyard.archetype, 'courtyard', `expected courtyard, got ${courtyard.archetype}`);

  // Anchor-position divergence: at least three of the four archetypes must
  // differ from one another in the hearth + storage + craft anchors. This is
  // the "slot-position diff > threshold" check from the acceptance criteria.
  const all = [ribbon, radial, terrace, courtyard];
  const anchorSig = (l) => {
    const keys = ['hearth', 'storage-main', 'craft', 'fields-1'];
    return keys.map((k) => `${k}:${l.anchors[k].x},${l.anchors[k].y}`).join('|');
  };
  const sigs = new Set(all.map(anchorSig));
  assert.ok(sigs.size >= 3, `expected >=3 distinct anchor signatures, got ${sigs.size}`);
});

test('Phase 1: every archetype emits the full slot family set used by all 6 building kinds', () => {
  const layouts = [
    buildLayout(1, withWaterNorth()),
    buildLayout(2, withDenseCenterTrees()),
    buildLayout(3, withSlope()),
    buildLayout(4, blankWorld())
  ];
  const requiredFamilies = ['hearth', 'storage', 'housing', 'craft', 'fields', 'wells'];
  for (const layout of layouts) {
    const families = new Set(layout.slots.map((s) => s.family));
    for (const family of requiredFamilies) {
      assert.ok(families.has(family), `${layout.archetype} missing family ${family}`);
    }
  }
});

test('Phase 1: findSlotForKind routes each of the 6 building kinds into a slot whose kindAffinity matches', () => {
  const layout = buildLayout(2, withDenseCenterTrees());
  const kinds = ['campfire', 'storage', 'hut', 'hunterLodge', 'farmplot', 'well'];
  for (const kind of kinds) {
    const slot = findSlotForKind(layout, kind);
    assert.ok(slot, `findSlotForKind(${kind}) returned null`);
    assert.ok(slot.kindAffinity.includes(kind),
      `slot ${slot.id} (${slot.family}) does not list ${kind} in kindAffinity`);
  }
});

test('Phase 1: planner._findPlacementNear places each kind inside its slot footprint', () => {
  const world = blankWorld();
  const layout = buildLayout(99, world);
  world.layout = layout;

  const buildings = [];
  const state = {
    units: { buildings, jobs: [], villagers: [{ id: 1, x: layout.origin.x, y: layout.origin.y }], animals: [] },
    stocks: { totals: { food: 0, wood: 100, stone: 50 }, reserved: {} },
    time: { tick: 1 },
    world,
    bb: { villagers: 1, availableFood: 10, availableWood: 100, availableStone: 50 }
  };
  const noop = () => {};
  const planner = createPlanner({
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

  const kinds = ['campfire', 'storage', 'hut', 'hunterLodge', 'farmplot', 'well'];
  for (const kind of kinds) {
    // Reset occupancy for each kind so we always probe the first eligible
    // slot. Capture the expected slot BEFORE the placement call, since the
    // call increments occupancy and may exhaust capacity-1 slots like
    // hearth/storage.
    layout.occupancy.clear();
    const slot = findSlotForKind(layout, kind);
    assert.ok(slot, `no slot for ${kind}`);
    const fp = slot.footprint;
    const pos = planner._findPlacementNear(kind, layout.origin.x, layout.origin.y, 18);
    assert.ok(pos, `findPlacementNear(${kind}) returned null`);
    assert.ok(
      pos.x >= fp.x && pos.x < fp.x + fp.w && pos.y >= fp.y && pos.y < fp.y + fp.h,
      `${kind} placed at (${pos.x},${pos.y}) is outside slot ${slot.id} fp=(${fp.x},${fp.y},${fp.w}x${fp.h})`
    );
  }
});

test('Phase 1: recomputeOccupancy rebuilds the occupancy map from a live buildings list', () => {
  const world = blankWorld();
  const layout = buildLayout(7, world);
  const housingSlot = layout.slots.find((s) => s.family === 'housing');
  assert.ok(housingSlot, 'expected at least one housing slot');
  // Drop two huts inside the housing slot — their footprint must overlap it.
  const buildings = [
    { kind: 'hut', x: housingSlot.footprint.x, y: housingSlot.footprint.y },
    { kind: 'hut', x: housingSlot.footprint.x + 2, y: housingSlot.footprint.y }
  ];
  recomputeOccupancy(layout, buildings, policy.layout);
  assert.equal(layout.occupancy.get(housingSlot.id), 2,
    `housing slot ${housingSlot.id} should report occupancy=2, got ${layout.occupancy.get(housingSlot.id)}`);
});

test('Phase 1: SAVE_VERSION is 8 and SAVE_MIGRATIONS exposes a no-op entry for v7→v8', () => {
  assert.equal(SAVE_VERSION, 8, 'SAVE_VERSION must be bumped to 8 for the layout addition');
  const migrate7 = SAVE_MIGRATIONS.get(7);
  assert.equal(typeof migrate7, 'function', 'v7→v8 migration entry must exist');
  const probe = { foo: 'bar' };
  assert.deepEqual(migrate7(probe), probe, 'v7→v8 migration must be a pure no-op');
});
