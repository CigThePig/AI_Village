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
  return { available, get, set, del };
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
const TILE = 32, MAP_W = 96, MAP_H = 96;
const TILES = { GRASS:0, FOREST:1, ROCK:2, WATER:3, FERTILE:4, FARMLAND:5, SAND:6, SNOW:7 };
const ZONES = { NONE:0, FARM:1, CUT:2, MINE:4 };
const WALKABLE = new Set([TILES.GRASS, TILES.FOREST, TILES.ROCK, TILES.FERTILE, TILES.FARMLAND, TILES.SAND, TILES.SNOW]);
const ITEM = { FOOD:'food', WOOD:'wood', STONE:'stone' };
const DIR4 = [[1,0],[-1,0],[0,1],[0,-1]];
const SPEEDS = [0.5, 1, 2, 4];
const PF = {
  qx: new Int16Array(MAP_W*MAP_H),
  qy: new Int16Array(MAP_W*MAP_H),
  came: new Int32Array(MAP_W*MAP_H)
};

/* ==================== Canvas & Camera ==================== */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha:false });
canvas.style.touchAction = 'none';
let DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
let W=0, H=0;
let cam = { x:0, y:0, z:2.2 }; // x,y in device pixels; draw scales by z
const MIN_Z=1.2, MAX_Z=4.5;

