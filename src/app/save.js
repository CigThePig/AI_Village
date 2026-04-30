import {
  ANIMAL_TYPES,
  COARSE_SAVE_SIZE,
  GRID_H,
  GRID_W,
  RESOURCE_TYPES,
  SAVE_KEY,
  SAVE_MIGRATIONS,
  SAVE_VERSION,
  ZONES
} from './constants.js';
import { Storage } from './storage.js';
import { clamp, irnd, uid } from './rng.js';

export function createSaveSystem(deps) {
  const {
    getWorld,
    getBuildings,
    getVillagers,
    getAnimals,
    getStorageTotals,
    getStorageReserved,
    getTick,
    getDayTime,
    setTick,
    setDayTime,
    starveThresh,
    childhoodTicks,
    ensureVillagerNumber,
    normalizeExperienceLedger,
    normalizeArraySource,
    applyArrayScaled,
    generateWorldBase,
    resetVolatileState,
    syncTimeButtons,
    getFootprint,
    ensureBuildingData,
    reindexAllBuildings,
    markEmittersDirty,
    refreshWaterRowMaskFromTiles,
    refreshZoneRowMask,
    markZoneOverlayDirty,
    markStaticDirty,
    toast
  } = deps;

  function saveGame() {
    const world = getWorld();
    const buildings = getBuildings();
    const villagers = getVillagers();
    const animals = getAnimals();
    const storageTotals = getStorageTotals();
    const storageReserved = getStorageReserved();
    const data = {
      saveVersion: SAVE_VERSION,
      seed: world.seed,
      tick: getTick() | 0,
      dayTime: typeof getDayTime === 'function' ? (getDayTime() | 0) : 0,
      tiles: Array.from(world.tiles),
      zone: Array.from(world.zone),
      trees: Array.from(world.trees),
      rocks: Array.from(world.rocks),
      berries: Array.from(world.berries),
      growth: Array.from(world.growth),
      season: world.season,
      tSeason: world.tSeason,
      // Phase 2: rectangular farm plots persisted alongside the FARM zone
      // bitmap. Strip the lazy _byTile cache; render rebuilds it on demand.
      farmPlots: Array.isArray(world.farmPlots)
        ? world.farmPlots.map((p) => ({
            id: p.id,
            slotId: p.slotId,
            x: p.x, y: p.y, w: p.w, h: p.h,
            orientation: p.orientation,
            abutsWells: !!p.abutsWells,
            abutsNeighbor: !!p.abutsNeighbor
          }))
        : [],
      buildings,
      storageTotals,
      storageReserved,
      villagers: villagers.map(v => ({
        id: v.id, x: v.x, y: v.y, h: v.hunger, e: v.energy, ha: v.happy,
        hy: v.hydration || 0, hb: v.hydrationBuffTicks || 0,
        nhy: v.nextHydrateTick || 0, hs: v.socialTimer || 0,
        nso: v.nextSocialTick || 0, role: v.role,
        cond: v.condition || 'normal', ss: v.starveStage || 0,
        ns: v.nextStarveWarning || 0, sk: v.sickTimer || 0,
        rc: v.recoveryTimer || 0, fs: v.farmingSkill || 0,
        cs: v.constructionSkill || 0, age: v.ageTicks || 0,
        stage: v.lifeStage || 'adult', preg: v.pregnancyTimer || 0,
        ct: v.childhoodTimer || 0,
        par: Array.isArray(v.parents) ? v.parents : [],
        mate: v.pregnancyMateId || null,
        sit: v.storageIdleTimer || 0,
        nsi: v.nextStorageIdleTick || 0,
        np: v.nextPregnancyTick || 0,
        rt: v.restTimer || 0,
        rsn: v.restStartedAtNight ? 1 : 0,
        ab: v.activeBuildingId || null,
        bw: v.equippedBow ? 1 : 0,
        num: ensureVillagerNumber(v),
        xp: normalizeExperienceLedger(v.experience)
      })),
      animals: animals.map(a => ({
        id: a.id, type: a.type, x: a.x, y: a.y,
        dir: a.dir || 'right', state: a.state || 'idle',
        na: a.nextActionTick || 0, phase: a.idlePhase || 0,
        nv: a.nextVillageTick || 0, ng: a.nextGrazeTick || 0,
        flee: a.fleeTicks || 0
      }))
    };
    Storage.set(SAVE_KEY, JSON.stringify(data));
  }

  function loadGame() {
    try {
      const raw = Storage.get(SAVE_KEY);
      if (!raw) return false;
      let d = JSON.parse(raw);
      const version = typeof d.saveVersion === 'number' ? d.saveVersion | 0 : 0;
      for (let v = version; v < SAVE_VERSION; v++) {
        const migrate = SAVE_MIGRATIONS.get(v);
        if (typeof migrate === 'function') {
          try { d = migrate(d) || d; }
          catch (err) { console.warn('AIV loadGame: migration from v' + v + ' failed', err); return false; }
        }
      }

      // Restore tick/dayTime before anything reads getTick() (e.g. animal
      // nextActionTick defaulting below). Old saves without these fields
      // load with tick = 0, dayTime = 0.
      const savedTick = Number.isFinite(d.tick) ? d.tick | 0 : 0;
      const savedDayTime = Number.isFinite(d.dayTime) ? d.dayTime | 0 : 0;
      if (typeof setTick === 'function') setTick(savedTick);
      if (typeof setDayTime === 'function') setDayTime(savedDayTime);

      const tileData = normalizeArraySource(d.tiles);
      const zoneData = normalizeArraySource(d.zone);
      const treeData = normalizeArraySource(d.trees);
      const rockData = normalizeArraySource(d.rocks);
      const berryData = normalizeArraySource(d.berries);
      const growthData = normalizeArraySource(d.growth);
      const coarseLen = COARSE_SAVE_SIZE * COARSE_SAVE_SIZE;
      const fullLen = GRID_W * GRID_H;
      const isCoarseSave = version < SAVE_VERSION && tileData.length === coarseLen;
      const factorCandidate = isCoarseSave ? Math.floor(GRID_W / COARSE_SAVE_SIZE) : 1;
      const factorY = isCoarseSave ? Math.floor(GRID_H / COARSE_SAVE_SIZE) : 1;
      const upscaleFactor = (factorCandidate > 1 && factorCandidate === factorY) ? factorCandidate : 1;
      const expectedLen = upscaleFactor > 1 ? coarseLen : fullLen;
      const layerSources = [
        ['tiles', tileData],
        ['zone', zoneData],
        ['trees', treeData],
        ['rocks', rockData],
        ['berries', berryData],
        ['growth', growthData]
      ];
      for (const [name, arr] of layerSources) {
        if (arr.length !== 0 && arr.length !== expectedLen) {
          console.warn('AIV loadGame: ' + name + ' layer length ' + arr.length + ' does not match expected ' + expectedLen + ' (upscaleFactor=' + upscaleFactor + ')');
        }
      }
      // audit #21: clear volatile state and rebuild base terrain only.
      // Avoid newWorld() so we don't spawn transient villagers/animals
      // that the load path immediately discards (and silences the
      // misleading "New pixel map created." toasts — audit #20).
      if (typeof resetVolatileState === 'function') resetVolatileState();
      generateWorldBase(Number.isFinite(d.seed) ? d.seed : undefined);
      const world = getWorld();
      const buildings = getBuildings();
      const villagers = getVillagers();
      const animals = getAnimals();
      const storageTotals = getStorageTotals();
      const storageReserved = getStorageReserved();
      applyArrayScaled(world.tiles, tileData, upscaleFactor, 0);
      applyArrayScaled(world.zone, zoneData, upscaleFactor, ZONES.NONE);
      applyArrayScaled(world.trees, treeData, upscaleFactor, 0);
      applyArrayScaled(world.rocks, rockData, upscaleFactor, 0);
      applyArrayScaled(world.berries, berryData, upscaleFactor, 0);
      applyArrayScaled(world.growth, growthData, upscaleFactor, 0);
      if (typeof d.season === 'number') world.season = d.season;
      if (typeof d.tSeason === 'number') world.tSeason = d.tSeason;
      // Phase 2: restore rectangular farm plots. Drop entries that fall
      // outside the regenerated grid (defensive — should not happen, but
      // keeps the byTile cache safe). _byTile is rebuilt on first lookup.
      const restoredPlots = Array.isArray(d.farmPlots) ? d.farmPlots : [];
      world.farmPlots = [];
      for (const src of restoredPlots) {
        if (!src || !Number.isFinite(src.x) || !Number.isFinite(src.y)) continue;
        if (!Number.isFinite(src.w) || !Number.isFinite(src.h)) continue;
        if (src.x < 0 || src.y < 0 || src.x + src.w > GRID_W || src.y + src.h > GRID_H) continue;
        world.farmPlots.push({
          id: typeof src.id === 'string' ? src.id : 'plot-' + world.farmPlots.length,
          slotId: typeof src.slotId === 'string' ? src.slotId : null,
          x: src.x | 0, y: src.y | 0,
          w: src.w | 0, h: src.h | 0,
          orientation: src.orientation === 'vertical' ? 'vertical' : 'horizontal',
          abutsWells: !!src.abutsWells,
          abutsNeighbor: !!src.abutsNeighbor
        });
      }
      world.farmPlots._byTile = null;
      refreshWaterRowMaskFromTiles();
      refreshZoneRowMask();
      markZoneOverlayDirty();
      buildings.length = 0;
      const buildingScale = upscaleFactor > 1 ? upscaleFactor : 1;
      (d.buildings || []).forEach(src => {
        if (!src) return;
        const b = { ...src };
        if (buildingScale > 1) {
          const fp = getFootprint(b.kind);
          const maxX = Math.max(0, GRID_W - (fp?.w || 1));
          const maxY = Math.max(0, GRID_H - (fp?.h || 1));
          const scaledX = Math.round((typeof b.x === 'number' ? b.x : 0) * buildingScale);
          const scaledY = Math.round((typeof b.y === 'number' ? b.y : 0) * buildingScale);
          b.x = clamp(scaledX, 0, maxX);
          b.y = clamp(scaledY, 0, maxY);
        }
        ensureBuildingData(b);
        buildings.push(b);
      });
      reindexAllBuildings();
      markEmittersDirty();
      const savedTotals = d.storageTotals || {};
      const savedReserved = d.storageReserved || {};
      for (const r of RESOURCE_TYPES) {
        storageTotals[r] = Number.isFinite(savedTotals[r]) ? savedTotals[r] : 0;
        storageReserved[r] = Number.isFinite(savedReserved[r]) ? savedReserved[r] : 0;
      }
      villagers.length = 0;
      const tickNow = getTick();
      (d.villagers || []).forEach(v => {
        if (!v) return;
        const stage = typeof v.ss === 'number'
          ? v.ss
          : (v.h > starveThresh.sick ? 3 : v.h > starveThresh.starving ? 2 : v.h > starveThresh.hungry ? 1 : 0);
        const cond = v.cond || (stage >= 3 ? 'sick' : stage === 2 ? 'starving' : stage === 1 ? 'hungry' : 'normal');
        let vx = typeof v.x === 'number' ? v.x : 0;
        let vy = typeof v.y === 'number' ? v.y : 0;
        if (buildingScale > 1) {
          vx = clamp(Math.round(vx * buildingScale), 0, GRID_W - 1);
          vy = clamp(Math.round(vy * buildingScale), 0, GRID_H - 1);
        }
        const farmingSkill = Number.isFinite(v.fs) ? clamp(v.fs, 0, 1) : (v.role === 'farmer' ? 0.7 : 0.5);
        const constructionSkill = Number.isFinite(v.cs) ? clamp(v.cs, 0, 1) : (v.role === 'worker' ? 0.65 : 0.5);
        const lifeStage = v.stage === 'child' ? 'child' : 'adult';
        const childhoodTimer = Number.isFinite(v.ct) ? v.ct : (lifeStage === 'child' ? childhoodTicks : 0);
        const experience = normalizeExperienceLedger(v.xp || v.experience);
        const villagerRecord = {
          id: v.id, x: vx, y: vy, path: [],
          hunger: v.h, energy: v.e, happy: v.ha,
          hydration: Number.isFinite(v.hy) ? clamp(v.hy, 0, 1) : 0.7,
          hydrationBuffTicks: Number.isFinite(v.hb) ? v.hb : 0,
          nextHydrateTick: Number.isFinite(v.nhy) ? v.nhy : 0,
          role: lifeStage === 'child' ? 'child' : v.role,
          speed: 2, inv: null, state: 'idle', thought: 'Resuming',
          _nextPathTick: 0,
          _wanderFailures: new Map(), _forageFailures: new Map(),
          condition: cond, starveStage: stage,
          nextStarveWarning: v.ns || 0, sickTimer: v.sk || 0,
          recoveryTimer: v.rc || 0, farmingSkill, constructionSkill,
          ageTicks: Number.isFinite(v.age) ? v.age : 0,
          lifeStage, pregnancyTimer: Number.isFinite(v.preg) ? v.preg : 0,
          pregnancyMateId: v.mate || null, childhoodTimer,
          parents: Array.isArray(v.par) ? v.par.slice(0, 2) : [],
          socialTimer: Number.isFinite(v.hs) ? v.hs : 0,
          nextSocialTick: Number.isFinite(v.nso) ? v.nso : 0,
          storageIdleTimer: Number.isFinite(v.sit) ? v.sit : 0,
          nextStorageIdleTick: Number.isFinite(v.nsi) ? v.nsi : 0,
          nextPregnancyTick: Number.isFinite(v.np) ? v.np : 0,
          restTimer: Number.isFinite(v.rt) ? v.rt : 0,
          restStartedAtNight: v.rsn === 1 || v.rsn === true,
          hydrationTimer: 0,
          activeBuildingId: v.ab || null,
          equippedBow: v.bw === 1 || v.bw === true,
          experience
        };
        ensureVillagerNumber(villagerRecord, v.num);
        villagers.push(villagerRecord);
      });
      const animalScale = upscaleFactor > 1 ? upscaleFactor : 1;
      animals.length = 0;
      (d.animals || []).forEach(a => {
        if (!a || !ANIMAL_TYPES[a.type]) return;
        let ax = typeof a.x === 'number' ? a.x : 0;
        let ay = typeof a.y === 'number' ? a.y : 0;
        if (animalScale > 1) {
          ax = clamp(Math.round(ax * animalScale), 0, GRID_W - 1);
          ay = clamp(Math.round(ay * animalScale), 0, GRID_H - 1);
        }
        const state = typeof a.state === 'string' ? a.state : 'idle';
        const nextActionTick = Number.isFinite(a.na) ? a.na : tickNow + irnd(12, 60);
        const idlePhase = Number.isFinite(a.phase) ? a.phase : irnd(0, 900);
        const nextVillageTick = Number.isFinite(a.nv) ? a.nv : 0;
        const nextGrazeTick = Number.isFinite(a.ng) ? a.ng : 0;
        const fleeTicks = Number.isFinite(a.flee) ? a.flee : 0;
        animals.push({
          id: a.id || uid(), type: a.type, x: ax, y: ay,
          dir: a.dir === 'left' ? 'left' : 'right',
          state, nextActionTick, idlePhase,
          nextVillageTick, nextGrazeTick, fleeTicks
        });
      });
      if (toast && typeof toast.show === 'function') toast.show('Loaded.');
      markStaticDirty();
      // audit #19: refresh pause/speed UI so loaded state is visible.
      if (typeof syncTimeButtons === 'function') syncTimeButtons();
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  return { saveGame, loadGame };
}
