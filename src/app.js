import { createInitialState } from './state.js';
import { policy } from './policy/policy.js';
import { computeBlackboard } from './ai/blackboard.js';
import { score as scoreJob, computeFamineSeverity } from './ai/scoring.js';
import {
  ANIMAL_BEHAVIORS,
  ANIMAL_TYPES,
  CRAFTING_RECIPES,
  DAY_LENGTH,
  DIR4,
  ENTITY_TILE_PX,
  GRID_H,
  GRID_SIZE,
  GRID_W,
  HUNT_RANGE,
  HUNT_RETRY_COOLDOWN,
  ITEM,
  LAYER_ORDER,
  SHADOW_DIRECTION,
  SHADOW_DIRECTION_ANGLE,
  SPEEDS,
  TILE,
  TILES,
  TREE_VERTICAL_RAISE,
  WALKABLE,
  ZONES,
  baseIdx,
  tileToPxX,
  tileToPxY
} from './app/constants.js';
import { AIV_SCOPE, SHADING_DEFAULTS, WORLDGEN_DEFAULTS, generateTerrain, makeHillshade } from './app/environment.js';
import { LIGHTING, clamp01, makeAltitudeShade, registerShadingHandlers, setShadingMode, setShadingParams } from './app/lighting.js';
import { Storage, reportFatal, setUpdateCallback } from './app/storage.js';
import { H, W, cam, clampCam, context2d, ctx } from './app/canvas.js';
import { R, clamp, irnd, mulberry32, rnd, setRandomSource, uid } from './app/rng.js';
import { Tileset, SHADOW_TEXTURE, buildTileset, makeCanvas } from './app/tileset.js';
import { createPathfinder } from './app/pathfinding.js';
import { createSaveSystem } from './app/save.js';
import { createUISystem } from './app/ui.js';
import { createRenderSystem } from './app/render.js';
import { createPlanner } from './app/planner.js';
import { createTickRunner } from './app/tick.js';
import {
  BUILDINGS,
  CAMPFIRE_EFFECT_RADIUS,
  agricultureBonusesAt as _agricultureBonusesAt,
  buildingAtIn,
  buildingCenter,
  buildingEntryTiles,
  buildingResourceNeed,
  buildingSupplyStatus,
  distanceToFootprint,
  ensureBuildingData,
  getFootprint,
  tileOccupiedByBuildingIn,
  validateFootprintPlacementIn
} from './app/world.js';
import {
  DAWN_AMBIENT_THRESHOLD,
  addJobExperience,
  applySkillGain,
  createExperienceLedger,
  createTimeOfDay,
  effectiveSkillFromExperience,
  isDawnAmbient,
  isNightAmbient,
  moodMotivation,
  moodThought,
  normalizeExperienceLedger
} from './app/simulation.js';

if (import.meta.env?.DEV) {
  console.log("AIV Phase1 perf build"); // shows up so we know this file ran
}
const PERF = { log:false }; // flip to true to log basic timings

let waterRowMask = new Uint8Array(GRID_H);
let zoneRowMask = new Uint8Array(GRID_H);
const zoneOverlayCache = {
  canvas: null,
  ctx: null,
  dirty: true,
  lastScale: null,
  lastActiveSignature: null
};
const waterOverlayCache = {
  canvas: null,
  ctx: null,
  frameIndex: -1,
  camX: null,
  camY: null,
  camZ: null,
  width: 0,
  height: 0
};

function ensureRowMasksSize(){
  if(waterRowMask.length !== GRID_H) waterRowMask = new Uint8Array(GRID_H);
  if(zoneRowMask.length !== GRID_H) zoneRowMask = new Uint8Array(GRID_H);
}

function markZoneOverlayDirty(){
  zoneOverlayCache.dirty = true;
}

function refreshWaterRowMaskFromTiles(){
  ensureRowMasksSize();
  waterRowMask.fill(0);
  for(let y=0; y<GRID_H; y++){
    const rowStart = y*GRID_W;
    for(let x=0; x<GRID_W; x++){
      if(world.tiles[rowStart+x] === TILES.WATER){
        waterRowMask[y] = 1;
        break;
      }
    }
  }
}

function refreshZoneRowMask(){
  ensureRowMasksSize();
  zoneRowMask.fill(0);
  for(let y=0; y<GRID_H; y++){
    const rowStart = y*GRID_W;
    for(let x=0; x<GRID_W; x++){
      if(world.zone[rowStart+x] !== ZONES.NONE){
        zoneRowMask[y] = 1;
        break;
      }
    }
  }
  markZoneOverlayDirty();
}

function updateZoneRow(y){
  ensureRowMasksSize();
  if(y<0 || y>=GRID_H) return;
  const rowStart = y*GRID_W;
  let hasZone = 0;
  for(let x=0; x<GRID_W; x++){
    if(world.zone[rowStart+x] !== ZONES.NONE){
      hasZone = 1;
      break;
    }
  }
  if (zoneRowMask[y] !== hasZone) markZoneOverlayDirty();
  zoneRowMask[y] = hasZone;
}

function normalizeArraySource(source){
  if(!source) return [];
  if(Array.isArray(source)) return source;
  if(ArrayBuffer.isView(source)) return Array.from(source);
  return [];
}

function applyArrayScaled(target, source, factor, fillValue=0){
  const data = normalizeArraySource(source);
  target.fill(fillValue);
  if(data.length === 0) return;
  if(!factor || factor <= 1){
    const len = Math.min(target.length, data.length);
    for(let i=0;i<len;i++){ target[i] = data[i]|0; }
    return;
  }
  const coarseWidth = Math.floor(GRID_W / factor);
  const coarseHeight = Math.floor(GRID_H / factor);
  if(coarseWidth <= 0 || coarseHeight <= 0){
    const len = Math.min(target.length, data.length);
    for(let i=0;i<len;i++){ target[i] = data[i]|0; }
    return;
  }
  for(let cy=0; cy<coarseHeight; cy++){
    const baseY = cy*factor;
    for(let cx=0; cx<coarseWidth; cx++){
      const coarseIdx = cy*coarseWidth + cx;
      if(coarseIdx >= data.length) break;
      const value = data[coarseIdx] !== undefined ? data[coarseIdx]|0 : fillValue;
      for(let oy=0; oy<factor; oy++){
        let dest = (baseY+oy)*GRID_W + cx*factor;
        for(let ox=0; ox<factor; ox++){
          target[dest+ox] = value;
        }
      }
    }
  }
}

/* ==================== World State ==================== */
const gameState = createInitialState({ seed: Date.now() | 0, cfg: null });
policy.attach(gameState);
gameState.policy = policy;
if (!gameState.bb) {
  gameState.bb = computeBlackboard(gameState, policy);
}
const { units, time, rng, stocks, queue } = gameState;
const buildings = units.buildings;
const villagers = units.villagers;
const jobs = units.jobs;
const itemsOnGround = units.itemsOnGround;
const animals = units.animals;
const buildingsByKind = new Map();
function indexBuilding(b){
  if(!b || !b.kind) return;
  let arr=buildingsByKind.get(b.kind);
  if(!arr){ arr=[]; buildingsByKind.set(b.kind, arr); }
  arr.push(b);
}
function reindexAllBuildings(){
  buildingsByKind.clear();
  for(const b of buildings) indexBuilding(b);
}
let emittersDirty = true;
function markEmittersDirty(){ emittersDirty = true; }
const activeZoneJobs = { sow: new Set(), chop: new Set(), mine: new Set() };
function clearActiveZoneJobs(){
  activeZoneJobs.sow.clear();
  activeZoneJobs.chop.clear();
  activeZoneJobs.mine.clear();
}
function noteJobAssignmentChanged(j){
  if(!j) return;
  const set = activeZoneJobs[j.type];
  if(!set) return;
  const key = j.y * GRID_W + j.x;
  if((j.assigned||0) > 0) set.add(key);
  else set.delete(key);
}
function noteJobRemoved(j){
  if(!j) return;
  const set = activeZoneJobs[j.type];
  if(!set) return;
  set.delete(j.y * GRID_W + j.x);
}
const nocturnalEntities = new Array(28).fill(null).map(() => ({
  active: false,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  radius: 0.45,
  alpha: 0,
  energy: 1,
  fade: 0,
  wanderTicks: 0
}));
let nocturnalSpawnCooldown = 0;
const pendingBirths = [];
const jobSuppression = new Map();
const itemTileIndex = new Map();
let itemTileIndexDirty = true;
const storageTotals = stocks.totals;
const storageReserved = stocks.reserved;
const villagerLabels = queue.villagerLabels;
let villagerNumberCounter = 1;
const DAY_LEN = DAY_LENGTH;

function ensureVillagerNumber(v, preferredNumber) {
  if (!v) return null;
  const candidate = Number.isFinite(preferredNumber)
    ? preferredNumber
    : (Number.isFinite(v.displayNumber) ? v.displayNumber : null);
  if (Number.isFinite(candidate)) {
    v.displayNumber = candidate;
    villagerNumberCounter = Math.max(villagerNumberCounter, candidate + 1);
    return v.displayNumber;
  }
  v.displayNumber = villagerNumberCounter++;
  return v.displayNumber;
}

function markItemsDirty() {
  itemTileIndexDirty = true;
}

function rebuildItemTileIndex() {
  if (!itemTileIndexDirty) return;
  itemTileIndex.clear();
  for (let i = itemsOnGround.length - 1; i >= 0; i--) {
    const it = itemsOnGround[i];
    if (!it) continue;
    const key = it.y * GRID_W + it.x;
    if (!itemTileIndex.has(key)) {
      itemTileIndex.set(key, i);
    }
  }
  itemTileIndexDirty = false;
}

function removeItemAtIndex(index) {
  itemsOnGround.splice(index, 1);
  markItemsDirty();
}

let world = gameState.world;
Object.defineProperty(gameState, 'world', {
  configurable: true,
  enumerable: true,
  get() {
    return world;
  },
  set(value) {
    world = value || null;
  }
});

let tick = Number.isFinite(time.tick) ? time.tick | 0 : 0;
let paused = time.paused === true;
let speedIdx = Number.isFinite(time.speedIdx) ? time.speedIdx | 0 : 1;
let dayTime = Number.isFinite(time.dayTime) ? time.dayTime | 0 : 0;
Object.defineProperties(time, {
  tick: {
    configurable: true,
    enumerable: true,
    get() {
      return tick;
    },
    set(value) {
      tick = Number.isFinite(value) ? value | 0 : 0;
    }
  },
  paused: {
    configurable: true,
    enumerable: true,
    get() {
      return paused;
    },
    set(value) {
      paused = value === true;
    }
  },
  speedIdx: {
    configurable: true,
    enumerable: true,
    get() {
      return speedIdx;
    },
    set(value) {
      speedIdx = Number.isFinite(value) ? value | 0 : 0;
    }
  },
  dayTime: {
    configurable: true,
    enumerable: true,
    get() {
      return dayTime;
    },
    set(value) {
      dayTime = Number.isFinite(value) ? value | 0 : 0;
    }
  }
});

// Cadence counters (lastBlackboardTick, lastZonePlanTick, lastBuildPlanTick,
// PLANNER_INTERVAL) live inside src/app/tick.js, which owns the simulation loop.
// Planner state (progressionMemory, jobNeedState) lives inside src/app/planner.js.

setRandomSource(typeof rng.generator === 'function' ? rng.generator : Math.random);
Object.defineProperty(rng, 'generator', {
  configurable: true,
  enumerable: true,
  get() {
    return R;
  },
  set(value) {
    if (typeof value === 'function') {
      setRandomSource(value);
    }
  }
});
rng.seed = Number.isFinite(rng.seed) ? rng.seed >>> 0 : (Date.now() | 0);

let debugKitInstance = null;
let debugKitWatcherInstalled = false;

function debugKitGetPipeline() {
  const pipe = world?.__debug?.pipeline;
  if (!Array.isArray(pipe) || pipe.length === 0) {
    return [];
  }
  return pipe.map((entry) => {
    if (!entry) return entry;
    return {
      name: entry.name || '',
      ok: entry.ok === true,
      extra: entry.extra === undefined ? null : entry.extra
    };
  });
}

function describeCanvasContext(ctx) {
  if (!ctx || !ctx.canvas) {
    return null;
  }
  const canvas = ctx.canvas;
  let type = 'unknown';
  if (typeof ctx.getContextAttributes === 'function') {
    type = 'webgl';
  } else if (typeof ctx.getImageData === 'function') {
    type = '2d';
  }
  return {
    type,
    size: {
      width: Number.isFinite(canvas.width) ? canvas.width : null,
      height: Number.isFinite(canvas.height) ? canvas.height : null
    }
  };
}

function debugKitGetLightingProbe() {
  const mode = LIGHTING?.mode ?? 'unknown';
  const useMultiply = LIGHTING?.useMultiplyComposite === true;
  const scale = Number.isFinite(LIGHTING?.lightmapScale) ? LIGHTING.lightmapScale : null;
  const hillshadeQ = world?.hillshadeQ || null;
  const lightmapQ = world?.lightmapQ || null;
  const statsFn = (debugKitInstance && typeof debugKitInstance.arrMinMax === 'function')
    ? debugKitInstance.arrMinMax
    : null;
  const hillshadeStats = statsFn && hillshadeQ ? statsFn(hillshadeQ) : null;
  const lightmapStats = statsFn && lightmapQ ? statsFn(lightmapQ) : null;
  const reasons = [];
  let canMultiply = useMultiply;

  if (!world) {
    reasons.push('World not initialized');
    canMultiply = false;
  } else {
    if (mode === 'off') {
      reasons.push('Lighting mode set to off');
      canMultiply = false;
    }
    if (!world.lightmapCtx) {
      reasons.push('lightmapCtx missing');
      canMultiply = false;
    }
    if (!lightmapQ) {
      reasons.push('lightmapQ not built');
      canMultiply = false;
    }
  }

  return {
    mode,
    useMultiplyComposite: useMultiply,
    lightmapScale: scale,
    contexts: {
      lightmap: describeCanvasContext(world?.lightmapCtx || null),
      albedo: describeCanvasContext(world?.staticAlbedoCtx || null)
    },
    hillshadeQ,
    lightmapQ,
    HqMin: hillshadeStats ? hillshadeStats.min : null,
    HqMax: hillshadeStats ? hillshadeStats.max : null,
    LqMin: lightmapStats ? lightmapStats.min : null,
    LqMax: lightmapStats ? lightmapStats.max : null,
    canMultiply,
    reasons
  };
}

function debugKitEnterSafeMode() {
  try {
    if (typeof applyShadingMode === 'function') {
      applyShadingMode('off');
    } else if (LIGHTING) {
      LIGHTING.mode = 'off';
      LIGHTING.useMultiplyComposite = false;
    }
    if (world) {
      world.lightmapQ = null;
      if (world.lightmapCtx && world.lightmapCanvas) {
        try {
          world.lightmapCtx.clearRect(0, 0, world.lightmapCanvas.width, world.lightmapCanvas.height);
        } catch (err) {
          /* ignore */
        }
      }
      if (typeof markStaticDirty === 'function') {
        markStaticDirty();
      }
    }
  } catch (err) {
    console.warn('DebugKit safe mode failed', err);
  }
}

function debugKitGetState() {
  const villagerCount = Array.isArray(villagers) ? villagers.length : 0;
  let snapshotTime = null;
  if (world?.clock && Number.isFinite(world.clock.timeOfDay)) {
    snapshotTime = world.clock.timeOfDay;
  } else if (Number.isFinite(dayTime)) {
    snapshotTime = dayTime;
  }
  const villagerDetails = Array.isArray(villagers)
    ? villagers.map((v) => ({
        id: v.id,
        number: ensureVillagerNumber(v),
        role: v.role,
        lifeStage: v.lifeStage,
        state: v.state,
        thought: v.thought,
        condition: v.condition,
        hunger: clamp(Number.isFinite(v.hunger) ? v.hunger : 0, 0, 1),
        energy: clamp(Number.isFinite(v.energy) ? v.energy : 0, 0, 1),
        hydration: clamp(Number.isFinite(v.hydration) ? v.hydration : 0, 0, 1),
        happy: clamp(Number.isFinite(v.happy) ? v.happy : 0, 0, 1),
        position: { x: v.x, y: v.y },
        targetJob: v.targetJob
          ? { type: v.targetJob.type, x: v.targetJob.x, y: v.targetJob.y, bid: v.targetJob.bid ?? null }
          : null,
        carrying: v.inv ? { type: v.inv.type, qty: v.inv.qty ?? 1 } : null,
        activeBuildingId: v.activeBuildingId ?? null
      }))
    : [];
  return {
    frame: world?.__debug?.lastFrame ?? 0,
    timeOfDay: snapshotTime,
    villagers: villagerCount,
    lightingMode: LIGHTING?.mode ?? 'unknown',
    multiplyComposite: LIGHTING?.useMultiplyComposite === true,
    villagerDetails
  };
}

function configureDebugKitBridge(instance) {
  if (!instance || typeof instance.configure !== 'function') {
    return;
  }
  debugKitInstance = instance;
  try {
    instance.configure({
      getPipeline: debugKitGetPipeline,
      getLightingProbe: debugKitGetLightingProbe,
      onSafeMode: debugKitEnterSafeMode,
      getState: debugKitGetState
    });
  } catch (err) {
    console.warn('DebugKit configure failed', err);
  }
}

function installDebugKitWatcher() {
  if (debugKitWatcherInstalled || typeof window === 'undefined') {
    return;
  }
  debugKitWatcherInstalled = true;
  let currentKit = window.DebugKit;
  const descriptor = Object.getOwnPropertyDescriptor(window, 'DebugKit');
  const canRedefine = !descriptor || descriptor.configurable === true;
  if (canRedefine) {
    Object.defineProperty(window, 'DebugKit', {
      configurable: true,
      enumerable: true,
      get() {
        return currentKit;
      },
      set(value) {
        currentKit = value;
        if (value && typeof value.configure === 'function') {
          configureDebugKitBridge(value);
        }
      }
    });
  }
  if (currentKit && typeof currentKit.configure === 'function') {
    configureDebugKitBridge(currentKit);
  }
}

function ensureDebugKitConfigured() {
  if (debugKitInstance) {
    configureDebugKitBridge(debugKitInstance);
  } else if (typeof window !== 'undefined' && window.DebugKit != null) {
    configureDebugKitBridge(window.DebugKit);
  }
}

if (typeof window !== 'undefined') {
  installDebugKitWatcher();
  if (window.DebugKit != null) {
    configureDebugKitBridge(window.DebugKit);
  }
  const prevReady = typeof window.__AIV_DEBUGKIT_READY__ === 'function'
    ? window.__AIV_DEBUGKIT_READY__
    : null;
  window.__AIV_DEBUGKIT_READY__ = function (kit) {
    try {
      configureDebugKitBridge(kit);
    } finally {
      if (prevReady && prevReady !== window.__AIV_DEBUGKIT_READY__) {
        try { prevReady(kit); } catch (err) { console.warn('DebugKit ready hook failed', err); }
      }
    }
  };
}

const _timeOfDay = createTimeOfDay({
  getTick: () => tick,
  getDayTime: () => dayTime,
  dayLen: DAY_LEN
});
const ambientAt = _timeOfDay.ambientAt;
const isNightTime = _timeOfDay.isNightTime;

function normalizeShadingMode(mode) {
  if (mode === 'off' || mode === 'altitude') return mode;
  return 'hillshade';
}

function computeShadeForMode(mode, height) {
  const nextMode = normalizeShadingMode(mode);
  if (!height || height.length !== GRID_SIZE) return null;
  if (nextMode === 'off') return null;
  if (nextMode === 'altitude') {
    return makeAltitudeShade(height, GRID_W, GRID_H, SHADING_DEFAULTS);
  }
  return makeHillshade(height, GRID_W, GRID_H, SHADING_DEFAULTS);
}

function applyShadingMode(mode) {
  const nextMode = normalizeShadingMode(mode);
  SHADING_DEFAULTS.mode = nextMode;
  LIGHTING.mode = nextMode;
  resetLightmapCache();
  if (!world || !world.aux || !world.aux.height) return;
  world.hillshade = computeShadeForMode(nextMode, world.aux.height);
  if (nextMode === 'off') {
    world.hillshadeQ = null;
    world.lightmapQ = null;
    world.lightmapCanvas = null;
    world.lightmapCtx = null;
    world.lightmapImageData = null;
  } else {
    buildHillshadeQ(world);
  }
  markStaticDirty();
}

function applyShadingParams({ ambient, intensity, slopeScale } = {}) {
  if (typeof ambient === 'number' && Number.isFinite(ambient)) {
    SHADING_DEFAULTS.ambient = clamp(ambient, 0, 1);
  }
  if (typeof intensity === 'number' && Number.isFinite(intensity)) {
    SHADING_DEFAULTS.intensity = clamp(intensity, 0, 1);
  }
  if (typeof slopeScale === 'number' && Number.isFinite(slopeScale)) {
    SHADING_DEFAULTS.slopeScale = clamp(slopeScale, 0.1, 16);
  }
  if (!world || !world.aux || !world.aux.height) return;
  if (SHADING_DEFAULTS.mode === 'off') return;
  applyShadingMode(SHADING_DEFAULTS.mode);
}

