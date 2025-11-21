import { createInitialState } from './state.js';
import { policy } from './policy/policy.js';
import { computeBlackboard } from './ai/blackboard.js';
import { score as scoreJob, computeFamineSeverity } from './ai/scoring.js';
import {
  TILE_SIZE,
  ENTITY_TILE_SIZE,
  GRID_WIDTH,
  GRID_HEIGHT,
  SPEED_OPTIONS,
  CAMERA_MIN_Z,
  CAMERA_MAX_Z,
  DAY_LENGTH,
  LAYER_ORDER
} from './config.js';

const AIV_SCOPE = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);
const terrainAPI = AIV_SCOPE && AIV_SCOPE.AIV_TERRAIN ? AIV_SCOPE.AIV_TERRAIN : null;
const configAPI = AIV_SCOPE && AIV_SCOPE.AIV_CONFIG ? AIV_SCOPE.AIV_CONFIG : null;

const generateTerrain = terrainAPI ? terrainAPI.generateTerrain : null;
const makeHillshade = terrainAPI ? terrainAPI.makeHillshade : null;
const WORLDGEN_DEFAULTS = configAPI ? configAPI.WORLDGEN_DEFAULTS : undefined;
const SHADING_DEFAULTS = configAPI ? configAPI.SHADING_DEFAULTS : undefined;

if (typeof generateTerrain !== 'function' || typeof makeHillshade !== 'function') {
  throw new Error('AI Village terrain module unavailable.');
}
if (!WORLDGEN_DEFAULTS || !SHADING_DEFAULTS) {
  throw new Error('AI Village configuration unavailable.');
}

let setShadingModeImpl = () => {};
let setShadingParamsImpl = () => {};

const LIGHTING = {
  mode: 'hillshade',
  useMultiplyComposite: true,
  lightmapScale: 0.25,
  uiMinLight: 0.90,
  exposure: 1.0,
  nightFloor: 0.25,
  lightCap: 1.40,
  softLights: true,
  debugShowLightmap: false
};

const clamp01 = (value) => {
  if (!Number.isFinite(value)) {
    return value > 0 ? 1 : 0;
  }
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
};

function setShadingMode(mode) {
  return setShadingModeImpl(mode);
}

function setShadingParams(params = {}) {
  return setShadingParamsImpl(params);
}

if (typeof globalThis !== 'undefined') {
  // Provide provisional globals so the debug overlay can bind immediately.
  globalThis.setShadingMode = setShadingMode;
  globalThis.setShadingParams = setShadingParams;
  globalThis.SHADING_DEFAULTS = SHADING_DEFAULTS;
}

function makeAltitudeShade(height, w, h, cfg = SHADING_DEFAULTS) {
  const size = w * h;
  const shade = new Float32Array(size);
  if (!height || height.length !== size || size === 0) {
    return shade;
  }
  const ambient = clamp01(typeof cfg?.ambient === 'number' ? cfg.ambient : SHADING_DEFAULTS.ambient);
  const intensity = clamp01(typeof cfg?.intensity === 'number' ? cfg.intensity : SHADING_DEFAULTS.intensity);
  shade.fill(ambient);
  const span = intensity * 2;
  if (span === 0) {
    return shade;
  }
  const min = ambient - intensity;
  for (let i = 0; i < size; i++) {
    const hVal = clamp01(height[i]);
    const lit = clamp01(min + span * hVal);
    shade[i] = lit;
  }
  return shade;
}

console.log("AIV Phase1 perf build"); // shows up so we know this file ran
const PERF = { log:false }; // flip to true to log basic timings

