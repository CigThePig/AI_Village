import {
  ENTITY_TILE_PX,
  GRID_H,
  GRID_SIZE,
  GRID_W,
  ITEM_COLORS,
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
import { LIGHTING, clamp01, gradeLightmap } from './lighting.js';
import { clamp, hash2 } from './rng.js';
import { context2d } from './canvas.js';
import {
  SHADOW_TEXTURE,
  Tileset,
  VILLAGER_FRAME_COUNT,
  makeCanvas,
  normalizeSeason,
  pickAccentColor,
  seasonName
} from './tileset.js';
import {
  BUILDINGS,
  buildingCenter,
  getFootprint
} from './world.js';
import { findFarmPlotForTile } from './layout.js';
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
    season: null,
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
    // Per-channel tint shifts the lightmap's neutral grey toward warm at
    // dawn/dusk and cool blue at night. The multiply composite carries the
    // tint across the whole scene, so this is the cheapest place to grade.
    const tint = gradeLightmap(ambient, targetWorld.dayTime);
    const data = img.data;
    for (let i = 0, p = 0; i < length; i++, p += 4) {
      const v = Math.max(0, Math.min(1, Lq[i]));
      const b = v * 255;
      data[p] = Math.round(b * tint.r);
      data[p + 1] = Math.round(b * tint.g);
      data[p + 2] = Math.round(b * tint.b);
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

    const season = normalizeSeason(world.season);
    const baseSet = Tileset.baseBySeason?.[season] || Tileset.base || {};
    const fallbackSet = baseSet.grass || Tileset.base?.grass;

    // baseSet[kind] is an array of canvases (length 1 for sand/snow/rock,
    // multiple for grass/forest/meadow/etc). Picking by hash2(x, y) gives a
    // deterministic, repetition-breaking variant per tile that survives
    // reloads and only re-evaluates on staticDirty.
    const pickVariant = (set, x, y) => {
      if (!set) return null;
      if (Array.isArray(set)) {
        if (set.length === 0) return null;
        if (set.length === 1) return set[0];
        return set[hash2(x, y) % set.length];
      }
      return set;
    };

    const fallback = pickVariant(fallbackSet, 0, 0);

    ensureRowMasksSize();

    const tiles = world.tiles;
    const isWater = (xi, yi) => {
      if (xi < 0 || xi >= GRID_W || yi < 0 || yi >= GRID_H) return false;
      return tiles[yi * GRID_W + xi] === TILES.WATER;
    };

    for (let y = 0; y < GRID_H; y++) {
      let rowHasWater = 0;
      const rowStart = y * GRID_W;

      for (let x = 0; x < GRID_W; x++) {
        const i = rowStart + x;
        const t = tiles[i];

        let img = pickVariant(baseSet.grass, x, y) || fallback;

        if (t === TILES.GRASS) img = pickVariant(baseSet.grass, x, y) || fallback;
        else if (t === TILES.FOREST) img = pickVariant(baseSet.forest, x, y) || pickVariant(baseSet.grass, x, y) || fallback;
        else if (t === TILES.FERTILE) img = pickVariant(baseSet.fertile, x, y) || fallback;
        else if (t === TILES.MEADOW) img = pickVariant(baseSet.meadow, x, y) || fallback;
        else if (t === TILES.MARSH) img = pickVariant(baseSet.marsh, x, y) || fallback;
        else if (t === TILES.SAND) img = pickVariant(baseSet.sand, x, y) || fallback;
        else if (t === TILES.SNOW) img = pickVariant(baseSet.snow, x, y) || fallback;
        else if (t === TILES.ROCK) img = pickVariant(baseSet.rock, x, y) || fallback;
        else if (t === TILES.WATER) img = pickVariant(baseSet.water, x, y) || fallback;
        else if (t === TILES.FARMLAND) img = pickVariant(baseSet.farmland, x, y) || fallback;

        if (img) g.drawImage(img, x * TILE, y * TILE);

        // Foam edges: paint a 1-pixel pale rim on the side of any non-water
        // tile that touches water. Drawn at bake time so per-frame cost is
        // zero, and the contrast reads nicely at every zoom level.
        if (t !== TILES.WATER) {
          const px = x * TILE;
          const py = y * TILE;
          g.fillStyle = 'rgba(232, 245, 255, 0.55)';
          if (isWater(x, y - 1)) g.fillRect(px, py, TILE, 1);
          if (isWater(x, y + 1)) g.fillRect(px, py + TILE - 1, TILE, 1);
          if (isWater(x - 1, y)) g.fillRect(px, py, 1, TILE);
          if (isWater(x + 1, y)) g.fillRect(px + TILE - 1, py, 1, TILE);
        }

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

  // Phase 1 — debug-only overlay. Each slot family gets a distinct hue so the
  // archetype is readable at a glance; anchor markers reuse the slot color so
  // a slot and its anchor read as a pair.
  const SLOT_FAMILY_COLORS = {
    hearth: 'rgba(255, 130, 70, 0.5)',
    storage: 'rgba(180, 140, 80, 0.5)',
    housing: 'rgba(120, 200, 255, 0.45)',
    craft: 'rgba(220, 100, 200, 0.45)',
    fields: 'rgba(150, 220, 120, 0.45)',
    wells: 'rgba(80, 160, 220, 0.5)'
  };

  // Phase 2 — debug-only overlay that strokes each rectangular farm plot and
  // labels it with id, dimensions, and an orientation glyph. Mirrors the
  // Phase 1 drawLayoutOverlay style so reviewers see plot vs. slot in the
  // same idiom.
  function drawPlotOverlay(world, camState) {
    const ctx = getCtx();
    if (!ctx || !world || !Array.isArray(world.farmPlots) || world.farmPlots.length === 0) return;
    ctx.save();
    ctx.lineWidth = Math.max(1, camState.z);
    for (const plot of world.farmPlots) {
      if (!plot) continue;
      const px = tileToPxX(plot.x, camState);
      const py = tileToPxY(plot.y, camState);
      const w = plot.w * TILE * camState.z;
      const h = plot.h * TILE * camState.z;
      const stroke = plot.abutsWells ? 'rgba(255, 200, 80, 0.95)' : 'rgba(220, 220, 80, 0.85)';
      const fill = plot.abutsWells ? 'rgba(255, 200, 80, 0.12)' : 'rgba(220, 220, 80, 0.10)';
      ctx.strokeStyle = stroke;
      ctx.fillStyle = fill;
      ctx.fillRect(px, py, w, h);
      ctx.strokeRect(px, py, w, h);
      const glyph = plot.orientation === 'horizontal' ? '↔' : '↕';
      ctx.fillStyle = '#0a0c10';
      ctx.font = `${Math.max(8, Math.round(8 * camState.z))}px system-ui, sans-serif`;
      ctx.fillText(`${plot.id} ${plot.w}x${plot.h} ${glyph}`, px + 2, py + Math.max(10, 10 * camState.z));
    }
    ctx.restore();
  }

  function drawLayoutOverlay(layout, camState) {
    const ctx = getCtx();
    if (!ctx || !layout || !Array.isArray(layout.slots)) return;
    const occ = layout.occupancy;
    ctx.save();
    ctx.lineWidth = Math.max(1, camState.z);
    for (const slot of layout.slots) {
      if (!slot || !slot.footprint) continue;
      const fp = slot.footprint;
      const x = tileToPxX(fp.x, camState);
      const y = tileToPxY(fp.y, camState);
      const w = fp.w * TILE * camState.z;
      const h = fp.h * TILE * camState.z;
      const color = SLOT_FAMILY_COLORS[slot.family] || 'rgba(220, 220, 220, 0.4)';
      ctx.strokeStyle = color;
      ctx.fillStyle = color.replace(/, [\d.]+\)$/, ', 0.10)');
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      const usedRaw = occ instanceof Map ? (occ.get(slot.id) || 0) : (occ?.[slot.id] || 0);
      ctx.fillStyle = '#0a0c10';
      ctx.font = `${Math.max(8, Math.round(8 * camState.z))}px system-ui, sans-serif`;
      ctx.fillText(`${slot.id} ${usedRaw}/${slot.capacity}`, x + 2, y + Math.max(10, 10 * camState.z));
    }
    if (layout.anchors) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = Math.max(1, camState.z * 0.6);
      for (const name of Object.keys(layout.anchors)) {
        const a = layout.anchors[name];
        if (!a) continue;
        const ax = tileToPxX(a.x + 0.5, camState);
        const ay = tileToPxY(a.y + 0.5, camState);
        const r = Math.max(2, 3 * camState.z);
        ctx.beginPath();
        ctx.moveTo(ax - r, ay); ctx.lineTo(ax + r, ay);
        ctx.moveTo(ax, ay - r); ctx.lineTo(ax, ay + r);
        ctx.stroke();
      }
    }
    ctx.restore();
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
    const overlaySeason = normalizeSeason(world.season);
    const needsRedraw = waterOverlayCache.frameIndex !== frameIndex
      || waterOverlayCache.season !== overlaySeason
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
      waterOverlayCache.season = overlaySeason;
      waterOverlayCache.camX = cam.x;
      waterOverlayCache.camY = cam.y;
      waterOverlayCache.camZ = cam.z;
    }
    ctx.drawImage(waterOverlayCache.canvas, 0, 0);
  }

  function drawSeasonAtmosphere(season, tick, vis) {
    const ctx = getCtx();
    const cam = getCam();
    if (!ctx || !cam || !vis) return;

    const name = seasonName(season);

    ctx.save();

    if (name === 'winter') {
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = '#dcecff';
      ctx.fillRect(0, 0, getViewportW(), getViewportH());

      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#f8fdff';

      for (let y = vis.y0; y <= vis.y1; y += 3) {
        for (let x = vis.x0; x <= vis.x1; x += 4) {
          const n = (x * 928371 + y * 364479 + Math.floor(tick / 24) * 53) % 19;
          if (n !== 0) continue;
          const px = tileToPxX(x + 0.3, cam);
          const py = tileToPxY(y + 0.2, cam);
          ctx.fillRect(px, py, Math.max(1, cam.z), Math.max(1, cam.z));
        }
      }
    } else if (name === 'autumn') {
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = '#d38b3a';
      ctx.fillRect(0, 0, getViewportW(), getViewportH());

      ctx.globalAlpha = 0.4;
      const colors = ['#d9852d', '#b84f2a', '#e1a33a'];

      // Denser leaf density (every ~17 cells vs the prior ~23) plus a small
      // horizontal drift so leaves look wind-blown instead of static stamps.
      for (let y = vis.y0; y <= vis.y1; y += 3) {
        for (let x = vis.x0; x <= vis.x1; x += 4) {
          const n = (x * 7127 + y * 9151 + Math.floor(tick / 40) * 17) % 17;
          if (n !== 0) continue;
          const drift = Math.sin((tick * 0.04) + x * 0.7 + y * 0.5) * 0.5;
          const px = tileToPxX(x + 0.5 + drift, cam);
          const py = tileToPxY(y + 0.4, cam);
          ctx.fillStyle = colors[(x + y) % colors.length];
          ctx.fillRect(px, py, Math.max(1, cam.z * 1.5), Math.max(1, cam.z));
        }
      }
    } else if (name === 'spring') {
      ctx.globalAlpha = 0.035;
      ctx.fillStyle = '#b9ffd0';
      ctx.fillRect(0, 0, getViewportW(), getViewportH());
    } else if (name === 'summer') {
      ctx.globalAlpha = 0.025;
      ctx.fillStyle = '#ffe2a0';
      ctx.fillRect(0, 0, getViewportW(), getViewportH());
    }

    ctx.restore();
  }

  // Summer-only night fireflies near grass/forest tiles. Hash-gated so the
  // particle count is bounded by visible area, not a per-frame allocation.
  function drawFireflies(season, tick, vis, ambient) {
    if (seasonName(season) !== 'summer') return;
    if (ambient > 0.5) return;
    const ctx = getCtx();
    const cam = getCam();
    const world = getWorld();
    if (!ctx || !cam || !vis || !world) return;
    ctx.save();
    for (let y = vis.y0; y <= vis.y1; y++) {
      const rowStart = y * GRID_W;
      for (let x = vis.x0; x <= vis.x1; x++) {
        const t = world.tiles[rowStart + x];
        if (t !== TILES.GRASS && t !== TILES.MEADOW && t !== TILES.FOREST && t !== TILES.FERTILE) continue;
        const n = (x * 9301 + y * 49297 + Math.floor(tick / 30) * 53) % 47;
        if (n !== 0) continue;
        const flicker = ((x + y + Math.floor(tick / 6)) % 5) >= 2;
        if (!flicker) continue;
        const drift = Math.sin(tick * 0.05 + x * 0.4 + y * 0.7) * 0.3;
        const px = tileToPxX(x + 0.5 + drift, cam);
        const py = tileToPxY(y + 0.45, cam);
        ctx.fillStyle = 'rgba(255, 232, 130, 0.95)';
        ctx.fillRect(px, py, Math.max(1, cam.z), Math.max(1, cam.z));
        ctx.fillStyle = 'rgba(255, 232, 130, 0.35)';
        ctx.fillRect(px - cam.z, py - cam.z, Math.max(1, cam.z * 3), Math.max(1, cam.z * 3));
      }
    }
    ctx.restore();
  }

  // Two soft circles per chimney/fire, phase-offset by hash2 so adjacent
  // huts don't puff in lockstep. Drawn in the post-multiply pass so the
  // alpha falloff reads against night without being darkened.
  function drawSmokeWisps(b, baseX, baseY, tick, cam) {
    const ctx = getCtx();
    if (!ctx) return;
    const phaseSeed = hash2(b.x | 0, b.y | 0);
    ctx.save();
    for (let i = 0; i < 2; i++) {
      const cycle = 80;
      const offset = (((tick + (phaseSeed >>> (i * 8)) % cycle) % cycle) + i * cycle * 0.5) % cycle;
      const t = offset / cycle;
      const rise = t * 22 * cam.z;
      const drift = Math.sin(t * Math.PI * 2 + i) * 2.4 * cam.z;
      const alpha = (1 - t) * 0.32;
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(220, 220, 224, 1)';
      ctx.beginPath();
      ctx.arc(baseX + drift, baseY - rise, (1.5 + t * 1.3) * cam.z, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Cached vignette gradient — only rebuild on viewport resize.
  const vignetteCache = { canvas: null, w: 0, h: 0 };
  function drawPostFx() {
    const ctx = getCtx();
    if (!ctx) return;
    const W = getViewportW();
    const H = getViewportH();
    if (W <= 0 || H <= 0) return;
    if (!vignetteCache.canvas || vignetteCache.w !== W || vignetteCache.h !== H) {
      const off = makeCanvas(W, H);
      const og = context2d(off);
      if (!og) return;
      const cx = W * 0.5;
      const cy = H * 0.5;
      const radius = Math.hypot(cx, cy);
      const grd = og.createRadialGradient(cx, cy, radius * 0.55, cx, cy, radius);
      grd.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grd.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
      og.fillStyle = grd;
      og.fillRect(0, 0, W, H);
      vignetteCache.canvas = off;
      vignetteCache.w = W;
      vignetteCache.h = H;
    }
    if (vignetteCache.canvas) {
      ctx.drawImage(vignetteCache.canvas, 0, 0);
    }
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
    drawShadow(b.x, b.y, fp.w, fp.h);
    const offsetX = Math.floor((ENTITY_TILE_PX - fp.w * TILE) * s * 0.5);
    const offsetY = Math.floor((ENTITY_TILE_PX - fp.h * TILE) * s * 0.5);
    gx -= offsetX;
    gy -= offsetY;
    g.save();

    const line = (x1, y1, x2, y2, color, width = 1) => {
      g.strokeStyle = shadeFillColorLit(color, shade);
      g.lineWidth = Math.max(1, Math.round(width * s));
      g.beginPath();
      g.moveTo(gx + x1 * s, gy + y1 * s);
      g.lineTo(gx + x2 * s, gy + y2 * s);
      g.stroke();
    };

    const box = (x, y, w, h, color) => {
      g.fillStyle = shadeFillColorLit(color, shade);
      g.fillRect(gx + x * s, gy + y * s, w * s, h * s);
    };

    const litBox = (x, y, w, h, color, alpha = 1) => {
      const oldAlpha = g.globalAlpha;
      g.globalAlpha *= alpha;
      box(x, y, w, h, color);
      g.globalAlpha = oldAlpha;
    };

    if (b.kind === 'campfire') {
      box(10, 21, 12, 3, '#5a5a5a');
      box(8, 22, 4, 3, '#777777');
      box(20, 22, 4, 3, '#777777');
      box(12, 20, 8, 2, '#3a2a1d');

      line(11, 22, 21, 18, '#6a3d1f', 2);
      line(21, 22, 11, 18, '#6a3d1f', 2);

      const flame = 1 + activityPulse * 0.4;
      litBox(14, 14 - flame, 4, 8 + flame, '#f7b733', 0.95);
      litBox(15, 11 - flame, 2, 8 + flame, '#ff6b2d', 0.9);
      litBox(16, 16, 2, 5, '#fff1a8', 0.85);

      g.globalAlpha *= 0.28 + activityPulse * 0.25;
      box(9, 9, 14, 14, '#ffb347');
      g.globalAlpha = 1;

      g.globalAlpha = 0.25;
      box(13, 7 - Math.sin(tick * 0.05) * 2, 2, 2, '#d8d0c0');
      box(18, 5 - Math.sin(tick * 0.04) * 2, 3, 2, '#d8d0c0');
      g.globalAlpha = 1;
    } else if (b.kind === 'storage') {
      box(7, 12, 18, 13, '#7a5530');
      box(6, 10, 20, 4, '#5d3b20');
      box(9, 15, 14, 2, '#9b7044');
      box(9, 20, 14, 2, '#9b7044');
      line(11, 13, 11, 25, '#4a2d18', 1);
      line(20, 13, 20, 25, '#4a2d18', 1);

      box(10, 22, 4, 3, '#c6a35f');
      box(15, 21, 4, 4, '#8d8f72');
      box(20, 22, 3, 3, '#b88a4f');

      const stored = Math.min(1, (b.store || 0) / Math.max(1, BUILDINGS[b.kind]?.cost || 1));
      if (stored > 0.15) {
        litBox(8, 8, 16 * stored, 2, '#d0b56c', 0.75);
      }
    } else if (b.kind === 'hut') {
      box(8, 14, 17, 12, '#8a5d35');
      box(10, 16, 13, 10, '#a06d3f');
      box(7, 12, 19, 3, '#5b3a22');
      box(9, 9, 15, 4, '#6e4728');
      box(11, 7, 11, 3, '#7a4e2c');

      box(14, 19, 5, 7, '#3b2415');
      litBox(21, 17, 2, 3, '#ffd27a', 0.45);
      box(13, 26, 7, 2, '#4a2d19');
    } else if (b.kind === 'hunterLodge') {
      box(7, 14, 18, 12, '#765033');
      box(8, 11, 16, 4, '#4b2f1c');
      box(10, 8, 12, 4, '#5e3b22');
      box(5, 18, 4, 8, '#6a4329');
      box(23, 18, 4, 8, '#6a4329');

      line(9, 9, 5, 6, '#d7c7a2', 1);
      line(23, 9, 27, 6, '#d7c7a2', 1);
      line(10, 9, 7, 5, '#d7c7a2', 1);
      line(22, 9, 25, 5, '#d7c7a2', 1);

      box(13, 19, 6, 7, '#2f2016');
      box(20, 18, 3, 4, '#b78b5a');
    } else if (b.kind === 'farmplot') {
      box(4, 8, 24, 17, '#4d3420');
      box(5, 9, 22, 2, '#704d2f');
      box(5, 14, 22, 2, '#332217');
      box(5, 19, 22, 2, '#332217');
      box(5, 24, 22, 1, '#704d2f');

      for (let x = 8; x <= 23; x += 5) {
        box(x, 12, 1, 10, '#7dbb58');
        box(x - 1, 14, 3, 1, '#9fd46b');
        box(x, 18, 3, 1, '#9fd46b');
      }

      box(3, 7, 2, 20, '#6b4a2d');
      box(27, 7, 2, 20, '#6b4a2d');
    } else if (b.kind === 'well') {
      box(9, 16, 14, 9, '#728896');
      box(10, 15, 12, 3, '#9baab4');
      box(12, 19, 8, 5, '#263746');

      box(8, 9, 2, 13, '#7b5b38');
      box(22, 9, 2, 13, '#7b5b38');
      box(7, 8, 18, 3, '#8a6842');
      box(10, 5, 12, 4, '#5d3b22');

      line(16, 11, 16, 18, '#2f2520', 1);
      box(15, 18, 3, 3, '#6f4d2e');

      litBox(13, 20, 6, 2, '#7ec8ff', 0.8);

      if (hydratePulse > 0.05) {
        g.strokeStyle = shadeFillColorLit('rgba(134,201,255,0.9)', shade);
        g.lineWidth = Math.max(1, Math.round(s));
        const ripple = 3 * s + (Math.sin(tick * 0.2) + 1) * s * 0.8;
        g.beginPath();
        g.arc(gx + 16 * s, gy + 20 * s, ripple * (1 + hydratePulse * 0.6), 0, Math.PI * 2);
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
    const frameCount = frames?.length || VILLAGER_FRAME_COUNT;
    const isMoving = Array.isArray(v.path) && v.path.length > 0;
    // Hold the neutral pose when the villager isn't moving so they don't
    // step in place; otherwise cycle through all 4 frames.
    const frameIdx = isMoving ? Math.floor((tick / 6) % frameCount) : 0;
    const f = frames[frameIdx];
    const s = cam.z;
    const rect = entityDrawRect(v.x, v.y, cam);
    const spriteSize = 16 * s;
    const gx = Math.floor(rect.x + (rect.size - spriteSize) * 0.5);
    const gyGround = Math.floor(rect.y + (rect.size - spriteSize) * 0.5);
    // 1-px head-bob synced to the walk cadence so the body silhouette
    // breathes in time with the gait. Shadow stays at the ground, sprite
    // and accent overlay lift together.
    const bobPx = isMoving && (frameIdx % 2 === 1) ? Math.round(s) : 0;
    const gy = gyGround - bobPx;
    const light = useMultiply ? 1 : sampleLightAt(world, v.x, v.y);
    drawShadow(v.x, v.y, 1, 1, { x: gx, y: gyGround, w: spriteSize, h: spriteSize });
    ctx.save();
    ctx.drawImage(f, 0, 0, 16, 16, gx, gy, spriteSize, spriteSize);
    applySpriteShadeLit(ctx, gx, gy, spriteSize, spriteSize, light);
    // 1-px scarf accent at the neckline; deterministic per villager id so a
    // village reads as a crowd of distinct people instead of clones.
    if (Number.isFinite(v.id)) {
      const accent = pickAccentColor(v.id);
      ctx.fillStyle = shadeFillColorLit(accent, light);
      ctx.fillRect(gx + 5 * s, gy + 7 * s, 6 * s, Math.max(1, s));
    }
    if (v.inv) {
      const packColor = ITEM_COLORS[v.inv.type] || ITEM_COLORS.food;
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

    const season = normalizeSeason(world.season);
    const frames = Tileset.waterOverlayBySeason?.[season]?.length
      ? Tileset.waterOverlayBySeason[season]
      : Tileset.waterOverlay || [];

    if (frames.length) {
      const frame = Math.floor((tick / 8) % frames.length);
      drawWaterOverlay(frames, frame, vis);
    }

    drawSeasonAtmosphere(season, tick, vis);
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
            const treeSet = Tileset.sprite.treeBySeason?.[season];
            let treeSprite = null;
            if (Array.isArray(treeSet) && treeSet.length > 0) {
              treeSprite = treeSet[hash2(x, y, 17) % treeSet.length];
            } else if (treeSet) {
              treeSprite = treeSet;
            } else {
              treeSprite = Tileset.sprite.tree;
            }
            if (treeSprite) {
              ctx.save();
              ctx.drawImage(treeSprite, 0, 0, ENTITY_TILE_PX, ENTITY_TILE_PX, rect.x, raisedY, rect.size, rect.size);
              applySpriteShadeLit(ctx, rect.x, raisedY, rect.size, rect.size, light);
              ctx.restore();
            }
          }
          if (world.berries[i] > 0) {
            drawShadow(x, y, 1, 1);
            const rect = entityDrawRect(x, y, cam);
            const light = useMultiply ? 1 : sampleLightAt(world, x, y);
            const berrySprite = Tileset.sprite.berryBySeason?.[season] || Tileset.sprite.berry;
            if (berrySprite) {
              ctx.save();
              ctx.drawImage(berrySprite, 0, 0, ENTITY_TILE_PX, ENTITY_TILE_PX, rect.x, rect.y, rect.size, rect.size);
              applySpriteShadeLit(ctx, rect.x, rect.y, rect.size, rect.size, light);
              ctx.restore();
            }
          }
          if (world.tiles[i] === TILES.FARMLAND && world.growth[i] > 0) {
            drawShadow(x, y, 1, 1);
            const stageIndex = Math.min(2, Math.floor(world.growth[i] / 80));
            const rect = entityDrawRect(x, y, cam);
            const sproutSet = Tileset.sprite.sproutBySeason?.[season] || Tileset.sprite.sprout;
            const sproutSprite = sproutSet?.[stageIndex] || Tileset.sprite.sprout?.[stageIndex];
            if (sproutSprite) {
              // Phase 2: stagger crop sprites perpendicular to the plot's row
              // axis so plots read as rows of crops instead of an undifferentiated
              // patch. Magnitude is one in-tile step (~2 device px @ z=1) so the
              // shift survives at small zoom but never overlaps neighbouring tiles.
              let dx = 0;
              let dy = 0;
              const plot = findFarmPlotForTile(world, x, y);
              if (plot) {
                const stagger = Math.max(1, Math.round(rect.size * 0.12));
                if (plot.orientation === 'horizontal') {
                  dy = ((y - plot.y) % 2 === 0) ? -stagger : stagger;
                } else {
                  dx = ((x - plot.x) % 2 === 0) ? -stagger : stagger;
                }
              }
              ctx.save();
              ctx.drawImage(sproutSprite, 0, 0, ENTITY_TILE_PX, ENTITY_TILE_PX, rect.x + dx, rect.y + dy, rect.size, rect.size);
              ctx.restore();
            }
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
        const baseColor = ITEM_COLORS[it.type] || ITEM_COLORS.food;
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

      // Post-multiply pass: any glow / lit-window / smoke effect that should
      // *not* be darkened by the lightmap multiply lives here. The campfire
      // glow already established this pattern; lit huts and smoke wisps now
      // ride alongside it.
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
          drawSmokeWisps(b, gx, gy - 6 * cam.z, tick, cam);
        } else if (b.kind === 'hut' && b.built >= 1) {
          const fp = getFootprint(b.kind);
          const offsetX = Math.floor((ENTITY_TILE_PX - fp.w * TILE) * cam.z * 0.5);
          const offsetY = Math.floor((ENTITY_TILE_PX - fp.h * TILE) * cam.z * 0.5);
          const bx = tileToPxX(b.x, cam) - offsetX;
          const by = tileToPxY(b.y, cam) - offsetY;
          if (nightActive) {
            // Window at (21, 17) size 2x3 inside the 32px sprite (matches
            // drawBuildingAt's hut window litBox call).
            const winCx = bx + 22 * cam.z;
            const winCy = by + 18.5 * cam.z;
            const halo = 7 * cam.z;
            const grd = ctx.createRadialGradient(winCx, winCy, 0, winCx, winCy, halo);
            grd.addColorStop(0, 'rgba(255, 218, 142, 0.55)');
            grd.addColorStop(1, 'rgba(255, 195, 110, 0)');
            ctx.fillStyle = grd;
            ctx.beginPath(); ctx.arc(winCx, winCy, halo, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'rgba(255, 226, 160, 0.85)';
            ctx.fillRect(bx + 21 * cam.z, by + 17 * cam.z, 2 * cam.z, 3 * cam.z);
          }
          // Chimney smoke from the upper-left corner of the roof so wisps
          // don't overlap the window glow.
          drawSmokeWisps(b, bx + 11 * cam.z, by + 4 * cam.z, tick, cam);
        }
      }

      drawFireflies(season, tick, vis, ambient);
      // Phase 1: optional slot/anchor overlay. Toggled via the DebugKit tray's
      // "Show slots" checkbox, which sets window.AIV_DEBUG_SLOTS. Draws each
      // slot footprint as a translucent rectangle and each named anchor as a
      // small cross — purely additive, no impact when the flag is off.
      if (typeof window !== 'undefined' && window.AIV_DEBUG_SLOTS && world.layout) {
        drawLayoutOverlay(world.layout, cam);
      }
      // Phase 2: optional plot rectangle overlay, gated by AIV_DEBUG_PLOTS.
      if (typeof window !== 'undefined' && window.AIV_DEBUG_PLOTS && world.farmPlots) {
        drawPlotOverlay(world, cam);
      }
      drawPostFx();
      drawQueuedVillagerLabels(ambient);

      if (el && storageTotals) {
        const foodEl = el('food'); if (foodEl) foodEl.textContent = storageTotals.food | 0;
        const woodEl = el('wood'); if (woodEl) woodEl.textContent = storageTotals.wood | 0;
        const stoneEl = el('stone'); if (stoneEl) stoneEl.textContent = storageTotals.stone | 0;
        const peltEl = el('pelt'); if (peltEl) peltEl.textContent = storageTotals.pelt | 0;
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