registerShadingHandlers({ setMode: applyShadingMode, setParams: applyShadingParams });

function desiredAnimalsForType(type){
  const def = ANIMAL_TYPES[type];
  if(!def) return 0;
  const density = typeof def.density === 'number' ? def.density : 0;
  const baseCount = Math.round(GRID_SIZE * density);
  const minCount = def.minCount || 0;
  return Math.max(minCount, baseCount);
}

function isAnimalTileAllowed(tile, def, allowFallback){
  const preferred = Array.isArray(def?.preferred) ? def.preferred : [];
  const fallback = Array.isArray(def?.fallback) ? def.fallback : preferred;
  const allowedSet = allowFallback ? (fallback.length ? fallback : preferred) : preferred;
  if(allowedSet.length === 0){
    return WALKABLE.has(tile);
  }
  return allowedSet.includes(tile);
}

function spawnAnimalsForWorld(){
  animals.length = 0;
  const occupied = new Set();

  const tileFree = (x,y)=>{
    if(x<0||y<0||x>=GRID_W||y>=GRID_H) return false;
    const idx = y*GRID_W + x;
    if(occupied.has(idx)) return false;
    if(tileOccupiedByBuilding(x,y)) return false;
    const tile = world.tiles[idx];
    if(tile === TILES.WATER) return false;
    if(world.trees[idx]>0 || world.rocks[idx]>0) return false;
    return WALKABLE.has(tile);
  };

  for(const [type, def] of Object.entries(ANIMAL_TYPES)){
    const target = desiredAnimalsForType(type);
    if(target <= 0) continue;
    let placed = 0;
    let attempts = 0;
    const maxAttempts = Math.max(target * 180, target * 24);
    while(placed < target && attempts < maxAttempts){
      attempts++;
      const x = irnd(0, GRID_W-1);
      const y = irnd(0, GRID_H-1);
      if(!tileFree(x,y)) continue;
      const idx = y*GRID_W + x;
      const tile = world.tiles[idx];
      const allowFallback = attempts > target * 60;
      if(!isAnimalTileAllowed(tile, def, allowFallback)) continue;
      animals.push({ id: uid(), type, x, y, dir: R() < 0.5 ? 'left' : 'right' });
      occupied.add(idx);
      placed++;
    }
  }
}

const DEFAULT_ANIMAL_BEHAVIOR = {
  roamRadius: 2,
  idleTicks: [20, 60],
  roamTicks: [40, 90],
  speed: 0.12,
  fleeSpeed: 0.16,
  grazeChance: 0.1,
  grazeRadius: 1,
  fearRadius: 3,
  fleeDistance: 3,
  observeMood: 0.003,
  idleBob: 1
};

function behaviorForAnimal(a){
  return ANIMAL_BEHAVIORS[a.type] || DEFAULT_ANIMAL_BEHAVIOR;
}

function ensureAnimalDefaults(a){
  if(!a.state) a.state='idle';
  if(!Number.isFinite(a.nextActionTick)) a.nextActionTick=tick+irnd(12,48);
  if(!Number.isFinite(a.idlePhase)) a.idlePhase=irnd(0,900);
  if(!Number.isFinite(a.nextVillageTick)) a.nextVillageTick=0;
  if(!Number.isFinite(a.nextGrazeTick)) a.nextGrazeTick=0;
  if(!Number.isFinite(a.fleeTicks)) a.fleeTicks=0;
}

function animalTileBlocked(x,y, occupancy, id){
  const tx=x|0, ty=y|0;
  if(tx<0||ty<0||tx>=GRID_W||ty>=GRID_H) return true;
  const i=ty*GRID_W+tx;
  if(world.tiles[i]===TILES.WATER) return true;
  if(world.trees[i]>0 || world.rocks[i]>0) return true;
  if(tileOccupiedByBuilding(tx,ty)) return true;
  if(occupancy){
    const key=ty*GRID_W+tx;
    const other=occupancy.get(key);
    if(other && other!==id) return true;
  }
  return false;
}

function queueAnimalLabel(text,color,x,y){
  if(!text) return;
  const fontSize=Math.max(6,6*cam.z);
  const boxH=fontSize+4*cam.z;
  villagerLabels.push({
    text,
    color,
    cx:tileToPxX(x, cam),
    cy:tileToPxY(y, cam)-6*cam.z,
    fontSize,
    boxH,
    camZ:cam.z
  });
}

function nearestVillagerWithin(x,y,radius){
  let best=null, bd=radius+0.001;
  for(const v of villagers){
    const d=Math.hypot((v.x|0)-x,(v.y|0)-y);
    if(d<=bd){ bd=d; best=v; }
  }
  return best;
}

function pickRoamTarget(a, behavior, occupancy){
  const tries=14;
  for(let t=0;t<tries;t++){
    const dx=irnd(-behavior.roamRadius, behavior.roamRadius);
    const dy=irnd(-behavior.roamRadius, behavior.roamRadius);
    const tx=clamp((a.x|0)+dx,0,GRID_W-1);
    const ty=clamp((a.y|0)+dy,0,GRID_H-1);
    const i=ty*GRID_W+tx;
    const def=ANIMAL_TYPES[a.type];
    if(!isAnimalTileAllowed(world.tiles[i], def, true)) continue;
    if(animalTileBlocked(tx,ty,occupancy,a.id)) continue;
    return {x:tx+0.02*R(), y:ty+0.02*R()};
  }
  return null;
}

function attemptGraze(animal, behavior){
  if(animal.nextGrazeTick>tick) return false;
  if(R()>behavior.grazeChance) return false;
  const radius=Math.max(1, behavior.grazeRadius||1);
  const ax=animal.x|0, ay=animal.y|0;
  let target=null;
  for(let y=ay-radius; y<=ay+radius; y++){
    for(let x=ax-radius; x<=ax+radius; x++){
      const i=idx(x,y);
      if(i<0) continue;
      if(world.berries[i]>0){ target={x,y,i}; break; }
    }
    if(target) break;
  }
  if(!target) return false;
  world.berries[target.i]=Math.max(0, world.berries[target.i]-1);
  animal.nextGrazeTick=tick+Math.round(60+R()*120);
  queueAnimalLabel('Grazing', '#cde6b7', target.x+0.1, target.y-0.15);
  return true;
}

function chooseFleeTarget(animal, from, behavior, occupancy){
  const fx=from?.x ?? animal.x;
  const fy=from?.y ?? animal.y;
  const dirX=animal.x - fx;
  const dirY=animal.y - fy;
  const mag=Math.hypot(dirX, dirY) || 1;
  const dist=Math.max(behavior.fleeDistance||3,1.5);
  const targetX=clamp(Math.round(animal.x + (dirX/mag)*dist),0,GRID_W-1);
  const targetY=clamp(Math.round(animal.y + (dirY/mag)*dist),0,GRID_H-1);
  if(!animalTileBlocked(targetX,targetY,occupancy,animal.id)){
    return { x: targetX+0.12*R(), y: targetY+0.12*R() };
  }
  return pickRoamTarget(animal, behavior, occupancy);
}

function findAnimalById(id){
  if(!id) return null;
  for(const a of animals){
    if(a && a.id===id){ return a; }
  }
  return null;
}

function removeAnimal(animal){
  if(!animal) return false;
  const idx=animals.indexOf(animal);
  if(idx!==-1){ animals.splice(idx,1); return true; }
  return false;
}

function resolveHuntYield({ animal: _animal, lodge }){
  const effects=lodge?.effects || {};
  const gameBonus=Number.isFinite(effects.gameYieldBonus)?effects.gameYieldBonus:0;
  const hideBonus=Number.isFinite(effects.hideYieldBonus)?effects.hideYieldBonus:0;
  const baseMeat=1 + (R()<0.42 ? 1 : 0);
  const meat=Math.max(1, Math.round(baseMeat * (1+gameBonus)));
  const hideChance=0.35 + hideBonus*0.5;
  return { meat, pelts: R()<hideChance ? 1 : 0 };
}

function findHuntApproachPath(v, animal, { range=HUNT_RANGE, maxPath=320 }={}){
  if(!v || !animal) return null;
  const ax=Math.round(animal.x);
  const ay=Math.round(animal.y);
  const radius=Math.max(1, Math.ceil(range));
  let best=null;
  for(let dy=-radius; dy<=radius; dy++){
    for(let dx=-radius; dx<=radius; dx++){
      const tx=ax+dx, ty=ay+dy;
      const dist=Math.hypot(tx - animal.x, ty - animal.y);
      if(dist>range) continue;
      if(tx<0||ty<0||tx>=GRID_W||ty>=GRID_H) continue;
      if(tileOccupiedByBuilding(tx,ty)) continue;
      const tile=world.tiles[idx(tx,ty)];
      if(tile===TILES.WATER) continue;
      if(!WALKABLE.has(tile)) continue;
      const p=pathfind(v.x|0, v.y|0, tx, ty, maxPath);
      if(!p) continue;
      if(!best || p.length<best.score){
        best={ path:p, score:p.length, dest:{x:tx,y:ty} };
      }
    }
  }
  return best;
}

function interactWithVillage(animal, behavior, occupancy){
  if(animal.nextVillageTick>tick) return;
  const radius=Math.max(2, behavior.fearRadius||3);
  const villager=nearestVillagerWithin(animal.x, animal.y, radius);
  if(!villager) return;
  const hungry=(villager.starveStage||0)>=1 || villager.condition==='hungry' || villager.condition==='starving';
  if(hungry && R()<0.08){
    dropItem(animal.x|0, animal.y|0, ITEM.FOOD, 1);
    villager.hunger=Math.max(0, villager.hunger-0.12);
    villager.thought=moodThought(villager,'Hunted game');
    queueAnimalLabel('Hunted', '#ffd27f', animal.x+0.15, animal.y-0.1);
    animal.state='flee';
    animal.target=chooseFleeTarget(animal, villager, behavior, occupancy);
    animal.fleeTicks=Math.round(behavior.roamTicks ? behavior.roamTicks[0] : 40);
    animal.nextVillageTick=tick+280;
    return;
  }
  if(R()<0.16){
    villager.happy=clamp(villager.happy+(behavior.observeMood||0.003),0,1);
    villager.thought=moodThought(villager,'Watching wildlife');
    queueAnimalLabel('👀', '#d8e7ff', animal.x+0.05, animal.y-0.2);
    animal.nextVillageTick=tick+Math.round(90+R()*120);
  }
}

function stepAnimal(animal, behavior, occupancy){
  const oldKey=(animal.y|0)*GRID_W+(animal.x|0);
  let speed=behavior.speed||0.12;
  if(animal.state==='flee') speed=behavior.fleeSpeed||speed*1.3;
  const target=animal.target;
  if(!target){ return; }
  const dx=target.x-animal.x;
  const dy=target.y-animal.y;
  const dist=Math.hypot(dx,dy);
  if(dist<0.001){ animal.state='idle'; animal.target=null; return; }
  const step=Math.min(dist, speed);
  const nx=animal.x + (dx/dist)*step;
  const ny=animal.y + (dy/dist)*step;
  const blocked=animalTileBlocked(nx,ny,occupancy,animal.id);
  if(blocked){
    animal.state='idle';
    animal.target=null;
    animal.nextActionTick=tick+irnd(10,40);
    return;
  }
  const newKey=(ny|0)*GRID_W+(nx|0);
  if(newKey!==oldKey){
    const occupant=occupancy.get(newKey);
    if(occupant && occupant!==animal.id){
      animal.state='idle';
      animal.target=null;
      animal.nextActionTick=tick+irnd(8,24);
      return;
    }
    occupancy.delete(oldKey);
    occupancy.set(newKey, animal.id);
  }
  animal.x=nx;
  animal.y=ny;
  if(dx<0) animal.dir='left';
  else if(dx>0) animal.dir='right';
  if(dist<=step+0.01){
    animal.state='idle';
    animal.target=null;
    animal.nextActionTick=tick+irnd(behavior.idleTicks[0], behavior.idleTicks[1]);
  }
}

function animalTick(animal, occupancy){
  ensureAnimalDefaults(animal);
  const behavior=behaviorForAnimal(animal);
  animal.bobOffset=Math.sin((tick+animal.idlePhase)*0.16)*(behavior.idleBob||1);
  const blocked=animalTileBlocked(animal.x,animal.y,occupancy,animal.id);
  if(blocked){
    const target=pickRoamTarget(animal, behavior, occupancy);
    if(target){
      animal.x=target.x;
      animal.y=target.y;
      const k=(animal.y|0)*GRID_W+(animal.x|0);
      occupancy.set(k, animal.id);
    }
  }

  if(animal.state==='idle' && attemptGraze(animal, behavior)){
    animal.nextActionTick=Math.max(animal.nextActionTick||tick, tick+behavior.idleTicks[0]);
  }
  interactWithVillage(animal, behavior, occupancy);

  if(animal.state==='idle' && tick>=animal.nextActionTick){
    const target=pickRoamTarget(animal, behavior, occupancy);
    if(target){
      animal.state='roam';
      animal.target=target;
      animal.nextActionTick=tick+irnd(behavior.roamTicks[0], behavior.roamTicks[1]);
    } else {
      animal.nextActionTick=tick+irnd(behavior.idleTicks[0], behavior.idleTicks[1]);
    }
  }
  if(animal.state==='flee'){
    animal.fleeTicks=Math.max(0,(animal.fleeTicks|0)-1);
    if(!animal.target){
      animal.target=pickRoamTarget(animal, behavior, occupancy);
    }
    if(animal.fleeTicks<=0 && animal.target){
      animal.state='roam';
    }
  }
  if(animal.state==='roam' || animal.state==='flee'){
    if(!animal.target){ animal.state='idle'; return; }
    stepAnimal(animal, behavior, occupancy);
  } else if(animal.state==='idle' && R()<0.015){
    animal.dir=animal.dir==='left'?'right':'left';
  }
}

function updateAnimals(){
  if(animals.length===0) return;
  const occupancy=new Map();
  for(const a of animals){
    const key=(a.y|0)*GRID_W+(a.x|0);
    if(!occupancy.has(key)) occupancy.set(key, a.id);
  }
  for(const a of animals){
    animalTick(a, occupancy);
  }
}

function newWorld(seed=Date.now()|0){
  if(typeof unbindUIListeners === 'function') unbindUIListeners();
  if(typeof unbindCanvasInputs === 'function') unbindCanvasInputs();
  const normalizedSeed = seed >>> 0;
  rng.seed = normalizedSeed;
  rng.generator = mulberry32(normalizedSeed);
  jobs.length=0; buildings.length=0; itemsOnGround.length=0; animals.length=0; markItemsDirty();
  buildingsByKind.clear();
  clearActiveZoneJobs();
  if(typeof tickRunner !== 'undefined') tickRunner.reset();
  markEmittersDirty();
  villagerNumberCounter = 1;
  storageTotals.food = 24;
  storageTotals.wood = 12;
  storageTotals.stone = 0;
  storageTotals.bow = 0;
  storageReserved.food = 0;
  storageReserved.wood = 0;
  storageReserved.stone = 0;
  storageReserved.bow = 0;
  time.tick = 0;
  time.dayTime = 0;
  const terrain = generateTerrain(seed, WORLDGEN_DEFAULTS, { w: GRID_W, h: GRID_H });
  const aux = terrain.aux || {};
  const mode = normalizeShadingMode(SHADING_DEFAULTS.mode);
  SHADING_DEFAULTS.mode = mode;
  LIGHTING.mode = mode;
  const hillshade = computeShadeForMode(mode, aux.height);
  const nextWorld={
    seed,
    tiles:terrain.tiles,
    zone:new Uint8Array(GRID_SIZE),
    trees:terrain.trees,
    rocks:terrain.rocks,
    berries:terrain.berries,
    growth:new Uint8Array(GRID_SIZE),
    season:0,
    tSeason:0,
    aux,
    hillshade,
    width: GRID_W,
    height: GRID_H,
    hillshadeQ: null,
    lightmapQ: null,
    lightmapCanvas: null,
    lightmapCtx: null,
    lightmapImageData: null,
    staticAlbedoCanvas: null,
    staticAlbedoCtx: null,
    emitters: []
  };
  buildHillshadeQ(nextWorld);
  world = nextWorld;
  gameState.world = nextWorld;
  resetLightmapCache();
  waterRowMask = new Uint8Array(GRID_H);
  zoneRowMask = new Uint8Array(GRID_H);
  world.zone.fill(0);
  world.growth.fill(0);
  refreshWaterRowMaskFromTiles();
  markZoneOverlayDirty();
  function idc(x,y){ return y*GRID_W+x; }
  const startFootprintClear=(kind, tx, ty)=>validateFootprintPlacement(kind, tx, ty)===null;

  const findNearestStartSpot=(kind, startX, startY)=>{
    const fp=getFootprint(kind);
    const maxX=Math.max(0, GRID_W-fp.w);
    const maxY=Math.max(0, GRID_H-fp.h);
    const clampedX=clamp(Math.round(startX), 0, maxX);
    const clampedY=clamp(Math.round(startY), 0, maxY);
    const visited=new Uint8Array(GRID_SIZE);
    const queue=[];
    const enqueue=(x,y)=>{
      if(x<0||y<0||x+fp.w>GRID_W||y+fp.h>GRID_H) return;
      const idx=idc(x,y);
      if(visited[idx]) return;
      visited[idx]=1;
      queue.push({x,y});
    };
    enqueue(clampedX, clampedY);
    let qi=0;
    while(qi<queue.length){
      const {x,y}=queue[qi++];
      if(startFootprintClear(kind,x,y)) return {x,y};
      for(const [dx,dy] of DIR4){ enqueue(x+dx, y+dy); }
    }
    return null;
  };

  const campFp=getFootprint('campfire');
  const campMaxX=Math.max(0, GRID_W-campFp.w);
  const campMaxY=Math.max(0, GRID_H-campFp.h);
  const campStartX=clamp(Math.round(GRID_W*0.5 - campFp.w*0.5), 0, campMaxX);
  const campStartY=clamp(Math.round(GRID_H*0.5 - campFp.h*0.5), 0, campMaxY);
  const campPos=findNearestStartSpot('campfire', campStartX, campStartY) || {x:campStartX, y:campStartY};
  const campfire=addBuilding('campfire',campPos.x,campPos.y,{built:1});

  const storageFp=getFootprint('storage');
  const mapCenterX=(GRID_W-1)/2;
  const mapCenterY=(GRID_H-1)/2;
  const adjacencyOffsets=[
    {dx:campFp.w, dy:0},
    {dx:-storageFp.w, dy:0},
    {dx:0, dy:campFp.h},
    {dx:0, dy:-storageFp.h}
  ];
  const adjacency=adjacencyOffsets.map((off, index)=>{
    const x=campfire.x+off.dx;
    const y=campfire.y+off.dy;
    const centerX=x+(storageFp.w-1)/2;
    const centerY=y+(storageFp.h-1)/2;
    const dist=Math.abs(centerX-mapCenterX)+Math.abs(centerY-mapCenterY);
    return {x,y,dist,order:index};
  }).sort((a,b)=>a.dist===b.dist?a.order-b.order:a.dist-b.dist);

  let storagePos=null;
  for(const cand of adjacency){
    if(cand.x<0||cand.y<0||cand.x+storageFp.w>GRID_W||cand.y+storageFp.h>GRID_H) continue;
    if(startFootprintClear('storage', cand.x, cand.y)){ storagePos={x:cand.x,y:cand.y}; break; }
  }
  if(!storagePos){
    const fallback=adjacency.find(c=>!(c.x<0||c.y<0||c.x+storageFp.w>GRID_W||c.y+storageFp.h>GRID_H));
    const startX=fallback?fallback.x:campfire.x;
    const startY=fallback?fallback.y:campfire.y;
    storagePos=findNearestStartSpot('storage', startX, startY);
    if(!storagePos){
      const defaultX=clamp(campfire.x+campFp.w, 0, GRID_W-storageFp.w);
      const defaultY=clamp(campfire.y, 0, GRID_H-storageFp.h);
      storagePos={x:defaultX, y:defaultY};
    }
  }
  const storage=addBuilding('storage',storagePos.x,storagePos.y,{built:1});
  const campCenter=buildingCenter(campfire);
  villagers.length=0;
  for(let i=0;i<6;i++){
    let spawnX=Math.round(campCenter.x)+irnd(-1,1);
    let spawnY=Math.round(campCenter.y)+irnd(-1,1);
    spawnX=clamp(spawnX,0,GRID_W-1);
    spawnY=clamp(spawnY,0,GRID_H-1);
    if(tileOccupiedByBuilding(spawnX, spawnY)){
      const fallback=findEntryTileNear(campfire, spawnX, spawnY) || findEntryTileNear(storage, spawnX, spawnY);
      if(fallback){ spawnX=fallback.x; spawnY=fallback.y; }
    }
    villagers.push(newVillager(spawnX, spawnY));
  }

  spawnAnimalsForWorld();

  // --- Debug namespace ---
  if (world.__debug == null) {
    world.__debug = {
      pipeline: [],
      lastFrame: 0
    };
  }

  ensureDebugKitConfigured();

  Toast.show('New pixel map created.');
  Toast.show('Villagers will choose buildings and resource zones automatically.');
  centerCamera(campfire.x,campfire.y); markStaticDirty();
  if(typeof bindCanvasInputs === 'function') bindCanvasInputs();
  if(typeof bindUIListeners === 'function') bindUIListeners();
}
function rollAdultRole(){ const r=R(); return r<0.25?'farmer':r<0.5?'worker':r<0.75?'explorer':'sleepy'; }
function assignAdultTraits(v, role=rollAdultRole()){
  const farmingSkill=Math.min(1, Math.max(0, rnd(0.35,0.75)+(role==='farmer'?0.1:0)));
  const constructionSkill=Math.min(1, Math.max(0, rnd(0.35,0.7)+(role==='worker'?0.12:0)));
  v.role=role;
  v.speed=2+rnd(-0.2,0.2);
  v.farmingSkill=farmingSkill;
  v.constructionSkill=constructionSkill;
}
function newVillager(x,y){ const v={ id:uid(), x,y,path:[], hunger:rnd(0.2,0.5), energy:rnd(0.5,0.9), happy:rnd(0.4,0.8), hydration:0.7, hydrationBuffTicks:0, nextHydrateTick:0, inv:null, state:'idle', thought:'Wandering', _nextPathTick:0, _wanderFailures:new Map(), _forageFailures:new Map(), condition:'normal', starveStage:0, nextStarveWarning:0, sickTimer:0, recoveryTimer:0, ageTicks:0, lifeStage:'adult', pregnancyTimer:0, pregnancyMateId:null, childhoodTimer:0, parents:[], nextPregnancyTick:0, socialTimer:0, nextSocialTick:0, storageIdleTimer:0, nextStorageIdleTick:0, hydrationTimer:0, activeBuildingId:null, equippedBow:false, experience:createExperienceLedger() }; assignAdultTraits(v); ensureVillagerNumber(v); return v; }
function newChildVillager(x,y,parents){
  const v=newVillager(x,y);
  v.role='child';
  v.speed=1.6+rnd(-0.1,0.1);
  v.hunger=rnd(0.1,0.3);
  v.energy=rnd(0.55,0.85);
  v.happy=rnd(0.45,0.85);
  v.lifeStage='child';
  v.childhoodTimer=CHILDHOOD_TICKS;
  v.pregnancyTimer=0;
  v.pregnancyMateId=null;
  v.farmingSkill=Math.max(0, v.farmingSkill-0.2);
  v.constructionSkill=Math.max(0, v.constructionSkill-0.2);
  v.parents=Array.isArray(parents)?parents.slice(0,2):[];
  return v;
}
function addBuilding(kind,x,y,opts={}){
  const def=BUILDINGS[kind]||{};
  const built=opts.built?1:0;
  const cost=def.cost||((def.wood||0)+(def.stone||0));
  const b={
    id:uid(),
    kind,x,y,
    built:built,
    progress:built?cost:0,
    store:{wood:0,stone:0,food:0},
    spent:{wood:built?(def.wood||0):0, stone:built?(def.stone||0):0},
    pending:{wood:0,stone:0}
  };
  buildings.push(b);
  indexBuilding(b);
  if(b.kind==='campfire' && b.built>=1) markEmittersDirty();
  return b;
}

