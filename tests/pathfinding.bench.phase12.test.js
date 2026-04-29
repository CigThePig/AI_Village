import test from 'node:test';
import { strict as assert } from 'node:assert';

import { GRID_W, GRID_H, GRID_SIZE } from '../src/app/constants.js';
import { createPathfinder } from '../src/app/pathfinding.js';
import { paintBuildingFootprint } from '../src/app/world.js';

// Phase 12 perf smoke test. Not a tight bound — guards against regressions
// (e.g. accidental .fill(GRID_SIZE) in the hot loop) while tolerating CI
// jitter. The threshold is intentionally generous; if you breach it you've
// almost certainly broken something serious.

test('Phase 12: 200 random pathfinds on a populated 192×192 map complete in < 5s', () => {
  const world = {
    tiles: new Uint8Array(GRID_SIZE),
    width: GRID_W,
    height: GRID_H,
    buildingOccupancy: new Uint8Array(GRID_SIZE),
  };

  // Sprinkle ~30 buildings (2x2 footprints) deterministically across the map.
  const buildings = [];
  for (let i = 0; i < 30; i++) {
    const x = ((i * 17) % (GRID_W - 4)) + 2;
    const y = ((i * 29) % (GRID_H - 4)) + 2;
    buildings.push({ id: i + 1, kind: 'hut', x, y, built: 1 });
  }
  for (const b of buildings) paintBuildingFootprint(world, b);

  const idx = (x, y) => (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H ? -1 : y * GRID_W + x);
  const tileOccupiedByBuilding = (x, y) => world.buildingOccupancy[y * GRID_W + x] !== 0;

  const { pathfind } = createPathfinder({
    idx,
    tileOccupiedByBuilding,
    getWorld: () => world,
    getTick: () => 0,
    perf: { log: false },
  });

  const N = 200;
  // Deterministic pseudorandom source so the benchmark is stable across runs.
  let seed = 0xdeadbeef;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const start = performance.now();
  let resolved = 0;
  for (let i = 0; i < N; i++) {
    const sx = next() % GRID_W;
    const sy = next() % GRID_H;
    const tx = next() % GRID_W;
    const ty = next() % GRID_H;
    const p = pathfind(sx, sy, tx, ty, 600);
    if (p) resolved++;
  }
  const elapsed = performance.now() - start;
  // Most random pairs should be reachable; at minimum, the call must complete.
  assert.ok(resolved > 0, 'expected at least one resolved path');
  assert.ok(elapsed < 5000, `200 pathfinds took ${elapsed.toFixed(1)}ms (>5s)`);
});
