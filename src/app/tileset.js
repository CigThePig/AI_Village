import { ENTITY_TILE_PX, TILE } from './constants.js';
import { context2d } from './canvas.js';
import { irnd } from './rng.js';

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

function drawTree(g){ g.fillStyle='#6b3f1f'; g.fillRect(14,20,4,6); g.fillStyle='#2c6b34'; g.fillRect(10,12,12,10); g.fillStyle='#2f7f3d'; g.fillRect(12,10,8,4); }
function drawBerry(g){ g.fillStyle='#2f6d36'; g.fillRect(8,16,16,10); g.fillStyle='#a04a5a'; g.fillRect(12,18,2,2); g.fillRect(18,20,2,2); g.fillRect(16,22,2,2); }
function drawDeer(g){ g.fillStyle='#8b5e3c'; g.fillRect(10,14,10,10); g.fillRect(8,16,2,8); g.fillRect(20,16,2,8); g.fillRect(10,12,6,4); g.fillRect(14,10,2,4); g.fillRect(10,10,2,2); }
function drawBoar(g){ g.fillStyle='#5a3a2a'; g.fillRect(10,16,12,10); g.fillRect(8,18,2,8); g.fillRect(22,18,2,8); g.fillRect(12,12,6,4); g.fillRect(10,14,2,2); }

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

export { Tileset, SHADOW_TEXTURE, buildTileset, makeCanvas, px, rect };