function tileOccupiedByBuilding(x, y, ignoreId=null){
  return tileOccupiedByBuildingIn(buildings, x, y, ignoreId);
}

function buildingAt(x, y){
  return buildingAtIn(buildings, x, y);
}

function validateFootprintPlacement(kind, tx, ty, opts={}){
  return validateFootprintPlacementIn(buildings, world, kind, tx, ty, opts);
}

function findEntryTileNear(b, fromX, fromY){
  let best=null, bestDist=Infinity;
  for(const tile of buildingEntryTiles(b)){
    if(tile.x<0 || tile.y<0 || tile.x>=GRID_W || tile.y>=GRID_H) continue;
    if(!passable(tile.x, tile.y)) continue;
    const d=Math.abs(tile.x-fromX)+Math.abs(tile.y-fromY);
    if(d<bestDist){
      bestDist=d;
      best=tile;
    }
  }
  return best;
}

function getBuildingById(id){
  if(!id) return null;
  return buildings.find(bb=>bb.id===id) || null;
}

function noteBuildingActivity(b, type='use'){
  if(!b) return;
  ensureBuildingData(b);
  b.activity.lastUse=tick;
  if(type==='hydrate') b.activity.lastHydrate=tick;
  else if(type==='social') b.activity.lastSocial=tick;
  else if(type==='rest') b.activity.lastRest=tick;
}

function setActiveBuilding(v, b){
  if(v.activeBuildingId && v.activeBuildingId===b?.id) return;
  clearActiveBuilding(v);
  if(b){
    ensureBuildingData(b);
    b.activity.occupants=Math.max(0,(b.activity.occupants||0)+1);
    noteBuildingActivity(b);
    v.activeBuildingId=b.id;
  }
}

function clearActiveBuilding(v){
  if(!v.activeBuildingId) return;
  const prev=getBuildingById(v.activeBuildingId);
  if(prev){ ensureBuildingData(prev); prev.activity.occupants=Math.max(0,(prev.activity.occupants||0)-1); }
  v.activeBuildingId=null;
}

function endBuildingStay(v){
  clearActiveBuilding(v);
  v.targetBuilding=null;
}

function agricultureBonusesAt(x,y){
  return _agricultureBonusesAt(buildings, x, y);
}

/* ==================== UI & Sheets ==================== */
const el = (id) => document.getElementById(id);

const ZONE_JOB_TYPES = {
  [ZONES.FARM]: 'sow',
  [ZONES.CUT]: 'chop',
  [ZONES.MINE]: 'mine'
};

function zoneJobType(z){
  return ZONE_JOB_TYPES[z] || null;
}

function zoneCanEverWork(z, i){
  if(z===ZONES.FARM){
    return world.tiles[i] !== TILES.WATER;
  }
  if(z===ZONES.CUT){
    return world.trees[i] > 0;
  }
  if(z===ZONES.MINE){
    return world.rocks[i] > 0;
  }
  return false;
}

function zoneHasWorkNow(z, i){
  if(!zoneCanEverWork(z, i)) return false;
  const x = i % GRID_W;
  const y = (i/GRID_W)|0;
  if(tileOccupiedByBuilding(x, y)) return false;
  if(z===ZONES.FARM){
    return world.growth[i] === 0;
  }
  if(z===ZONES.CUT){
    return true;
  }
  if(z===ZONES.MINE){
    return true;
  }
  return false;
}

const _uiSystem = createUISystem({
  policy,
  time,
  saveGame: (...args) => saveGame(...args),
  newWorld
});
const Toast = _uiSystem.Toast;
const openMode = _uiSystem.openMode;
const bindUIListeners = _uiSystem.bindUIListeners;
const unbindUIListeners = _uiSystem.unbindUIListeners;
const bindCanvasInputs = _uiSystem.bindCanvasInputs;
const unbindCanvasInputs = _uiSystem.unbindCanvasInputs;
const toTile = _uiSystem.toTile;
bindUIListeners();
bindCanvasInputs();

/* ==================== Automation Helpers ==================== */

function availableToReserve(resource){
  return (storageTotals[resource]||0) - (storageReserved[resource]||0);
}

function canReserveMaterials(cost={}){
  for(const [key, qty] of Object.entries(cost)){
    if(qty>0 && availableToReserve(key)<qty) return false;
  }
  return true;
}

function reserveMaterials(cost={}){
  if(!canReserveMaterials(cost)) return false;
  for(const [key, qty] of Object.entries(cost)){
    if(qty>0){
      storageReserved[key]=(storageReserved[key]||0)+qty;
    }
  }
  return true;
}

function releaseReservedMaterials(cost={}){
  for(const [key, qty] of Object.entries(cost)){
    if(qty>0){
      storageReserved[key]=Math.max(0,(storageReserved[key]||0)-qty);
    }
  }
}

function spendCraftMaterials(cost={}){
  for(const [key, qty] of Object.entries(cost)){
    if(qty>0 && (storageTotals[key]||0)<qty){
      releaseReservedMaterials(cost);
      return false;
    }
  }
  for(const [key, qty] of Object.entries(cost)){
    if(qty>0){
      storageTotals[key]=Math.max(0,(storageTotals[key]||0)-qty);
      releaseReservedMaterials({ [key]: qty });
    }
  }
  return true;
}

function countBuildingsByKind(kind){
  let built=0, planned=0;
  for(const b of buildings){
    if(!b || b.kind!==kind) continue;
    if(b.built>=1) built++; else planned++;
  }
  return { built, planned, total: built+planned };
}

function scheduleHaul(b, resource, amount){
  if(!b || amount<=0) return;
  ensureBuildingData(b);
  const available=availableToReserve(resource);
  if(available<=0) return;
  const qty=Math.min(Math.ceil(amount), available);
  if(qty<=0) return;
  const center=buildingCenter(b);
  const storageBuilding=findNearestBuilding(center.x, center.y, 'storage');
  if(!storageBuilding) return;
  const job=addJob({
    type:'haul',
    bid:b.id,
    resource,
    qty,
    prio:0.6+(policy.sliders.build||0)*0.5,
    x:storageBuilding.x,
    y:storageBuilding.y
  });
  job.src={x:storageBuilding.x, y:storageBuilding.y};
  job.dest={x:b.x, y:b.y};
  job.stage='pickup';
  storageReserved[resource]=(storageReserved[resource]||0)+qty;
  b.pending[resource]=(b.pending[resource]||0)+qty;
}

function requestBuildHauls(b){
  if(!b || b.built>=1) return;
  ensureBuildingData(b);
  const store=b.store||{};
  const pending=b.pending||{};
  const woodNeed=buildingResourceNeed(b,'wood');
  const stoneNeed=buildingResourceNeed(b,'stone');
  const woodShort=Math.max(0, woodNeed - ((store.wood||0)+(pending.wood||0)));
  const stoneShort=Math.max(0, stoneNeed - ((store.stone||0)+(pending.stone||0)));
  if(woodShort>0) scheduleHaul(b, ITEM.WOOD, woodShort);
  if(stoneShort>0) scheduleHaul(b, ITEM.STONE, stoneShort);
}

function cancelHaulJobsForBuilding(b){
  if(!b || !b.id) return;
  ensureBuildingData(b);
  for(let i=jobs.length-1;i>=0;i--){
    const job=jobs[i];
    if(job.type==='haul' && job.bid===b.id){
      if(job.stage==='deliver'){
        job.cancelled=true;
        continue;
      }
      const res=job.resource;
      const qty=job.qty||0;
      storageReserved[res]=Math.max(0,(storageReserved[res]||0)-qty);
      b.pending[res]=Math.max(0,(b.pending[res]||0)-qty);
      for(const villager of villagers){
        if(villager.targetJob===job){
          villager.targetJob=null;
          if(villager.path) villager.path.length=0;
          villager.state='idle';
        }
      }
      noteJobRemoved(job);
      jobs.splice(i,1);
    }
  }
}
function idx(x,y){ if(x<0||y<0||x>=GRID_W||y>=GRID_H) return -1; return baseIdx(x,y); }
const _pathfinder = createPathfinder({
  idx,
  tileOccupiedByBuilding,
  getWorld: () => world,
  getTick: () => tick,
  perf: PERF
});
const passable = _pathfinder.passable;
const pathfind = _pathfinder.pathfind;
function centerCamera(x,y){
  cam.z = 2.2;
  cam.x = x - W / (TILE * cam.z) * 0.5;
  cam.y = y - H / (TILE * cam.z) * 0.5;
  clampCam();
}
function getJobCreationConfig(){
  return policy?.style?.jobCreation || {};
}

// ensureBlackboardSnapshot lives on the tick runner (src/app/tick.js); use the
// thunk below so callers in this file keep a stable call shape until the runner
// is wired up at boot.
let ensureBlackboardSnapshot = () => {
  if(!gameState.bb) gameState.bb = computeBlackboard(gameState, policy);
  return gameState.bb;
};

function jobKey(job){
  if(!job || !job.type) return null;
  const base = `${job.type}:${Number.isFinite(job.x)?job.x:'?'},${Number.isFinite(job.y)?job.y:'?'}`;
  if(job.bid!==undefined){
    return `${base}:b${job.bid}`;
  }
  return base;
}

function isJobSuppressed(job){
  const key = jobKey(job);
  if(!key) return false;
  const until = jobSuppression.get(key);
  if(until===undefined) return false;
  if(until<=tick){
    jobSuppression.delete(key);
    return false;
  }
  return true;
}

function suppressJob(job, duration=0){
  const key = jobKey(job);
  if(!key || duration<=0) return;
  jobSuppression.set(key, tick+duration);
}

function hasSimilarJob(job){
  return jobs.some(j=>j && j.type===job.type && j.x===job.x && j.y===job.y && (j.bid||null)===(job.bid||null));
}

function violatesSpacing(x,y,type,cfg){
  const spacing = cfg?.minSpacing?.[type];
  if(!Number.isFinite(spacing) || spacing<=0) return false;
  for(const j of jobs){
    if(!j || j.type!==type) continue;
    const dist = Math.abs((j.x||0)-x)+Math.abs((j.y||0)-y);
    if(dist<=spacing) return true;
  }
  return false;
}

function addJob(job){
  if(!job || !job.type) return null;
  if(hasSimilarJob(job) || isJobSuppressed(job)) return null;
  job.id=uid(); job.assigned=0; jobs.push(job); return job;
}

function finishJob(v, remove=false){
  const job = v.targetJob;
  if(job){
    job.assigned = Math.max(0, (job.assigned||0)-1);
    noteJobAssignmentChanged(job);
    if(remove){
      const ji = jobs.indexOf(job);
      if(ji !== -1){
        noteJobRemoved(job);
        jobs.splice(ji,1);
      }
    }
  }
  v.targetJob=null;
}

