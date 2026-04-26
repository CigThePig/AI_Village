import {
  ENTITY_TILE_PX,
  GRID_H,
  GRID_W,
  TILE,
  baseVisibleTileBounds,
  tileToPxX,
  tileToPxY
} from './constants.js';
import { LIGHTING, clamp01 } from './lighting.js';
import { clamp } from './rng.js';
import { context2d } from './canvas.js';
import { makeCanvas } from './tileset.js';

export function createRenderSystem(deps) {
  const { getCam, getViewportW, getViewportH } = deps;

  const lightmapCacheState = {
    ambient: null,
    mode: null,
    scale: null,
    emitterSignature: null
  };

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
    maybeBuildLightmap
  };
}
