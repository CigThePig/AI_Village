import { SHADING_DEFAULTS } from './environment.js';

const LIGHTING = {
  mode: 'hillshade',
  useMultiplyComposite: true,
  lightmapScale: 0.25,
  uiMinLight: 0.94,
  exposure: 1.0,
  nightFloor: 0.32,
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

// Lightmap color grading. The lightmap composites with 'multiply', so these
// tints are channel scalars in [0, 1] applied to the greyscale brightness.
// A value below 1 attenuates that channel (cools when r/g drop, warms when
// b drops). Picked to read as cozy-sim atmosphere rather than a colored
// filter — every tint stays close to neutral.
const NIGHT_TINT = Object.freeze({ r: 0.66, g: 0.78, b: 1.00 });
const DAWN_DUSK_TINT = Object.freeze({ r: 1.00, g: 0.92, b: 0.78 });
const NEUTRAL_TINT = Object.freeze({ r: 1.00, g: 1.00, b: 1.00 });

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpTint(a, b, t) {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t)
  };
}

// gradeLightmap maps the scalar ambient into a per-channel multiplier:
//   ambient < 0.40  : night → neutral
//   0.40 ≤ a < 0.55 : neutral → dawn/dusk warm
//   0.55 ≤ a < 0.85 : warm → neutral
//   ambient ≥ 0.85  : neutral daylight
function gradeLightmap(ambient) {
  const a = clamp01(ambient);
  if (a < 0.40) {
    return lerpTint(NIGHT_TINT, NEUTRAL_TINT, a / 0.40);
  }
  if (a < 0.55) {
    return lerpTint(NEUTRAL_TINT, DAWN_DUSK_TINT, (a - 0.40) / 0.15);
  }
  if (a < 0.85) {
    return lerpTint(DAWN_DUSK_TINT, NEUTRAL_TINT, (a - 0.55) / 0.30);
  }
  return { ...NEUTRAL_TINT };
}

let setShadingModeImpl = () => {};
let setShadingParamsImpl = () => {};

function setShadingMode(mode) {
  return setShadingModeImpl(mode);
}

function setShadingParams(params = {}) {
  return setShadingParamsImpl(params);
}

function registerShadingHandlers({ setMode, setParams }) {
  if (typeof setMode === 'function') {
    setShadingModeImpl = setMode;
  }
  if (typeof setParams === 'function') {
    setShadingParamsImpl = setParams;
  }
}

if (typeof globalThis !== 'undefined') {
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

export {
  clamp01,
  DAWN_DUSK_TINT,
  gradeLightmap,
  LIGHTING,
  makeAltitudeShade,
  NEUTRAL_TINT,
  NIGHT_TINT,
  registerShadingHandlers,
  setShadingMode,
  setShadingParams
};