const STARVE_THRESH={ hungry:0.82, starving:1.08, sick:1.22 };
const STARVE_COLLAPSE_TICKS=140;
const STARVE_RECOVERY_TICKS=280;
const STARVE_TOAST_COOLDOWN=420;
// Hunger tuning knob: soften the rate a bit so farms can keep pace once established.
const HUNGER_RATE=0.00095;
// Balance knob: how much a bite of food reduces hunger.
const FOOD_HUNGER_RECOVERY=0.65;
const ENERGY_DRAIN_BASE=0.0011;
const PREGNANCY_TICKS=DAY_LEN*2;
const CHILDHOOD_TICKS=DAY_LEN*5;
const PREGNANCY_ATTEMPT_COOLDOWN_TICKS=Math.floor(DAY_LEN*1.1);
const PREGNANCY_ATTEMPT_CHANCE=0.12;
const POPULATION_SOFT_BUFFER=2;
const POPULATION_HARD_CAP=80;
const FOOD_HEADROOM_PER_VILLAGER=1.25;
const REST_BASE_TICKS=90;
const REST_EXTRA_PER_ENERGY=110;
const REST_ENERGY_RECOVERY=0.0024;
const REST_MOOD_TICK=0.0009;
const REST_FINISH_MOOD=0.05;
const REST_HUNGER_MULT=0.42;
const HYDRATION_DECAY=0.00018;
const HYDRATION_VISIT_THRESHOLD=0.46;
const HYDRATION_LOW=0.28;
const HYDRATION_BUFF_TICKS=320;
const HYDRATION_HUNGER_MULT=0.9;
const HYDRATION_FATIGUE_BONUS=0.8;
const HYDRATION_DEHYDRATED_PENALTY=1.12;
const HYDRATION_MOOD_TICK=0.00035;
const SOCIAL_BASE_TICKS=88;
const SOCIAL_COOLDOWN_TICKS=DAY_LEN*0.2;
const SOCIAL_MOOD_TICK=0.0013;
const SOCIAL_ENERGY_TICK=0.00055;
const NIGHT_CAMPFIRE_MOOD_TICK=0.0012;
const NIGHT_CAMPFIRE_XP_TICK=0.15;
const STORAGE_IDLE_BASE=70;
const STORAGE_IDLE_COOLDOWN=DAY_LEN*0.12;
function issueStarveToast(v,text,force=false){ const ready=(v.nextStarveWarning||0)<=tick; if(force||ready){ Toast.show(text); v.nextStarveWarning=tick+STARVE_TOAST_COOLDOWN; } }
function enterSickState(v){ if(v.condition==='sick') return; v.condition='sick'; v.sickTimer=STARVE_COLLAPSE_TICKS; v.starveStage=Math.max(3,v.starveStage||0); finishJob(v); if(v.path) v.path.length=0; v.state='sick'; v.thought=moodThought(v,'Collapsed'); issueStarveToast(v,'A villager collapsed from hunger! They need food now.',true); }
function handleVillagerFed(v,source='food'){ const wasCritical=(v.condition==='sick')||((v.starveStage||0)>=2); v.sickTimer=0; v.starveStage=0; if(wasCritical){ v.condition='recovering'; v.recoveryTimer=STARVE_RECOVERY_TICKS; } else { v.condition='normal'; v.recoveryTimer=Math.max(v.recoveryTimer, Math.floor(STARVE_RECOVERY_TICKS/3)); } v.nextStarveWarning=tick+Math.floor(STARVE_TOAST_COOLDOWN*0.6); if(v.state==='sick') v.state='idle'; v.thought=moodThought(v,wasCritical?'Recovering':'Content'); v.happy=clamp(v.happy+0.05,0,1); if(wasCritical){ const detail=source==='camp'?'camp stores':source==='pack'?'their pack':source==='berries'?'wild berries':source; issueStarveToast(v,`Villager recovered after eating ${detail}.`,true); } }
function villagerTick(v){
  if(v.condition===undefined) v.condition='normal';
  if(v.starveStage===undefined) v.starveStage=0;
  if(v.nextStarveWarning===undefined) v.nextStarveWarning=0;
  if(v.sickTimer===undefined) v.sickTimer=0;
  if(v.recoveryTimer===undefined) v.recoveryTimer=0;
  if(v.restTimer===undefined) v.restTimer=0;
  if(!Number.isFinite(v.hydration)) v.hydration=0.7;
  if(!Number.isFinite(v.hydrationBuffTicks)) v.hydrationBuffTicks=0;
  if(!Number.isFinite(v.nextHydrateTick)) v.nextHydrateTick=0;
  if(!Number.isFinite(v.hydrationTimer)) v.hydrationTimer=0;
  if(!Number.isFinite(v.socialTimer)) v.socialTimer=0;
  if(!Number.isFinite(v.nextSocialTick)) v.nextSocialTick=0;
  if(!Number.isFinite(v.storageIdleTimer)) v.storageIdleTimer=0;
  if(!Number.isFinite(v.nextStorageIdleTick)) v.nextStorageIdleTick=0;
  if(v.activeBuildingId===undefined) v.activeBuildingId=null;
  if(!Number.isFinite(v.ageTicks)) v.ageTicks=0;
  if(!v.lifeStage) v.lifeStage='adult';
  if(!Number.isFinite(v.pregnancyTimer)) v.pregnancyTimer=0;
  if(!Number.isFinite(v.childhoodTimer)) v.childhoodTimer=v.lifeStage==='child'?CHILDHOOD_TICKS:0;
  if(!Array.isArray(v.parents)) v.parents=[];
  if(v.pregnancyMateId===undefined) v.pregnancyMateId=null;
  if(!Number.isFinite(v.nextPregnancyTick)) v.nextPregnancyTick=0;
  v.ageTicks++;
  if(v.lifeStage==='child'){
    if(v.childhoodTimer>0) v.childhoodTimer--;
    if(v.childhoodTimer<=0) promoteChildToAdult(v);
  }
  if(v.lifeStage==='adult'){
    if(v.pregnancyTimer>0){
      v.pregnancyTimer--;
      if(v.pregnancyTimer<=0) completePregnancy(v);
    } else {
      tryStartPregnancy(v);
    }
  }
  const ambientNow = ambientAt(dayTime);
  const nightNow = isNightAmbient(ambientNow);
  const dawnNow = isDawnAmbient(ambientNow);
  const style = policy?.style?.jobScoring || {};
  const blackboard = gameState.bb;
  const resting=v.state==='resting';
  const hydrationDecay=HYDRATION_DECAY*(resting?0.55:1);
  v.hydration=clamp(v.hydration-hydrationDecay,0,1);
  if(v.hydrationBuffTicks>0) v.hydrationBuffTicks--;
  const hydratedBuff=(v.hydrationBuffTicks||0)>0;
  const dehydrated=v.hydration<HYDRATION_LOW;
  const hungerRate=(resting?HUNGER_RATE*REST_HUNGER_MULT:HUNGER_RATE)*(hydratedBuff?HYDRATION_HUNGER_MULT:(dehydrated?HYDRATION_DEHYDRATED_PENALTY:1));
  v.hunger += hungerRate;
  const tileX=v.x|0, tileY=v.y|0;
  const warm=nearbyWarmth(tileX,tileY);
  let energyDelta=-ENERGY_DRAIN_BASE;
  const moodEnergyBoost=moodMotivation(v)*0.00045;
  let happyDelta=warm?0.001:-0.0002;
  const { moodBonus } = agricultureBonusesAt(tileX, tileY);
  if(moodBonus){ happyDelta+=moodBonus; }
  if(warm && nightNow){
    happyDelta+=NIGHT_CAMPFIRE_MOOD_TICK;
    addJobExperience(v, 'socialize', NIGHT_CAMPFIRE_XP_TICK);
  }
  const wellFed=v.hunger<STARVE_THRESH.hungry*0.55;
  const wellRested=v.energy>0.55;
  if(wellFed&&wellRested){
    happyDelta+=0.0008+Math.max(0,v.energy-0.55)*0.0006;
  }
  energyDelta+=moodEnergyBoost;
  if(hydratedBuff){
    energyDelta*=HYDRATION_FATIGUE_BONUS;
    happyDelta+=HYDRATION_MOOD_TICK*0.5;
  } else if(dehydrated){
    energyDelta*=HYDRATION_DEHYDRATED_PENALTY;
    happyDelta-=HYDRATION_MOOD_TICK;
  }
  if(resting){
    energyDelta+=REST_ENERGY_RECOVERY;
    happyDelta+=REST_MOOD_TICK;
  }
  const prevStage=v.starveStage||0;
  let stage=0;
  if(v.hunger>STARVE_THRESH.hungry) stage=1;
  if(v.hunger>STARVE_THRESH.starving) stage=2;
  if(v.hunger>STARVE_THRESH.sick) stage=3;
  if(v.recoveryTimer>0){
    v.recoveryTimer--;
    energyDelta*=0.6;
    happyDelta+=0.0006;
    if(v.recoveryTimer===0 && stage===0) v.condition='normal';
  } else if(v.condition==='recovering' && stage===0){
    v.condition='normal';
  }
  if(stage>=1) energyDelta-=0.00025;
  if(stage>=2){ energyDelta-=0.00045; happyDelta-=0.00045; }
  if(stage>=3){ energyDelta-=0.0006; happyDelta-=0.0009; }
  if(stage>prevStage){
    if(stage===1){ if(v.condition!=='sick') v.condition='hungry'; }
    else if(stage===2){ if(v.condition!=='sick') v.condition='starving'; issueStarveToast(v,'A villager is starving! Set up food or gather berries.'); }
    else if(stage>=3){ enterSickState(v); }
  } else if(stage<prevStage){
    if(prevStage>=2 && stage<=1 && v.condition!=='recovering') issueStarveToast(v,'Villager ate and is stabilizing.',true);
    if(stage===0 && v.recoveryTimer<=0) v.condition='normal';
    else if(stage===1 && v.condition!=='sick' && v.recoveryTimer<=0) v.condition='hungry';
  } else if(stage===0 && v.recoveryTimer<=0 && v.condition!=='normal' && v.condition!=='recovering'){
    v.condition='normal';
  }
  if(v.condition==='sick' && v.sickTimer<=0 && stage<3){
    v.condition=stage>=2?'starving':stage===1?'hungry':'normal';
  }
  v.starveStage=stage;
  if(v.condition==='sick' && v.sickTimer>0){
    v.sickTimer--;
    energyDelta-=0.0006;
    happyDelta-=0.0008;
    if(v.path) v.path.length=0;
    finishJob(v);
    v.state='sick';
    v.thought=moodThought(v,'Collapsed');
  }
  v.hunger=clamp(v.hunger,0,1.2);
  v.energy=clamp(v.energy+energyDelta,0,1);
  v.happy=clamp(v.happy+happyDelta,0,1);
  if(v.condition==='sick' && v.sickTimer>0){ return; }
  const urgentFood = stage>=2 || v.condition==='sick';
  const needsFood = stage>=1;
  let panicHarvestJob=null;
  if(v.state==='socializing' && dawnNow){
    endBuildingStay(v);
    v.state='idle';
    v.socialTimer=0;
    v.thought=moodThought(v,'Greeting the dawn');
  }
  // If daylight has clearly arrived, break out of lingering campfire gatherings.
  if(!nightNow && (v.state==='socialize' || v.state==='socializing')){
    endBuildingStay(v);
    v.state='idle';
    v.socialTimer=0;
    v.nextSocialTick = Math.max(v.nextSocialTick || 0, tick + Math.floor(SOCIAL_COOLDOWN_TICKS * 0.4));
    v.thought=moodThought(v,'Back to work');
  }
  if(v.state==='resting'){
    if(urgentFood){
      endBuildingStay(v);
      v.state='idle';
    } else {
      const minRest=REST_BASE_TICKS+Math.round(Math.max(0,1-v.energy)*REST_EXTRA_PER_ENERGY*0.35);
      if(v.restTimer<minRest) v.restTimer=minRest;
      v.restTimer=Math.max(0,v.restTimer-1);
      if(v.restTimer<=0 || v.energy>=0.995){
        endBuildingStay(v);
        v.state='idle';
        v.restTimer=0;
        v.happy=clamp(v.happy+REST_FINISH_MOOD,0,1);
        v.thought=moodThought(v,'Rested');
      } else {
        const active=getBuildingById(v.activeBuildingId);
        if(active) noteBuildingActivity(active,'rest');
        v.thought=moodThought(v,'Resting');
        return;
      }
    }
  }
  if(v.state==='hydrating'){
    if(urgentFood){ endBuildingStay(v); v.state='idle'; }
    else {
      const active=getBuildingById(v.activeBuildingId);
      v.hydration=1;
      v.hydrationBuffTicks=Math.max(v.hydrationBuffTicks, HYDRATION_BUFF_TICKS);
      v.hydrationTimer=Math.max(v.hydrationTimer||0, Math.round(HYDRATION_BUFF_TICKS*0.2));
      v.hydrationTimer=Math.max(0, v.hydrationTimer-1);
      if(active) noteBuildingActivity(active,'hydrate');
      v.happy=clamp(v.happy+HYDRATION_MOOD_TICK,0,1);
      v.thought=moodThought(v,'Drinking');
      if(v.hydrationTimer<=0){
        endBuildingStay(v);
        v.state='idle';
        v.hydrationTimer=0;
        v.nextHydrateTick=tick+Math.floor(DAY_LEN*0.16);
        v.thought=moodThought(v,'Hydrated');
      } else {
        return;
      }
    }
  }
  if(v.state==='socializing'){
    if(urgentFood){ endBuildingStay(v); v.state='idle'; }
    else {
      v.socialTimer=Math.max(v.socialTimer||0, SOCIAL_BASE_TICKS);
      v.socialTimer=Math.max(0, v.socialTimer-1);
      v.happy=clamp(v.happy+SOCIAL_MOOD_TICK,0,1);
      v.energy=clamp(v.energy+SOCIAL_ENERGY_TICK,0,1);
      const active=getBuildingById(v.activeBuildingId);
      if(active) noteBuildingActivity(active,'social');
      v.thought=moodThought(v,'Sharing stories');
      if(v.socialTimer<=0){
        endBuildingStay(v);
        v.state='idle';
        v.nextSocialTick=tick+SOCIAL_COOLDOWN_TICKS;
        v.thought=moodThought(v,'Refreshed');
      } else {
        return;
      }
    }
  }
  if(v.state==='storage_linger'){
    if(urgentFood){ endBuildingStay(v); v.state='idle'; }
    else {
      v.storageIdleTimer=Math.max(v.storageIdleTimer||0, STORAGE_IDLE_BASE);
      v.storageIdleTimer=Math.max(0, v.storageIdleTimer-1);
      v.happy=clamp(v.happy+0.00045,0,1);
      const active=getBuildingById(v.activeBuildingId);
      if(active) noteBuildingActivity(active,'use');
      v.thought=moodThought(v,'Tidying storage');
      if(v.storageIdleTimer<=0){
        endBuildingStay(v);
        v.state='idle';
        v.nextStorageIdleTick=tick+STORAGE_IDLE_COOLDOWN;
        v.thought=moodThought(v,'Organized');
      } else {
        return;
      }
    }
  }
  if(urgentFood){
    if(consumeFood(v)){ v.thought=moodThought(v,'Eating'); return; }
    if(foragingJob(v)) return;
    if(seekEmergencyFood(v, { pathLimit: 240, radius: 16 })) return;
  } else if(needsFood){
    if(consumeFood(v)){ v.thought=moodThought(v,'Eating'); return; }
    if(foragingJob(v)) return;
  }
  // Panic harvest behavior when hungry: grab ripe crops if idle and food is tight.
  if((urgentFood||needsFood) && v.state==='idle' && !v.targetJob){
    panicHarvestJob = findPanicHarvestJob(v);
  }
  if(v.state==='idle' && !urgentFood && !needsFood && !v.targetJob){
    if(tryEquipBow(v)) return;
  }
  const restThreshold = Number.isFinite(style.restEnergyThreshold) ? style.restEnergyThreshold : 0.22;
  const fatigueThreshold = Number.isFinite(style.energyFatigueThreshold) ? style.energyFatigueThreshold : 0.32;
  const restFatigueBoost = Number.isFinite(style.restFatigueBoost) ? style.restFatigueBoost : 0.08;
  const fatigueFlag = !!blackboard?.energy?.fatigue;
  const shouldRest = v.energy < restThreshold || (fatigueFlag && v.energy < restThreshold + restFatigueBoost) || v.energy < (fatigueThreshold * 0.8);
  if(shouldRest){ if(goRest(v)) return; }
  if(v.state==='idle' && !urgentFood){
    if(tryHydrateAtWell(v)) return;
  }
  if(nightNow && v.state==='idle' && !needsFood && !urgentFood && !v.targetJob){
    if(tryCampfireSocial(v, { ambientNow, forceNight: true })) return;
  }
  const reprioritizeMargin = Number.isFinite(style.reprioritizeMargin) ? style.reprioritizeMargin : 0.06;
  if(maybeInterruptJob(v, { blackboard, margin: reprioritizeMargin })) return;
  if(v.path && v.path.length>0){ stepAlong(v); return; }
  if(v.inv){ const s=findNearestBuilding(v.x|0,v.y|0,'storage'); if(s && tick>=v._nextPathTick){ const entry=findEntryTileNear(s, v.x|0, v.y|0) || {x:Math.round(buildingCenter(s).x), y:Math.round(buildingCenter(s).y)}; const p=pathfind(v.x|0,v.y|0,entry.x,entry.y); if(p){ v.path=p; v.state='to_storage'; v.thought=moodThought(v,'Storing'); v._nextPathTick=tick+12; return; } } }
    if(v.lifeStage==='child'){
      v.targetJob=null;
    }
    const j=(panicHarvestJob || pickJobFor(v)); if(j && tick>=v._nextPathTick){
    let dest={x:j.x,y:j.y};
    let plannedPath=null;
    if(j.type==='build'){
      const b=buildings.find(bb=>bb.id===j.bid);
      if(b){
        const entry=findEntryTileNear(b, v.x|0, v.y|0);
        if(entry){ dest=entry; }
        else {
          const center=buildingCenter(b);
          dest={x:Math.round(center.x), y:Math.round(center.y)};
        }
      }
    } else if(j.type==='haul'){
      if(j.src){
        const srcBuilding=buildingAt(j.src.x, j.src.y);
        if(srcBuilding){
          const entry=findEntryTileNear(srcBuilding, v.x|0, v.y|0);
          if(entry){ dest=entry; }
          else { dest={x:j.src.x,y:j.src.y}; }
        } else { dest={x:j.src.x,y:j.src.y}; }
      }
      else {
        const b=buildings.find(bb=>bb.id===j.bid);
        if(b){
          const entry=findEntryTileNear(b, v.x|0, v.y|0);
          if(entry){ dest=entry; }
          else {
            const center=buildingCenter(b);
            dest={x:Math.round(center.x), y:Math.round(center.y)};
          }
        }
      }
    } else if(j.type==='craft_bow'){
      const lodge=buildings.find(bb=>bb.id===j.bid && bb.kind==='hunterLodge');
      if(lodge){
        const entry=findEntryTileNear(lodge, v.x|0, v.y|0);
        if(entry){ dest=entry; }
        else {
          const center=buildingCenter(lodge);
          dest={x:Math.round(center.x), y:Math.round(center.y)};
        }
      }
    } else if(j.type==='hunt'){
      const animal=findAnimalById(j.targetAid);
      if(animal){
        const approach=findHuntApproachPath(v, animal, { range:HUNT_RANGE });
        if(approach){
          dest=approach.dest;
          plannedPath=approach.path;
        }
      }
      if(!plannedPath){
        suppressJob(j, HUNT_RETRY_COOLDOWN);
        v._nextPathTick=tick+12;
        // No viable path; skip further processing for this villager until retry.
        return;
      }
    }
    const p=plannedPath || pathfind(v.x|0,v.y|0,dest.x,dest.y);
    if(p){
      v.path=p;
      v.state=j.type==='haul'?'haul_pickup':j.type;
      if(j.type==='forage' && Number.isInteger(j.targetI)){
        v.targetI=j.targetI;
      }
      v.targetJob=j;
      v.thought=j.type==='haul'?moodThought(v,'Hauling'):moodThought(v,j.type.toUpperCase());
      j.assigned++;
      noteJobAssignmentChanged(j);
      v._nextPathTick=tick+12;
      return;
    }
    const retryTicks = Number.isFinite(getJobCreationConfig()?.unreachableRetryTicks)
      ? getJobCreationConfig().unreachableRetryTicks
      : 0;
      if(retryTicks>0){
        suppressJob(j, retryTicks);
      }
      v._nextPathTick=tick+12;
    }
    if(!j && v.state==='idle' && !urgentFood && !v.targetJob && jobs.length===0){
      if(tryStorageIdle(v)) return;
    }
    if(v.state==='idle' && !needsFood && !urgentFood && !v.targetJob){
      if(tryCampfireSocial(v, { ambientNow })) return;
    }
  if(handleIdleRoam(v, { stage, needsFood, urgentFood })) return;
}
function nearbyWarmth(x,y){
  return buildings.some(b=>b.kind==='campfire' && distanceToFootprint(x,y,b)<=CAMPFIRE_EFFECT_RADIUS);
}
function consumeFood(v){
  let source=null;
  if(v.inv && v.inv.type===ITEM.FOOD){
    v.hunger-=FOOD_HUNGER_RECOVERY;
    v.inv=null;
    source='pack';
  } else if(storageTotals.food>0){
    storageTotals.food--;
    v.hunger-=FOOD_HUNGER_RECOVERY;
    source='camp';
  }
  if(source){
    if(v.hunger<0) v.hunger=0;
    handleVillagerFed(v, source);
    return true;
  }
  return false;
}
function nearestFoodTarget(v,{radius=12,pathLimit=200}={}){
  const sx=v.x|0, sy=v.y|0;
  let best=null;
  const consider=(target)=>{
    if(!target) return;
    const { x, y, kind, targetI } = target;
    const p=pathfind(sx,sy,x,y,pathLimit);
    if(!p) return;
    const score=p.length;
    if(!best || score<best.score){
      best={ path:p, score, kind, x, y, targetI };
    }
  };
  if(storageTotals.food>0){
    const storage=findNearestBuilding(sx,sy,'storage');
    if(storage){
      const entry=findEntryTileNear(storage, sx, sy) || {x:Math.round(buildingCenter(storage).x), y:Math.round(buildingCenter(storage).y)};
      consider({x:entry.x,y:entry.y,kind:'storage'});
    }
  }
  for(const it of itemsOnGround){
    if(!it || it.type!==ITEM.FOOD) continue;
    consider({x:it.x,y:it.y,kind:'ground'});
  }
  const clampX=(val)=>clamp(val,0,GRID_W-1);
  const clampY=(val)=>clamp(val,0,GRID_H-1);
  const x0=clampX(sx-radius), x1=clampX(sx+radius);
  const y0=clampY(sy-radius), y1=clampY(sy+radius);
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const i=idx(x,y);
      if(i<0) continue;
      if(world.berries[i]>0){
        consider({x,y,kind:'berry',targetI:i});
      }
    }
  }
  return best;
}
function seekEmergencyFood(v,{radius=14,pathLimit=200}={}){
  if(tick<v._nextPathTick) return false;
  const target=nearestFoodTarget(v,{radius,pathLimit});
  if(!target) return false;
  v.path=target.path;
  const cooldown=Math.max(8, Math.min(22, target.path.length+6));
  v._nextPathTick=tick+cooldown;
  if(target.kind==='berry'){
    v.state='forage';
    v.targetI=target.targetI;
    v.thought=moodThought(v,'Foraging');
  } else {
    v.state='seek_food';
    v.targetFood=target.kind;
    v.targetFoodPos={x:target.x,y:target.y};
    v.thought=moodThought(v,'Seeking food');
  }
  return true;
}
function getRallyPoint(){
  const camp=buildings.find(b=>b.kind==='campfire' && b.built>=1);
  if(camp){
    const entry=findEntryTileNear(camp, camp.x, camp.y) || {x:Math.round(buildingCenter(camp).x), y:Math.round(buildingCenter(camp).y)};
    return entry;
  }
  const storage=buildings.find(b=>b.kind==='storage' && b.built>=1);
  if(storage){
    const entry=findEntryTileNear(storage, storage.x, storage.y) || {x:Math.round(buildingCenter(storage).x), y:Math.round(buildingCenter(storage).y)};
    return entry;
  }
  return null;
}
function countNearbyVillagers(v, radius=3){
  const sx=v.x, sy=v.y;
  let count=0;
  for(const other of villagers){
    if(other===v) continue;
    if(Math.abs(other.x-sx)<=radius && Math.abs(other.y-sy)<=radius){
      count++;
    }
  }
  return count;
}
function housingCapacity(){
  const huts=countBuildingsByKind('hut');
  return Math.max(6, huts.built*2 + 4);
}
function populationLimit(availableFood){
  const housingGate=housingCapacity()+POPULATION_SOFT_BUFFER;
  const foodGate=Math.max(0, Math.floor((availableFood||0)/FOOD_HEADROOM_PER_VILLAGER));
  const rawLimit=Math.min(housingGate, foodGate);
  return Math.max(6, Math.min(POPULATION_HARD_CAP, rawLimit));
}
function canSupportBirth(){
  const availableFood=storageTotals.food||0;
  const projectedPop=villagers.length+pendingBirths.length;
  const housingRoom=housingCapacity()-projectedPop;
  if(housingRoom<=0) return false;
  const underCap=projectedPop<populationLimit(availableFood);
  const wellFed=availableFood>Math.max(4, projectedPop*0.8);
  return underCap && wellFed;
}
function findBirthMate(v){
  let best=null;
  let bestDist=Infinity;
  for(const other of villagers){
    if(other===v) continue;
    if(other.lifeStage!=='adult') continue;
    if(other.pregnancyTimer>0) continue;
    if((other.nextPregnancyTick||0)>tick) continue;
    if((other.starveStage||0)>=2) continue;
    if(other.condition!=='normal' && other.condition!=='hungry') continue;
    const dist=Math.abs((other.x|0)-(v.x|0))+Math.abs((other.y|0)-(v.y|0));
    if(dist<bestDist){ best=other; bestDist=dist; }
  }
  return best;
}
function tryStartPregnancy(v){
  if(v.lifeStage!=='adult') return;
  if(v.pregnancyTimer>0) return;
  if((v.starveStage||0)>=1) return;
  if(v.condition==='sick') return;
  if(v.energy<0.4 || v.happy<0.35) return;
  if(tick<(v.nextPregnancyTick||0)) return;
  if(!canSupportBirth()){
    v.nextPregnancyTick=Math.max(v.nextPregnancyTick||0, tick+Math.floor(PREGNANCY_ATTEMPT_COOLDOWN_TICKS*0.5));
    return;
  }
  if(R()>PREGNANCY_ATTEMPT_CHANCE){
    v.nextPregnancyTick=tick+PREGNANCY_ATTEMPT_COOLDOWN_TICKS;
    return;
  }
  const mate=findBirthMate(v);
  const cooldownUntil=tick+PREGNANCY_ATTEMPT_COOLDOWN_TICKS;
  if(!mate){
    v.nextPregnancyTick=cooldownUntil;
    return;
  }
  v.pregnancyTimer=PREGNANCY_TICKS;
  v.pregnancyMateId=mate.id;
  v.thought=moodThought(v,'Expecting');
  v.nextPregnancyTick=cooldownUntil;
  mate.nextPregnancyTick=Math.max(mate.nextPregnancyTick||0, cooldownUntil);
}
function spawnChildNearParents(parent, mate){
  const centerX=Math.round((parent.x + (mate?mate.x:parent.x))/2);
  const centerY=Math.round((parent.y + (mate?mate.y:parent.y))/2);
  const offsets=[{dx:0,dy:0},{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1},{dx:1,dy:1},{dx:-1,dy:1},{dx:1,dy:-1},{dx:-1,dy:-1}];
  const parents=[parent.id];
  if(mate?.id) parents.push(mate.id);
  for(const off of offsets){
    const x=clamp(centerX+off.dx,0,GRID_W-1);
    const y=clamp(centerY+off.dy,0,GRID_H-1);
    const i=idx(x,y);
    if(i<0) continue;
    if(tileOccupiedByBuilding(x,y)) continue;
    if(world.tiles[i]===TILES.WATER) continue;
    pendingBirths.push({x,y,parents});
    return true;
  }
  return false;
}
function flushPendingBirths(){
  if(pendingBirths.length===0) return;
  for(const birth of pendingBirths){
    villagers.push(newChildVillager(birth.x,birth.y,birth.parents));
  }
  pendingBirths.length=0;
}
function completePregnancy(v){
  const mate=v.pregnancyMateId?villagers.find(o=>o.id===v.pregnancyMateId):null;
  if(!spawnChildNearParents(v, mate)){
    v.pregnancyTimer=10;
    return;
  }
  v.pregnancyTimer=0;
  v.pregnancyMateId=null;
  v.thought=moodThought(v,'Newborn');
}
function promoteChildToAdult(v){
  v.lifeStage='adult';
  v.childhoodTimer=0;
  assignAdultTraits(v);
  v.nextPregnancyTick=Math.max(v.nextPregnancyTick||0, tick+PREGNANCY_ATTEMPT_COOLDOWN_TICKS);
  v.thought=moodThought(v,'Grew up');
}
function collectFoodHubs(v, radius=12){
  const hubs=[];
  const sx=v.x|0, sy=v.y|0;
  const radiusX=Math.max(1,radius);
  const clampX=(val)=>clamp(val,0,GRID_W-1);
  const clampY=(val)=>clamp(val,0,GRID_H-1);
  if(storageTotals.food>0){
    for(const b of buildings){
      if(b.kind!=='storage' || b.built<1) continue;
      const c=buildingCenter(b);
      hubs.push({x:Math.round(c.x), y:Math.round(c.y), weight:2.5});
    }
  }
  for(const b of buildings){
    if(b.kind==='campfire' && b.built>=1){
      const c=buildingCenter(b);
      hubs.push({x:Math.round(c.x), y:Math.round(c.y), weight:1.5});
    }
  }
  for(const it of itemsOnGround){
    if(!it || it.type!==ITEM.FOOD) continue;
    if(Math.abs(it.x-sx)<=radiusX && Math.abs(it.y-sy)<=radiusX){
      hubs.push({x:it.x, y:it.y, weight:3});
    }
  }
  const x0=clampX(sx-radiusX), x1=clampX(sx+radiusX);
  const y0=clampY(sy-radiusX), y1=clampY(sy+radiusX);
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const i=idx(x,y);
      if(i<0) continue;
      if(world.berries[i]>0){
        hubs.push({x,y,weight:2});
      }
    }
  }
  return hubs;
}
function pickWeightedRandom(candidates){
  if(!candidates || candidates.length===0) return null;
  const total=candidates.reduce((sum,c)=>sum+(c.weight||1),0);
  let r=R()*total;
  for(const c of candidates){
    r-=c.weight||1;
    if(r<=0) return c;
  }
  return candidates[candidates.length-1];
}
function selectReachableWanderTarget(v,candidates,pathLimit,cooldown){
  if(!candidates || candidates.length===0) return null;
  for (const [key, until] of Array.from(v._wanderFailures.entries())) {
    if (until <= tick) v._wanderFailures.delete(key);
  }
  const attempts=Math.min(8, candidates.length*2);
  for(let n=0;n<attempts;n++){
    const cand=pickWeightedRandom(candidates);
    if(!cand) break;
    const cx=clamp(cand.x|0,0,GRID_W-1);
    const cy=clamp(cand.y|0,0,GRID_H-1);
    const key=idx(cx,cy);
    if(key<0) continue;
    const failedUntil=v._wanderFailures.get(key);
    if(failedUntil && failedUntil>tick) continue;
    if(!passable(cx,cy)){
      v._wanderFailures.set(key, tick+180);
      continue;
    }
    const p=pathfind(v.x|0,v.y|0,cx,cy,pathLimit);
    if(p){
      return { path:p, cooldown };
    }
    v._wanderFailures.set(key, tick+240);
  }
  return null;
}
function handleIdleRoam(v,{stage, needsFood, urgentFood}){
  const baseRange=stage===1?3:4;
  const crowd=countNearbyVillagers(v, 3);
  const crowdCooldown=Math.max(10, 12 + Math.max(0, crowd-2)*4 + irnd(0,4));
  const adjustedRange=crowd>3 ? Math.max(1, baseRange-1) : baseRange;
  if(urgentFood && seekEmergencyFood(v, { radius: 14, pathLimit: 220 })) return true;
  const rally=(!needsFood && !urgentFood && !v.inv) ? getRallyPoint() : null;
  const ready=tick>=v._nextPathTick;
  if(rally && ready){
    const rallyPath=pathfind(v.x|0,v.y|0,rally.x,rally.y,160);
    if(rallyPath){
      v.path=rallyPath;
      v.thought=moodThought(v,'Regrouping');
      v._nextPathTick=tick+crowdCooldown;
      return true;
    }
  }
  const hungry=needsFood || urgentFood;
  const hubs=hungry?collectFoodHubs(v, 12):[];
  const candidates=[];
  if(hubs.length>0){
    for(const hub of hubs){
      candidates.push({
        x:clamp(hub.x+irnd(-2,2),0,GRID_W-1),
        y:clamp(hub.y+irnd(-2,2),0,GRID_H-1),
        weight:hub.weight||1
      });
    }
  }
  const cx=v.x|0, cy=v.y|0;
  for(let i=0;i<4;i++){
    candidates.push({
      x:clamp(cx+irnd(-adjustedRange,adjustedRange),0,GRID_W-1),
      y:clamp(cy+irnd(-adjustedRange,adjustedRange),0,GRID_H-1),
      weight:1
    });
  }
  const pathLimit=hungry?120:80;
  const wander=ready?selectReachableWanderTarget(v,candidates,pathLimit,crowdCooldown+irnd(0,4)):null;
  v.thought=moodThought(v, urgentFood?'Starving':(stage===1?'Hungry':'Wandering'));
  if(wander){
    v.path=wander.path;
    v._nextPathTick=tick+wander.cooldown;
  } else if(tick>=v._nextPathTick){
    v._nextPathTick=tick+crowdCooldown;
  }
  return true;
}
function foragingJob(v){
  if(tick<v._nextPathTick) return false;
  const style = policy?.style?.jobScoring || {};
  const bb = gameState?.bb;
  const famineSeverity = computeFamineSeverity(bb);
  const baseRadius = 10;
  const maxRadius = Number.isFinite(style.adaptiveForageMaxRadius) ? style.adaptiveForageMaxRadius : 18;
  const radius = Math.max(baseRadius, Math.round(baseRadius + famineSeverity * Math.max(0, maxRadius - baseRadius)));
  const basePathLimit = 120;
  const maxPathLimit = Number.isFinite(style.adaptiveForageMaxPath) ? style.adaptiveForageMaxPath : 240;
  const pathLimit = Math.max(basePathLimit, Math.round(basePathLimit + famineSeverity * Math.max(0, maxPathLimit - basePathLimit)));
  const sx=v.x|0,sy=v.y|0; let best=null,bd=999;
  for (const [key, until] of Array.from(v._forageFailures.entries())) {
    if (until <= tick) v._forageFailures.delete(key);
  }
  for(let y=sy-radius;y<=sy+radius;y++){
    for(let x=sx-radius;x<=sx+radius;x++){
      const i=idx(x,y);
      if(i<0) continue;
      if(world.berries[i]>0){
        if(v._forageFailures.has(i)) continue;
        const d=Math.abs(x-sx)+Math.abs(y-sy);
        if(d<bd){bd=d; best={x,y,i};}
      }
    }
  }
  if(best){
    const p=pathfind(v.x|0,v.y|0,best.x,best.y,pathLimit);
    if(p){ v.path=p; v.state='forage'; v.targetI=best.i; v.thought=moodThought(v,'Foraging'); v._nextPathTick=tick+12; return true; }
    v._forageFailures.set(best.i, tick+180);
  }
  return false;
}
function goRest(v){ if(tick<v._nextPathTick) return false; const hut=findNearestBuilding(v.x|0,v.y|0,'hut')||buildings.find(b=>b.kind==='campfire'&&b.built>=1); if(hut){ const entry=findEntryTileNear(hut, v.x|0, v.y|0) || {x:Math.round(buildingCenter(hut).x), y:Math.round(buildingCenter(hut).y)}; const p=pathfind(v.x|0,v.y|0,entry.x,entry.y); if(p){ v.path=p; v.state='rest'; v.targetBuilding=hut; v.thought=moodThought(v,'Resting'); v._nextPathTick=tick+12; return true; } } return false; }
function tryHydrateAtWell(v){
  if(tick<v._nextPathTick) return false;
  if(v.nextHydrateTick>tick) return false;
  if(v.hydration>HYDRATION_VISIT_THRESHOLD) return false;
  const well=findNearestBuilding(v.x|0,v.y|0,'well');
  if(!well) return false;
  const entry=findEntryTileNear(well, v.x|0, v.y|0) || {x:Math.round(buildingCenter(well).x), y:Math.round(buildingCenter(well).y)};
  const p=pathfind(v.x|0,v.y|0,entry.x,entry.y);
  if(p){
    v.path=p;
    v.state='hydrate';
    v.targetBuilding=well;
    v.thought=moodThought(v,'Fetching water');
    v._nextPathTick=tick+12;
    v.nextHydrateTick=tick+Math.floor(DAY_LEN*0.12);
    return true;
  }
  v.nextHydrateTick=Math.max(v.nextHydrateTick||0, tick+60);
  return false;
}
function tryCampfireSocial(v, { ambientNow = ambientAt(dayTime), forceNight = false } = {}){
  if(tick<v._nextPathTick) return false;
  if(v.nextSocialTick>tick) return false;
  if((v.starveStage||0)>=1) return false;
  const nightAmbient=isNightAmbient(ambientNow);
  if(!nightAmbient && !forceNight) return false;
  if(!nightAmbient && forceNight && !isNightTime()) return false;
  if(isDawnAmbient(ambientNow)) return false;
  const camp=findNearestBuilding(v.x|0,v.y|0,'campfire');
  if(!camp) return false;
  const entry=findEntryTileNear(camp, v.x|0, v.y|0) || {x:Math.round(buildingCenter(camp).x), y:Math.round(buildingCenter(camp).y)};
  const p=pathfind(v.x|0,v.y|0,entry.x,entry.y);
  if(p){
    v.path=p;
    v.state='socialize';
    v.targetBuilding=camp;
    v.thought=moodThought(v,'Gathering by fire');
    v._nextPathTick=tick+12;
    v.nextSocialTick=tick+Math.floor(SOCIAL_COOLDOWN_TICKS*0.25);
    return true;
  }
  v.nextSocialTick=Math.max(v.nextSocialTick||0, tick+90);
  return false;
}
function tryStorageIdle(v){
  if(tick<v._nextPathTick) return false;
  if(v.nextStorageIdleTick>tick) return false;
  if(v.inv) return false;
  if(v.targetJob) return false;
  const storage=findNearestBuilding(v.x|0,v.y|0,'storage');
  if(!storage) return false;
  const entry=findEntryTileNear(storage, v.x|0, v.y|0) || {x:Math.round(buildingCenter(storage).x), y:Math.round(buildingCenter(storage).y)};
  const p=pathfind(v.x|0,v.y|0,entry.x,entry.y);
  if(p){
    v.path=p;
    v.state='storage_idle';
    v.targetBuilding=storage;
    v.thought=moodThought(v,'Checking storage');
    v._nextPathTick=tick+12;
    v.nextStorageIdleTick=tick+Math.floor(STORAGE_IDLE_COOLDOWN*0.4);
    return true;
  }
  v.nextStorageIdleTick=Math.max(v.nextStorageIdleTick||0, tick+80);
  return false;
}