// ---- Safe storage wrapper ----
const Storage = (() => {
  const host = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
  let store = null;
  try {
    if (host && host.localStorage) {
      store = host.localStorage;
    }
  } catch (e) {
    store = null;
  }

  let available = false;
  if (store) {
    try {
      const k = '__aiv_test__' + Math.random();
      store.setItem(k, '1');
      store.removeItem(k);
      available = true;
    } catch (e) {
      available = false;
    }
  }

  function get(key, def = null) {
    if (!available || !store) return def;
    try {
      const v = store.getItem(key);
      return v === null ? def : v;
    } catch (e) {
      return def;
    }
  }

  function set(key, value) {
    if (!available || !store) return false;
    try {
      store.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function del(key) {
    if (!available || !store) return false;
    try {
      store.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    get available() { return available; },
    set available(v) { available = !!v; },
    get,
    set,
    del
  };
})();

function describeError(value) {
  if (value == null) {
    return 'Fatal error';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }
  if (typeof value === 'object') {
    const stack = value.stack || value.message;
    if (stack) {
      return stack;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch (jsonErr) {
      return String(value);
    }
  }
  return String(value);
}

function showFatalOverlay(err) {
  if (typeof document === 'undefined') {
    console.error('Startup error', describeError(err));
    return;
  }
  const message = describeError(err);
  let div = document.getElementById('fatal-overlay');
  if (!div) {
    div = document.createElement('div');
    div.id = 'fatal-overlay';
    div.style.cssText = `
      position:fixed;left:12px;right:12px;top:12px;z-index:9999;
      background:rgba(20,24,33,0.96);color:#e9f1ff;border:1px solid rgba(255,255,255,0.15);
      border-radius:12px;padding:12px;font:14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      box-shadow:0 10px 30px rgba(0,0,0,.6)
    `;
    document.body.appendChild(div);
  }
  if (typeof div.replaceChildren === 'function') {
    div.replaceChildren();
  } else {
    while (div.firstChild) {
      div.removeChild(div.firstChild);
    }
  }

  const title = document.createElement('b');
  title.textContent = 'Startup error';
  div.appendChild(title);
  div.appendChild(document.createElement('br'));

  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  pre.textContent = message;
  div.appendChild(pre);

  const button = document.createElement('button');
  button.id = 'btnContinueNoSave';
  button.style.marginTop = '8px';
  button.textContent = 'Continue (no save)';
  div.appendChild(button);

  const btn = button;
  btn.onclick = () => {
    // Try to recover by disabling storage and starting the loop if needed
    if (typeof Storage !== 'undefined') {
      Storage.available = false;
      const bs=document.getElementById('btnSave');
      if(bs){ bs.disabled=true; bs.title='Saving unavailable in this context'; }
    }
    div.remove();
    try { requestAnimationFrame(update); } catch(e){}
  };
}

function reportFatal(message, data) {
  let usedDebugKit = false;
  const debugKit = window.DebugKit;
  if (debugKit != null && typeof debugKit.fatal === 'function') {
    try {
      debugKit.fatal(message, data || null);
      usedDebugKit = true;
    } catch (e) {
      // fall through to overlay fallback
    }
  }
  if (usedDebugKit !== true) {
    let fallback = message;
    if ((fallback == null || fallback === '') && data != null) {
      if (typeof data === 'object' && (data.stack || data.message)) {
        fallback = data;
      } else {
        fallback = String(data);
      }
    }
    if (fallback == null || fallback === '') {
      fallback = 'Fatal error';
    }
    showFatalOverlay(fallback);
  }
}

// Surface any unhandled error
window.addEventListener('error', (e) => {
  const detail = e && (e.error || e.message || e);
  reportFatal(detail, e);
});
window.addEventListener('unhandledrejection', (e) => {
  const detail = e && (e.reason || e);
  reportFatal(detail, e);
});

/* ==================== Constants & Types ==================== */
const coords = (() => {
  const TILE = TILE_SIZE;
  const ENTITY_TILE_PX = ENTITY_TILE_SIZE;
  let GRID_W = GRID_WIDTH;
  let GRID_H = GRID_HEIGHT;

  function tileToPxX(tx, cam){ return Math.floor((tx - cam.x) * TILE * cam.z); }
  function tileToPxY(ty, cam){ return Math.floor((ty - cam.y) * TILE * cam.z); }
  function pxToTileX(sx, cam){ return (sx / (TILE * cam.z)) + cam.x; }
  function pxToTileY(sy, cam){ return (sy / (TILE * cam.z)) + cam.y; }
  function idx(x, y){ return y * GRID_W + x; }
  function visibleTileBounds(W,H,cam){
    const spanX = Math.ceil(W/(TILE*cam.z));
    const spanY = Math.ceil(H/(TILE*cam.z));
    return {
      x0: Math.floor(cam.x)-1,
      y0: Math.floor(cam.y)-1,
      x1: Math.ceil(cam.x)+spanX+1,
      y1: Math.ceil(cam.y)+spanY+1
    };
  }

  return {
    TILE,
    ENTITY_TILE_PX,
    get GRID_W(){ return GRID_W; },
    set GRID_W(v){ GRID_W = v; },
    get GRID_H(){ return GRID_H; },
    set GRID_H(v){ GRID_H = v; },
    tileToPxX,
    tileToPxY,
    pxToTileX,
    pxToTileY,
    idx,
    visibleTileBounds
  };
})();

const {
  TILE,
  ENTITY_TILE_PX,
  tileToPxX,
  tileToPxY,
  pxToTileX,
  pxToTileY,
  visibleTileBounds: baseVisibleTileBounds,
  idx: baseIdx
} = coords;
const GRID_W = coords.GRID_W;
const GRID_H = coords.GRID_H;
const GRID_SIZE = GRID_W * GRID_H;
const SAVE_KEY = 'aiv_px_v3_save';
const SAVE_VERSION = 4;
const COARSE_SAVE_SIZE = 96;
const TILES = { GRASS:0, FOREST:1, ROCK:2, WATER:3, FERTILE:4, FARMLAND:5, SAND:6, SNOW:7, MEADOW:8, MARSH:9 };
const ZONES = { NONE:0, FARM:1, CUT:2, MINE:4 };
const WALKABLE = new Set([
  TILES.GRASS,
  TILES.FOREST,
  TILES.ROCK,
  TILES.FERTILE,
  TILES.FARMLAND,
  TILES.SAND,
  TILES.SNOW,
  TILES.MEADOW,
  TILES.MARSH
]);
const ANIMAL_TYPES = {
  deer: {
    label: 'Deer',
    preferred: [TILES.MEADOW, TILES.FOREST],
    fallback: [TILES.GRASS, TILES.FERTILE],
    density: 0.00045,
    minCount: 10
  },
  boar: {
    label: 'Boar',
    preferred: [TILES.FOREST, TILES.MARSH],
    fallback: [TILES.GRASS, TILES.SAND],
    density: 0.00035,
    minCount: 8
  }
};
const ANIMAL_BEHAVIORS = {
  deer: {
    roamRadius: 4,
    idleTicks: [28, 90],
    roamTicks: [60, 140],
    speed: 0.14,
    fleeSpeed: 0.21,
    grazeChance: 0.12,
    grazeRadius: 1,
    fearRadius: 4,
    fleeDistance: 4.5,
    observeMood: 0.006,
    idleBob: 1.6
  },
  boar: {
    roamRadius: 3,
    idleTicks: [22, 70],
    roamTicks: [45, 120],
    speed: 0.12,
    fleeSpeed: 0.18,
    grazeChance: 0.16,
    grazeRadius: 1,
    fearRadius: 3,
    fleeDistance: 3.5,
    observeMood: 0.004,
    idleBob: 1.2
  }
};
const ITEM = { FOOD:'food', WOOD:'wood', STONE:'stone' };
const DIR4 = [[1,0],[-1,0],[0,1],[0,-1]];
const TREE_VERTICAL_RAISE = 6; // pixels to lift tree sprites so trunks anchor in their tile
const LIGHT_VECTOR = { x:-0.75, y:-0.65 };
const LIGHT_VECTOR_LENGTH = Math.hypot(LIGHT_VECTOR.x, LIGHT_VECTOR.y) || 1;
const SHADOW_DIRECTION = {
  x: -LIGHT_VECTOR.x / LIGHT_VECTOR_LENGTH,
  y: -LIGHT_VECTOR.y / LIGHT_VECTOR_LENGTH
};
const SHADOW_DIRECTION_ANGLE = Math.atan2(SHADOW_DIRECTION.y, SHADOW_DIRECTION.x);
const SHADE_COLOR_CACHE = (() => {
  const cache = new Array(256);
  for (let i = 0; i < 256; i++) {
    cache[i] = `rgb(${i},${i},${i})`;
  }
  return cache;
})();
const SPEEDS = SPEED_OPTIONS;
const PF = {
  qx: new Int16Array(GRID_SIZE),
  qy: new Int16Array(GRID_SIZE),
  came: new Int32Array(GRID_SIZE)
};
let waterRowMask = new Uint8Array(GRID_H);
let zoneRowMask = new Uint8Array(GRID_H);
let currentAmbient = 1;
const lightmapCacheState = {
  ambient: null,
  mode: null,
  scale: null,
  emitterSignature: null
};
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

function resetLightmapCache(){
  lightmapCacheState.ambient = null;
  lightmapCacheState.mode = null;
  lightmapCacheState.scale = null;
  lightmapCacheState.emitterSignature = null;
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

/* ==================== Canvas & Camera ==================== */
const canvas = document.getElementById('game');
function context2d(canvas, opts){
  if (!canvas || typeof canvas.getContext !== 'function'){
    reportFatal(new Error('Unable to access a 2D drawing surface.'));
    return null;
  }

  let context = null;
  let lastError = null;

  if (opts){
    try {
      context = canvas.getContext('2d', opts) || null;
    } catch (err){
      lastError = err;
    }
  }

  if (!context){
    const shouldRetryWithoutAlpha = opts && Object.prototype.hasOwnProperty.call(opts, 'alpha') && opts.alpha === false;
    if (shouldRetryWithoutAlpha || !opts){
      try {
        context = canvas.getContext('2d') || null;
      } catch (err){
        if (!lastError) lastError = err;
      }
    }
  }

  if (!context){
    const details = [];
    if (opts){
      try { details.push(`options=${JSON.stringify(opts)}`); }
      catch (e){ details.push('options=[unserializable]'); }
    } else {
      details.push('options=default');
    }
    if (lastError){
      details.push(`error=${lastError.message || lastError}`);
    }
    const message = `Unable to acquire 2D rendering context (${details.join(', ')}).`;
    if (lastError){
      console.error(message, lastError);
    } else {
      console.error(message);
    }
    reportFatal(new Error(message));
    return null;
  }

  // We size canvases in device pixels (see resize) so disable smoothing once per context for crisp art.
  try {
    context.imageSmoothingEnabled = false;
  } catch (err){
    console.warn('Unable to configure image smoothing on context:', err);
  }
  return context;
}
const ctx = context2d(canvas, { alpha:false });
canvas.style.touchAction = 'none';
let DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
let W=0, H=0;
let cam = { x:0, y:0, z:2.2 }; // x,y in tiles; draw scales by z
const MIN_Z=CAMERA_MIN_Z, MAX_Z=CAMERA_MAX_Z;

function resize(){
  DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  W = Math.floor(rect.width * DPR);
  H = Math.floor(rect.height * DPR);
  canvas.width = W;
  canvas.height = H;
}
resize(); window.addEventListener('resize', resize);
function clampCam(){
  const maxX = GRID_W - W / (TILE * cam.z);
  const maxY = GRID_H - H / (TILE * cam.z);
  cam.x = Math.max(0, Math.min(cam.x, Math.max(0, maxX)));
  cam.y = Math.max(0, Math.min(cam.y, Math.max(0, maxY)));
}

/* ==================== RNG ==================== */
function mulberry32(seed) { return function(){ let t=seed+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; } }
let R = Math.random;
const irnd=(a,b)=> (R()*(b-a+1)|0)+a;
const rnd=(a,b)=> R()*(b-a)+a;
const clamp=(v,mi,ma)=>v<mi?mi:(v>ma?ma:v);
function uid() {
  try { return (crypto.getRandomValues(new Uint32Array(1))[0]>>>0); }
  catch { return Math.floor(Math.random()*2**31); }
}

/* ==================== Tileset (pixel art generated in code) ==================== */
const Tileset = { base:{}, waterOverlay:[], zoneGlyphs:{}, villagerSprites:{}, sprite:{ tree:null, berry:null, sprout:[], animals:{} } };
function makeCanvas(w,h){ const c=document.createElement('canvas'); c.width=w; c.height=h; return c; }
function px(g,x,y,c){ if(!g) return; g.fillStyle=c; g.fillRect(x,y,1,1); }
function rect(g,x,y,w,h,c){ if(!g) return; g.fillStyle=c; g.fillRect(x,y,w,h); }
function makeSprite(w,h,drawFn){
  const c = makeCanvas(w,h);
  const g = context2d(c);
  if (!g) return c;
  if (typeof drawFn === 'function') drawFn(g);
  return c;
}
const SHADOW_TEXTURE = (() => {
  const size = 128;
  const canvas = makeCanvas(size, size);
  const g = context2d(canvas);
  if (!g) return null;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2;
  const gradient = g.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  return canvas;
})();

function makeGrassVariant({ base, blades, shadow, overlay, extras }){
  const c=makeCanvas(TILE,TILE), g=context2d(c);
  if (!g) return c;
  rect(g,0,0,TILE,TILE,base);
  for(let i=0;i<40;i++){
    const color=blades[i % blades.length];
    px(g,irnd(0,TILE-1),irnd(0,TILE-1),color);
  }
  if(shadow){ g.globalAlpha=0.25; rect(g,0,TILE-5,TILE,5,shadow); g.globalAlpha=1; }
  if(overlay){ const oa=(typeof overlay.alpha==='number')?overlay.alpha:1; g.globalAlpha=oa; rect(g,0,0,TILE,TILE,overlay.color); g.globalAlpha=1; }
  if(typeof extras==='function') extras(g);
  return c;
}
function makeGrass(){
  return makeGrassVariant({
    base:'#245a2f',
    blades:['#2f7d3d','#2a6b37','#2a5f34'],
    shadow:'#1a3e22'
  });
}
function makeFertile(){
  return makeGrassVariant({
    base:'#276b33',
    blades:['#358845','#2f7d3d','#2c7036'],
    shadow:'#1a3e22',
    overlay:{ color:'rgba(140,220,145,0.18)', alpha:1 }
  });
}
function makeMeadow(){
  return makeGrassVariant({
    base:'#276f39',
    blades:['#348846','#2f7d3d','#2d7137'],
    shadow:'#1a3e22',
    overlay:{ color:'rgba(200,255,200,0.1)', alpha:1 },
    extras:(g)=>{
      const flowers=['#f4f0c0','#f7b4d4','#d5f5ff'];
      g.globalAlpha=0.85;
      for(let i=0;i<6;i++){
        px(g,irnd(0,TILE-1),irnd(0,TILE-1),flowers[i%flowers.length]);
      }
      g.globalAlpha=1;
    }
  });
}
function makeMarsh(){
  return makeGrassVariant({
    base:'#1f4e32',
    blades:['#2d6a45','#245b3a','#27543a'],
    shadow:'#163724',
    overlay:{ color:'rgba(20,40,35,0.22)', alpha:1 },
    extras:(g)=>{
      const puddles=['#3a6b63','#2f5550'];
      g.globalAlpha=0.35;
      for(let i=0;i<5;i++){
        px(g,irnd(0,TILE-1),irnd(0,TILE-1),puddles[i%puddles.length]);
      }
      g.globalAlpha=1;
    }
  });
}
function makeSand(){ const c=makeCanvas(TILE,TILE), g=context2d(c); if(!g) return c; rect(g,0,0,TILE,TILE,'#b99a52'); for(let i=0;i<28;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#c7ad69':'#a78848'); } return c; }
function makeSnow(){ const c=makeCanvas(TILE,TILE), g=context2d(c); if(!g) return c; rect(g,0,0,TILE,TILE,'#d7e6f8'); for(let i=0;i<24;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), '#c9d7ea'); } rect(g,0,TILE-4,TILE,4,'#c0d0e8'); return c; }
function makeRock(){ const c=makeCanvas(TILE,TILE), g=context2d(c); if(!g) return c; rect(g,0,0,TILE,TILE,'#59616c'); for(let i=0;i<30;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#8f99a5':'#6c757f'); } rect(g,0,TILE-5,TILE,5,'#4a525b'); return c; }
function makeWaterBase(){ const c=makeCanvas(TILE,TILE), g=context2d(c); if(!g) return c; rect(g,0,0,TILE,TILE,'#134a6a'); for (let i = 0; i < 14; i++) { px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#0f3e59':'#0c3248'); } return c; }
function makeWaterOverlayFrames(){ const frames=[]; for(let f=0; f<3; f++){ const c=makeCanvas(TILE,TILE), g=context2d(c); if(!g){ frames.push(c); continue; } g.globalAlpha=0.22; g.strokeStyle='#4fa3d6'; g.lineWidth=1; g.beginPath(); for(let i=0;i<3;i++){ const y=6+i*10+f*2; g.moveTo(0,y); g.quadraticCurveTo(TILE*0.5,y+2,TILE,y); } g.stroke(); g.globalAlpha=1; frames.push(c); } return frames; }
function makeFarmland(){ const c=makeCanvas(TILE,TILE), g=context2d(c); if(!g) return c; rect(g,0,0,TILE,TILE,'#4a3624'); g.globalAlpha=0.25; for(let y=3;y<TILE;y+=6){ rect(g,0,y,TILE,2,'#3b2a1d'); } g.globalAlpha=1; return c; }
function drawSproutOn(g,stage){
  if(!g) return;
  const s=Math.min(3,Math.floor(stage));
  if(s<=0) return;
  const centerX=Math.floor(ENTITY_TILE_PX/2);
  const centerY=Math.floor(ENTITY_TILE_PX/2);
  const gx=centerX-1;
  const gy=centerY-1;
  g.fillStyle='#86c06c';
  g.fillRect(gx,gy,2,2);
  if(s>=2){ g.fillRect(gx-2,gy+2,6,2); }
  if(s>=3){ g.fillRect(gx-1,gy-2,4,2); }
}
function makeZoneGlyphs(){ const farm=makeCanvas(8,8), f=context2d(farm); rect(f,0,0,8,8,'rgba(0,0,0,0)'); px(f,3,6,'#9dd47a'); px(f,4,6,'#9dd47a'); px(f,3,5,'#73b85d'); px(f,4,5,'#73b85d'); px(f,3,4,'#5aa34b'); const cut=makeCanvas(8,8), c=context2d(cut); rect(c,0,0,8,8,'rgba(0,0,0,0)'); rect(c,2,2,4,1,'#caa56a'); rect(c,3,1,2,1,'#8f6934'); const mine=makeCanvas(8,8), m=context2d(mine); rect(m,0,0,8,8,'rgba(0,0,0,0)'); rect(m,2,2,4,1,'#9aa3ad'); rect(m,3,3,2,1,'#6d7782'); Tileset.zoneGlyphs={farm,cut,mine}; }
function makeVillagerFrames(){ function role(shirt,hat){ const frames=[]; for(let f=0; f<3; f++){ const c=makeCanvas(16,16), g=context2d(c); rect(g,7,4,2,2,'#f1d4b6'); if(hat){ rect(g,6,3,4,1,hat); rect(g,6,2,4,1,hat); } rect(g,6,6,4,4,shirt); if(f===0){ rect(g,5,6,1,3,shirt); rect(g,10,6,1,2,shirt); } if(f===1){ rect(g,5,6,1,2,shirt); rect(g,10,6,1,3,shirt); } if(f===2){ rect(g,5,6,1,2,shirt); rect(g,10,6,1,2,shirt); } rect(g,6,10,1,4,'#3f3f4f'); rect(g,9,10,1,4,'#3f3f4f'); frames.push(c);} return frames; } Tileset.villagerSprites.farmer=role('#3aa357','#d6cf74'); Tileset.villagerSprites.worker=role('#a36b3a','#8f7440'); Tileset.villagerSprites.explorer=role('#3a6aa3',null); Tileset.villagerSprites.sleepy=role('#777','#444'); }
function buildTileset(){
  try { Tileset.base.grass = makeGrass(); } catch(e){ console.warn('grass', e); }
  try { Tileset.base.fertile = makeFertile(); } catch(e){ console.warn('fertile', e); }
  try { Tileset.base.meadow = makeMeadow(); } catch(e){ console.warn('meadow', e); }
  try { Tileset.base.marsh = makeMarsh(); } catch(e){ console.warn('marsh', e); }
  try { Tileset.base.sand = makeSand(); } catch(e){ console.warn('sand', e); }
  try { Tileset.base.snow = makeSnow(); } catch(e){ console.warn('snow', e); }
  try { Tileset.base.rock = makeRock(); } catch(e){ console.warn('rock', e); }
  try { Tileset.base.water = makeWaterBase(); } catch(e){ console.warn('water', e); }
  try { Tileset.base.farmland = makeFarmland(); } catch(e){ console.warn('farmland', e); }
  try { Tileset.waterOverlay = makeWaterOverlayFrames(); } catch(e){ console.warn('waterOverlay', e); Tileset.waterOverlay = []; }
  try { makeZoneGlyphs(); } catch(e){ console.warn('zones', e); }
  try { makeVillagerFrames(); } catch(e){ console.warn('villagers', e); }
  try {
    Tileset.sprite.tree = makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, drawTree);
    Tileset.sprite.berry = makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, drawBerry);
    Tileset.sprite.sprout = [
      makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, g=>drawSproutOn(g,1)),
      makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, g=>drawSproutOn(g,2)),
      makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, g=>drawSproutOn(g,3))
    ];
    Tileset.sprite.animals = {
      deer: makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, drawDeer),
      boar: makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, drawBoar)
    };
  } catch(e){ console.warn('sprites', e); }
}

/* ==================== World State ==================== */
const gameState = createInitialState({ seed: Date.now() | 0, cfg: null });
policy.attach(gameState);
gameState.policy = policy;
if (!gameState.bb) {
  gameState.bb = computeBlackboard(gameState, policy);
}
const { units, time, rng, stocks, queue, population } = gameState;
const buildings = units.buildings;
const villagers = units.villagers;
const jobs = units.jobs;
const itemsOnGround = units.itemsOnGround;
const animals = units.animals;
const pendingBirths = [];
const jobNeedState = { food: false, wood: false, stone: false, sow: false, harvest: false };
const jobSuppression = new Map();
const itemTileIndex = new Map();
let itemTileIndexDirty = true;
const storageTotals = stocks.totals;
const storageReserved = stocks.reserved;
const villagerLabels = queue.villagerLabels;
const DAY_LEN = DAY_LENGTH;

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

let lastBlackboardTick = tick;
let lastBlackboardLogTick = tick;
const PLANNER_INTERVAL = { zones: 90, build: 120 };
let lastZonePlanTick = tick - PLANNER_INTERVAL.zones;
let lastBuildPlanTick = tick - PLANNER_INTERVAL.build;

R = typeof rng.generator === 'function' ? rng.generator : Math.random;
Object.defineProperty(rng, 'generator', {
  configurable: true,
  enumerable: true,
  get() {
    return R;
  },
  set(value) {
    if (typeof value === 'function') {
      R = value;
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
  return {
    frame: world?.__debug?.lastFrame ?? 0,
    timeOfDay: snapshotTime,
    villagers: villagerCount,
    lightingMode: LIGHTING?.mode ?? 'unknown',
    multiplyComposite: LIGHTING?.useMultiplyComposite === true
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

function ambientAt(currentDayTime) {
  const theta = (currentDayTime / DAY_LEN) * 2 * Math.PI;
  const cosv = Math.max(0, Math.cos(theta));
  const ramp = cosv * cosv;
  const A = LIGHTING.nightFloor + (1 - LIGHTING.nightFloor) * ramp;
  return Math.min(1.0, A * LIGHTING.exposure);
}

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

setShadingModeImpl = applyShadingMode;
setShadingParamsImpl = applyShadingParams;

if (typeof globalThis !== 'undefined') {
  globalThis.setShadingMode = applyShadingMode;
  globalThis.setShadingParams = applyShadingParams;
  globalThis.SHADING_DEFAULTS = SHADING_DEFAULTS;
}
const BUILDINGS = {
  campfire: { label: 'Campfire', cost: 0, wood: 0, stone: 0, effects:{ radius:4, moodBonus:0.0011 }, tooltip:'Villagers gather here at night; warms and cheers everyone within 4 tiles.' },
  storage:  { label: 'Storage',  cost: 8, wood: 8, stone: 0 },
  hut:      { label: 'Hut',      cost:10, wood:10, stone: 0, effects:{ radius:3, moodBonus:0.0008 }, tooltip:'Shelter that gently lifts moods nearby.' },
  farmplot: {
    label: 'Farm Plot',
    cost: 4,
    wood: 4,
    stone: 0,
    effects: {
      radius: 3,
      growthBonus: 0.85,
      harvestBonus: 0.65
    },
    tooltip: 'Boosts crop growth and yields within 3 tiles.'
  },
  well: {
    label: 'Well',
    cost: 6,
    wood: 0,
    stone: 6,
    effects: {
      hydrationRadius: 4,
      hydrationGrowthBonus: 0.45,
      moodBonus: 0.0007,
      hydrationBuff: 0.25
    },
    tooltip: 'Villagers drink here to stay hydrated; hydrates farms in 4 tiles and keeps nearby villagers cheerful.'
  }
};

const FOOTPRINT = {
  campfire: { w:2, h:2 },
  storage:  { w:2, h:2 },
  hut:      { w:2, h:2 },
  farmplot: { w:2, h:2 },
  well:     { w:2, h:2 }
};

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
  const normalizedSeed = seed >>> 0;
  rng.seed = normalizedSeed;
  rng.generator = mulberry32(normalizedSeed);
  jobs.length=0; buildings.length=0; itemsOnGround.length=0; animals.length=0; markItemsDirty();
  storageTotals.food = 24;
  storageTotals.wood = 12;
  storageTotals.stone = 0;
  storageReserved.food = 0;
  storageReserved.wood = 0;
  storageReserved.stone = 0;
  time.tick = 0;
  time.dayTime = 0;
  tick = time.tick;
  dayTime = time.dayTime;
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
  const startFootprintClear=(kind, tx, ty)=>{
    if(validateFootprintPlacement(kind, tx, ty)!==null) return false;
    const fp=getFootprint(kind);
    for(let yy=0; yy<fp.h; yy++){
      const row=(ty+yy)*GRID_W;
      for(let xx=0; xx<fp.w; xx++){
        const idx=row+(tx+xx);
        const tile=world.tiles[idx];
        if(tile===TILES.WATER || tile===TILES.ROCK) return false;
        if(world.trees[idx]>0 || world.rocks[idx]>0) return false;
      }
    }
    return true;
  };

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

  toast('New pixel map created.');
  toast('Villagers will choose buildings and resource zones automatically.');
  centerCamera(campfire.x,campfire.y); markStaticDirty();
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
function newVillager(x,y){ const v={ id:uid(), x,y,path:[], hunger:rnd(0.2,0.5), energy:rnd(0.5,0.9), happy:rnd(0.4,0.8), hydration:0.7, hydrationBuffTicks:0, nextHydrateTick:0, inv:null, state:'idle', thought:'Wandering', _nextPathTick:0, condition:'normal', starveStage:0, nextStarveWarning:0, sickTimer:0, recoveryTimer:0, ageTicks:0, lifeStage:'adult', pregnancyTimer:0, pregnancyMateId:null, childhoodTimer:0, parents:[], nextPregnancyTick:0, socialTimer:0, nextSocialTick:0, storageIdleTimer:0, nextStorageIdleTick:0, hydrationTimer:0, activeBuildingId:null }; assignAdultTraits(v); return v; }
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
  return b;
}

function getFootprint(kind){
  return FOOTPRINT[kind] || { w:2, h:2 };
}

function buildingCenter(b){
  const fp = getFootprint(b.kind);
  return {
    x: b.x + (fp.w - 1) / 2,
    y: b.y + (fp.h - 1) / 2
  };
}

function forEachFootprintTile(b, fn){
  const fp = getFootprint(b.kind);
  for(let yy=0; yy<fp.h; yy++){
    for(let xx=0; xx<fp.w; xx++){
      fn(b.x + xx, b.y + yy);
    }
  }
}

function tileOccupiedByBuilding(x, y, ignoreId=null){
  for(const b of buildings){
    if(ignoreId && b.id===ignoreId) continue;
    const fp = getFootprint(b.kind);
    if(x>=b.x && x<b.x+fp.w && y>=b.y && y<b.y+fp.h){
      return true;
    }
  }
  return false;
}

function buildingAt(x, y){
  for(const b of buildings){
    const fp=getFootprint(b.kind);
    if(x>=b.x && x<b.x+fp.w && y>=b.y && y<b.y+fp.h){
      return b;
    }
  }
  return null;
}

function validateFootprintPlacement(kind, tx, ty, ignoreId=null){
  const fp = getFootprint(kind);
  if(tx<0 || ty<0 || tx+fp.w>GRID_W || ty+fp.h>GRID_H) return 'bounds';
  for(let yy=0; yy<fp.h; yy++){
    for(let xx=0; xx<fp.w; xx++){
      const gx = tx + xx;
      const gy = ty + yy;
      const i = gy*GRID_W + gx;
      if(world.tiles[i]===TILES.WATER) return 'water';
    }
  }
  for(let yy=0; yy<fp.h; yy++){
    for(let xx=0; xx<fp.w; xx++){
      const gx = tx + xx;
      const gy = ty + yy;
      if(tileOccupiedByBuilding(gx, gy, ignoreId)) return 'occupied';
    }
  }
  return null;
}

function distanceToFootprint(x, y, b){
  const fp = getFootprint(b.kind);
  const minX = b.x;
  const maxX = b.x + fp.w - 1;
  const minY = b.y;
  const maxY = b.y + fp.h - 1;
  let dx = 0;
  if(x < minX) dx = minX - x;
  else if(x > maxX) dx = x - maxX;
  let dy = 0;
  if(y < minY) dy = minY - y;
  else if(y > maxY) dy = y - maxY;
  return dx + dy;
}

function buildingEntryTiles(b){
  const fp = getFootprint(b.kind);
  const tiles=[];
  const x0 = b.x;
  const y0 = b.y;
  const x1 = b.x + fp.w - 1;
  const y1 = b.y + fp.h - 1;
  for(let xx=x0; xx<=x1; xx++){
    tiles.push({x:xx, y:y0-1});
    tiles.push({x:xx, y:y1+1});
  }
  for(let yy=y0; yy<=y1; yy++){
    tiles.push({x:x0-1, y:yy});
    tiles.push({x:x1+1, y:yy});
  }
  return tiles;
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

function ensureBuildingData(b){
  if(!b) return;
  if(!b.store){ b.store={wood:0,stone:0,food:0}; }
  if(!b.spent){
    const def=BUILDINGS[b.kind]||{};
    const cost=def.cost||((def.wood||0)+(def.stone||0));
    const woodReq=def.wood||0;
    const stoneReq=def.stone||0;
    let progress=Math.max(0, b.progress||0);
    if(b.built>=1){
      b.spent={wood:woodReq, stone:stoneReq};
    } else {
      const spentWood=Math.min(progress, woodReq);
      const spentStone=Math.min(Math.max(0, progress-spentWood), stoneReq);
      b.spent={wood:spentWood, stone:spentStone};
    }
    if(b.progress===undefined) b.progress=Math.min(cost, (b.spent.wood||0)+(b.spent.stone||0));
  } else {
    if(typeof b.spent.wood!=='number') b.spent.wood=0;
    if(typeof b.spent.stone!=='number') b.spent.stone=0;
  }
  if(!b.pending){ b.pending={wood:0,stone:0}; }
  if(typeof b.pending.wood!=='number') b.pending.wood=0;
  if(typeof b.pending.stone!=='number') b.pending.stone=0;
  if(typeof b.progress!=='number') b.progress=(b.spent.wood||0)+(b.spent.stone||0);
  if(!b.activity){ b.activity={occupants:0,lastUse:0,lastHydrate:0,lastSocial:0,lastRest:0}; }
  if(typeof b.activity.occupants!=='number') b.activity.occupants=0;
  if(typeof b.activity.lastUse!=='number') b.activity.lastUse=0;
  if(typeof b.activity.lastHydrate!=='number') b.activity.lastHydrate=0;
  if(typeof b.activity.lastSocial!=='number') b.activity.lastSocial=0;
  if(typeof b.activity.lastRest!=='number') b.activity.lastRest=0;
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

function buildingResourceNeed(b, resource){
  const def=BUILDINGS[b?.kind]||{};
  const required=def[resource]||0;
  const spent=b?.spent?.[resource]||0;
  return Math.max(0, required-spent);
}

function buildingSupplyStatus(b){
  ensureBuildingData(b);
  const woodNeed = buildingResourceNeed(b, 'wood');
  const stoneNeed = buildingResourceNeed(b, 'stone');
  const storeWood = b?.store?.wood || 0;
  const storeStone = b?.store?.stone || 0;
  const pendingWood = b?.pending?.wood || 0;
  const pendingStone = b?.pending?.stone || 0;
  const reservedWood = storeWood + pendingWood;
  const reservedStone = storeStone + pendingStone;
  const requiresResources = (woodNeed > 0) || (stoneNeed > 0);
  const hasAnySupply = requiresResources ? (reservedWood > 0 || reservedStone > 0) : true;
  const hasAllReserved = reservedWood >= woodNeed && reservedStone >= stoneNeed;
  const fullyDelivered = storeWood >= woodNeed && storeStone >= stoneNeed;
  return {
    woodNeed,
    stoneNeed,
    storeWood,
    storeStone,
    pendingWood,
    pendingStone,
    reservedWood,
    reservedStone,
    hasAnySupply,
    hasAllReserved,
    fullyDelivered
  };
}

function agricultureBonusesAt(x,y){
  let growthBonus=0, harvestBonus=0, moodBonus=0;
  if(!buildings.length) return {growthBonus, harvestBonus, moodBonus};
  const influenceFor=(radius, dist)=>{
    if(radius>0){ return dist>radius?0:Math.max(0,1-dist/(radius+1)); }
    return dist===0?1:0;
  };
  for(const b of buildings){
    if(b.built<1) continue;
    const def=BUILDINGS[b.kind]||{};
    const eff=def.effects||{};
    const dist=distanceToFootprint(x,y,b);
    if(b.kind==='farmplot'){
      const radius=(eff.radius|0);
      const influence=influenceFor(radius, dist);
      if(influence<=0) continue;
      if(eff.growthBonus){ growthBonus+=eff.growthBonus*influence; }
      if(eff.harvestBonus){ harvestBonus+=eff.harvestBonus*influence; }
    } else if(b.kind==='well'){
      const radius=(eff.hydrationRadius|0);
      const influence=influenceFor(radius, dist);
      if(influence<=0) continue;
      if(eff.hydrationGrowthBonus){ growthBonus+=eff.hydrationGrowthBonus*influence; }
      if(eff.harvestBonus){ harvestBonus+=eff.harvestBonus*influence; }
      if(eff.moodBonus){ moodBonus+=eff.moodBonus*influence; }
    } else if(eff.moodBonus){
      const radius=(eff.radius|0);
      const influence=influenceFor(radius, dist);
      if(influence<=0) continue;
      moodBonus+=eff.moodBonus*influence;
    }
  }
  return { growthBonus, harvestBonus, moodBonus };
}

/* ==================== UI & Sheets ==================== */
const el=(id)=>document.getElementById(id);

// --- Toast system (top center, queued, auto-dismiss) ---
const Toast = (() => {
  const host = document.createElement('div');
  host.id = 'toastHost';
  host.style.cssText = `
    position:fixed; top:72px; left:50%; transform:translateX(-50%);
    display:flex; flex-direction:column; gap:8px; z-index:5000; pointer-events:none;
  `;
  document.body.appendChild(host);

  const q=[];
  let showing=0;

  function show(text, ms=2200){
    q.push({text, ms});
    if(!showing) next();
  }
  function next(){
    if(!q.length){ showing=0; return; }
    showing=1;
    const {text, ms}=q.shift();
    const el=document.createElement('div');
    el.className='toast';
    el.textContent=text;
    el.style.cssText=`
      background: rgba(20,24,33,0.96);
      border:1px solid rgba(255,255,255,0.12);
      color:#e9f1ff; font-weight:700; font-size:14px;
      border-radius:12px; padding:10px 14px; box-shadow:0 6px 18px rgba(0,0,0,.35);
    `;
    host.appendChild(el);
    setTimeout(()=>{
      el.style.transition='opacity .2s ease, transform .2s ease';
      el.style.opacity='0'; el.style.transform='translateY(-6px)';
      setTimeout(()=>{ el.remove(); next(); },220);
    }, ms);
  }
  return { show };
})();

// Legacy shim for old toast() calls
window.toast = (msg, ms) => Toast.show(msg, ms);

let ui={ mode:'inspect' };

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

el('btnPause').addEventListener('click', ()=> { paused=!paused; el('btnPause').textContent=paused?'▶️':'⏸'; });
el('btnSpeed').addEventListener('click', ()=> { speedIdx=(speedIdx+1)%SPEEDS.length; el('btnSpeed').textContent=SPEEDS[speedIdx]+'×'; });
el('btnPrior').addEventListener('click', ()=> {
  const sheet=document.getElementById('sheetPrior');
  const open=sheet.getAttribute('data-open')==='true';
  toggleSheet('sheetPrior', !open);
});
const btnSave=el('btnSave');
if(!Storage.available){ btnSave.disabled=true; btnSave.title='Saving unavailable in this context'; }
btnSave.addEventListener('click', ()=>{ if(!Storage.available){ Toast.show('Saving disabled in this context'); return; } saveGame(); Toast.show('Saved.'); });
el('btnNew').addEventListener('click', ()=> { newWorld(); });
el('btnHelpClose').addEventListener('click', ()=> { el('help').style.display='none'; Storage.set('aiv_help_px3','1'); });
function toggleSheet(id, open){ const el=document.getElementById(id); if(!el) return; el.setAttribute('data-open', open?'true':'false'); }
['sheetPrior'].forEach(id=>{ const s=document.getElementById(id); s.addEventListener('click', (e)=>{ if(e.target.closest('.sheet-close')) toggleSheet(id,false); }); });

document.addEventListener('click', (e)=>{
  if(e.target.closest('.sheet') || e.target.closest('.pill-controls')) return;
  toggleSheet('sheetPrior', false);
});

/* ==================== Pointer Input ==================== */
const activePointers = new Map();
let primaryPointer = null;
let pinch = null;

// tiny tap debugger to confirm events
const dbg = document.createElement('div');
dbg.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:5000;color:#9cb2cc;font:12px system-ui;pointer-events:none';
document.body.appendChild(dbg);
const setDbg = (s)=> dbg.textContent = s;

function pointerScale(){
  const r = canvas.getBoundingClientRect();
  return { sx: canvas.width / r.width, sy: canvas.height / r.height };
}

function screenToWorld(px, py){
  const rect = canvas.getBoundingClientRect();         // CSS pixels
  const sx = (px - rect.left) * (canvas.width  / rect.width);   // device px
  const sy = (py - rect.top)  * (canvas.height / rect.height);  // device px
  // camera is in tiles; conversion helpers live in coords
  return {
    x: pxToTileX(sx, cam),
    y: pxToTileY(sy, cam)
  };
}

function toTile(v){ return Math.floor(v); }

canvas.addEventListener('pointerdown', (e)=>{
  setDbg(`down ${e.pointerType} mode=${ui.mode}`);
  activePointers.set(e.pointerId, {x:e.clientX, y:e.clientY, type:e.pointerType});
  canvas.setPointerCapture(e.pointerId);
  if(e.pointerType==='touch' && activePointers.size===2){
    const pts = Array.from(activePointers.values());
    pinch = {
      startDist: Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y),
      startZ: cam.z,
      midx: (pts[0].x+pts[1].x)/2,
      midy: (pts[0].y+pts[1].y)/2
    };
    primaryPointer = null;
  } else if(!primaryPointer){
    primaryPointer = {id:e.pointerId, sx:e.clientX, sy:e.clientY, camx:cam.x, camy:cam.y};
  }
  e.preventDefault();
},{passive:false});

canvas.addEventListener('pointermove', (e)=>{
  if(!activePointers.has(e.pointerId)) return;
  const p = activePointers.get(e.pointerId);
  p.x=e.clientX; p.y=e.clientY; activePointers.set(e.pointerId,p);
  const {sx:scaleX, sy:scaleY} = pointerScale();
  if(pinch && activePointers.size===2){
    const pts = Array.from(activePointers.values());
    const dist = Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
    const before = screenToWorld(pinch.midx, pinch.midy);
    cam.z = clamp((dist/(pinch.startDist||1))*pinch.startZ, MIN_Z, MAX_Z);
    const after = screenToWorld(pinch.midx, pinch.midy);
    cam.x += (after.x - before.x);
    cam.y += (after.y - before.y);
    const midx = (pts[0].x + pts[1].x) / 2,
          midy = (pts[0].y + pts[1].y) / 2;
    cam.x -= pxToTileX((midx - pinch.midx) * scaleX, cam) - cam.x;
    cam.y -= pxToTileY((midy - pinch.midy) * scaleY, cam) - cam.y;
    pinch.midx = midx; pinch.midy = midy;
    clampCam();
  } else if(primaryPointer && e.pointerId===primaryPointer.id){
    const dx=(e.clientX-primaryPointer.sx)*scaleX;
    const dy=(e.clientY-primaryPointer.sy)*scaleY;
    const dtX = pxToTileX(dx, cam) - cam.x;
    const dtY = pxToTileY(dy, cam) - cam.y;
    cam.x = primaryPointer.camx - dtX;
    cam.y = primaryPointer.camy - dtY;
    clampCam();
  }
},{passive:false});

function endPointer(e){
  activePointers.delete(e.pointerId);
  if(primaryPointer && e.pointerId===primaryPointer.id) primaryPointer=null;
  if(activePointers.size<2) pinch=null;
}

canvas.addEventListener('pointerup', endPointer, {passive:false});
canvas.addEventListener('pointercancel', endPointer, {passive:false});
canvas.addEventListener('pointerleave', endPointer, {passive:false});

canvas.addEventListener('wheel', (e)=>{
  const delta=Math.sign(e.deltaY); const scale=delta>0?1/1.1:1.1; const mx=e.clientX,my=e.clientY;
  const before=screenToWorld(mx,my); cam.z=clamp(cam.z*scale, MIN_Z, MAX_Z); const after=screenToWorld(mx,my);
cam.x += (after.x - before.x); cam.y += (after.y - before.y); clampCam();
});

window.addEventListener('keydown', (e)=>{
  if((e.key==='l' || e.key==='L') && e.altKey){
    LIGHTING.debugShowLightmap = !LIGHTING.debugShowLightmap;
    e.preventDefault();
  }
});

/* ==================== Automation Helpers ==================== */
document.getElementById('prioFood').addEventListener('input', e=> policy.sliders.food=(parseInt(e.target.value,10)||0)/100 );
document.getElementById('prioBuild').addEventListener('input', e=> policy.sliders.build=(parseInt(e.target.value,10)||0)/100 );
document.getElementById('prioExplore').addEventListener('input', e=> policy.sliders.explore=(parseInt(e.target.value,10)||0)/100 );

function availableToReserve(resource){
  return (storageTotals[resource]||0) - (storageReserved[resource]||0);
}

function countZoneTiles(zone){
  if(!world || !world.zone) return 0;
  let total=0;
  for(let i=0;i<world.zone.length;i++){
    if(world.zone[i]===zone) total++;
  }
  return total;
}

function countNaturalResourceTiles(kind){
  if(!world) return 0;
  const source = kind==='wood' ? world.trees : world.rocks;
  if(!source) return 0;
  let total=0;
  for(let i=0;i<source.length;i++){
    if(source[i]>0 && world.tiles[i]!==TILES.WATER) total++;
  }
  return total;
}

function countBuildingsByKind(kind){
  let built=0, planned=0;
  for(const b of buildings){
    if(!b || b.kind!==kind) continue;
    if(b.built>=1) built++; else planned++;
  }
  return { built, planned, total: built+planned };
}

function outstandingResource(resource){
  let need=0;
  for(const b of buildings){
    if(!b || b.built>=1) continue;
    const status=buildingSupplyStatus(b);
    const required = resource==='wood' ? status.woodNeed : status.stoneNeed;
    const reserved = resource==='wood' ? status.reservedWood : status.reservedStone;
    need += Math.max(0, required - reserved);
  }
  return need;
}

function resourcePressure(resource, buffer=0){
  const available=availableToReserve(resource);
  const outstanding = outstandingResource(resource);
  return Math.max(0, outstanding + buffer - available);
}

function zoneCentroid(zone){
  if(!world || !world.zone) return null;
  let sumX=0,sumY=0,count=0;
  for(let i=0;i<world.zone.length;i++){
    if(world.zone[i]!==zone) continue;
    const x=i%GRID_W;
    const y=(i/GRID_W)|0;
    sumX+=x; sumY+=y; count++;
  }
  if(count===0) return null;
  return { x:sumX/count, y:sumY/count };
}

function findPrimaryAnchor(){
  const camp=buildings.find(b=>b.kind==='campfire');
  if(camp) return buildingCenter(camp);
  const storage=findNearestBuilding?.(GRID_W/2, GRID_H/2, 'storage');
  if(storage) return buildingCenter(storage);
  return { x:GRID_W*0.5, y:GRID_H*0.5 };
}

function findPlacementNear(kind, anchorX, anchorY, maxRadius=18, context={}){
  const fp=getFootprint(kind);
  let best=null, bestScore=-Infinity;
  const anchorTx=Math.round(anchorX);
  const anchorTy=Math.round(anchorY);
  let reachableFound=false;

  const nearbyZoneScore=(zone,x,y,radius=3)=>{
    if(!world?.zone) return 0;
    let count=0;
    for(let yy=y-radius; yy<=y+radius; yy++){
      for(let xx=x-radius; xx<=x+radius; xx++){
        if(xx<0||yy<0||xx>=GRID_W||yy>=GRID_H) continue;
        const i=yy*GRID_W+xx;
        if(world.zone[i]===zone) count++;
      }
    }
    return count;
  };

  const resourceDensity=(resource,x,y,radius=2)=>{
    if(!world) return 0;
    const source = resource==='wood' ? world.trees : world.rocks;
    if(!source) return 0;
    let score=0;
    for(let yy=y-radius; yy<=y+radius; yy++){
      for(let xx=x-radius; xx<=x+radius; xx++){
        if(xx<0||yy<0||xx>=GRID_W||yy>=GRID_H) continue;
        const i=yy*GRID_W+xx;
        score += Math.max(0, source[i]||0);
      }
    }
    return score;
  };

  const fertileScore=(x,y,radius=1)=>{
    if(!world?.tiles) return 0;
    let score=0;
    for(let yy=y-radius; yy<=y+radius; yy++){
      for(let xx=x-radius; xx<=x+radius; xx++){
        if(xx<0||yy<0||xx>=GRID_W||yy>=GRID_H) continue;
        const tile=world.tiles[yy*GRID_W+xx];
        if(tile===TILES.FERTILE||tile===TILES.MEADOW) score+=2;
        else if(tile===TILES.GRASS) score+=1;
      }
    }
    return score;
  };

  for(let r=0; r<=maxRadius; r++){
    const minX=Math.max(0, Math.floor(anchorX - r));
    const maxX=Math.min(GRID_W - fp.w, Math.floor(anchorX + r));
    const minY=Math.max(0, Math.floor(anchorY - r));
    const maxY=Math.min(GRID_H - fp.h, Math.floor(anchorY + r));
    for(let y=minY; y<=maxY; y++){
      for(let x=minX; x<=maxX; x++){
        if(validateFootprintPlacement(kind, x, y)!==null) continue;
        const cx=x+(fp.w-1)/2;
        const cy=y+(fp.h-1)/2;
        const baseDist=Math.abs(cx-anchorX)+Math.abs(cy-anchorY);
        let score=-baseDist;

        if(kind==='hut'){
          score+=nearbyZoneScore(ZONES.FARM,cx,cy,4)*-0.3;
          score+=nearbyZoneScore(ZONES.CUT,cx,cy,3)*-0.1;
        }
        if(kind==='farmplot'){
          score+=nearbyZoneScore(ZONES.FARM,cx,cy,3)*1.8;
          score+=fertileScore(cx,cy,2)*0.6;
        }
        if(kind==='well'){
          score+=nearbyZoneScore(ZONES.FARM,cx,cy,4)*2.2;
          score+=fertileScore(cx,cy,1)*0.2;
        }
        if(kind==='storage'){
          score+=nearbyZoneScore(ZONES.CUT,cx,cy,4)*1.1;
          score+=nearbyZoneScore(ZONES.MINE,cx,cy,4)*1.1;
          score+=resourceDensity('wood',cx,cy,2)*0.05;
          score+=resourceDensity('stone',cx,cy,2)*0.06;
        }

        // prefer tiles that keep builds connected via real paths
        if(score>bestScore-4){
          const path=pathfind(anchorTx, anchorTy, Math.round(cx), Math.round(cy), Math.max(140, maxRadius*8));
          if(!path) continue;
          reachableFound=true;
          const pathCost=path.length || baseDist*2;
          score -= pathCost*0.35;
        } else {
          continue;
        }

        if(score>bestScore){
          bestScore=score;
          best={x,y};
        }
      }
    }
  }
  if(!reachableFound && maxRadius<Math.max(GRID_W, GRID_H)){
    const nextRadius=Math.min(Math.max(GRID_W, GRID_H), maxRadius+8);
    if(nextRadius>maxRadius){
      return findPlacementNear(kind, anchorX, anchorY, nextRadius, { ...context, expanded:true });
    }
  }
  return reachableFound ? best : null;
}

function ensureZoneCoverage(zone, targetTiles, anchor, radius=0){
  if(!anchor) anchor=findPrimaryAnchor();
  let current=countZoneTiles(zone);
  if(current>=targetTiles) return false;
  const baseSearchRadius=Math.max(6, Math.ceil(targetTiles*0.6));
  const anchorX=Math.round(anchor.x);
  const anchorY=Math.round(anchor.y);
  const fertilityNeighborhood=(x,y,radius)=>{
    let fertile=0;
    for(let yy=y-radius; yy<=y+radius; yy++){
      for(let xx=x-radius; xx<=x+radius; xx++){
        if(xx<0||yy<0||xx>=GRID_W||yy>=GRID_H) continue;
        const tile=world.tiles[yy*GRID_W+xx];
        if(tile===TILES.FERTILE||tile===TILES.MEADOW) fertile++;
      }
    }
    return fertile;
  };

  const woodDensity=(x,y,radius)=>{
    let total=0;
    for(let yy=y-radius; yy<=y+radius; yy++){
      for(let xx=x-radius; xx<=x+radius; xx++){
        if(xx<0||yy<0||xx>=GRID_W||yy>=GRID_H) continue;
        total+=Math.max(0, world.trees[yy*GRID_W+xx]||0);
      }
    }
    return total;
  };

  const stoneDensity=(x,y,radius)=>{
    let total=0;
    for(let yy=y-radius; yy<=y+radius; yy++){
      for(let xx=x-radius; xx<=x+radius; xx++){
        if(xx<0||yy<0||xx>=GRID_W||yy>=GRID_H) continue;
        total+=Math.max(0, world.rocks[yy*GRID_W+xx]||0);
      }
    }
    return total;
  };

  const cohesionScore=(x,y)=>{
    let adj=0;
    for(let yy=y-1; yy<=y+1; yy++){
      for(let xx=x-1; xx<=x+1; xx++){
        if(xx<0||yy<0||xx>=GRID_W||yy>=GRID_H||(xx===x&&yy===y)) continue;
        if(world.zone[yy*GRID_W+xx]===zone) adj++;
      }
    }
    return adj;
  };

  const localResourceScore=(x,y)=>{
    const i=y*GRID_W+x;
    if(zone===ZONES.FARM){
      const tile=world.tiles[i];
      let s = (tile===TILES.FERTILE?5:0)+(tile===TILES.MEADOW?4:0)+(tile===TILES.GRASS?2:0);
      if(world.trees[i]>0 || world.rocks[i]>0) s-=3;
      return s + fertilityNeighborhood(x,y,2)*0.4;
    }
    if(zone===ZONES.CUT){
      return woodDensity(x,y,2)*0.45;
    }
    if(zone===ZONES.MINE){
      return stoneDensity(x,y,2)*0.55;
    }
    return 0;
  };

  const attemptPlacement=(searchRadius)=>{
    const candidates=[];
    const minX=Math.max(0, Math.floor(anchor.x - searchRadius));
    const maxX=Math.min(GRID_W-1, Math.floor(anchor.x + searchRadius));
    const minY=Math.max(0, Math.floor(anchor.y - searchRadius));
    const maxY=Math.min(GRID_H-1, Math.floor(anchor.y + searchRadius));
    for(let y=minY; y<=maxY; y++){
      for(let x=minX; x<=maxX; x++){
        const i=y*GRID_W+x;
        if(world.zone[i]===zone) continue;
        if(!zoneCanEverWork(zone, i)) continue;
        if(tileOccupiedByBuilding(x,y)) continue;
        const dist=Math.abs(x-anchor.x)+Math.abs(y-anchor.y);
        const score=localResourceScore(x,y)+cohesionScore(x,y)*1.2 - dist*0.35;
        candidates.push({x,y,score});
      }
    }

    candidates.sort((a,b)=>b.score-a.score);
    let reachableSeen=false;
    let changed=false;
    const pathable=[];
    const pathLimit=Math.max(120, searchRadius*3);
    for(const c of candidates){
      if(current>=targetTiles) break;
      if(c.score<=-Infinity) continue;
      const path=pathfind(anchorX, anchorY, c.x, c.y, pathLimit);
      if(!path) continue;
      reachableSeen=true;
      const pathCost=path.length || Math.abs(c.x-anchorX)+Math.abs(c.y-anchorY);
      const adjustedScore=c.score - pathCost*0.2;
      if(adjustedScore<=-Infinity) continue;
      pathable.push({ ...c, adjustedScore });
    }

    pathable.sort((a,b)=>b.adjustedScore-a.adjustedScore);
    for(const c of pathable){
      if(current>=targetTiles) break;
      if(applyZoneBrush(c.x,c.y,zone,radius)){
        changed=true;
        current=countZoneTiles(zone);
      }
    }
    return { changed, reachableSeen };
  };

  let changed=false;
  const firstPass=attemptPlacement(baseSearchRadius);
  changed=changed||firstPass.changed;
  const needMore=current<targetTiles;
  if(needMore && firstPass.reachableSeen){
    const expandedRadius=Math.min(Math.max(GRID_W, GRID_H), baseSearchRadius+8);
    if(expandedRadius>baseSearchRadius){
      const secondPass=attemptPlacement(expandedRadius);
      changed=changed||secondPass.changed;
    }
  }
  return changed;
}

function planZones(bb){
  if(!world) return false;
  const anchor=findPrimaryAnchor();
  const villagerCount=Math.max(1, villagers.length||0);
  const baseFarmTarget=Math.max(6, Math.ceil(villagerCount*3));
  const famineSeverity = computeFamineSeverity(bb);
  const lowFood = (bb?.availableFood ?? Infinity) < villagerCount * 2;
  let farmTarget=baseFarmTarget;
  if(bb?.famine || lowFood){
    const famineScale = 1.25 + famineSeverity * 0.75;
    const safetyFloor = Math.max(baseFarmTarget, Math.ceil(villagerCount * 3.5));
    farmTarget = Math.max(safetyFloor, Math.ceil(baseFarmTarget * famineScale));
  }
  const farmTiles=countZoneTiles(ZONES.FARM);
  const woodPressure=resourcePressure('wood', 6);
  const stonePressure=resourcePressure('stone', 3);
  let changed=false;

  if(bb?.famine || bb?.availableFood < villagerCount*2 || farmTiles<farmTarget){
    changed = ensureZoneCoverage(ZONES.FARM, farmTarget, zoneCentroid(ZONES.FARM)||anchor, 1) || changed;
  }

  const naturalTrees=countNaturalResourceTiles('wood');
  const cutTarget=woodPressure>0 ? Math.min(naturalTrees, Math.max(8, Math.ceil(woodPressure*2))) : 0;
  if(cutTarget>0 && countZoneTiles(ZONES.CUT)<cutTarget){
    changed = ensureZoneCoverage(ZONES.CUT, cutTarget, anchor, 0) || changed;
  }

  const naturalRocks=countNaturalResourceTiles('stone');
  const mineTarget=stonePressure>0 ? Math.min(naturalRocks, Math.max(4, Math.ceil(stonePressure*1.5))) : 0;
  if(mineTarget>0 && countZoneTiles(ZONES.MINE)<mineTarget){
    const rockAnchor=zoneCentroid(ZONES.MINE) || anchor;
    changed = ensureZoneCoverage(ZONES.MINE, mineTarget, rockAnchor, 0) || changed;
  }

  if(changed){
    generateJobs();
  }
  return changed;
}

function planBuildings(bb){
  if(!world) return false;
  const anchor=findPrimaryAnchor();
  const villagerCount=Math.max(1, villagers.length||0);
  let placed=false;

  const TUNING={
    famineFarmMultiplier:1.4,
    winterPrepBonus:0.35,
    foodGapWeight:0.2,
    hutFatigueGate:0.35,
    storageWoodBuffer:18,
    wellWoodBuffer:10,
    maxPlacements:3
  };

  const famine=!!bb?.famine;
  const availableFood=bb?.availableFood ?? Infinity;
  const availableWood=bb?.availableWood ?? availableToReserve('wood');
  const availableStone=bb?.availableStone ?? availableToReserve('stone');
  const season=bb?.season ?? 0;
  const seasonProgress=bb?.seasonProgress ?? 0;
  const approachingWinter=(season===2 && seasonProgress>0.55) || season===3;
  const growthPush=!!bb?.growthPush;
  const energy=bb?.energy || {};
  const lowEnergy=!!energy.fatigue || (energy.avgEnergy ?? 1)<TUNING.hutFatigueGate;
  const foodGap=Math.max(0, villagerCount*2 - availableFood);

  const hutCounts=countBuildingsByKind('hut');
  const farmTiles=countZoneTiles(ZONES.FARM);
  const farmplotCounts=countBuildingsByKind('farmplot');
  const wellCounts=countBuildingsByKind('well');
  const storageCounts=countBuildingsByKind('storage');

  const plannedTotals={
    hut: hutCounts.total,
    farmplot: farmplotCounts.total,
    well: wellCounts.total,
    storage: storageCounts.total
  };

  const hutTargetBase=Math.max(1, Math.ceil(villagerCount/2));
  const hutTarget=lowEnergy ? Math.max(hutCounts.built, Math.ceil(hutTargetBase*0.85)) : hutTargetBase;

  let desiredFarmplots=farmTiles>0 ? Math.max(1, Math.floor(farmTiles/8)) : 0;
  const farmUrgency=1
    + (famine ? TUNING.famineFarmMultiplier-1 : 0)
    + (foodGap>0 ? Math.min(0.8, (foodGap/Math.max(1, villagerCount*2))*(1+TUNING.foodGapWeight)) : 0)
    + (approachingWinter ? TUNING.winterPrepBonus : 0)
    + (growthPush ? 0.25 : 0);
  if(farmTiles>0){
    desiredFarmplots=Math.max(desiredFarmplots, Math.round(Math.max(1, farmTiles/8) * farmUrgency));
  } else if(famine){
    desiredFarmplots=Math.max(desiredFarmplots, Math.round(farmUrgency));
  }

  let wellTarget=farmTiles>=8 ? 1 : 0;
  if(approachingWinter && farmTiles>=6) wellTarget=1;
  if(famine && !approachingWinter && farmTiles<16) wellTarget=0;

  let storageTarget=famine ? 1 : 2;
  const woodBufferOk=availableWood>TUNING.storageWoodBuffer;
  if(!woodBufferOk) storageTarget=Math.min(storageTarget, 1);

  const buildQueue=[];
  if(plannedTotals.hut < hutTarget && (!lowEnergy || hutCounts.total<hutTargetBase)){
    const fatiguePenalty=lowEnergy ? 1 : 0;
    buildQueue.push({ priority:1+fatiguePenalty, kind:'hut', anchor:{ x:anchor.x+2, y:anchor.y+1 }, reason:'shelter plan' });
  }
  if(desiredFarmplots>plannedTotals.farmplot){
    const farmAnchor=zoneCentroid(ZONES.FARM) || anchor;
    const farmPriority=famine ? 0.5 : (approachingWinter ? 1 : 2);
    buildQueue.push({ priority:farmPriority, kind:'farmplot', anchor:farmAnchor, reason:'support crops', radius:14 });
  }
  if(wellTarget>plannedTotals.well && (availableWood>TUNING.wellWoodBuffer || availableStone>0) && (!famine || approachingWinter)){
    const farmAnchor=zoneCentroid(ZONES.FARM) || anchor;
    const prio=approachingWinter ? 2.5 : 3;
    buildQueue.push({ priority:prio, kind:'well', anchor:farmAnchor, reason:approachingWinter?'prepare for winter water':'hydrate farms', radius:16 });
  }
  if(plannedTotals.storage<storageTarget && (woodBufferOk || storageCounts.built===0) && (!famine || storageCounts.total===0)){
    buildQueue.push({ priority:famine?6:4, kind:'storage', anchor:{ x:anchor.x-2, y:anchor.y }, reason:'extra storage', radius:18 });
  }

  buildQueue.sort((a,b)=>a.priority-b.priority);

  const targetByKind={
    hut: hutTarget,
    farmplot: desiredFarmplots,
    well: wellTarget,
    storage: storageTarget
  };
  const maxPlacements=Math.min(TUNING.maxPlacements, buildQueue.length);
  let placedThisTick=0;
  for(const task of buildQueue){
    if(placedThisTick>=maxPlacements) break;
    const def=BUILDINGS[task.kind]||{};
    if((def.wood||0)>0 && availableToReserve('wood')<def.wood) continue;
    if((def.stone||0)>0 && availableToReserve('stone')<def.stone) continue;
    if(plannedTotals[task.kind]>= (targetByKind[task.kind] ?? 0)) continue;

    const pos=findPlacementNear(task.kind, task.anchor.x, task.anchor.y, task.radius||18, task.context||{});
    if(pos){
      placeBlueprint(task.kind, pos.x, pos.y, { reason:task.reason });
      plannedTotals[task.kind]++;
      placed=true;
      placedThisTick++;
    }
  }

  return placed;
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
      jobs.splice(i,1);
    }
  }
}
function idx(x,y){ if(x<0||y<0||x>=GRID_W||y>=GRID_H) return -1; return baseIdx(x,y); }
function getTile(x,y){ const i=idx(x,y); if(i<0) return null; return { t:world.tiles[i], i }; }
function centerCamera(x,y){
  cam.z = 2.2;
  cam.x = x - W / (TILE * cam.z) * 0.5;
  cam.y = y - H / (TILE * cam.z) * 0.5;
  clampCam();
}
function applyZoneBrush(cx, cy, z, radius=0){
  const x0 = toTile(cx), y0 = toTile(cy);
  if (x0 < 0 || y0 < 0 || x0 >= GRID_W || y0 >= GRID_H) return false;
  const r = Math.max(0, Math.floor(radius));
  const touchedRows = new Set();
  for (let y = y0 - r; y <= y0 + r; y++){
    for (let x = x0 - r; x <= x0 + r; x++){
      if (x<0 || y<0 || x>=GRID_W || y>=GRID_H) continue;
      const i = y*GRID_W + x;
      if(z===ZONES.NONE){
        if(world.zone[i] !== ZONES.NONE){
          world.zone[i] = ZONES.NONE;
          touchedRows.add(y);
        }
        continue;
      }
      if(tileOccupiedByBuilding(x, y)) continue;
      if(zoneCanEverWork(z, i)){
        if(world.zone[i] !== z){
          world.zone[i] = z;
          touchedRows.add(y);
        }
      }
    }
  }
  touchedRows.forEach(updateZoneRow);
  if (touchedRows.size > 0) markZoneOverlayDirty();
  return touchedRows.size>0;
}
function placeBlueprint(kind,x,y, opts={}){
  const tx=toTile(x), ty=toTile(y);
  if(tx<0||ty<0||tx>=GRID_W||ty>=GRID_H) return;
  const result=validateFootprintPlacement(kind, tx, ty);
  if(result==='bounds') return;
  if(result==='water'){ Toast.show('Cannot build on water.'); return; }
  if(result==='occupied'){ Toast.show('Tile occupied.'); return; }
  const fp=getFootprint(kind);
  const touchedRows = new Set();
  for(let yy=0; yy<fp.h; yy++){
    for(let xx=0; xx<fp.w; xx++){
      const idx=(ty+yy)*GRID_W + (tx+xx);
      if(world.zone[idx] !== ZONES.NONE){
        world.zone[idx]=ZONES.NONE;
        touchedRows.add(ty+yy);
      }
    }
  }
  touchedRows.forEach(updateZoneRow);
  if (touchedRows.size > 0) markZoneOverlayDirty();
  const b=addBuilding(kind,tx,ty,{built:0}); requestBuildHauls(b); markStaticDirty();
  const def=BUILDINGS[kind];
  const label=def?.label||kind;
  if(opts.silent!==true){
    const reason=opts.reason?` (${opts.reason})`:'';
    Toast.show(`Villagers planned a ${label}${reason}.`);
  }
}

/* ==================== Jobs & AI (trimmed to essentials) ==================== */
function getJobCreationConfig(){
  return policy?.style?.jobCreation || {};
}

function ensureBlackboardSnapshot(){
  const cadence = Number.isFinite(policy?.routine?.blackboardCadenceTicks)
    ? policy.routine.blackboardCadenceTicks
    : 30;
  if(!gameState.bb || (tick-lastBlackboardTick)>cadence){
    gameState.bb = computeBlackboard(gameState, policy);
    lastBlackboardTick = tick;
  }
  return gameState.bb;
}

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

function evaluateResourceNeed(kind, available, villagerCount, cfg, thresholdKey, stateKey=kind){
  const threshold = Number.isFinite(cfg?.[thresholdKey]) ? cfg[thresholdKey] : 0;
  const hysteresis = Number.isFinite(cfg?.hysteresis) ? cfg.hysteresis : 0;
  const ratio = villagerCount>0 ? available/Math.max(1,villagerCount) : available;
  const prevNeed = jobNeedState[stateKey]===true;
  let need = ratio < threshold;
  if(!need && prevNeed && ratio < (threshold + hysteresis)){
    need = true;
  }
  jobNeedState[stateKey] = need;
  return need;
}

function hasAnyFarmTiles(){
  if(!world) return false;
  if(world.zone && countZoneTiles(ZONES.FARM) > 0) return true;
  if(world.tiles){
    for(let i=0;i<world.tiles.length;i++){
      if(world.tiles[i]===TILES.FARMLAND) return true;
    }
  }
  return false;
}

function hasRipeCrops(threshold=160){
  if(!world || !world.growth || !world.tiles) return false;
  for(let i=0;i<world.growth.length;i++){
    if(world.tiles[i]===TILES.FARMLAND && world.growth[i]>=threshold) return true;
  }
  return false;
}

function shouldGenerateJobType(type, bb, cfg){
  if(!bb) return true;
  const villagersCount = Math.max(1, bb.villagers || 0);
  if(type==='forage'){
    if(bb.famine) return true;
    return evaluateResourceNeed('food', bb.availableFood || 0, villagersCount, cfg, 'minFoodPerVillager', 'food');
  }
  if(type==='sow' || type==='harvest'){
    if(bb.famine) return true;
    if(hasAnyFarmTiles()) return true;
    return evaluateResourceNeed('food', bb.availableFood || 0, villagersCount, cfg, 'minFoodPerVillager', type);
  }
  if(type==='chop'){
    return evaluateResourceNeed('wood', bb.availableWood || 0, villagersCount, cfg, 'minWoodPerVillager');
  }
  if(type==='mine'){
    return evaluateResourceNeed('stone', bb.availableStone || 0, villagersCount, cfg, 'minStonePerVillager');
  }
  return true;
}

function addJob(job){
  if(!job || !job.type) return null;
  if(hasSimilarJob(job) || isJobSuppressed(job)) return null;
  job.id=uid(); job.assigned=0; jobs.push(job); return job;
}
function moodMotivation(v){ return clamp((v.happy-0.5)*2,-1,1); }
function moodPrefix(v){
  if(v.happy>=0.8) return '😊 ';
  if(v.happy>=0.6) return '🙂 ';
  if(v.happy<=0.2) return '☹️ ';
  if(v.happy<=0.4) return '😟 ';
  return '';
}
function moodThought(v, base){ const prefix=moodPrefix(v); return prefix?`${prefix}${base}`:base; }
function finishJob(v, remove=false){
  const job = v.targetJob;
  if(job){
    job.assigned = Math.max(0, (job.assigned||0)-1);
    if(remove){
      const ji = jobs.indexOf(job);
      if(ji !== -1) jobs.splice(ji,1);
    }
  }
  v.targetJob=null;
}

function applySkillGain(v, key, amount=0.02, softCap=0.9, hardCap=1){
  const current = clamp(Number.isFinite(v[key]) ? v[key] : 0, 0, hardCap);
  let delta = amount;
  if (current >= softCap) {
    const span = Math.max(0.0001, hardCap - softCap);
    const progress = clamp((current - softCap) / span, 0, 1);
    delta *= Math.max(0.15, 1 - progress);
  }
  const next = clamp(current + delta, 0, hardCap);
  if (next > current) {
    v[key] = next;
    v.happy = clamp(v.happy + Math.min(0.01, (next - current) * 1.5), 0, 1);
  } else {
    v[key] = current;
  }
  return v[key];
}
function generateJobs(){
  const creationCfg = getJobCreationConfig();
  const bb = ensureBlackboardSnapshot();
  const allowSow = shouldGenerateJobType('sow', bb, creationCfg);
  const allowChop = shouldGenerateJobType('chop', bb, creationCfg);
  const allowMine = shouldGenerateJobType('mine', bb, creationCfg);
  const villagerCount = Math.max(1, bb?.villagers || villagers.length || 0);
  const famineSeverity = computeFamineSeverity(bb);
  const foodOnHand = bb?.availableFood ?? storageTotals.food ?? 0;
  const forageNeed = bb?.famine || !hasRipeCrops() || foodOnHand < villagerCount * 2;
  const allowForage = shouldGenerateJobType('forage', bb, creationCfg) && forageNeed;
  for(let y=0;y<GRID_H;y++){
    for(let x=0;x<GRID_W;x++){
      const i=y*GRID_W+x;
      if(tileOccupiedByBuilding(x,y)) continue;
      const z=world.zone[i];
      if(z===ZONES.FARM){
        if(allowSow && zoneHasWorkNow(z, i) && !violatesSpacing(x,y,'sow',creationCfg)){
          addJob({type:'sow',x,y, prio:0.6+(policy.sliders.food||0)*0.6});
        }
      }
      else if(z===ZONES.CUT){
        if(allowChop && zoneHasWorkNow(z, i) && !violatesSpacing(x,y,'chop',creationCfg)){
          addJob({type:'chop',x,y, prio:0.5+(policy.sliders.build||0)*0.5});
        }
      }
      else if(z===ZONES.MINE){
        if(allowMine && zoneHasWorkNow(z, i) && !violatesSpacing(x,y,'mine',creationCfg)){
          addJob({type:'mine',x,y, prio:0.5+(policy.sliders.build||0)*0.5});
        }
      }
    }
  }
  if(allowForage){
    const anchor = findPrimaryAnchor() || { x: Math.round(GRID_W/2), y: Math.round(GRID_H/2) };
    const clampX=(val)=>clamp(val,0,GRID_W-1);
    const clampY=(val)=>clamp(val,0,GRID_H-1);
    const radius = Math.max(8, Math.round(10 + famineSeverity * 8));
    const minX=Math.max(0, clampX(anchor.x - radius));
    const maxX=Math.min(GRID_W-1, clampX(anchor.x + radius));
    const minY=Math.max(0, clampY(anchor.y - radius));
    const maxY=Math.min(GRID_H-1, clampY(anchor.y + radius));
    const foragePrio = Math.min(1, 0.85 + famineSeverity * 0.15 + (policy.sliders.food||0)*0.25);
    const maxJobs = Math.max(2, Math.ceil(villagerCount * 0.75));
    const candidates=[];
    for(let y=minY;y<=maxY;y++){
      for(let x=minX;x<=maxX;x++){
        const i=y*GRID_W+x;
        if(world.berries[i]<=0) continue;
        if(tileOccupiedByBuilding(x,y)) continue;
        if(violatesSpacing(x,y,'forage',creationCfg)) continue;
        const dist=Math.abs(x-anchor.x)+Math.abs(y-anchor.y);
        candidates.push({x,y,i,dist});
      }
    }
    candidates.sort((a,b)=>a.dist-b.dist);
    let added=0;
    for(const c of candidates){
      if(added>=maxJobs) break;
      if(hasSimilarJob({type:'forage',x:c.x,y:c.y})) continue;
      if(addJob({type:'forage',x:c.x,y:c.y,targetI:c.i, prio:foragePrio})){
        added++;
      }
    }
  }
  for(const b of buildings){
    ensureBuildingData(b);
    if(b.built>=1){
      continue;
    }
    let status = buildingSupplyStatus(b);
    if(!status.hasAllReserved){
      requestBuildHauls(b);
      status = buildingSupplyStatus(b);
    }
    let job = jobs.find(j=>j.type==='build' && j.bid===b.id);
    if(!status.hasAnySupply){
      if(job){
        const ji=jobs.indexOf(job);
        if(ji!==-1) jobs.splice(ji,1);
      }
      continue;
    }
    const buildSlider = policy.sliders.build || 0;
    const readyPrio = 0.6 + buildSlider*0.6;
    const waitingPrio = 0.5 + buildSlider*0.35;
    if(!job){
      job = addJob({type:'build',bid:b.id,x:b.x,y:b.y,prio:status.fullyDelivered?readyPrio:waitingPrio});
    } else {
      job.prio = status.fullyDelivered?readyPrio:waitingPrio;
    }
    job.waitingForMaterials = !status.fullyDelivered;
    job.hasAllReserved = status.hasAllReserved;
  }
}
const STARVE_THRESH={ hungry:0.82, starving:1.08, sick:1.22 };
const STARVE_COLLAPSE_TICKS=140;
const STARVE_RECOVERY_TICKS=280;
const STARVE_TOAST_COOLDOWN=420;
const HUNGER_RATE=0.00105;
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
  const style = policy?.style?.jobScoring || {};
  const blackboard = ensureBlackboardSnapshot();
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
  const restThreshold = Number.isFinite(style.restEnergyThreshold) ? style.restEnergyThreshold : 0.22;
  const fatigueThreshold = Number.isFinite(style.energyFatigueThreshold) ? style.energyFatigueThreshold : 0.32;
  const restFatigueBoost = Number.isFinite(style.restFatigueBoost) ? style.restFatigueBoost : 0.08;
  const fatigueFlag = !!blackboard?.energy?.fatigue;
  const shouldRest = v.energy < restThreshold || (fatigueFlag && v.energy < restThreshold + restFatigueBoost) || v.energy < (fatigueThreshold * 0.8);
  if(shouldRest){ if(goRest(v)) return; }
  if(v.state==='idle' && !urgentFood){
    if(tryHydrateAtWell(v)) return;
  }
  const reprioritizeMargin = Number.isFinite(style.reprioritizeMargin) ? style.reprioritizeMargin : 0.06;
  if(maybeInterruptJob(v, { blackboard, margin: reprioritizeMargin })) return;
  if(v.path && v.path.length>0){ stepAlong(v); return; }
  if(v.state==='idle' && !needsFood && !urgentFood && !v.targetJob){
    if(tryCampfireSocial(v)) return;
  }
  if(v.inv){ const s=findNearestBuilding(v.x|0,v.y|0,'storage'); if(s && tick>=v._nextPathTick){ const entry=findEntryTileNear(s, v.x|0, v.y|0) || {x:Math.round(buildingCenter(s).x), y:Math.round(buildingCenter(s).y)}; const p=pathfind(v.x|0,v.y|0,entry.x,entry.y); if(p){ v.path=p; v.state='to_storage'; v.thought=moodThought(v,'Storing'); v._nextPathTick=tick+12; return; } } }
  if(v.state==='idle' && !urgentFood && !v.targetJob){
    if(tryStorageIdle(v)) return;
  }
  if(v.lifeStage==='child'){
    v.targetJob=null;
  }
  const j=pickJobFor(v); if(j && tick>=v._nextPathTick){
    let dest={x:j.x,y:j.y};
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
    }
    const p=pathfind(v.x|0,v.y|0,dest.x,dest.y);
    if(p){
      v.path=p;
      v.state=j.type==='haul'?'haul_pickup':j.type;
      if(j.type==='forage' && Number.isInteger(j.targetI)){
        v.targetI=j.targetI;
      }
      v.targetJob=j;
      v.thought=j.type==='haul'?moodThought(v,'Hauling'):moodThought(v,j.type.toUpperCase());
      j.assigned++;
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
  if(handleIdleRoam(v, { stage, needsFood, urgentFood })) return;
}
function nearbyWarmth(x,y){ return buildings.some(b=>b.kind==='campfire' && distanceToFootprint(x,y,b)<=2); }
function consumeFood(v){
  let source=null;
  if(v.inv && v.inv.type===ITEM.FOOD){
    v.hunger-=0.6;
    v.inv=null;
    source='pack';
  } else if(storageTotals.food>0){
    storageTotals.food--;
    v.hunger-=0.6;
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
  if(!v._wanderFailures) v._wanderFailures=new Map();
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
  if(!v._forageFailures) v._forageFailures=new Map();
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
function tryCampfireSocial(v){
  if(tick<v._nextPathTick) return false;
  if(v.nextSocialTick>tick) return false;
  if((v.starveStage||0)>=1) return false;
  const ambientNow=ambientAt(dayTime);
  if(ambientNow>0.62) return false;
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
function findNearestBuilding(x,y,kind){ let best=null,bd=Infinity; for(const b of buildings){ if(b.kind!==kind||b.built<1) continue; const d=distanceToFootprint(x,y,b); if(d<bd){bd=d; best=b;} } return best; }
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
  const bb = blackboard || ensureBlackboardSnapshot();
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
function pickJobFor(v){
  if(v.lifeStage==='child') return null;
  let best=null,bs=-Infinity;
  const blackboard = ensureBlackboardSnapshot();
  const minScore = typeof policy?.style?.jobScoring?.minPickScore === 'number'
    ? policy.style.jobScoring.minPickScore
    : 0;
  const jobStyle = policy?.style?.jobScoring || {};
  for(const j of jobs){
    let supplyStatus=null;
    let buildTarget=null;
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
  finishJob(v, remove);
}
else if(v.state==='forage'){
  if(Number.isInteger(v.targetI) && world.berries[v.targetI]>0){
    world.berries[v.targetI]--;
    if((v.starveStage||0)>=2 || v.condition==='sick'){
      v.hunger-=0.6;
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
  finishJob(v, true);
}
else if(v.state==='harvest'){
  if(world.growth[i]>0){
    let yieldAmount=1;
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
        cancelHaulJobsForBuilding(b);
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
else if(v.state==='to_storage'){
  if(v.inv){
    if(v.inv.type===ITEM.FOOD && ((v.starveStage||0)>=2 || v.condition==='sick')){
      consumeFood(v);
      v.thought=moodThought(v,'Ate supplies');
    } else {
      if(v.inv.type===ITEM.WOOD) storageTotals.wood+=v.inv.qty;
      if(v.inv.type===ITEM.STONE) storageTotals.stone+=v.inv.qty;
      if(v.inv.type===ITEM.FOOD) storageTotals.food+=v.inv.qty;
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

/* ==================== Pathfinding ==================== */
function passable(x,y){ const i=idx(x,y); if(i<0) return false; if(tileOccupiedByBuilding(x,y)) return false; return WALKABLE.has(world.tiles[i]); }
function pathfind(sx,sy,tx,ty,limit=400){
  // Normalize coordinates to integer tile indices so the path reconstruction loop
  // always terminates, even if callers accidentally pass fractional values.
  sx = Math.round(clamp(sx, 0, GRID_W - 1));
  sy = Math.round(clamp(sy, 0, GRID_H - 1));
  tx = Math.round(clamp(tx, 0, GRID_W - 1));
  ty = Math.round(clamp(ty, 0, GRID_H - 1));
  const tStart = PERF.log ? performance.now() : 0;
  if(sx===tx&&sy===ty){
    if(PERF.log && (tick % 60) === 0) console.log(`pathfind 0.00ms`);
    return [{x:tx,y:ty}];
  }
  const Wm=GRID_W,Hm=GRID_H;
  const qx=PF.qx, qy=PF.qy, came=PF.came;
  came.fill(-1);
  let qs=0,qe=0;
  qx[qe]=sx; qy[qe]=sy; qe++;
  came[sy*Wm+sx]=sx+sy*Wm;
  let found=false,steps=0;
  while(qs<qe && steps<limit){
    const x=qx[qs], y=qy[qs]; qs++; steps++;
    for(const d of DIR4){
      const nx=x+d[0], ny=y+d[1];
      if(nx<0||ny<0||nx>=Wm||ny>=Hm) continue;
      const ni=ny*Wm+nx;
      if(came[ni]!==-1) continue;
      if(!passable(nx,ny)) continue;
      came[ni]=y*Wm+x;
      qx[qe]=nx; qy[qe]=ny; qe++;
      if(nx===tx&&ny===ty){ found=true; qs=qe; break; }
    }
  }
  if(!found){
    if(PERF.log && (tick % 60) === 0){
      const tEnd = performance.now();
      console.log(`pathfind ${(tEnd - tStart).toFixed(2)}ms`);
    }
    return null;
  }
  const path=[];
  let cx=tx,cy=ty,ci=cy*Wm+cx;
  while(!(cx===sx&&cy===sy)){
    path.push({x:cx+0.0001,y:cy+0.0001});
    const pi=came[ci];
    // If we somehow lost the predecessor chain, bail out to avoid infinite loops
    // and signal that the path is unusable.
    if(pi===-1 || !Number.isFinite(pi)){
      return null;
    }
    cy=(pi/Wm)|0; cx=pi%Wm; ci=cy*Wm+cx;
  }
  path.reverse();
  if(PERF.log && (tick % 60) === 0){
    const tEnd = performance.now();
    console.log(`pathfind ${(tEnd - tStart).toFixed(2)}ms`);
  }
  return path;
}

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
  const bb = ensureBlackboardSnapshot();
  for(let i=0;i<world.growth.length;i++){
    if(world.tiles[i]!==TILES.FARMLAND) continue;
    const prev=world.growth[i];
    if(prev<=0 || prev>=240) continue;
    const y=(i/GRID_W)|0, x=i%GRID_W;
    let delta=1;
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
    if(prev<160 && next>=160){
      if(!violatesSpacing(x,y,'harvest',creationCfg)){
        addJob({type:'harvest',x,y, prio:0.65+(policy.sliders.food||0)*0.6});
      }
    }
  }
}

/* ==================== Save/Load ==================== */
function saveGame(){ const data={ saveVersion:SAVE_VERSION, seed:world.seed, tiles:Array.from(world.tiles), zone:Array.from(world.zone), trees:Array.from(world.trees), rocks:Array.from(world.rocks), berries:Array.from(world.berries), growth:Array.from(world.growth), season:world.season, tSeason:world.tSeason, buildings, storageTotals, storageReserved, villagers: villagers.map(v=>({id:v.id,x:v.x,y:v.y,h:v.hunger,e:v.energy,ha:v.happy,hy:v.hydration||0, hb:v.hydrationBuffTicks||0,nhy:v.nextHydrateTick||0,hs:v.socialTimer||0,nso:v.nextSocialTick||0,role:v.role,cond:v.condition||'normal',ss:v.starveStage||0,ns:v.nextStarveWarning||0,sk:v.sickTimer||0,rc:v.recoveryTimer||0,fs:v.farmingSkill||0,cs:v.constructionSkill||0,age:v.ageTicks||0,stage:v.lifeStage||'adult',preg:v.pregnancyTimer||0,ct:v.childhoodTimer||0,par:Array.isArray(v.parents)?v.parents:[],mate:v.pregnancyMateId||null,sit:v.storageIdleTimer||0,nsi:v.nextStorageIdleTick||0,ab:v.activeBuildingId||null})), animals: animals.map(a=>({id:a.id,type:a.type,x:a.x,y:a.y,dir:a.dir||'right',state:a.state||'idle',na:a.nextActionTick||0,phase:a.idlePhase||0,nv:a.nextVillageTick||0,ng:a.nextGrazeTick||0,flee:a.fleeTicks||0})) }; Storage.set(SAVE_KEY, JSON.stringify(data)); }
function loadGame(){ try{ const raw=Storage.get(SAVE_KEY); if(!raw) return false; const d=JSON.parse(raw); const version=typeof d.saveVersion==='number'?d.saveVersion|0:0; const tileData=normalizeArraySource(d.tiles); const isCoarseSave=version < SAVE_VERSION && tileData.length===COARSE_SAVE_SIZE*COARSE_SAVE_SIZE; const factorCandidate=isCoarseSave?Math.floor(GRID_W/COARSE_SAVE_SIZE):1; const factorY=isCoarseSave?Math.floor(GRID_H/COARSE_SAVE_SIZE):1; const upscaleFactor=(factorCandidate>1&&factorCandidate===factorY)?factorCandidate:1; newWorld(d.seed);
  applyArrayScaled(world.tiles, d.tiles, upscaleFactor, 0);
  applyArrayScaled(world.zone, d.zone, upscaleFactor, ZONES.NONE);
  applyArrayScaled(world.trees, d.trees, upscaleFactor, 0);
  applyArrayScaled(world.rocks, d.rocks, upscaleFactor, 0);
  applyArrayScaled(world.berries, d.berries, upscaleFactor, 0);
  applyArrayScaled(world.growth, d.growth, upscaleFactor, 0);
  if(typeof d.season==='number') world.season=d.season;
  if(typeof d.tSeason==='number') world.tSeason=d.tSeason;
  refreshWaterRowMaskFromTiles();
  refreshZoneRowMask();
  markZoneOverlayDirty();
  buildings.length=0;
  const buildingScale=upscaleFactor>1?upscaleFactor:1;
  (d.buildings||[]).forEach(src=>{
    if(!src) return;
    const b={...src};
    if(buildingScale>1){
      const fp=getFootprint(b.kind);
      const maxX=Math.max(0, GRID_W - (fp?.w||1));
      const maxY=Math.max(0, GRID_H - (fp?.h||1));
      const scaledX=Math.round((typeof b.x==='number'?b.x:0)*buildingScale);
      const scaledY=Math.round((typeof b.y==='number'?b.y:0)*buildingScale);
      b.x=clamp(scaledX,0,maxX);
      b.y=clamp(scaledY,0,maxY);
    }
    ensureBuildingData(b);
    buildings.push(b);
  });
  const loadedTotals = Object.assign({food:0,wood:0,stone:0}, d.storageTotals||{});
  storageTotals.food = loadedTotals.food||0;
  storageTotals.wood = loadedTotals.wood||0;
  storageTotals.stone = loadedTotals.stone||0;
  const loadedReserved = Object.assign({food:0,wood:0,stone:0}, d.storageReserved||{});
  storageReserved.food = loadedReserved.food||0;
  storageReserved.wood = loadedReserved.wood||0;
  storageReserved.stone = loadedReserved.stone||0;
  villagers.length=0;
  (d.villagers||[]).forEach(v=>{
    if(!v) return;
    const stage=typeof v.ss==='number'?v.ss:(v.h>STARVE_THRESH.sick?3:v.h>STARVE_THRESH.starving?2:v.h>STARVE_THRESH.hungry?1:0);
    const cond=v.cond||(stage>=3?'sick':stage===2?'starving':stage===1?'hungry':'normal');
    let vx=typeof v.x==='number'?v.x:0;
    let vy=typeof v.y==='number'?v.y:0;
    if(buildingScale>1){
      vx=clamp(Math.round(vx*buildingScale),0,GRID_W-1);
      vy=clamp(Math.round(vy*buildingScale),0,GRID_H-1);
    }
    const farmingSkill = Number.isFinite(v.fs) ? clamp(v.fs, 0, 1) : (v.role==='farmer'?0.7:0.5);
    const constructionSkill = Number.isFinite(v.cs) ? clamp(v.cs, 0, 1) : (v.role==='worker'?0.65:0.5);
    const lifeStage = v.stage==='child' ? 'child' : 'adult';
    const childhoodTimer = Number.isFinite(v.ct) ? v.ct : (lifeStage==='child'?CHILDHOOD_TICKS:0);
    villagers.push({ id:v.id,x:vx,y:vy,path:[], hunger:v.h,energy:v.e,happy:v.ha,hydration:Number.isFinite(v.hy)?clamp(v.hy,0,1):0.7,hydrationBuffTicks:Number.isFinite(v.hb)?v.hb:0,nextHydrateTick:Number.isFinite(v.nhy)?v.nhy:0,role:lifeStage==='child'?'child':v.role,speed:2,inv:null,state:'idle',thought:'Resuming', _nextPathTick:0, condition:cond, starveStage:stage, nextStarveWarning:v.ns||0, sickTimer:v.sk||0, recoveryTimer:v.rc||0, farmingSkill, constructionSkill, ageTicks:Number.isFinite(v.age)?v.age:0, lifeStage, pregnancyTimer:Number.isFinite(v.preg)?v.preg:0, pregnancyMateId:v.mate||null, childhoodTimer, parents:Array.isArray(v.par)?v.par.slice(0,2):[], socialTimer:Number.isFinite(v.hs)?v.hs:0, nextSocialTick:Number.isFinite(v.nso)?v.nso:0, storageIdleTimer:Number.isFinite(v.sit)?v.sit:0, nextStorageIdleTick:Number.isFinite(v.nsi)?v.nsi:0, hydrationTimer:0, activeBuildingId:v.ab||null });
  });
  const animalScale=upscaleFactor>1?upscaleFactor:1;
  animals.length=0;
  (d.animals||[]).forEach(a=>{
    if(!a || !ANIMAL_TYPES[a.type]) return;
    let ax=typeof a.x==='number'?a.x:0;
    let ay=typeof a.y==='number'?a.y:0;
    if(animalScale>1){
      ax=clamp(Math.round(ax*animalScale),0,GRID_W-1);
      ay=clamp(Math.round(ay*animalScale),0,GRID_H-1);
    }
    const state=typeof a.state==='string'?a.state:'idle';
    const nextActionTick=Number.isFinite(a.na)?a.na:tick+irnd(12,60);
    const idlePhase=Number.isFinite(a.phase)?a.phase:irnd(0,900);
    const nextVillageTick=Number.isFinite(a.nv)?a.nv:0;
    const nextGrazeTick=Number.isFinite(a.ng)?a.ng:0;
    const fleeTicks=Number.isFinite(a.flee)?a.flee:0;
    animals.push({ id:a.id||uid(), type:a.type, x:ax, y:ay, dir:a.dir==='left'?'left':'right', state, nextActionTick, idlePhase, nextVillageTick, nextGrazeTick, fleeTicks });
  });
  Toast.show('Loaded.'); markStaticDirty(); return true; } catch(e){ console.error(e); return false; } }

/* ==================== Rendering ==================== */
let staticAlbedoCanvas=null, staticAlbedoCtx=null, staticDirty=true;
function markStaticDirty(){ staticDirty=true; }
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

function drawTree(g){ g.fillStyle='#6b3f1f'; g.fillRect(14,20,4,6); g.fillStyle='#2c6b34'; g.fillRect(10,12,12,10); g.fillStyle='#2f7f3d'; g.fillRect(12,10,8,4); }
function drawBerry(g){ g.fillStyle='#2f6d36'; g.fillRect(8,16,16,10); g.fillStyle='#a04a5a'; g.fillRect(12,18,2,2); g.fillRect(18,20,2,2); g.fillRect(16,22,2,2); }
function drawDeer(g){
  if(!g) return;
  const cx=Math.floor(ENTITY_TILE_PX/2);
  g.fillStyle='#8b5b32';
  g.fillRect(cx-7,17,14,6);
  g.fillStyle='#9c6a3c';
  g.fillRect(cx-4,12,7,5);
  g.fillStyle='#704729';
  g.fillRect(cx-6,23,2,6);
  g.fillRect(cx+3,23,2,6);
  g.fillRect(cx-2,23,2,5);
  g.fillRect(cx+1,23,2,5);
  g.fillStyle='#c29b62';
  g.fillRect(cx+2,11,3,2);
  g.fillRect(cx+3,10,1,2);
  g.fillRect(cx+1,9,1,3);
  g.fillStyle='#d9c9a6';
  g.fillRect(cx+4,14,1,1);
}
function drawBoar(g){
  if(!g) return;
  const cx=Math.floor(ENTITY_TILE_PX/2);
  g.fillStyle='#5c4941';
  g.fillRect(cx-8,18,16,6);
  g.fillStyle='#6d5448';
  g.fillRect(cx-6,14,10,5);
  g.fillRect(cx+4,16,4,4);
  g.fillStyle='#3f312b';
  g.fillRect(cx-7,24,2,6);
  g.fillRect(cx-2,24,2,5);
  g.fillRect(cx+3,24,2,5);
  g.fillRect(cx+7,22,2,6);
  g.fillStyle='#d8c8b4';
  g.fillRect(cx+6,18,2,2);
  g.fillRect(cx+7,19,1,1);
  g.fillStyle='#40342c';
  g.fillRect(cx-4,12,2,2);
}

function entityDrawRect(tileX, tileY, cam){
  const baseX = tileToPxX(tileX, cam);
  const baseY = tileToPxY(tileY, cam);
  const offset = Math.floor((ENTITY_TILE_PX - TILE) * cam.z * 0.5);
  const size = ENTITY_TILE_PX * cam.z;
  return { x: baseX - offset, y: baseY - offset, size };
}

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

function visibleTileBounds(){
  const raw = baseVisibleTileBounds(W, H, cam);
  const x0 = Math.max(0, raw.x0);
  const y0 = Math.max(0, raw.y0);
  const x1 = Math.min(GRID_W-1, raw.x1);
  const y1 = Math.min(GRID_H-1, raw.y1);
  return {x0, y0, x1, y1};
}

function emittersSignature(list){
  if (!Array.isArray(list) || list.length === 0) return 'none';
  const round = (v, places=3) => {
    const factor = Math.pow(10, places);
    return Math.round((Number.isFinite(v) ? v : 0) * factor) / factor;
  };
  return list.map(e => {
    if (!e) return 'x';
    return [round(e.x,2), round(e.y,2), round(e.radius,2), round(e.intensity,3), round(e.falloff,2)].join(':');
  }).join('|');
}

function ensureLightmapBuffers(targetWorld){
  if (!targetWorld) return false;
  const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
  const expectedW = Math.max(1, Math.floor(((targetWorld.width||GRID_W)) * scale));
  const expectedH = Math.max(1, Math.floor(((targetWorld.height||GRID_H)) * scale));
  const missingQ = !targetWorld.lightmapQ || (!targetWorld.hillshadeQ && LIGHTING.mode === 'hillshade');
  if (!targetWorld.lightmapCanvas || targetWorld.lightmapCanvas.width !== expectedW || targetWorld.lightmapCanvas.height !== expectedH || missingQ){
    buildHillshadeQ(targetWorld);
  }
  return Boolean(targetWorld.lightmapCanvas && targetWorld.lightmapQ);
}

function maybeBuildLightmap(targetWorld, ambient){
  if (!ensureLightmapBuffers(targetWorld)) return false;
  const mode = normalizeShadingMode(LIGHTING.mode);
  const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
  const ambientKey = Math.round(Math.max(0, Math.min(1, ambient || 0)) * 1000) / 1000;
  const emitterSignature = emittersSignature(targetWorld.emitters);
  const needsBuild = lightmapCacheState.ambient !== ambientKey
    || lightmapCacheState.mode !== mode
    || lightmapCacheState.scale !== scale
    || lightmapCacheState.emitterSignature !== emitterSignature;
  if (!needsBuild) return false;
  buildLightmap(targetWorld, ambient);
  lightmapCacheState.ambient = ambientKey;
  lightmapCacheState.mode = mode;
  lightmapCacheState.scale = scale;
  lightmapCacheState.emitterSignature = emitterSignature;
  return true;
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

function buildHillshadeQ(targetWorld){
  if (!targetWorld) return;
  const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
  const width = Math.max(1, (targetWorld.width|0) || GRID_W);
  const height = Math.max(1, (targetWorld.height|0) || GRID_H);
  const qw = Math.max(1, Math.floor(width * scale));
  const qh = Math.max(1, Math.floor(height * scale));
  const source = targetWorld.hillshade;
  if (source && source.length === width * height){
    const downsampled = new Float32Array(qw * qh);
    for (let qy = 0; qy < qh; qy++){
      const y = Math.min(height - 1, Math.floor(qy / scale));
      const srcRow = y * width;
      const row = qy * qw;
      for (let qx = 0; qx < qw; qx++){
        const x = Math.min(width - 1, Math.floor(qx / scale));
        downsampled[row + qx] = source[srcRow + x];
      }
    }
    targetWorld.hillshadeQ = downsampled;
  } else {
    targetWorld.hillshadeQ = null;
  }

  targetWorld.lightmapQ = new Float32Array(qw * qh);

  let canvas = targetWorld.lightmapCanvas;
  if (!canvas || canvas.width !== qw || canvas.height !== qh){
    if (typeof OffscreenCanvas !== 'undefined'){
      canvas = new OffscreenCanvas(qw, qh);
    } else {
      canvas = makeCanvas(qw, qh);
    }
  }
  canvas.width = qw;
  canvas.height = qh;
  targetWorld.lightmapCanvas = canvas;

  let ctx = targetWorld.lightmapCtx;
  if (!ctx || ctx.canvas !== canvas){
    ctx = context2d(canvas, { alpha:false });
  }
  targetWorld.lightmapCtx = ctx || null;
  if (ctx){
    if (!targetWorld.lightmapImageData || targetWorld.lightmapImageData.width !== qw || targetWorld.lightmapImageData.height !== qh){
      targetWorld.lightmapImageData = ctx.createImageData(qw, qh);
    }
  } else {
    targetWorld.lightmapImageData = null;
  }
  resetLightmapCache();
}

function buildLightmap(targetWorld, ambient){
  if (!targetWorld || !targetWorld.lightmapQ || !targetWorld.lightmapCanvas) return;
  const Lq = targetWorld.lightmapQ;
  const Hq = (LIGHTING.mode === 'hillshade') ? targetWorld.hillshadeQ : null;
  const length = Lq.length;
  const cap = Number.isFinite(LIGHTING.lightCap) ? LIGHTING.lightCap : 1.0;
  for (let i = 0; i < length; i++){
    const base = ambient * (Hq ? Hq[i] : 1);
    Lq[i] = base > cap ? cap : base;
  }

  const emitters = Array.isArray(targetWorld.emitters) ? targetWorld.emitters : [];
  const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
  const qw = targetWorld.lightmapCanvas.width|0;
  const qh = targetWorld.lightmapCanvas.height|0;

  const addLight = (cx, cy, radiusTiles, intensity, falloff) => {
    if (!Number.isFinite(intensity) || intensity === 0) return;
    const r = Math.max(1, Math.floor(radiusTiles * scale));
    const r2 = r * r;
    const exponent = Math.max(0.1, Number.isFinite(falloff) ? falloff : 2);
    for (let dy = -r; dy <= r; dy++){
      const y = cy + dy;
      if (y < 0 || y >= qh) continue;
      for (let dx = -r; dx <= r; dx++){
        const x = cx + dx;
        if (x < 0 || x >= qw) continue;
        const d2 = dx*dx + dy*dy;
        if (d2 > r2) continue;
        const ratio = r === 0 ? 0 : Math.sqrt(d2) / r;
        const fall = Math.max(0, 1 - Math.pow(ratio, exponent));
        if (fall <= 0) continue;
        const idx = y * qw + x;
        const sum = Lq[idx] + intensity * fall;
        Lq[idx] = sum > cap ? cap : sum;
      }
    }
  };

  for (const emitter of emitters){
    if (!emitter) continue;
    const cx = Math.round((Number.isFinite(emitter.x) ? emitter.x : 0) * scale);
    const cy = Math.round((Number.isFinite(emitter.y) ? emitter.y : 0) * scale);
    const radius = Number.isFinite(emitter.radius) ? emitter.radius : 0;
    if (!(radius > 0)) continue;
    let intensity = Number.isFinite(emitter.intensity) ? emitter.intensity : 0;
    if (emitter.flicker){
      intensity *= (1 + 0.05 * Math.sin(targetWorld.dayTime || 0) + (Math.random() * 0.03));
    }
    addLight(cx, cy, radius, intensity, emitter.falloff);
  }

  if (LIGHTING.softLights){
    for (let y = 1; y < qh - 1; y++){
      const row = y * qw;
      for (let x = 1; x < qw - 1; x++){
        const i = row + x;
        Lq[i] = (Lq[i] + Lq[i-1] + Lq[i+1] + Lq[i-qw] + Lq[i+qw]) / 5;
      }
    }
  }

  const ctx = targetWorld.lightmapCtx;
  if (!ctx) return;
  let img = targetWorld.lightmapImageData;
  if (!img || img.width !== qw || img.height !== qh){
    img = ctx.createImageData(qw, qh);
    targetWorld.lightmapImageData = img;
  }
  const data = img.data;
  for (let i = 0, p = 0; i < length; i++, p += 4){
    const v = Math.max(0, Math.min(1, Lq[i]));
    const b = Math.round(v * 255);
    data[p] = data[p+1] = data[p+2] = b;
    data[p+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function sampleLightAt(targetWorld, wx, wy){
  if (!targetWorld || !targetWorld.lightmapQ || !targetWorld.lightmapCanvas) return 1.0;
  const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
  const x = wx * scale;
  const y = wy * scale;
  const qw = targetWorld.lightmapCanvas.width|0;
  const qh = targetWorld.lightmapCanvas.height|0;
  const Lq = targetWorld.lightmapQ;
  if (!qw || !qh || !Lq || Lq.length === 0) return 1.0;

  const x0 = Math.max(0, Math.min(qw - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(qh - 1, Math.floor(y)));
  const x1 = Math.min(qw - 1, x0 + 1);
  const y1 = Math.min(qh - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const i00 = y0 * qw + x0;
  const i10 = y0 * qw + x1;
  const i01 = y1 * qw + x0;
  const i11 = y1 * qw + x1;

  const a = Lq[i00] * (1 - tx) + Lq[i10] * tx;
  const b = Lq[i01] * (1 - tx) + Lq[i11] * tx;
  const value = a * (1 - ty) + b * ty;
  return Math.max(0, Math.min(LIGHTING.lightCap, value));
}

function shadeFillColorLit(rgbaString, light){
  const L = Math.max(0, Math.min(LIGHTING.lightCap, light));
  const normalized = L >= 1 ? 1 : L;
  return shadeFillColor(rgbaString, normalized);
}

function applySpriteShadeLit(context, x, y, w, h, light){
  const L = Math.max(0, Math.min(LIGHTING.lightCap, light));
  const normalized = L >= 1 ? 1 : L;
  return applySpriteShade(context, x, y, w, h, normalized);
}

function sampleShade(tx, ty){
  if (!world || LIGHTING.mode === 'off') return 1;
  if (LIGHTING.useMultiplyComposite) return 1;
  return sampleLightAt(world, tx, ty);
}

function shadeFillColor(color, shade){
  const normalized = clamp01(shade);
  if (normalized >= 0.999 || typeof color !== 'string') return color;
  if (color[0] === '#'){
    let r, g, b;
    if (color.length === 4){
      r = parseInt(color[1] + color[1], 16);
      g = parseInt(color[2] + color[2], 16);
      b = parseInt(color[3] + color[3], 16);
    } else if (color.length === 7){
      r = parseInt(color.slice(1, 3), 16);
      g = parseInt(color.slice(3, 5), 16);
      b = parseInt(color.slice(5, 7), 16);
    } else {
      return color;
    }
    const scale = (component) => clamp(Math.round(component * normalized), 0, 255);
    return `rgb(${scale(r)},${scale(g)},${scale(b)})`;
  }
  const rgbaMatch = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch){
    const parts = rgbaMatch[1].split(',').map(part => part.trim());
    if (parts.length < 3) return color;
    const parseComponent = (value) => {
      const num = Number.parseFloat(value);
      return Number.isFinite(num) ? num : 0;
    };
    const baseR = parseComponent(parts[0]);
    const baseG = parseComponent(parts[1]);
    const baseB = parseComponent(parts[2]);
    const alpha = parts.length >= 4 ? clamp(parseComponent(parts[3]), 0, 1) : 1;
    const scale = (component) => clamp(Math.round(clamp(component, 0, 255) * normalized), 0, 255);
    return `rgba(${scale(baseR)},${scale(baseG)},${scale(baseB)},${alpha})`;
  }
  return color;
}

function applySpriteShade(context, x, y, w, h, shade){
  const normalized = clamp01(shade);
  const overlay = 1 - normalized;
  if (overlay <= 0) return;
  context.save();
  context.globalCompositeOperation='multiply';
  context.fillStyle=`rgba(0,0,0,${overlay})`;
  context.fillRect(x, y, w, h);
  context.restore();
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
  currentAmbient = ambient;

  villagerLabels.length = 0;

  if (!Array.isArray(world.emitters)) world.emitters = [];
  world.emitters.length = 0;
  if (shadingMode !== 'off'){
    for (const b of buildings){
      if(b && b.kind==='campfire' && (b.built||0) >= 1){
        const fp=getFootprint(b.kind);
        const emitterX=b.x + (fp?.w||1)*0.5;
        const emitterY=b.y + (fp?.h||1)*0.5;
        world.emitters.push({ x:emitterX, y:emitterY, radius:7.5, intensity:0.45, falloff:2.0, flicker:true });
      }
    }
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
  // base map scaled by cam.z
  const baseDx = Math.round(-cam.x*TILE*cam.z);
  const baseDy = Math.round(-cam.y*TILE*cam.z);
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

  const activeZoneJobs={ sow:new Set(), chop:new Set(), mine:new Set() };
  for(const job of jobs){
    const type=job.type;
    if((job.assigned||0)>0 && activeZoneJobs[type]){
      activeZoneJobs[type].add(job.y*GRID_W + job.x);
    }
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
      const baseColor = it.type===ITEM.WOOD ? '#b48a52' : it.type===ITEM.STONE ? '#aeb7c3' : '#b6d97a';
      ctx.fillStyle = shadeFillColorLit(baseColor, light);
      ctx.fillRect(spriteRect.x, spriteRect.y, spriteRect.w, spriteRect.h);
      ctx.restore();
    }

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
    const packColor=v.inv.type===ITEM.WOOD?'#b48a52':v.inv.type===ITEM.STONE?'#aeb7c3':'#b6d97a';
    ctx.fillStyle=shadeFillColorLit(packColor, light);
    ctx.fillRect(gx+spriteSize-4*s, gy+2*s, 3*s, 3*s);
  }
  ctx.restore();

  const baseCx=gx+spriteSize*0.5;
  const baseCy=gy-4*cam.z;
  let labelOffset=0;
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
let last=performance.now(), acc=0; const TICKS_PER_SEC=policy.routine.ticksPerSecond||6; const TICK_MS=1000/TICKS_PER_SEC; const SECONDS_PER_TICK=1/TICKS_PER_SEC; const SPEED_PX_PER_SEC=0.08*32*TICKS_PER_SEC; const MAX_CATCHUP_STEPS=Math.max(1, Number.isFinite(policy.routine.maxCatchupTicksPerFrame)?policy.routine.maxCatchupTicksPerFrame:12);
function update(){
  const now=performance.now();
  if(paused){ last=now; render(); requestAnimationFrame(update); return; }
  let dt=now-last; last=now; dt*=SPEEDS[speedIdx]; acc+=dt;
  let steps=Math.floor(acc/TICK_MS);
  if(steps>MAX_CATCHUP_STEPS){
    const allowedAcc=MAX_CATCHUP_STEPS*TICK_MS;
    const droppedMs=Math.max(0, acc-allowedAcc);
    acc=allowedAcc;
    steps=MAX_CATCHUP_STEPS;
    if(PERF.log){
      console.warn('AIV loop catch-up capped', { droppedMs, cappedSteps: MAX_CATCHUP_STEPS });
    }
  }
  if(steps>0) acc-=steps*TICK_MS;
  const jobInterval=policy.routine.jobGenerationTickInterval||20;
  const seasonInterval=policy.routine.seasonTickInterval||10;
  const blackboardInterval=policy.routine.blackboardCadenceTicks||30;
  const logConfig=policy.routine.blackboardLogging||null;
  const logInterval=logConfig&&Number.isFinite(logConfig.intervalTicks)?Math.max(1,logConfig.intervalTicks):Math.max(1,TICKS_PER_SEC*60);
  for(let s=0;s<steps;s++){
    tick++;
    dayTime=(dayTime+1)%DAY_LEN;
    if(jobInterval>0 && tick%jobInterval===0) generateJobs();
    if(seasonInterval>0 && tick%seasonInterval===0) seasonTick();
    if(blackboardInterval>0 && (tick-lastBlackboardTick)>=blackboardInterval){
      gameState.bb=computeBlackboard(gameState, policy);
      lastBlackboardTick=tick;
      if(logConfig&&logConfig.enabled&& (tick-lastBlackboardLogTick)>=logInterval){
        console.debug('[blackboard]', gameState.bb);
        lastBlackboardLogTick=tick;
      }
    }
    if((tick-lastZonePlanTick)>=PLANNER_INTERVAL.zones){
      planZones(gameState.bb);
      lastZonePlanTick=tick;
    }
    if((tick-lastBuildPlanTick)>=PLANNER_INTERVAL.build){
      planBuildings(gameState.bb);
      lastBuildPlanTick=tick;
    }
    rebuildItemTileIndex();
    updateAnimals();
    for(const v of villagers){
      if(!v.inv){
        if(itemTileIndexDirty) rebuildItemTileIndex();
        const key=((v.y|0)*GRID_W)+(v.x|0);
        const itemIndex=itemTileIndex.get(key);
        if(itemIndex!==undefined){
          const it=itemsOnGround[itemIndex];
          if(it){ v.inv={type:it.type,qty:it.qty}; removeItemAtIndex(itemIndex); }
        }
      }
    }
    for(const v of villagers){ villagerTick(v); }
    flushPendingBirths();
  }
  render();
  requestAnimationFrame(update);
}

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
export { setShadingMode, setShadingParams, makeAltitudeShade, ambientAt, buildHillshadeQ, buildLightmap, sampleLightAt, shadeFillColorLit, applySpriteShadeLit };
