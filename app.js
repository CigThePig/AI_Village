import { generateTerrain, makeHillshade } from './worldgen/terrain.js';
import { WORLDGEN_DEFAULTS, SHADING_DEFAULTS } from './worldgen/config.js';

let setShadingModeImpl = () => {};
let setShadingParamsImpl = () => {};

const clamp01 = (value) => {
  if (!Number.isFinite(value)) {
    return value > 0 ? 1 : 0;
  }
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
};

export function setShadingMode(mode) {
  return setShadingModeImpl(mode);
}

export function setShadingParams(params = {}) {
  return setShadingParamsImpl(params);
}

if (typeof globalThis !== 'undefined') {
  // Provide provisional globals so the debug overlay can bind immediately.
  globalThis.setShadingMode = setShadingMode;
  globalThis.setShadingParams = setShadingParams;
  globalThis.SHADING_DEFAULTS = SHADING_DEFAULTS;
}

export function makeAltitudeShade(height, w, h, cfg = SHADING_DEFAULTS) {
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
(function(){
'use strict';

// ---- Safe storage wrapper ----
const Storage = (() => {
  let available = false;
  try {
    const k = '__aiv_test__' + Math.random();
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    available = true;
  } catch (e) {
    available = false;
  }
  function get(key, def=null) {
    if (!available) return def;
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? def : v;
    } catch (e) { return def; }
  }
  function set(key, value) {
    if (!available) return false;
    try { window.localStorage.setItem(key, value); return true; }
    catch (e) { return false; }
  }
  function del(key) {
    if (!available) return false;
    try { window.localStorage.removeItem(key); return true; }
    catch (e) { return false; }
  }
  return {
    get available(){ return available; },
    set available(v){ available = !!v; },
    get,
    set,
    del
  };
})();

function showFatalOverlay(err) {
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
  div.innerHTML = `<b>Startup error</b><br><pre style="white-space:pre-wrap">${(err && (err.stack||err.message||String(err)))}</pre>
    <button id="btnContinueNoSave" style="margin-top:8px">Continue (no save)</button>`;
  const btn = document.getElementById('btnContinueNoSave');
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

// Surface any unhandled error
window.addEventListener('error', (e) => { showFatalOverlay(e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { showFatalOverlay(e.reason || e); });

/* ==================== Constants & Types ==================== */
const coords = (() => {
  const TILE = 16;
  const ENTITY_TILE_PX = 32;
  let GRID_W = 192;
  let GRID_H = 192;

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
const SAVE_VERSION = 2;
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
const SPEEDS = [0.5, 1, 2, 4];
const PF = {
  qx: new Int16Array(GRID_SIZE),
  qy: new Int16Array(GRID_SIZE),
  came: new Int32Array(GRID_SIZE)
};
let waterRowMask = new Uint8Array(GRID_H);
let zoneRowMask = new Uint8Array(GRID_H);

function ensureRowMasksSize(){
  if(waterRowMask.length !== GRID_H) waterRowMask = new Uint8Array(GRID_H);
  if(zoneRowMask.length !== GRID_H) zoneRowMask = new Uint8Array(GRID_H);
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
  const context = canvas.getContext('2d', opts);
  // We size canvases in device pixels (see resize) so disable smoothing once per context for crisp art.
  context.imageSmoothingEnabled = false;
  return context;
}
const ctx = context2d(canvas, { alpha:false });
canvas.style.touchAction = 'none';
let DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
let W=0, H=0;
let cam = { x:0, y:0, z:2.2 }; // x,y in tiles; draw scales by z
const MIN_Z=1.2, MAX_Z=4.5;

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
const Tileset = { base:{}, waterOverlay:[], zoneGlyphs:{}, villagerSprites:{}, sprite:{ tree:null, berry:null, sprout:[] } };
function makeCanvas(w,h){ const c=document.createElement('canvas'); c.width=w; c.height=h; return c; }
function px(g,x,y,c){ g.fillStyle=c; g.fillRect(x,y,1,1); }
function rect(g,x,y,w,h,c){ g.fillStyle=c; g.fillRect(x,y,w,h); }
function makeSprite(w,h,drawFn){ const c=makeCanvas(w,h), g=context2d(c); drawFn(g); return c; }
const SHADOW_TEXTURE = (() => {
  const size = 128;
  const canvas = makeCanvas(size, size);
  const g = context2d(canvas);
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
function makeSand(){ const c=makeCanvas(TILE,TILE), g=context2d(c); rect(g,0,0,TILE,TILE,'#b99a52'); for(let i=0;i<28;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#c7ad69':'#a78848'); } return c; }
function makeSnow(){ const c=makeCanvas(TILE,TILE), g=context2d(c); rect(g,0,0,TILE,TILE,'#d7e6f8'); for(let i=0;i<24;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), '#c9d7ea'); } rect(g,0,TILE-4,TILE,4,'#c0d0e8'); return c; }
function makeRock(){ const c=makeCanvas(TILE,TILE), g=context2d(c); rect(g,0,0,TILE,TILE,'#59616c'); for(let i=0;i<30;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#8f99a5':'#6c757f'); } rect(g,0,TILE-5,TILE,5,'#4a525b'); return c; }
function makeWaterBase(){ const c=makeCanvas(TILE,TILE), g=context2d(c); rect(g,0,0,TILE,TILE,'#134a6a'); for (let i = 0; i < 14; i++) { px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#0f3e59':'#0c3248'); } return c; }
function makeWaterOverlayFrames(){ const frames=[]; for(let f=0; f<3; f++){ const c=makeCanvas(TILE,TILE), g=context2d(c); g.globalAlpha=0.22; g.strokeStyle='#4fa3d6'; g.lineWidth=1; g.beginPath(); for(let i=0;i<3;i++){ const y=6+i*10+f*2; g.moveTo(0,y); g.quadraticCurveTo(TILE*0.5,y+2,TILE,y); } g.stroke(); g.globalAlpha=1; frames.push(c); } return frames; }
function makeFarmland(){ const c=makeCanvas(TILE,TILE), g=context2d(c); rect(g,0,0,TILE,TILE,'#4a3624'); g.globalAlpha=0.25; for(let y=3;y<TILE;y+=6){ rect(g,0,y,TILE,2,'#3b2a1d'); } g.globalAlpha=1; return c; }
function drawSproutOn(g,stage){
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
  } catch(e){ console.warn('sprites', e); }
}

/* ==================== World State ==================== */
let world=null, buildings=[], villagers=[], jobs=[], itemsOnGround=[], storageTotals={food:0,wood:0,stone:0}, storageReserved={food:0,wood:0,stone:0};
let tick=0, paused=false, speedIdx=1, dayTime=0; const DAY_LEN=60*40;

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
  if (!world || !world.aux || !world.aux.height) return;
  world.hillshade = computeShadeForMode(nextMode, world.aux.height);
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
  campfire: { label: 'Campfire', cost: 0, wood: 0, stone: 0 },
  storage:  { label: 'Storage',  cost: 8, wood: 8, stone: 0 },
  hut:      { label: 'Hut',      cost:10, wood:10, stone: 0 },
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
      moodBonus: 0.0007
    },
    tooltip: 'Hydrates farms in 4 tiles and keeps nearby villagers cheerful.'
  }
};

const FOOTPRINT = {
  campfire: { w:2, h:2 },
  storage:  { w:2, h:2 },
  hut:      { w:2, h:2 },
  farmplot: { w:2, h:2 },
  well:     { w:2, h:2 }
};

function newWorld(seed=Date.now()|0){
  R = mulberry32(seed>>>0);
  jobs.length=0; buildings.length=0; itemsOnGround.length=0;
  storageTotals={food:8, wood:12, stone:0};
  storageReserved={food:0, wood:0, stone:0};
  tick=0; dayTime=0;
  const terrain = generateTerrain(seed, WORLDGEN_DEFAULTS, { w: GRID_W, h: GRID_H });
  const aux = terrain.aux || {};
  const mode = normalizeShadingMode(SHADING_DEFAULTS.mode);
  SHADING_DEFAULTS.mode = mode;
  const hillshade = computeShadeForMode(mode, aux.height);
  world={
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
    hillshade
  };
  waterRowMask = new Uint8Array(GRID_H);
  zoneRowMask = new Uint8Array(GRID_H);
  world.zone.fill(0);
  world.growth.fill(0);
  refreshWaterRowMaskFromTiles();
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
  toast('New pixel map created.'); centerCamera(campfire.x,campfire.y); markStaticDirty();
}
function newVillager(x,y){ const r=R(); let role=r<0.25?'farmer':r<0.5?'worker':r<0.75?'explorer':'sleepy'; return { id:uid(), x,y,path:[], hunger:rnd(0.2,0.5), energy:rnd(0.5,0.9), happy:rnd(0.4,0.8), speed:2+rnd(-0.2,0.2), inv:null, state:'idle', thought:'Wandering', role, _nextPathTick:0, condition:'normal', starveStage:0, nextStarveWarning:0, sickTimer:0, recoveryTimer:0 }; }
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
  for(const b of buildings){
    if(b.built<1) continue;
    if(b.kind!=='farmplot' && b.kind!=='well') continue;
    const dist=distanceToFootprint(x,y,b);
    if(b.kind==='farmplot'){
      const eff=BUILDINGS.farmplot.effects||{};
      const radius=(eff.radius|0);
      if(radius>0){ if(dist>radius) continue; }
      else if(dist>0){ continue; }
      const influence=radius>0?Math.max(0,1-dist/(radius+1)):1;
      if(eff.growthBonus){ growthBonus+=eff.growthBonus*influence; }
      if(eff.harvestBonus){ harvestBonus+=eff.harvestBonus*influence; }
    } else if(b.kind==='well'){
      const eff=BUILDINGS.well.effects||{};
      const radius=(eff.hydrationRadius|0);
      if(radius>0){ if(dist>radius) continue; }
      else if(dist>0){ continue; }
      const influence=radius>0?Math.max(0,1-dist/(radius+1)):1;
      if(eff.hydrationGrowthBonus){ growthBonus+=eff.hydrationGrowthBonus*influence; }
      if(eff.harvestBonus){ harvestBonus+=eff.harvestBonus*influence; }
      if(eff.moodBonus){ moodBonus+=eff.moodBonus*influence; }
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

let ui={ mode:'inspect', zonePaint:ZONES.FARM, buildKind:null, brush:2 };
let brushPreview=null;

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

el('chipInspect').addEventListener('click', ()=> openMode('inspect'));
el('chipZones').addEventListener('click', ()=> openMode('zones'));
el('chipBuild').addEventListener('click', ()=> openMode('build'));
el('chipPrior').addEventListener('click', ()=> openMode('prior'));
el('btnPause').addEventListener('click', ()=> { paused=!paused; el('btnPause').textContent=paused?'▶️':'⏸'; });
el('btnSpeed').addEventListener('click', ()=> { speedIdx=(speedIdx+1)%SPEEDS.length; el('btnSpeed').textContent=SPEEDS[speedIdx]+'×'; });
const btnSave=el('btnSave');
if(!Storage.available){ btnSave.disabled=true; btnSave.title='Saving unavailable in this context'; }
btnSave.addEventListener('click', ()=>{ if(!Storage.available){ Toast.show('Saving disabled in this context'); return; } saveGame(); Toast.show('Saved.'); });
el('btnNew').addEventListener('click', ()=> { newWorld(); });
el('btnHelpClose').addEventListener('click', ()=> { el('help').style.display='none'; Storage.set('aiv_help_px3','1'); });
function toggleSheet(id, open){ const el=document.getElementById(id); if(!el) return; el.setAttribute('data-open', open?'true':'false'); }
['sheetZones','sheetBuild','sheetPrior'].forEach(id=>{ const s=document.getElementById(id); s.addEventListener('click', (e)=>{ if(e.target.closest('.sheet-close')) toggleSheet(id,false); }); });

function openMode(m){
  if(ui.mode===m){
    ui.mode='inspect';
    document.querySelectorAll('.chip').forEach(n=>n.removeAttribute('data-active'));
    toggleSheet('sheetZones', false);
    toggleSheet('sheetBuild', false);
    toggleSheet('sheetPrior', false);
    brushPreview=null;
    return;
  }
  ui.mode=m;
  document.querySelectorAll('.chip').forEach(n=>n.removeAttribute('data-active'));
  const chip=document.getElementById('chip'+m.charAt(0).toUpperCase()+m.slice(1));
  chip.setAttribute('data-active','true');
  toggleSheet('sheetZones', m==='zones');
  toggleSheet('sheetBuild', m==='build');
  toggleSheet('sheetPrior', m==='prior');
  if(m!=='zones') brushPreview=null;
  if(m==='zones') Toast.show('Painting: '+(ui.zonePaint===ZONES.FARM?'Farm':ui.zonePaint===ZONES.CUT?'Cut Trees':'Mine'));
}

document.addEventListener('click', (e)=>{
  if(e.target.closest('.sheet') || e.target.closest('.bar')) return;
  toggleSheet('sheetZones', false);
  toggleSheet('sheetBuild', false);
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
    if(ui.mode==='build'){ const w=screenToWorld(e.clientX,e.clientY); placeBlueprint(ui.buildKind||'hut', toTile(w.x), toTile(w.y)); }
    if(ui.mode==='zones'){ const w=screenToWorld(e.clientX,e.clientY); paintZoneAt(w.x, w.y); }
  }
  e.preventDefault();
},{passive:false});

canvas.addEventListener('pointermove', (e)=>{
  if(!activePointers.has(e.pointerId)) return;
  const p = activePointers.get(e.pointerId);
  p.x=e.clientX; p.y=e.clientY; activePointers.set(e.pointerId,p);
  const {sx:scaleX, sy:scaleY} = pointerScale();
  if (ui.mode==='zones' && primaryPointer){
    const w = screenToWorld(e.clientX, e.clientY);
    setDbg(`paint ${toTile(w.x)},${toTile(w.y)}`);
  }

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
    if(ui.mode!=='zones'){
      const dx=(e.clientX-primaryPointer.sx)*scaleX;
      const dy=(e.clientY-primaryPointer.sy)*scaleY;
      const dtX = pxToTileX(dx, cam) - cam.x;
      const dtY = pxToTileY(dy, cam) - cam.y;
      cam.x = primaryPointer.camx - dtX;
      cam.y = primaryPointer.camy - dtY;
      clampCam();
    } else {
      const w=screenToWorld(e.clientX,e.clientY);
      paintZoneAt(w.x, w.y);
    }
  }

  if(ui.mode==='zones'){
    const ptr = primaryPointer ? activePointers.get(primaryPointer.id) : activePointers.values().next().value;
    if(ptr){
      const w=screenToWorld(ptr.x, ptr.y);
      brushPreview={x:toTile(w.x), y:toTile(w.y), r:Math.floor(ui.brush)};
    }
  } else {
    brushPreview=null;
  }
},{passive:false});

function endPointer(e){
  activePointers.delete(e.pointerId);
  if(primaryPointer && e.pointerId===primaryPointer.id) primaryPointer=null;
  if(activePointers.size<2) pinch=null;
  if(activePointers.size===0){
    if(ui.mode==='zones') generateJobs(); // regen once per stroke
    brushPreview=null;
  }
}

canvas.addEventListener('pointerup', endPointer, {passive:false});
canvas.addEventListener('pointercancel', endPointer, {passive:false});
canvas.addEventListener('pointerleave', endPointer, {passive:false});

canvas.addEventListener('wheel', (e)=>{
  const delta=Math.sign(e.deltaY); const scale=delta>0?1/1.1:1.1; const mx=e.clientX,my=e.clientY;
  const before=screenToWorld(mx,my); cam.z=clamp(cam.z*scale, MIN_Z, MAX_Z); const after=screenToWorld(mx,my);
cam.x += (after.x - before.x); cam.y += (after.y - before.y); clampCam();
});

/* ==================== Zones/Build/Helpers ==================== */
document.getElementById('sheetZones').addEventListener('click', (e)=>{
  const t = e.target.closest('.tile'); if (!t) return;
  const z = t.getAttribute('data-zone');
  ui.zonePaint = z==='farm' ? ZONES.FARM
               : z==='cut'  ? ZONES.CUT
               : z==='mine' ? ZONES.MINE
               : ZONES.NONE;
  toggleSheet('sheetZones', false);           // ← close sheet so canvas gets taps
  Toast.show('Zone: ' + (z==='erase' ? 'Clear' : z.toUpperCase()));
});
document.getElementById('brushSize').addEventListener('input', (e)=> ui.brush=parseInt(e.target.value||'2'));
document.querySelectorAll('#sheetBuild .tile').forEach(tile=>{
  const kind=tile.getAttribute('data-build');
  const def=BUILDINGS[kind];
  if(def && def.tooltip){ tile.setAttribute('title', def.tooltip); }
});
document.getElementById('sheetBuild').addEventListener('click', (e)=>{
  const t = e.target.closest('.tile'); if (!t) return;
  const kind=t.getAttribute('data-build');
  ui.buildKind = kind;
  toggleSheet('sheetBuild', false);           // ← close sheet so canvas gets taps
  const def=BUILDINGS[kind];
  const label=def?.label||kind;
  const detail=def?.tooltip?` — ${def.tooltip}`:'';
  Toast.show(`Tap map to place: ${label}${detail}`);
});
const priorities={ food:0.7, build:0.5, explore:0.3 };
document.getElementById('prioFood').addEventListener('input', e=> priorities.food=(parseInt(e.target.value,10)||0)/100 );
document.getElementById('prioBuild').addEventListener('input', e=> priorities.build=(parseInt(e.target.value,10)||0)/100 );
document.getElementById('prioExplore').addEventListener('input', e=> priorities.explore=(parseInt(e.target.value,10)||0)/100 );

function availableToReserve(resource){
  return (storageTotals[resource]||0) - (storageReserved[resource]||0);
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
    prio:0.6+priorities.build*0.5,
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
function paintZoneAt(cx, cy){
  const x0 = toTile(cx), y0 = toTile(cy);
  if (x0 < 0 || y0 < 0 || x0 >= GRID_W || y0 >= GRID_H) return;
  const r = Math.floor(ui.brush), z = ui.zonePaint|0;
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
  brushPreview = {x:x0, y:y0, r};
}
function placeBlueprint(kind,x,y){
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
  const b=addBuilding(kind,tx,ty,{built:0}); requestBuildHauls(b); markStaticDirty(); Toast.show('Blueprint placed.');
}

/* ==================== Jobs & AI (trimmed to essentials) ==================== */
function addJob(job){ job.id=uid(); job.assigned=0; jobs.push(job); return job; }
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
function generateJobs(){
  for(let y=0;y<GRID_H;y++){
    for(let x=0;x<GRID_W;x++){
      const i=y*GRID_W+x;
      if(tileOccupiedByBuilding(x,y)) continue;
      const z=world.zone[i];
      if(z===ZONES.FARM){
        if(zoneHasWorkNow(z, i) && !jobs.some(j=>j.type==='sow'&&j.x===x&&j.y===y)){
          addJob({type:'sow',x,y, prio:0.6+priorities.food*0.6});
        }
      }
      else if(z===ZONES.CUT){
        if(zoneHasWorkNow(z, i) && !jobs.some(j=>j.type==='chop'&&j.x===x&&j.y===y)){
          addJob({type:'chop',x,y, prio:0.5+priorities.build*0.5});
        }
      }
      else if(z===ZONES.MINE){
        if(zoneHasWorkNow(z, i) && !jobs.some(j=>j.type==='mine'&&j.x===x&&j.y===y)){
          addJob({type:'mine',x,y, prio:0.5+priorities.build*0.5});
        }
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
    const readyPrio = 0.6 + priorities.build*0.6;
    const waitingPrio = 0.5 + priorities.build*0.35;
    if(!job){
      job = addJob({type:'build',bid:b.id,x:b.x,y:b.y,prio:status.fullyDelivered?readyPrio:waitingPrio});
    } else {
      job.prio = status.fullyDelivered?readyPrio:waitingPrio;
    }
    job.waitingForMaterials = !status.fullyDelivered;
    job.hasAllReserved = status.hasAllReserved;
  }
}
const STARVE_THRESH={ hungry:0.78, starving:1.02, sick:1.15 };
const STARVE_COLLAPSE_TICKS=90;
const STARVE_RECOVERY_TICKS=240;
const STARVE_TOAST_COOLDOWN=420;
const HUNGER_RATE=0.00135;
const ENERGY_DRAIN_BASE=0.0011;
function issueStarveToast(v,text,force=false){ const ready=(v.nextStarveWarning||0)<=tick; if(force||ready){ Toast.show(text); v.nextStarveWarning=tick+STARVE_TOAST_COOLDOWN; } }
function enterSickState(v){ if(v.condition==='sick') return; v.condition='sick'; v.sickTimer=STARVE_COLLAPSE_TICKS; v.starveStage=Math.max(3,v.starveStage||0); finishJob(v); if(v.path) v.path.length=0; v.state='sick'; v.thought=moodThought(v,'Collapsed'); issueStarveToast(v,'A villager collapsed from hunger! They need food now.',true); }
function handleVillagerFed(v,source='food'){ const wasCritical=(v.condition==='sick')||((v.starveStage||0)>=2); v.sickTimer=0; v.starveStage=0; if(wasCritical){ v.condition='recovering'; v.recoveryTimer=STARVE_RECOVERY_TICKS; } else { v.condition='normal'; v.recoveryTimer=Math.max(v.recoveryTimer, Math.floor(STARVE_RECOVERY_TICKS/3)); } v.nextStarveWarning=tick+Math.floor(STARVE_TOAST_COOLDOWN*0.6); if(v.state==='sick') v.state='idle'; v.thought=moodThought(v,wasCritical?'Recovering':'Content'); v.happy=clamp(v.happy+0.05,0,1); if(wasCritical){ const detail=source==='camp'?'camp stores':source==='pack'?'their pack':source==='berries'?'wild berries':source; issueStarveToast(v,`Villager recovered after eating ${detail}.`,true); } }
function villagerTick(v){
  if(v.condition===undefined) v.condition='normal';
  if(v.starveStage===undefined) v.starveStage=0;
  if(v.nextStarveWarning===undefined) v.nextStarveWarning=0;
  if(v.sickTimer===undefined) v.sickTimer=0;
  if(v.recoveryTimer===undefined) v.recoveryTimer=0;
  v.hunger += HUNGER_RATE;
  const tileX=v.x|0, tileY=v.y|0;
  const warm=nearbyWarmth(tileX,tileY);
  let energyDelta=-ENERGY_DRAIN_BASE;
  const moodEnergyBoost=moodMotivation(v)*0.00045;
  let happyDelta=warm?0.0008:-0.0004;
  const { moodBonus } = agricultureBonusesAt(tileX, tileY);
  if(moodBonus){ happyDelta+=moodBonus; }
  energyDelta+=moodEnergyBoost;
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
  if(stage>=2){ energyDelta-=0.00045; happyDelta-=0.0006; }
  if(stage>=3){ energyDelta-=0.0006; happyDelta-=0.001; }
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
  if(urgentFood){
    if(consumeFood(v)){ v.thought=moodThought(v,'Eating'); return; }
    if(foragingJob(v)) return;
  } else if(needsFood){
    if(consumeFood(v)){ v.thought=moodThought(v,'Eating'); return; }
    if(foragingJob(v)) return;
  }
  if(v.energy<0.15){ if(goRest(v)) return; }
  if(v.path && v.path.length>0){ stepAlong(v); return; }
  if(v.inv){ const s=findNearestBuilding(v.x|0,v.y|0,'storage'); if(s && tick>=v._nextPathTick){ const entry=findEntryTileNear(s, v.x|0, v.y|0) || {x:Math.round(buildingCenter(s).x), y:Math.round(buildingCenter(s).y)}; const p=pathfind(v.x|0,v.y|0,entry.x,entry.y); if(p){ v.path=p; v.state='to_storage'; v.thought=moodThought(v,'Storing'); v._nextPathTick=tick+12; return; } } }
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
      v.targetJob=j;
      v.thought=j.type==='haul'?moodThought(v,'Hauling'):moodThought(v,j.type.toUpperCase());
      j.assigned++;
      v._nextPathTick=tick+12;
      return;
    }
  }
  if(stage>=2){ v.thought=moodThought(v,'Starving'); return; }
  const wanderRange=stage===1?3:4;
  v.thought=moodThought(v,stage===1?'Hungry':'Wandering');
  const nx=clamp((v.x|0)+irnd(-wanderRange,wanderRange),0,GRID_W-1);
  const ny=clamp((v.y|0)+irnd(-wanderRange,wanderRange),0,GRID_H-1);
  if(tick>=v._nextPathTick){ const p=pathfind(v.x|0,v.y|0,nx,ny,60); if(p){ v.path=p; v._nextPathTick=tick+12; } }
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
function foragingJob(v){ if(tick<v._nextPathTick) return false; const r=10,sx=v.x|0,sy=v.y|0; let best=null,bd=999; for(let y=sy-r;y<=sy+r;y++){ for(let x=sx-r;x<=sx+r;x++){ const i=idx(x,y); if(i<0) continue; if(world.berries[i]>0){ const d=Math.abs(x-sx)+Math.abs(y-sy); if(d<bd){bd=d; best={x,y,i};} } } } if(best){ const p=pathfind(v.x|0,v.y|0,best.x,best.y,120); if(p){ v.path=p; v.state='forage'; v.targetI=best.i; v.thought=moodThought(v,'Foraging'); v._nextPathTick=tick+12; return true; } } return false; }
function goRest(v){ if(tick<v._nextPathTick) return false; const hut=findNearestBuilding(v.x|0,v.y|0,'hut')||buildings.find(b=>b.kind==='campfire'&&b.built>=1); if(hut){ const entry=findEntryTileNear(hut, v.x|0, v.y|0) || {x:Math.round(buildingCenter(hut).x), y:Math.round(buildingCenter(hut).y)}; const p=pathfind(v.x|0,v.y|0,entry.x,entry.y); if(p){ v.path=p; v.state='rest'; v.targetBuilding=hut; v.thought=moodThought(v,'Resting'); v._nextPathTick=tick+12; return true; } } return false; }
function findNearestBuilding(x,y,kind){ let best=null,bd=Infinity; for(const b of buildings){ if(b.kind!==kind||b.built<1) continue; const d=distanceToFootprint(x,y,b); if(d<bd){bd=d; best=b;} } return best; }
function pickJobFor(v){
  let best=null,bs=-1e9;
  for(const j of jobs){
    let supplyStatus=null;
    if(j.type==='build'){
      const b=buildings.find(bb=>bb.id===j.bid);
      if(!b || b.built>=1) continue;
      supplyStatus=buildingSupplyStatus(b);
      if(!supplyStatus.hasAnySupply){
        j.waitingForMaterials=true;
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
    let d;
    if(j.type==='build'){
      const b=buildings.find(bb=>bb.id===j.bid);
      d=b?distanceToFootprint(v.x|0, v.y|0, b):Math.abs((v.x|0)-j.x)+Math.abs((v.y|0)-j.y);
    } else {
      d=Math.abs((v.x|0)-j.x)+Math.abs((v.y|0)-j.y);
    }
    let prio=(j.prio||0.5);
    if(j.type==='build' && supplyStatus && !supplyStatus.fullyDelivered){
      const waitingCap=0.5 + priorities.build*0.35;
      if(prio>waitingCap) prio=waitingCap;
    }
    let s=prio-d*0.01;
    const mood=moodMotivation(v);
    const heavy=(j.type==='chop'||j.type==='mine'||j.type==='build'||j.type==='haul');
    const nurture=(j.type==='sow'||j.type==='harvest');
    const baseMood=mood*0.04;
    const roleMood=heavy?mood*0.04:(nurture?mood*0.02:0);
    const prioMood=mood>=0?mood*(prio*0.03):mood*((0.7-prio)*0.03);
    s+=baseMood+roleMood+prioMood;
    if(v.role==='farmer'&&(j.type==='sow'||j.type==='harvest')) s+=0.08;
    if(v.role==='worker'&&(j.type==='chop'||j.type==='mine'||j.type==='build')) s+=0.06;
    if(v.hunger>0.6&&(j.type==='sow'||j.type==='harvest')) s+=0.03;
    if(j.type==='build'){
      j.waitingForMaterials=!supplyStatus.fullyDelivered;
    }
    if(s>bs){ bs=s; best=j; }
  }
  return bs>0?best:null;
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
  finishJob(v, remove);
}
else if(v.state==='forage'){
  if(world.berries[v.targetI]>0){
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
  v.energy += 0.4; if(v.energy>1)v.energy=1; v.thought=moodThought(v,'Rested'); v.state='idle';
} }

/* ==================== Pathfinding ==================== */
function passable(x,y){ const i=idx(x,y); if(i<0) return false; if(tileOccupiedByBuilding(x,y)) return false; return WALKABLE.has(world.tiles[i]); }
function pathfind(sx,sy,tx,ty,limit=400){
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
      if(!jobs.some(j=>j.type==='harvest'&&j.x===x&&j.y===y)){
        addJob({type:'harvest',x,y, prio:0.65+priorities.food*0.6});
      }
    }
  }
}

/* ==================== Save/Load ==================== */
function saveGame(){ const data={ saveVersion:SAVE_VERSION, seed:world.seed, tiles:Array.from(world.tiles), zone:Array.from(world.zone), trees:Array.from(world.trees), rocks:Array.from(world.rocks), berries:Array.from(world.berries), growth:Array.from(world.growth), season:world.season, tSeason:world.tSeason, buildings, storageTotals, storageReserved, villagers: villagers.map(v=>({id:v.id,x:v.x,y:v.y,h:v.hunger,e:v.energy,ha:v.happy,role:v.role,cond:v.condition||'normal',ss:v.starveStage||0,ns:v.nextStarveWarning||0,sk:v.sickTimer||0,rc:v.recoveryTimer||0})) }; Storage.set(SAVE_KEY, JSON.stringify(data)); }
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
  storageTotals=Object.assign({food:0,wood:0,stone:0}, d.storageTotals||{});
  storageReserved=Object.assign({food:0,wood:0,stone:0}, d.storageReserved||{});
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
    villagers.push({ id:v.id,x:vx,y:vy,path:[], hunger:v.h,energy:v.e,happy:v.ha,role:v.role,speed:2,inv:null,state:'idle',thought:'Resuming', _nextPathTick:0, condition:cond, starveStage:stage, nextStarveWarning:v.ns||0, sickTimer:v.sk||0, recoveryTimer:v.rc||0 });
  });
  Toast.show('Loaded.'); markStaticDirty(); return true; } catch(e){ console.error(e); return false; } }

/* ==================== Rendering ==================== */
let staticCanvas=null, staticCtx=null, staticDirty=true;
function markStaticDirty(){ staticDirty=true; }
function drawStatic(){ if(!staticCanvas){ staticCanvas=makeCanvas(GRID_W*TILE, GRID_H*TILE); staticCtx=context2d(staticCanvas); } if(!world) return; const g=staticCtx; ensureRowMasksSize();
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
  const shade = (world.hillshade && world.hillshade.length === GRID_SIZE) ? world.hillshade : null;
  if(shade){
    const ctx=staticCtx;
    ctx.save();
    ctx.globalCompositeOperation='multiply';
    const tilePx=TILE;
    let lastColorIndex=-1;
    for(let ty=0; ty<GRID_H; ty++){
      const rowStart=ty*GRID_W;
      const yOffset=ty*tilePx;
      for(let tx=0; tx<GRID_W; tx++){
        const idx=rowStart+tx;
        const tileType = world.tiles[idx];
        if(tileType===TILES.WATER || tileType===TILES.FARMLAND) continue;
        let s=shade[idx];
        if(!Number.isFinite(s)) continue;
        if(s<=0){
          s=0;
        } else if(s>=1){
          continue;
        }
        const colorIndex=((s*255)+0.5)|0;
        if(colorIndex>=255) continue;
        if(colorIndex!==lastColorIndex){
          ctx.fillStyle=SHADE_COLOR_CACHE[colorIndex];
          lastColorIndex=colorIndex;
        }
        const xOffset=tx*tilePx;
        ctx.fillRect(xOffset, yOffset, tilePx, tilePx);
      }
    }
    ctx.restore();
  }
  staticDirty=false; }

function drawTree(g){ g.fillStyle='#6b3f1f'; g.fillRect(14,20,4,6); g.fillStyle='#2c6b34'; g.fillRect(10,12,12,10); g.fillStyle='#2f7f3d'; g.fillRect(12,10,8,4); }
function drawBerry(g){ g.fillStyle='#2f6d36'; g.fillRect(8,16,16,10); g.fillStyle='#a04a5a'; g.fillRect(12,18,2,2); g.fillRect(18,20,2,2); g.fillRect(16,22,2,2); }

function entityDrawRect(tileX, tileY, cam){
  const baseX = tileToPxX(tileX, cam);
  const baseY = tileToPxY(tileY, cam);
  const offset = Math.floor((ENTITY_TILE_PX - TILE) * cam.z * 0.5);
  const size = ENTITY_TILE_PX * cam.z;
  return { x: baseX - offset, y: baseY - offset, size };
}

function drawShadow(tileX, tileY, footprintW=1, footprintH=1, screenRect=null){
  if (!ctx || !world || !world.tiles) return;
  if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return;
  if (normalizeShadingMode(SHADING_DEFAULTS.mode) === 'off') return;

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

function sampleShade(tx, ty){
  const shadeData = (world && world.hillshade && world.hillshade.length === GRID_SIZE) ? world.hillshade : null;
  if (!shadeData) return 1;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return 1;
  const clampedX = clamp(tx, 0, GRID_W - 1);
  const clampedY = clamp(ty, 0, GRID_H - 1);
  const fx = Math.floor(clampedX);
  const fy = Math.floor(clampedY);
  const cx = Math.min(fx + 1, GRID_W - 1);
  const cy = Math.min(fy + 1, GRID_H - 1);
  const wx = clampedX - fx;
  const wy = clampedY - fy;
  const topLeft = shadeData[fy * GRID_W + fx];
  const topRight = shadeData[fy * GRID_W + cx];
  const bottomLeft = shadeData[cy * GRID_W + fx];
  const bottomRight = shadeData[cy * GRID_W + cx];
  const top = topLeft + (topRight - topLeft) * wx;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * wx;
  return clamp01(top + (bottom - top) * wy);
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
  if(staticDirty) drawStatic();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle='#0a0c10';
  ctx.fillRect(0,0,W,H);
  // base map scaled by cam.z
  const baseDx = Math.round(-cam.x*TILE*cam.z);
  const baseDy = Math.round(-cam.y*TILE*cam.z);
  ctx.drawImage(staticCanvas, 0,0, staticCanvas.width, staticCanvas.height,
    baseDx, baseDy,
    staticCanvas.width*cam.z, staticCanvas.height*cam.z);

  let t0,t1,t2;
  if(PERF.log) t0 = performance.now();

  const vis = visibleTileBounds();
  const x0=vis.x0, y0=vis.y0, x1=vis.x1, y1=vis.y1;

  // animated water overlay
  const frames = Tileset.waterOverlay || [];
  if(frames.length){
    const frame = Math.floor((tick/10)%frames.length);
    for(let y=y0;y<=y1;y++){
      if(!waterRowMask[y]) continue;
      const rowStart=y*GRID_W;
      for(let x=x0;x<=x1;x++){ const i=rowStart+x; if(world.tiles[i]===TILES.WATER){
        const px = tileToPxX(x, cam);
        const py = tileToPxY(y, cam);
        ctx.drawImage(frames[frame], 0,0,TILE,TILE, px, py, TILE*cam.z, TILE*cam.z);
      } }
    }
  }

  const activeZoneJobs={ sow:new Set(), chop:new Set(), mine:new Set() };
  for(const job of jobs){
    const type=job.type;
    if((job.assigned||0)>0 && activeZoneJobs[type]){
      activeZoneJobs[type].add(job.y*GRID_W + job.x);
    }
  }

  // zones glyphs and wash
  for(let y=y0;y<=y1;y++){
    if(!zoneRowMask[y]) continue;
    const rowStart=y*GRID_W;
    for(let x=x0;x<=x1;x++){
      const i=rowStart+x; const z=world.zone[i]; if(z===ZONES.NONE) continue;
      if(!zoneHasWorkNow(z, i)) continue;
      const jobType=zoneJobType(z);
      if(jobType){ const activeSet=activeZoneJobs[jobType]; if(activeSet && activeSet.has(i)) continue; }
      const wash = z===ZONES.FARM ? 'rgba(120,220,120,0.25)'
                 : z===ZONES.CUT  ? 'rgba(255,190,110,0.22)'
                 :                   'rgba(160,200,255,0.22)';
      ctx.fillStyle=wash;
      const px = tileToPxX(x, cam);
      const py = tileToPxY(y, cam);
      ctx.fillRect(px, py, TILE*cam.z, TILE*cam.z);
      const glyph = z===ZONES.FARM ? Tileset.zoneGlyphs.farm : z===ZONES.CUT ? Tileset.zoneGlyphs.cut : Tileset.zoneGlyphs.mine;
      ctx.globalAlpha=0.6;
      for(let yy=4; yy<TILE; yy+=10){ for(let xx=4; xx<TILE; xx+=10){
        ctx.drawImage(glyph, 0,0,8,8, px+xx*cam.z, py+yy*cam.z, 8*cam.z, 8*cam.z);
      } }
      ctx.globalAlpha=1;
    }
  }

  // vegetation/crops
  for(let y=y0;y<=y1;y++){ const rowStart=y*GRID_W; for(let x=x0;x<=x1;x++){ const i=rowStart+x;
    if(world.tiles[i]===TILES.FOREST && world.trees[i]>0){
      drawShadow(x, y, 1, 1);
      const rect = entityDrawRect(x, y, cam);
      const raisedY = rect.y - Math.round(cam.z*TREE_VERTICAL_RAISE);
      const shade = sampleShade(x, y);
      ctx.save();
      ctx.drawImage(Tileset.sprite.tree, 0,0,ENTITY_TILE_PX,ENTITY_TILE_PX, rect.x, raisedY, rect.size, rect.size);
      applySpriteShade(ctx, rect.x, raisedY, rect.size, rect.size, shade);
      ctx.restore();
    }
    if(world.berries[i]>0){
      drawShadow(x, y, 1, 1);
      const rect = entityDrawRect(x, y, cam);
      const shade = sampleShade(x, y);
      ctx.save();
      ctx.drawImage(Tileset.sprite.berry, 0,0,ENTITY_TILE_PX,ENTITY_TILE_PX, rect.x, rect.y, rect.size, rect.size);
      applySpriteShade(ctx, rect.x, rect.y, rect.size, rect.size, shade);
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
    const shade = sampleShade(it.x, it.y);
    const tileSize = TILE*cam.z;
    const centerX = Math.round(gx + tileSize*0.5);
    const centerY = Math.round(gy + tileSize*0.5);
    const size = Math.max(2, Math.round(4*cam.z));
    const half = Math.floor(size/2);
    const spriteRect = { x:centerX-half, y:centerY-half, w:size, h:size };
    drawShadow(it.x, it.y, 1, 1, spriteRect);
    ctx.save();
    const baseColor = it.type===ITEM.WOOD ? '#b48a52' : it.type===ITEM.STONE ? '#aeb7c3' : '#b6d97a';
    ctx.fillStyle = shadeFillColor(baseColor, shade);
    ctx.fillRect(spriteRect.x, spriteRect.y, spriteRect.w, spriteRect.h);
    ctx.restore();
  }

  // villagers
  for(const v of villagers){ drawVillager(v); }

  if(ui.mode==='zones' && brushPreview){
    const {x,y,r}=brushPreview;
    ctx.strokeStyle='rgba(124,196,255,0.9)';
    const strokeWidth=Math.max(1, Math.round(cam.z));
    ctx.lineWidth=strokeWidth;
    for(let yy=y-r; yy<=y+r; yy++){
      for(let xx=x-r; xx<=x+r; xx++){
        if(xx<0||yy<0||xx>=GRID_W||yy>=GRID_H) continue;
        const sx = tileToPxX(xx, cam);
        const sy = tileToPxY(yy, cam);
        const tileSize=TILE*cam.z;
        const inset=Math.min(Math.max(1, Math.round(cam.z*0.5)), Math.floor(tileSize*0.5));
        const rectSize=Math.max(0, Math.round(tileSize - inset*2));
        ctx.strokeRect(sx+inset, sy+inset, rectSize, rectSize);
      }
    }
  }

  // day/night tint (screen space)
  const t=dayTime/DAY_LEN; let night=(Math.cos((t*2*Math.PI))+1)/2; ctx.fillStyle=`rgba(10,18,30, ${0.25*night})`; ctx.fillRect(0,0,W,H);

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

  // HUD counters
  el('food').textContent=storageTotals.food|0; el('wood').textContent=storageTotals.wood|0; el('stone').textContent=storageTotals.stone|0; el('pop').textContent=villagers.length|0;
  if(PERF.log){
    t2 = performance.now();
    if((tick % 60) === 0) console.log(`render: overlays ${(t1-t0).toFixed(2)}ms, total ${(t2-t0).toFixed(2)}ms`);
  }
}

function drawBuildingAt(gx,gy,b){
  const g=ctx, s=cam.z;
  const fp=getFootprint(b.kind);
  const center=buildingCenter(b);
  const shade = b.kind==='farmplot' ? 1 : sampleShade(center.x, center.y);
  drawShadow(b.x, b.y, fp.w, fp.h);
  const offsetX = Math.floor((ENTITY_TILE_PX - fp.w*TILE) * s * 0.5);
  const offsetY = Math.floor((ENTITY_TILE_PX - fp.h*TILE) * s * 0.5);
  gx -= offsetX;
  gy -= offsetY;
  g.save();
  if(b.kind==='campfire'){
    g.fillStyle=shadeFillColor('#7b8591', shade);
    g.fillRect(gx+10*s,gy+18*s,12*s,6*s);
    const f=(tick%6);
    const flameColor=['#ffde7a','#ffc05a','#ff9b4a'][f%3];
    g.fillStyle=shadeFillColor(flameColor, shade);
    g.fillRect(gx+14*s,gy+12*s,4*s,6*s);
  } else if(b.kind==='storage'){
    g.fillStyle=shadeFillColor('#6a5338', shade);
    g.fillRect(gx+6*s,gy+10*s,20*s,14*s);
    g.fillStyle=shadeFillColor('#8b6b44', shade);
    g.fillRect(gx+6*s,gy+20*s,20*s,2*s);
    g.fillStyle=shadeFillColor('#3b2b1a', shade);
    g.fillRect(gx+6*s,gy+10*s,20*s,1*s);
  } else if(b.kind==='hut'){
    g.fillStyle=shadeFillColor('#7d5a3a', shade);
    g.fillRect(gx+8*s,gy+16*s,16*s,12*s);
    g.fillStyle=shadeFillColor('#caa56a', shade);
    g.fillRect(gx+6*s,gy+12*s,20*s,6*s);
    g.fillStyle=shadeFillColor('#31251a', shade);
    g.fillRect(gx+14*s,gy+20*s,4*s,8*s);
  } else if(b.kind==='farmplot'){
    g.fillStyle=shadeFillColor('#4a3624', shade);
    g.fillRect(gx+4*s,gy+8*s,24*s,16*s);
    g.fillStyle=shadeFillColor('#3b2a1d', shade);
    g.fillRect(gx+4*s,gy+12*s,24*s,2*s);
    g.fillRect(gx+4*s,gy+16*s,24*s,2*s);
    g.fillRect(gx+4*s,gy+20*s,24*s,2*s);
  } else if(b.kind==='well'){
    g.fillStyle=shadeFillColor('#6f8696', shade);
    g.fillRect(gx+10*s,gy+14*s,12*s,10*s);
    g.fillStyle=shadeFillColor('#2b3744', shade);
    g.fillRect(gx+12*s,gy+18*s,8*s,6*s);
    g.fillStyle=shadeFillColor('#927a54', shade);
    g.fillRect(gx+8*s,gy+12*s,16*s,2*s);
  }
  if(b.built<1){
    g.strokeStyle='rgba(255,255,255,0.6)';
    g.strokeRect(gx+4*s,gy+4*s,24*s,24*s);
    const p=(b.progress||0)/(BUILDINGS[b.kind].cost||1);
    g.fillStyle=shadeFillColor('#7cc4ff', shade);
    g.fillRect(gx+6*s,gy+28*s, Math.floor(20*p)*s, 2*s);
  }
  g.restore();
}

function drawVillager(v){
  const frames = v.role==='farmer'? Tileset.villagerSprites.farmer : v.role==='worker'? Tileset.villagerSprites.worker : v.role=='explorer'? Tileset.villagerSprites.explorer : Tileset.villagerSprites.sleepy;
  const f=frames[Math.floor((tick/8)%3)], s=cam.z;
  const rect = entityDrawRect(v.x, v.y, cam);
  const spriteSize = 16 * s;
  const gx = Math.floor(rect.x + (rect.size - spriteSize) * 0.5);
  const gy = Math.floor(rect.y + (rect.size - spriteSize) * 0.5);
  const shade = sampleShade(v.x, v.y);
  drawShadow(v.x, v.y, 1, 1, { x:gx, y:gy, w:spriteSize, h:spriteSize });
  ctx.save();
  ctx.drawImage(f, 0,0,16,16, gx, gy, spriteSize, spriteSize);
  applySpriteShade(ctx, gx, gy, spriteSize, spriteSize, shade);
  if(v.inv){
    const packColor=v.inv.type===ITEM.WOOD?'#b48a52':v.inv.type===ITEM.STONE?'#aeb7c3':'#b6d97a';
    ctx.fillStyle=shadeFillColor(packColor, shade);
    ctx.fillRect(gx+spriteSize-4*s, gy+2*s, 3*s, 3*s);
  }
  const cond=v.condition;
  const baseCx=gx+spriteSize*0.5;
  const baseCy=gy-4*cam.z;
  let labelOffset=0;
  function drawLabel(text,color){
    const fontSize=Math.max(6,6*cam.z);
    const cx=baseCx;
    const cy=baseCy-labelOffset;
    ctx.save();
    ctx.font=`600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    const metrics=ctx.measureText(text);
    const boxW=metrics.width+6*cam.z;
    const boxH=fontSize+4*cam.z;
    ctx.fillStyle=shadeFillColor('rgba(10,12,16,0.8)', shade);
    ctx.fillRect(cx-boxW/2, cy-boxH/2, boxW, boxH);
    ctx.strokeStyle='rgba(255,255,255,0.25)';
    ctx.lineWidth=Math.max(1, Math.round(0.7*cam.z));
    ctx.strokeRect(cx-boxW/2, cy-boxH/2, boxW, boxH);
    ctx.fillStyle=shadeFillColor(color, shade);
    ctx.fillText(text, cx, cy+0.2*cam.z);
    ctx.restore();
    labelOffset+=boxH+2*cam.z;
  }
  if(cond && cond!=='normal'){
    let label=null, color='#ffcf66';
    if(cond==='hungry'){ label='Hungry'; color='#ffcf66'; }
    else if(cond==='starving'){ label='Starving'; color='#ff6b6b'; }
    else if(cond==='sick'){ label='Collapsed'; color='#d76bff'; }
    else if(cond==='recovering'){ label='Recovering'; color='#7cc4ff'; }
    if(label){ drawLabel(label,color); }
  }
  const mood=v.happy;
  let moodLabel=null, moodColor='#8fe58c';
  if(mood>=0.8){ moodLabel='😊 Upbeat'; moodColor='#8fe58c'; }
  else if(mood>=0.65){ moodLabel='🙂 Cheerful'; moodColor='#b9f5ae'; }
  else if(mood<=0.2){ moodLabel='☹️ Miserable'; moodColor='#ff8c8c'; }
  else if(mood<=0.35){ moodLabel='😟 Low spirits'; moodColor='#f5d58b'; }
  if(moodLabel){ drawLabel(moodLabel,moodColor); }
  ctx.restore();
}


/* ==================== Items & Loop ==================== */
function dropItem(x,y,type,qty){ itemsOnGround.push({x,y,type,qty}); }
let last=performance.now(), acc=0; const TICK_MS=1000/6; const TICKS_PER_SEC=6; const SECONDS_PER_TICK=1/TICKS_PER_SEC; const SPEED_PX_PER_SEC=0.08*32*TICKS_PER_SEC;
function update(){ if(paused){ render(); requestAnimationFrame(update); return; } const now=performance.now(); let dt=now-last; last=now; dt*=SPEEDS[speedIdx]; acc+=dt; const steps=Math.floor(acc/TICK_MS); if(steps>0) acc-=steps*TICK_MS; for(let s=0;s<steps;s++){ tick++; dayTime=(dayTime+1)%DAY_LEN; if(tick%20===0) generateJobs(); if(tick%10===0) seasonTick(); for(const v of villagers){ if(!v.inv){ for(let k=0;k<itemsOnGround.length;k++){ const it=itemsOnGround[k]; if((v.x|0)===it.x && (v.y|0)===it.y){ v.inv={type:it.type,qty:it.qty}; itemsOnGround.splice(k,1); k--; break; } } } } for(const v of villagers){ villagerTick(v); } } render(); requestAnimationFrame(update); }

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
    showFatalOverlay(e);
  } finally {
    // Ensure the loop starts no matter what
    try { requestAnimationFrame(update); }
    catch (e){ showFatalOverlay(e); }
  }
}
boot();

})();