function tryEquipBow(v){
  if(v.lifeStage==='child') return false;
  if(v.equippedBow) return false;
  if(v.inv) return false;
  if(v.state!=='idle') return false;
  if(tick<v._nextPathTick) return false;
  if(availableToReserve('bow')<=0) return false;
  const storage=findNearestBuilding(v.x|0,v.y|0,'storage');
  if(!storage) return false;
  const entry=findEntryTileNear(storage, v.x|0, v.y|0) || {x:Math.round(buildingCenter(storage).x), y:Math.round(buildingCenter(storage).y)};
  const p=pathfind(v.x|0,v.y|0,entry.x,entry.y);
  if(!p) return false;
  v.path=p;
  v.state='equip_bow';
  v.targetBuilding=storage;
  v.thought=moodThought(v,'Fetching bow');
  v._nextPathTick=tick+12;
  return true;
}
function findNearestBuilding(x,y,kind){ let best=null,bd=Infinity; const list=buildingsByKind.get(kind); if(!list) return null; for(const b of list){ if(b.built<1) continue; const d=distanceToFootprint(x,y,b); if(d<bd){bd=d; best=b;} } return best; }
function scoreExistingJobForVillager(j, v, blackboard){
  if(!j) return -Infinity;
  let supplyStatus=null;
  let buildTarget=null;
  if(j.type==='build'){
    buildTarget=buildings.find(bb=>bb.id===j.bid);
    if(!buildTarget || buildTarget.built>=1) return -Infinity;
    supplyStatus=buildingSupplyStatus(buildTarget);
    if(!supplyStatus.hasAnySupply){
      j.waitingForMaterials=true;
      return -Infinity;
    }
  }
  const i=idx(j.x,j.y);
  if(j.type==='chop'&&world.trees[i]===0) return -Infinity;
  if(j.type==='mine'&&world.rocks[i]===0) return -Infinity;
  if(j.type==='sow'&&world.growth[i]>0) return -Infinity;
  if(j.type==='forage' && world.berries[j.targetI ?? i]<=0) return -Infinity;
  let distance;
  if(j.type==='build'){
    distance=buildTarget?distanceToFootprint(v.x|0, v.y|0, buildTarget):Math.abs((v.x|0)-j.x)+Math.abs((v.y|0)-j.y);
  } else {
    distance=Math.abs((v.x|0)-j.x)+Math.abs((v.y|0)-j.y);
  }
  const jobView={
    type:j.type,
    prio:j.prio,
    distance,
    supply:supplyStatus
  };
  if(j.type==='build' && supplyStatus){
    j.waitingForMaterials=!supplyStatus.fullyDelivered;
  }
  return scoreJob(jobView, v, policy, blackboard);
}
function maybeInterruptJob(v, { blackboard=null, margin=0 } = {}){
  const currentJob = v.targetJob;
  if(!currentJob) return false;
  const bb = blackboard || gameState.bb;
  const famineEmergency = bb?.famine === true && currentJob.type!=='harvest' && currentJob.type!=='sow' && currentJob.type!=='forage';
  const jobStyle = policy?.style?.jobScoring || {};
  const reprioritizeMargin = Number.isFinite(margin) ? margin : (Number.isFinite(jobStyle.reprioritizeMargin) ? jobStyle.reprioritizeMargin : 0);
  if(!famineEmergency && reprioritizeMargin<=0) return false;

  const wasAssigned = currentJob.assigned||0;
  if(wasAssigned>0){ currentJob.assigned=Math.max(0, wasAssigned-1); }
  const candidate = pickJobFor(v);
  if(wasAssigned>0){ currentJob.assigned=wasAssigned; }
  if(!candidate || candidate===currentJob) return false;

  const currentScore = scoreExistingJobForVillager(currentJob, v, bb);
  const candidateScore = scoreExistingJobForVillager(candidate, v, bb);
  if(candidateScore>currentScore+reprioritizeMargin || famineEmergency){
    finishJob(v);
    if(v.path) v.path.length=0;
    v.state='idle';
    return true;
  }
  return false;
}
// Finds an open harvest job when food is tight and a villager is free.
function findPanicHarvestJob(v){
  const bb = gameState.bb;
  let best=null, bestScore=-Infinity;
  for(const j of jobs){
    if(!j || j.type!=='harvest') continue;
    if(j.assigned>=1) continue;
    const i=idx(j.x,j.y);
    if(world.growth[i]<=0) continue;
    const distance=Math.abs((v.x|0)-j.x)+Math.abs((v.y|0)-j.y);
    const jobView={ type:j.type, prio:j.prio, distance };
    const jobScore=scoreJob(jobView, v, policy, bb);
    if(jobScore>bestScore){ bestScore=jobScore; best=j; }
  }
  return best;
}
function pickJobFor(v){
  if(v.lifeStage==='child') return null;
  let best=null,bs=-Infinity;
  const blackboard = gameState.bb;
  const minScore = typeof policy?.style?.jobScoring?.minPickScore === 'number'
    ? policy.style.jobScoring.minPickScore
    : 0;
  const jobStyle = policy?.style?.jobScoring || {};
  for(const j of jobs){
    let supplyStatus=null;
    let buildTarget=null;
    if(j.type==='hunt' && !v.equippedBow) continue;
    if(j.type==='build'){
      buildTarget=buildings.find(bb=>bb.id===j.bid);
      if(!buildTarget || buildTarget.built>=1) continue;
      supplyStatus=buildingSupplyStatus(buildTarget);
      if(!supplyStatus.hasAnySupply){
        j.waitingForMaterials=true;
        requestBuildHauls(buildTarget);
        const assistLimit = Number.isFinite(jobStyle.builderHaulAssistLimit) ? jobStyle.builderHaulAssistLimit : 1;
        if(assistLimit>0){
          const haulJobs=jobs.filter(h=>h.type==='haul' && h.bid===buildTarget.id && h.stage!=='deliver' && !h.cancelled);
          const activeHaulers=haulJobs.reduce((sum,h)=>sum+(h.assigned||0),0);
          if(activeHaulers<assistLimit){
            const openHaul=haulJobs.find(h=>(h.assigned||0)===0);
            if(openHaul){
              const haulDistance=Math.abs((v.x|0)-openHaul.x)+Math.abs((v.y|0)-openHaul.y);
              const haulView={ type:openHaul.type, prio:openHaul.prio, distance:haulDistance };
              const haulScore=scoreJob(haulView, v, policy, blackboard);
              if(haulScore>bs){ bs=haulScore; best=openHaul; }
            }
          }
        }
        continue;
      }
      if(j.assigned>=1 && !supplyStatus.fullyDelivered){
        continue;
      }
    } else {
      if(j.assigned>=1) continue;
    }
    const i=idx(j.x,j.y);
    if(j.type==='chop'&&world.trees[i]===0) continue;
    if(j.type==='mine'&&world.rocks[i]===0) continue;
    if(j.type==='sow'&&world.growth[i]>0) continue;
    if(j.type==='forage' && world.berries[j.targetI ?? i]<=0) continue;
    let distance;
    if(j.type==='build'){
      distance=buildTarget?distanceToFootprint(v.x|0, v.y|0, buildTarget):Math.abs((v.x|0)-j.x)+Math.abs((v.y|0)-j.y);
    } else if(j.type==='hunt'){
      const targetAnimal=findAnimalById(j.targetAid);
      const targetX=targetAnimal?.x ?? j.x;
      const targetY=targetAnimal?.y ?? j.y;
      distance=Math.abs((v.x|0)-Math.round(targetX))+Math.abs((v.y|0)-Math.round(targetY));
    } else {
      distance=Math.abs((v.x|0)-j.x)+Math.abs((v.y|0)-j.y);
    }
    const jobView={
      type:j.type,
      prio:j.prio,
      distance,
      supply:supplyStatus
    };
    const jobScore=scoreJob(jobView, v, policy, blackboard);
    if(j.type==='build' && supplyStatus){
      j.waitingForMaterials=!supplyStatus.fullyDelivered;
    }
    if(jobScore>bs){ bs=jobScore; best=j; }
  }
  return bs>minScore?best:null;
}
function stepAlong(v){ const next=v.path[0]; if(!next) return; const condition=v.condition||'normal'; const penalty=condition==='sick'?0.45:condition==='starving'?0.7:condition==='hungry'?0.85:condition==='recovering'?0.95:1; const moodSpeed=0.75+v.happy*0.5; const speedMultiplier=v.speed*penalty*moodSpeed*SPEEDS[speedIdx]; const stepPx=SPEED_PX_PER_SEC*speedMultiplier*SECONDS_PER_TICK; const step=stepPx/TILE; const dx=next.x-v.x, dy=next.y-v.y, dist=Math.hypot(dx,dy); if(dist<=step){ v.x=next.x; v.y=next.y; v.path.shift(); if(v.path.length===0) onArrive(v); } else { v.x+=(dx/dist)*step; v.y+=(dy/dist)*step; } }
function onArrive(v){ const cx=v.x|0, cy=v.y|0, i=idx(cx,cy);
if(v.state==='chop'){
  let remove = world.trees[i]<=0;
  if(world.trees[i]>0){
    world.trees[i]--;
    dropItem(cx,cy,ITEM.WOOD,1);
    if(world.trees[i]===0){
      world.tiles[i]=TILES.GRASS;
      markStaticDirty();
      remove = true;
    }
    v.thought=moodThought(v,'Chopped');
  } else {
    v.thought=moodThought(v,'Nothing to chop');
  }
  addJobExperience(v, 'chop', remove ? 2 : 1);
  v.state='idle';
  finishJob(v, remove);
}
else if(v.state==='mine'){
  let remove = world.rocks[i]<=0;
  if(world.rocks[i]>0){
    world.rocks[i]--;
    dropItem(cx,cy,ITEM.STONE,1);
    if(world.rocks[i]===0){
      world.tiles[i]=TILES.GRASS;
      markStaticDirty();
      remove = true;
    }
    v.thought=moodThought(v,'Mined');
  } else {
    v.thought=moodThought(v,'Nothing to mine');
  }
  v.state='idle';
  applySkillGain(v, 'constructionSkill', 0.016, 0.88, 1);
  addJobExperience(v, 'mine', remove ? 2 : 1);
  finishJob(v, remove);
}
else if(v.state==='hunt'){
  const job=v.targetJob;
  const animal=job?findAnimalById(job.targetAid):null;
  const lodge=job?buildings.find(bb=>bb.id===job.bid && bb.kind==='hunterLodge'):null;
  if(!job || !animal || animal.state==='dead'){
    v.thought=moodThought(v,'Lost prey');
    v.state='idle';
    finishJob(v, true);
    return;
  }
  const dist=Math.hypot(animal.x-v.x, animal.y-v.y);
  if(dist>HUNT_RANGE+0.2){
    const approach=findHuntApproachPath(v, animal, { range:HUNT_RANGE });
    if(approach?.path){
      v.path=approach.path;
      v.state='hunt';
      v.thought=moodThought(v,'Stalking');
      return;
    }
    suppressJob(job, HUNT_RETRY_COOLDOWN);
    v.thought=moodThought(v,'Prey escaped');
    v.state='idle';
    finishJob(v, true);
    return;
  }
  const behavior=ANIMAL_BEHAVIORS[animal.type] || {};
  const skill=effectiveSkillFromExperience(v, 'constructionSkill', 0.5, 'hunt');
  const moodFactor=clamp((v.happy-0.5)*0.5,-0.15,0.2);
  const lodgeBonus=Number.isFinite(lodge?.effects?.gameYieldBonus)?lodge.effects.gameYieldBonus*0.2:0;
  const successChance=clamp(0.55 + skill*0.25 + moodFactor + lodgeBonus, 0.25, 0.95);
  if(R()<successChance){
    const yieldResult=resolveHuntYield({ animal, lodge });
    dropItem(animal.x|0, animal.y|0, ITEM.FOOD, yieldResult.meat);
    if(yieldResult.pelts>0){
      dropItem(animal.x|0, animal.y|0, 'pelt', yieldResult.pelts);
    }
    queueAnimalLabel('Taken', '#ffd27f', animal.x+0.1, animal.y-0.1);
    removeAnimal(animal);
    v.happy=clamp(v.happy+0.06,0,1);
    applySkillGain(v, 'constructionSkill', 0.014, 0.9, 1);
    addJobExperience(v, 'hunt', 2.5);
    v.thought=moodThought(v,'Successful hunt');
  } else {
    animal.state='flee';
    animal.target=chooseFleeTarget(animal, v, behavior, new Map());
    animal.fleeTicks=Math.round((behavior.roamTicks?.[0]||40)*0.8);
    v.happy=clamp(v.happy-0.015,0,1);
    applySkillGain(v, 'constructionSkill', 0.008, 0.9, 1);
    suppressJob(job, HUNT_RETRY_COOLDOWN);
    addJobExperience(v, 'hunt', 1);
    v.thought=moodThought(v,'Missed the shot');
  }
  v.state='idle';
  finishJob(v, true);
}
else if(v.state==='forage'){
  if(Number.isInteger(v.targetI) && world.berries[v.targetI]>0){
    world.berries[v.targetI]--;
    if((v.starveStage||0)>=2 || v.condition==='sick'){
      v.hunger-=FOOD_HUNGER_RECOVERY;
      if(v.hunger<0) v.hunger=0;
      handleVillagerFed(v,'berries');
      v.thought=moodThought(v,'Ate berries');
    } else {
      v.inv={type:ITEM.FOOD,qty:1};
      v.thought=moodThought(v,'Got berries');
    }
  } else {
    v.thought=moodThought(v,'Berries gone');
  }
  addJobExperience(v, 'forage', 1);
  v.state='idle';
  finishJob(v, true);
}
else if(v.state==='seek_food'){
  if(!v.inv){
    const itemKey=(cy*GRID_W)+cx;
    const itemIndex=itemTileIndex.get(itemKey);
    const it=itemIndex!==undefined?itemsOnGround[itemIndex]:null;
    if(it && it.type===ITEM.FOOD){
      v.inv={type:ITEM.FOOD,qty:it.qty};
      removeItemAtIndex(itemIndex);
    }
  }
  if(consumeFood(v)){
    v.thought=moodThought(v,'Eating');
  } else if(v.inv && v.inv.type===ITEM.FOOD){
    v.thought=moodThought(v,'Holding food');
  } else {
    v.thought=moodThought(v,'No food found');
  }
  v.state='idle';
}
else if(v.state==='sow'){
  if(world.tiles[i]!==TILES.WATER){
    world.tiles[i]=TILES.FARMLAND;
    world.growth[i]=1;
    world.zone[i]=ZONES.FARM;
    ensureRowMasksSize();
    zoneRowMask[cy]=1;
    markStaticDirty();
    v.thought=moodThought(v,'Sowed');
  } else {
    v.thought=moodThought(v,'Too wet to sow');
  }
  v.state='idle';
  applySkillGain(v, 'farmingSkill', 0.012, 0.9, 1);
  addJobExperience(v, 'sow', 1);
  finishJob(v, true);
}
else if(v.state==='harvest'){
  if(world.growth[i]>0){
    // Balance knob: base yield per crop tile.
    let yieldAmount=2;
    const { harvestBonus } = agricultureBonusesAt(cx,cy);
    if(harvestBonus>0){
      const whole=Math.floor(harvestBonus);
      yieldAmount+=whole;
      const frac=harvestBonus-whole;
      if(frac>0 && R()<frac) yieldAmount+=1;
    }
    dropItem(cx,cy,ITEM.FOOD,yieldAmount);
    const harvestThought=yieldAmount>1?'Bountiful harvest':'Harvested';
    v.thought=moodThought(v,harvestThought);
  } else {
    v.thought=moodThought(v,'Nothing to harvest');
  }
  world.growth[i]=0;
  v.state='idle';
  applySkillGain(v, 'farmingSkill', 0.018, 0.9, 1);
  addJobExperience(v, 'harvest', 2);
  finishJob(v, true);
}
else if(v.state==='build'){
  let remove=false;
  const b=buildings.find(bb=>bb.id===v.targetJob?.bid);
  if(b){
    ensureBuildingData(b);
    const def=BUILDINGS[b.kind]||{};
    const cost=def.cost||((def.wood||0)+(def.stone||0));
    if(b.built<1){
      const store=b.store||{};
      const spent=b.spent||{wood:0,stone:0};
      let used=0;
      if(def.wood){
        const needWood=Math.max(0, (def.wood||0)-(spent.wood||0));
        if(needWood>0 && (store.wood||0)>0){
          const take=Math.min(needWood, store.wood);
          store.wood-=take;
          spent.wood=(spent.wood||0)+take;
          used+=take;
        }
      }
      if(def.stone){
        const needStone=Math.max(0, (def.stone||0)-(spent.stone||0));
        if(needStone>0 && (store.stone||0)>0){
          const take=Math.min(needStone, store.stone);
          store.stone-=take;
          spent.stone=(spent.stone||0)+take;
          used+=take;
        }
      }
      b.progress=(spent.wood||0)+(spent.stone||0);
      if(b.progress>=cost){
        b.built=1;
        spent.wood=def.wood||0;
        spent.stone=def.stone||0;
        b.progress=cost;
        if(b.kind==='campfire') markEmittersDirty();
        cancelHaulJobsForBuilding(b);
        markStaticDirty();
        v.thought=moodThought(v,'Built');
        remove=true;
      } else {
        requestBuildHauls(b);
        v.thought=moodThought(v, used>0 ? 'Building' : 'Needs supplies');
      }
    } else {
      v.thought=moodThought(v,'Built');
      cancelHaulJobsForBuilding(b);
      remove=true;
    }
  } else {
    const bid=v.targetJob?.bid;
    if(bid){ cancelHaulJobsForBuilding({id:bid}); }
    v.thought=moodThought(v,'Site missing');
    remove=true;
  }
  applySkillGain(v, 'constructionSkill', remove ? 0.02 : 0.012, 0.9, 1);
  addJobExperience(v, 'build', remove ? 3 : 1);
  v.state='idle';
  finishJob(v, remove);
}
else if(v.state==='haul_pickup'){
  const job=v.targetJob;
  const res=job?.resource;
  const qty=job?.qty||0;
  const b=job?buildings.find(bb=>bb.id===job.bid):null;
  if(!job || job.type!=='haul' || !res || qty<=0){
    if(job && job.type==='haul' && job.stage==='pickup'){ const r=job.resource; storageReserved[r]=Math.max(0,(storageReserved[r]||0)-qty); if(b){ ensureBuildingData(b); b.pending[r]=Math.max(0,(b.pending[r]||0)-qty); } }
    v.thought=moodThought(v,'Idle');
    v.state='idle';
    finishJob(v, true);
    return;
  }
  ensureBuildingData(b);
  if(!b || b.built>=1){
    storageReserved[res]=Math.max(0,(storageReserved[res]||0)-qty);
    if(b){ b.pending[res]=Math.max(0,(b.pending[res]||0)-qty); }
    v.thought=moodThought(v,'Site stocked');
    v.state='idle';
    finishJob(v, true);
    return;
  }
  const available=storageTotals[res]||0;
  if(available>=qty){
    storageTotals[res]-=qty;
    storageReserved[res]=Math.max(0,(storageReserved[res]||0)-qty);
    v.inv={type:res,qty};
    job.stage='deliver';
    v.thought=moodThought(v,'Loaded supplies');
    let dest=job.dest||{x:b.x,y:b.y};
    const targetBuilding=job.dest?buildingAt(dest.x,dest.y):b;
    if(targetBuilding){
      const entry=findEntryTileNear(targetBuilding, cx, cy) || {x:Math.round(buildingCenter(targetBuilding).x), y:Math.round(buildingCenter(targetBuilding).y)};
      dest=entry;
    }
    const p=pathfind(cx,cy,dest.x,dest.y);
    if(p){
      v.path=p;
      v.state='haul_deliver';
      return;
    }
    storageTotals[res]+=qty;
    v.inv=null;
    b.pending[res]=Math.max(0,(b.pending[res]||0)-qty);
    v.thought=moodThought(v,'Path blocked');
    v.state='idle';
    finishJob(v, true);
  } else {
    storageReserved[res]=Math.max(0,(storageReserved[res]||0)-qty);
    b.pending[res]=Math.max(0,(b.pending[res]||0)-qty);
    v.thought=moodThought(v,'Needs supplies');
    v.state='idle';
    finishJob(v, true);
  }
}
else if(v.state==='haul_deliver'){
  const job=v.targetJob;
  const res=job?.resource;
  const carrying=v.inv;
  const b=job?buildings.find(bb=>bb.id===job.bid):null;
  v.thought=moodThought(v,'Idle');
  if(job && job.type==='haul' && carrying && carrying.type===res){
    const qty=carrying.qty||0;
    v.inv=null;
    if(b){ ensureBuildingData(b); }
    if(b && b.built<1 && !job?.cancelled){
      b.store[res]=(b.store[res]||0)+qty;
      requestBuildHauls(b);
      v.thought=moodThought(v,'Delivered supplies');
    } else {
      storageTotals[res]=(storageTotals[res]||0)+qty;
      v.thought=moodThought(v,'Returned supplies');
    }
    if(b){ b.pending[res]=Math.max(0,(b.pending[res]||0)-qty); }
    applySkillGain(v, 'constructionSkill', 0.01, 0.9, 1);
    addJobExperience(v, 'haul', 1);
  } else if(job && job.type==='haul' && job.stage==='pickup'){
    const qty=job.qty||0;
    if(res){
      storageReserved[res]=Math.max(0,(storageReserved[res]||0)-qty);
      if(b){ ensureBuildingData(b); b.pending[res]=Math.max(0,(b.pending[res]||0)-qty); }
    }
  }
  v.state='idle';
  finishJob(v, true);
}
else if(v.state==='craft_bow'){
  const job=v.targetJob;
  const recipe=job?.materials || CRAFTING_RECIPES.bow;
  const lodge=job?buildings.find(bb=>bb.id===job.bid && bb.kind==='hunterLodge'):null;
  if(!job || !lodge || lodge.built<1){
    releaseReservedMaterials(recipe||{});
    v.thought=moodThought(v,'No lodge');
    v.state='idle';
    finishJob(v, true);
    return;
  }
  if(!spendCraftMaterials(recipe||{})){
    v.thought=moodThought(v,'Missing supplies');
    v.state='idle';
    finishJob(v, true);
    return;
  }
  const storage=findNearestBuilding(cx,cy,'storage');
  if(storage){
    storageTotals.bow=(storageTotals.bow||0)+1;
    v.thought=moodThought(v,'Crafted bow');
  } else if(!v.inv){
    v.inv={ type:ITEM.BOW, qty:1 };
    v.thought=moodThought(v,'Crafted bow');
  } else {
    dropItem(cx,cy,ITEM.BOW,1);
    v.thought=moodThought(v,'Dropped bow');
  }
  applySkillGain(v, 'constructionSkill', 0.012, 0.9, 1);
  addJobExperience(v, 'craft_bow', 2.5);
  v.state='idle';
  finishJob(v, true);
}
else if(v.state==='equip_bow'){
  const storage=v.targetBuilding||findNearestBuilding(cx,cy,'storage');
  if(storage && spendCraftMaterials({ bow:1 })){
    v.equippedBow=true;
    v.thought=moodThought(v,'Equipped bow');
  } else {
    v.thought=moodThought(v,'No bow available');
  }
  v.state='idle';
  v.targetBuilding=null;
}
else if(v.state==='to_storage'){
  if(v.inv){
    if(v.inv.type===ITEM.FOOD && ((v.starveStage||0)>=2 || v.condition==='sick')){
      consumeFood(v);
      v.thought=moodThought(v,'Ate supplies');
    } else {
      if(v.inv.type===ITEM.WOOD) storageTotals.wood+=v.inv.qty;
      if(v.inv.type===ITEM.STONE) storageTotals.stone+=v.inv.qty;
      if(v.inv.type===ITEM.FOOD) storageTotals.food+=v.inv.qty;
      if(v.inv.type===ITEM.BOW) storageTotals.bow+=v.inv.qty;
      v.inv=null;
      v.thought=moodThought(v,'Stored');
    }
  }
  v.state='idle';
}
else if(v.state==='rest'){
  const baseRest=REST_BASE_TICKS+Math.round(Math.max(0,1-v.energy)*REST_EXTRA_PER_ENERGY);
  const b=v.targetBuilding||getBuildingById(v.activeBuildingId)||buildingAt(cx,cy);
  if(b) setActiveBuilding(v,b);
  if(b) noteBuildingActivity(b,'rest');
  if(v.restTimer<baseRest) v.restTimer=baseRest;
  v.state='resting';
  v.thought=moodThought(v,'Resting');
}
else if(v.state==='hydrate'){
  const b=v.targetBuilding||getBuildingById(v.activeBuildingId)||buildingAt(cx,cy);
  if(b) setActiveBuilding(v,b);
  if(b) noteBuildingActivity(b,'hydrate');
  v.hydrationTimer=Math.max(v.hydrationTimer||0, Math.round(HYDRATION_BUFF_TICKS*0.25));
  v.hydration=1;
  v.hydrationBuffTicks=Math.max(v.hydrationBuffTicks, HYDRATION_BUFF_TICKS);
  v.state='hydrating';
  v.thought=moodThought(v,'Drinking');
}
else if(v.state==='socialize'){
  const b=v.targetBuilding||getBuildingById(v.activeBuildingId)||buildingAt(cx,cy);
  if(b) setActiveBuilding(v,b);
  if(b) noteBuildingActivity(b,'social');
  v.socialTimer=Math.max(v.socialTimer||0, SOCIAL_BASE_TICKS);
  v.state='socializing';
  v.thought=moodThought(v,'Gathering');
}
else if(v.state==='storage_idle'){
  const b=v.targetBuilding||getBuildingById(v.activeBuildingId)||buildingAt(cx,cy);
  if(b) setActiveBuilding(v,b);
  if(b) noteBuildingActivity(b,'use');
  v.storageIdleTimer=Math.max(v.storageIdleTimer||0, STORAGE_IDLE_BASE);
  v.state='storage_linger';
  v.thought=moodThought(v,'Tidying storage');
} }

