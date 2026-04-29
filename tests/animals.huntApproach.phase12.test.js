import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// animals.js → canvas.js touches document/window. Provide stubs before the
// dynamic imports the same way the hunting/idleCascade tests do.
function ensureBrowserStubs() {
  if (!globalThis.document) {
    globalThis.document = {
      getElementById: () => ({
        getContext: () => ({ imageSmoothingEnabled: true }),
        getBoundingClientRect: () => ({ width: 800, height: 600 }),
        style: {}, width: 0, height: 0,
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

const { GRID_W, GRID_H, GRID_SIZE, HUNT_RANGE, TILES, WALKABLE } = await import('../src/app/constants.js');
const { createPathfinder } = await import('../src/app/pathfinding.js');
const { createAnimalsSystem } = await import('../src/app/animals.js');

function makeStubState() {
  return {
    world: {
      tiles: new Uint8Array(GRID_SIZE),
      trees: new Uint8Array(GRID_SIZE),
      rocks: new Uint8Array(GRID_SIZE),
      berries: new Uint8Array(GRID_SIZE),
      width: GRID_W,
      height: GRID_H,
    },
    units: { animals: [], villagers: [] },
    queue: { villagerLabels: [] },
    time: { tick: 0 },
  };
}

function makeSystem(state, blocked = new Set()) {
  const idx = (x, y) => (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H ? -1 : y * GRID_W + x);
  const tileOccupiedByBuilding = (x, y) => blocked.has(y * GRID_W + x);
  const pf = createPathfinder({
    idx,
    tileOccupiedByBuilding,
    getWorld: () => state.world,
    getTick: () => state.time.tick,
    perf: { log: false },
  });
  return createAnimalsSystem({
    state,
    pathfind: pf.pathfind,
    pathfindToRegion: pf.pathfindToRegion,
    tileOccupiedByBuilding,
    idx,
  });
}

test('B23: findHuntApproachPath returns a path whose endpoint is in range and walkable', () => {
  const state = makeStubState();
  const animal = { id: 'a1', type: 'deer', x: 30, y: 30 };
  state.units.animals.push(animal);
  const v = { id: 'v1', x: 10, y: 10 };
  const sys = makeSystem(state);
  const result = sys.findHuntApproachPath(v, animal, { range: HUNT_RANGE });
  assert.ok(result, 'expected an approach path');
  assert.ok(Array.isArray(result.path) && result.path.length > 0);
  const last = result.path[result.path.length - 1];
  const dx = (last.x | 0) - animal.x;
  const dy = (last.y | 0) - animal.y;
  const dist = Math.hypot(dx, dy);
  assert.ok(dist <= HUNT_RANGE + 0.01, `endpoint must be in HUNT_RANGE; got ${dist}`);
  // dest field should match the path endpoint coordinates.
  assert.equal(result.dest.x, last.x | 0);
  assert.equal(result.dest.y, last.y | 0);
});

test('B23: findHuntApproachPath returns null when animal is fully surrounded by buildings', () => {
  const state = makeStubState();
  const animal = { id: 'a1', type: 'deer', x: 30, y: 30 };
  const v = { id: 'v1', x: 10, y: 10 };
  // Box every in-range tile around the animal with buildings.
  const blocked = new Set();
  const r = Math.ceil(HUNT_RANGE) + 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const tx = animal.x + dx;
      const ty = animal.y + dy;
      const dist = Math.hypot(dx, dy);
      if (dist <= HUNT_RANGE) blocked.add(ty * GRID_W + tx);
    }
  }
  const sys = makeSystem(state, blocked);
  const result = sys.findHuntApproachPath(v, animal, { range: HUNT_RANGE });
  assert.equal(result, null);
});

test('B23: findHuntApproachPath skips water tiles', () => {
  const state = makeStubState();
  const animal = { id: 'a1', type: 'deer', x: 30, y: 30 };
  const v = { id: 'v1', x: 25, y: 25 };
  // Make every in-range tile water EXCEPT one walkable tile.
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const tx = animal.x + dx;
      const ty = animal.y + dy;
      if (Math.hypot(dx, dy) <= HUNT_RANGE) {
        state.world.tiles[ty * GRID_W + tx] = TILES.WATER;
      }
    }
  }
  // Carve one approach tile.
  state.world.tiles[animal.y * GRID_W + (animal.x - 3)] = TILES.GRASS;
  const sys = makeSystem(state);
  const result = sys.findHuntApproachPath(v, animal, { range: HUNT_RANGE });
  assert.ok(result, 'expected the single non-water tile to be reached');
  const last = result.path[result.path.length - 1];
  assert.equal(last.x | 0, animal.x - 3);
  assert.equal(last.y | 0, animal.y);
  assert.ok(WALKABLE.has(state.world.tiles[(last.y | 0) * GRID_W + (last.x | 0)]));
});

test('B23: returns null when v or animal is missing', () => {
  const state = makeStubState();
  const sys = makeSystem(state);
  assert.equal(sys.findHuntApproachPath(null, { x: 1, y: 1 }), null);
  assert.equal(sys.findHuntApproachPath({ x: 1, y: 1 }, null), null);
});
