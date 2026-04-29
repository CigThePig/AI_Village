import test from 'node:test';
import { strict as assert } from 'node:assert';

import { GRID_W, GRID_H, GRID_SIZE, TILES } from '../src/app/constants.js';
import { createPathfinder } from '../src/app/pathfinding.js';

function emptyWorld() {
  return {
    tiles: new Uint8Array(GRID_SIZE), // all GRASS (=0) → walkable
    width: GRID_W,
    height: GRID_H,
  };
}

function makePathfinder(world, blocked = new Set()) {
  return createPathfinder({
    idx: (x, y) => (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H ? -1 : y * GRID_W + x),
    tileOccupiedByBuilding: (x, y) => blocked.has(y * GRID_W + x),
    getWorld: () => world,
    getTick: () => 0,
    perf: { log: false },
  });
}

test('S12: pathfind returns shortest path on an empty grid', () => {
  const world = emptyWorld();
  const { pathfind } = makePathfinder(world);
  const p = pathfind(2, 2, 8, 5);
  assert.ok(Array.isArray(p), 'expected a path array');
  // Manhattan distance on 4-connected grid = optimal step count.
  assert.equal(p.length, 9);
});

test('S12: pathfind on a wall finds the same length as the BFS reference', () => {
  // Vertical wall at x=10 from y=0..15, with a gap at y=16. Optimal path
  // length from (5,5) to (15,5) on a 4-connected grid:
  //   right to x=10 blocked → must go down to y=16, across to x=15, back up to y=5.
  //   = (10-5) blocked → step around: (5..15)x detour through y=16
  // Manhattan |15-5|+|5-5|=10. With wall, we go (5,5) → (5,16) → (15,16) → (15,5)
  //   waypoints = 11 + 10 + 11 = 32 (zig-zag steps; each step is 1 waypoint).
  const world = emptyWorld();
  const blocked = new Set();
  for (let y = 0; y <= 15; y++) blocked.add(y * GRID_W + 10);
  const { pathfind } = makePathfinder(world, blocked);
  const p = pathfind(5, 5, 15, 5);
  assert.ok(Array.isArray(p), 'expected a path');
  // Optimal length when forced around a 16-tall wall at x=10.
  // Down 11, right 10, up 11 = 32 steps.
  assert.equal(p.length, 32);
});

test('S12: pathfind returns null when target is unreachable within limit', () => {
  // Box the goal tile in entirely.
  const world = emptyWorld();
  const blocked = new Set();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    blocked.add((20 + dy) * GRID_W + (20 + dx));
  }
  const { pathfind } = makePathfinder(world, blocked);
  const p = pathfind(0, 0, 20, 20);
  assert.equal(p, null);
});

test('S12: pathfind returns single-tile path for start==goal', () => {
  const world = emptyWorld();
  const { pathfind } = makePathfinder(world);
  const p = pathfind(7, 7, 7, 7);
  assert.equal(p.length, 1);
});

test('S12: water tiles block the path', () => {
  const world = emptyWorld();
  // Wall of water at x=10 from y=0..15.
  for (let y = 0; y <= 15; y++) world.tiles[y * GRID_W + 10] = TILES.WATER;
  const { pathfind } = makePathfinder(world);
  const p = pathfind(5, 5, 15, 5);
  assert.ok(p, 'expected path around water wall');
  // Same detour as the building-wall case above.
  assert.equal(p.length, 32);
});

test('S12: repeated pathfinds do not leak state between calls', () => {
  const world = emptyWorld();
  const { pathfind } = makePathfinder(world);
  const a = pathfind(0, 0, 12, 0);
  const b = pathfind(0, 0, 12, 0);
  assert.equal(a.length, b.length);
  // Path with a different goal should be re-derived correctly. Manhattan
  // distance 12 → 12 path entries (start tile not included in path).
  const c = pathfind(0, 0, 0, 12);
  assert.equal(c.length, 12);
});
