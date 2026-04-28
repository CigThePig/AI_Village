import test from 'node:test';
import { strict as assert } from 'node:assert';

// Stub localStorage BEFORE importing save.js — the storage.js IIFE captures
// globalThis.localStorage at module-load time and gates Storage.set/get on it.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); }
};

const { createSaveSystem } = await import('../src/app/save.js');
const { GRID_W, GRID_H } = await import('../src/app/constants.js');

function makeWorld() {
  const n = GRID_W * GRID_H;
  return {
    seed: 1,
    season: 0,
    tSeason: 0,
    tiles: new Uint8Array(n),
    zone: new Uint8Array(n),
    trees: new Uint8Array(n),
    rocks: new Uint8Array(n),
    berries: new Uint8Array(n),
    growth: new Uint16Array(n)
  };
}

function makeSystem({ initialTick = 0, initialDayTime = 0, villager } = {}) {
  let tick = initialTick;
  let dayTime = initialDayTime;
  const world = makeWorld();
  const buildings = [];
  const villagers = villager ? [villager] : [];
  const animals = [];
  const storageTotals = {};
  const storageReserved = {};

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
    generateWorldBase: () => {},
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
  return {
    sys,
    villagers,
    getTick: () => tick,
    getDayTime: () => dayTime,
    setTick: deps.setTick,
    setDayTime: deps.setDayTime
  };
}

test('save/load round-trips tick and dayTime', () => {
  mem.clear();
  const ctx = makeSystem({
    initialTick: 5000,
    initialDayTime: 2400,
    villager: {
      id: 'v1', x: 0, y: 0,
      hunger: 0.2, energy: 0.8, happy: 0.7,
      role: 'worker',
      nextPregnancyTick: 8000,
      restTimer: 123
    }
  });

  ctx.sys.saveGame();

  // Wipe live state to verify the load path is the source of truth.
  ctx.setTick(0);
  ctx.setDayTime(0);

  assert.equal(ctx.sys.loadGame(), true, 'loadGame should report success');
  assert.equal(ctx.getTick(), 5000, 'tick must be restored');
  assert.equal(ctx.getDayTime(), 2400, 'dayTime must be restored');
});

test('save/load round-trips per-villager nextPregnancyTick and restTimer', () => {
  mem.clear();
  const ctx = makeSystem({
    initialTick: 5000,
    initialDayTime: 2400,
    villager: {
      id: 'v1', x: 0, y: 0,
      hunger: 0.2, energy: 0.8, happy: 0.7,
      role: 'worker',
      nextPregnancyTick: 8000,
      restTimer: 123
    }
  });

  ctx.sys.saveGame();
  assert.equal(ctx.sys.loadGame(), true);

  const reloaded = ctx.villagers[0];
  assert.equal(reloaded.nextPregnancyTick, 8000, 'nextPregnancyTick must round-trip');
  assert.equal(reloaded.restTimer, 123, 'restTimer must round-trip');
});

test('loadGame defaults missing tick/dayTime/np/rt to zero (older save shape)', () => {
  mem.clear();
  const ctx = makeSystem({
    villager: {
      id: 'v1', x: 0, y: 0,
      hunger: 0.2, energy: 0.8, happy: 0.7,
      role: 'worker'
    }
  });

  // Persist a save, then strip the new fields to simulate a pre-Phase-1 record
  // that has been migrated forward to the current SAVE_VERSION.
  ctx.sys.saveGame();
  const raw = JSON.parse(globalThis.localStorage.getItem('aiv_px_v3_save'));
  delete raw.tick;
  delete raw.dayTime;
  if (Array.isArray(raw.villagers)) {
    for (const v of raw.villagers) {
      delete v.np;
      delete v.rt;
    }
  }
  globalThis.localStorage.setItem('aiv_px_v3_save', JSON.stringify(raw));

  ctx.setTick(9999);
  ctx.setDayTime(9999);
  assert.equal(ctx.sys.loadGame(), true);
  assert.equal(ctx.getTick(), 0);
  assert.equal(ctx.getDayTime(), 0);
  const reloaded = ctx.villagers[0];
  assert.equal(reloaded.nextPregnancyTick, 0);
  assert.equal(reloaded.restTimer, 0);
});