/* ==================== Seasons/Growth ==================== */
function seasonTick(){
  world.tSeason++;
  const SEASON_LEN=60*10;
  if(world.tSeason>=SEASON_LEN){
    world.tSeason=0;
    world.season=(world.season+1)%4;
  }
  const hasFarmBoosters=buildings.some(b=>b.built>=1 && (b.kind==='farmplot'||b.kind==='well'));
  const creationCfg = getJobCreationConfig();
  ensureBlackboardSnapshot();
  for(let i=0;i<world.growth.length;i++){
    if(world.tiles[i]!==TILES.FARMLAND) continue;
    const prev=world.growth[i];
    if(prev<=0 || prev>=240) continue;
    const y=(i/GRID_W)|0, x=i%GRID_W;
    // Crop balance knob: faster base growth to help farms stabilize food.
    let delta=1.2;
    if(hasFarmBoosters){
      const { growthBonus } = agricultureBonusesAt(x,y);
      if(growthBonus>0){
        const whole=Math.floor(growthBonus);
        delta += whole;
        const frac=growthBonus-whole;
        if(frac>0 && R()<frac) delta+=1;
      }
    }
    const next=Math.min(240, prev+delta);
    world.growth[i]=next;
    // Slightly earlier harvest window so ripe food gets picked before withering.
    if(prev<150 && next>=150){
      if(!violatesSpacing(x,y,'harvest',creationCfg)){
        addJob({type:'harvest',x,y, prio:0.65+(policy.sliders.food||0)*0.6});
      }
    }
  }
}

/* ==================== Rendering ==================== */
let staticAlbedoCanvas=null, staticAlbedoCtx=null, staticDirty=true;
function markStaticDirty(){ staticDirty=true; }

const _saveSystem = createSaveSystem({
  getWorld: () => world,
  getBuildings: () => buildings,
  getVillagers: () => villagers,
  getAnimals: () => animals,
  getStorageTotals: () => storageTotals,
  getStorageReserved: () => storageReserved,
  getTick: () => tick,
  starveThresh: STARVE_THRESH,
  childhoodTicks: CHILDHOOD_TICKS,
  ensureVillagerNumber,
  normalizeExperienceLedger,
  normalizeArraySource,
  applyArrayScaled,
  newWorld,
  getFootprint,
  ensureBuildingData,
  reindexAllBuildings,
  markEmittersDirty,
  refreshWaterRowMaskFromTiles,
  refreshZoneRowMask,
  markZoneOverlayDirty,
  markStaticDirty,
  toast: Toast
});
const saveGame = _saveSystem.saveGame;
const loadGame = _saveSystem.loadGame;

const _renderSystem = createRenderSystem({
  getCam: () => cam,
  getViewportW: () => W,
  getViewportH: () => H
});
const setCurrentAmbient = _renderSystem.setCurrentAmbient;
const resetLightmapCache = _renderSystem.resetLightmapCache;
const shadeFillColorLit = _renderSystem.shadeFillColorLit;
const applySpriteShadeLit = _renderSystem.applySpriteShadeLit;
const entityDrawRect = _renderSystem.entityDrawRect;
const visibleTileBounds = _renderSystem.visibleTileBounds;
const buildHillshadeQ = _renderSystem.buildHillshadeQ;
const buildLightmap = _renderSystem.buildLightmap;
const sampleLightAt = _renderSystem.sampleLightAt;

function drawStaticAlbedo(){ if(!staticAlbedoCanvas){ staticAlbedoCanvas=makeCanvas(GRID_W*TILE, GRID_H*TILE); staticAlbedoCtx=context2d(staticAlbedoCanvas); } if(!world) return; const g=staticAlbedoCtx; if(!g) return; ensureRowMasksSize();
  for(let y=0;y<GRID_H;y++){
    let rowHasWater=0;
    const rowStart=y*GRID_W;
    for(let x=0;x<GRID_W;x++){ const i=rowStart+x, t=world.tiles[i];
      let img=Tileset.base.grass;
      if(t===TILES.GRASS) img=Tileset.base.grass;
      else if(t===TILES.FERTILE) img=Tileset.base.fertile;
      else if(t===TILES.MEADOW) img=Tileset.base.meadow;
      else if(t===TILES.MARSH) img=Tileset.base.marsh;
      else if(t===TILES.SAND) img=Tileset.base.sand;
      else if(t===TILES.SNOW) img=Tileset.base.snow;
      else if(t===TILES.ROCK) img=Tileset.base.rock;
      else if(t===TILES.WATER) img=Tileset.base.water;
      else if(t===TILES.FARMLAND) img=Tileset.base.farmland;
      g.drawImage(img,x*TILE,y*TILE);
      if(t===TILES.WATER) rowHasWater=1;
    }
    waterRowMask[y]=rowHasWater;
  }
  world.staticAlbedoCanvas = staticAlbedoCanvas;
  world.staticAlbedoCtx = staticAlbedoCtx;
  staticDirty=false; }


