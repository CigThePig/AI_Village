import {
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
  baseVisibleTileBounds,
  tileToPxX,
  tileToPxY
} from './constants.js';
import { LIGHTING, clamp01 } from './lighting.js';
import { clamp } from './rng.js';
import { context2d } from './canvas.js';
import { SHADOW_TEXTURE, Tileset, makeCanvas } from './tileset.js';
import {
  BUILDINGS,
  buildingCenter,
  getFootprint
} from './world.js';
import { isNightAmbient } from './simulation.js';

export function createRenderSystem(deps) {
  const {
    getCam,
    getViewportW,
    getViewportH,
    getCtx,
    getWorld,
    getBuildings,
    getVillagers,
    getAnimals,
    getItemsOnGround,
    getVillagerLabels,
    getActiveZoneJobs,
    getBuildingsByKind,
    getStorageTotals,
    getTick,
    getDayTime,
    getEmittersDirty,
    setEmittersClean,
    ambientAt,
    drawNocturnalEntities,
    normalizeShadingMode,
    zoneHasWorkNow,
    zoneJobType,
    policy,
    el,
    ensureVillagerNumber,
    perf
  } = deps;

  const lightmapCacheState = {
    ambient: null,
    mode: null,
    scale: null,
    emitterSignature: null
  };

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
  let staticAlbedoCanvas = null;
  let staticAlbedoCtx = null;
  let staticDirty = true;

  function markStaticDirty() { staticDirty = true; }
  function markZoneOverlayDirty() { zoneOverlayCache.dirty = true; }

  function ensureRowMasksSize() {
    if (waterRowMask.length !== GRID_H) waterRowMask = new Uint8Array(GRID_H);
    if (zoneRowMask.length !== GRID_H) zoneRowMask = new Uint8Array(GRID_H);
  }

  function resetOverlayCaches() {
    waterRowMask = new Uint8Array(GRID_H);
    zoneRowMask = new Uint8Array(GRID_H);
    markZoneOverlayDirty();
  }

  function refreshWaterRowMaskFromTiles() {
    const world = getWorld();
    if (!world) return;
    ensureRowMasksSize();
    waterRowMask.fill(0);
    for (let y = 0; y < GRID_H; y++) {
      const rowStart = y * GRID_W;
      for (let x = 0; x < GRID_W; x++) {
        if (world.tiles[rowStart + x] === TILES.WATER) {
          waterRowMask[y] = 1;
          break;
        }
      }
    }
  }

  function refreshZoneRowMask() {
    const world = getWorld();
    if (!world) return;
    ensureRowMasksSize();
    zoneRowMask.fill(0);
    for (let y = 0; y < GRID_H; y++) {
      const rowStart = y * GRID_W;
      for (let x = 0; x < GRID_W; x++) {
        if (world.zone[rowStart + x] !== ZONES.NONE) {
          zoneRowMask[y] = 1;
          break;
        }
      }
    }
    markZoneOverlayDirty();
  }

  function updateZoneRow(y) {
    const world = getWorld();
    if (!world) return;
    ensureRowMasksSize();
    if (y < 0 || y >= GRID_H) return;
    const rowStart = y * GRID_W;
    let hasZone = 0;
    for (let x = 0; x < GRID_W; x++) {
      if (world.zone[rowStart + x] !== ZONES.NONE) {
        hasZone = 1;
        break;
      }
    }
    if (zoneRowMask[y] !== hasZone) markZoneOverlayDirty();
    zoneRowMask[y] = hasZone;
  }

  function noteZoneTileSown(_cx, cy) {
    ensureRowMasksSize();
    if (cy < 0 || cy >= GRID_H) return;
    zoneRowMask[cy] = 1;
  }

  function resetLightmapCache() {
    lightmapCacheState.ambient = null;
    lightmapCacheState.mode = null;
    lightmapCacheState.scale = null;
    lightmapCacheState.emitterSignature = null;
  }

  let currentAmbient = 1;
  function setCurrentAmbient(value) {
    currentAmbient = Number.isFinite(value) ? value : 1;
  }

  function applyNightColorShift(r, g, b, normalized) {
    const nightStrength = clamp01(1 - currentAmbient);
    if (nightStrength <= 0) return [r, g, b];

    const desaturate = 0.18 * nightStrength;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = r * (1 - desaturate) + luma * desaturate;
    g = g * (1 - desaturate) + luma * desaturate;
    b = b * (1 - desaturate) + luma * desaturate;

    const blueLift = 1 + 0.10 * nightStrength;
    const redDampen = 1 - 0.06 * nightStrength;
    const greenDampen = 1 - 0.03 * nightStrength;
    r *= redDampen;
    g *= greenDampen;
    b *= blueLift;

    const visibilityLift = 8 * nightStrength * (1 - normalized);
    r += visibilityLift;
    g += visibilityLift;
    b += visibilityLift;

    return [
      clamp(Math.round(r), 0, 255),
      clamp(Math.round(g), 0, 255),
      clamp(Math.round(b), 0, 255)
    ];
  }

  function shadeFillColor(color, shade) {
    const normalized = clamp01(shade);
    if (normalized >= 0.999 || typeof color !== 'string') return color;
    if (color[0] === '#') {
      let r, g, b;
      if (color.length === 4) {
        r = parseInt(color[1] + color[1], 16);
        g = parseInt(color[2] + color[2], 16);
        b = parseInt(color[3] + color[3], 16);
      } else if (color.length === 7) {
        r = parseInt(color.slice(1, 3), 16);
        g = parseInt(color.slice(3, 5), 16);
        b = parseInt(color.slice(5, 7), 16);
      } else {
        return color;
      }
      const scale = (component) => clamp(Math.round(component * normalized), 0, 255);
      [r, g, b] = applyNightColorShift(scale(r), scale(g), scale(b), normalized);
      return `rgb(${r},${g},${b})`;
    }
    const rgbaMatch = color.match(/^rgba?\(([^)]+)\)$/i);
    if (rgbaMatch) {
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
      const scaleFn = (component) => clamp(Math.round(clamp(component, 0, 255) * normalized), 0, 255);
      let [r, g, b] = [scaleFn(baseR), scaleFn(baseG), scaleFn(baseB)];
      [r, g, b] = applyNightColorShift(r, g, b, normalized);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
  }

  function applySpriteShade(context, x, y, w, h, shade) {
    const normalized = clamp01(shade);
    const overlay = 1 - normalized;
    if (overlay <= 0) return;
    context.save();
    context.globalCompositeOperation = 'multiply';
    context.fillStyle = `rgba(0,0,0,${overlay})`;
    context.fillRect(x, y, w, h);
    context.restore();
  }

  function shadeFillColorLit(rgbaString, light) {
    const L = Math.max(0, Math.min(LIGHTING.lightCap, light));
    const normalized = L >= 1 ? 1 : L;
    return shadeFillColor(rgbaString, normalized);
  }

  function applySpriteShadeLit(context, x, y, w, h, light) {
    const L = Math.max(0, Math.min(LIGHTING.lightCap, light));
    const normalized = L >= 1 ? 1 : L;
    return applySpriteShade(context, x, y, w, h, normalized);
  }

  function entityDrawRect(tileX, tileY, cam) {
    const baseX = tileToPxX(tileX, cam);
    const baseY = tileToPxY(tileY, cam);
    const offset = Math.floor((ENTITY_TILE_PX - TILE) * cam.z * 0.5);
    const size = ENTITY_TILE_PX * cam.z;
    return { x: baseX - offset, y: baseY - offset, size };
  }

  function visibleTileBounds() {
    const cam = getCam();
    const W = getViewportW();
    const H = getViewportH();
    const raw = baseVisibleTileBounds(W, H, cam);
    const x0 = Math.max(0, raw.x0);
    const y0 = Math.max(0, raw.y0);
    const x1 = Math.min(GRID_W - 1, raw.x1);
    const y1 = Math.min(GRID_H - 1, raw.y1);
    return { x0, y0, x1, y1 };
  }

  function emittersSignature(list) {
    if (!Array.isArray(list) || list.length === 0) return 'none';
    const round = (v, places = 3) => {
      const factor = Math.pow(10, places);
      return Math.round((Number.isFinite(v) ? v : 0) * factor) / factor;
    };
    return list.map(e => {
      if (!e) return 'x';
      return [round(e.x, 2), round(e.y, 2), round(e.radius, 2), round(e.intensity, 3), round(e.falloff, 2)].join(':');
    }).join('|');
  }

  function buildHillshadeQ(targetWorld) {
    if (!targetWorld) return;
    const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
    const width = Math.max(1, (targetWorld.width | 0) || GRID_W);
    const height = Math.max(1, (targetWorld.height | 0) || GRID_H);
    const qw = Math.max(1, Math.floor(width * scale));
    const qh = Math.max(1, Math.floor(height * scale));
    const source = targetWorld.hillshade;
    if (source && source.length === width * height) {
      const downsampled = new Float32Array(qw * qh);
      for (let qy = 0; qy < qh; qy++) {
        const y = Math.min(height - 1, Math.floor(qy / scale));
        const srcRow = y * width;
        const row = qy * qw;
        for (let qx = 0; qx < qw; qx++) {
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
    if (!canvas || canvas.width !== qw || canvas.height !== qh) {
      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(qw, qh);
      } else {
        canvas = makeCanvas(qw, qh);
      }
    }
    canvas.width = qw;
    canvas.height = qh;
    targetWorld.lightmapCanvas = canvas;

    let ctx = targetWorld.lightmapCtx;
    if (!ctx || ctx.canvas !== canvas) {
      ctx = context2d(canvas, { alpha: false });
    }
    targetWorld.lightmapCtx = ctx || null;
    if (ctx) {
      if (!targetWorld.lightmapImageData || targetWorld.lightmapImageData.width !== qw || targetWorld.lightmapImageData.height !== qh) {
        targetWorld.lightmapImageData = ctx.createImageData(qw, qh);
      }
    } else {
      targetWorld.lightmapImageData = null;
    }
    resetLightmapCache();
  }

  function buildLightmap(targetWorld, ambient) {
    if (!targetWorld || !targetWorld.lightmapQ || !targetWorld.lightmapCanvas) return;
    const Lq = targetWorld.lightmapQ;
    const Hq = (LIGHTING.mode === 'hillshade') ? targetWorld.hillshadeQ : null;
    const length = Lq.length;
    const cap = Number.isFinite(LIGHTING.lightCap) ? LIGHTING.lightCap : 1.0;
    for (let i = 0; i < length; i++) {
      const base = ambient * (Hq ? Hq[i] : 1);
      Lq[i] = base > cap ? cap : base;
    }

    const emitters = Array.isArray(targetWorld.emitters) ? targetWorld.emitters : [];
    const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
    const qw = targetWorld.lightmapCanvas.width | 0;
    const qh = targetWorld.lightmapCanvas.height | 0;

    const addLight = (cx, cy, radiusTiles, intensity, falloff) => {
      if (!Number.isFinite(intensity) || intensity === 0) return;
      const r = Math.max(1, Math.floor(radiusTiles * scale));
      const r2 = r * r;
      const exponent = Math.max(0.1, Number.isFinite(falloff) ? falloff : 2);
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= qh) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= qw) continue;
          const d2 = dx * dx + dy * dy;
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

    for (const emitter of emitters) {
      if (!emitter) continue;
      const cx = Math.round((Number.isFinite(emitter.x) ? emitter.x : 0) * scale);
      const cy = Math.round((Number.isFinite(emitter.y) ? emitter.y : 0) * scale);
      const radius = Number.isFinite(emitter.radius) ? emitter.radius : 0;
      if (!(radius > 0)) continue;
      let intensity = Number.isFinite(emitter.intensity) ? emitter.intensity : 0;
      if (emitter.flicker) {
        intensity *= (1 + 0.05 * Math.sin(targetWorld.dayTime || 0) + (Math.random() * 0.03));
      }
      addLight(cx, cy, radius, intensity, emitter.falloff);
    }

    if (LIGHTING.softLights) {
      for (let y = 1; y < qh - 1; y++) {
        const row = y * qw;
        for (let x = 1; x < qw - 1; x++) {
          const i = row + x;
          Lq[i] = (Lq[i] + Lq[i - 1] + Lq[i + 1] + Lq[i - qw] + Lq[i + qw]) / 5;
        }
      }
    }

    const ctx = targetWorld.lightmapCtx;
    if (!ctx) return;
    let img = targetWorld.lightmapImageData;
    if (!img || img.width !== qw || img.height !== qh) {
      img = ctx.createImageData(qw, qh);
      targetWorld.lightmapImageData = img;
    }
    const data = img.data;
    for (let i = 0, p = 0; i < length; i++, p += 4) {
      const v = Math.max(0, Math.min(1, Lq[i]));
      const b = Math.round(v * 255);
      data[p] = data[p + 1] = data[p + 2] = b;
      data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function sampleLightAt(targetWorld, wx, wy) {
    if (!targetWorld || !targetWorld.lightmapQ || !targetWorld.lightmapCanvas) return 1.0;
    const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
    const x = wx * scale;
    const y = wy * scale;
    const qw = targetWorld.lightmapCanvas.width | 0;
    const qh = targetWorld.lightmapCanvas.height | 0;
    const Lq = targetWorld.lightmapQ;
    if (!qw || !qh || !Lq || Lq.length === 0) return 1.0;

    const x0 = Math.max(0, Math.min(qw - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(qh - 1, Math.floor(y)));
    const x1 = Math.max(0, Math.min(qw - 1, x0 + 1));
    const y1 = Math.max(0, Math.min(qh - 1, y0 + 1));
    const fx = x - x0;
    const fy = y - y0;
    const i00 = y0 * qw + x0;
    const i10 = y0 * qw + x1;
    const i01 = y1 * qw + x0;
    const i11 = y1 * qw + x1;
    const v00 = Lq[i00];
    const v10 = Lq[i10];
    const v01 = Lq[i01];
    const v11 = Lq[i11];
    const top = v00 * (1 - fx) + v10 * fx;
    const bot = v01 * (1 - fx) + v11 * fx;
    return top * (1 - fy) + bot * fy;
  }

  function ensureLightmapBuffers(targetWorld) {
    if (!targetWorld) return false;
    const scale = Math.max(0.01, Number.isFinite(LIGHTING.lightmapScale) ? LIGHTING.lightmapScale : 0.25);
    const expectedW = Math.max(1, Math.floor(((targetWorld.width || GRID_W)) * scale));
    const expectedH = Math.max(1, Math.floor(((targetWorld.height || GRID_H)) * scale));
    const missingQ = !targetWorld.lightmapQ || (!targetWorld.hillshadeQ && LIGHTING.mode === 'hillshade');
    if (!targetWorld.lightmapCanvas || targetWorld.lightmapCanvas.width !== expectedW || targetWorld.lightmapCanvas.height !== expectedH || missingQ) {
      buildHillshadeQ(targetWorld);
    }
    return Boolean(targetWorld.lightmapCanvas && targetWorld.lightmapQ);
  }

  function maybeBuildLightmap(targetWorld, ambient, normalizeShadingMode) {
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

  function drawStaticAlbedo() {
    const world = getWorld();
    if (!world) return;
    if (!staticAlbedoCanvas) {
      staticAlbedoCanvas = makeCanvas(GRID_W * TILE, GRID_H * TILE);
      staticAlbedoCtx = context2d(staticAlbedoCanvas);
    }
    const g = staticAlbedoCtx;
    if (!g) return;
    ensureRowMasksSize();
    for (let y = 0; y < GRID_H; y++) {
      let rowHasWater = 0;
      const rowStart = y * GRID_W;
      for (let x = 0; x < GRID_W; x++) {
        const i = rowStart + x;
        const t = world.tiles[i];
        let img = Tileset.base.grass;
        if (t === TILES.GRASS) img = Tileset.base.grass;
        else if (t === TILES.FERTILE) img = Tileset.base.fertile;
        else if (t === TILES.MEADOW) img = Tileset.base.meadow;
        else if (t === TILES.MARSH) img = Tileset.base.marsh;
        else if (t === TILES.SAND) img = Tileset.base.sand;
        else if (t === TILES.SNOW) img = Tileset.base.snow;
        else if (t === TILES.ROCK) img = Tileset.base.rock;
        else if (t === TILES.WATER) img = Tileset.base.water;
        else if (t === TILES.FARMLAND) img = Tileset.base.farmland;
        g.drawImage(img, x * TILE, y * TILE);
        if (t === TILES.WATER) rowHasWater = 1;
      }
      waterRowMask[y] = rowHasWater;
    }
    world.staticAlbedoCanvas = staticAlbedoCanvas;
    world.staticAlbedoCtx = staticAlbedoCtx;
    staticDirty = false;
  }

  function ensureZoneOverlayCanvas() {
    const width = GRID_W * TILE;
    const height = GRID_H * TILE;
    let canvas = zoneOverlayCache.canvas;
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : makeCanvas(width, height);
      zoneOverlayCache.canvas = canvas;
      zoneOverlayCache.ctx = context2d(canvas);
      zoneOverlayCache.dirty = true;
    }
    return zoneOverlayCache.canvas && zoneOverlayCache.ctx;
  }

  function activeZoneSignature(activeZoneJobs) {
    const parts = [];
    for (const key of ['sow', 'chop', 'mine']) {
      const sorted = Array.from(activeZoneJobs[key] || []).sort((a, b) => a - b);
      parts.push(`${key}:${sorted.join(',')}`);
    }
    return parts.join('|');
  }

  function rebuildZoneOverlay(activeZoneJobs) {
    if (!ensureZoneOverlayCanvas()) return;
    const world = getWorld();
    if (!world) return;
    const g = zoneOverlayCache.ctx;
    const canvas = zoneOverlayCache.canvas;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const tileSize = TILE;
    const active = {
      sow: activeZoneJobs.sow || new Set(),
      chop: activeZoneJobs.chop || new Set(),
      mine: activeZoneJobs.mine || new Set()
    };
    for (let y = 0; y < GRID_H; y++) {
      if (!zoneRowMask[y]) continue;
      const rowStart = y * GRID_W;
      for (let x = 0; x < GRID_W; x++) {
        const i = rowStart + x;
        const z = world.zone[i];
        if (z === ZONES.NONE) continue;
        if (!zoneHasWorkNow(z, i)) continue;
        const jobType = zoneJobType(z);
        if (jobType) {
          const activeSet = active[jobType];
          if (activeSet && activeSet.has(i)) continue;
        }
        const wash = z === ZONES.FARM ? 'rgba(120,220,120,0.25)'
                   : z === ZONES.CUT ? 'rgba(255,190,110,0.22)'
                   :                   'rgba(160,200,255,0.22)';
        g.fillStyle = wash;
        const px = x * tileSize;
        const py = y * tileSize;
        g.fillRect(px, py, tileSize, tileSize);
        const glyph = z === ZONES.FARM ? Tileset.zoneGlyphs.farm : z === ZONES.CUT ? Tileset.zoneGlyphs.cut : Tileset.zoneGlyphs.mine;
        g.globalAlpha = 0.6;
        for (let yy = 4; yy < TILE; yy += 10) {
          for (let xx = 4; xx < TILE; xx += 10) {
            g.drawImage(glyph, 0, 0, 8, 8, px + xx, py + yy, 8, 8);
          }
        }
        g.globalAlpha = 1;
      }
    }
  }

  function drawZoneOverlay(activeZoneJobs, camState, baseDx, baseDy) {
    const ctx = getCtx();
    if (!ctx) return;
    const signature = activeZoneSignature(activeZoneJobs);
    if (zoneOverlayCache.lastActiveSignature !== signature) {
      zoneOverlayCache.lastActiveSignature = signature;
      zoneOverlayCache.dirty = true;
    }
    if (zoneOverlayCache.lastScale !== camState.z) {
      zoneOverlayCache.lastScale = camState.z;
      zoneOverlayCache.dirty = true;
    }
    if (zoneOverlayCache.dirty) {
      rebuildZoneOverlay(activeZoneJobs);
      zoneOverlayCache.dirty = false;
    }
    const canvas = zoneOverlayCache.canvas;
    if (!canvas) return;
    const destW = canvas.width * camState.z;
    const destH = canvas.height * camState.z;
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, baseDx, baseDy, destW, destH);
  }

  function ensureWaterOverlayCanvas() {
    const W = getViewportW();
    const H = getViewportH();
    const sizeChanged = !waterOverlayCache.canvas || waterOverlayCache.width !== W || waterOverlayCache.height !== H;
    if (!sizeChanged && waterOverlayCache.canvas) return true;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : makeCanvas(W, H);
    waterOverlayCache.canvas = canvas;
    waterOverlayCache.ctx = context2d(canvas, { alpha: true });
    waterOverlayCache.width = W;
    waterOverlayCache.height = H;
    waterOverlayCache.frameIndex = -1;
    return Boolean(waterOverlayCache.canvas && waterOverlayCache.ctx);
  }

  function drawWaterOverlay(frames, frameIndex, vis) {
    if (!frames.length || !ensureWaterOverlayCanvas()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const world = getWorld();
    if (!world) return;
    const cam = getCam();
    const W = getViewportW();
    const H = getViewportH();
    const needsRedraw = waterOverlayCache.frameIndex !== frameIndex
      || waterOverlayCache.camX !== cam.x
      || waterOverlayCache.camY !== cam.y
      || waterOverlayCache.camZ !== cam.z
      || waterOverlayCache.width !== W
      || waterOverlayCache.height !== H;
    if (needsRedraw) {
      const g = waterOverlayCache.ctx;
      g.clearRect(0, 0, waterOverlayCache.width, waterOverlayCache.height);
      for (let y = vis.y0; y <= vis.y1; y++) {
        if (!waterRowMask[y]) continue;
        const rowStart = y * GRID_W;
        for (let x = vis.x0; x <= vis.x1; x++) {
          const i = rowStart + x;
          if (world.tiles[i] === TILES.WATER) {
            const px = tileToPxX(x, cam);
            const py = tileToPxY(y, cam);
            g.drawImage(frames[frameIndex], 0, 0, TILE, TILE, px, py, TILE * cam.z, TILE * cam.z);
          }
        }
      }
      waterOverlayCache.frameIndex = frameIndex;
      waterOverlayCache.camX = cam.x;
      waterOverlayCache.camY = cam.y;
      waterOverlayCache.camZ = cam.z;
    }
    ctx.drawImage(waterOverlayCache.canvas, 0, 0);
  }

  function drawShadow(tileX, tileY, footprintW = 1, footprintH = 1, screenRect = null) {
    const ctx = getCtx();
    const world = getWorld();
    if (!ctx || !world || !world.tiles) return;
    if (!SHADOW_TEXTURE) return;
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return;
    if (LIGHTING.mode === 'off') return;

    const tiles = world.tiles;
    if (!tiles || tiles.length !== GRID_SIZE) return;

    const cam = getCam();
    const safeFootprintW = Number.isFinite(footprintW) && footprintW > 0 ? footprintW : 1;
    const safeFootprintH = Number.isFinite(footprintH) && footprintH > 0 ? footprintH : 1;

    const startX = Math.floor(tileX);
    const startY = Math.floor(tileY);
    const tilesWide = Math.max(1, Math.ceil(safeFootprintW));
    const tilesHigh = Math.max(1, Math.ceil(safeFootprintH));
    let hasGround = false;
    for (let oy = 0; oy < tilesHigh; oy++) {
      const ty = startY + oy;
      if (ty < 0 || ty >= GRID_H) continue;
      const rowStart = ty * GRID_W;
      for (let ox = 0; ox < tilesWide; ox++) {
        const tx = startX + ox;
        if (tx < 0 || tx >= GRID_W) continue;
        hasGround = true;
        if (tiles[rowStart + tx] === TILES.WATER) {
          return;
        }
      }
    }
    if (!hasGround) return;

    const centerTileX = tileX + safeFootprintW * 0.5;
    const centerTileY = tileY + safeFootprintH * 0.5;

    let widthPx = TILE * cam.z * safeFootprintW;
    let heightPx = TILE * cam.z * safeFootprintH;
    if (screenRect && Number.isFinite(screenRect.w) && Number.isFinite(screenRect.h)) {
      widthPx = Math.max(screenRect.w, 0);
      heightPx = Math.max(screenRect.h, 0);
    }

    let baseCenterX = tileToPxX(centerTileX, cam);
    let baseCenterY = tileToPxY(centerTileY, cam);
    if (screenRect && Number.isFinite(screenRect.x) && Number.isFinite(screenRect.y)) {
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
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = alpha;
    ctx.translate(centerX, centerY);
    ctx.rotate(SHADOW_DIRECTION_ANGLE);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(SHADOW_TEXTURE, -radiusX, -radiusY, radiusX * 2, radiusY * 2);
    ctx.restore();
    ctx.imageSmoothingEnabled = prevSmoothing;
  }

  function drawBuildingAt(gx, gy, b) {
    const ctx = getCtx();
    const world = getWorld();
    if (!ctx || !world) return;
    const cam = getCam();
    const tick = getTick();
    const storageTotals = getStorageTotals ? getStorageTotals() : null;
    const g = ctx;
    const s = cam.z;
    const fp = getFootprint(b.kind);
    const center = buildingCenter(b);
    const def = BUILDINGS[b.kind] || {};
    const activity = b.activity || {};
    const useAgo = Math.max(0, tick - (activity.lastUse || 0));
    const hydrateAgo = Math.max(0, tick - (activity.lastHydrate || 0));
    const socialAgo = Math.max(0, tick - (activity.lastSocial || 0));
    const restAgo = Math.max(0, tick - (activity.lastRest || 0));
    const recentUse = Math.max(0, 1 - useAgo / 360);
    const hydratePulse = Math.max(0, 1 - hydrateAgo / 260);
    const socialPulse = Math.max(0, 1 - socialAgo / 260);
    const restPulse = Math.max(0, 1 - restAgo / 260);
    const occupantPulse = Math.min(1, (activity.occupants || 0) * 0.4);
    const activityPulse = Math.max(recentUse, hydratePulse, socialPulse, restPulse, occupantPulse);
    const useMultiply = LIGHTING.useMultiplyComposite && LIGHTING.mode !== 'off';
    const sampledLight = useMultiply ? 1 : sampleLightAt(world, center.x, center.y);
    const shade = b.kind === 'farmplot' ? 1 : sampledLight;
    const campfireShade = b.kind === 'campfire' ? Math.max(shade, 0.95) : shade;
    drawShadow(b.x, b.y, fp.w, fp.h);
    const offsetX = Math.floor((ENTITY_TILE_PX - fp.w * TILE) * s * 0.5);
    const offsetY = Math.floor((ENTITY_TILE_PX - fp.h * TILE) * s * 0.5);
    gx -= offsetX;
    gy -= offsetY;
    g.save();
    if (b.kind === 'campfire') {
      g.fillStyle = shadeFillColorLit('#7b8591', campfireShade);
      g.fillRect(gx + 10 * s, gy + 18 * s, 12 * s, 6 * s);
      const f = (tick % 6);
      const flameColor = ['#ffde7a', '#ffc05a', '#ff9b4a'][f % 3];
      const flameH = 6 * s * (1 + activityPulse * 0.8);
      g.fillStyle = shadeFillColorLit(flameColor, campfireShade);
      g.fillRect(gx + 14 * s, gy + 12 * s, 4 * s, flameH);
      g.globalAlpha = 0.35 + activityPulse * 0.25;
      g.fillStyle = shadeFillColorLit('rgba(142,142,142,0.75)', campfireShade);
      g.beginPath();
      g.arc(gx + 16 * s, gy + (10 - f) * s, 3 * s + activityPulse * 3 * s, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    } else if (b.kind === 'storage') {
      g.fillStyle = shadeFillColorLit('#6a5338', shade);
      g.fillRect(gx + 6 * s, gy + 10 * s, 20 * s, 14 * s);
      g.fillStyle = shadeFillColorLit('#8b6b44', shade);
      g.fillRect(gx + 6 * s, gy + 20 * s, 20 * s, 2 * s);
      g.fillStyle = shadeFillColorLit('#3b2b1a', shade);
      g.fillRect(gx + 6 * s, gy + 10 * s, 20 * s, 1 * s);
      const totals = storageTotals || { food: 0, wood: 0, stone: 0 };
      const storedLevel = Math.min(1, (totals.food * 0.5 + totals.wood * 0.35 + totals.stone * 0.35) / 40);
      if (storedLevel > 0.02) {
        const fillH = Math.max(2 * s, Math.floor(12 * storedLevel) * s);
        g.fillStyle = shadeFillColorLit('rgba(152,118,76,0.9)', shade);
        g.fillRect(gx + 8 * s, gy + 10 * s + (12 * s - fillH), 16 * s, fillH);
      }
    } else if (b.kind === 'hut') {
      g.fillStyle = shadeFillColorLit('#7d5a3a', shade);
      g.fillRect(gx + 8 * s, gy + 16 * s, 16 * s, 12 * s);
      g.fillStyle = shadeFillColorLit('#caa56a', shade);
      g.fillRect(gx + 6 * s, gy + 12 * s, 20 * s, 6 * s);
      g.fillStyle = shadeFillColorLit('#31251a', shade);
      g.fillRect(gx + 14 * s, gy + 20 * s, 4 * s, 8 * s);
      if (activityPulse > 0.05) {
        const glowAlpha = Math.min(0.55, 0.25 + activityPulse * 0.5);
        g.fillStyle = shadeFillColorLit(`rgba(255,215,128,${glowAlpha})`, shade);
        g.fillRect(gx + 10 * s, gy + 18 * s, 4 * s, 4 * s);
        g.fillRect(gx + 16 * s, gy + 18 * s, 4 * s, 4 * s);
      }
    } else if (b.kind === 'farmplot') {
      g.fillStyle = shadeFillColorLit('#4a3624', shade);
      g.fillRect(gx + 4 * s, gy + 8 * s, 24 * s, 16 * s);
      g.fillStyle = shadeFillColorLit('#3b2a1d', shade);
      g.fillRect(gx + 4 * s, gy + 12 * s, 24 * s, 2 * s);
      g.fillRect(gx + 4 * s, gy + 16 * s, 24 * s, 2 * s);
      g.fillRect(gx + 4 * s, gy + 20 * s, 24 * s, 2 * s);
    } else if (b.kind === 'well') {
      g.fillStyle = shadeFillColorLit('#6f8696', shade);
      g.fillRect(gx + 10 * s, gy + 14 * s, 12 * s, 10 * s);
      g.fillStyle = shadeFillColorLit('#2b3744', shade);
      g.fillRect(gx + 12 * s, gy + 18 * s, 8 * s, 6 * s);
      g.fillStyle = shadeFillColorLit('#927a54', shade);
      g.fillRect(gx + 8 * s, gy + 12 * s, 16 * s, 2 * s);
      if (hydratePulse > 0.05) {
        g.strokeStyle = shadeFillColorLit('rgba(134,201,255,0.9)', shade);
        g.lineWidth = Math.max(1, Math.round(s));
        const ripple = 3 * s + (Math.sin(tick * 0.2) + 1) * s * 0.8;
        g.beginPath();
        g.arc(gx + 16 * s, gy + 17 * s, ripple * (1 + hydratePulse * 0.6), 0, Math.PI * 2);
        g.stroke();
      }
    }
    if (b.built < 1) {
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.strokeRect(gx + 4 * s, gy + 4 * s, 24 * s, 24 * s);
      const p = (b.progress || 0) / (BUILDINGS[b.kind].cost || 1);
      g.fillStyle = shadeFillColorLit('#7cc4ff', shade);
      g.fillRect(gx + 6 * s, gy + 28 * s, Math.floor(20 * p) * s, 2 * s);
    }
    g.restore();
    const overlayRadius = def.effects?.radius ?? def.effects?.hydrationRadius ?? 0;
    if (overlayRadius > 0 && activityPulse > 0.05) {
      const cx = tileToPxX(center.x, cam);
      const cy = tileToPxY(center.y, cam);
      const radiusPx = (overlayRadius + 0.5) * TILE * cam.z;
      ctx.save();
      ctx.globalAlpha = Math.min(0.45, 0.2 + activityPulse * 0.4);
      const overlayColor = b.kind === 'well' ? 'rgba(134,201,255,0.95)' : 'rgba(255,232,168,0.95)';
      ctx.strokeStyle = shadeFillColorLit(overlayColor, shade);
      ctx.lineWidth = Math.max(1, Math.round(1.6 * cam.z));
      ctx.beginPath();
      ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawAnimal(animal, useMultiply) {
    if (!animal) return;
    const sprite = Tileset.sprite.animals && Tileset.sprite.animals[animal.type];
    if (!sprite) return;
    const ctx = getCtx();
    const world = getWorld();
    const cam = getCam();
    if (!ctx || !world) return;
    const rect = entityDrawRect(animal.x, animal.y, cam);
    const bobPx = Math.round((animal.bobOffset || 0) * cam.z);
    const light = useMultiply ? 1 : sampleLightAt(world, animal.x, animal.y);
    drawShadow(animal.x, animal.y, 1, 1, { x: rect.x, y: rect.y, w: rect.size, h: rect.size });
    ctx.save();
    if (animal.dir === 'left') {
      ctx.translate(rect.x + rect.size, rect.y - bobPx);
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, 0, 0, ENTITY_TILE_PX, ENTITY_TILE_PX, 0, 0, rect.size, rect.size);
      applySpriteShadeLit(ctx, 0, 0, rect.size, rect.size, light);
    } else {
      ctx.drawImage(sprite, 0, 0, ENTITY_TILE_PX, ENTITY_TILE_PX, rect.x, rect.y - bobPx, rect.size, rect.size);
      applySpriteShadeLit(ctx, rect.x, rect.y - bobPx, rect.size, rect.size, light);
    }
    ctx.restore();
  }

  function drawVillager(v, useMultiply) {
    const ctx = getCtx();
    const world = getWorld();
    const cam = getCam();
    const tick = getTick();
    const villagerLabels = getVillagerLabels();
    if (!ctx || !world || !villagerLabels) return;
    const frames = v.role === 'farmer' ? Tileset.villagerSprites.farmer
                 : v.role === 'worker' ? Tileset.villagerSprites.worker
                 : v.role === 'explorer' ? Tileset.villagerSprites.explorer
                 : Tileset.villagerSprites.sleepy;
    const f = frames[Math.floor((tick / 8) % 3)];
    const s = cam.z;
    const rect = entityDrawRect(v.x, v.y, cam);
    const spriteSize = 16 * s;
    const gx = Math.floor(rect.x + (rect.size - spriteSize) * 0.5);
    const gy = Math.floor(rect.y + (rect.size - spriteSize) * 0.5);
    const light = useMultiply ? 1 : sampleLightAt(world, v.x, v.y);
    drawShadow(v.x, v.y, 1, 1, { x: gx, y: gy, w: spriteSize, h: spriteSize });
    ctx.save();
    ctx.drawImage(f, 0, 0, 16, 16, gx, gy, spriteSize, spriteSize);
    applySpriteShadeLit(ctx, gx, gy, spriteSize, spriteSize, light);
    if (v.inv) {
      const packColor = v.inv.type === ITEM.WOOD
        ? '#b48a52'
        : v.inv.type === ITEM.STONE
          ? '#aeb7c3'
          : v.inv.type === ITEM.BOW
            ? '#d4c08a'
            : '#b6d97a';
      ctx.fillStyle = shadeFillColorLit(packColor, light);
      ctx.fillRect(gx + spriteSize - 4 * s, gy + 2 * s, 3 * s, 3 * s);
    }
    ctx.restore();

    const baseCx = gx + spriteSize * 0.5;
    const baseCy = gy - 4 * cam.z;
    let labelOffset = 0;
    const villagerNumber = ensureVillagerNumber ? ensureVillagerNumber(v) : null;
    const queueLabel = (text, color) => {
      if (!text) return;
      const fontSize = Math.max(6, 6 * cam.z);
      const boxH = fontSize + 4 * cam.z;
      villagerLabels.push({
        text,
        color,
        cx: baseCx,
        cy: baseCy - labelOffset,
        fontSize,
        boxH,
        camZ: cam.z
      });
      labelOffset += boxH + 2 * cam.z;
    };

    if (villagerNumber != null) {
      queueLabel(`#${villagerNumber}`, '#e8edff');
    }

    if (v.lifeStage === 'child') {
      queueLabel('Child', '#9ad1ff');
    } else if (v.pregnancyTimer > 0) {
      queueLabel('🤰 Expecting', '#f7b0d6');
    }

    const cond = v.condition;
    if (cond && cond !== 'normal') {
      let label = null, color = '#ffcf66';
      if (cond === 'hungry') { label = 'Hungry'; color = '#ffcf66'; }
      else if (cond === 'starving') { label = 'Starving'; color = '#ff6b6b'; }
      else if (cond === 'sick') { label = 'Collapsed'; color = '#d76bff'; }
      else if (cond === 'recovering') { label = 'Recovering'; color = '#7cc4ff'; }
      if (label) { queueLabel(label, color); }
    }
    const mood = v.happy;
    let moodLabel = null, moodColor = '#8fe58c';
    const moodTargets = (policy && policy.moodTargets) || {};
    const upbeatTarget = typeof moodTargets.upbeat === 'number' ? moodTargets.upbeat : 0.8;
    const cheerfulTarget = typeof moodTargets.cheerful === 'number' ? moodTargets.cheerful : 0.65;
    const miserableTarget = typeof moodTargets.miserable === 'number' ? moodTargets.miserable : 0.2;
    const lowSpiritsTarget = typeof moodTargets.lowSpirits === 'number' ? moodTargets.lowSpirits : 0.35;
    if (mood >= upbeatTarget) { moodLabel = '😊 Upbeat'; moodColor = '#8fe58c'; }
    else if (mood >= cheerfulTarget) { moodLabel = '🙂 Cheerful'; moodColor = '#b9f5ae'; }
    else if (mood <= miserableTarget) { moodLabel = '☹️ Miserable'; moodColor = '#ff8c8c'; }
    else if (mood <= lowSpiritsTarget) { moodLabel = '😟 Low spirits'; moodColor = '#f5d58b'; }
    if (moodLabel) { queueLabel(moodLabel, moodColor); }
  }

  function drawQueuedVillagerLabels(uiLight) {
    const ctx = getCtx();
    const villagerLabels = getVillagerLabels();
    if (!ctx || !villagerLabels) return;
    if (villagerLabels.length === 0) return;
    const clamped = Math.max(LIGHTING.uiMinLight, uiLight);
    for (const label of villagerLabels) {
      const { text, color, cx, cy, fontSize, boxH, camZ } = label;
      ctx.save();
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const metrics = ctx.measureText(text);
      const boxW = metrics.width + 6 * camZ;
      ctx.fillStyle = shadeFillColorLit('rgba(10,12,16,0.8)', clamped);
      ctx.fillRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = Math.max(1, Math.round(0.7 * camZ));
      ctx.strokeRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
      ctx.fillStyle = shadeFillColorLit(color, clamped);
      ctx.fillText(text, cx, cy + 0.2 * camZ);
      ctx.restore();
    }
    villagerLabels.length = 0;
  }

  function render() {
    const ctx = getCtx();
    const world = getWorld();
    if (!ctx || !world) return;

    const cam = getCam();
    const W = getViewportW();
    const H = getViewportH();
    const tick = getTick();
    const dayTime = getDayTime();
    const buildings = getBuildings();
    const villagers = getVillagers();
    const animals = getAnimals();
    const itemsOnGround = getItemsOnGround();
    const villagerLabels = getVillagerLabels();
    const buildingsByKind = getBuildingsByKind();
    const activeZoneJobs = getActiveZoneJobs();
    const storageTotals = getStorageTotals ? getStorageTotals() : null;

    if (world.__debug != null) {
      world.__debug.pipeline = [];
      world.__debug.lastFrame = (world.__debug.lastFrame != null) ? (world.__debug.lastFrame + 1) : 1;
      world.__debug.layerOrder = LAYER_ORDER;
    }
    function __ck(name, ok, extra) {
      const entry = { name, ok: ok === true, extra: extra || null };
      const debugKit = (typeof window !== 'undefined') ? window.DebugKit : null;
      if (debugKit != null && typeof debugKit.checkpoint === 'function') {
        try { debugKit.checkpoint(name, entry.ok, entry.extra); }
        catch (_e) { /* ignore checkpoint errors */ }
      }
      if (world.__debug != null && Array.isArray(world.__debug.pipeline)) {
        world.__debug.pipeline.push(entry);
      }
    }

    world.dayTime = dayTime;

    const shadingMode = normalizeShadingMode(LIGHTING.mode);
    if (LIGHTING.mode !== shadingMode) LIGHTING.mode = shadingMode;
    const ambient = shadingMode === 'off' ? 1 : ambientAt(dayTime);
    const nightActive = isNightAmbient(ambient);
    setCurrentAmbient(ambient);

    villagerLabels.length = 0;

    if (!Array.isArray(world.emitters)) world.emitters = [];
    const emittersDirty = getEmittersDirty ? getEmittersDirty() : true;
    if (emittersDirty
        || world._emittersShadingMode !== shadingMode
        || world._emittersNightActive !== nightActive) {
      world.emitters.length = 0;
      if (shadingMode !== 'off') {
        const campfires = buildingsByKind && buildingsByKind.get('campfire');
        if (campfires) {
          const intensity = nightActive ? 0.55 : 0.4;
          for (const b of campfires) {
            if ((b.built || 0) < 1) continue;
            const fp = getFootprint(b.kind);
            world.emitters.push({
              x: b.x + (fp?.w || 1) * 0.5,
              y: b.y + (fp?.h || 1) * 0.5,
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
      if (setEmittersClean) setEmittersClean();
    }

    const useMultiply = shadingMode !== 'off' && LIGHTING.useMultiplyComposite;
    let compositeLogged = false;
    let compositeError = null;
    let spritesError = null;

    const logComposite = (ok, extra) => {
      __ck('composite:multiply', ok, extra);
      compositeLogged = true;
    };

    if (staticDirty) drawStaticAlbedo();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    __ck('albedo:begin', true, null);
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, W, H);
    const baseDx = tileToPxX(0, cam);
    const baseDy = tileToPxY(0, cam);
    if (staticAlbedoCanvas) {
      ctx.drawImage(staticAlbedoCanvas, 0, 0, staticAlbedoCanvas.width, staticAlbedoCanvas.height,
        baseDx, baseDy,
        staticAlbedoCanvas.width * cam.z, staticAlbedoCanvas.height * cam.z);
    }

    let t0, t1, t2;
    if (perf && perf.log) t0 = performance.now();

    const vis = visibleTileBounds();
    const x0 = vis.x0, y0 = vis.y0, x1 = vis.x1, y1 = vis.y1;

    const frames = Tileset.waterOverlay || [];
    if (frames.length) {
      const frame = Math.floor((tick / 10) % frames.length);
      drawWaterOverlay(frames, frame, vis);
    }

    drawZoneOverlay(activeZoneJobs, cam, baseDx, baseDy);

    __ck('albedo:end', true, null);

    const lightingReady = (LIGHTING.mode != 'off')
      && (world.hillshadeQ != null || world.lightmapQ != null);
    __ck('lighting:ready', lightingReady === true, {
      mode: LIGHTING.mode,
      hasHillshadeQ: world.hillshadeQ != null,
      hasLightmapQ: world.lightmapQ != null
    });

    try {
      if (LIGHTING.mode != 'off') {
        const updated = maybeBuildLightmap(world, ambient, normalizeShadingMode);
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

    if (!useMultiply && shadingMode !== 'off' && world.lightmapCanvas) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      const destW = staticAlbedoCanvas ? staticAlbedoCanvas.width * cam.z : GRID_W * TILE * cam.z;
      const destH = staticAlbedoCanvas ? staticAlbedoCanvas.height * cam.z : GRID_H * TILE * cam.z;
      ctx.drawImage(world.lightmapCanvas, 0, 0, world.lightmapCanvas.width, world.lightmapCanvas.height,
        baseDx, baseDy,
        destW, destH);
      ctx.restore();
    }

    try {
      for (let y = y0; y <= y1; y++) {
        const rowStart = y * GRID_W;
        for (let x = x0; x <= x1; x++) {
          const i = rowStart + x;
          if (world.tiles[i] === TILES.FOREST && world.trees[i] > 0) {
            drawShadow(x, y, 1, 1);
            const rect = entityDrawRect(x, y, cam);
            const raisedY = rect.y - Math.round(cam.z * TREE_VERTICAL_RAISE);
            const light = useMultiply ? 1 : sampleLightAt(world, x, y);
            ctx.save();
            ctx.drawImage(Tileset.sprite.tree, 0, 0, ENTITY_TILE_PX, ENTITY_TILE_PX, rect.x, raisedY, rect.size, rect.size);
            applySpriteShadeLit(ctx, rect.x, raisedY, rect.size, rect.size, light);
            ctx.restore();
          }
          if (world.berries[i] > 0) {
            drawShadow(x, y, 1, 1);
            const rect = entityDrawRect(x, y, cam);
            const light = useMultiply ? 1 : sampleLightAt(world, x, y);
            ctx.save();
            ctx.drawImage(Tileset.sprite.berry, 0, 0, ENTITY_TILE_PX, ENTITY_TILE_PX, rect.x, rect.y, rect.size, rect.size);
            applySpriteShadeLit(ctx, rect.x, rect.y, rect.size, rect.size, light);
            ctx.restore();
          }
          if (world.tiles[i] === TILES.FARMLAND && world.growth[i] > 0) {
            drawShadow(x, y, 1, 1);
            const stageIndex = Math.min(2, Math.floor(world.growth[i] / 80));
            const rect = entityDrawRect(x, y, cam);
            ctx.save();
            ctx.drawImage(Tileset.sprite.sprout[stageIndex], 0, 0, ENTITY_TILE_PX, ENTITY_TILE_PX, rect.x, rect.y, rect.size, rect.size);
            ctx.restore();
          }
        }
      }

      if (perf && perf.log) t1 = performance.now();

      for (const creature of animals) { drawAnimal(creature, useMultiply); }

      for (const b of buildings) {
        const gx = tileToPxX(b.x, cam);
        const gy = tileToPxY(b.y, cam);
        drawBuildingAt(gx, gy, b);
      }

      for (const it of itemsOnGround) {
        const gx = tileToPxX(it.x, cam);
        const gy = tileToPxY(it.y, cam);
        const light = useMultiply ? 1 : sampleLightAt(world, it.x, it.y);
        const tileSize = TILE * cam.z;
        const centerX = Math.round(gx + tileSize * 0.5);
        const centerY = Math.round(gy + tileSize * 0.5);
        const size = Math.max(2, Math.round(4 * cam.z));
        const half = Math.floor(size / 2);
        const spriteRect = { x: centerX - half, y: centerY - half, w: size, h: size };
        drawShadow(it.x, it.y, 1, 1, spriteRect);
        ctx.save();
        const baseColor = it.type === ITEM.WOOD
          ? '#b48a52'
          : it.type === ITEM.STONE
            ? '#aeb7c3'
            : it.type === ITEM.BOW
              ? '#d4c08a'
              : '#b6d97a';
        ctx.fillStyle = shadeFillColorLit(baseColor, light);
        ctx.fillRect(spriteRect.x, spriteRect.y, spriteRect.w, spriteRect.h);
        ctx.restore();
      }

      if (drawNocturnalEntities) drawNocturnalEntities(ambient);

      for (const v of villagers) { drawVillager(v, useMultiply); }

      if (LIGHTING.useMultiplyComposite === true && LIGHTING.mode != 'off') {
        try {
          if (useMultiply && shadingMode !== 'off' && world.lightmapCanvas) {
            ctx.save();
            ctx.globalCompositeOperation = 'multiply';
            const destW = staticAlbedoCanvas ? staticAlbedoCanvas.width * cam.z : GRID_W * TILE * cam.z;
            const destH = staticAlbedoCanvas ? staticAlbedoCanvas.height * cam.z : GRID_H * TILE * cam.z;
            ctx.drawImage(world.lightmapCanvas, 0, 0, world.lightmapCanvas.width, world.lightmapCanvas.height,
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

      if (LIGHTING.debugShowLightmap && world.lightmapCanvas) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.imageSmoothingEnabled = false;
        const previewW = Math.min(128, Math.max(32, world.lightmapCanvas.width));
        const previewH = Math.min(128, Math.max(32, world.lightmapCanvas.height));
        ctx.drawImage(world.lightmapCanvas, 0, 0, world.lightmapCanvas.width, world.lightmapCanvas.height,
          12, 12, previewW, previewH);
        ctx.restore();
      }

      for (const b of buildings) {
        if (b.kind === 'campfire') {
          const center = buildingCenter(b);
          const gx = tileToPxX(center.x, cam);
          const gy = tileToPxY(center.y, cam);
          const r = (24 + 4 * Math.sin(tick * 0.2)) * cam.z;
          const grd = ctx.createRadialGradient(gx, gy, 4 * cam.z, gx, gy, r);
          grd.addColorStop(0, 'rgba(255,180,90,0.35)');
          grd.addColorStop(1, 'rgba(255,120,60,0)');
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill();
          if (nightActive) {
            ctx.save();
            ctx.globalAlpha = 0.25 + 0.15 * Math.random();
            ctx.fillStyle = 'rgba(255,210,150,0.85)';
            for (let i = 0; i < 2; i++) {
              const emberX = gx + (12 + Math.random() * 8) * cam.z + (Math.random() * 2 - 1) * cam.z;
              const emberY = gy + (4 - Math.random() * 10) * cam.z;
              ctx.beginPath();
              ctx.arc(emberX, emberY, Math.max(0.6, 1.1 * Math.random()) * cam.z, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }
        }
      }

      drawQueuedVillagerLabels(ambient);

      if (el && storageTotals) {
        const foodEl = el('food'); if (foodEl) foodEl.textContent = storageTotals.food | 0;
        const woodEl = el('wood'); if (woodEl) woodEl.textContent = storageTotals.wood | 0;
        const stoneEl = el('stone'); if (stoneEl) stoneEl.textContent = storageTotals.stone | 0;
        const popEl = el('pop'); if (popEl) popEl.textContent = villagers.length | 0;
      }
      if (perf && perf.log) {
        t2 = performance.now();
        if ((tick % 60) === 0) console.log(`render: overlays ${(t1 - t0).toFixed(2)}ms, total ${(t2 - t0).toFixed(2)}ms`);
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

  return {
    setCurrentAmbient,
    resetLightmapCache,
    shadeFillColor,
    applySpriteShade,
    shadeFillColorLit,
    applySpriteShadeLit,
    entityDrawRect,
    visibleTileBounds,
    emittersSignature,
    buildHillshadeQ,
    buildLightmap,
    sampleLightAt,
    ensureLightmapBuffers,
    maybeBuildLightmap,
    markStaticDirty,
    markZoneOverlayDirty,
    ensureRowMasksSize,
    refreshWaterRowMaskFromTiles,
    refreshZoneRowMask,
    updateZoneRow,
    noteZoneTileSown,
    resetOverlayCaches,
    render
  };
}