function resize(){
  DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  W = Math.floor(window.innerWidth * DPR);
  H = Math.floor(window.innerHeight * DPR);
  canvas.width = W; canvas.height = H;
  canvas.style.width = '100vw'; canvas.style.height = '100vh';
}
resize(); window.addEventListener('resize', resize);
function clampCam(){
  const maxX = MAP_W*TILE*cam.z - W;
  const maxY = MAP_H*TILE*cam.z - H;
  cam.x = Math.max(0, Math.min(cam.x, Math.max(0,maxX)));
  cam.y = Math.max(0, Math.min(cam.y, Math.max(0,maxY)));
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
function makeSprite(w,h,drawFn){ const c=makeCanvas(w,h), g=c.getContext('2d'); drawFn(g); return c; }

function makeGrass(){ const c=makeCanvas(TILE,TILE), g=c.getContext('2d'); rect(g,0,0,TILE,TILE,'#245a2f'); for(let i=0;i<40;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), (i%3===0)?'#2f7d3d':(i%2===0?'#2a6b37':'#2a5f34')); } g.globalAlpha=0.25; rect(g,0,TILE-5,TILE,5,'#1a3e22'); g.globalAlpha=1; return c; }
function makeFertile(){ const c=makeCanvas(TILE,TILE), g=c.getContext('2d'); rect(g,0,0,TILE,TILE,'#3c2a1e'); g.globalAlpha=0.2; for(let y=4;y<TILE;y+=6){ rect(g,0,y,TILE,2,'#2a1d15'); } g.globalAlpha=1; return c; }
function makeSand(){ const c=makeCanvas(TILE,TILE), g=c.getContext('2d'); rect(g,0,0,TILE,TILE,'#b99a52'); for(let i=0;i<28;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#c7ad69':'#a78848'); } return c; }
function makeSnow(){ const c=makeCanvas(TILE,TILE), g=c.getContext('2d'); rect(g,0,0,TILE,TILE,'#d7e6f8'); for(let i=0;i<24;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), '#c9d7ea'); } rect(g,0,TILE-4,TILE,4,'#c0d0e8'); return c; }
function makeRock(){ const c=makeCanvas(TILE,TILE), g=c.getContext('2d'); rect(g,0,0,TILE,TILE,'#59616c'); for(let i=0;i<30;i++){ px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#8f99a5':'#6c757f'); } rect(g,0,TILE-5,TILE,5,'#4a525b'); return c; }
function makeWaterBase(){ const c=makeCanvas(TILE,TILE), g=c.getContext('2d'); rect(g,0,0,TILE,TILE,'#134a6a'); for (let i = 0; i < 14; i++) { px(g,irnd(0,TILE-1),irnd(0,TILE-1), i%2?'#0f3e59':'#0c3248'); } return c; }
function makeWaterOverlayFrames(){ const frames=[]; for(let f=0; f<3; f++){ const c=makeCanvas(TILE,TILE), g=c.getContext('2d'); g.globalAlpha=0.22; g.strokeStyle='#4fa3d6'; g.lineWidth=1; g.beginPath(); for(let i=0;i<3;i++){ const y=6+i*10+f*2; g.moveTo(0,y); g.quadraticCurveTo(TILE*0.5,y+2,TILE,y); } g.stroke(); g.globalAlpha=1; frames.push(c); } return frames; }
function makeFarmland(){ const c=makeCanvas(TILE,TILE), g=c.getContext('2d'); rect(g,0,0,TILE,TILE,'#4a3624'); g.globalAlpha=0.25; for(let y=3;y<TILE;y+=6){ rect(g,0,y,TILE,2,'#3b2a1d'); } g.globalAlpha=1; return c; }
function drawSproutOn(g,stage){ const s=Math.min(3,Math.floor(stage)); if(s<=0) return; const gx=8, gy=10; g.fillStyle='#86c06c'; g.fillRect(gx,gy,2,2); if(s>=2){ g.fillRect(gx-2,gy+2,6,2); } if(s>=3){ g.fillRect(gx-1,gy-2,4,2); } }
function makeZoneGlyphs(){ const farm=makeCanvas(8,8), f=farm.getContext('2d'); rect(f,0,0,8,8,'rgba(0,0,0,0)'); px(f,3,6,'#9dd47a'); px(f,4,6,'#9dd47a'); px(f,3,5,'#73b85d'); px(f,4,5,'#73b85d'); px(f,3,4,'#5aa34b'); const cut=makeCanvas(8,8), c=cut.getContext('2d'); rect(c,0,0,8,8,'rgba(0,0,0,0)'); rect(c,2,2,4,1,'#caa56a'); rect(c,3,1,2,1,'#8f6934'); const mine=makeCanvas(8,8), m=mine.getContext('2d'); rect(m,0,0,8,8,'rgba(0,0,0,0)'); rect(m,2,2,4,1,'#9aa3ad'); rect(m,3,3,2,1,'#6d7782'); Tileset.zoneGlyphs={farm,cut,mine}; }
function makeVillagerFrames(){ function role(shirt,hat){ const frames=[]; for(let f=0; f<3; f++){ const c=makeCanvas(16,16), g=c.getContext('2d'); rect(g,7,4,2,2,'#f1d4b6'); if(hat){ rect(g,6,3,4,1,hat); rect(g,6,2,4,1,hat); } rect(g,6,6,4,4,shirt); if(f===0){ rect(g,5,6,1,3,shirt); rect(g,10,6,1,2,shirt); } if(f===1){ rect(g,5,6,1,2,shirt); rect(g,10,6,1,3,shirt); } if(f===2){ rect(g,5,6,1,2,shirt); rect(g,10,6,1,2,shirt); } rect(g,6,10,1,4,'#3f3f4f'); rect(g,9,10,1,4,'#3f3f4f'); frames.push(c);} return frames; } Tileset.villagerSprites.farmer=role('#3aa357','#d6cf74'); Tileset.villagerSprites.worker=role('#a36b3a','#8f7440'); Tileset.villagerSprites.explorer=role('#3a6aa3',null); Tileset.villagerSprites.sleepy=role('#777','#444'); }
function buildTileset(){
  try { Tileset.base.grass = makeGrass(); } catch(e){ console.warn('grass', e); }
  try { Tileset.base.fertile = makeFertile(); } catch(e){ console.warn('fertile', e); }
  try { Tileset.base.sand = makeSand(); } catch(e){ console.warn('sand', e); }
  try { Tileset.base.snow = makeSnow(); } catch(e){ console.warn('snow', e); }
  try { Tileset.base.rock = makeRock(); } catch(e){ console.warn('rock', e); }
  try { Tileset.base.water = makeWaterBase(); } catch(e){ console.warn('water', e); }
  try { Tileset.base.farmland = makeFarmland(); } catch(e){ console.warn('farmland', e); }
  try { Tileset.waterOverlay = makeWaterOverlayFrames(); } catch(e){ console.warn('waterOverlay', e); Tileset.waterOverlay = []; }
  try { makeZoneGlyphs(); } catch(e){ console.warn('zones', e); }
  try { makeVillagerFrames(); } catch(e){ console.warn('villagers', e); }
  try {
    Tileset.sprite.tree = makeSprite(TILE,TILE, drawTree);
    Tileset.sprite.berry = makeSprite(TILE,TILE, drawBerry);
    Tileset.sprite.sprout = [
      makeSprite(TILE,TILE, g=>drawSproutOn(g,1)),
      makeSprite(TILE,TILE, g=>drawSproutOn(g,2)),
      makeSprite(TILE,TILE, g=>drawSproutOn(g,3))
    ];
  } catch(e){ console.warn('sprites', e); }
}

/* ==================== World State ==================== */
let world=null, buildings=[], villagers=[], jobs=[], itemsOnGround=[], storageTotals={food:0,wood:0,stone:0};
let tick=0, paused=false, speedIdx=1, dayTime=0; const DAY_LEN=60*40;
const BUILDINGS = { campfire:{label:'Campfire',cost:0,wood:0,stone:0}, storage:{label:'Storage',cost:8,wood:8,stone:0}, hut:{label:'Hut',cost:10,wood:10,stone:0}, farmplot:{label:'Farm Plot',cost:4,wood:4,stone:0}, well:{label:'Well',cost:6,wood:0,stone:6} };

function newWorld(seed=Date.now()|0){
  R = mulberry32(seed>>>0);
  jobs.length=0; buildings.length=0; itemsOnGround.length=0;
  storageTotals={food:8, wood:12, stone:0};
  tick=0; dayTime=0;
  world={ seed, tiles:new Uint8Array(MAP_W*MAP_H), zone:new Uint8Array(MAP_W*MAP_H), trees:new Uint8Array(MAP_W*MAP_H), rocks:new Uint8Array(MAP_W*MAP_H), berries:new Uint8Array(MAP_W*MAP_H), growth:new Uint8Array(MAP_W*MAP_H), season:0, tSeason:0 };
  function idc(x,y){ return y*MAP_W+x; }
  for(let y=0;y<MAP_H;y++){ for(let x=0;x<MAP_W;x++){ const v=R(); let t=TILES.GRASS;
    if(v<0.10) t=TILES.WATER; else if(v<0.18) t=TILES.ROCK; else if(v<0.52) t=TILES.FOREST; else if(v<0.72) t=TILES.FERTILE; else if(v<0.80) t=TILES.SAND; else if(v<0.86) t=TILES.SNOW;
    world.tiles[idc(x,y)]=t; world.zone[idc(x,y)]=0; world.growth[idc(x,y)]=0;
    if(t===TILES.FOREST && R()<0.9) world.trees[idc(x,y)]=1+(R()<0.6?1:0);
    if(t===TILES.ROCK && R()<0.7) world.rocks[idc(x,y)]=1+(R()<0.5?1:0);
    if((t===TILES.GRASS||t===TILES.FERTILE) && R()<0.14) world.berries[idc(x,y)]=1;
  } }
  let sx=MAP_W>>1, sy=MAP_H>>1;
  for(let k=0;k<200;k++){ const x=(MAP_W>>1)+irnd(-8,8), y=(MAP_H>>1)+irnd(-8,8); const t=world.tiles[idc(x,y)]; if(t!==TILES.WATER && t!==TILES.ROCK){ sx=x; sy=y; break; } }
  addBuilding('campfire',sx,sy,{built:1}); addBuilding('storage',sx+1,sy,{built:1});
  villagers.length=0; for(let i=0;i<6;i++){ villagers.push(newVillager(sx+irnd(-1,1), sy+irnd(-1,1))); }
  toast('New pixel map created.'); centerCamera(sx,sy); markStaticDirty();
}
function newVillager(x,y){ const r=R(); let role=r<0.25?'farmer':r<0.5?'worker':r<0.75?'explorer':'sleepy'; return { id:uid(), x,y,path:[], hunger:rnd(0.2,0.5), energy:rnd(0.5,0.9), happy:rnd(0.4,0.8), speed:2+rnd(-0.2,0.2), inv:null, state:'idle', thought:'Wandering', role, _nextPathTick:0 }; }
function addBuilding(kind,x,y,opts={}){ const def=BUILDINGS[kind]; const b={ id:uid(), kind,x,y, built:opts.built?1:0, progress:opts.built?def.cost:0, store:(kind==='storage'?{wood:0,stone:0,food:0}:null) }; buildings.push(b); return b; }

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

function screenToWorld(px, py){
  const rect = canvas.getBoundingClientRect();
  // Use the real backing-store scale instead of DPR guesses
  const sx = (px - rect.left) * (canvas.width  / rect.width);
  const sy = (py - rect.top)  * (canvas.height / rect.height);
  return {
    x: (sx - cam.x) / (TILE * cam.z),
    y: (sy - cam.y) / (TILE * cam.z)
  };
}

canvas.addEventListener('pointerdown', (e)=>{
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
    if(ui.mode==='build'){ const w=screenToWorld(e.clientX,e.clientY); placeBlueprint(ui.buildKind||'hut', w.x|0, w.y|0); }
    if(ui.mode==='zones'){ const w=screenToWorld(e.clientX,e.clientY); paintZoneAt(w.x|0,w.y|0); }
  }
  e.preventDefault();
},{passive:false});

canvas.addEventListener('pointermove', (e)=>{
  if(!activePointers.has(e.pointerId)) return;
  const p = activePointers.get(e.pointerId);
  p.x=e.clientX; p.y=e.clientY; activePointers.set(e.pointerId,p);

  if(pinch && activePointers.size===2){
    const pts = Array.from(activePointers.values());
    const dist = Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
    const before = screenToWorld(pinch.midx,pinch.midy);
    cam.z = clamp((dist/(pinch.startDist||1))*pinch.startZ, MIN_Z, MAX_Z);
    const after = screenToWorld(pinch.midx,pinch.midy);
    cam.x += (after.x-before.x)*(TILE*cam.z);
    cam.y += (after.y-before.y)*(TILE*cam.z);
    const midx=(pts[0].x+pts[1].x)/2, midy=(pts[0].y+pts[1].y)/2;
    cam.x -= (midx-pinch.midx)*DPR;
    cam.y -= (midy-pinch.midy)*DPR;
    pinch.midx=midx; pinch.midy=midy;
    clampCam();
  } else if(primaryPointer && e.pointerId===primaryPointer.id){
    if(ui.mode!=='zones'){
      const dx=(e.clientX-primaryPointer.sx)*DPR;
      const dy=(e.clientY-primaryPointer.sy)*DPR;
      cam.x = primaryPointer.camx - dx;
      cam.y = primaryPointer.camy - dy;
      clampCam();
    } else {
      const w=screenToWorld(e.clientX,e.clientY);
      paintZoneAt(w.x|0,w.y|0);
    }
  }

  if(ui.mode==='zones'){
    const ptr = primaryPointer ? activePointers.get(primaryPointer.id) : activePointers.values().next().value;
    if(ptr){
      const w=screenToWorld(ptr.x, ptr.y);
      brushPreview={x:Math.floor(w.x), y:Math.floor(w.y), r:ui.brush|0};
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
    brushPreview=null;
    if(ui.mode==='zones') generateJobs();  // ← regen once when painting stops
  }
}

canvas.addEventListener('pointerup', endPointer, {passive:false});
canvas.addEventListener('pointercancel', endPointer, {passive:false});
canvas.addEventListener('pointerleave', endPointer, {passive:false});

canvas.addEventListener('wheel', (e)=>{
  const delta=Math.sign(e.deltaY); const scale=delta>0?1/1.1:1.1; const mx=e.clientX,my=e.clientY;
  const before=screenToWorld(mx,my); cam.z=clamp(cam.z*scale, MIN_Z, MAX_Z); const after=screenToWorld(mx,my);
  cam.x += (after.x-before.x)*(TILE*cam.z); cam.y += (after.y-before.y)*(TILE*cam.z); clampCam();
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
document.getElementById('sheetBuild').addEventListener('click', (e)=>{
  const t = e.target.closest('.tile'); if (!t) return;
  ui.buildKind = t.getAttribute('data-build');
  toggleSheet('sheetBuild', false);           // ← close sheet so canvas gets taps
  Toast.show('Tap map to place: ' + ui.buildKind);
});
const priorities={ food:0.7, build:0.5, explore:0.3 };
document.getElementById('prioFood').addEventListener('input', e=> priorities.food=(parseInt(e.target.value,10)||0)/100 );
document.getElementById('prioBuild').addEventListener('input', e=> priorities.build=(parseInt(e.target.value,10)||0)/100 );
document.getElementById('prioExplore').addEventListener('input', e=> priorities.explore=(parseInt(e.target.value,10)||0)/100 );
function idx(x,y){ if(x<0||y<0||x>=MAP_W||y>=MAP_H) return -1; return y*MAP_W+x; }
function getTile(x,y){ const i=idx(x,y); if(i<0) return null; return { t:world.tiles[i], i }; }
function centerCamera(x,y){ cam.z=2.2; cam.x=x*TILE*cam.z - W*0.5; cam.y=y*TILE*cam.z - H*0.5; clampCam(); }
function paintZoneAt(cx, cy){
  if (cx<0 || cy<0 || cx>=MAP_W || cy>=MAP_H) return;
  const r = ui.brush|0, z = ui.zonePaint|0;
  for (let y = cy - r; y <= cy + r; y++){
    for (let x = cx - r; x <= cx + r; x++){
      if (x<0 || y<0 || x>=MAP_W || y>=MAP_H) continue;
      world.zone[y*MAP_W + x] = z;         // paint immediately
    }
  }
  brushPreview = {x:cx, y:cy, r};
}
function placeBlueprint(kind,x,y){ if(x<0||y<0||x>=MAP_W||y>=MAP_H) return; const t=getTile(x,y); if(!t||t.t===TILES.WATER){ Toast.show('Cannot build on water.'); return; } if(buildings.some(b=>b.x===x&&b.y===y)){ Toast.show('Tile occupied.'); return; } addBuilding(kind,x,y,{built:0}); markStaticDirty(); Toast.show('Blueprint placed.'); }

/* ==================== Jobs & AI (trimmed to essentials) ==================== */
function addJob(job){ job.id=uid(); job.assigned=0; jobs.push(job); return job; }
function generateJobs(){ for(let y=0;y<MAP_H;y++){ for(let x=0;x<MAP_W;x++){ const i=y*MAP_W+x; const z=world.zone[i];
  if(z===ZONES.FARM){ if(world.tiles[i]!==TILES.WATER && !jobs.some(j=>j.type==='sow'&&j.x===x&&j.y===y)) addJob({type:'sow',x,y, prio:0.6+priorities.food*0.6}); }
  else if(z===ZONES.CUT){ if(world.trees[i]>0 && !jobs.some(j=>j.type==='chop'&&j.x===x&&j.y===y)) addJob({type:'chop',x,y, prio:0.5+priorities.build*0.5}); }
  else if(z===ZONES.MINE){ if(world.rocks[i]>0 && !jobs.some(j=>j.type==='mine'&&j.x===x&&j.y===y)) addJob({type:'mine',x,y, prio:0.5+priorities.build*0.5}); }
} } buildings.forEach(b=>{ if(b.built<1 && !jobs.some(j=>j.type==='build'&&j.bid===b.id)) addJob({type:'build',bid:b.id,x:b.x,y:b.y,prio:0.6+priorities.build*0.6}); }); }
function villagerTick(v){
  v.hunger += 0.0015; v.energy -= 0.0012; v.happy += nearbyWarmth(v.x|0,v.y|0)?0.0008:-0.0004;
  v.hunger=clamp(v.hunger,0,1.2); v.energy=clamp(v.energy,0,1); v.happy=clamp(v.happy,0,1);
  if(v.hunger>0.9){ if(consumeFood(v)){ v.thought='Eating'; return; } if(foragingJob(v)) return; }
  if(v.energy<0.15){ if(goRest(v)) return; }
  if(v.path && v.path.length>0){ stepAlong(v); return; }
  if(v.inv){ const s=findNearestBuilding(v.x|0,v.y|0,'storage'); if(s && tick>=v._nextPathTick){ const p=pathfind(v.x|0,v.y|0,s.x,s.y); if(p){ v.path=p; v.state='to_storage'; v.thought='Storing'; v._nextPathTick=tick+12; return; } } }
  const j=pickJobFor(v); if(j && tick>=v._nextPathTick){ const dest={x:j.x,y:j.y}; if(j.type==='build'){ const b=buildings.find(bb=>bb.id===j.bid); if(b) dest.x=b.x, dest.y=b.y; } const p=pathfind(v.x|0,v.y|0,dest.x,dest.y); if(p){ v.path=p; v.state=j.type; v.targetJob=j; v.thought=j.type.toUpperCase(); j.assigned++; v._nextPathTick=tick+12; return; } }
  v.thought='Wandering'; const nx=clamp((v.x|0)+irnd(-4,4),0,MAP_W-1), ny=clamp((v.y|0)+irnd(-4,4),0,MAP_H-1); if(tick>=v._nextPathTick){ const p=pathfind(v.x|0,v.y|0,nx,ny,60); if(p){ v.path=p; v._nextPathTick=tick+12; } }
}
function nearbyWarmth(x,y){ return buildings.some(b=>b.kind==='campfire' && Math.abs(b.x-x)+Math.abs(b.y-y)<=2); }
function consumeFood(v){ if(v.inv&&v.inv.type===ITEM.FOOD){ v.hunger-=0.6; if(v.hunger<0)v.hunger=0; v.inv=null; return true; } if(storageTotals.food>0){ storageTotals.food--; v.hunger-=0.6; if(v.hunger<0)v.hunger=0; return true; } return false; }
function foragingJob(v){ if(tick<v._nextPathTick) return false; const r=10,sx=v.x|0,sy=v.y|0; let best=null,bd=999; for(let y=sy-r;y<=sy+r;y++){ for(let x=sx-r;x<=sx+r;x++){ const i=idx(x,y); if(i<0) continue; if(world.berries[i]>0){ const d=Math.abs(x-sx)+Math.abs(y-sy); if(d<bd){bd=d; best={x,y,i};} } } } if(best){ const p=pathfind(v.x|0,v.y|0,best.x,best.y,120); if(p){ v.path=p; v.state='forage'; v.targetI=best.i; v.thought='Foraging'; v._nextPathTick=tick+12; return true; } } return false; }
function goRest(v){ if(tick<v._nextPathTick) return false; const hut=findNearestBuilding(v.x|0,v.y|0,'hut')||buildings.find(b=>b.kind==='campfire'); if(hut){ const p=pathfind(v.x|0,v.y|0,hut.x,hut.y); if(p){ v.path=p; v.state='rest'; v.targetBuilding=hut; v.thought='Resting'; v._nextPathTick=tick+12; return true; } } return false; }
function findNearestBuilding(x,y,kind){ let best=null,bd=999; for(const b of buildings){ if(b.kind!==kind||b.built<1) continue; const d=Math.abs(b.x-x)+Math.abs(b.y-y); if(d<bd){bd=d; best=b;} } return best; }
function pickJobFor(v){ let best=null,bs=-1e9; for(const j of jobs){ if(j.assigned>=1 && j.type!=='build') continue; const i=idx(j.x,j.y); if(j.type==='chop'&&world.trees[i]===0) continue; if(j.type==='mine'&&world.rocks[i]===0) continue; if(j.type==='sow'&&world.tiles[i]===TILES.FARMLAND) continue; const d=Math.abs((v.x|0)-j.x)+Math.abs((v.y|0)-j.y); let s=(j.prio||0.5)-d*0.01; if(v.role==='farmer'&&(j.type==='sow'||j.type==='harvest')) s+=0.08; if(v.role==='worker'&&(j.type==='chop'||j.type==='mine'||j.type==='build')) s+=0.06; if(v.hunger>0.6&&(j.type==='sow'||j.type==='harvest')) s+=0.03; if(s>bs){ bs=s; best=j; } } return bs>0?best:null; }
function stepAlong(v){ const next=v.path[0]; if(!next) return; const speed=v.speed*SPEEDS[speedIdx]; const dx=next.x-v.x, dy=next.y-v.y, dist=Math.hypot(dx,dy), step=0.08*speed; if(dist<=step){ v.x=next.x; v.y=next.y; v.path.shift(); if(v.path.length===0) onArrive(v); } else { v.x+=(dx/dist)*step; v.y+=(dy/dist)*step; } }
function onArrive(v){ const cx=v.x|0, cy=v.y|0, i=idx(cx,cy); if(v.state==='chop'){ if(world.trees[i]>0){ world.trees[i]--; dropItem(cx,cy,ITEM.WOOD,1); if(world.trees[i]===0){ world.tiles[i]=TILES.GRASS; markStaticDirty(); } v.thought='Chopped'; } v.state='idle'; v.targetJob=null; }
else if(v.state==='mine'){ if(world.rocks[i]>0){ world.rocks[i]--; dropItem(cx,cy,ITEM.STONE,1); if(world.rocks[i]===0){ world.tiles[i]=TILES.GRASS; markStaticDirty(); } v.thought='Mined'; } v.state='idle'; v.targetJob=null; }
else if(v.state==='forage'){ if(world.berries[v.targetI]>0){ world.berries[v.targetI]--; v.inv={type:ITEM.FOOD,qty:1}; v.thought='Got berries'; } v.state='idle'; }
else if(v.state==='sow'){ if(world.tiles[i]!==TILES.WATER){ world.tiles[i]=TILES.FARMLAND; world.growth[i]=1; world.zone[i]=ZONES.FARM; markStaticDirty(); v.thought='Sowed'; } v.state='idle'; v.targetJob=null; }
else if(v.state==='harvest'){ dropItem(cx,cy,ITEM.FOOD,1); world.growth[i]=0; v.state='idle'; v.thought='Harvested'; }
else if(v.state==='build'){ const b=buildings.find(bb=>bb.id===v.targetJob?.bid); if(b){ const def=BUILDINGS[b.kind]; if(b.built<1){ const need=def.cost-(b.progress||0); let pulled=0; if(def.wood>0){ const take=Math.min(need,storageTotals.wood); storageTotals.wood-=take; pulled+=take; } if(def.stone>0){ const take=Math.min(need-pulled,storageTotals.stone); storageTotals.stone-=take; pulled+=take; } b.progress=(b.progress||0)+pulled; if(b.progress>=def.cost){ b.built=1; v.thought='Built'; } } } v.state='idle'; v.targetJob=null; }
else if(v.state==='to_storage'){ if(v.inv){ if(v.inv.type===ITEM.WOOD) storageTotals.wood+=v.inv.qty; if(v.inv.type===ITEM.STONE) storageTotals.stone+=v.inv.qty; if(v.inv.type===ITEM.FOOD) storageTotals.food+=v.inv.qty; v.inv=null; v.thought='Stored'; } v.state='idle'; }
else if(v.state==='rest'){ v.energy += 0.4; if(v.energy>1)v.energy=1; v.thought='Rested'; v.state='idle'; } }

/* ==================== Pathfinding ==================== */
function passable(x,y){ const i=idx(x,y); if(i<0) return false; return WALKABLE.has(world.tiles[i]); }
function pathfind(sx,sy,tx,ty,limit=400){
  const tStart = PERF.log ? performance.now() : 0;
  if(sx===tx&&sy===ty){
    if(PERF.log && (tick % 60) === 0) console.log(`pathfind 0.00ms`);
    return [{x:tx,y:ty}];
  }
  const Wm=MAP_W,Hm=MAP_H;
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
function seasonTick(){ world.tSeason++; const SEASON_LEN=60*10; if(world.tSeason>=SEASON_LEN){ world.tSeason=0; world.season=(world.season+1)%4; } for(let i=0;i<world.growth.length;i++){ if(world.tiles[i]===TILES.FARMLAND && world.growth[i]>0 && world.growth[i]<240){ world.growth[i]+=1; if(world.growth[i]===160){ const y=(i/MAP_W)|0, x=i%MAP_W; if(!jobs.some(j=>j.type==='harvest'&&j.x===x&&j.y===y)) addJob({type:'harvest',x,y, prio:0.65+priorities.food*0.6}); } } } }

/* ==================== Save/Load ==================== */
function saveGame(){ const data={ seed:world.seed, tiles:Array.from(world.tiles), zone:Array.from(world.zone), trees:Array.from(world.trees), rocks:Array.from(world.rocks), berries:Array.from(world.berries), growth:Array.from(world.growth), season:world.season, tSeason:world.tSeason, buildings, storageTotals, villagers: villagers.map(v=>({id:v.id,x:v.x,y:v.y,h:v.hunger,e:v.energy,ha:v.happy,role:v.role})) }; Storage.set('aiv_px_v3_save', JSON.stringify(data)); }
function loadGame(){ try{ const raw=Storage.get('aiv_px_v3_save'); if(!raw) return false; const d=JSON.parse(raw); newWorld(d.seed); world.tiles=Uint8Array.from(d.tiles); world.zone=Uint8Array.from(d.zone); world.trees=Uint8Array.from(d.trees); world.rocks=Uint8Array.from(d.rocks); world.berries=Uint8Array.from(d.berries); world.growth=Uint8Array.from(d.growth); world.season=d.season; world.tSeason=d.tSeason; buildings.length=0; d.buildings.forEach(b=>buildings.push(b)); storageTotals=d.storageTotals; villagers.length=0; d.villagers.forEach(v=>{ villagers.push({ id:v.id,x:v.x,y:v.y,path:[], hunger:v.h,energy:v.e,happy:v.ha,role:v.role,speed:2,inv:null,state:'idle',thought:'Resuming', _nextPathTick:0 }); }); Toast.show('Loaded.'); markStaticDirty(); return true; } catch(e){ console.error(e); return false; } }

/* ==================== Rendering ==================== */
let staticCanvas=null, staticCtx=null, staticDirty=true;
function markStaticDirty(){ staticDirty=true; }
function drawStatic(){ if(!staticCanvas){ staticCanvas=makeCanvas(MAP_W*TILE, MAP_H*TILE); staticCtx=staticCanvas.getContext('2d'); staticCtx.imageSmoothingEnabled=false; } const g=staticCtx;
  for(let y=0;y<MAP_H;y++){ for(let x=0;x<MAP_W;x++){ const i=y*MAP_W+x, t=world.tiles[i];
    let img=Tileset.base.grass; if(t===TILES.GRASS) img=Tileset.base.grass; else if(t===TILES.FERTILE) img=Tileset.base.fertile; else if(t===TILES.SAND) img=Tileset.base.sand; else if(t===TILES.SNOW) img=Tileset.base.snow; else if(t===TILES.ROCK) img=Tileset.base.rock; else if(t===TILES.WATER) img=Tileset.base.water; else if(t===TILES.FARMLAND) img=Tileset.base.farmland; g.drawImage(img,x*TILE,y*TILE);
  } } staticDirty=false; }

function drawTree(g){ g.fillStyle='#6b3f1f'; g.fillRect(14,20,4,6); g.fillStyle='#2c6b34'; g.fillRect(10,12,12,10); g.fillStyle='#2f7f3d'; g.fillRect(12,10,8,4); }
function drawBerry(g){ g.fillStyle='#2f6d36'; g.fillRect(8,16,16,10); g.fillStyle='#a04a5a'; g.fillRect(12,18,2,2); g.fillRect(18,20,2,2); g.fillRect(16,22,2,2); }

function visibleTileBounds(){
  const tileSize = TILE * cam.z;
  const x0 = Math.max(0, Math.floor(cam.x / tileSize));
  const y0 = Math.max(0, Math.floor(cam.y / tileSize));
  const x1 = Math.min(MAP_W-1, Math.ceil((cam.x + W) / tileSize));
  const y1 = Math.min(MAP_H-1, Math.ceil((cam.y + H) / tileSize));
  return {x0, y0, x1, y1};
}

function render(){
  if(staticDirty) drawStatic();
  ctx.imageSmoothingEnabled=false; ctx.fillStyle='#0a0c10'; ctx.fillRect(0,0,W,H);
  // base map scaled by cam.z
  ctx.drawImage(staticCanvas, 0,0, staticCanvas.width, staticCanvas.height, -cam.x, -cam.y, staticCanvas.width*cam.z, staticCanvas.height*cam.z);

  let t0,t1,t2;
  if(PERF.log) t0 = performance.now();

  const vis = visibleTileBounds();
  const x0=vis.x0, y0=vis.y0, x1=vis.x1, y1=vis.y1;

  // animated water overlay
  const frames = Tileset.waterOverlay || [];
  if(frames.length){
    const frame = Math.floor((tick/10)%frames.length);
    for(let y=y0;y<=y1;y++){ for(let x=x0;x<=x1;x++){ const i=y*MAP_W+x; if(world.tiles[i]===TILES.WATER){
      ctx.drawImage(frames[frame], 0,0,TILE,TILE, -cam.x+x*TILE*cam.z, -cam.y+y*TILE*cam.z, TILE*cam.z, TILE*cam.z);
    } } }
  }

  // zones glyphs and wash
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const i=y*MAP_W+x; const z=world.zone[i]; if(z===ZONES.NONE) continue;
      const wash = z===ZONES.FARM ? 'rgba(120,220,120,0.25)'
                 : z===ZONES.CUT  ? 'rgba(255,190,110,0.22)'
                 :                   'rgba(160,200,255,0.22)';
      ctx.fillStyle=wash;
      ctx.fillRect(-cam.x + x*TILE*cam.z, -cam.y + y*TILE*cam.z, TILE*cam.z, TILE*cam.z);
      const glyph = z===ZONES.FARM ? Tileset.zoneGlyphs.farm : z===ZONES.CUT ? Tileset.zoneGlyphs.cut : Tileset.zoneGlyphs.mine;
      ctx.globalAlpha=0.6;
      for(let yy=4; yy<TILE; yy+=10){ for(let xx=4; xx<TILE; xx+=10){
        ctx.drawImage(glyph, 0,0,8,8, -cam.x+x*TILE*cam.z+xx*cam.z, -cam.y+y*TILE*cam.z+yy*cam.z, 8*cam.z, 8*cam.z);
      } }
      ctx.globalAlpha=1;
    }
  }

  // vegetation/crops
  for(let y=y0;y<=y1;y++){ for(let x=x0;x<=x1;x++){ const i=y*MAP_W+x;
    if(world.tiles[i]===TILES.FOREST && world.trees[i]>0){ ctx.drawImage(Tileset.sprite.tree, -cam.x+x*TILE*cam.z, -cam.y+y*TILE*cam.z, TILE*cam.z, TILE*cam.z); }
    if(world.berries[i]>0){ ctx.drawImage(Tileset.sprite.berry, -cam.x+x*TILE*cam.z, -cam.y+y*TILE*cam.z, TILE*cam.z, TILE*cam.z); }
    if(world.tiles[i]===TILES.FARMLAND && world.growth[i]>0){ const stageIndex=Math.min(2, Math.floor(world.growth[i]/80)); ctx.drawImage(Tileset.sprite.sprout[stageIndex], -cam.x+x*TILE*cam.z, -cam.y+y*TILE*cam.z, TILE*cam.z, TILE*cam.z); }
  } }

  if(PERF.log) t1 = performance.now();

  // buildings
  for(const b of buildings){ const gx=-cam.x + b.x*TILE*cam.z, gy=-cam.y + b.y*TILE*cam.z; drawBuildingAt(gx,gy,b); }

  // items
  for(const it of itemsOnGround){ const gx=-cam.x+it.x*TILE*cam.z, gy=-cam.y+it.y*TILE*cam.z; ctx.fillStyle = it.type===ITEM.WOOD ? '#b48a52' : it.type===ITEM.STONE ? '#aeb7c3' : '#b6d97a'; ctx.fillRect(gx+TILE*cam.z*0.5-2*cam.z, gy+TILE*cam.z*0.5-2*cam.z, 4*cam.z, 4*cam.z); }

  // villagers
  for(const v of villagers){ drawVillager(v); }

  if(ui.mode==='zones' && brushPreview){
    const {x,y,r}=brushPreview;
    ctx.strokeStyle='rgba(124,196,255,0.9)';
    ctx.lineWidth=Math.max(1,1*cam.z);
    for(let yy=y-r; yy<=y+r; yy++){
      for(let xx=x-r; xx<=x+r; xx++){
        if(xx<0||yy<0||xx>=MAP_W||yy>=MAP_H) continue;
        const sx=-cam.x + xx*TILE*cam.z;
        const sy=-cam.y + yy*TILE*cam.z;
        ctx.strokeRect(sx+1, sy+1, TILE*cam.z-2, TILE*cam.z-2);
      }
    }
  }

  // day/night tint (screen space)
  const t=dayTime/DAY_LEN; let night=(Math.cos((t*2*Math.PI))+1)/2; ctx.fillStyle=`rgba(10,18,30, ${0.25*night})`; ctx.fillRect(0,0,W,H);

  // campfire glow (screen space but positioned via cam)
  for(const b of buildings){ if(b.kind==='campfire'){ const gx=-cam.x+b.x*TILE*cam.z+TILE*cam.z/2, gy=-cam.y+b.y*TILE*cam.z+TILE*cam.z/2; const r= (24+4*Math.sin(tick*0.2))*cam.z; const grd=ctx.createRadialGradient(gx,gy,4*cam.z, gx,gy,r); grd.addColorStop(0,'rgba(255,180,90,0.35)'); grd.addColorStop(1,'rgba(255,120,60,0)'); ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(gx,gy,r,0,Math.PI*2); ctx.fill(); } }

  // HUD counters
  el('food').textContent=storageTotals.food|0; el('wood').textContent=storageTotals.wood|0; el('stone').textContent=storageTotals.stone|0; el('pop').textContent=villagers.length|0;
  if(PERF.log){
    t2 = performance.now();
    if((tick % 60) === 0) console.log(`render: overlays ${(t1-t0).toFixed(2)}ms, total ${(t2-t0).toFixed(2)}ms`);
  }
}

function drawBuildingAt(gx,gy,b){
  const g=ctx, s=cam.z;
  if(b.kind==='campfire'){ g.fillStyle='#7b8591'; g.fillRect(gx+10*s,gy+18*s,12*s,6*s); const f=(tick%6); g.fillStyle=['#ffde7a','#ffc05a','#ff9b4a'][f%3]; g.fillRect(gx+14*s,gy+12*s,4*s,6*s);
  } else if(b.kind==='storage'){ g.fillStyle='#6a5338'; g.fillRect(gx+6*s,gy+10*s,20*s,14*s); g.fillStyle='#8b6b44'; g.fillRect(gx+6*s,gy+20*s,20*s,2*s); g.fillStyle='#3b2b1a'; g.fillRect(gx+6*s,gy+10*s,20*s,1*s);
  } else if(b.kind==='hut'){ g.fillStyle='#7d5a3a'; g.fillRect(gx+8*s,gy+16*s,16*s,12*s); g.fillStyle='#caa56a'; g.fillRect(gx+6*s,gy+12*s,20*s,6*s); g.fillStyle='#31251a'; g.fillRect(gx+14*s,gy+20*s,4*s,8*s);
  } else if(b.kind==='farmplot'){ g.fillStyle='#4a3624'; g.fillRect(gx+4*s,gy+8*s,24*s,16*s); g.fillStyle='#3b2a1d'; g.fillRect(gx+4*s,gy+12*s,24*s,2*s); g.fillRect(gx+4*s,gy+16*s,24*s,2*s); g.fillRect(gx+4*s,gy+20*s,24*s,2*s);
  } else if(b.kind==='well'){ g.fillStyle='#6f8696'; g.fillRect(gx+10*s,gy+14*s,12*s,10*s); g.fillStyle='#2b3744'; g.fillRect(gx+12*s,gy+18*s,8*s,6*s); g.fillStyle='#927a54'; g.fillRect(gx+8*s,gy+12*s,16*s,2*s); }
  if(b.built<1){ g.strokeStyle='rgba(255,255,255,0.6)'; g.strokeRect(gx+4*s,gy+4*s,24*s,24*s); const p=(b.progress||0)/(BUILDINGS[b.kind].cost||1); g.fillStyle='#7cc4ff'; g.fillRect(gx+6*s,gy+28*s, Math.floor(20*p)*s, 2*s); }
}

function drawVillager(v){
  const frames = v.role==='farmer'? Tileset.villagerSprites.farmer : v.role==='worker'? Tileset.villagerSprites.worker : v.role==='explorer'? Tileset.villagerSprites.explorer : Tileset.villagerSprites.sleepy;
  const f=frames[Math.floor((tick/8)%3)], s=cam.z;
  const gx=-cam.x+v.x*TILE*cam.z + 8*s, gy=-cam.y+v.y*TILE*cam.z + 8*s;
  ctx.drawImage(f, 0,0,16,16, gx, gy, 16*s, 16*s);
  if(v.inv){ ctx.fillStyle=v.inv.type===ITEM.WOOD?'#b48a52':v.inv.type===ITEM.STONE?'#aeb7c3':'#b6d97a'; ctx.fillRect(gx+12*s, gy+2*s, 3*s, 3*s); }
}

/* ==================== Items & Loop ==================== */
function dropItem(x,y,type,qty){ itemsOnGround.push({x,y,type,qty}); }
let last=performance.now(), acc=0; const TICK_MS=1000/6;
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