function drawShadow(tileX, tileY, footprintW=1, footprintH=1, screenRect=null){
  if (!ctx || !world || !world.tiles) return;
  if (!SHADOW_TEXTURE) return;
  if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return;
  if (LIGHTING.mode === 'off') return;

  const tiles = world.tiles;
  if (!tiles || tiles.length !== GRID_SIZE) return;

  const safeFootprintW = Number.isFinite(footprintW) && footprintW > 0 ? footprintW : 1;
  const safeFootprintH = Number.isFinite(footprintH) && footprintH > 0 ? footprintH : 1;

  const startX = Math.floor(tileX);
  const startY = Math.floor(tileY);
  const tilesWide = Math.max(1, Math.ceil(safeFootprintW));
  const tilesHigh = Math.max(1, Math.ceil(safeFootprintH));
  let hasGround = false;
  for (let oy=0; oy<tilesHigh; oy++){
    const ty = startY + oy;
    if (ty < 0 || ty >= GRID_H) continue;
    const rowStart = ty * GRID_W;
    for (let ox=0; ox<tilesWide; ox++){
      const tx = startX + ox;
      if (tx < 0 || tx >= GRID_W) continue;
      hasGround = true;
      if (tiles[rowStart + tx] === TILES.WATER){
        return;
      }
    }
  }
  if (!hasGround) return;

  const centerTileX = tileX + safeFootprintW * 0.5;
  const centerTileY = tileY + safeFootprintH * 0.5;

  let widthPx = TILE * cam.z * safeFootprintW;
  let heightPx = TILE * cam.z * safeFootprintH;
  if (screenRect && Number.isFinite(screenRect.w) && Number.isFinite(screenRect.h)){
    widthPx = Math.max(screenRect.w, 0);
    heightPx = Math.max(screenRect.h, 0);
  }

  let baseCenterX = tileToPxX(centerTileX, cam);
  let baseCenterY = tileToPxY(centerTileY, cam);
  if (screenRect && Number.isFinite(screenRect.x) && Number.isFinite(screenRect.y)){
    baseCenterX = screenRect.x + widthPx * 0.5;
    baseCenterY = screenRect.y + heightPx * 0.5;
  }

  const baseSize = Math.max(widthPx, heightPx);
  if (!(baseSize > 0)) return;
  const radiusX = Math.max(cam.z * 2.2, baseSize * 0.45);
  const radiusY = Math.max(cam.z * 1.2, baseSize * 0.28);
  const offsetMagnitude = Math.max(radiusX, radiusY) * 0.42;
  const centerX = baseCenterX + SHADOW_DIRECTION.x * offsetMagnitude;
  let centerY = baseCenterY + SHADOW_DIRECTION.y * offsetMagnitude;
  centerY += radiusY * 0.25;

  const alpha = clamp01(0.22 + 0.05 * cam.z);

  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.save();
  ctx.globalCompositeOperation='multiply';
  ctx.globalAlpha = alpha;
  ctx.translate(centerX, centerY);
  ctx.rotate(SHADOW_DIRECTION_ANGLE);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(SHADOW_TEXTURE, -radiusX, -radiusY, radiusX * 2, radiusY * 2);
  ctx.restore();
  ctx.imageSmoothingEnabled = prevSmoothing;
}

function maybeBuildLightmap(targetWorld, ambient){
  return _renderSystem.maybeBuildLightmap(targetWorld, ambient, normalizeShadingMode);
}

function ensureZoneOverlayCanvas(){
  const width = GRID_W * TILE;
  const height = GRID_H * TILE;
  let canvas = zoneOverlayCache.canvas;
  if (!canvas || canvas.width !== width || canvas.height !== height){
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : makeCanvas(width, height);
    zoneOverlayCache.canvas = canvas;
    zoneOverlayCache.ctx = context2d(canvas);
    zoneOverlayCache.dirty = true;
  }
  return zoneOverlayCache.canvas && zoneOverlayCache.ctx;
}

function activeZoneSignature(activeZoneJobs){
  const parts = [];
  for (const key of ['sow','chop','mine']){
    const sorted = Array.from(activeZoneJobs[key] || []).sort((a,b) => a-b);
    parts.push(`${key}:${sorted.join(',')}`);
  }
  return parts.join('|');
}

function rebuildZoneOverlay(activeZoneJobs){
  if (!ensureZoneOverlayCanvas()) return;
  const g = zoneOverlayCache.ctx;
  const canvas = zoneOverlayCache.canvas;
  g.clearRect(0, 0, canvas.width, canvas.height);
  const tileSize = TILE;
  const active = {
    sow: activeZoneJobs.sow || new Set(),
    chop: activeZoneJobs.chop || new Set(),
    mine: activeZoneJobs.mine || new Set()
  };
  for(let y=0; y<GRID_H; y++){
    if(!zoneRowMask[y]) continue;
    const rowStart=y*GRID_W;
    for(let x=0; x<GRID_W; x++){
      const i=rowStart+x; const z=world.zone[i]; if(z===ZONES.NONE) continue;
      if(!zoneHasWorkNow(z, i)) continue;
      const jobType=zoneJobType(z);
      if(jobType){ const activeSet=active[jobType]; if(activeSet && activeSet.has(i)) continue; }
      const wash = z===ZONES.FARM ? 'rgba(120,220,120,0.25)'
                 : z===ZONES.CUT  ? 'rgba(255,190,110,0.22)'
                 :                   'rgba(160,200,255,0.22)';
      g.fillStyle=wash;
      const px = x * tileSize;
      const py = y * tileSize;
      g.fillRect(px, py, tileSize, tileSize);
      const glyph = z===ZONES.FARM ? Tileset.zoneGlyphs.farm : z===ZONES.CUT ? Tileset.zoneGlyphs.cut : Tileset.zoneGlyphs.mine;
      g.globalAlpha=0.6;
      for(let yy=4; yy<TILE; yy+=10){ for(let xx=4; xx<TILE; xx+=10){
        g.drawImage(glyph, 0,0,8,8, px+xx, py+yy, 8, 8);
      } }
      g.globalAlpha=1;
    }
  }
}

function drawZoneOverlay(activeZoneJobs, camState, baseDx, baseDy){
  const signature = activeZoneSignature(activeZoneJobs);
  if (zoneOverlayCache.lastActiveSignature !== signature){
    zoneOverlayCache.lastActiveSignature = signature;
    zoneOverlayCache.dirty = true;
  }
  if (zoneOverlayCache.lastScale !== camState.z){
    zoneOverlayCache.lastScale = camState.z;
    zoneOverlayCache.dirty = true;
  }
  if (zoneOverlayCache.dirty){
    rebuildZoneOverlay(activeZoneJobs);
    zoneOverlayCache.dirty = false;
  }
  const canvas = zoneOverlayCache.canvas;
  if (!canvas) return;
  const destW = canvas.width * camState.z;
  const destH = canvas.height * camState.z;
  ctx.drawImage(canvas, 0,0, canvas.width, canvas.height, baseDx, baseDy, destW, destH);
}

function ensureWaterOverlayCanvas(){
  const sizeChanged = !waterOverlayCache.canvas || waterOverlayCache.width !== W || waterOverlayCache.height !== H;
  if (!sizeChanged && waterOverlayCache.canvas) return true;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : makeCanvas(W, H);
  waterOverlayCache.canvas = canvas;
  waterOverlayCache.ctx = context2d(canvas, { alpha:true });
  waterOverlayCache.width = W;
  waterOverlayCache.height = H;
  waterOverlayCache.frameIndex = -1;
  return Boolean(waterOverlayCache.canvas && waterOverlayCache.ctx);
}

function drawWaterOverlay(frames, frameIndex, vis){
  if (!frames.length || !ensureWaterOverlayCanvas()) return;
  const needsRedraw = waterOverlayCache.frameIndex !== frameIndex
    || waterOverlayCache.camX !== cam.x
    || waterOverlayCache.camY !== cam.y
    || waterOverlayCache.camZ !== cam.z
    || waterOverlayCache.width !== W
    || waterOverlayCache.height !== H;
  if (needsRedraw){
    const g = waterOverlayCache.ctx;
    g.clearRect(0, 0, waterOverlayCache.width, waterOverlayCache.height);
    for(let y=vis.y0; y<=vis.y1; y++){
      if(!waterRowMask[y]) continue;
      const rowStart=y*GRID_W;
      for(let x=vis.x0; x<=vis.x1; x++){ const i=rowStart+x; if(world.tiles[i]===TILES.WATER){
        const px = tileToPxX(x, cam);
        const py = tileToPxY(y, cam);
        g.drawImage(frames[frameIndex], 0,0,TILE,TILE, px, py, TILE*cam.z, TILE*cam.z);
      } }
    }
    waterOverlayCache.frameIndex = frameIndex;
    waterOverlayCache.camX = cam.x;
    waterOverlayCache.camY = cam.y;
    waterOverlayCache.camZ = cam.z;
  }
  ctx.drawImage(waterOverlayCache.canvas, 0, 0);
}

