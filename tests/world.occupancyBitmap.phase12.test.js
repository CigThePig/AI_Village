import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
  paintBuildingFootprint,
  clearBuildingFootprint,
  rebuildBuildingOccupancy,
  tileOccupiedByBuildingFast,
  tileOccupiedByBuildingIn,
} from '../src/app/world.js';

function makeWorld(w = 16, h = 16) {
  return {
    width: w,
    height: h,
    buildingOccupancy: new Uint8Array(w * h),
  };
}

function makeBuilding(kind, x, y, id, built = 1) {
  return { id, kind, x, y, built };
}

test('S13: paintBuildingFootprint marks every footprint tile', () => {
  const world = makeWorld();
  const hut = makeBuilding('hut', 5, 7, 1);
  paintBuildingFootprint(world, hut);
  // hut footprint is 2x2 — see FOOTPRINT in world.js
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      assert.equal(tileOccupiedByBuildingFast(world, 5 + dx, 7 + dy), true);
    }
  }
  // Adjacent tiles must remain free.
  assert.equal(tileOccupiedByBuildingFast(world, 4, 7), false);
  assert.equal(tileOccupiedByBuildingFast(world, 7, 7), false);
  assert.equal(tileOccupiedByBuildingFast(world, 5, 9), false);
});

test('S13: tileOccupiedByBuildingFast agrees with linear scan for many placements', () => {
  const world = makeWorld(20, 20);
  const buildings = [
    makeBuilding('hut', 1, 1, 1),
    makeBuilding('storage', 8, 4, 2),
    makeBuilding('well', 12, 12, 3),
    makeBuilding('farmplot', 3, 14, 4),
    makeBuilding('campfire', 17, 17, 5),
  ];
  for (const b of buildings) paintBuildingFootprint(world, b);
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const fast = tileOccupiedByBuildingFast(world, x, y);
      const slow = tileOccupiedByBuildingIn(buildings, x, y);
      assert.equal(fast, slow, `mismatch at ${x},${y}`);
    }
  }
});

test('S13: clearBuildingFootprint removes the building from the bitmap', () => {
  const world = makeWorld();
  const hut = makeBuilding('hut', 3, 3, 1);
  paintBuildingFootprint(world, hut);
  clearBuildingFootprint(world, hut);
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      assert.equal(tileOccupiedByBuildingFast(world, 3 + dx, 3 + dy), false);
    }
  }
});

test('S13: rebuildBuildingOccupancy reconstructs from buildings array', () => {
  const world = makeWorld();
  // Stale data already in the bitmap should be wiped first.
  world.buildingOccupancy[0] = 1;
  world.buildingOccupancy[5] = 1;
  const buildings = [makeBuilding('hut', 8, 8, 1), makeBuilding('storage', 12, 12, 2)];
  rebuildBuildingOccupancy(world, buildings);
  assert.equal(tileOccupiedByBuildingFast(world, 0, 0), false, 'stale data must be cleared');
  assert.equal(tileOccupiedByBuildingFast(world, 8, 8), true);
  assert.equal(tileOccupiedByBuildingFast(world, 12, 12), true);
});

test('S13: build completion (built 0 → 1) does not change footprint', () => {
  // Buildings under construction also block movement; the bitmap is set on
  // addBuilding regardless of `built`. Toggling `built` later must not need
  // a bitmap update.
  const world = makeWorld();
  const b = makeBuilding('hut', 4, 4, 1, 0);
  paintBuildingFootprint(world, b);
  const before = Array.from(world.buildingOccupancy);
  b.built = 1;
  // Without any bitmap call, occupancy is still correct.
  const after = Array.from(world.buildingOccupancy);
  assert.deepEqual(after, before);
});

test('S13: out-of-bounds paint does not crash', () => {
  const world = makeWorld(8, 8);
  // Building partially off the grid.
  paintBuildingFootprint(world, makeBuilding('hut', 7, 7, 1));
  assert.equal(tileOccupiedByBuildingFast(world, 7, 7), true);
  assert.equal(tileOccupiedByBuildingFast(world, 8, 7), false);
  assert.equal(tileOccupiedByBuildingFast(world, 7, 8), false);
});
