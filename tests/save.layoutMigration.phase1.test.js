import test from 'node:test';
import { strict as assert } from 'node:assert';

// Phase 1 — settlement layout templates. Layout is a pure function of seed +
// terrain and is recomputed at world-gen time, so SAVE_VERSION bumps to 8
// without persisting any new fields. The migration entry for v7→v8 is a
// no-op; the loader's job is just to not crash on older saves and let
// generateWorldBase rebuild the layout from the restored seed.

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); }
};

const { createSaveSystem } = await import('../src/app/save.js');
const { GRID_W, GRID_H, SAVE_KEY, SAVE_VERSION, SAVE_MIGRATIONS, TILES } = await import('../src/app/constants.js');
const { buildLayout } = await import('../src/app/layout.js');

function makeWorld() {
  const n = GRID_W * GRID_H;
  return {
    seed: 1,
    season: 0,
    tSeason: 0,
    tiles: new Uint8Array(n).fill(TILES.GRASS),
    zone: new Uint8Array(n),
    trees: new Uint8Array(n),
    rocks: new Uint8Array(n),
    berries: new Uint8Array(n),
    growth: new Uint16Array(n),
    width: GRID_W,
    height: GRID_H,
    aux: {}
  };
}

function makeSystem() {
  let tick = 0;
  let dayTime = 0;
  const world = makeWorld();
  const buildings = [];
  const villagers = [];
  const animals = [];
  const storageTotals = {};
  const storageReserved = {};
  let regenCount = 0;

  const deps = {
    getWorld: () => world,
    getBuildings: () => buildings,
    getVillagers: () => villagers,
    getAnimals: () => animals,
    getStorageTotals: () => storageTotals,
    getStorageReserved: () => storageReserved,
    getTick: () => tick,
    getDayTime: () => dayTime,
    setTick: (v) => { tick = Number.isFinite(v) ? v | 0 : 0; },
    setDayTime: (v) => { dayTime = Number.isFinite(v) ? v | 0 : 0; },
    starveThresh: { hungry: 0.4, starving: 0.8, sick: 1.18 },
    childhoodTicks: 1000,
    ensureVillagerNumber: (v, num) => {
      if (Number.isFinite(num)) v.num = num;
      else if (!Number.isFinite(v.num)) v.num = 1;
      return v.num;
    },
    normalizeExperienceLedger: (xp) => xp || null,
    normalizeArraySource: (src) => {
      if (!src) return [];
      if (Array.isArray(src)) return src;
      if (typeof src.length === 'number') return Array.from(src);
      return [];
    },
    applyArrayScaled: (dest, src, _factor, fill) => {
      if (!dest || typeof dest.length !== 'number') return;
      const fillVal = Number.isFinite(fill) ? fill : 0;
      for (let i = 0; i < dest.length; i++) {
        dest[i] = i < src.length ? src[i] : fillVal;
      }
    },
    generateWorldBase: (seed) => {
      regenCount++;
      // Mirror the production wiring: stamp a layout on the live world after
      // terrain is restored, so loadGame leaves world.layout populated.
      world.seed = Number.isFinite(seed) ? seed : world.seed;
      world.layout = buildLayout(world.seed, world);
    },
    resetVolatileState: () => {},
    syncTimeButtons: () => {},
    getFootprint: () => ({ w: 1, h: 1 }),
    ensureBuildingData: () => {},
    reindexAllBuildings: () => {},
    markEmittersDirty: () => {},
    refreshWaterRowMaskFromTiles: () => {},
    refreshZoneRowMask: () => {},
    markZoneOverlayDirty: () => {},
    markStaticDirty: () => {},
    toast: { show: () => {} }
  };

  const sys = createSaveSystem(deps);
  return { sys, world, getRegenCount: () => regenCount };
}

test('Phase 1: SAVE_VERSION is 8 and the v7 migration is a no-op', () => {
  assert.equal(SAVE_VERSION, 8);
  const m = SAVE_MIGRATIONS.get(7);
  assert.equal(typeof m, 'function');
  const probe = { saveVersion: 7, seed: 5 };
  const out = m(probe);
  assert.deepEqual(out, probe, 'v7→v8 migration must not mutate the save object');
});

test('Phase 1: loadGame applies migrations from older versions without crashing', () => {
  mem.clear();
  // Hand-craft a v6 save (post-Phase-8). Migrations 6→7 and 7→8 are both
  // no-ops, so loadGame should walk them, regenerate the world (and its
  // layout), and report success.
  const fakeV6 = {
    saveVersion: 6,
    seed: 4242,
    tick: 0,
    dayTime: 0,
    tiles: Array.from(new Uint8Array(GRID_W * GRID_H).fill(TILES.GRASS)),
    zone: Array.from(new Uint8Array(GRID_W * GRID_H)),
    trees: Array.from(new Uint8Array(GRID_W * GRID_H)),
    rocks: Array.from(new Uint8Array(GRID_W * GRID_H)),
    berries: Array.from(new Uint8Array(GRID_W * GRID_H)),
    growth: Array.from(new Uint8Array(GRID_W * GRID_H)),
    season: 0,
    tSeason: 0,
    buildings: [],
    storageTotals: { food: 12, wood: 0, stone: 0, bow: 0, pelt: 0 },
    storageReserved: {},
    villagers: [],
    animals: []
  };
  globalThis.localStorage.setItem(SAVE_KEY, JSON.stringify(fakeV6));

  const ctx = makeSystem();
  const ok = ctx.sys.loadGame();
  assert.equal(ok, true, 'loadGame must return true on a migratable older save');
  assert.equal(ctx.getRegenCount(), 1, 'generateWorldBase must run exactly once on load');
  assert.ok(ctx.world.layout, 'world.layout must be populated after load');
  assert.ok(ctx.world.layout.archetype, 'layout.archetype must be set');
});

test('Phase 1: a v8 save round-trips with a freshly-rebuilt layout matching the seed', () => {
  mem.clear();
  const ctx1 = makeSystem();
  // Seed the world directly so the save reflects a known archetype.
  ctx1.world.seed = 91234;
  ctx1.world.layout = buildLayout(91234, ctx1.world);
  const archetypeBefore = ctx1.world.layout.archetype;
  ctx1.sys.saveGame();

  const ctx2 = makeSystem();
  const ok = ctx2.sys.loadGame();
  assert.equal(ok, true, 'loadGame must succeed on a v8 save');
  assert.ok(ctx2.world.layout, 'layout must be rebuilt at load time');
  assert.equal(ctx2.world.layout.archetype, archetypeBefore,
    'rebuilt layout must select the same archetype for the same seed');
});