function render(){
  if (world && world.__debug != null) {
    world.__debug.pipeline = [];
    world.__debug.lastFrame = (world.__debug.lastFrame != null) ? (world.__debug.lastFrame + 1) : 1;
    world.__debug.layerOrder = LAYER_ORDER;
  }
  function __ck(name, ok, extra) {
    const entry = { name: name, ok: ok === true, extra: extra || null };
    const debugKit = window.DebugKit;
    if (debugKit != null && typeof debugKit.checkpoint === 'function') {
      try {
        debugKit.checkpoint(name, entry.ok, entry.extra);
      } catch (e) {
        // ignore checkpoint errors
      }
    }
    if (world && world.__debug != null && Array.isArray(world.__debug.pipeline)) {
      world.__debug.pipeline.push(entry);
    }
  }

  if(!ctx || !world) return;

  world.dayTime = dayTime;

  const shadingMode = normalizeShadingMode(LIGHTING.mode);
  if (LIGHTING.mode !== shadingMode) LIGHTING.mode = shadingMode;
  const ambient = shadingMode === 'off' ? 1 : ambientAt(dayTime);
  const nightActive = isNightAmbient(ambient);
  setCurrentAmbient(ambient);

  villagerLabels.length = 0;

  if (!Array.isArray(world.emitters)) world.emitters = [];
  if (emittersDirty
      || world._emittersShadingMode !== shadingMode
      || world._emittersNightActive !== nightActive) {
    world.emitters.length = 0;
    if (shadingMode !== 'off') {
      const campfires = buildingsByKind.get('campfire');
      if (campfires){
        const intensity = nightActive ? 0.55 : 0.4;
        for (const b of campfires){
          if((b.built||0) < 1) continue;
          const fp = getFootprint(b.kind);
          world.emitters.push({
            x: b.x + (fp?.w||1)*0.5,
            y: b.y + (fp?.h||1)*0.5,
            radius: 7.5,
            intensity,
            falloff: 2.0,
            flicker: true
          });
        }
      }
    }
    world._emittersShadingMode = shadingMode;
    world._emittersNightActive = nightActive;
    emittersDirty = false;
  }

  const useMultiply = shadingMode !== 'off' && LIGHTING.useMultiplyComposite;
  let compositeLogged = false;
  let compositeError = null;
  let spritesError = null;

  const logComposite = (ok, extra) => {
    __ck('composite:multiply', ok, extra);
    compositeLogged = true;
  };

  if(staticDirty) drawStaticAlbedo();
  ctx.setTransform(1,0,0,1,0,0);
  __ck('albedo:begin', true, null);
  ctx.fillStyle='#0a0c10';
  ctx.fillRect(0,0,W,H);
  // base map scaled by cam.z (match tileToPx flooring for consistent transforms)
  const baseDx = tileToPxX(0, cam);
  const baseDy = tileToPxY(0, cam);
  if(staticAlbedoCanvas){
    ctx.drawImage(staticAlbedoCanvas, 0,0, staticAlbedoCanvas.width, staticAlbedoCanvas.height,
      baseDx, baseDy,
      staticAlbedoCanvas.width*cam.z, staticAlbedoCanvas.height*cam.z);
  }

  let t0,t1,t2;
  if(PERF.log) t0 = performance.now();

  const vis = visibleTileBounds();
  const x0=vis.x0, y0=vis.y0, x1=vis.x1, y1=vis.y1;

  // animated water overlay
  const frames = Tileset.waterOverlay || [];
  if(frames.length){
    const frame = Math.floor((tick/10)%frames.length);
    drawWaterOverlay(frames, frame, vis);
  }

  drawZoneOverlay(activeZoneJobs, cam, baseDx, baseDy);

  __ck('albedo:end', true, null);

  const lightingReady = (typeof LIGHTING !== 'undefined' && LIGHTING.mode != 'off')
    && (world.hillshadeQ != null || world.lightmapQ != null);
  __ck('lighting:ready', lightingReady === true, {
    mode: (typeof LIGHTING !== 'undefined') ? LIGHTING.mode : 'unknown',
    hasHillshadeQ: world.hillshadeQ != null,
    hasLightmapQ: world.lightmapQ != null
  });

  try {
    if (typeof LIGHTING !== 'undefined' && LIGHTING.mode != 'off') {
      const updated = maybeBuildLightmap(world, ambient);
      const size = (world.lightmapCanvas != null) ? { w: world.lightmapCanvas.width, h: world.lightmapCanvas.height } : null;
      const ready = !!(world.lightmapCanvas && world.lightmapQ);
      __ck('lightmap:build', ready, { size, updated });
    } else {
      __ck('lightmap:build', false, { reason: 'lighting off' });
    }
  } catch (e) {
    const err = e && e.message ? e.message : e;
    __ck('lightmap:build', false, { error: String(err) });
  }

  if(!useMultiply && shadingMode !== 'off' && world.lightmapCanvas){
    ctx.save();
    ctx.globalCompositeOperation='multiply';
    const destW = staticAlbedoCanvas ? staticAlbedoCanvas.width*cam.z : GRID_W*TILE*cam.z;
    const destH = staticAlbedoCanvas ? staticAlbedoCanvas.height*cam.z : GRID_H*TILE*cam.z;
    ctx.drawImage(world.lightmapCanvas, 0,0, world.lightmapCanvas.width, world.lightmapCanvas.height,
      baseDx, baseDy,
      destW, destH);
    ctx.restore();
  }

  try {
    // vegetation/crops
    for(let y=y0;y<=y1;y++){ const rowStart=y*GRID_W; for(let x=x0;x<=x1;x++){ const i=rowStart+x;
      if(world.tiles[i]===TILES.FOREST && world.trees[i]>0){
        drawShadow(x, y, 1, 1);
        const rect = entityDrawRect(x, y, cam);
        const raisedY = rect.y - Math.round(cam.z*TREE_VERTICAL_RAISE);
        const light = useMultiply ? 1 : sampleLightAt(world, x, y);
        ctx.save();
        ctx.drawImage(Tileset.sprite.tree, 0,0,ENTITY_TILE_PX,ENTITY_TILE_PX, rect.x, raisedY, rect.size, rect.size);
        applySpriteShadeLit(ctx, rect.x, raisedY, rect.size, rect.size, light);
        ctx.restore();
      }
      if(world.berries[i]>0){
        drawShadow(x, y, 1, 1);
        const rect = entityDrawRect(x, y, cam);
        const light = useMultiply ? 1 : sampleLightAt(world, x, y);
        ctx.save();
        ctx.drawImage(Tileset.sprite.berry, 0,0,ENTITY_TILE_PX,ENTITY_TILE_PX, rect.x, rect.y, rect.size, rect.size);
        applySpriteShadeLit(ctx, rect.x, rect.y, rect.size, rect.size, light);
        ctx.restore();
      }
      if(world.tiles[i]===TILES.FARMLAND && world.growth[i]>0){
        drawShadow(x, y, 1, 1);
        const stageIndex=Math.min(2, Math.floor(world.growth[i]/80));
        const rect = entityDrawRect(x, y, cam);
        ctx.save();
        ctx.drawImage(Tileset.sprite.sprout[stageIndex], 0,0,ENTITY_TILE_PX,ENTITY_TILE_PX, rect.x, rect.y, rect.size, rect.size);
        ctx.restore();
      }
    } }

    if(PERF.log) t1 = performance.now();

    for(const creature of animals){ drawAnimal(creature, useMultiply); }

    // buildings
    for(const b of buildings){
      const gx = tileToPxX(b.x, cam);
      const gy = tileToPxY(b.y, cam);
      drawBuildingAt(gx, gy, b);
    }

    // items
    for(const it of itemsOnGround){
      const gx = tileToPxX(it.x, cam);
      const gy = tileToPxY(it.y, cam);
      const light = useMultiply ? 1 : sampleLightAt(world, it.x, it.y);
      const tileSize = TILE*cam.z;
      const centerX = Math.round(gx + tileSize*0.5);
      const centerY = Math.round(gy + tileSize*0.5);
      const size = Math.max(2, Math.round(4*cam.z));
      const half = Math.floor(size/2);
      const spriteRect = { x:centerX-half, y:centerY-half, w:size, h:size };
      drawShadow(it.x, it.y, 1, 1, spriteRect);
      ctx.save();
      const baseColor = it.type===ITEM.WOOD
        ? '#b48a52'
        : it.type===ITEM.STONE
          ? '#aeb7c3'
          : it.type===ITEM.BOW
            ? '#d4c08a'
            : '#b6d97a';
      ctx.fillStyle = shadeFillColorLit(baseColor, light);
      ctx.fillRect(spriteRect.x, spriteRect.y, spriteRect.w, spriteRect.h);
      ctx.restore();
    }

    drawNocturnalEntities(ambient);

    // villagers
    for(const v of villagers){ drawVillager(v, useMultiply); }

    if (typeof LIGHTING !== 'undefined' && LIGHTING.useMultiplyComposite === true && LIGHTING.mode != 'off') {
      try {
        if (useMultiply && shadingMode !== 'off' && world.lightmapCanvas){
          ctx.save();
          ctx.globalCompositeOperation='multiply';
          const destW = staticAlbedoCanvas ? staticAlbedoCanvas.width*cam.z : GRID_W*TILE*cam.z;
          const destH = staticAlbedoCanvas ? staticAlbedoCanvas.height*cam.z : GRID_H*TILE*cam.z;
          ctx.drawImage(world.lightmapCanvas, 0,0, world.lightmapCanvas.width, world.lightmapCanvas.height,
            baseDx, baseDy,
            destW, destH);
          ctx.restore();
          logComposite(true, null);
        } else {
          logComposite(false, { reason: 'no-lightmap' });
        }
      } catch (err) {
        compositeError = err;
        const message = err && err.message ? err.message : err;
        logComposite(false, { error: String(message) });
      }
    } else {
      logComposite(false, { reason: 'disabled' });
    }

    if (LIGHTING.debugShowLightmap && world.lightmapCanvas){
      ctx.save();
      ctx.globalAlpha=0.9;
      ctx.imageSmoothingEnabled=false;
      const previewW=Math.min(128, Math.max(32, world.lightmapCanvas.width));
      const previewH=Math.min(128, Math.max(32, world.lightmapCanvas.height));
      ctx.drawImage(world.lightmapCanvas, 0,0, world.lightmapCanvas.width, world.lightmapCanvas.height,
        12, 12, previewW, previewH);
      ctx.restore();
    }

    // campfire glow (screen space but positioned via cam)
    for(const b of buildings){
      if(b.kind==='campfire'){
        const center=buildingCenter(b);
        const gx = tileToPxX(center.x, cam);
        const gy = tileToPxY(center.y, cam);
        const r = (24+4*Math.sin(tick*0.2))*cam.z;
        const grd=ctx.createRadialGradient(gx,gy,4*cam.z, gx,gy,r);
        grd.addColorStop(0,'rgba(255,180,90,0.35)');
        grd.addColorStop(1,'rgba(255,120,60,0)');
        ctx.fillStyle=grd;
        ctx.beginPath(); ctx.arc(gx,gy,r,0,Math.PI*2); ctx.fill();
        if(nightActive){
          ctx.save();
          ctx.globalAlpha=0.25+0.15*Math.random();
          ctx.fillStyle='rgba(255,210,150,0.85)';
          for(let i=0;i<2;i++){
            const emberX=gx + (12 + Math.random()*8)*cam.z + (Math.random()*2-1)*cam.z;
            const emberY=gy + (4 - Math.random()*10)*cam.z;
            ctx.beginPath();
            ctx.arc(emberX, emberY, Math.max(0.6, 1.1*Math.random())*cam.z, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.restore();
        }
      }
    }

    drawQueuedVillagerLabels(ambient);

    // HUD counters
    el('food').textContent=storageTotals.food|0; el('wood').textContent=storageTotals.wood|0; el('stone').textContent=storageTotals.stone|0; el('pop').textContent=villagers.length|0;
    if(PERF.log){
      t2 = performance.now();
      if((tick % 60) === 0) console.log(`render: overlays ${(t1-t0).toFixed(2)}ms, total ${(t2-t0).toFixed(2)}ms`);
    }
  } catch (err) {
    spritesError = err;
  }

  if (!compositeLogged) {
    if (spritesError) {
      logComposite(false, { reason: 'skipped' });
    } else {
      logComposite(false, { reason: 'disabled' });
    }
  }

  if (spritesError) {
    const message = spritesError && spritesError.message ? spritesError.message : spritesError;
    __ck('sprites-ui', false, { error: String(message) });
  } else {
    __ck('sprites-ui', true, null);
  }

  if (spritesError) {
    throw spritesError;
  }
  if (compositeError) {
    throw compositeError;
  }
}

function drawBuildingAt(gx,gy,b){
  const g=ctx, s=cam.z;
  const fp=getFootprint(b.kind);
  const center=buildingCenter(b);
  const def=BUILDINGS[b.kind]||{};
  const activity=b.activity||{};
  const useAgo=Math.max(0, tick-(activity.lastUse||0));
  const hydrateAgo=Math.max(0, tick-(activity.lastHydrate||0));
  const socialAgo=Math.max(0, tick-(activity.lastSocial||0));
  const restAgo=Math.max(0, tick-(activity.lastRest||0));
  const recentUse=Math.max(0, 1 - useAgo/360);
  const hydratePulse=Math.max(0, 1 - hydrateAgo/260);
  const socialPulse=Math.max(0, 1 - socialAgo/260);
  const restPulse=Math.max(0, 1 - restAgo/260);
  const occupantPulse=Math.min(1, (activity.occupants||0)*0.4);
  const activityPulse=Math.max(recentUse, hydratePulse, socialPulse, restPulse, occupantPulse);
  const useMultiply = LIGHTING.useMultiplyComposite && LIGHTING.mode !== 'off';
  const sampledLight = useMultiply ? 1 : sampleLightAt(world, center.x, center.y);
  const shade = b.kind==='farmplot' ? 1 : sampledLight;
  const campfireShade = b.kind==='campfire' ? Math.max(shade, 0.95) : shade;
  drawShadow(b.x, b.y, fp.w, fp.h);
  const offsetX = Math.floor((ENTITY_TILE_PX - fp.w*TILE) * s * 0.5);
  const offsetY = Math.floor((ENTITY_TILE_PX - fp.h*TILE) * s * 0.5);
  gx -= offsetX;
  gy -= offsetY;
  g.save();
  if(b.kind==='campfire'){
    g.fillStyle=shadeFillColorLit('#7b8591', campfireShade);
    g.fillRect(gx+10*s,gy+18*s,12*s,6*s);
    const f=(tick%6);
    const flameColor=['#ffde7a','#ffc05a','#ff9b4a'][f%3];
    const flameH=6*s*(1+activityPulse*0.8);
    g.fillStyle=shadeFillColorLit(flameColor, campfireShade);
    g.fillRect(gx+14*s,gy+12*s,4*s,flameH);
    g.globalAlpha=0.35+activityPulse*0.25;
    g.fillStyle=shadeFillColorLit('rgba(142,142,142,0.75)', campfireShade);
    g.beginPath();
    g.arc(gx+16*s, gy+(10-f)*s, 3*s+activityPulse*3*s, 0, Math.PI*2);
    g.fill();
    g.globalAlpha=1;
  } else if(b.kind==='storage'){
    g.fillStyle=shadeFillColorLit('#6a5338', shade);
    g.fillRect(gx+6*s,gy+10*s,20*s,14*s);
    g.fillStyle=shadeFillColorLit('#8b6b44', shade);
    g.fillRect(gx+6*s,gy+20*s,20*s,2*s);
    g.fillStyle=shadeFillColorLit('#3b2b1a', shade);
    g.fillRect(gx+6*s,gy+10*s,20*s,1*s);
    const storedLevel=Math.min(1, (storageTotals.food*0.5 + storageTotals.wood*0.35 + storageTotals.stone*0.35)/40);
    if(storedLevel>0.02){
      const fillH=Math.max(2*s, Math.floor(12*storedLevel)*s);
      g.fillStyle=shadeFillColorLit('rgba(152,118,76,0.9)', shade);
      g.fillRect(gx+8*s, gy+10*s+(12*s-fillH), 16*s, fillH);
    }
  } else if(b.kind==='hut'){
    g.fillStyle=shadeFillColorLit('#7d5a3a', shade);
    g.fillRect(gx+8*s,gy+16*s,16*s,12*s);
    g.fillStyle=shadeFillColorLit('#caa56a', shade);
    g.fillRect(gx+6*s,gy+12*s,20*s,6*s);
    g.fillStyle=shadeFillColorLit('#31251a', shade);
    g.fillRect(gx+14*s,gy+20*s,4*s,8*s);
    if(activityPulse>0.05){
      const glowAlpha=Math.min(0.55, 0.25+activityPulse*0.5);
      g.fillStyle=shadeFillColorLit(`rgba(255,215,128,${glowAlpha})`, shade);
      g.fillRect(gx+10*s,gy+18*s,4*s,4*s);
      g.fillRect(gx+16*s,gy+18*s,4*s,4*s);
    }
  } else if(b.kind==='farmplot'){
    g.fillStyle=shadeFillColorLit('#4a3624', shade);
    g.fillRect(gx+4*s,gy+8*s,24*s,16*s);
    g.fillStyle=shadeFillColorLit('#3b2a1d', shade);
    g.fillRect(gx+4*s,gy+12*s,24*s,2*s);
    g.fillRect(gx+4*s,gy+16*s,24*s,2*s);
    g.fillRect(gx+4*s,gy+20*s,24*s,2*s);
  } else if(b.kind==='well'){
    g.fillStyle=shadeFillColorLit('#6f8696', shade);
    g.fillRect(gx+10*s,gy+14*s,12*s,10*s);
    g.fillStyle=shadeFillColorLit('#2b3744', shade);
    g.fillRect(gx+12*s,gy+18*s,8*s,6*s);
    g.fillStyle=shadeFillColorLit('#927a54', shade);
    g.fillRect(gx+8*s,gy+12*s,16*s,2*s);
    if(hydratePulse>0.05){
      g.strokeStyle=shadeFillColorLit('rgba(134,201,255,0.9)', shade);
      g.lineWidth=Math.max(1,Math.round(s));
      const ripple=3*s+(Math.sin(tick*0.2)+1)*s*0.8;
      g.beginPath();
      g.arc(gx+16*s, gy+17*s, ripple*(1+hydratePulse*0.6), 0, Math.PI*2);
      g.stroke();
    }
  }
  if(b.built<1){
    g.strokeStyle='rgba(255,255,255,0.6)';
    g.strokeRect(gx+4*s,gy+4*s,24*s,24*s);
    const p=(b.progress||0)/(BUILDINGS[b.kind].cost||1);
    g.fillStyle=shadeFillColorLit('#7cc4ff', shade);
    g.fillRect(gx+6*s,gy+28*s, Math.floor(20*p)*s, 2*s);
  }
  g.restore();
  const overlayRadius=def.effects?.radius ?? def.effects?.hydrationRadius ?? 0;
  if(overlayRadius>0 && activityPulse>0.05){
    const cx=tileToPxX(center.x, cam);
    const cy=tileToPxY(center.y, cam);
    const radiusPx=(overlayRadius+0.5)*TILE*cam.z;
    ctx.save();
    ctx.globalAlpha=Math.min(0.45, 0.2+activityPulse*0.4);
    const overlayColor=b.kind==='well'?'rgba(134,201,255,0.95)':'rgba(255,232,168,0.95)';
    ctx.strokeStyle=shadeFillColorLit(overlayColor, shade);
    ctx.lineWidth=Math.max(1,Math.round(1.6*cam.z));
    ctx.beginPath();
    ctx.arc(cx, cy, radiusPx, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawAnimal(animal, useMultiply){
  if(!animal) return;
  const sprite = Tileset.sprite.animals && Tileset.sprite.animals[animal.type];
  if(!sprite) return;
  const rect = entityDrawRect(animal.x, animal.y, cam);
  const bobPx = Math.round((animal.bobOffset||0) * cam.z);
  const light = useMultiply ? 1 : sampleLightAt(world, animal.x, animal.y);
  drawShadow(animal.x, animal.y, 1, 1, { x:rect.x, y:rect.y, w:rect.size, h:rect.size });
  ctx.save();
  if(animal.dir === 'left'){
    ctx.translate(rect.x + rect.size, rect.y - bobPx);
    ctx.scale(-1, 1);
    ctx.drawImage(sprite, 0,0,ENTITY_TILE_PX,ENTITY_TILE_PX, 0, 0, rect.size, rect.size);
    applySpriteShadeLit(ctx, 0, 0, rect.size, rect.size, light);
  } else {
    ctx.drawImage(sprite, 0,0,ENTITY_TILE_PX,ENTITY_TILE_PX, rect.x, rect.y - bobPx, rect.size, rect.size);
    applySpriteShadeLit(ctx, rect.x, rect.y - bobPx, rect.size, rect.size, light);
  }
  ctx.restore();
}

function drawVillager(v, useMultiply){
  const frames = v.role==='farmer'? Tileset.villagerSprites.farmer : v.role==='worker'? Tileset.villagerSprites.worker : v.role==='explorer'? Tileset.villagerSprites.explorer : Tileset.villagerSprites.sleepy;
  const f=frames[Math.floor((tick/8)%3)], s=cam.z;
  const rect = entityDrawRect(v.x, v.y, cam);
  const spriteSize = 16 * s;
  const gx = Math.floor(rect.x + (rect.size - spriteSize) * 0.5);
  const gy = Math.floor(rect.y + (rect.size - spriteSize) * 0.5);
  const light = useMultiply ? 1 : sampleLightAt(world, v.x, v.y);
  drawShadow(v.x, v.y, 1, 1, { x:gx, y:gy, w:spriteSize, h:spriteSize });
  ctx.save();
  ctx.drawImage(f, 0,0,16,16, gx, gy, spriteSize, spriteSize);
  applySpriteShadeLit(ctx, gx, gy, spriteSize, spriteSize, light);
  if(v.inv){
    const packColor=v.inv.type===ITEM.WOOD
      ? '#b48a52'
      : v.inv.type===ITEM.STONE
        ? '#aeb7c3'
        : v.inv.type===ITEM.BOW
          ? '#d4c08a'
          : '#b6d97a';
    ctx.fillStyle=shadeFillColorLit(packColor, light);
    ctx.fillRect(gx+spriteSize-4*s, gy+2*s, 3*s, 3*s);
  }
  ctx.restore();

  const baseCx=gx+spriteSize*0.5;
  const baseCy=gy-4*cam.z;
  let labelOffset=0;
  const villagerNumber = ensureVillagerNumber(v);
  const queueLabel=(text,color)=>{
    if(!text) return;
    const fontSize=Math.max(6,6*cam.z);
    const boxH=fontSize+4*cam.z;
    villagerLabels.push({
      text,
      color,
      cx:baseCx,
      cy:baseCy-labelOffset,
      fontSize,
      boxH,
      camZ:cam.z
    });
    labelOffset+=boxH+2*cam.z;
  };

  if (villagerNumber != null) {
    queueLabel(`#${villagerNumber}`, '#e8edff');
  }

  if(v.lifeStage==='child'){
    queueLabel('Child', '#9ad1ff');
  } else if(v.pregnancyTimer>0){
    queueLabel('🤰 Expecting', '#f7b0d6');
  }

  const cond=v.condition;
  if(cond && cond!=='normal'){
    let label=null, color='#ffcf66';
    if(cond==='hungry'){ label='Hungry'; color='#ffcf66'; }
    else if(cond==='starving'){ label='Starving'; color='#ff6b6b'; }
    else if(cond==='sick'){ label='Collapsed'; color='#d76bff'; }
    else if(cond==='recovering'){ label='Recovering'; color='#7cc4ff'; }
    if(label){ queueLabel(label,color); }
  }
  const mood=v.happy;
  let moodLabel=null, moodColor='#8fe58c';
  const moodTargets = policy.moodTargets || {};
  const upbeatTarget = typeof moodTargets.upbeat === 'number' ? moodTargets.upbeat : 0.8;
  const cheerfulTarget = typeof moodTargets.cheerful === 'number' ? moodTargets.cheerful : 0.65;
  const miserableTarget = typeof moodTargets.miserable === 'number' ? moodTargets.miserable : 0.2;
  const lowSpiritsTarget = typeof moodTargets.lowSpirits === 'number' ? moodTargets.lowSpirits : 0.35;
  if(mood>=upbeatTarget){ moodLabel='😊 Upbeat'; moodColor='#8fe58c'; }
  else if(mood>=cheerfulTarget){ moodLabel='🙂 Cheerful'; moodColor='#b9f5ae'; }
  else if(mood<=miserableTarget){ moodLabel='☹️ Miserable'; moodColor='#ff8c8c'; }
  else if(mood<=lowSpiritsTarget){ moodLabel='😟 Low spirits'; moodColor='#f5d58b'; }
  if(moodLabel){ queueLabel(moodLabel,moodColor); }
}

function drawQueuedVillagerLabels(uiLight){
  if(villagerLabels.length===0) return;
  const clamped = Math.max(LIGHTING.uiMinLight, uiLight);
  for(const label of villagerLabels){
    const { text, color, cx, cy, fontSize, boxH, camZ } = label;
    ctx.save();
    ctx.font=`600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    const metrics=ctx.measureText(text);
    const boxW=metrics.width+6*camZ;
    ctx.fillStyle=shadeFillColorLit('rgba(10,12,16,0.8)', clamped);
    ctx.fillRect(cx-boxW/2, cy-boxH/2, boxW, boxH);
    ctx.strokeStyle='rgba(255,255,255,0.25)';
    ctx.lineWidth=Math.max(1, Math.round(0.7*camZ));
    ctx.strokeRect(cx-boxW/2, cy-boxH/2, boxW, boxH);
    ctx.fillStyle=shadeFillColorLit(color, clamped);
    ctx.fillText(text, cx, cy+0.2*camZ);
    ctx.restore();
  }
  villagerLabels.length=0;
}



/* ==================== Items & Loop ==================== */
function dropItem(x,y,type,qty){
  itemsOnGround.push({x,y,type,qty});
  markItemsDirty();
}

function nocturnalAmbientStrength(ambient){
  const usableRange = Math.max(0.0001, 1 - LIGHTING.nightFloor);
  return clamp01((1 - ambient) / usableRange);
}

function spawnNocturnalEntity(nightStrength){
  const slot = nocturnalEntities.find((entity) => !entity.active);
  if (!slot) return false;

  const margin = 1.25;
  slot.active = true;
  slot.x = rnd(margin, GRID_W - margin);
  slot.y = rnd(margin, GRID_H - margin);
  const angle = rnd(0, Math.PI * 2);
  const speed = rnd(0.004, 0.018);
  slot.vx = Math.cos(angle) * speed;
  slot.vy = Math.sin(angle) * speed;
  slot.radius = rnd(0.35, 0.65);
  slot.energy = 0.5 + nightStrength * 0.45 + rnd(0, 0.15);
  slot.fade = 0;
  slot.wanderTicks = irnd(28, 90);
  return true;
}

function updateNocturnalEntities(ambient){
  const nightActive = isNightAmbient(ambient);
  const nightStrength = nocturnalAmbientStrength(ambient);
  const dawnFade = clamp01((DAWN_AMBIENT_THRESHOLD - ambient) / DAWN_AMBIENT_THRESHOLD);
  let activeCount = 0;

  for (const entity of nocturnalEntities){
    if (!entity.active) continue;

    entity.wanderTicks--;
    if(entity.wanderTicks <= 0){
      const angle = rnd(0, Math.PI * 2);
      const speed = rnd(0.0035, 0.015);
      entity.vx = Math.cos(angle) * speed;
      entity.vy = Math.sin(angle) * speed;
      entity.wanderTicks = irnd(30, 120);
    }

    entity.x = clamp(entity.x + entity.vx, 1.25, GRID_W - 1.25);
    entity.y = clamp(entity.y + entity.vy, 1.25, GRID_H - 1.25);
    if(entity.x <= 1.3 || entity.x >= GRID_W - 1.3) entity.vx *= -0.6;
    if(entity.y <= 1.3 || entity.y >= GRID_H - 1.3) entity.vy *= -0.6;

    const targetFade = nightActive ? 1 : dawnFade * 0.65;
    const fadeDelta = targetFade - entity.fade;
    entity.fade = clamp(entity.fade + fadeDelta * 0.08 - (nightActive ? 0 : 0.01), 0, 1);
    entity.alpha = clamp(entity.energy * entity.fade * (0.45 + nightStrength * 0.6), 0, 1);

    if(entity.alpha <= 0.02){
      entity.active = false;
      continue;
    }
    activeCount++;
  }

  if(nightActive){
    if(nocturnalSpawnCooldown > 0) nocturnalSpawnCooldown--;
    const targetPopulation = Math.max(4, Math.floor(nightStrength * nocturnalEntities.length * 0.8));
    while(activeCount < targetPopulation && nocturnalSpawnCooldown <= 0){
      if(!spawnNocturnalEntity(nightStrength)) break;
      nocturnalSpawnCooldown = irnd(12, 26);
      activeCount++;
    }
  } else {
    nocturnalSpawnCooldown = Math.max(nocturnalSpawnCooldown, 6);
  }
}

function drawNocturnalEntities(ambient){
  const nightStrength = nocturnalAmbientStrength(ambient);
  if(nightStrength <= 0 && !nocturnalEntities.some((e) => e.active)) return;

  ctx.save();
  ctx.globalCompositeOperation='lighter';
  for(const entity of nocturnalEntities){
    if(!entity.active || entity.alpha <= 0) continue;
    const gx = tileToPxX(entity.x, cam);
    const gy = tileToPxY(entity.y, cam);
    const radiusPx = entity.radius * TILE * cam.z * (1.2 + nightStrength * 0.8);
    const grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, radiusPx);
    const alpha = entity.alpha;
    grd.addColorStop(0, `rgba(170,210,255,${0.6 * alpha})`);
    grd.addColorStop(0.45, `rgba(140,190,255,${0.35 * alpha})`);
    grd.addColorStop(1, 'rgba(120,170,240,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(gx, gy, radiusPx, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

// SECONDS_PER_TICK and SPEED_PX_PER_SEC are read by stepAlong() in this file;
// the rest of the per-frame timing is owned by createTickRunner.
const TICKS_PER_SEC = policy.routine.ticksPerSecond || 6;
const SECONDS_PER_TICK = 1 / TICKS_PER_SEC;
const SPEED_PX_PER_SEC = 0.08 * 32 * TICKS_PER_SEC;

function processVillagerItemPickup(v){
  if(itemTileIndexDirty) rebuildItemTileIndex();
  if(v.inv) return;
  const key = ((v.y|0) * GRID_W) + (v.x|0);
  const itemIndex = itemTileIndex.get(key);
  if(itemIndex === undefined) return;
  const it = itemsOnGround[itemIndex];
  if(!it) return;
  v.inv = { type: it.type, qty: it.qty };
  removeItemAtIndex(itemIndex);
}

const planner = createPlanner({
  state: gameState,
  policy,
  pathfind,
  addJob,
  hasSimilarJob,
  noteJobRemoved,
  requestBuildHauls,
  countBuildingsByKind,
  ensureBlackboardSnapshot: () => ensureBlackboardSnapshot(),
  getJobCreationConfig,
  violatesSpacing,
  zoneCanEverWork,
  zoneHasWorkNow,
  updateZoneRow,
  markZoneOverlayDirty,
  markStaticDirty,
  availableToReserve,
  reserveMaterials,
  releaseReservedMaterials,
  addBuilding,
  Toast,
  toTile
});

const tickRunner = createTickRunner({
  state: gameState,
  policy,
  planZones: planner.planZones,
  planBuildings: planner.planBuildings,
  generateJobs: planner.generateJobs,
  villagerTick,
  updateAnimals,
  updateNocturnalEntities,
  seasonTick,
  flushPendingBirths,
  processVillagerItemPickup,
  ambientAt,
  perf: PERF
});
ensureBlackboardSnapshot = tickRunner.ensureBlackboardSnapshot;

function update(){
  tickRunner.runFrame(performance.now());
  render();
  requestAnimationFrame(update);
}

setUpdateCallback(update);

/* ==================== Boot ==================== */
function boot(){
  window.__AIV_BOOT__ = true;
  try {
    buildTileset();                 // must not be fatal
    const loaded = loadGame();      // may fail safely
    if(!loaded) newWorld();         // always create a world
    openMode('inspect');            // UI init
    if(!Storage.get('aiv_help_px3')){
      el('help').style.display='block';
    }
  } catch (e){
    reportFatal(e);
  } finally {
    // Ensure the loop starts no matter what
    try { requestAnimationFrame(update); }
    catch (e){ reportFatal(e); }
  }
}
if (AIV_SCOPE && typeof AIV_SCOPE === 'object') {
  const appApi = {
    setShadingMode,
    setShadingParams,
    makeAltitudeShade,
    ambientAt,
    buildHillshadeQ,
    buildLightmap,
    sampleLightAt,
    shadeFillColorLit,
    applySpriteShadeLit,
    LIGHTING,
    state: gameState,
    boot
  };
  AIV_SCOPE.AIV_APP = Object.assign({}, AIV_SCOPE.AIV_APP || {}, appApi);
  AIV_SCOPE.LIGHTING = LIGHTING;
}

export { boot as bootGame };
export { gameState as state };
export { LIGHTING };
// Debug helpers (setShadingMode, setShadingParams, makeAltitudeShade,
// ambientAt, buildHillshadeQ, buildLightmap, sampleLightAt,
// shadeFillColorLit, applySpriteShadeLit) are exposed only via the
// `window.AIV_APP` global installed above. They are not re-exported as
// ES bindings because no internal module imports them and DebugKit
// reaches them through `window`.
