import { createInitialState } from './state.js';
import { policy } from './policy/policy.js';
import { computeBlackboard } from './ai/blackboard.js';
import {
  DAY_LENGTH,
  DIR4,
  GRID_H,
  GRID_SIZE,
  GRID_W,
  RESOURCE_TYPES,
  TILE,
  TILES,
  ZONES,
  baseIdx
} from './app/constants.js';
import { AIV_SCOPE, SHADING_DEFAULTS, WORLDGEN_DEFAULTS, generateTerrain, makeHillshade } from './app/environment.js';
import { LIGHTING, makeAltitudeShade, registerShadingHandlers, setShadingMode, setShadingParams } from './app/lighting.js';
import { Storage, reportFatal, setUpdateCallback } from './app/storage.js';
import { H, W, cam, clampCam, ctx } from './app/canvas.js';
import { R, clamp, irnd, mulberry32, setRandomSource, uid } from './app/rng.js';
import { buildTileset } from './app/tileset.js';
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
  normalizeExperienceLedger
} from './app/simulation.js';

if (import.meta.env?.DEV) {
  console.log("AIV Phase1 perf build"); // shows up so we know this file ran
}
const PERF = { log:false }; // flip to true to log basic timings

// Render-side row masks, overlay caches, and dirty markers
// (markStaticDirty / markZoneOverlayDirty / updateZoneRow /
// refreshWaterRowMaskFromTiles / refreshZoneRowMask) live on
// _renderSystem (src/app/render.js). The thunks below delegate to it
// and are wired after _renderSystem is instantiated.

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
  // audit #38: starting stocks duplicated with state.js — defer consolidation.
  for (const r of RESOURCE_TYPES) {
    storageTotals[r] = 0;
    storageReserved[r] = 0;
  }
  storageTotals.food = 24;
  storageTotals.wood = 12;
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
  resetOverlayCaches();
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
// The render body, all draw helpers, the overlay/lightmap caches, and
// the row-mask scaffolding live on _renderSystem (src/app/render.js).
// Forward references to factories declared later in this file
// (`activeZoneJobs` from `_jobsSystem`, `drawNocturnalEntities` from
// `_nocturnalSystem`) are passed as thunks; they resolve at call time
// once `update()` starts the per-frame loop after `boot()`.

const _renderSystem = createRenderSystem({
  getCam: () => cam,
  getViewportW: () => W,
  getViewportH: () => H,
  getCtx: () => ctx,
  getWorld: () => world,
  getBuildings: () => buildings,
  getVillagers: () => villagers,
  getAnimals: () => animals,
  getItemsOnGround: () => itemsOnGround,
  getVillagerLabels: () => villagerLabels,
  getActiveZoneJobs: () => activeZoneJobs,
  getBuildingsByKind: () => buildingsByKind,
  getStorageTotals: () => storageTotals,
  getTick: () => tick,
  getDayTime: () => dayTime,
  getEmittersDirty: () => emittersDirty,
  setEmittersClean: () => { emittersDirty = false; },
  ambientAt,
  drawNocturnalEntities: (ambient) => drawNocturnalEntities(ambient),
  normalizeShadingMode,
  zoneHasWorkNow,
  zoneJobType,
  policy,
  el,
  ensureVillagerNumber,
  perf: PERF
});
// Aliases used both inside src/app.js (e.g. applyShadingMode,
// newWorld) and as deps for other factories (saveSystem, planner,
// onArrive, debugkit). The DebugKit-facing helpers below
// (shadeFillColorLit / applySpriteShadeLit / buildHillshadeQ /
// buildLightmap / sampleLightAt) are also exposed via window.AIV_APP.
const resetLightmapCache = _renderSystem.resetLightmapCache;
const shadeFillColorLit = _renderSystem.shadeFillColorLit;
const applySpriteShadeLit = _renderSystem.applySpriteShadeLit;
const buildHillshadeQ = _renderSystem.buildHillshadeQ;
const buildLightmap = _renderSystem.buildLightmap;
const sampleLightAt = _renderSystem.sampleLightAt;
const markStaticDirty = _renderSystem.markStaticDirty;
const markZoneOverlayDirty = _renderSystem.markZoneOverlayDirty;
const updateZoneRow = _renderSystem.updateZoneRow;
const refreshWaterRowMaskFromTiles = _renderSystem.refreshWaterRowMaskFromTiles;
const refreshZoneRowMask = _renderSystem.refreshZoneRowMask;
const noteZoneTileSown = _renderSystem.noteZoneTileSown;
const resetOverlayCaches = _renderSystem.resetOverlayCaches;

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
  takeFromStorage: _takeFromStorage,
  countBuildingsByKind,
  scheduleHaul: _scheduleHaul,
  requestBuildHauls,
  cancelHaulJobsForBuilding
} = _materialsSystem;
void _scheduleHaul;
void _takeFromStorage;

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
  reserveMaterials,
  releaseReservedMaterials,
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
  onZoneTileSown: noteZoneTileSown,
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
  _renderSystem.render();
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
