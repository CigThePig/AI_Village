import { createInitialState } from './state.js';
import { policy } from './policy/policy.js';
import { computeBlackboard } from './ai/blackboard.js';
import {
  DAY_LENGTH,
  DIR4,
  ENTITY_TILE_PX,
  GRID_H,
  GRID_SIZE,
  GRID_W,
  ITEM,
  LAYER_ORDER,
  SHADOW_DIRECTION,
  SHADOW_DIRECTION_ANGLE,
  TILE,
  TILES,
  TREE_VERTICAL_RAISE,
  ZONES,
  baseIdx,
  tileToPxX,
  tileToPxY
} from './app/constants.js';
import { AIV_SCOPE, SHADING_DEFAULTS, WORLDGEN_DEFAULTS, generateTerrain, makeHillshade } from './app/environment.js';
import { LIGHTING, clamp01, makeAltitudeShade, registerShadingHandlers, setShadingMode, setShadingParams } from './app/lighting.js';
import { Storage, reportFatal, setUpdateCallback } from './app/storage.js';
import { H, W, cam, clampCam, context2d, ctx } from './app/canvas.js';
import { R, clamp, irnd, mulberry32, setRandomSource, uid } from './app/rng.js';
import { Tileset, SHADOW_TEXTURE, buildTileset, makeCanvas } from './app/tileset.js';
import { createPathfinder } from './app/pathfinding.js';
import { createSaveSystem } from './app/save.js';
import { createUISystem } from './app/ui.js';
import { createRenderSystem } from './app/render.js';
import { createPlanner } from './app/planner.js';
import { createTickRunner } from './app/tick.js';
import { createVillagerTick } from './app/villagerTick.js';
import { createJobsSystem } from './app/jobs.js';
import { createAnimalsSystem } from './app/animals.js';
import { createNocturnalSystem } from './app/nocturnal.js';
import { createDebugKitBridge } from './app/debugkit.js';
import { createMaterials } from './app/materials.js';
import { CHILDHOOD_TICKS, createPopulation } from './app/population.js';
import { STARVE_THRESH, createVillagerAI } from './app/villagerAI.js';
import { createOnArrive } from './app/onArrive.js';
import {
  BUILDINGS,
  agricultureBonusesAt as _agricultureBonusesAt,
  buildingAtIn,
  buildingCenter,
  buildingEntryTiles,
  ensureBuildingData,
  getFootprint,
  tileOccupiedByBuildingIn,
  validateFootprintPlacementIn
} from './app/world.js';
import {
  createTimeOfDay,
  isNightAmbient,
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
// activeZoneJobs / clearActiveZoneJobs / noteJobAssignmentChanged / noteJobRemoved
// moved to src/app/jobs.js (createJobsSystem). Wired below.
// nocturnalEntities and nocturnalSpawnCooldown moved to src/app/nocturnal.js.
// pendingBirths moved to src/app/population.js.
// jobSuppression moved to src/app/jobs.js.
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

// ensureBlackboardSnapshot lives on the tick runner (src/app/tick.js); use the
// thunk below so callers in this file keep a stable call shape until the runner
// is wired up at boot.
let ensureBlackboardSnapshot = () => {
  if(!gameState.bb) gameState.bb = computeBlackboard(gameState, policy);
  return gameState.bb;
};


// stepAlong and onArrive moved to src/app/onArrive.js — see _onArrive factory wiring below.

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

/* ==================== Factory wiring ==================== */
// Order matters: each factory only depends on factories declared above it,
// or uses thunks (arrow functions) for forward references.

const _jobsSystem = createJobsSystem({
  state: gameState,
  policy
});
const {
  activeZoneJobs,
  clearActiveZoneJobs,
  noteJobAssignmentChanged,
  noteJobRemoved,
  getJobCreationConfig,
  jobKey: _jobKey,
  isJobSuppressed: _isJobSuppressed,
  suppressJob,
  hasSimilarJob,
  violatesSpacing,
  addJob,
  finishJob,
  detachVillagersFromJob
} = _jobsSystem;
void _jobKey; void _isJobSuppressed;

const _animalsSystem = createAnimalsSystem({
  state: gameState,
  pathfind,
  tileOccupiedByBuilding,
  idx,
  dropItem
});
const {
  spawnAnimalsForWorld,
  queueAnimalLabel,
  chooseFleeTarget,
  findAnimalById,
  removeAnimal,
  resolveHuntYield,
  findHuntApproachPath,
  updateAnimals
} = _animalsSystem;

// findNearestBuilding lives on _villagerAI; thunk it so factories declared
// before _villagerAI can still reach it.
const findNearestBuilding = (x, y, kind) => _villagerAI.findNearestBuilding(x, y, kind);

const _materialsSystem = createMaterials({
  state: gameState,
  policy,
  addJob,
  noteJobRemoved,
  findNearestBuilding,
  detachVillagersFromJob
});
const {
  availableToReserve,
  reserveMaterials,
  releaseReservedMaterials,
  spendCraftMaterials,
  countBuildingsByKind,
  scheduleHaul: _scheduleHaul,
  requestBuildHauls,
  cancelHaulJobsForBuilding
} = _materialsSystem;
void _scheduleHaul;

const _populationSystem = createPopulation({
  state: gameState,
  countBuildingsByKind,
  tileOccupiedByBuilding,
  idx,
  ensureVillagerNumber
});
const {
  newVillager,
  tryStartPregnancy,
  completePregnancy,
  promoteChildToAdult,
  flushPendingBirths
} = _populationSystem;

const _villagerAI = createVillagerAI({
  state: gameState,
  policy,
  pathfind,
  passable,
  Toast,
  finishJob,
  availableToReserve,
  requestBuildHauls,
  findAnimalById,
  findEntryTileNear,
  getBuildingById,
  buildingsByKind,
  idx,
  ambientAt,
  isNightTime
});
const {
  nearbyWarmth,
  issueStarveToast,
  handleVillagerFed,
  consumeFood,
  seekEmergencyFood,
  foragingJob,
  goRest,
  tryHydrateAtWell,
  tryCampfireSocial,
  tryStorageIdle,
  tryEquipBow,
  enterSickState,
  maybeInterruptJob,
  findPanicHarvestJob,
  pickJobFor,
  handleIdleRoam
} = _villagerAI;

const TICKS_PER_SEC = policy.routine.ticksPerSecond || 6;
const SECONDS_PER_TICK = 1 / TICKS_PER_SEC;
const SPEED_PX_PER_SEC = 0.08 * 32 * TICKS_PER_SEC;

const _onArriveSystem = createOnArrive({
  state: gameState,
  pathfind,
  idx,
  finishJob,
  suppressJob,
  releaseReservedMaterials,
  spendCraftMaterials,
  requestBuildHauls,
  cancelHaulJobsForBuilding,
  findAnimalById,
  removeAnimal,
  resolveHuntYield,
  chooseFleeTarget,
  queueAnimalLabel,
  findHuntApproachPath,
  consumeFood,
  handleVillagerFed,
  findNearestBuilding,
  agricultureBonusesAt,
  findEntryTileNear,
  getBuildingById,
  setActiveBuilding,
  noteBuildingActivity,
  buildingAt,
  dropItem,
  removeItemAtIndex,
  itemTileIndex,
  markStaticDirty,
  markEmittersDirty,
  onZoneTileSown: (_cx, cy) => { ensureRowMasksSize(); zoneRowMask[cy] = 1; },
  getSecondsPerTick: () => SECONDS_PER_TICK,
  getSpeedPxPerSec: () => SPEED_PX_PER_SEC
});
const { stepAlong, onArrive: _onArrive } = _onArriveSystem;
void _onArrive;

const _debugKitBridge = createDebugKitBridge({
  state: gameState,
  ensureVillagerNumber,
  applyShadingMode,
  markStaticDirty
});
const { ensureDebugKitConfigured } = _debugKitBridge;
_debugKitBridge.attachToWindow();

const _nocturnalSystem = createNocturnalSystem({});
const {
  updateNocturnalEntities,
  drawNocturnalEntities
} = _nocturnalSystem;

/* ==================== Planner & tick wiring ==================== */

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

const _villagerTick = createVillagerTick({
  state: gameState,
  policy,
  pathfind,
  ambientAt,
  nearbyWarmth,
  agricultureBonusesAt,
  getBuildingById,
  noteBuildingActivity,
  endBuildingStay,
  finishJob,
  issueStarveToast,
  enterSickState,
  suppressJob,
  noteJobAssignmentChanged,
  getJobCreationConfig,
  findEntryTileNear,
  findNearestBuilding,
  buildingCenter,
  findHuntApproachPath,
  findAnimalById,
  buildingAt,
  tryEquipBow,
  tryHydrateAtWell,
  tryCampfireSocial,
  tryStorageIdle,
  foragingJob,
  goRest,
  seekEmergencyFood,
  consumeFood,
  findPanicHarvestJob,
  pickJobFor,
  maybeInterruptJob,
  tryStartPregnancy,
  completePregnancy,
  promoteChildToAdult,
  handleIdleRoam,
  stepAlong
});

const tickRunner = createTickRunner({
  state: gameState,
  policy,
  planZones: planner.planZones,
  planBuildings: planner.planBuildings,
  generateJobs: planner.generateJobs,
  villagerTick: _villagerTick.villagerTick,
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
